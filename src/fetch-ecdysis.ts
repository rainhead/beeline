import type { DuckDBConnection } from "@duckdb/node-api";
import { unzipSync } from "fflate";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadEcdysis, REPORTED_NAMES, type LoadEcdysisResult } from "./load-ecdysis.js";

/**
 * Fetch an Ecdysis collection's Darwin Core archive and load it (beeline-9ut.1),
 * the way beeatlas does nightly (its ADR 0023, ecdysis_pipeline.py).
 *
 * The archive is built by Symbiota on request — about two minutes for
 * Washington's dataset 44 — and only for a signed-in session: an anonymous
 * request is answered 401 since Ecdysis changed it. So before paying for one,
 * Ecdysis's public v2 API is asked two cheap questions about the same
 * population (Washington's by datasetID, not collection: dataset 44 is a
 * subset of WSUC's collection 164; British Columbia's by collection, since
 * its collection 196 has no public dataset): how many records there are, and how many changed since the
 * last download, counted from a day before it. Either number moving means
 * something changed; any doubt — no baseline, the API unreachable — means
 * download, because a skipped download is silent staleness and a needless one
 * costs two minutes. The baseline is read before the download, so a record
 * edited while the archive builds reads as changed next time, and written only
 * once the download has loaded.
 *
 * Unchanged upstream does not mean skip the load: a reseed drops every
 * Ecdysis determination (docs/architecture/determinations-from-ecdysis.md), so the job
 * loads the cached archive instead. The loader is idempotent — on an ordinary
 * night that records nothing — and a reseeded store is whole again by the next
 * morning without anyone remembering to reload it.
 *
 * The credentials are never written to a log, an error or the run's detail.
 */

/**
 * What an archive and its probe are scoped by: a dataset, which is a subset of
 * a collection that Ecdysis publishes under its own id (Washington's is 44),
 * or a whole collection, for one with no public dataset (British Columbia's is
 * 196). The download form says `datasetid=44` or `db=196`; the v2 API says
 * `datasetID=44` or `collid=196`.
 */
export type EcdysisScope = { datasetId: number; collectionId?: undefined } | { collectionId: number; datasetId?: undefined };

export type EcdysisCollection = EcdysisScope & {
  /** What precedes Beeline's field number in the catalog number. */
  catalogPrefix: string;
  /** The program whose determinations the collection holds, by code: what its page says it reads from. */
  program: string;
};

/**
 * The collections Beeline reads determinations back from: Washington's
 * dataset and British Columbia's collection (beeline-9ut.2, beeline-dd8). Code
 * and not a table (beeline-9ut.2): nobody edits these, adding one is a code
 * change anyway (how to ask Ecdysis for it is above), and the store being
 * reseeded or migrated has no bearing on which museum collection an atlas
 * keeps. beeline-5pza reads the prefixes from here.
 */
export const ECDYSIS_COLLECTIONS: readonly EcdysisCollection[] = [
  { datasetId: 44, catalogPrefix: "WSDA_", program: "WaBA" },
  { collectionId: 196, catalogPrefix: "BCBA_", program: "BC" },
];

/** What the collection is called in a log line and on a program's page: "dataset 44", "collection 196". */
export const describeScope = (s: EcdysisScope): string =>
  s.collectionId !== undefined ? `collection ${s.collectionId}` : `dataset ${s.datasetId}`;

/** The name its archive and baseline are kept under. A dataset's stays its bare id, as before collections were an option. */
const scopeKey = (s: EcdysisScope): string => (s.collectionId !== undefined ? `collection-${s.collectionId}` : String(s.datasetId));

/** Where the archive last downloaded for a collection is kept, under the folder the fetch is given. */
export const cachedArchivePath = (dir: string, collection: EcdysisScope): string => join(dir, `${scopeKey(collection)}.zip`);

/**
 * What a successful read of a collection leaves beside its cached archive
 * (`<archive>.read.json`, written after every read that loaded, whether it
 * downloaded the archive or found it unchanged). The upload files
 * (src/app/ecdysis-upload.ts) rest on it: it says when Ecdysis was read and
 * which zip that read loaded, so a zip changed or replaced since is seen.
 */
