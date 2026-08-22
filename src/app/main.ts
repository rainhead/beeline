import { serve } from "@hono/node-server";
import { inatClient, loadInatCredentials } from "./auth.js";
import { configFromEnv } from "./config.js";
import { openAppDb } from "./db.js";
import { startScheduler } from "./jobs/framework.js";
import { buildJobs } from "./jobs/registry.js";
import { createApp } from "./server.js";
import { cookieSessionResolver, type SessionResolver } from "./session.js";

const config = configFromEnv();
const { db, instance, close } = await openAppDb(config);

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
  resolveSession = async () => ({ personId, login: config.devLogin! });
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
