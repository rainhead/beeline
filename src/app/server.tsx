import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { html } from "hono/html";
import type { Child } from "hono/jsx";
import { sql, type Kysely } from "kysely";
import type { Database } from "../model.js";
import { islandsSrc, styleVersion } from "./assets.js";
import { registerAuthRoutes, type InatClient } from "./auth.js";
import { messagesFor, type Messages } from "./messages/index.js";
import type { AppConfig } from "./config.js";
import { deleteSession, SESSION_COOKIE, type AppEnv, type Session, type SessionResolver } from "./session.js";
import { resolveActing, startActing, stopActing } from "./acting.js";
import { normalizeSeed, SEED_COLOR, tokensCss } from "./theme/tokens.js";
import { Layout, PublicPage } from "./views/layout.js";
import type { Job } from "./jobs/framework.js";
import { Glossary } from "./views/glossary.js";
import { Jobs } from "./views/jobs.js";
import { PersonPage, Roster } from "./views/roster.js";
import {
  listRoster,
  nameIsUnique,
  parsePersonHandle,
  parseRosterQuery,
  personDetail,
  personRef,
  resolvePersonHandle,
} from "./roster.js";
import { upsertOverlay, valueProblem, type OverlayField, type PersonOverlayRow } from "../person-overlay.js";
import { applyPersonOverlay } from "../apply-person-overlay.js";
import type { DuckDBConnection } from "@duckdb/node-api";
import { QcHome, type FindingRow, type PendingRow } from "./views/qc.js";
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
import {
  atlasOptions,
  BY_SAMPLE_NUMBER,
  CSV_ROW_LIMIT,
  listSamples,
  listSpecimens,
  parseListingQuery,
  sampleCsv,
  specimenCsv,
} from "./listings.js";
import { SampleListing, SpecimenListing } from "./views/listings.js";

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
  /** App-written store of staff decisions about people (ADR 0004 overlay). */
  personOverlayPath?: string;
  /**
   * A raw connection, for the overlay applier. Kysely cannot run the applier's
   * statements as one unit, and the app already keeps a spare connection for
   * the scheduler (ADR 0005: one process, many connections, one writer).
   */
  conn?: DuckDBConnection;
}

/**
 * The app. Routes registered before the session gate are the public surface —
 * styling assets, the health check, and sign-in itself. Everything added
 * after the gate (and everything added later by other modules) sees a
 * session or doesn't run: no anonymous reads, structurally.
 */