export interface ReadMarker {
  /** `describeScope`: "dataset 44", "collection 196". */
  scope: string;
  /** When the read began: the time the upload's own rules count freshness and "after the last read" from. */
  readAt: string;
  source: "downloaded" | "cached";
  /** The zip the read loaded: its size in bytes and its modification time. */
  zipBytes: number;
  zipModifiedAt: string;
  /** Occurrences in the archive. */
  records: number;
}

export const readMarkerPath = (dir: string, collection: EcdysisScope): string => join(dir, `${scopeKey(collection)}.read.json`);

/** The marker of the last successful read, or null where there is none or it cannot be read. */
export async function readMarkerOf(dir: string, collection: EcdysisScope): Promise<ReadMarker | null> {
  try {
    const marker = JSON.parse(await readFile(readMarkerPath(dir, collection), "utf8")) as Partial<ReadMarker>;
    const ok =
      typeof marker.scope === "string" && typeof marker.readAt === "string" && !Number.isNaN(Date.parse(marker.readAt)) &&
      (marker.source === "downloaded" || marker.source === "cached") && typeof marker.zipBytes === "number" &&
      typeof marker.zipModifiedAt === "string" && typeof marker.records === "number";
    return ok ? (marker as ReadMarker) : null;
  } catch {
    return null;
  }
}

async function writeReadMarker(dir: string, collection: EcdysisScope, zipPath: string, read: { readAt: Date; source: ReadMarker["source"]; records: number }): Promise<void> {
  const st = await stat(zipPath);
  const marker: ReadMarker = {
    scope: describeScope(collection),
    readAt: read.readAt.toISOString(),
    source: read.source,
    zipBytes: st.size,
    zipModifiedAt: st.mtime.toISOString(),
    records: read.records,
  };
  const path = readMarkerPath(dir, collection);
  await writeFile(`${path}.tmp`, `${JSON.stringify(marker, null, 2)}\n`);
  await rename(`${path}.tmp`, path);
}

export interface EcdysisCredentials {
  username: string;
  password: string;
}

const LOGIN_URL = "https://ecdysis.org/profile/index.php";
const DOWNLOAD_URL = "https://ecdysis.org/collections/download/downloadhandler.php";
const API_URL = "https://ecdysis.org/api/v2/occurrence";
/** The v2 API answers 500 to a lower bound on dateLastModified without an upper one. */
const FAR_FUTURE = "2999-01-01";
const USER_AGENT = "beeline (https://github.com/rainhead/beeline)";

export interface ProbeBaseline {
  /** Which scope this was counted for; exactly one of the two, as in EcdysisScope. */
  datasetId?: number;
  collectionId?: number;
  /** Total records in the dataset when the archive on disk was requested. */
  total: number;
  /** A day before that request: the lower bound of the modified-since count. */
  since: string;
  /** Records modified since `since`, counted at the same moment. */
  modifiedSince: number;
}

export interface FetchEcdysisOptions {
  /** Where the archive and its probe baseline are kept: `<dir>/<dataset id or collection-<id>>.zip`, `.probe.json`. */
  dir: string;
  credentials: EcdysisCredentials;
  signal?: AbortSignal;
  /** Injected in tests; the global fetch otherwise. */
  fetch?: typeof fetch;
  now?: Date;
  /**
   * Download the archive whether or not the probe says Ecdysis changed, for a collection read whole (`collectionId`):
   * the probe counts records and records modified since the last download, so a second change to a record already
   * modified leaves both numbers as they were. The upload files rest on a read that downloaded, so the manual read
   * on a program's Data tab forces one. The nightly run does not. A dataset (Washington's) is read as before.
   */
  force?: boolean;
  /** Run around each phase, as the job framework's ctx.step does; a plain call otherwise. */
  step?: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
}

export interface FetchEcdysisResult {
  /** What was fetched, as `describeScope` words it. */
  scope: string;
  /** Whether the archive was downloaded tonight or the cached one reloaded, and why. */
  source: "downloaded" | "cached";
  reason: string;
  load: LoadEcdysisResult;
}

