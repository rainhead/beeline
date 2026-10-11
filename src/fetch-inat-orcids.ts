import { DuckDBConnection } from "@duckdb/node-api";
import { pathToFileURL } from "node:url";
import { openDuckDb } from "./db.js";
import { parseOrcid } from "./orcid.js";
import { changeLogFor, DEFAULT_DB, duckdbReader, recordPersonChanges } from "./person-change.js";

/**
 * Refresh inat_user_orcid (schema/010): the ORCID iD each bound iNaturalist
 * account has connected (beeline-yaaj).
 *
 * Sign-in records it for whoever signs in (src/app/auth.tsx), which is the
 * route that matters: somebody told how to connect an ORCID is somebody who
 * uses Beeline. This is the same for every bound account at once, for the
 * people who never sign in, and is run by hand rather than on a schedule.
 *
 * iNaturalist holds an ORCID only as a connected account — the person signs
 * in to ORCID from Settings → Applications → Connected Accounts — and the
 * API reports it as `orcid` on the user record. A user record comes back in
 * bulk only from the observers endpoint, which takes a list of user ids and
 * returns each one's profile, but only for users with an observation; the
 * rest are asked for one at a time through /v1/users/{id}. Of the 437
 * accounts Beeline bound on 2026-10-10, 2 had connected one.
 *
 * Unauthenticated: a profile is public, and a token would buy nothing.
 *
 * An account iNaturalist answered for is restated — its row replaced, or
 * removed if it has disconnected its ORCID. One it did not answer for (the
 * request failed) keeps what it had, so a bad night costs nothing.
 */

const IDS_PER_REQUEST = 100;

export interface FetchOrcidsOptions {
  fetchImpl?: typeof fetch;
  apiBase?: string;
  /** The public API allows 100 req/min; stay well under, as the other fetches do. */
  requestDelayMs?: number;
  signal?: AbortSignal;
}

export interface FetchOrcidsResult {
  /** Bound accounts asked about. */
  accounts: number;
  /** Of those, how many iNaturalist answered for. */
  answered: number;
  /** Accounts holding an ORCID once the refresh is done. */
  withOrcid: number;
  requests: number;
}

interface InatUser {
  id: number;
  orcid?: string | null;
}

const pause = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

export async function fetchInatOrcids(
  conn: DuckDBConnection,
  opts: FetchOrcidsOptions = {},
): Promise<FetchOrcidsResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiBase = opts.apiBase ?? "https://api.inaturalist.org/v1";
  const delay = opts.requestDelayMs ?? 1100;
  const ids = ((await (await conn.run(`SELECT inat_user_id FROM inat_account ORDER BY inat_user_id`)).getRows()) as [
    bigint,
  ][]).map(([id]) => Number(id));

  // user id → the bare iD, or null for an account that has none.
  const answered = new Map<number, string | null>();
  let requests = 0;
  const get = async (url: string): Promise<Response | null> => {
    opts.signal?.throwIfAborted();
    if (requests > 0) await pause(delay);
    requests++;
    const response = await fetchImpl(url, { signal: opts.signal });
    return response.ok ? response : response.status === 404 ? null : Promise.reject(new Error(`HTTP ${response.status} from ${url}`));
  };
  // A profile's orcid is the URL iNaturalist shows, https://orcid.org/…;
  // one that does not read as an iD is treated as none rather than stored.
  const record = (user: InatUser) => answered.set(user.id, user.orcid ? parseOrcid(user.orcid) : null);

  for (let i = 0; i < ids.length; i += IDS_PER_REQUEST) {
    const chunk = ids.slice(i, i + IDS_PER_REQUEST);
    const response = await get(
      `${apiBase}/observations/observers?user_id=${chunk.join(",")}&per_page=${IDS_PER_REQUEST}`,
    );
    if (response === null) continue;
    const body = (await response.json()) as { results: Array<{ user: InatUser }> };
    for (const { user } of body.results ?? []) if (chunk.includes(user.id)) record(user);
  }
  for (const id of ids.filter((id) => !answered.has(id))) {
    const response = await get(`${apiBase}/users/${id}`);
    // Gone from iNaturalist altogether: it has no ORCID to report.
    if (response === null) {
      answered.set(id, null);
      continue;
    }
    const body = (await response.json()) as { results: InatUser[] };
    const user = body.results?.[0];
    if (user?.id === id) record(user);
  }

  await conn.run("BEGIN TRANSACTION");
  try {
    for (const [id, orcid] of answered) {
      await conn.run(`DELETE FROM inat_user_orcid WHERE inat_user_id = $1`, [id] as never);
      if (orcid !== null) {
        await conn.run(`INSERT INTO inat_user_orcid (inat_user_id, orcid) VALUES ($1, $2)`, [id, orcid] as never);
      }
    }
    await conn.run("COMMIT");
  } catch (err) {
    await conn.run("ROLLBACK");
    throw err;
  }
  const withOrcid = Number(
    ((await (
      await conn.run(
        `SELECT count(*) FROM inat_user_orcid o JOIN inat_account a ON a.inat_user_id = o.inat_user_id`,
      )
    ).getRows()) as [bigint][])[0]![0],
  );
  return { accounts: ids.length, answered: answered.size, withOrcid, requests };
}

// CLI: pnpm inat:fetch-orcids [db]. Holds the store, so on the sandbox it runs
// in maintenance mode. Records what changed in the person log under its own
// name, as the account backfill does, when pointed at the store this
// environment keeps a log for.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const dbPath = process.argv[2] ?? process.env.BEELINE_DB ?? DEFAULT_DB;
  const instance = await openDuckDb(dbPath);
  const conn = await instance.connect();
  const result = await fetchInatOrcids(conn);
  const log = changeLogFor(dbPath, process.env);
  const recorded =
    log === null ? null : (await recordPersonChanges(duckdbReader(conn), log, { source: "inat_orcid_fetch" })).appended;
  await conn.run("CHECKPOINT");
  conn.closeSync();
  console.log(JSON.stringify({ ...result, personChangesRecorded: recorded }, null, 2));
}
