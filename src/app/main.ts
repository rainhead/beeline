import { serve } from "@hono/node-server";
import { inatClient, loadInatCredentials } from "./auth.js";
import { configFromEnv } from "./config.js";
import { openAppDb } from "./db.js";
import { createApp } from "./server.js";
import { cookieSessionResolver, type SessionResolver } from "./session.js";

const config = configFromEnv();
const { db, close } = await openAppDb(config);

if (config.privateDbKey === null) {
  console.warn("BEELINE_PRIVATE_DB_KEY unset: private store is UNENCRYPTED (development only)");
}

// Real cookie sessions; a development instance may bypass them wholesale via
// BEELINE_DEV_LOGIN (no OAuth round-trip, person id 0).
const resolveSession: SessionResolver = config.devLogin
  ? async () => ({ personId: 0, login: config.devLogin! })
  : cookieSessionResolver(db);

const inat = inatClient(await loadInatCredentials());
const app = createApp({ db, config, inat, resolveSession });
const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`beeline app (${config.environment}) listening on http://localhost:${info.port}`);
});

// The process owns the database (ADR 0005): close it before exiting so the
// WAL flushes; the supervisor restarting us is the normal deploy.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close(async () => {
      await close();
      process.exit(0);
    });
  });
}