/** A request's deadline, and the job's abort as well when there is one: a hung Ecdysis must not stall the scheduler. */
const within = (ms: number, signal?: AbortSignal) =>
  signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);

async function apiCount(f: typeof fetch, params: Record<string, string | number>, signal?: AbortSignal): Promise<number> {
  const url = `${API_URL}?${new URLSearchParams({ limit: "1", ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) })}`;
  const res = await f(url, { headers: { "User-Agent": USER_AGENT }, signal: within(30_000, signal) });
  if (!res.ok) throw new Error(`Ecdysis API answered ${res.status}`);
  const count = Number(((await res.json()) as { count?: unknown }).count);
  if (!Number.isInteger(count) || count < 0) throw new Error("Ecdysis API gave no count");
  return count;
}

/** The v2 API's filter for a scope. */
const apiFilter = (s: EcdysisScope): Record<string, number> =>
  s.collectionId !== undefined ? { collid: s.collectionId } : { datasetID: s.datasetId };

/** The two counts, now: the scope's total, and how many changed since `since`. */
export async function probeEcdysis(
  f: typeof fetch,
  scope: EcdysisScope,
  since: string,
  signal?: AbortSignal,
): Promise<{ total: number; modifiedSince: number }> {
  const total = await apiCount(f, apiFilter(scope), signal);
  const modifiedSince = await apiCount(
    f,
    { ...apiFilter(scope), dateLastModifiedMin: since, dateLastModifiedMax: FAR_FUTURE },
    signal,
  );
  return { total, modifiedSince };
}

const dayBefore = (now: Date) => new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);

/** A response's cookies as one Cookie header: Symbiota's session is a cookie set on the login reply. */
function cookieHeader(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";", 1)[0]!.trim())
    .filter((c) => c.includes("="))
    .join("; ");
}

/** Sign in and download the archive. Throws, saying nothing of the credentials, unless the body is a zip. */
export async function downloadArchive(
  f: typeof fetch,
  credentials: EcdysisCredentials,
  scope: EcdysisScope,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  // The login form has no CSRF token; its username field is `login` and the
  // submit is `action=login` (beeatlas, verified 2026-06-24). The reply is a
  // redirect carrying the session cookie, so it is not followed.
  const login = await f(LOGIN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
    body: new URLSearchParams({ login: credentials.username, password: credentials.password, action: "login", remember: "0" }),
    redirect: "manual",
    signal: within(60_000, signal),
  });
  const cookie = cookieHeader(login);
  if (cookie === "") throw new Error(`Ecdysis sign-in set no session cookie (answered ${login.status})`);

  // The same request Ecdysis's own download form makes for one dataset (or,
  // with `db`, one collection), with
  // the identification history (beeatlas's parameters, verified there).
  const body = new URLSearchParams({
    schema: "symbiota",
    identifications: "1",
    images: "0",
    identifiers: "1",
    format: "tab",
    cset: "utf-8",
    zip: "1",
    publicsearch: "1",
    taxonFilterCode: "0",
    sourcepage: "specimen",
    searchvar: new URLSearchParams({
      usethes: "1",
      taxontype: "4",
      "association-type": "none",
      comingFrom: "newsearch",
      ...(scope.collectionId !== undefined ? { db: String(scope.collectionId) } : { datasetid: String(scope.datasetId) }),
    }).toString(),
    submitaction: "",
  });
  const res = await f(DOWNLOAD_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT, Cookie: cookie },
    body,
    signal: within(300_000, signal),
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  // A refused sign-in still answers the download — with JSON or a page, not a
  // zip — so the body is the test of whether the sign-in worked.
  const isZip = bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  if (!res.ok || !isZip) {
    throw new Error(
      `Ecdysis download for ${describeScope(scope)} answered ${res.status} ${res.headers.get("content-type") ?? ""}, not a zip` +
        (res.status === 401 ? " — the sign-in was refused (check ECDYSIS_USERNAME / ECDYSIS_PASSWORD)" : ""),
    );
  }
  return bytes;
}

