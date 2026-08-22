import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { deleteCookie, getCookie } from "hono/cookie";
import { html } from "hono/html";
import type { Child } from "hono/jsx";
import type { Kysely } from "kysely";
import type { Database } from "../model.js";
import { islandsSrc } from "./assets.js";
import { registerAuthRoutes, type InatClient } from "./auth.js";
import { messagesFor } from "./messages/index.js";
import type { AppConfig } from "./config.js";
import { deleteSession, SESSION_COOKIE, type AppEnv, type Session, type SessionResolver } from "./session.js";
import { tokensCss } from "./theme/tokens.js";
import { Home } from "./views/home.js";
import { Layout } from "./views/layout.js";
import { Patterns } from "./views/patterns.js";

export interface AppDeps {
  db: Kysely<Database>;
  config: Pick<AppConfig, "environment" | "origin">;
  inat: InatClient;
  resolveSession: SessionResolver;
}

/**
 * The app. Routes registered before the session gate are the public surface —
 * styling assets, the health check, and sign-in itself. Everything added
 * after the gate (and everything added later by other modules) sees a
 * session or doesn't run: no anonymous reads, structurally.
 */
export function createApp({ db, config, inat, resolveSession }: AppDeps) {
  const app = new Hono<AppEnv>();
  const tokens = tokensCss();

  // Every route (sign-in pages included) reads copy from the catalog; the
  // locale becomes per-person once profiles carry one (beeline-1a7).
  app.use(async (c, next) => {
    c.set("m", messagesFor(null));
    await next();
  });

  // --- Public surface: assets, liveness, and the way in. ---
  app.get("/healthz", (c) => c.text("ok"));
  app.get("/tokens.css", (c) => c.body(tokens, 200, { "content-type": "text/css" }));
  app.use("/static/*", serveStatic({ root: "./src/app" }));
  app.use("/assets/*", serveStatic({ root: "./dist/app" }));
  registerAuthRoutes(app, { db, inat, origin: config.origin });

  // --- CSRF: cross-origin writes die here (cookies are SameSite=Lax too). ---
  app.use(async (c, next) => {
    const origin = c.req.header("origin");
    if (origin !== undefined && origin !== config.origin && c.req.method !== "GET" && c.req.method !== "HEAD") {
      return c.text(c.get("m").errors.crossOrigin, 403);
    }
    await next();
  });

  // --- The session gate. ---
  app.use(async (c, next) => {
    const session = await resolveSession(c);
    if (session === null) {
      const m = c.get("m");
      return c.html(
        html`<!doctype html>${(
          <html lang={m.locale}>
            <head>
              <meta charset="utf-8" />
              <title>{m.layout.pageTitle(m.signIn.title)}</title>
              <link rel="stylesheet" href="/tokens.css" />
              <link rel="stylesheet" href="/static/base.css" />
            </head>
            <body>
              <main>
                <h1>{m.signIn.heading}</h1>
                <p>{m.signIn.nothingPublic}</p>
                <p>
                  <a class="button" href="/auth/inat">
                    {m.signIn.button}
                  </a>
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
  app.post("/auth/logout", async (c) => {
    const id = getCookie(c, SESSION_COOKIE);
    if (id) await deleteSession(db, id);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.redirect("/");
  });

  const page = async (c: { get<K extends "session" | "m">(k: K): AppEnv["Variables"][K] }, title: string, children: Child) =>
    html`<!doctype html>${(
      <Layout
        env={{
          environment: config.environment,
          islandsSrc: await islandsSrc(),
          session: c.get("session"),
          m: c.get("m"),
        }}
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
    const m = c.get("m");
    return c.html(
      await page(c, m.home.title, <Home m={m} sampleCount={Number(samples.n)} personCount={Number(people.n)} />),
    );
  });

  app.get("/patterns", async (c) => {
    const m = c.get("m");
    return c.html(await page(c, m.patterns.title, <Patterns m={m} />));
  });

  return app;
}
