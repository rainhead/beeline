import { serve } from "@hono/node-server";
import { inatClient, loadInatCredentials } from "./auth.js";
import { configFromEnv } from "./config.js";
import { openAppDb, seedAdmins } from "./db.js";
import { CURATED_OVERLAY, mergeOverlays, readOverlay } from "../person-overlay.js";
import { kyselyReader, recordPersonChanges } from "../person-change.js";
import { recordSampleChanges } from "../sample-change.js";
import { startScheduler } from "./jobs/framework.js";
import { buildJobs } from "./jobs/registry.js";
import { createApp } from "./server.js";
import { cookieSessionResolver, type SessionResolver } from "./session.js";

const config = configFromEnv();
const { db, instance, close } = await openAppDb(config);

// Both overlays, merged as promotion merges them: the guard's job is to spot
// a decision a person made, and half the decisions are curated in git.
const decisions = mergeOverlays(
  await readOverlay(CURATED_OVERLAY),
  await readOverlay(config.personOverlayPath),
);
const seeded = await seedAdmins(db, config.adminLogins, decisions);
if (seeded > 0) console.log(`seeded ${seeded} admin(s) from the checked-in list`);

// Reconcile the change log with the store before serving anything
// (beeline-o22). Coverage is the point: a rebuild promoted while the app was
// down, a hand-run `pnpm person:apply`, the admin seed just above — none of
// them is the roster screen, and all of them change people. Whatever this
// finds is attributed to the pass rather than to a person, because by now
// there is nobody left to name. Idempotent, so a boot that follows a
// promotion writes nothing.
// Failing to write history is not a reason to refuse to serve: the log is a
// record of what happened, and a store this cannot read is one the roster
// screen will report on its own. Said out loud, and picked up by the next
// pass.
try {
  const reconciled = await recordPersonChanges(kyselyReader(db), config.personChangesPath, {
    source: "reconcile",
  });
  if (reconciled.appended > 0) {
    console.log(`recorded ${reconciled.appended} person change(s) made while the app was down`);
  }
  if (reconciled.contested > 0) {
    console.warn(
      `${reconciled.contested} people could not be told apart from a history the log already holds — ` +
        `nothing was recorded for them (see matchKnown in src/person-change.ts)`,
    );
  }
  if (reconciled.unreferenceable > 0) {
    console.warn(
      `${reconciled.unreferenceable} people share a display name and hold no account — ` +
        `their changes cannot be recorded until one of the two is fixed`,
    );
  }
} catch (err) {
  console.warn(`could not reconcile the person change log: ${(err as Error).message}`);
}

// And the samples (beeline-ewl): the same coverage argument, over the log's
// second instance. The first boot against a store writes the snapshot — the
// whole corpus as it stands, recorded as zero events — and every later one
// records only what changed while nothing else was recording.
try {
  const samples = await recordSampleChanges(
    kyselyReader(db),
    { log: config.sampleChangesPath, state: config.sampleStatePath },
    { source: "reconcile" },
  );
  if (samples.baselined) {
    console.log(`sample change log baselined: snapshot written to ${config.sampleStatePath}`);
  } else if (samples.appended > 0) {
    console.log(`recorded ${samples.appended} sample change(s) made while the app was down`);
  }
  if (samples.contested > 0) {
    console.warn(
      `${samples.contested} samples could not be told apart from a history the log already holds — ` +
        `nothing was recorded for them (see matchSamples in src/sample-change.ts)`,
    );
  }
  if (samples.unreferenceable > 0) {
    console.warn(
      `${samples.unreferenceable} samples have a collector no reference names — ` +
        `their changes cannot be recorded until the person is fixed`,
    );
  }
} catch (err) {
  console.warn(`could not reconcile the sample change log: ${(err as Error).message}`);
}

if (config.privateDbKey === null) {
  console.warn("BEELINE_PRIVATE_DB_KEY unset: private store is UNENCRYPTED (development only)");
}