async function readBaseline(path: string): Promise<ProbeBaseline | null> {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8")) as ProbeBaseline;
  } catch {
    return null; // a baseline that cannot be read is no baseline: download
  }
}

/** Unpack the two files the loader reads into a fresh directory under `dir`, and load them. */
async function loadArchive(
  conn: DuckDBConnection,
  zip: Uint8Array,
  dir: string,
  collection: EcdysisCollection,
  now: Date,
): Promise<LoadEcdysisResult & { archiveRows: number }> {
  const files = unzipSync(zip, { filter: (f) => /^(occurrences|identifications)\.(tab|csv|txt)$/i.test(f.name) });
  if (Object.keys(files).length < 2) {
    throw new Error(`Ecdysis archive for ${describeScope(collection)} lacks occurrences or identifications (has: ${Object.keys(files).join(", ") || "nothing"})`);
  }
  const unpacked = await mkdtemp(join(dir, `${scopeKey(collection)}-unpacked-`));
  try {
    for (const [name, data] of Object.entries(files)) await writeFile(join(unpacked, name), data);
    // The archive's own count of occurrence rows, as the upload code counts them again from the zip. The loader's
    // `occurrences` is a count over a join to specimens, and an Ecdysis record whose label number is on two
    // specimens is counted twice there (src/load-ecdysis.ts, beeline-1kb.14): it is not the archive's.
    const occurrencesFile = Object.keys(files).find((n) => /^occurrences\.(tab|csv|txt)$/i.test(n))!;
    const counted = await conn.runAndReadAll(
      `SELECT count(*) FROM read_csv('${join(unpacked, occurrencesFile).replaceAll("'", "''")}', header = true, all_varchar = true)`,
    );
    const archiveRows = Number(counted.getRows()[0]![0]);
    return { ...(await loadEcdysis(conn, { path: unpacked, catalogPrefix: collection.catalogPrefix, now })), archiveRows };
  } finally {
    await rm(unpacked, { recursive: true, force: true });
  }
}

