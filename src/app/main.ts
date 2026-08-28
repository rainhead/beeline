import { serve } from "@hono/node-server";
import { inatClient, loadInatCredentials } from "./auth.js";
import { configFromEnv } from "./config.js";
import { openAppDb, seedAdmins } from "./db.js";
import { CURATED_OVERLAY, mergeOverlays, readOverlay } from "../person-overlay.js";
import { kyselyReader, recordPersonChanges } from "../person-change.js";
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
  conn: jobConn,
});
const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`beeline app (${config.environment}) listening on http://localhost:${info.port}`);
});

// The process owns the database (ADR 0005): close it before exiting so the
// WAL flushes; the supervisor restarting us is the normal deploy.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    scheduler.stop();
    server.close(async () => {
      jobConn.closeSync();
      await close();
      process.exit(0);
    });
  });
}
