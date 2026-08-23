import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { deleteCookie, getCookie } from "hono/cookie";
import { html } from "hono/html";
import type { Child } from "hono/jsx";
import type { Kysely } from "kysely";
import type { Database } from "../model.js";
import { islandsSrc } from "./assets.js";
import { registerAuthRoutes, type InatClient } from "./auth.js";
import { messagesFor, type Messages } from "./messages/index.js";
import type { AppConfig } from "./config.js";
import { deleteSession, SESSION_COOKIE, type AppEnv, type Session, type SessionResolver } from "./session.js";
import { normalizeSeed, SEED_COLOR, tokensCss } from "./theme/tokens.js";
import { Layout } from "./views/layout.js";
import type { Job } from "./jobs/framework.js";
import { Glossary } from "./views/glossary.js";
import { Jobs } from "./views/jobs.js";
import { QcHome, type FindingRow } from "./views/qc.js";
import { DESIGN_STYLESHEETS } from "./views/design/shell.js";
import { DesignIndex } from "./views/design/index-page.js";
import { DesignColor } from "./views/design/color.js";
import { DesignType } from "./views/design/type.js";
import { DesignNames } from "./views/design/names.js";
import { DesignIdentity } from "./views/design/identity.js";
import { DesignIcons } from "./views/design/icons.js";
import { DesignSpace } from "./views/design/space.js";
import { DesignComponents } from "./views/design/components.js";
import { DesignVoice } from "./views/design/voice.js";
import { DesignImagery } from "./views/design/imagery.js";
import { MessagesProof } from "./views/design/messages-proof.js";
import { QcProof } from "./views/design/qc-proof.js";
import { applySampleEdit, loadEditableSample } from "./sample-edit.js";
import { SampleEditForm } from "./views/sample-edit.js";

export interface JobsDep {
  list: Job[];
  /** Run a job immediately; false if unknown or busy. */
  runNow(name: string): Promise<boolean>;
}

export interface AppDeps {
  db: Kysely<Database>;
  config: Pick<AppConfig, "environment" | "origin"> & Partial<Pick<AppConfig, "adminLogins">>;
  inat: InatClient;
  resolveSession: SessionResolver;
  /** The job registry; absent in tests that don't exercise /jobs. */
  jobs?: JobsDep;
  /** App-written correction store for in-app sample edits (config.correctionsPath). */
  correctionsPath?: string;
}

/**
 * The app. Routes registered before the session gate are the public surface —
 * styling assets, the health check, and sign-in itself. Everything added
 * after the gate (and everything added later by other modules) sees a
 * session or doesn't run: no anonymous reads, structurally.
 */
