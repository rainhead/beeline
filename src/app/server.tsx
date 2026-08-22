import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { html } from "hono/html";
import type { Child } from "hono/jsx";
import type { Kysely } from "kysely";
import type { Database } from "../model.js";
import { islandsSrc } from "./assets.js";
import type { AppConfig } from "./config.js";
import { type Session, type SessionResolver } from "./session.js";
import { tokensCss } from "./theme/tokens.js";
import { Home } from "./views/home.js";
import { Layout } from "./views/layout.js";
import { Patterns } from "./views/patterns.js";

export interface AppDeps {
  db: Kysely<Database>;
  config: Pick<AppConfig, "environment">;
  resolveSession: SessionResolver;
}

type Env = { Variables: { session: Session } };

/**
 * The app. Routes registered before the session gate are the public surface —
 * styling assets and the health check, nothing that touches data. Everything
 * added after the gate (and everything added later by other modules) sees a
 * session or doesn't run: no anonymous reads, structurally.
 */
export function createApp({ db, config, resolveSession }: AppDeps) {
  const app = new Hono<Env>();
  const tokens = tokensCss();

  // --- Public surface: assets and liveness only. ---
  app.get("/healthz", (c) => c.text("ok"));
  app.get("/tokens.css", (c) => c.body(tokens, 200, { "content-type": "text/css" }));
  app.use("/static/*", serveStatic({ root: "./src/app" }));
  app.use("/assets/*", serveStatic({ root: "./dist/app" }));

  // --- The session gate. ---
  app.use(async (c, next) => {
    const session = await resolveSession(c);
    if (session === null) {
      return c.html(
        html`<!doctype html>${(
          <html lang="en">
            <head>
              <meta charset="utf-8" />
              <title>Sign in · Beeline</title>
              <link rel="stylesheet" href="/tokens.css" />
              <link rel="stylesheet" href="/static/base.css" />
            </head>
            <body>
              <main>
                <h1>Beeline</h1>
                <p>Nothing here is public — sign in with iNaturalist to continue.</p>
                <p>
                  <a class="button" href="/auth/inat">Sign in</a> (arrives with beeline-2c3.3)
                </p>
              </main>
            </body>
          </html>
        )}`,
        401,
      );
    }
    c.set("session", session);
    await next();
  });

  // --- Authenticated app. ---
  const page = async (c: { get(k: "session"): Session }, title: string, children: Child) =>
    html`<!doctype html>${(
      <Layout
        env={{ environment: config.environment, islandsSrc: await islandsSrc(), session: c.get("session") }}
        title={title}
      >
        {children}
      </Layout>
    )}`;

  app.get("/", async (c) => {
    const [samples, people] = await Promise.all([
      db.selectFrom("sample").select(({ fn }) => fn.countAll().as("n")).executeTakeFirstOrThrow(),
      db.selectFrom("person").select(({ fn }) => fn.countAll().as("n")).executeTakeFirstOrThrow(),
    ]);
    return c.html(await page(c, "Home", <Home sampleCount={Number(samples.n)} personCount={Number(people.n)} />));
  });

  app.get("/patterns", async (c) => c.html(await page(c, "Pattern library", <Patterns />)));

  return app;
}
