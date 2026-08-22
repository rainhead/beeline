import { serve } from "@hono/node-server";
import { configFromEnv } from "./config.js";
import { openAppDb } from "./db.js";
import { createApp } from "./server.js";
import { noSession, type SessionResolver } from "./session.js";

const config = configFromEnv();
const { db, close } = await openAppDb(config);

// Until real auth (beeline-2c3.3): a development instance may stub a session
// via BEELINE_DEV_LOGIN; everywhere else, nobody is signed in.
const resolveSession: SessionResolver = config.devLogin
  ? async () => ({ personId: 0, login: config.devLogin! })
  : noSession;

const app = createApp({ db, config, resolveSession });
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
