import { legacyExportPath, writeLegacyExport } from "../../legacy-export.js";
import { budgetProblems, describeUsage, measureFlyUsage } from "../../fly-usage.js";
import { commitDeterminationDrafts } from "../../commit-determinations.js";
import { describeFetch, ECDYSIS_COLLECTIONS, fetchEcdysis } from "../../fetch-ecdysis.js";
import { backUp, describeBackup } from "../../store-backup.js";
import type { Kysely } from "kysely";
import { deriveElevations } from "../../derive-elevation.js";
import { deriveLocalities, describeLocalities } from "../../derive-locality.js";
import { fetchMissingTiles, type FetchTilesOptions } from "../../fetch-dem.js";
import { mintPipelineJwt } from "../../inat-jwt.js";
import { fetchPlaces, type FetchPlacesOptions } from "../../fetch-places.js";
import type { Database } from "../../model.js";
import { duckdbReader, recordPersonChanges } from "../../person-change.js";
import { recordSampleChanges, type SampleLogPaths } from "../../sample-change.js";
import { promoteObservations } from "../../promote-observations.js";
import { fetchObservationsById, syncINat, type FetchByIdOptions } from "../../sync-inat.js";
import type { AppConfig } from "../config.js";
import { deploymentPath } from "../../deployment-path.js";
import { describeManifest, writeProgramArchives } from "../program-archives.js";
import { purgeIdleSessions } from "../session.js";
import type { Job, JobContext } from "./framework.js";

/** A fresh JWT per run (src/inat-jwt.ts); a failed mint aborts the job. */
const mintJwt = () => mintPipelineJwt();

/**
 * The incremental watermark for a source: start of the most recent completed
 * run that asked for everything-updated-since-X. A windowed sweep must not
 * advance it — the sweep proves nothing about edits to observations outside
 * its window, so using its start would skip those edits forever
 * (beeline-bwy). Sweeps bootstrap the chain only while no incremental run
 * has ever completed: at that point the store holds nothing but what sweeps
 * loaded, all of it inside the window.
 */
export async function lastSyncStart(db: Kysely<Database>, source: string): Promise<Date | null> {
  // A run that read one observer (the dashboard's check, beeline-yso) says
  // nothing about anybody else's edits, so it never moves the watermark.
  const completed = db
    .selectFrom("sync_run")
    .where("source", "=", source)
    .where("completed_at", "is not", null)
    .where("observer_user_id", "is", null);
  const incremental = await completed
    .where("updated_since", "is not", null)
    .select(({ fn }) => fn.max("started_at").as("at"))
    .executeTakeFirst();
  if (incremental?.at != null) return incremental.at;
  const any = await completed.select(({ fn }) => fn.max("started_at").as("at")).executeTakeFirst();
  return any?.at ?? null;
}

/** Overlap margin for incremental runs: re-fetching an hour twice is free (hash-dedup). */
const UPDATED_SINCE_MARGIN_MS = 60 * 60 * 1000;

const sweepStart = (sweepDays: number) => new Date(Date.now() - sweepDays * 86_400_000).toISOString().slice(0, 10);

/**
 * The places cache, brought up to date between sync and promote
 * (beeline-0oj). observation_place is the only route from an observation to
 * a state and so to an atlas, and a sync can bring in observations naming
 * places the cache has never seen; minting one of those before the fetch
 * gives the sample no state, no atlas and a place_unrecognised finding for
 * no reason except that a fetch had not run. Steady state is one request or
 * none — the view only refills when a sync introduces a new place.
 *
 * NEVER FAILS THE RUN. This is the only outbound dependency in the pipeline
 * other than the sync itself, and an unreachable places endpoint is not a
 * reason to skip promotion: a store with a slightly stale cache is fine, a
 * store that skipped promotion is not. So the failure is reported in the
 * run's detail, the way the elevation step reports missing tiles, and the
 * fill-only atlas refresh repairs the affected samples on the pass after the
 * fetch succeeds (sample_atlas_unfilled is its worklist).
 */
