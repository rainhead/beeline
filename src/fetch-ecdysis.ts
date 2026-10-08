import type { DuckDBConnection } from "@duckdb/node-api";
import { unzipSync } from "fflate";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadEcdysis, type LoadEcdysisResult } from "./load-ecdysis.js";

/**
 * Fetch an Ecdysis collection's Darwin Core archive and load it (beeline-9ut.1),
 * the way beeatlas does nightly (its ADR 0023, ecdysis_pipeline.py).
 *
 * The archive is built by Symbiota on request — about two minutes for
 * Washington's dataset 44 — and only for a signed-in session: an anonymous
 * request is answered 401 since Ecdysis changed it. So before paying for one,
 * Ecdysis's public v2 API is asked two cheap questions about the same
 * population (by datasetID, not collection: dataset 44 is a subset of WSUC's
 * collection 164): how many records there are, and how many changed since the
 * last download, counted from a day before it. Either number moving means
 * something changed; any doubt — no baseline, the API unreachable — means
 * download, because a skipped download is silent staleness and a needless one
 * costs two minutes. The baseline is read before the download, so a record
 * edited while the archive builds reads as changed next time, and written only
 * once the download has loaded.
 *
 * Unchanged upstream does not mean skip the load: a reseed drops every
 * Ecdysis determination (CLAUDE.md, Determinations from Ecdysis), so the job
 * loads the cached archive instead. The loader is idempotent — on an ordinary
 * night that records nothing — and a reseeded store is whole again by the next
 * morning without anyone remembering to reload it.
 *
 * The credentials are never written to a log, an error or the run's detail.
 */

export interface EcdysisCollection {
  /** Symbiota's dataset id: what the archive and the probe are scoped by. */
  datasetId: number;
  /** What precedes Beeline's field number in the catalog number. */
  catalogPrefix: string;
}

/**
 * The collections Beeline reads determinations back from. Washington's only,
 * until which collections the other atlases keep is answered (beeline-9ut.2,
 * where this becomes reference data beside atlas_printing).
 */
export const ECDYSIS_COLLECTIONS: readonly EcdysisCollection[] = [{ datasetId: 44, catalogPrefix: "WSDA_" }];

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
  datasetId: number;
  /** Total records in the dataset when the archive on disk was requested. */
  total: number;
  /** A day before that request: the lower bound of the modified-since count. */
  since: string;
  /** Records modified since `since`, counted at the same moment. */
  modifiedSince: number;
}

export interface FetchEcdysisOptions {
  /** Where the archive and its probe baseline are kept: `<dir>/<datasetId>.zip`, `.probe.json`. */
  dir: string;
  credentials: EcdysisCredentials;
  signal?: AbortSignal;
  /** Injected in tests; the global fetch otherwise. */
  fetch?: typeof fetch;
  now?: Date;
  /** Run around each phase, as the job framework's ctx.step does; a plain call otherwise. */
  step?: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
}

export interface FetchEcdysisResult {
  datasetId: number;
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

/** The two counts, now: the dataset's total, and how many changed since `since`. */
export async function probeEcdysis(
  f: typeof fetch,
  datasetId: number,
  since: string,
  signal?: AbortSignal,
): Promise<{ total: number; modifiedSince: number }> {
  const total = await apiCount(f, { datasetID: datasetId }, signal);
  const modifiedSince = await apiCount(
    f,
    { datasetID: datasetId, dateLastModifiedMin: since, dateLastModifiedMax: FAR_FUTURE },
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
  datasetId: number,
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

  // The same request Ecdysis's own download form makes for one dataset, with
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
      datasetid: String(datasetId),
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
      `Ecdysis download for dataset ${datasetId} answered ${res.status} ${res.headers.get("content-type") ?? ""}, not a zip` +
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
): Promise<LoadEcdysisResult> {
  const files = unzipSync(zip, { filter: (f) => /^(occurrences|identifications)\.(tab|csv|txt)$/i.test(f.name) });
  if (Object.keys(files).length < 2) {
    throw new Error(`Ecdysis archive for dataset ${collection.datasetId} lacks occurrences or identifications (has: ${Object.keys(files).join(", ") || "nothing"})`);
  }
  const unpacked = await mkdtemp(join(dir, `${collection.datasetId}-unpacked-`));
  try {
    for (const [name, data] of Object.entries(files)) await writeFile(join(unpacked, name), data);
    return await loadEcdysis(conn, { path: unpacked, catalogPrefix: collection.catalogPrefix, now });
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
  const { datasetId } = collection;
  await mkdir(opts.dir, { recursive: true });
  const zipPath = join(opts.dir, `${datasetId}.zip`);
  const baselinePath = join(opts.dir, `${datasetId}.probe.json`);

  // Read the source before anything else, and decide.
  const baseline = await readBaseline(baselinePath);
  const since = dayBefore(now);
  let reason: string;
  let fresh: { total: number; modifiedSince: number } | null = null;
  let unchanged = false;
  try {
    fresh = await step("probe Ecdysis", () => probeEcdysis(f, datasetId, since, opts.signal));
    if (baseline === null || baseline.datasetId !== datasetId || !existsSync(zipPath)) {
      reason = "no archive downloaded before";
    } else {
      const sinceThen = await step("probe since the last download", () =>
        probeEcdysis(f, datasetId, baseline.since, opts.signal),
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
    try {
      const zip = new Uint8Array(await readFile(zipPath));
      const load = await step("load the cached archive", () => loadArchive(conn, zip, opts.dir, collection, now));
      return { datasetId, source: "cached", reason, load };
    } catch (err) {
      // A kept archive that will not load would fail every night until
      // somebody deleted it; a fresh one costs two minutes. An abort is the
      // job being stopped, not the archive, and goes on up.
      if (opts.signal?.aborted) throw err;
      reason = `the kept archive could not be loaded (${(err as Error).message}), so downloading`;
    }
  }

  const zip = await step("download the archive", () => downloadArchive(f, opts.credentials, datasetId, opts.signal));
  const load = await step("load the archive", () => loadArchive(conn, zip, opts.dir, collection, now));
  // Kept only once it has loaded, and the baseline with it: a failed load
  // leaves the previous pair, so the next night downloads again.
  await writeFile(`${zipPath}.tmp`, zip);
  await rename(`${zipPath}.tmp`, zipPath);
  if (fresh !== null) {
    const next: ProbeBaseline = { datasetId, total: fresh.total, since, modifiedSince: fresh.modifiedSince };
    await writeFile(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
  } else {
    await rm(baselinePath, { force: true }); // no probe, no baseline: tomorrow downloads again
  }
  return { datasetId, source: "downloaded", reason, load };
}

/** One line for the job's detail: what was fetched, what loaded, and what is left for a person. */
export function describeFetch(r: FetchEcdysisResult): string {
  const l = r.load;
  const parts = [
    `dataset ${r.datasetId} ${r.source === "downloaded" ? "downloaded" : "cached archive reloaded"} (${r.reason})`,
    `${l.loaded} determination(s) recorded`,
    `${l.matched}/${l.occurrences} occurrences matched`,
  ];
  if (l.adopted.length > 0) parts.push(`${l.adopted.length} name(s) adopted from ITIS: ${l.adopted.map((a) => a.name).join(", ")}`);
  if (l.unresolvedNames.length > 0) parts.push(`${l.unresolvedNames.length} name(s) unresolved`);
  return parts.join("; ");
}
