import { open, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { html } from "hono/html";
import type { Child } from "hono/jsx";
import { sql, type Kysely } from "kysely";
import type { Database } from "../model.js";
import { islandsSrc, styleVersion } from "./assets.js";
import { registerAuthRoutes, signInHref, type InatClient } from "./auth.js";
import { messagesFor, type Messages } from "./messages/index.js";
import type { AppConfig } from "./config.js";
import { deleteSession, endSessionsFor, SESSION_COOKIE, type AppEnv, type Session, type SessionResolver } from "./session.js";
import { resolveActing, startActing, stopActing, startImpersonating, stopImpersonating } from "./acting.js";
import { normalizeSeed, SEED_COLOR, tokensCss } from "./theme/tokens.js";
import { Layout, PublicPage } from "./views/layout.js";
import { jobHealth, type Job, type LastOutcome } from "./jobs/framework.js";
import { reportAppError } from "./error-reporting.js";
import { ErrorPage, staticErrorPage, type ErrorKind } from "./views/error-page.js";
import { HTTPException } from "hono/http-exception";
import { csvGenerationTiming, requestTiming } from "./request-timing.js";
import { securityHeaders } from "./security-headers.js";
import { countListingView, listingAttributes, rosterAttributes, type Viewer } from "./usage.js";
import { Glossary } from "./views/glossary.js";
import { TaxonomyIndex, TaxonPage } from "./views/taxonomy.js";
import { browseStart, isFiltering, loadTaxon, parseTaxonomyQuery, searchTaxa, taxonomySummary } from "./taxonomy.js";
import {
  addSpecimensToBatch,
  addToBatch,
  batchRows,
  batchSize,
  defaultSeason,
  entrySeasons,
  entryTaxa,
  removeFromBatch,
  rowTaxa,
  saveDrafts,
  seasonRows,
  BadRequest,
  UnknownTaxon,
  UnreachableSpecimens,
  type DraftWrite,
} from "./determine.js";
import { DeterminePage } from "./views/determine.js";
import { Jobs } from "./views/jobs.js";
import { Exports } from "./views/exports.js";
import { legacyExportPath } from "../legacy-export.js";
import { PrintRun, PrintRuns } from "./views/print-runs.js";
import { listRuns, loadRun, runLabels, runPdf, scopeCounts, specimenLabels } from "./print-runs.js";
import {
  approveRun,
  cancelRun,
  markMailed,
  markPrinted,
  prepareRun,
  PrintRunRefused,
  PrintRunTransitionError,
  withPrintRunLock,
} from "../print-run.js";
import { PersonPage, Roster } from "./views/roster.js";
import { ObserverPage, UnclaimedPage } from "./views/unclaimed.js";
import { bindablePeople, listUnclaimed, mintNow, observerDetail, type ObserverDetail } from "./unclaimed.js";
import {
  linkChanges,
  listRoster,
  nameIsUnique,
  parsePersonHandle,
  parseRosterQuery,
  programOptions,
  isRosterFiltered,
  rosterCsv,
  personDetail,
  personHandle,
  personRef,
  RECENT_CHANGES,
  resolvePersonHandle,
} from "./roster.js";
import { upsertOverlay, valueProblem, type OverlayField, type PersonOverlayRow } from "../person-overlay.js";
import {
  appendChanges,
  CHANGE_LOG,
  diffPerson,
  historyFor,
  knownPerson,
  kyselyReader,
  lastKnown,
  readChanges,
  readPersonStates,
  recentChanges,
} from "../person-change.js";
import { applyPersonOverlay, resolver } from "../apply-person-overlay.js";
import type { DuckDBConnection } from "@duckdb/node-api";
import { QcHome } from "./views/qc.js";
import { loadDashboard } from "./dashboard.js";
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
import { setStaffCoordinates, setStaffLocality } from "./locality-override.js";
import { recordSampleChanges, SAMPLE_CHANGE_LOG, SAMPLE_STATE_SNAPSHOT } from "../sample-change.js";
import { SampleEditForm } from "./views/sample-edit.js";
import {
  atlasOptions,
  BY_SAMPLE_NUMBER,
  CSV_ROW_LIMIT,
  exportFilename,
  listSamples,
  listSpecimens,
  parseListingQuery,
  csvStream,
  SAMPLE_CSV_HEADER,
  sampleCsvRow,
  SPECIMEN_CSV_HEADER,
  specimenCsvRow,
} from "./listings.js";
import { SampleListing, SpecimenListing } from "./views/listings.js";
import {
  determinationHistory,
  listSampleSpecimens,
  loadSample,
  loadSpecimen,
  parsePage,
  recordFindings,
  sampleChangeHistory,
} from "./record.js";
import { SamplePage, SpecimenPage } from "./views/record.js";

export interface JobsDep {
  list: Job[];
  /** Run a job immediately; false if unknown or busy. */
  runNow(name: string): Promise<boolean>;
}

export interface AppDeps {
  db: Kysely<Database>;
  config: Pick<AppConfig, "environment" | "origin"> & Partial<Pick<AppConfig, "adminLogins" | "feedbackEmail" | "exportsDir">>;
  inat: InatClient;
  resolveSession: SessionResolver;
  /** The job registry; absent in tests that don't exercise /jobs. */
  jobs?: JobsDep;
  /** App-written correction store for in-app sample edits (config.correctionsPath). */
  correctionsPath?: string;
  /** App-written store of staff decisions about people (ADR 0004 overlay). */
  personOverlayPath?: string;
  /** App-written store of staff decisions about samples — a locality set over the observation's (beeline-649). */
  sampleOverlayPath?: string;
  /** Append-only log of what happened to a person, and when (beeline-o22). */
  personChangesPath?: string;
  /** Sample history: the append-only log and its snapshot baseline (beeline-ewl). */
  sampleChangesPath?: string;
  sampleStatePath?: string;
  /**
   * A raw connection, for the overlay applier. Kysely cannot run the applier's
   * statements as one unit. Never the scheduler's (ADR 0005: one process,
   * many connections): a write on it during the nightly's transaction would
   * land inside that transaction (src/app/main.ts).
   */
  conn?: DuckDBConnection;
  /**
   * The print runs' own connection (src/print-run.ts): the freeze is one
   * transaction, and it cannot share a connection whose transactions are
   * raw BEGIN/COMMIT with the scheduler or with other requests. Falls back
   * to `conn` where a test passes one connection for everything.
   */
  printConn?: DuckDBConnection;
  /**
   * The connection the unclaimed screen promotes on once staff connect a
   * collector (beeline-e85): promotion is one raw BEGIN/COMMIT transaction,
   * like a freeze, and must not share a connection with the scheduler's.
   * Absent ⇒ the decision is saved and the nightly makes the samples.
   */
  mintConn?: DuckDBConnection;
  /** Where rendered label sheets are kept (config.printRunsDir). */
  printRunsDir?: string;
}

/**
 * The app. Routes registered before the session gate are the public surface —
 * styling assets, the health check, and sign-in itself. Everything added
 * after the gate (and everything added later by other modules) sees a
 * session or doesn't run: no anonymous reads, structurally.
 */
export function createApp({
  db,
  config,
  inat,
  resolveSession,
  jobs,
  correctionsPath,
  personOverlayPath,
  sampleOverlayPath,
  personChangesPath,
  sampleChangesPath,
  sampleStatePath,
  conn,
  printConn,
  mintConn,
  printRunsDir,
}: AppDeps) {
  const jobsDep: JobsDep = jobs ?? { list: [], runNow: async () => false };
  const printRunsPath = printRunsDir ?? "data/print-runs";
  const printWriter = printConn ?? conn;
  const corrections = correctionsPath ?? "data/corrections.csv";
  const overlayPath = personOverlayPath ?? "data/person-overlay.csv";
  const sampleOverlay = sampleOverlayPath ?? "data/sample-overlay.csv";
  const changesPath = personChangesPath ?? CHANGE_LOG;
  const samplePaths = {
    log: sampleChangesPath ?? SAMPLE_CHANGE_LOG,
    state: sampleStatePath ?? SAMPLE_STATE_SNAPSHOT,
  };
  // One person's state, as the change log describes it. The same query both
  // producers use, so what the screen records and what a rebuild records are
  // comparable (src/person-change.ts).
  const stateOf = async (personId: number) => {
    const read = await readPersonStates(kyselyReader(db), `p.entity_id = ${Number(personId)}`);
    return { state: [...read.states.values()][0], names: read.names };
  };
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
  // Outermost, so the time it records is the whole request, every middleware
  // after it included, and so it sees the status an error page settled on.
  app.use(requestTiming());
  // So every response carries them — error pages and static files included
  // (beeline-m9o; the policy and its reasons are in the module).
  app.use(securityHeaders(config.environment));
  // Failures and dead ends answer with a page (beeline-0kj): errorResponse
  // below, defined once the page helper exists. Hono calls these after
  // registration, so naming it before it is defined is fine.
  app.onError(async (err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    const reference = reportAppError(err, c);
    return errorResponse(c, "failed", { reference, err });
  });
  app.notFound((c) => errorResponse(c, "notFound"));
  const tokens = tokensCss();

  // Every route (sign-in pages included) reads copy from the catalog; the
  // locale becomes per-person once profiles carry one (beeline-1a7).
  app.use(async (c, next) => {
    c.set("m", messagesFor(null));
    await next();
  });

  // --- Public surface: assets, liveness, and the way in. ---
  // Readiness, and it has to mean something. Fly's service check polls this,
  // and a failing check does NOT restart the machine: "a failing check won't
  // cause the Machine to restart or stop" (docs.fly.io/reference/health-checks,
  // read 2026-10-04 — this comment used to say it did). What it does is take
  // the machine out of routing and hold a deploy or `fly machine update`
  // until it passes. So it must fail exactly when this process cannot serve:
  // a process that is listening but cannot read its own store is precisely
  // that case, and `ok` from a bare handler was not it (beeline-2c3.17) — the
  // store could be missing, locked by a second writer, or a file the app
  // never opened, and this would have said ok throughout. Maintenance mode,
  // when this app is not running at all, answers it from
  // src/app/maintenance.ts, so that switching into it does not hang.
  app.get("/healthz", async (c) => {
    try {
      await db.selectFrom("qc_rule").select("name").limit(1).execute();
      return c.text("ok");
    } catch (err) {
      // Named, not swallowed: this is the one page that exists to say why.
      return c.text(`store unreadable: ${(err as Error).message}`, 503);
    }
  });

  // Job staleness, deliberately NOT part of /healthz (beeline-6td). Fly acts
  // on that endpoint by taking the machine out of routing and holding
  // deploys, and both are the wrong response to a job that failed: the site
  // would go dark for something serving pages has nothing to do with. (The
  // reason first given here was that Fly restarts on a failed check; it does
  // not, which changes the reason and not the conclusion.) So this is its own
  // endpoint, which nothing on Fly polls and an external checker does.
  //
  // Unauthenticated, and therefore it says only WHICH job and WHAT KIND of
  // wrong — never job_run.detail. That column holds whatever a caught Error
  // said, and the errors reaching it come from DuckDB, the filesystem and the
  // iNat API: a constraint violation quotes the offending value, so a failure
  // in person promotion would put a volunteer's name on a public endpoint.
  // The reason lives on /jobs, behind the admin gate, which is where somebody
  // goes once this has told them to look. The alarm and the diagnosis are
  // different jobs and only one of them can be public.
  app.get("/healthz/jobs", async (c) => {
    const rows = await db
      .selectFrom("job_run")
      .select(["job_name", "started_at", "completed_at", "outcome", "detail"])
      .orderBy("started_at", "desc")
      .execute();
    const last = new Map<string, LastOutcome>();
    for (const r of rows) {
      const seen = last.get(r.job_name);
      if (seen === undefined) {
        last.set(r.job_name, {
          started: r.started_at,
          succeeded: r.outcome === "succeeded" ? r.started_at : null,
          outcome: r.outcome as LastOutcome["outcome"],
          detail: r.detail,
        });
      } else if (seen.succeeded === null && r.outcome === "succeeded") {
        seen.succeeded = r.started_at;
      }
    }
    const health = jobHealth(jobsDep.list, last, new Date());
    const wrong = health.filter((h) => h.problem !== null);
    if (wrong.length === 0) return c.text("ok");
    // One line per problem, the job named first: this is read by a cron job
    // and by whoever it mails, so it has to survive being quoted in an email.
    const body = `${wrong.map((h) => `${h.name}: ${h.problem}`).join("\n")}\nSee /jobs for the reason.`;
    return c.text(body, 503);
  });
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
      // Sign-in comes back to the page that was asked for. Only for GETs: a
      // POST cannot be replayed after the detour through iNaturalist, so its
      // sender lands home and does it again (beeline-2c3.31).
      const url = new URL(c.req.url);
      const wanted = c.req.method === "GET" ? `${url.pathname}${url.search}` : null;
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
              <a class="button" href={signInHref(wanted)}>
                {m.signIn.button}
              </a>
            </p>
          </PublicPage>
        )}`,
        401,
      );
    }
    c.set("session", session);
    const admin = await isAdmin(session);
    // Whose records `mine` means. Re-checked against person_delegate every
    // request, so a revoked grant stops working at once (beeline-oyl).
    const acting = await resolveActing(db, session, c, admin);
    c.set("acting", acting);
    // Impersonation takes the admin surfaces away for the duration
    // (beeline-jjt): every admin gate below — /people, /jobs, the scope
    // picker, staff reach on record pages — then answers as it would for the
    // volunteer, which is the point of looking. The real flag was consulted
    // once, to resolve the cookie at all, and is not needed again: stopping
    // is not gated, and nothing else an admin does is meant to work meanwhile.
    c.set("admin", admin && !acting.impersonating);
    await next();
  });

  // --- Authenticated app. ---
  app.post("/auth/logout", async (c) => {
    const id = getCookie(c, SESSION_COOKIE);
    if (id) await deleteSession(db, id);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    // The switch is scoped to the session that held the grant. Leaving it set
    // is not exploitable — resolveActing re-checks the grant against whoever
    // signs in next — but on a household's shared browser it would outlive
    // the person who turned it on, which is its own kind of wrong.
    stopActing(c);
    stopImpersonating(c);
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
    const grant = c.get("acting").canActFor.find((d) => d.personId === wanted);
    if (grant === undefined) {
      return c.text(c.get("m").errors.forbidden, 403);
    }
    // The cookie carries the name, not the id it was picked by (acting.ts).
    startActing(c, grant.name, config.origin);
    return c.redirect("/");
  });

  app.post("/acting/stop", async (c) => {
    stopActing(c);
    return c.redirect("/");
  });

  // Ending an impersonation is not admin-gated: the admin flag is off for the
  // duration, and the one thing that must work under it is getting out. Back
  // to the roster, which is where the switch is turned on.
  app.post("/impersonation/stop", async (c) => {
    stopImpersonating(c);
    return c.redirect("/people");
  });

  // The feedback email, pre-filled. The URL is rebuilt on the public origin,
  // since behind Fly's proxy the request URL is the internal one.
  const feedbackHref = (c: Context<AppEnv>): string | null => {
    if (!config.feedbackEmail) return null;
    const m = c.get("m");
    const session = c.get("session");
    const url = new URL(c.req.url);
    const body = m.layout.feedback.body({
      url: `${config.origin}${url.pathname}${url.search}`,
      when: new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles", timeZoneName: "short" }),
      userAgent: c.req.header("user-agent") ?? "unknown",
      login: session.login,
      session: session.ref ?? "none",
      reference: c.get("errorReference"),
    });
    const query = [`subject=${encodeURIComponent(m.layout.feedback.subject)}`, `body=${encodeURIComponent(body)}`];
    return `mailto:${config.feedbackEmail}?${query.join("&")}`;
  };

  const page = async (
    c: Context<AppEnv>,
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
          feedbackHref: feedbackHref(c),
          m: c.get("m"),
        }}
        title={title}
        stylesheets={stylesheets}
      >
        {children}
      </Layout>
    )}`;

  /**
   * The answer to a request that failed or found nothing (beeline-0kj). The
   * ordinary page where there is a session, the sign-in page's shell where
   * there is not, and a static page if rendering either one fails too —
   * an error page must not depend on what broke. A caller that asked for
   * JSON (the determinations grid) gets JSON. Not-found never says whether
   * a record is missing or not the person's to see; a page that knows more
   * and leaks nothing by saying it passes its own message.
   */
  const errorResponse = async (
    c: Context<AppEnv>,
    kind: ErrorKind,
    { reference, err, message, heading }: { reference?: string; err?: Error; message?: string; heading?: string } = {},
  ): Promise<Response> => {
    const status = kind === "failed" ? 500 : 404;
    const m = c.get("m") ?? messagesFor(null);
    const url = new URL(c.req.url);
    const json =
      url.pathname.endsWith(".json") ||
      (c.req.header("content-type") ?? "").includes("application/json") ||
      (c.req.header("accept") ?? "").startsWith("application/json");
    if (json) return c.json({ error: kind === "failed" ? "failed" : "not found", ...(reference === undefined ? {} : { reference }) }, status);
    // Back only to a page of this site, and never to this very page. The
    // path is checked as well as the origin: a referrer of
    // https://beeline.fly.dev//evil.example/x has this origin and a pathname
    // of //evil.example/x, which as an href is protocol-relative and leaves.
    let back: string | null = null;
    try {
      const referer = new URL(c.req.header("referer") ?? "");
      const path = `${referer.pathname}${referer.search}`;
      if (
        referer.origin === config.origin &&
        /^\/(?![/\\])/.test(path) &&
        new URL(path, config.origin).origin === config.origin &&
        path !== `${url.pathname}${url.search}`
      ) {
        back = path;
      }
    } catch {
      back = null;
    }
    const dev =
      config.environment === "development" && err !== undefined
        ? { text: err.stack ?? err.message, staleStore: /Binder Error|Catalog Error/.test(err.message) }
        : null;
    const body = <ErrorPage m={m} kind={kind} reference={reference} message={message} heading={heading} back={back} dev={dev} />;
    const title = m.errorPage[kind].title;
    try {
      if (c.get("session") !== undefined && c.get("acting") !== undefined) {
        c.set("errorReference", reference);
        return c.html(await page(c, title, body), status);
      }
      return c.html(
        await html`<!doctype html>${(
          <PublicPage environment={config.environment} m={m} title={title} styleVersion={await styleVersion()}>
            {body}
          </PublicPage>
        )}`,
        status,
      );
    } catch (renderErr) {
      console.error(`the error page could not be rendered either: ${(renderErr as Error).message}`);
      return c.html(staticErrorPage(m, kind, reference), status);
    }
  };

  // The front page: your samples that want something this season, as one
  // table (src/app/dashboard.ts).
  app.get("/", async (c) => {
    const m = c.get("m");
    // The dashboard is the "mine" surface, so it follows the switch: while
    // acting for Robert it is Robert's samples that need attention, and the
    // chrome says whose they are.
    const { personId } = c.get("acting");
    const dashboard = await loadDashboard(db, personId);
    return c.html(
      await page(
        c,
        m.qc.title,
        <QcHome
          m={m}
          rows={dashboard.rows}
          withOthers={dashboard.withOthers}
          everSynced={dashboard.everSynced}
          settledFlagged={dashboard.settledFlagged}
          settledThrough={dashboard.settledThrough}
          atlas={dashboard.atlas}
          skipped={dashboard.skipped}
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
    // The atlas this person belongs to, for the scope toggle's middle
    // position: mine, my atlas, everything. Nobody's for a program member
    // or somebody nobody has asked about, and the toggle is then two-way.
    const home = admin
      ? await db
          .selectFrom("person_membership as pm")
          .innerJoin("atlas as a", "a.entity_id", "pm.atlas_id")
          .where("pm.person_id", "=", personId)
          .select(["a.code", "a.name"])
          .executeTakeFirst()
      : undefined;
    return { personId, admin, atlases, query, homeAtlas: home ?? null };
  };

  /** Who is browsing, as the usage counts see it: a role, never a person. */
  const viewer = (c: Context<AppEnv>): Viewer => {
    const acting = c.get("acting");
    return {
      admin: c.get("admin"),
      impersonating: acting.impersonating,
      actingFor: !acting.impersonating && acting.actingFor !== null,
    };
  };

  const csv = (c: Context<AppEnv>, body: string | ReadableStream<Uint8Array>, base: string) =>
    c.body(body, 200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${exportFilename(base, new Date())}"`,
    });

  app.get("/samples", async (c) => {
    const m = c.get("m");
    const { personId, admin, atlases, query, homeAtlas } = await listingRequest(c);
    countListingView(listingAttributes("samples", "page", query, viewer(c)));
    const results = await listSamples(db, query, personId);
    return c.html(
      await page(
        c,
        m.listings.samples.title,
        <SampleListing m={m} query={query} page={results} atlases={atlases} admin={admin} homeAtlas={homeAtlas} />,
      ),
    );
  });

  app.get("/samples.csv", async (c) => {
    const { personId, query } = await listingRequest(c);
    countListingView(listingAttributes("samples", "csv", query, viewer(c)));
    // The whole selection, a page at a time: no cap, no truncation line.
    const body = csvStream(
      SAMPLE_CSV_HEADER,
      (limit, offset) => listSamples(db, query, personId, { limit, offset, withTotal: false }),
      sampleCsvRow,
      csvGenerationTiming("samples"),
    );
    return csv(c, body, "beeline-samples");
  });

  app.get("/specimens", async (c) => {
    const m = c.get("m");
    const { personId, admin, atlases, query, homeAtlas } = await listingRequest(c);
    countListingView(listingAttributes("specimens", "page", query, viewer(c)));
    const results = await listSpecimens(db, query, personId);
    return c.html(
      await page(
        c,
        m.listings.specimens.title,
        <SpecimenListing m={m} query={query} page={results} atlases={atlases} admin={admin} homeAtlas={homeAtlas} />,
      ),
    );
  });

  app.get("/specimens.csv", async (c) => {
    const { personId, query } = await listingRequest(c);
    countListingView(listingAttributes("specimens", "csv", query, viewer(c)));
    const body = csvStream(
      SPECIMEN_CSV_HEADER,
      (limit, offset) => listSpecimens(db, query, personId, { limit, offset, withTotal: false }),
      specimenCsvRow,
      csvGenerationTiming("specimens"),
    );
    return csv(c, body, "beeline-specimens");
  });

  // --- One record (beeline-2c3.34). The listings answer "what is there";
  // these answer everything about one, which is where the determination
  // history — append-only events, not a flattened current name — is finally
  // readable. Gating is the listings' with no filters left: the effective
  // person reaches their own records, staff reach every one, and a record
  // they cannot reach is a 404 rather than a 403, so a URL cannot be probed
  // to learn that it exists. ---

  app.get("/samples/:id", async (c) => {
    const m = c.get("m");
    const sample = await loadSample(db, Number(c.req.param("id")), c.get("acting").personId, c.get("admin"));
    if (sample === null) return errorResponse(c, "notFound");
    const [findings, specimens, history] = await Promise.all([
      recordFindings(db, sample.sample_id),
      listSampleSpecimens(db, sample.sample_id, parsePage(c.req.query("page"))),
      sampleChangeHistory(db, samplePaths.log, sample.sample_id),
    ]);
    return c.html(
      await page(
        c,
        m.record.sample.title(sample.sample_number),
        <SamplePage
          m={m}
          sample={sample}
          findings={findings}
          specimens={specimens}
          history={history}
          admin={c.get("admin")}
        />,
      ),
    );
  });

  app.get("/specimens/:id", async (c) => {
    const m = c.get("m");
    const specimen = await loadSpecimen(db, Number(c.req.param("id")), c.get("acting").personId, c.get("admin"));
    if (specimen === null) return errorResponse(c, "notFound");
    const [events, findings, labels] = await Promise.all([
      determinationHistory(db, specimen.specimen_id),
      recordFindings(db, specimen.sample.sample_id),
      specimenLabels(db, specimen.specimen_id),
    ]);
    const title =
      specimen.field_number === null
        ? m.record.specimen.titleUnnumbered(specimen.specimen_number, specimen.sample.sample_number)
        : m.record.specimen.title(specimen.field_number);
    return c.html(
      await page(
        c,
        title,
        <SpecimenPage m={m} specimen={specimen} events={events} findings={findings} labels={labels} admin={c.get("admin")} />,
      ),
    );
  });

  // Non-iNat samples are fixed here, not upstream (beeline-2c3.8). The gate
  // is in the query: your sample, and no observation to send you to.
  app.get("/samples/:id/edit", async (c) => {
    const m = c.get("m");
    // Acting for someone is reach to act, not only to look: the collector
    // gate reads the effective person (beeline-oyl).
    const sample = await loadEditableSample(db, Number(c.req.param("id")), c.get("acting").personId);
    if (sample === undefined) return errorResponse(c, "notFound", { heading: m.sampleEdit.notEditableHeading, message: m.sampleEdit.notEditable });
    return c.html(await page(c, m.sampleEdit.title, <SampleEditForm m={m} sample={sample} />));
  });

  app.post("/samples/:id/edit", async (c) => {
    const m = c.get("m");
    // Impersonation is a way of looking, not of acting (beeline-jjt): the
    // form renders, since the volunteer would see it, but a save is refused.
    // Delegation is the mechanism for editing on somebody's behalf.
    if (c.get("acting").impersonating) return c.text(m.errors.readOnlyImpersonating, 403);
    // The collector gate follows the switch, but the AUTHOR of the correction
    // is whoever actually made it — acting for Robert does not make Robert
    // the one who typed it (beeline-oyl: reach, never credit).
    const session = c.get("session");
    const sample = await loadEditableSample(db, Number(c.req.param("id")), c.get("acting").personId);
    if (sample === undefined) return errorResponse(c, "notFound", { heading: m.sampleEdit.notEditableHeading, message: m.sampleEdit.notEditable });
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
    // Record what just changed, credited to whoever typed it — the fact a
    // later pass over the store could never recover (ADR 0007). Narrowed to
    // this sample, so the author is charged with this sample's pending
    // differences and no other sample's; in the rare case another writer
    // changed THIS sample and failed to record, that change rides along
    // under this author's name — the cost of recording state rather than
    // intent, and bounded to one sample by the narrowing. A failure here is
    // reported and left for the next pass, which attributes the edit to
    // itself — the author and reason are not lost with it, because
    // applySampleEdit durably wrote them to the corrections overlay before
    // the store was touched. The log records; it never gates the edit.
    if (result.outcome === "saved") {
      try {
        const recorded = await recordSampleChanges(kyselyReader(db), samplePaths, {
          source: "app",
          author: session.login,
          reason: field("note")?.trim() || undefined,
          where: `s.entity_id = ${sample.entity_id}`,
        });
        // A missing snapshot turns this pass into the baseline, which
        // records the edit as part of "the corpus as it stands" — no entry,
        // no author. Say so: silence here would hide that the one fact no
        // later pass can recover went unrecorded (the corrections overlay
        // still holds it, durably, from applySampleEdit).
        if (recorded.baselined) {
          console.warn(
            `sample edit by '${session.login}' fell on a missing snapshot and was baselined, not recorded; ` +
              `the corrections overlay carries the attribution`,
          );
        }
      } catch (err) {
        console.warn(`could not record the sample edit: ${(err as Error).message}`);
      }
    }
    return c.redirect("/");
  });

  // A staff member sets a sample's locality from its page (beeline-649): the
  // one write a volunteer cannot make on an iNat-linked sample, standing
  // over the observation on every sync. Admin-gated — and the admin flag is
  // off while impersonating, so the impersonation refusal is stated first
  // and the gate then catches everything else.
  app.post("/samples/:id/locality", async (c) => {
    const m = c.get("m");
    if (c.get("acting").impersonating) return c.text(m.errors.readOnlyImpersonating, 403);
    if (!c.get("admin")) return c.text("Admins only.", 403);
    const session = c.get("session");
    const sample = await loadSample(db, Number(c.req.param("id")), c.get("acting").personId, true);
    if (sample === null) return errorResponse(c, "notFound");
    const body = await c.req.parseBody();
    const field = (name: string) => (typeof body[name] === "string" ? (body[name] as string) : "");
    const result = await setStaffLocality(
      { db, conn, sampleOverlayPath: sampleOverlay, correctionsPath: corrections },
      { entity_id: sample.sample_id, inat_observation_id: sample.inat_observation_id, locality: sample.locality },
      { value: field("locality"), remove: field("remove") !== "", note: field("note"), author: session.login },
    );
    if (result.outcome === "invalid") return c.text(result.problem, 400);
    if (result.outcome === "no_staging") return c.text(m.sampleEdit.noStagingRows, 409);
    if (result.outcome === "unresolved") return c.text(result.reason, 409);
    // Credited to whoever typed it, narrowed to this sample — the same
    // reasoning as the collector's edit above; the overlay carries the
    // attribution durably whatever happens here.
    if (result.outcome === "saved" || result.outcome === "removed") {
      try {
        await recordSampleChanges(kyselyReader(db), samplePaths, {
          source: "app",
          author: session.login,
          reason: field("note").trim() || undefined,
          where: `s.entity_id = ${sample.sample_id}`,
        });
      } catch (err) {
        console.warn(`could not record the locality change: ${(err as Error).message}`);
      }
    }
    return c.redirect(`/samples/${sample.sample_id}`);
  });

  // The coordinates, on the same terms (beeline-942). The one case a
  // volunteer cannot fix upstream at all is an obscured observation with no
  // trust, which yields no coordinates and cannot print; this is where staff
  // put the true point in.
  app.post("/samples/:id/coordinates", async (c) => {
    const m = c.get("m");
    if (c.get("acting").impersonating) return c.text(m.errors.readOnlyImpersonating, 403);
    if (!c.get("admin")) return c.text("Admins only.", 403);
    const session = c.get("session");
    const sample = await loadSample(db, Number(c.req.param("id")), c.get("acting").personId, true);
    if (sample === null) return errorResponse(c, "notFound");
    if (sample.inat_observation_id === null) return c.text(m.record.sample.staffCoordinates.noObservation, 409);
    const body = await c.req.parseBody();
    const field = (name: string) => (typeof body[name] === "string" ? (body[name] as string) : "");
    const result = await setStaffCoordinates(
      { db, conn, sampleOverlayPath: sampleOverlay, correctionsPath: corrections },
      { entity_id: sample.sample_id, inat_observation_id: sample.inat_observation_id, locality: sample.locality },
      {
        latitude: field("latitude"),
        longitude: field("longitude"),
        uncertainty: field("uncertainty"),
        remove: field("remove") !== "",
        note: field("note"),
        author: session.login,
      },
    );
    if (result.outcome === "invalid") return c.text(result.problem, 400);
    if (result.outcome === "unresolved") return c.text(result.reason, 409);
    if (result.outcome === "saved" || result.outcome === "removed") {
      try {
        await recordSampleChanges(kyselyReader(db), samplePaths, {
          source: "app",
          author: session.login,
          reason: field("note").trim() || undefined,
          where: `s.entity_id = ${sample.sample_id}`,
        });
      } catch (err) {
        console.warn(`could not record the coordinate change: ${(err as Error).message}`);
      }
    }
    return c.redirect(`/samples/${sample.sample_id}`);
  });

  // The glossary is volunteer-facing: in the nav for everyone, and the one
  // page whose entire content is message-catalog copy.
  app.get("/glossary", async (c) => {
    const m = c.get("m");
    return c.html(await page(c, m.glossary.title, <Glossary m={m} />));
  });

  // The taxonomy (beeline-45v.5). Read by everyone, like the glossary: it
  // shows names and totals and nobody's records, and the one link into
  // records it offers lands on a listing that applies its own scope. A name
  // is addressed by rank and name, the tree's own key, because an entity_id
  // is redrawn by every rebuild. Curation, when it comes, gets its own gate.
  app.get("/taxonomy", async (c) => {
    const m = c.get("m");
    const query = parseTaxonomyQuery(new URL(c.req.url).searchParams);
    const summary = await taxonomySummary(db);
    const list = isFiltering(query) ? await searchTaxa(db, query) : null;
    const start = list === null ? await browseStart(db) : null;
    return c.html(
      await page(c, m.taxonomy.title, <TaxonomyIndex m={m} query={query} summary={summary} list={list} start={start} admin={c.get("admin")} />),
    );
  });

  app.get("/taxonomy/:rank/:name", async (c) => {
    const m = c.get("m");
    const node = await loadTaxon(db, c.req.param("rank"), c.req.param("name"));
    if (node === null) return errorResponse(c, "notFound", { message: m.taxonomy.notFound });
    return c.html(await page(c, node.scientific_name, <TaxonPage m={m} node={node} admin={c.get("admin")} />));
  });

  // --- Identify your specimens (beeline-bcq). Reach is "mine", following
  // the acting-for switch; whoever is signed in is the determiner and owns
  // the drafts and the batch, since delegation grants reach, never credit.
  // Impersonation may look and not write, like every other write path.
  // Nothing here writes a determination: the overnight job does
  // (src/commit-determinations.ts). ---
  const determiner = (c: Context<AppEnv>) => c.get("session").personId;

  app.get("/determinations", async (c) => {
    const m = c.get("m");
    const acting = c.get("acting");
    const me = determiner(c);
    const seasons = await entrySeasons(db, acting.personId, me);
    const view = c.req.query("view") === "batch" ? "batch" : "sample";
    const asked = Number(c.req.query("season"));
    const season = seasons.some((s) => s.season === asked) ? asked : defaultSeason(seasons);
    const rows =
      view === "batch" ? await batchRows(db, acting.personId, me) : season === null ? [] : await seasonRows(db, acting.personId, me, season);
    const data = {
      view,
      season,
      rows,
      taxa: await rowTaxa(db, rows),
      readOnly: acting.impersonating,
      batchCount: view === "batch" ? rows.length : await batchSize(db, acting.personId, me),
    } as const;
    return c.html(
      await page(c, m.determine.title, <DeterminePage m={m} seasons={seasons} data={data} />, ["/static/determine.css"]),
    );
  });

  // The names change only when the tree is promoted; a few minutes' staleness
  // costs nothing and saves 400 KB on every page of a long sitting.
  app.get("/determinations/taxa.json", async (c) => {
    c.header("cache-control", "private, max-age=600");
    return c.json(await entryTaxa(db));
  });

  /** Refuse a write while impersonating, and answer the module's refusals in HTTP. */
  const determineWrite = async (c: Context<AppEnv>, write: () => Promise<unknown>) => {
    if (c.get("acting").impersonating) return c.json({ error: c.get("m").errors.readOnlyImpersonating }, 403);
    try {
      return c.json(await write());
    } catch (err) {
      // Not "forbidden": a specimen someone cannot reach is one they cannot
      // know exists, the same 404 the record pages give (beeline-2c3.34).
      if (err instanceof UnreachableSpecimens) return c.json({ error: "not found" }, 404);
      if (err instanceof UnknownTaxon) return c.json({ error: "unknown taxon" }, 400);
      if (err instanceof BadRequest) return c.json({ error: err.message }, 400);
      throw err;
    }
  };

  /** The JSON object a write endpoint was sent; anything else is the client's error. */
  const jsonBody = async (c: Context<AppEnv>): Promise<Record<string, unknown>> => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new BadRequest("the body is not JSON");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new BadRequest("the body is not a JSON object");
    return body as Record<string, unknown>;
  };

  app.post("/determinations/drafts", (c) =>
    determineWrite(c, async () => {
      const body = await jsonBody(c);
      if (!Array.isArray(body.writes)) throw new BadRequest("writes must be a list");
      const id = (v: unknown, nullable: boolean) => {
        if (nullable && (v === null || v === undefined)) return null;
        const n = Number(v);
        if (!Number.isInteger(n)) throw new BadRequest("an id is not a whole number");
        return n;
      };
      const text = (v: unknown) => (typeof v === "string" ? v : null);
      const clean = body.writes.map((w: unknown): DraftWrite => {
        if (typeof w !== "object" || w === null) throw new BadRequest("each write must be an object");
        const r = w as Record<string, unknown>;
        // saveDrafts normalises sex and caste against the taxon, dropping
        // anything it does not know; only the type is checked here.
        return {
          specimenId: id(r.specimenId, false)!,
          animalId: id(r.animalId, true),
          sex: text(r.sex) as DraftWrite["sex"],
          caste: text(r.caste) as DraftWrite["caste"],
        };
      });
      return { rows: await saveDrafts(db, c.get("acting").personId, determiner(c), clean) };
    }),
  );

  app.post("/determinations/batch", (c) =>
    determineWrite(c, async () => {
      const { personId } = c.get("acting");
      const me = determiner(c);
      const body = await jsonBody(c);
      const ids = (v: unknown) => (Array.isArray(v) ? v.map(Number).filter(Number.isInteger) : []);
      let addition = null;
      if (typeof body.add === "string") addition = await addToBatch(db, personId, me, body.add);
      if (body.addIds !== undefined) await addSpecimensToBatch(db, personId, me, ids(body.addIds));
      if (body.remove === "all") await removeFromBatch(db, me, "all");
      else if (body.remove !== undefined) await removeFromBatch(db, me, ids(body.remove));
      const rows = await batchRows(db, personId, me);
      return { addition, rows, taxa: await rowTaxa(db, rows) };
    }),
  );

  // --- The design system. English-only by policy: these views carry literal
  // prose. Not gated, unlike /jobs and /people — it reads no records and
  // decides nothing, so the only reason to keep a curious volunteer out was
  // that it sits next to two surfaces that do. It is offered only to admins
  // instead (the menu beside the brand, views/layout.tsx), which is what "staff
  // tooling" here actually means. Every section is listed in DESIGN_SECTIONS,
  // and a test walks that list. ---
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

  // --- Exports (beeline-6q8). The legacy-format occurrences file the
  // nightly legacy-export job writes: every specimen, with names and true
  // coordinates, so admins only, like /jobs. Served from disk rather than
  // built per request — it is ~160 MB and takes a DuckDB COPY to make.
  const occurrencesPath = legacyExportPath(config.exportsDir ?? "data/exports");
  const occurrencesFile = async () => {
    try {
      const st = await stat(occurrencesPath);
      return { writtenAt: st.mtime, bytes: st.size };
    } catch {
      return null;
    }
  };

  app.get("/exports", async (c) => {
    if (!c.get("admin")) return c.text("Admins only.", 403);
    const m = c.get("m");
    return c.html(await page(c, m.exports.title, <Exports m={m} occurrences={await occurrencesFile()} />));
  });

  app.get("/exports/occurrences.csv", async (c) => {
    if (!c.get("admin")) return c.text("Admins only.", 403);
    // One handle for the size and the bytes: the nightly job replaces the
    // file by rename, and a stat by name followed by an open by name could
    // describe one file and send another (CodeRabbit on #110).
    let handle;
    try {
      handle = await open(occurrencesPath, "r");
    } catch {
      return errorResponse(c, "notFound", { message: c.get("m").exports.missing });
    }
    let st;
    try {
      st = await handle.stat();
    } catch (err) {
      // The stream would have closed it; with no stream, nothing else will.
      await handle.close();
      throw err;
    }
    // Named the way the legacy system named its own occurrences files, with
    // the moment it was written, so a script that picks "the newest" by name
    // still does.
    const stamp = st.mtime.toISOString().slice(0, 19).replaceAll(":", ".");
    // autoClose: the stream closes the handle when it ends or is destroyed.
    return c.body(Readable.toWeb(handle.createReadStream({ autoClose: true })) as ReadableStream, 200, {
      "content-type": "text/csv; charset=utf-8",
      "content-length": String(st.size),
      "content-disposition": `attachment; filename="occurrences_beeline_${stamp}.csv"`,
    });
  });

  // --- Print runs (beeline-1kb.2, beeline-1kb.4). Admin-gated like /jobs;
  // per-atlas print permission waits for a second printer to exist. Reads go
  // through Kysely; the writes are src/print-run.ts on the print connection,
  // behind its lock. Impersonation is a way of looking (beeline-jjt), so the
  // POSTs refuse it exactly as the sample editor does. ---
  app.get("/print-runs", async (c) => {
    if (!c.get("admin")) return c.text("Admins only.", 403);
    const m = c.get("m");
    const [runs, scope] = await Promise.all([listRuns(db), scopeCounts(db)]);
    const nothing = c.req.query("prepared") === "nothing";
    return c.html(
      await page(c, m.printRuns.title, <PrintRuns m={m} runs={runs} scope={scope} nothingPrepared={nothing} />),
    );
  });

  const printRunId = (c: Context<AppEnv>) => Number(c.req.param("id"));
  const showRun = async (c: Context<AppEnv>, id: number) => {
    const m = c.get("m");
    const run = await loadRun(db, id);
    if (run === null) return errorResponse(c, "notFound", { message: m.printRuns.run.notFound });
    const labels = await runLabels(db, id);
    return c.html(await page(c, m.printRuns.run.title(run.prepared_at, run.atlas_code), <PrintRun m={m} run={run} labels={labels} />));
  };

  app.get("/print-runs/:id", async (c) => {
    if (!c.get("admin")) return c.text("Admins only.", 403);
    return showRun(c, printRunId(c));
  });

  app.get("/print-runs/:id/labels.pdf", async (c) => {
    if (!c.get("admin")) return c.text("Admins only.", 403);
    const m = c.get("m");
    const id = printRunId(c);
    // Under the print-run lock, with the state read inside it: cancelRun
    // holds the same lock, so a cancel cannot land between the check and the
    // render and have burned numbers served anyway. Whichever gets the lock
    // first wins, and a cancel that wins is a 409 here. (A file downloaded
    // before a later cancel is beyond any lock; the run page says canceled.)
    const sheets = await withPrintRunLock(async () => {
      const run = await loadRun(db, id);
      if (run === null) return "missing" as const;
      if (run.state === "canceled") return "canceled" as const;
      return runPdf(db, id, run.prepared_at, run.pdf_sha256, printRunsPath);
    });
    if (sheets === "missing") return errorResponse(c, "notFound", { message: m.printRuns.run.notFound });
    if (sheets === "canceled") return c.text(m.printRuns.run.canceledNoSheets, 409);
    const { bytes } = sheets;
    return c.body(bytes as Uint8Array<ArrayBuffer>, 200, {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="beeline-labels-run-${id}.pdf"`,
    });
  });

  // The writes. Each answers the way the store does: a run in the wrong
  // state for the transition is a 409 saying which state it is in.
  const printWrite = async (
    c: Context<AppEnv>,
    write: (personId: number, note: string | null) => Promise<string | null>,
  ) => {
    if (!c.get("admin")) return c.text("Admins only.", 403);
    const m = c.get("m");
    if (c.get("acting").impersonating) return c.text(m.errors.readOnlyImpersonating, 403);
    if (printWriter === undefined) return c.text("print runs need a store connection", 500);
    const form = await c.req.formData();
    const note = String(form.get("note") ?? "").trim() || null;
    try {
      const redirectTo = await write(c.get("session").personId, note);
      return c.redirect(redirectTo ?? "/print-runs");
    } catch (err) {
      if (err instanceof PrintRunTransitionError) {
        // No state at all means no such run, which is a 404 and not "the run is null".
        if (err.from === null) return errorResponse(c, "notFound", { message: m.printRuns.run.notFound });
        return c.text(m.printRuns.run.wrongState(m.printRuns.state[err.from] ?? err.from), 409);
      }
      // The store declined for a reason the printer can act on: say it,
      // rather than a bare failure. Anything else is a fault and stays one.
      if (err instanceof PrintRunRefused) return c.text(m.printRuns.refused(err.refusal), 409);
      throw err;
    }
  };

  app.post("/print-runs", (c) =>
    printWrite(c, async (personId) => {
      const form = await c.req.formData();
      const raw = String(form.get("atlas_id") ?? "").trim();
      const atlasId = raw === "" ? null : Number(raw);
      if (atlasId !== null && !Number.isSafeInteger(atlasId)) return "/print-runs";
      const result = await prepareRun(printWriter!, { atlasId, personId });
      return result === null ? "/print-runs?prepared=nothing" : `/print-runs/${result.printRunId}`;
    }),
  );
  app.post("/print-runs/:id/approve", (c) =>
    printWrite(c, async (personId, note) => {
      await approveRun(printWriter!, printRunId(c), { personId, note });
      return `/print-runs/${printRunId(c)}`;
    }),
  );
  app.post("/print-runs/:id/printed", (c) =>
    printWrite(c, async (personId, note) => {
      await markPrinted(printWriter!, printRunId(c), { personId, note });
      return `/print-runs/${printRunId(c)}`;
    }),
  );
  app.post("/print-runs/:id/mailed", (c) =>
    printWrite(c, async (personId, note) => {
      await markMailed(printWriter!, printRunId(c), { personId, note });
      return `/print-runs/${printRunId(c)}`;
    }),
  );
  app.post("/print-runs/:id/cancel", (c) =>
    printWrite(c, async (personId, note) => {
      await cancelRun(printWriter!, printRunId(c), { personId, note });
      return `/print-runs/${printRunId(c)}`;
    }),
  );

  // --- People: the roster, its binding evidence, and the staff decisions
  // that change any of it. Admin-gated like /jobs. Every write goes to the
  // overlay first and is applied from there, so what a rebuild replays is
  // exactly what the screen did — there is no second path into these rows. ---
  app.get("/people", async (c) => {
    if (!c.get("admin")) return c.text("Admins only.", 403);
    const m = c.get("m");
    const atlases = await atlasOptions(db);
    const programs = await programOptions(db);
    const query = parseRosterQuery(
      new URL(c.req.url).searchParams,
      atlases.map((a) => a.code),
      programs.map((x) => x.code),
    );
    countListingView(rosterAttributes("page", query, viewer(c)));
    const listed = await listRoster(db, query);
    // Only on the unfiltered roster. The panel is about the store as a whole,
    // and a search for one person that answers with somebody else's history
    // reads as a filter that leaked (beeline-o22). The log is a file, so this
    // is a read of every entry ever written; it stays cheap because there is
    // one entry per change rather than one per promotion, which is the whole
    // reason the ingest pass diffs at all.
    const linked = isRosterFiltered(query)
      ? []
      : await linkChanges(db, recentChanges(await readChanges(changesPath), RECENT_CHANGES));
    return c.html(
      await page(
        c,
        m.people.title,
        <Roster m={m} page={listed} query={query} recent={linked} atlases={atlases} programs={programs} />,
      ),
    );
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

  /** One person's change history, as the log holds it (beeline-o22). */
  const history = async (personId: number) => {
    const { state, names } = await stateOf(personId);
    return historyFor(await readChanges(changesPath), names, state);
  };

  const showPerson = async (c: Context<AppEnv>, notice?: string, problem?: string) => {
    const m = c.get("m");
    const person = await personFromUrl(c);
    if (person === null) return errorResponse(c, "notFound", { message: m.people.notFound });
    return c.html(
      await page(
        c,
        person.display_name,
        <PersonPage
          m={m}
          person={person}
          atlases={await atlasOptions(db)}
          programs={await programOptions(db)}
          history={await history(person.person_id)}
          notice={notice}
          problem={problem}
        />,
      ),
    );
  };

  app.get("/people.csv", async (c) => {
    if (!c.get("admin")) return c.text("Admins only.", 403);
    const atlases = await atlasOptions(db);
    const programs = await programOptions(db);
    const query = parseRosterQuery(
      new URL(c.req.url).searchParams,
      atlases.map((a) => a.code),
      programs.map((x) => x.code),
    );
    countListingView(rosterAttributes("csv", query, viewer(c)));
    const listed = await listRoster(db, query, { limit: CSV_ROW_LIMIT, offset: 0 });
    return csv(c, rosterCsv(listed), "beeline-people");
  });

  app.get("/people/:id", async (c) => {
    if (!c.get("admin")) return c.text("Admins only.", 403);
    return showPerson(c);
  });

  // View Beeline as this person (beeline-jjt). A POST because it changes
  // what every later GET means, like the delegation switch; home is where
  // it lands because home is the surface that changes most. Two refusals
  // come before anything is written: a name two people share cannot be put
  // in the cookie (the resolver would answer nobody, and a trace would say
  // the switch was on when it never was), and the trace itself is a gate
  // rather than a courtesy — the card promises "each time is recorded", so
  // a store that cannot record it does not start the switch either.
  app.post("/people/:id/impersonate", async (c) => {
    if (!c.get("admin")) return c.text("Admins only.", 403);
    const m = c.get("m");
    const person = await personFromUrl(c);
    if (person === null) return errorResponse(c, "notFound", { message: m.people.notFound });
    if (!(await nameIsUnique(db, person.display_name))) {
      return showPerson(c, undefined, m.people.viewAsNameShared);
    }
    try {
      await db
        .insertInto("private.impersonation")
        .values({ admin_login: c.get("session").login, person_name: person.display_name })
        .execute();
    } catch (err) {
      console.warn(`could not record the impersonation: ${(err as Error).message}`);
      return c.text(m.errors.impersonationNotRecorded, 503);
    }
    // By name, as the delegation cookie is (acting.ts): a name that stops
    // matching resolves to nobody rather than to the wrong person.
    startImpersonating(c, person.display_name, config.origin);
    return c.redirect("/");
  });

  /**
   * The writing half of a decision about a person, shared by their page and
   * the unclaimed screen (beeline-e85). The overlay is written first: if the
   * apply fails, the decision is still on disk to be replayed, whereas a
   * store-first order would leave a change nothing remembers. Then the
   * store, the change log, and the sessions an account change orphans.
   * `applied` is false where there is no connection to apply with (a test
   * without one): the decision is saved and waits for the next rebuild.
   */
  const commitDecisions = async (d: {
    rows: PersonOverlayRow[];
    ref: string;
    author: string;
    reason: string;
    /** Who the decision is about, or null when it creates them. */
    personId: number | null;
    boundBefore: number | null;
    /** Who it is about afterwards: the same person, or the one `create` made. */
    findAfter: () => Promise<number | null>;
  }): Promise<{ applied: boolean; problem: string | null; personId: number | null }> => {
    await upsertOverlay(overlayPath, d.rows);
    if (conn === undefined) return { applied: false, problem: null, personId: d.personId };
    // What the person looks like now, so the log can say what they looked
    // like before — the one thing the overlay's latest-wins row cannot carry
    // (beeline-o22).
    const before = d.personId === null ? undefined : (await stateOf(d.personId)).state;
    const applied = await applyPersonOverlay(conn, d.rows);
    const afterId = await d.findAfter();
    // Recorded before the unresolved check, and against the same reference
    // the overlay row used: a decision that half applied still changed
    // somebody, and the history has to show what it did.
    //
    // Unless the change left them with no reference at all — unbinding the
    // account of somebody who shares a display name does exactly that. They
    // are still here; it is the log that can no longer name them, and
    // diffing against nothing would record their name and account as
    // *cleared*, over a staff member's own login. Say so instead.
    const { state: after, names } =
      afterId === null ? { state: undefined, names: new Set<string>() } : await stateOf(afterId);
    if (after === undefined) {
      console.warn(
        `not recording: '${d.ref}' now shares a display name with somebody else and holds no ` +
          `account, so nothing names them in the change log`,
      );
    } else {
      // Filed under the reference the LOG knows them by, exactly as a pass
      // over the store would file it (knownPerson). Using the store's own
      // reference instead put an edit made during a namesake era under a
      // second key, and the next pass then diffed the whole person against
      // that half-record and re-reported fields nobody had touched.
      const seen = knownPerson({ known: lastKnown(await readChanges(changesPath)), names }, before ?? after);
      await appendChanges(
        changesPath,
        diffPerson(seen?.ref ?? before?.ref ?? d.ref, before, after, {
          source: "app",
          author: d.author,
          reason: d.reason,
        }),
      );
    }
    if (applied.unresolved.length > 0) {
      return { applied: true, problem: applied.unresolved.map((u) => u.reason).join("; "), personId: afterId };
    }
    // Whatever this account was, it stops being it now: a session issued under
    // the old binding must not survive to be revived under the new one
    // (beeline-ten). Both sides — the iNat user being taken away and the one
    // being given — so neither a departing volunteer nor the person inheriting
    // their account keeps a cookie the other made.
    if (d.rows.some((r) => r.field === "inat_user_id")) {
      const boundAfter =
        afterId === null
          ? undefined
          : await db
              .selectFrom("inat_account")
              .select("inat_user_id")
              .where("person_id", "=", afterId)
              .executeTakeFirst();
      for (const uid of [d.boundBefore, boundAfter?.inat_user_id]) {
        if (uid !== null && uid !== undefined) await endSessionsFor(db, uid);
      }
    }
    return { applied: true, problem: null, personId: afterId };
  };

  /** Record decisions about the person a /people URL names, and show their page. */
  const decide = async (c: Context<AppEnv>, build: (form: FormData) => Array<[OverlayField, string]>) => {
    if (!c.get("admin")) return c.text("Admins only.", 403);
    const m = c.get("m");
    const person = await personFromUrl(c);
    if (person === null) return errorResponse(c, "notFound", { message: m.people.notFound });

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

    const outcome = await commitDecisions({
      rows,
      ref,
      author,
      reason,
      personId: person.person_id,
      boundBefore: person.inat_user_id,
      findAfter: async () => person.person_id,
    });
    if (!outcome.applied) return showPerson(c, m.people.saved);
    if (outcome.problem !== null) return showPerson(c, undefined, outcome.problem);
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

  // The whole set, not one grant: `acts_for` is latest-wins on a single
  // overlay row, so the field states everyone this person may act for and an
  // empty field revokes the lot (beeline-oyl).
  app.post("/people/:id/delegate", (c) => decide(c, (form) => [["acts_for", text(form, "acts_for")]]));

  // One change per form — add a program from the dropdown, or remove one by
  // its pill — made into the whole set the overlay row states, sorted so the
  // row reads the same as the store does (beeline-7c1). A code no program has
  // is refused here, before the overlay: decide writes the file first, and an
  // unappliable row there would replace the last good decision, so the next
  // rebuild would drop every lead the person holds.
  app.post("/people/:id/leads", async (c) => {
    if (!c.get("admin")) return c.text("Admins only.", 403);
    const person = await personFromUrl(c);
    if (person === null) return errorResponse(c, "notFound", { message: c.get("m").people.notFound });
    const form = await c.req.formData();
    const program = text(form, "program");
    const change = text(form, "change");
    if (program === "") return showPerson(c);
    const known = new Set((await programOptions(db)).map((x) => x.code));
    if (!known.has(program)) return showPerson(c, undefined, `no program with code '${program}'`);
    const leads = new Set(person.leads);
    if (change === "add") leads.add(program);
    else if (change === "remove") leads.delete(program);
    else return showPerson(c, undefined, `'${change}' is neither add nor remove`);
    return decide(c, () => [["leads", [...leads].sort().join(";")]]);
  });

  // ── Collectors Beeline does not know (beeline-e85) ─────────────────────
  // Records from iNaturalist users no person is connected to, grouped by the
  // program whose region they fell in; connecting the account to somebody
  // here, or adding somebody new, makes them samples at once. Admin-gated,
  // and refused outright while impersonating, as every staff write is.
  const unclaimedObserver = async (c: Context<AppEnv>) => {
    const raw = c.req.param("uid") ?? "";
    if (!/^\d{1,15}$/.test(raw)) return null;
    return observerDetail(db, Number(raw));
  };

  /**
   * The observer's page. Once nobody waits under the account — as when a
   * decision just lost a race to another — a problem is said on the list
   * rather than answered with a 404 that hides it.
   */
  const showObserver = async (c: Context<AppEnv>, problem?: string) => {
    const m = c.get("m");
    const detail = await unclaimedObserver(c);
    if (detail === null) {
      if (problem === undefined) return errorResponse(c, "notFound", { message: m.unclaimed.gone });
      return c.html(
        await page(c, m.unclaimed.title, <UnclaimedPage m={m} listing={await listUnclaimed(db)} problem={problem} />),
      );
    }
    return c.html(
      await page(
        c,
        `@${detail.observer.login}`,
        <ObserverPage m={m} detail={detail} people={await bindablePeople(db)} problem={problem} />,
      ),
    );
  };

  app.get("/unclaimed", async (c) => {
    if (!c.get("admin")) return c.text("Admins only.", 403);
    const m = c.get("m");
    return c.html(await page(c, m.unclaimed.title, <UnclaimedPage m={m} listing={await listUnclaimed(db)} />));
  });

  app.get("/unclaimed/:uid", async (c) => {
    if (!c.get("admin")) return c.text("Admins only.", 403);
    return showObserver(c);
  });

  // One decision at a time. Each checks the observer and the person, then
  // writes; two at once — two staff on one collector — would both pass the
  // checks, and the loser's overlay row would fail on every rebuild after.
  // In process is enough, since one process owns the store (ADR 0005), and
  // the checks are re-read inside the turn rather than before it.
  let unclaimedQueue: Promise<unknown> = Promise.resolve();
  const oneAtATime = <T,>(work: () => Promise<T>): Promise<T> => {
    const run = unclaimedQueue.then(work);
    unclaimedQueue = run.catch(() => {});
    return run;
  };

  /**
   * What `name:<name>` will resolve to when these rows are applied — asked of
   * the resolver the apply itself uses, because a current display name is not
   * all it reads: legacy promotion's every recorded spelling comes first, and
   * the renames among the rows. Checking display names alone let "MaryJo
   * Mosby" be *added* as new while the overlay connected the account to the
   * Mary Jo Mosby already here. Null where there is no connection to ask (a
   * test without one), where current names are all there is.
   */
  const resolveName = async (name: string, rows: readonly PersonOverlayRow[]) =>
    conn === undefined ? null : (await resolver(conn, rows)).resolve(`name:${name}`);

  /** Whoever now holds the observer's account. */
  const holderOf = async (uid: number) =>
    (await db.selectFrom("inat_account").select("person_id").where("inat_user_id", "=", BigInt(uid)).executeTakeFirst())
      ?.person_id ?? null;

  /**
   * After the person decision: make the observer's records into samples now
   * (src/app/unclaimed.ts, mintNow), and say so on the list. A failure to
   * mint is not a failure to connect — the decision is saved and the nightly
   * makes the samples — so it is said rather than thrown.
   *
   * The sample log is reconciled afterwards by a full pass, filed as the
   * promotion it was: mintNow runs the whole store's promotion, not only this
   * observer's, and a narrowed pass records nothing for a sample it has no
   * earlier row for — which is every sample just made. Who caused it is in
   * the person log, against the decision. Not awaited: the page need not wait
   * for the log, and the log's own queue keeps passes from interleaving.
   */
  const afterConnecting = async (
    c: Context<AppEnv>,
    detail: ObserverDetail,
    decided: { personId: number | null; name: string; applied: boolean },
  ) => {
    const m = c.get("m");
    const u = m.unclaimed;
    const { user_id: uid, login } = detail.observer;
    const person = decided.personId === null ? null : await personDetail(db, decided.personId);
    const name = person?.display_name ?? decided.name;
    let text = u.connected(login, name);
    if (!decided.applied || mintConn === undefined) {
      text = `${text} ${u.notMadeYet}`;
    } else {
      try {
        const made = await mintNow(mintConn, uid, { sampleOverlayPath: sampleOverlay });
        text = `${text} ${u.outcome(made.made, made.linked, made.left)}`;
        void recordSampleChanges(kyselyReader(db), samplePaths, {
          source: "observation_promotion",
          reason: `connected @${login} to ${name}`,
        }).then(
          (recorded) => {
            if (recorded.refused != null) console.warn(`sample history not recorded: ${recorded.refused}`);
          },
          (err) => console.warn(`could not record the samples made for @${login}: ${(err as Error).message}`),
        );
      } catch (err) {
        reportAppError(err as Error, c);
        text = `${text} ${u.notMadeYet}`;
      }
    }
    const personHref = person === null ? "/people" : `/people/${encodeURIComponent(personHandle(person))}`;
    return c.html(
      await page(
        c,
        u.title,
        <UnclaimedPage m={m} listing={await listUnclaimed(db)} notice={{ text, personHref, personName: name }} />,
      ),
    );
  };

  // Somebody already here: their account becomes this one. Named by display
  // name, the way the form offers them, so a name two people share is
  // refused rather than guessed between; someone already connected to
  // another account is refused too, since a person holds one and moving
  // theirs is a decision for their own page.
  app.post("/unclaimed/:uid/connect", async (c) => {
    const m = c.get("m");
    if (c.get("acting").impersonating) return c.text(m.errors.readOnlyImpersonating, 403);
    if (!c.get("admin")) return c.text("Admins only.", 403);
    const u = m.unclaimed;
    const form = await c.req.formData();
    return oneAtATime(async () => {
      const detail = await unclaimedObserver(c);
      if (detail === null) return errorResponse(c, "notFound", { message: u.gone });
      const name = String(form.get("person") ?? "").trim();
      const reason = String(form.get("reason") ?? "").trim() || u.connectedReason(detail.observer.records);
      const found = await db.selectFrom("person").select("entity_id").where("display_name", "=", name).execute();
      if (found.length === 0) return showObserver(c, u.nobodyCalled(name));
      if (found.length > 1) return showObserver(c, u.nameShared(name));
      const person = await personDetail(db, found[0]!.entity_id);
      if (person === null) return showObserver(c, u.nobodyCalled(name));
      if (person.inat_user_id !== null) {
        return showObserver(c, u.alreadyHasAccount(name, person.login ?? String(person.inat_user_id)));
      }

      const author = c.get("session").login;
      const ref = personRef({ ...person, nameIsUnique: true });
      const { user_id, login } = detail.observer;
      const rows: PersonOverlayRow[] = [
        { person_ref: ref, field: "inat_user_id", value: `${user_id} ${login}`, author, reason },
      ];
      // The name has to reach this person when applied, not merely be theirs
      // now: an old spelling of somebody else's would connect the account to
      // them instead (legacy_person_name is read first).
      const resolved = await resolveName(person.display_name, rows);
      if (resolved !== null && !("id" in resolved && resolved.id === person.person_id)) {
        return showObserver(c, u.nameAmbiguous(name));
      }
      const outcome = await commitDecisions({
        rows,
        ref,
        author,
        reason,
        personId: person.person_id,
        boundBefore: null,
        findAfter: async () => person.person_id,
      });
      if (outcome.problem !== null) return showObserver(c, outcome.problem);
      return afterConnecting(c, detail, { personId: person.person_id, name, applied: outcome.applied });
    });
  });

  // Somebody new: the overlay's `create`, their account, and the name parts
  // their labels are set from. A name that would resolve to anybody already
  // here is refused rather than handed to `create`, which would read it as
  // that person, connect the account to them, and overwrite their name parts
  // without anyone having said so.
  app.post("/unclaimed/:uid/add", async (c) => {
    const m = c.get("m");
    if (c.get("acting").impersonating) return c.text(m.errors.readOnlyImpersonating, 403);
    if (!c.get("admin")) return c.text("Admins only.", 403);
    const u = m.unclaimed;
    const form = await c.req.formData();
    const text = (name: string) => String(form.get(name) ?? "").trim();
    return oneAtATime(async () => {
      const detail = await unclaimedObserver(c);
      if (detail === null) return errorResponse(c, "notFound", { message: u.gone });
      const name = text("display_name");
      const reason = text("reason") || u.connectedReason(detail.observer.records);
      if (name === "") return showObserver(c, u.nameBlank);

      const author = c.get("session").login;
      const ref = `name:${name}`;
      const { user_id, login } = detail.observer;
      const rows: PersonOverlayRow[] = (
        [
          ["create", "yes"],
          ["inat_user_id", `${user_id} ${login}`],
          ["given_name", text("given_name")],
          ["family_name", text("family_name")],
        ] as Array<[OverlayField, string]>
      )
        .filter(([field, value]) => field === "create" || field === "inat_user_id" || value !== "")
        .map(([field, value]) => ({ person_ref: ref, field, value, author, reason }));
      const taken = await db.selectFrom("person").select("entity_id").where("display_name", "=", name).execute();
      const resolved = await resolveName(name, rows);
      if (taken.length > 0 || (resolved !== null && !("missing" in resolved && resolved.missing === true))) {
        return showObserver(c, u.nameTaken(name));
      }
      const outcome = await commitDecisions({
        rows,
        ref,
        author,
        reason,
        personId: null,
        boundBefore: null,
        findAfter: () => holderOf(user_id),
      });
      if (outcome.problem !== null) return showObserver(c, outcome.problem);
      return afterConnecting(c, detail, { personId: outcome.personId, name, applied: outcome.applied });
    });
  });

  app.post("/jobs/run/:name", async (c) => {
    if (!c.get("admin")) return c.text("Admins only.", 403);
    await jobsDep.runNow(c.req.param("name"));
    return c.redirect("/jobs");
  });

  return app;
}