export async function fetchEcdysis(
  conn: DuckDBConnection,
  collection: EcdysisCollection,
  opts: FetchEcdysisOptions,
): Promise<FetchEcdysisResult> {
  const f = opts.fetch ?? fetch;
  const now = opts.now ?? new Date();
  const step = opts.step ?? (<T>(_: string, fn: () => Promise<T>) => fn());
  const scope: EcdysisScope = collection.collectionId !== undefined ? { collectionId: collection.collectionId } : { datasetId: collection.datasetId };
  await mkdir(opts.dir, { recursive: true });
  const zipPath = cachedArchivePath(opts.dir, collection);
  const baselinePath = join(opts.dir, `${scopeKey(collection)}.probe.json`);

  // Read the source before anything else, and decide.
  const baseline = await readBaseline(baselinePath);
  const since = dayBefore(now);
  let reason: string;
  let fresh: { total: number; modifiedSince: number } | null = null;
  let unchanged = false;
  const forced = opts.force === true && collection.collectionId !== undefined;
  try {
    fresh = await step("probe Ecdysis", () => probeEcdysis(f, scope, since, opts.signal));
    if (forced) {
      // The counts are still taken, for the baseline the nightly run compares with, but they decide nothing.
      reason = "a download was asked for";
    } else if (baseline === null || baseline.datasetId !== scope.datasetId || baseline.collectionId !== scope.collectionId || !existsSync(zipPath)) {
      reason = "no archive downloaded before";
    } else {
      const sinceThen = await step("probe since the last download", () =>
        probeEcdysis(f, scope, baseline.since, opts.signal),
      );
      unchanged = sinceThen.total === baseline.total && sinceThen.modifiedSince === baseline.modifiedSince;
      reason = unchanged
        ? `unchanged since ${baseline.since} (${sinceThen.total} records)`
        : `${sinceThen.total - baseline.total >= 0 ? "+" : ""}${sinceThen.total - baseline.total} records, ` +
          `${Math.max(0, sinceThen.modifiedSince - baseline.modifiedSince)} more modified since ${baseline.since}`;
    }
  } catch (err) {
    reason = `probe failed (${(err as Error).message}), so downloading`;
  }

  if (unchanged) {
    // "Nothing moved" is about Ecdysis, not about the file here: the kept zip must still be the one the last read
    // loaded (the marker's size and time), or the upload code, which trusts that marker, would be blessing whatever
    // file happens to be there. A store deployed before the marker existed has none, and downloads once.
    const marker = await readMarkerOf(opts.dir, collection);
    const st = await stat(zipPath).catch(() => null);
    if (marker === null || st === null || st.size !== marker.zipBytes || st.mtime.toISOString() !== marker.zipModifiedAt) {
      unchanged = false;
      reason = "the kept archive is not the one the last read loaded, so downloading";
    }
  }
  if (unchanged) {
    try {
      const zip = new Uint8Array(await readFile(zipPath));
      const { archiveRows, ...load } = await step("load the cached archive", () => loadArchive(conn, zip, opts.dir, collection, now));
      await writeReadMarker(opts.dir, collection, zipPath, { readAt: now, source: "cached", records: archiveRows });
      return { scope: describeScope(scope), source: "cached", reason, load };
    } catch (err) {
      // A kept archive that will not load would fail every night until
      // somebody deleted it; a fresh one costs two minutes. An abort is the
      // job being stopped, not the archive, and goes on up.
      if (opts.signal?.aborted) throw err;
      reason = `the kept archive could not be loaded (${(err as Error).message}), so downloading`;
    }
  }

  const zip = await step("download the archive", () => downloadArchive(f, opts.credentials, scope, opts.signal));
  const { archiveRows, ...load } = await step("load the archive", () => loadArchive(conn, zip, opts.dir, collection, now));
  // Kept only once it has loaded, and the baseline with it: a failed load
  // leaves the previous pair, so the next night downloads again.
  await writeFile(`${zipPath}.tmp`, zip);
  await rename(`${zipPath}.tmp`, zipPath);
  if (fresh !== null) {
    const next: ProbeBaseline = { ...scope, total: fresh.total, since, modifiedSince: fresh.modifiedSince };
    await writeFile(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
  } else {
    await rm(baselinePath, { force: true }); // no probe, no baseline: tomorrow downloads again
  }
  await writeReadMarker(opts.dir, collection, zipPath, { readAt: now, source: "downloaded", records: archiveRows });
  return { scope: describeScope(scope), source: "downloaded", reason, load };
}

/** One line for the job's detail: what was fetched, what loaded, and what is left for a person. */
export function describeFetch(r: FetchEcdysisResult): string {
  const l = r.load;
  const parts = [
    `${r.scope} ${r.source === "downloaded" ? "downloaded" : "cached archive reloaded"} (${r.reason})`,
    `${l.loaded} determination(s) recorded`,
    `${l.matched}/${l.occurrences} occurrences matched`,
  ];
  if (l.catalogNumbers > 0) parts.push(`${l.catalogNumbers} catalog number(s) recorded or changed`);
  if (l.ambiguousCatalogNumbers > 0)
    parts.push(`${l.ambiguousCatalogNumbers} catalog number(s) not recorded, their field number being on two specimens`);
  if (l.ambiguousIdentifications > 0)
    parts.push(`${l.ambiguousIdentifications} identification(s) held back for the same reason`);
  if (l.adopted.length > 0) parts.push(`${l.adopted.length} name(s) adopted from Ecdysis's thesaurus: ${l.adopted.map((a) => a.name).join(", ")}`);
  if (l.refiled > 0) parts.push(`${l.refiled} record(s) made again under their own name, no longer filed under a broader one`);
  const count = (n: number) => (n >= REPORTED_NAMES ? `at least ${n}` : String(n));
  if (l.filedUnder.length > 0) parts.push(`${count(l.filedUnder.length)} bycatch name(s) recorded under a broader name`);
  if (l.unresolvedNames.length > 0) parts.push(`${count(l.unresolvedNames.length)} name(s) unresolved`);
  return parts.join("; ");
}