export function createApp({ db, config, inat, resolveSession, jobs, correctionsPath }: AppDeps) {
  const jobsDep: JobsDep = jobs ?? { list: [], runNow: async () => false };
  const corrections = correctionsPath ?? "data/corrections.csv";
  // Admin surface (/jobs): everyone in development, allowlisted logins
  // elsewhere — running ingestion is not for every approved volunteer
  // (beeline-6va).
  const isAdmin = (session: Session) =>
    config.environment === "development" || (config.adminLogins ?? []).includes(session.login);
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
  // The default seed is computed once; `?seed=` regenerates on demand so
  // per-atlas colorways can be proofed at /design/identity (beeline-2c3.12).
  app.get("/tokens.css", (c) => {
    const seed = normalizeSeed(c.req.query("seed"));
    return c.body(seed === SEED_COLOR ? tokens : tokensCss(seed), 200, { "content-type": "text/css" });
  });
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
              <link rel="stylesheet" href="/static/elements.css" />
              <link rel="stylesheet" href="/static/layout.css" />
              <link rel="stylesheet" href="/static/components.css" />
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

  const page = async (
    c: { get<K extends "session" | "m">(k: K): AppEnv["Variables"][K] },
    title: string,
    children: Child,
    stylesheets?: readonly string[],
  ) =>
    html`<!doctype html>${(
      <Layout
        env={{
          environment: config.environment,
          islandsSrc: await islandsSrc(),
          session: c.get("session"),
          admin: isAdmin(c.get("session")),
          m: c.get("m"),
        }}
        title={title}
        stylesheets={stylesheets}
      >
        {children}
      </Layout>
    )}`;

  // The flagship is the front page: your samples needing attention.
  app.get("/", async (c) => {
    const m = c.get("m");
    const session = c.get("session");
    const [findings, sync] = await Promise.all([
      db
        .selectFrom("qc_finding as f")
        .innerJoin("sample as s", "s.entity_id", "f.sample_id")
        .innerJoin("qc_rule as r", "r.name", "f.rule_name")
        .where("s.collector_id", "=", session.personId)
        .select([
          "s.entity_id as sample_id",
          "f.rule_name",
          "f.details",
          "r.severity",
          "s.sample_number",
          "s.date_start",
          "s.locality",
          "s.county",
          "s.state_province",
          "s.specimen_count",
          "s.inat_observation_id",
        ])
        .orderBy("s.date_start", "desc")
        .orderBy("s.entity_id")
        .execute(),
      db
        .selectFrom("sync_run")
        .select(({ fn }) => fn.max("completed_at").as("at"))
        .executeTakeFirst(),
    ]);
    return c.html(
      await page(c, m.qc.title, <QcHome m={m} findings={findings as FindingRow[]} syncedAt={sync?.at ?? null} />),
    );
  });

  // Non-iNat samples are fixed here, not upstream (beeline-2c3.8). The gate
  // is in the query: your sample, and no observation to send you to.
  app.get("/samples/:id/edit", async (c) => {
    const m = c.get("m");
    const sample = await loadEditableSample(db, Number(c.req.param("id")), c.get("session").personId);
    if (sample === undefined) return c.text(m.sampleEdit.notEditable, 404);
    return c.html(await page(c, m.sampleEdit.title, <SampleEditForm m={m} sample={sample} />));
  });

  app.post("/samples/:id/edit", async (c) => {
    const m = c.get("m");
    const session = c.get("session");
    const sample = await loadEditableSample(db, Number(c.req.param("id")), session.personId);
    if (sample === undefined) return c.text(m.sampleEdit.notEditable, 404);
    const body = await c.req.parseBody();
    // Absent fields stay untouched (applySampleEdit's contract); only strings pass.
    const field = (name: string) => (typeof body[name] === "string" ? (body[name] as string) : undefined);
    const names = ["locality", "country", "state_province", "county", "protocol"] as const;
    const values = Object.fromEntries(names.map((name) => [name, field(name)]).filter(([, v]) => v !== undefined));
    const bases = Object.fromEntries(
      names.map((name) => [name, field(`base:${name}`)]).filter(([, v]) => v !== undefined),
    );
    const result = await applySampleEdit(db, corrections, sample, {
      values,
      bases,
      note: field("note") ?? "",
      author: session.login,
    });
    if (result.outcome === "no_staging") return c.text(m.sampleEdit.noStagingRows, 409);
    return c.redirect("/");
  });

  // The glossary is volunteer-facing: in the nav for everyone, and the one
  // page whose entire content is message-catalog copy.
  app.get("/glossary", async (c) => {
    const m = c.get("m");
    return c.html(await page(c, m.glossary.title, <Glossary m={m} />));
  });

  // --- The design system. Staff tooling, so admin-gated like /jobs, and
  // English-only by policy: these views carry literal prose. Every section
  // is listed in DESIGN_SECTIONS, and a test walks that list. ---
  const designPages: ReadonlyArray<[string, string, (m: Messages) => Child]> = [
    ["/design", "Design system", () => <DesignIndex />],
    ["/design/color", "Color", () => <DesignColor />],
    ["/design/type", "Typography", () => <DesignType />],
    ["/design/names", "Scientific names", () => <DesignNames />],
    ["/design/identity", "Identity", () => <DesignIdentity />],
    ["/design/icons", "Iconography", () => <DesignIcons />],
    ["/design/space", "Space & form", () => <DesignSpace />],
    ["/design/components", "Components", (m) => <DesignComponents m={m} />],
    ["/design/voice", "Voice", (m) => <DesignVoice m={m} />],
    ["/design/imagery", "Imagery", () => <DesignImagery />],
    ["/design/messages", "Message catalog", (m) => <MessagesProof m={m} />],
    ["/design/qc", "QC states", (m) => <QcProof m={m} />],
  ];
  for (const [path, title, render] of designPages) {
    app.get(path, async (c) => {
      if (!isAdmin(c.get("session"))) return c.text("Admins only.", 403);
      const m = c.get("m");
      return c.html(await page(c, title, render(m), DESIGN_STYLESHEETS));
    });
  }

  // The pattern library used to live here; keep the bookmarks working.
  app.get("/patterns", (c) => c.redirect("/design", 301));
  app.get("/patterns/messages", (c) => c.redirect("/design/messages", 301));
  app.get("/patterns/qc", (c) => c.redirect("/design/qc", 301));

  app.get("/jobs", async (c) => {
    if (!isAdmin(c.get("session"))) return c.text("Admins only.", 403);
    const m = c.get("m");
    const runs = await db
      .selectFrom("job_run")
      .select(["job_name", "started_at", "completed_at", "outcome", "detail", "sla_breaches"])
      .orderBy("started_at", "desc")
      .limit(20)
      .execute();
    return c.html(await page(c, m.jobs.title, <Jobs m={m} jobs={jobsDep.list} runs={runs} />));
  });

  app.post("/jobs/run/:name", async (c) => {
    if (!isAdmin(c.get("session"))) return c.text("Admins only.", 403);
    await jobsDep.runNow(c.req.param("name"));
    return c.redirect("/jobs");
  });

  return app;
}