export function createApp({ db, config, inat, resolveSession, jobs, correctionsPath, personOverlayPath, conn }: AppDeps) {
  const jobsDep: JobsDep = jobs ?? { list: [], runNow: async () => false };
  const corrections = correctionsPath ?? "data/corrections.csv";
  const overlayPath = personOverlayPath ?? "data/person-overlay.csv";
  // Admin surface (/jobs, /people): everyone in development, and elsewhere
  // whoever holds a person_admin row — the roster moved into the store so the
  // people who own it can edit it (beeline-eft added five names by deploy).
  // config.adminLogins is only the bootstrap seed now, applied at boot to a
  // store that has never granted anything; a revocation here therefore sticks.
  const isAdmin = async (session: Session) => {
    if (config.environment === "development") return true;
    const row = await db
      .selectFrom("person_admin")
      .where("person_id", "=", session.personId)
      .select("person_id")
      .executeTakeFirst();
    return row !== undefined;
  };
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
  // Versioned URLs (styleVersion) make caching these safe: a changed file is
  // a changed URL, so nothing serves stale CSS the way it did before.
  app.use("/static/*", async (c, next) => {
    await next();
    if (config.environment !== "development") c.header("cache-control", "public, max-age=3600");
  });
  app.use("/static/*", serveStatic({ root: "./src/app" }));
  app.use("/assets/*", serveStatic({ root: "./dist/app" }));
  registerAuthRoutes(app, { db, inat, origin: config.origin, environment: config.environment });

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
          <PublicPage
            environment={config.environment}
            m={m}
            title={m.signIn.title}
            styleVersion={await styleVersion()}
          >
            <h1>{m.signIn.heading}</h1>
            <p>{m.signIn.nothingPublic}</p>
            <p>
              <a class="button" href="/auth/inat">
                {m.signIn.button}
              </a>
            </p>
          </PublicPage>
        )}`,
        401,
      );
    }
    c.set("session", session);
    c.set("admin", await isAdmin(session));
    // Whose records `mine` means. Re-checked against person_delegate every
    // request, so a revoked grant stops working at once (beeline-oyl).
    c.set("acting", await resolveActing(db, session, c));
    await next();
  });

  // --- Authenticated app. ---
  app.post("/auth/logout", async (c) => {
    const id = getCookie(c, SESSION_COOKIE);
    if (id) await deleteSession(db, id);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.redirect("/");
  });

  // Acting for somebody else (beeline-oyl). Both are POSTs because both
  // change what every later GET means; redirecting home rather than back
  // keeps it out of open-redirect territory, and home is the surface the
  // switch most changes.
  app.post("/acting", async (c) => {
    const body = await c.req.parseBody();
    const wanted = typeof body["person"] === "string" ? Number(body["person"]) : NaN;
    // Refused rather than silently ignored: setting a cookie the resolver
    // would throw away on the next request looks to the user like the switch
    // simply not working.
    if (!c.get("acting").canActFor.some((d) => d.personId === wanted)) {
      return c.text(c.get("m").errors.forbidden, 403);
    }
    startActing(c, wanted);
    return c.redirect("/");
  });

  app.post("/acting/stop", async (c) => {
    stopActing(c);
    return c.redirect("/");
  });

  const page = async (
    c: { get<K extends "session" | "m" | "admin" | "acting">(k: K): AppEnv["Variables"][K] },
    title: string,
    children: Child,
    stylesheets?: readonly string[],
  ) =>
    html`<!doctype html>${(
      <Layout
        env={{
          environment: config.environment,
          islandsSrc: await islandsSrc(),
          styleVersion: await styleVersion(),
          session: c.get("session"),
          admin: c.get("admin"),
          acting: c.get("acting"),
          canActFor: c.get("acting").canActFor,
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
    // The dashboard is the "mine" surface, so it follows the switch: while
    // acting for Robert it is Robert's flagged samples that need attention,
    // and the chrome says whose they are.
    const { personId } = c.get("acting");
    const [flagged, pending, partners, sync] = await Promise.all([
      db
        // The roll-up, not qc_finding: a finding on one of a sample's
        // specimens is something to fix about that sample, and the dashboard
        // has to say so or it disagrees with printability (beeline-2c3.29).
        .selectFrom("sample_qc_finding as f")
        .innerJoin("sample as s", "s.entity_id", "f.sample_id")
        .innerJoin("qc_rule as r", "r.name", "f.rule_name")
        // Any sample you collected, not only the ones numbered under your
        // name: a second collector is not a spectator (beeline-77j).
        .innerJoin("sample_collector as mine", (join) =>
          join.onRef("mine.sample_id", "=", "s.entity_id").on("mine.person_id", "=", personId),
        )
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
          // Settled seasons stay in this one read and are split out below:
          // asking twice would mean computing the whole flag set twice, and
          // that view is what the page costs (beeline-2c3.24).
          sql<boolean>`EXISTS (SELECT 1 FROM settled_sample st WHERE st.sample_id = s.entity_id)`.as("settled"),
        ])
        .orderBy("s.date_start", "desc")
        .orderBy(BY_SAMPLE_NUMBER)
        .orderBy("s.entity_id")
        .execute(),
      // The passive half of the dashboard: clean samples waiting on labels.
      // Warnings don't block printing, so a sample can honestly appear in
      // both lists.
      db
        .selectFrom("pending_print_sample as p")
        .innerJoin("sample as s", "s.entity_id", "p.sample_id")
        .innerJoin("sample_collector as mine", (join) =>
          join.onRef("mine.sample_id", "=", "s.entity_id").on("mine.person_id", "=", personId),
        )
        .select([
          "s.entity_id as sample_id",
          "s.sample_number",
          "s.date_start",
          "s.locality",
          "s.county",
          "s.state_province",
          "p.pending_count",
        ])
        .orderBy("s.date_start", "desc")
        .orderBy(BY_SAMPLE_NUMBER)
        .orderBy("s.entity_id")
        .execute(),
      // Who else collected those samples, so a card can say whose numbering
      // it is you are looking at.
      db
        .selectFrom("sample_collector as mine")
        .innerJoin("sample_collector as theirs", "theirs.sample_id", "mine.sample_id")
        .innerJoin("person", "person.entity_id", "theirs.person_id")
        .where("mine.person_id", "=", personId)
        .where("theirs.person_id", "!=", personId)
        .select(["mine.sample_id as sample_id", "person.display_name as display_name"])
        .orderBy("theirs.position")
        .execute(),
      db
        .selectFrom("sync_run")
        .select(({ fn }) => fn.max("completed_at").as("at"))
        .executeTakeFirst(),
    ]);
    // This season asks; earlier ones only report their number.
    const rows = flagged as Array<FindingRow & { settled: boolean }>;
    const findings = rows.filter((row) => !row.settled);
    const settledFlagged = new Set(rows.filter((row) => row.settled).map((row) => row.sample_id)).size;
    // sample_id → the other collectors' names, in recordedBy order.
    const withOthers = new Map<number, string[]>();
    for (const row of partners as Array<{ sample_id: number; display_name: string }>) {
      const names = withOthers.get(row.sample_id) ?? [];
      names.push(row.display_name);
      withOthers.set(row.sample_id, names);
    }
    return c.html(
      await page(
        c,
        m.qc.title,
        <QcHome
          m={m}
          findings={findings}
          pending={pending as PendingRow[]}
          withOthers={withOthers}
          syncedAt={sync?.at ?? null}
          settledFlagged={settledFlagged}
        />,
      ),
    );
  });

  // --- Browsing the collection (beeline-2c3.21). The QC home says what
  // needs attention; these say what is there. Scope, filters and page live
  // in the query string, so a staff member helping a volunteer can send
  // them the exact listing they are looking at. ---

  /** The cookie that remembers a staff member's last scope, so nav lands where they left off. */
  const SCOPE_COOKIE = "beeline_scope";

  /**
   * Parse a listing request. The scope gate is here and nowhere else:
   * parseListingQuery forces MINE for anyone not on the admin allowlist, so
   * a volunteer cannot reach another atlas by typing a query string.
   */
  const listingRequest = async (c: Context<AppEnv>) => {
    // The effective person, not the signed-in one: MINE scope means the
    // person being acted for while the switch is on (beeline-oyl).
    const { personId } = c.get("acting");
    const admin = c.get("admin");
    const atlases = await atlasOptions(db);
    const query = parseListingQuery(new URL(c.req.url).searchParams, {
      admin,
      atlasCodes: atlases.map((a) => a.code),
      preferred: getCookie(c, SCOPE_COOKIE),
    });
    // Remember an explicit choice only — a bare /samples keeps the cookie.
    if (admin && c.req.query("scope") !== undefined) {
      setCookie(c, SCOPE_COOKIE, query.scope, { path: "/", sameSite: "Lax", httpOnly: true });
    }
    return { personId, admin, atlases, query };
  };

  const csv = (c: Context<AppEnv>, body: string, filename: string) =>
    c.body(body, 200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
    });

  app.get("/samples", async (c) => {
    const m = c.get("m");
    const { personId, admin, atlases, query } = await listingRequest(c);
    const results = await listSamples(db, query, personId);
    return c.html(
      await page(
        c,
        m.listings.samples.title,
        <SampleListing m={m} query={query} page={results} atlases={atlases} admin={admin} />,
      ),
    );
  });

  app.get("/samples.csv", async (c) => {
    const { personId, query } = await listingRequest(c);
    const results = await listSamples(db, query, personId, { limit: CSV_ROW_LIMIT, offset: 0 });
    return csv(c, sampleCsv(results), "beeline-samples.csv");
  });

  app.get("/specimens", async (c) => {
    const m = c.get("m");
    const { personId, admin, atlases, query } = await listingRequest(c);
    const results = await listSpecimens(db, query, personId);
    return c.html(
      await page(
        c,
        m.listings.specimens.title,
        <SpecimenListing m={m} query={query} page={results} atlases={atlases} admin={admin} />,
      ),
    );
  });

  app.get("/specimens.csv", async (c) => {
    const { personId, query } = await listingRequest(c);
    const results = await listSpecimens(db, query, personId, { limit: CSV_ROW_LIMIT, offset: 0 });
    return csv(c, specimenCsv(results), "beeline-specimens.csv");
  });

  // Non-iNat samples are fixed here, not upstream (beeline-2c3.8). The gate
  // is in the query: your sample, and no observation to send you to.
  app.get("/samples/:id/edit", async (c) => {
    const m = c.get("m");
    // Acting for someone is reach to act, not only to look: the collector
    // gate reads the effective person (beeline-oyl).
    const sample = await loadEditableSample(db, Number(c.req.param("id")), c.get("acting").personId);
    if (sample === undefined) return c.text(m.sampleEdit.notEditable, 404);
    return c.html(await page(c, m.sampleEdit.title, <SampleEditForm m={m} sample={sample} />));
  });

  app.post("/samples/:id/edit", async (c) => {
    const m = c.get("m");
    // The collector gate follows the switch, but the AUTHOR of the correction
    // is whoever actually made it — acting for Robert does not make Robert
    // the one who typed it (beeline-oyl: reach, never credit).
    const session = c.get("session");
    const sample = await loadEditableSample(db, Number(c.req.param("id")), c.get("acting").personId);
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
    ["/design/names", "Names", () => <DesignNames />],
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
      if (!c.get("admin")) return c.text("Admins only.", 403);
      const m = c.get("m");
      return c.html(await page(c, title, render(m), DESIGN_STYLESHEETS));
    });
  }

  // The pattern library used to live here; keep the bookmarks working.
  app.get("/patterns", (c) => c.redirect("/design", 301));
  app.get("/patterns/messages", (c) => c.redirect("/design/messages", 301));
  app.get("/patterns/qc", (c) => c.redirect("/design/qc", 301));

  app.get("/jobs", async (c) => {
    if (!c.get("admin")) return c.text("Admins only.", 403);
    const m = c.get("m");
    const runs = await db
      .selectFrom("job_run")
      .select(["job_name", "started_at", "completed_at", "outcome", "detail", "sla_breaches"])
      .orderBy("started_at", "desc")
      .limit(20)
      .execute();
    return c.html(await page(c, m.jobs.title, <Jobs m={m} jobs={jobsDep.list} runs={runs} />));
  });

  // --- People: the roster, its binding evidence, and the staff decisions
  // that change any of it. Admin-gated like /jobs. Every write goes to the
  // overlay first and is applied from there, so what a rebuild replays is
  // exactly what the screen did — there is no second path into these rows. ---
  app.get("/people", async (c) => {
    if (!c.get("admin")) return c.text("Admins only.", 403);
    const m = c.get("m");
    const query = parseRosterQuery(new URL(c.req.url).searchParams);
    const listed = await listRoster(db, query);
    return c.html(await page(c, m.people.title, <Roster m={m} page={listed} query={query} />));
  });

  /**
   * The person named by the URL, addressed by login or by entity_id. Both
   * resolve; links are written with the login where there is one, because an
   * entity_id is redrawn by every rebuild (personHandle, ADR 0002).
   */
  const personFromUrl = async (c: Context<AppEnv>) => {
    const handle = parsePersonHandle(c.req.param("id") ?? "");
    if (handle === null) return null;
    const id = await resolvePersonHandle(db, handle);
    return id === null ? null : await personDetail(db, id);
  };

  const showPerson = async (c: Context<AppEnv>, notice?: string, problem?: string) => {
    const m = c.get("m");
    const person = await personFromUrl(c);
    if (person === null) return c.text(m.people.notFound, 404);
    return c.html(
      await page(
        c,
        person.display_name,
        <PersonPage m={m} person={person} atlases={await atlasOptions(db)} notice={notice} problem={problem} />,
      ),
    );
  };

  app.get("/people/:id", async (c) => {
    if (!c.get("admin")) return c.text("Admins only.", 403);
    return showPerson(c);
  });

  /**
   * Record decisions and apply them. The overlay is written first: if the
   * apply fails, the decision is still on disk to be replayed, whereas a
   * store-first order would leave a change nothing remembers.
   */
  const decide = async (c: Context<AppEnv>, build: (form: FormData) => Array<[OverlayField, string]>) => {
    if (!c.get("admin")) return c.text("Admins only.", 403);
    const m = c.get("m");
    const person = await personFromUrl(c);
    if (person === null) return c.text(m.people.notFound, 404);

    const form = await c.req.formData();
    const author = c.get("session").login;
    const reason = String(form.get("reason") ?? "").trim();
    let ref: string;
    try {
      ref = personRef({ ...person, nameIsUnique: await nameIsUnique(db, person.display_name) });
    } catch (err) {
      return showPerson(c, undefined, (err as Error).message);
    }

    const rows: PersonOverlayRow[] = [];
    for (const [field, value] of build(form)) {
      const problem = valueProblem(field, value);
      if (problem !== null) return showPerson(c, undefined, problem);
      rows.push({ person_ref: ref, field, value, author, reason });
    }
    // Back to the URL as it was asked for: rebinding an account can change
    // the handle underneath us, and redirecting to the new one would 404 a
    // form post that succeeded.
    if (rows.length === 0) return c.redirect(`/people/${encodeURIComponent(c.req.param("id") ?? "")}`);

    await upsertOverlay(overlayPath, rows);
    if (conn === undefined) return showPerson(c, m.people.saved);
    const applied = await applyPersonOverlay(conn, rows);
    if (applied.unresolved.length > 0) {
      return showPerson(c, undefined, applied.unresolved.map((u) => u.reason).join("; "));
    }
    return showPerson(c, m.people.savedRebuild);
  };

  const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

  app.post("/people/:id/account", (c) =>
    decide(c, (form) => {
      const uid = text(form, "inat_user_id");
      const login = text(form, "login");
      // Login rides along so the overlay reads as something a human can check.
      return [["inat_user_id", uid === "" ? "" : login === "" ? uid : `${uid} ${login}`]];
    }),
  );

  app.post("/people/:id/names", (c) =>
    decide(c, (form) => [
      ["display_name", text(form, "display_name")],
      ["given_name", text(form, "given_name")],
      ["family_name", text(form, "family_name")],
      ["label_name", text(form, "label_name")],
    ]),
  );

  app.post("/people/:id/membership", (c) => decide(c, (form) => [["home_atlas", text(form, "home_atlas")]]));

  app.post("/people/:id/admin", (c) => decide(c, (form) => [["admin", text(form, "admin")]]));

  app.post("/jobs/run/:name", async (c) => {
    if (!c.get("admin")) return c.text("Admins only.", 403);
    await jobsDep.runNow(c.req.param("name"));
    return c.redirect("/jobs");
  });

  return app;
}