export async function refreshPlaces(
  conn: JobContext["conn"],
  opts: FetchPlacesOptions = {},
): Promise<string> {
  try {
    const r = await fetchPlaces(conn, opts);
    if (r.missing === 0) return "places cache complete";
    return (
      `${r.cached} places cached` +
      (r.unresolved.length > 0 ? `, ${r.unresolved.length} gone upstream (${r.unresolved.join(", ")})` : "")
    );
  } catch (err) {
    return `places fetch failed (${(err as Error).message}); promoting with the cache as it stands`;
  }
}

/** How many cited observations one night may ask iNaturalist for: ten requests. */
export const NIGHTLY_CITED_LIMIT = 2_000;

/**
 * The observations samples cite that no sync has read (beeline-7vsw), asked
 * for by id. A project sweep only returns observations in its project, and
 * 1,537 samples on the dev store cite one in none of them — legacy links, the
 * old system's — so their geoprivacy was never read, and the listings
 * withhold their location from other volunteers for want of knowing
 * (src/app/listings.ts `withheld`, which defines "unread" the same way). The
 * ones iNaturalist no longer has stay unread and are asked about again each
 * night: a few hundred ids, two requests.
 *
 * NEVER FAILS THE RUN, for refreshPlaces's reason: a location withheld one
 * more night is no harm, and a skipped promotion is.
 */
export async function refreshCitedObservations(
  conn: JobContext["conn"],
  opts: Omit<FetchByIdOptions, "ids"> & { limit?: number } = {},
): Promise<string> {
  try {
    const rows = (await (
      await conn.run(
        `SELECT DISTINCT s.inat_observation_id
         FROM sample s
         LEFT JOIN observation_field f ON f.inat_id = s.inat_observation_id
         WHERE s.inat_observation_id IS NOT NULL AND f.inat_id IS NULL
         ORDER BY 1
         LIMIT ${Math.trunc(opts.limit ?? NIGHTLY_CITED_LIMIT)}`,
      )
    ).getRows()) as [bigint | number][];
    if (rows.length === 0) return "every cited observation read";
    const r = await fetchObservationsById(conn, { ...opts, ids: rows.map(([id]) => Number(id)) });
    return `${r.fetched} of ${r.asked} cited observations read by id (${r.newLoads} new)` +
      (r.asked > r.fetched ? `, ${r.asked - r.fetched} gone from iNaturalist` : "");
  } catch (err) {
    return `cited observations not read (${(err as Error).message}); promoting without them`;
  }
}

/**
 * How many DEM tiles one run may download. The sandbox's 123 tiles average
 * 14 MB, so this is about 350 MB, and fetching 83 of them by hand on
 * 2026-10-16 took a few minutes; a store that suddenly gains a continent's
 * worth of gaps fills over several nights rather than spending one
 * downloading (beeline-z08).
 */
export const NIGHTLY_TILE_LIMIT = 25;

/** How long one run may spend fetching tiles, all of them together. */
export const NIGHTLY_TILE_DEADLINE_MS = 15 * 60_000;

/**
 * The DEM tiles the pending elevations need and the disk lacks, fetched just
 * before deriving (beeline-z08). Until this, the nightly only named the tiles
 * it was missing, and somebody had to run `pnpm elevation:fetch` by hand in
 * maintenance mode; a full sync on 2026-10-14 left 609 samples waiting on 83
 * tiles, most of them in Oregon and Washington.
 *
 * NEVER FAILS THE RUN, for refreshPlaces's reason: an elevation is never a
 * QC finding and never blocks printing, so derivation goes on with the tiles
 * on disk and the detail says what went wrong. A tile neither source has is
 * left to the derive step's list of missing tiles, as before.
 */