// Real cookie sessions; a development instance may bypass them wholesale via
// BEELINE_DEV_LOGIN (no OAuth round-trip). The stub resolves the login
// against inat_account so dev sessions see that person's real data.
let resolveSession: SessionResolver = cookieSessionResolver(db);
if (config.devLogin) {
  const account = await db
    .selectFrom("inat_account")
    .where("login", "=", config.devLogin)
    .select("person_id")
    .executeTakeFirst();
  const personId = account?.person_id ?? 0;
  if (account === undefined) console.warn(`BEELINE_DEV_LOGIN '${config.devLogin}' has no inat_account; using person 0`);
  resolveSession = async () => ({ personId, login: config.devLogin!, iconUrl: null, stub: true });
}

const jobs = buildJobs(config);
const jobConn = await instance.connect();
const scheduler = startScheduler({ db, conn: jobConn, jobs });

const inat = inatClient(await loadInatCredentials());
const app = createApp({
  db,
  config,
  inat,
  resolveSession,
  jobs: { list: jobs, runNow: (name) => scheduler.runNow(name) },
  correctionsPath: config.correctionsPath,
  personOverlayPath: config.personOverlayPath,
  personChangesPath: config.personChangesPath,
  sampleChangesPath: config.sampleChangesPath,
  sampleStatePath: config.sampleStatePath,
  conn: jobConn,
});
const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`beeline app (${config.environment}) listening on http://localhost:${info.port}`);
});

// The process owns the database (ADR 0005): close it before exiting so the
// WAL flushes; the supervisor restarting us is the normal deploy.
//
// The budget is Fly's `kill_timeout` (fly.toml: 120s, and the nightly runs
// inside the window host maintenance can land in). It is spent in this order,
// and the order is the point (beeline-fth): stop taking requests, settle the
// running job, then checkpoint and close. The job comes before the close
// because a connection closed under a transaction is what this used to do —
// and the close is reached whatever happens before it, because the version
// that put it in an async callback lost the checkpoint to an unhandled
// rejection, which is the uncheckpointed WAL DuckDB <= 1.5.5 can fail to
// replay (beeline-c1b).
//
// The job gets a minute to finish on its own before it is interrupted, which
// leaves the other minute for its rollback, the drain and the checkpoint. A
// second signal is not handled at all: `once` restores Node's default, which
// is to die on the spot — the escape hatch, and exactly the unclean exit the
// first signal is trying to avoid.
const SHUTDOWN_GRACE_MS = 60_000;
const SHUTDOWN_LIMIT_MS = 110_000;
async function shutdown(signal: string): Promise<never> {
  console.log(`${signal}: shutting down`);
  setTimeout(() => {
    console.error(`shutdown exceeded ${SHUTDOWN_LIMIT_MS}ms; exiting without a clean close`);
    process.exit(1);
  }, SHUTDOWN_LIMIT_MS).unref();

  let code = 0;
  const failed = (what: string, err: unknown) => {
    console.error(`shutdown: ${what} failed:`, err);
    code = 1;
  };

  // Stop listening; requests in flight complete and idle keep-alives close.
  const drained = new Promise<void>((resolve) => server.close(() => resolve()));
  const running = scheduler.running();
  if (running !== null) console.log(`waiting for job '${running}' (up to ${SHUTDOWN_GRACE_MS}ms before interrupting it)`);
  await scheduler.stop({ graceMs: SHUTDOWN_GRACE_MS }).catch((err: unknown) => failed("stopping the scheduler", err));
  // A request that is still open past the grace is not worth the store.
  const drainLimit = setTimeout(() => {
    if ("closeAllConnections" in server) server.closeAllConnections();
  }, SHUTDOWN_GRACE_MS).unref();
  await drained;
  clearTimeout(drainLimit);

  try {
    jobConn.closeSync();
  } catch (err) {
    failed("closing the job connection", err);
  }
  try {
    await close();
  } catch (err) {
    failed("closing the store", err);
  }
  process.exit(code);
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    shutdown(signal).catch((err: unknown) => {
      console.error("shutdown failed:", err);
      process.exit(1);
    });
  });
}