export async function refreshTiles(
  conn: JobContext["conn"],
  demDir: string,
  opts: FetchTilesOptions & { deadlineMs?: number } = {},
): Promise<string | null> {
  // The whole fetch has a deadline as well as each request, since 25 slow
  // downloads just inside their own ten-minute timeouts would hold the
  // nightly for hours and push the 3am backup out of the night window
  // (CodeRabbit). Tiles that arrived before it are kept; the rest wait.
  const deadlineMs = opts.deadlineMs ?? NIGHTLY_TILE_DEADLINE_MS;
  const deadline = AbortSignal.timeout(deadlineMs);
  const signal = opts.signal ? AbortSignal.any([deadline, opts.signal]) : deadline;
  try {
    const r = await fetchMissingTiles(conn, demDir, { limit: NIGHTLY_TILE_LIMIT, ...opts, signal });
    const fetched = r.fromSrtm.length + r.fromGlo30.length;
    if (fetched === 0 && r.deferred === 0) return null;
    return `${fetched} elevation tile(s) fetched` + (r.deferred > 0 ? `, ${r.deferred} left for the next run` : "");
  } catch (err) {
    // A shutdown stops the run, as it does at every step boundary.
    opts.signal?.throwIfAborted();
    if (deadline.aborted) {
      return `elevation tile fetch stopped after ${Math.round(deadlineMs / 60_000)} minutes; deriving from the tiles on disk`;
    }
    return `elevation tile fetch failed (${(err as Error).message}); deriving from the tiles on disk`;
  }
}

/** Where the gazetteer goes on the machine (docs/runbooks/deploy-fly.md); built on a workstation. */
export const GAZETTEER_PATH = "data/gazetteer.duckdb";

/**
 * A locality named from each sample's coordinates (beeline-7i6), after
 * elevations. NEVER FAILS THE RUN, for refreshTiles's reason: a suggested
 * locality is never a QC finding and never blocks printing, so a failure is
 * said in the run's detail and the rest of the night goes on.
 */
export async function refreshLocalities(
  conn: JobContext["conn"],
  gazetteerPath: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    return describeLocalities(await deriveLocalities(conn, gazetteerPath, { signal }));
  } catch (err) {
    signal?.throwIfAborted();
    return `naming localities failed (${(err as Error).message})`;
  }
}

/** Fetch places, promote, elevation and localities, shared by both sync jobs. Exported for its test. */
export async function pipelineTail(
  ctx: JobContext,
  parts: string[],
  personChanges: string,
  samplePaths: SampleLogPaths,
  sampleOverlayPath?: string,
  tiles: FetchTilesOptions & { demDir?: string; gazetteerPath?: string } = {},
): Promise<string> {
  parts.push(await ctx.step("fetch places", () => refreshPlaces(ctx.conn, { signal: ctx.signal })));
  const promoted = await ctx.step("promote observations", () =>
    promoteObservations(ctx.conn, { sampleOverlayPath, retry: { signal: ctx.signal } }),
  );
  parts.push(`${promoted.linkedSamples} samples linked`);
  // A promotion that lost a write race and was run again says so in the
  // run's detail: a retry that keeps happening is a writer worth finding.
  if (promoted.retries > 0) parts.push(`promotion retried ${promoted.retries}× after a write conflict`);
  // A printed sample's coordinates changing is rare enough to name: these are
  // imported stand-ins replaced by the true point (beeline-b34).
  if (promoted.standinsCorrected > 0) {
    parts.push(`${promoted.standinsCorrected} stand-in point(s) replaced by the true one`);
  }
  // A staff decision naming a sample the store no longer holds is a standing
  // condition somebody should read, not a failure: the run's detail carries
  // it and the rest of the pipeline goes on.
  if (promoted.overlayUnresolved.length > 0) {
    parts.push(`${promoted.overlayUnresolved.length} sample overlay row(s) name no sample`);
  }
  // iNaturalist renames an account and promotion rewrites the cached login,
  // which used to happen with no trace at all (beeline-o22). Recorded as its
  // own step rather than inside promotion, because the log is the app's file
  // and promotion is a pure store operation that tests run without one.
  const recorded = await ctx.step("record person changes", () =>
    recordPersonChanges(duckdbReader(ctx.conn), personChanges, { source: "observation_promotion" }),
  );
  if (recorded.appended > 0) parts.push(`${recorded.appended} person changes recorded`);
  // And the samples — the nightly IS the change log's headline writer: the
  // coordinate rewrites, the minting, the free-links. This was wired into the
  // CLI promotion and not here, so a deployed app that never restarted would
  // never have recorded any of it; the adversarial review of PR #32 caught it
  // before the first nightly ran.
  const samples = await ctx.step("record sample changes", () =>
    recordSampleChanges(duckdbReader(ctx.conn), samplePaths, { source: "observation_promotion" }),
  );
  if (samples.baselined) parts.push("sample change log baselined");
  else if (samples.appended > 0) parts.push(`${samples.appended} sample changes recorded`);
  const demDir = tiles.demDir ?? deploymentPath("data/dem");
  const fetched = await ctx.step("fetch elevation tiles", () =>
    refreshTiles(ctx.conn, demDir, { signal: ctx.signal, ...tiles }),
  );
  if (fetched !== null) parts.push(fetched);
  const elevation = await ctx.step("derive elevations", () => deriveElevations(ctx.conn, demDir));
  parts.push(
    `elevation ${elevation.filled}/${elevation.gaps} filled` +
      (elevation.refused > 0 ? `, ${elevation.refused} refused as too uncertain` : "") +
      (elevation.missingTiles.length > 0 ? ` (missing tiles: ${elevation.missingTiles.join(", ")})` : ""),
  );
  const localities = await ctx.step("name localities", () =>
    refreshLocalities(ctx.conn, tiles.gazetteerPath ?? deploymentPath(GAZETTEER_PATH), ctx.signal),
  );
  if (localities !== null) parts.push(localities);
  // A refused snapshot (beeline-hrw) fails the run — after every store step
  // has done its work, so nothing the nightly is for waits on it — because a
  // refusal is a standing condition that needs a person, and a run marked
  // succeeded would leave `/healthz/jobs` green while the history went
  // unrecorded night after night (CodeRabbit on PR #92). The retry is the
  // framework's ordinary one: every fifteen minutes inside the night
  // carve-out, an incremental sync and a promotion each time, bounded by
  // the carve-out's end; `failing` is what the health check then says, with
  // this message as the detail.
  if (samples.refused !== null) {
    throw new Error(`sample history not recorded: ${samples.refused} (${parts.join("; ")})`);
  }
  return parts.join("; ");
}

export function buildJobs(
  config: Pick<
    AppConfig,
    "syncProjects" | "sweepDays" | "personChangesPath" | "sampleChangesPath" | "sampleStatePath"
  > &
    Partial<
      Pick<
        AppConfig,
        | "sampleOverlayPath"
        | "exportsDir"
        | "flyMetrics"
        | "ecdysis"
        | "ecdysisDir"
        | "driveBackup"
        | "backupsDir"
        | "environment"
        | "privateDbKey"
        | "release"
        | "correctionsPath"
        | "personOverlayPath"
        | "programContactsPath"
      >
    >,
): Job[] {
  const samplePaths: SampleLogPaths = { log: config.sampleChangesPath, state: config.sampleStatePath };
  return [
    {
      name: "session-purge",
      schedule: { kind: "everyMinutes", minutes: 60 },
      window: "interactive",
      async run(ctx) {
        await ctx.step("purge idle sessions", () => purgeIdleSessions(ctx.db));
      },
    },
    {
      // Incremental ingestion (beeline-3hj): updated_since catches edits and
      // creations of any-aged observation since the last run. First run ever
      // for a source falls back to a full sweep of the presence window.
      name: "nightly-pipeline",
      schedule: { kind: "dailyLA", hour: 2 },
      window: "night",
      async run(ctx) {
        if (config.syncProjects.length === 0) {
          return "no projects configured (BEELINE_SYNC_PROJECTS) — nothing to sync";
        }
        const token = await ctx.step("mint JWT", mintJwt);
        const parts: string[] = [];
        for (const projectId of config.syncProjects) {
          const last = await lastSyncStart(ctx.db, String(projectId));
          if (last === null) {
            const d1 = sweepStart(config.sweepDays);
            const r = await ctx.step(`first full sweep ${projectId}`, () => syncINat(ctx.conn, { projectId, d1, token, signal: ctx.signal }));
            parts.push(`project ${projectId} (first sweep since ${d1}): ${r.fetched} fetched, ${r.newLoads} new`);
          } else {
            const updatedSince = new Date(last.getTime() - UPDATED_SINCE_MARGIN_MS).toISOString();
            const r = await ctx.step(`incremental ${projectId}`, () => syncINat(ctx.conn, { projectId, updatedSince, token, signal: ctx.signal }));
            parts.push(`project ${projectId} (updated since ${updatedSince.slice(0, 16)}Z): ${r.fetched} fetched, ${r.newLoads} new`);
          }
        }
        // Before promotion, which writes what they say onto their samples.
        parts.push(await ctx.step("read cited observations", () => refreshCitedObservations(ctx.conn, { token, signal: ctx.signal })));
        return pipelineTail(ctx, parts, config.personChangesPath, samplePaths, config.sampleOverlayPath);
      },
    },
    {
      // The nightly backup (beeline-elf, GitHub #126). At 3am, after the 1am
      // determinations and the 2am promotion. Ahead of the Sunday sweep and
      // the Ecdysis fetch in this list, because due jobs run in list order
      // and a night job may not start at 5am or later: behind a long sweep it
      // would miss the night, and a single missed night shows nowhere (a
      // daily job is overdue after two). What Ecdysis sends back is in the
      // next night's copy. The 4am jobs write exports, which are regenerated
      // from the store.
      name: "store-backup",
      schedule: { kind: "dailyLA", hour: 3 },
      window: "night",
      async run(ctx) {
        if (!config.driveBackup) {
          const unset = "BEELINE_DRIVE_KEY and BEELINE_BACKUP_FOLDER are not set";
          // A backup job that succeeds at doing nothing reads, on /jobs and
          // in Sentry, like a backup.
          if (config.environment === "development") return `${unset} — nothing backed up`;
          throw new Error(`${unset}: nothing was backed up`);
        }
        // Never a plaintext copy of the private store on the drive: the job
        // is handed the key with the rest of the config, and a caller that
        // narrowed the config would otherwise back it up unencrypted, record
        // `encrypted: false`, and pass every check.
        if (!config.privateDbKey && config.environment !== "development") {
          throw new Error("no private-store key (BEELINE_PRIVATE_DB_KEY): refusing to back up the private store unencrypted");
        }
        const [[main]] = (await (await ctx.conn.run("SELECT current_database()")).getRows()) as [[string]];
        const result = await backUp(ctx.conn, {
          workDir: config.backupsDir ?? deploymentPath("data/backups"),
          catalogs: { main, private: "private" },
          privateKey: config.privateDbKey ?? null,
          authored: [
            config.correctionsPath ?? deploymentPath("data/corrections.csv"),
            config.personOverlayPath ?? deploymentPath("data/person-overlay.csv"),
            config.sampleOverlayPath ?? deploymentPath("data/sample-overlay.csv"),
            config.programContactsPath ?? deploymentPath("data/program-contacts.csv"),
            config.personChangesPath,
            config.sampleChangesPath,
            config.sampleStatePath,
          ],
          release: config.release ?? null,
          drive: config.driveBackup,
          step: ctx.step,
          signal: ctx.signal,
        });
        return describeBackup(result);
      },
    },
    {
      // Anti-entropy (beeline-3hj): a full presence sweep of the trailing
      // window — the only kind of run that can prove an observation gone
      // (deletion detection reads covering runs; incremental runs are not).
      name: "weekly-sweep",
      schedule: { kind: "weeklyLA", weekday: 0, hour: 3 },
      window: "night",
      async run(ctx) {
        if (config.syncProjects.length === 0) {
          return "no projects configured (BEELINE_SYNC_PROJECTS) — nothing to sweep";
        }
        const token = await ctx.step("mint JWT", mintJwt);
        const d1 = sweepStart(config.sweepDays);
        const parts: string[] = [];
        for (const projectId of config.syncProjects) {
          const r = await ctx.step(`sweep ${projectId}`, () => syncINat(ctx.conn, { projectId, d1, token, signal: ctx.signal }));
          parts.push(`project ${projectId} (full sweep since ${d1}): ${r.fetched} fetched, ${r.newLoads} new`);
        }
        return pipelineTail(ctx, parts, config.personChangesPath, samplePaths, config.sampleOverlayPath);
      },
    },
    {
      // Volunteers' entries become determinations (beeline-bcq): a draft is
      // theirs to change all day, and from tonight it is history. At 1am, so
      // the 4am legacy export carries the day's work.
      name: "commit-determinations",
      schedule: { kind: "dailyLA", hour: 1 },
      window: "night",
      async run(ctx) {
        const { committed, unchanged, waiting } = await ctx.step("commit drafts", () => commitDeterminationDrafts(ctx.conn));
        return `${committed} determination(s) recorded, ${unchanged} draft(s) unchanged and dropped, ${waiting} waiting for a name`;
      },
    },
    {
      // Determinations made in Ecdysis come back nightly (beeline-9ut.1). At
      // 3am: after the 2am sync's promotion has made tonight's specimens, and
      // before the 4am legacy export, which then carries what the museum
      // changed today. A download only when Ecdysis says something moved; the
      // cached archive reloaded otherwise, so a reseeded store recovers.
      name: "ecdysis-fetch",
      schedule: { kind: "dailyLA", hour: 3 },
      window: "night",
      async run(ctx) {
        if (!config.ecdysis) return "no Ecdysis login (ECDYSIS_USERNAME / ECDYSIS_PASSWORD) — nothing to fetch";
        const parts: string[] = [];
        for (const collection of ECDYSIS_COLLECTIONS) {
          const r = await fetchEcdysis(ctx.conn, collection, {
            dir: config.ecdysisDir ?? deploymentPath("data/ecdysis"),
            credentials: config.ecdysis,
            signal: ctx.signal,
            step: ctx.step,
          });
          parts.push(describeFetch(r));
        }
        return parts.join("; ");
      },
    },
    {
      // What the machine used in the last day against what it has (Peter,
      // 2026-10-01): it fails when a limit in BUDGET was crossed, which is
      // what puts it on /healthz/jobs and fails its Sentry check-in. Ahead of
      // the export in this list, so it starts first at 4am — due jobs run in
      // list order, and an export running past 5 would otherwise leave the
      // day unchecked (CodeRabbit on #120). It takes seconds, and the 24
      // hours it reads still hold yesterday's export.
      name: "resource-budget",
      schedule: { kind: "dailyLA", hour: 4 },
      window: "night",
      async run(ctx) {
        if (!config.flyMetrics) return "not on Fly (no FLY_METRICS_TOKEN / FLY_APP_NAME) — nothing to measure";
        const usage = await measureFlyUsage(config.flyMetrics, { step: ctx.step, signal: ctx.signal });
        const problems = budgetProblems(usage);
        if (problems.length > 0) throw new Error(`${problems.join("; ")} — ${describeUsage(usage)}`);
        return describeUsage(usage);
      },
    },
    {
      // The legacy system's occurrences file, kept current (beeline-6q8):
      // reporting built on that dump — Andony's comparison, the taxonomists'
      // Ecdysis uploads — reads this instead once the legacy system freezes.
      // After the nightly and clear of Sunday's sweep, so it describes the
      // store the night's promotion left behind.
      name: "legacy-export",
      schedule: { kind: "dailyLA", hour: 4 },
      window: "night",
      async run(ctx) {
        const path = legacyExportPath(config.exportsDir ?? deploymentPath("data/exports"));
        // On one thread, as writeLegacyExport always runs, for its memory.
        const { rows, staged } = await ctx.step("write the export", () => writeLegacyExport(ctx.conn, path));
        return `${rows} rows written to ${path}${staged ? "" : " (no legacy staging: legacy-only columns blank)"}`;
      },
    },
    {
      // One Darwin Core archive per calendar year for each atlas and for
      // Master Melittology, for staff to review; none for the BLM surveys,
      // whose samples are not theirs by geography (beeline-rvun). After the
      // legacy export, so it reads the same store; on Exports.
      name: "dwc-archives",
      schedule: { kind: "dailyLA", hour: 4 },
      window: "night",
      async run(ctx) {
        const manifest = await writeProgramArchives(ctx.db, config.exportsDir ?? deploymentPath("data/exports"), { step: ctx.step });
        return describeManifest(manifest);
      },
    },
  ];
}
