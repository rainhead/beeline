import { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

/**
 * Authenticated iNaturalist sync (v2 API). One run = one source + window,
 * transactional: an incomplete run persists nothing — partial fetches fail
 * loudly rather than reporting empty success. Sweeps use id-keyset
 * pagination (drift-immune over a live window; no 10k cap). The fields
 * parameter IS the whitelisted projection; loads are append-only, deduped
 * by canonical-JSON sha256.
 */

// The whitelisted projection. Private fields are simply absent when the
// token lacks trust — provenance rules read viewer_trusted_by_observer.
const FIELDS = [
  "id", "uuid", "observed_on",
  "geojson", "private_geojson", "positional_accuracy", "public_positional_accuracy",
  "geoprivacy", "taxon_geoprivacy", "obscured", "viewer_trusted_by_observer",
  "place_guess", "private_place_guess", "place_ids", "private_place_ids",
  "quality_grade", "user.id", "user.login", "user.name",
  "taxon.id", "taxon.name", "taxon.rank",
  "ofvs.name", "ofvs.value", "ofvs.datatype",
].join(",");

export interface SyncOptions {
  projectId: number;
  d1?: string;
  d2?: string;
  /** undefined → fall back to INAT_JWT / data/secrets/inat-jwt; null → explicitly tokenless (tests). */
  token?: string | null;
  /** Explicit dev-only escape hatch; never the silent default. */
  anonymous?: boolean;
  perPage?: number;
  fetchImpl?: typeof fetch;
  /** Pause between pages; the public API allows 100 req/min, we stay well under. */
  pageDelayMs?: number;
  apiBase?: string;
}

export interface SyncResult {
  syncRunId: number;
  fetched: number;
  newLoads: number;
  unchanged: number;
}

/** JSON.stringify with recursively sorted keys, so hashes are stable. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

async function readTokenFallback(): Promise<string | undefined> {
  if (process.env.INAT_JWT) return process.env.INAT_JWT.trim();
  try {
    return (await readFile("data/secrets/inat-jwt", "utf8")).trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function syncINat(conn: DuckDBConnection, opts: SyncOptions): Promise<SyncResult> {
  const token = opts.token === null ? undefined : (opts.token ?? (await readTokenFallback()));
  if (!token && !opts.anonymous) {
    throw new Error(
      "no iNaturalist token (INAT_JWT or data/secrets/inat-jwt) — refusing to run silently anonymous. " +
        "Get a 24h JWT from https://www.inaturalist.org/users/api_token, or pass --anonymous (dev only).",
    );
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const perPage = opts.perPage ?? 200;
  const apiBase = opts.apiBase ?? "https://api.inaturalist.org/v2";
  const scalar = async (sql: string, params: unknown[] = []): Promise<number> => {
    const [[v]] = (await (await conn.run(sql, params as never)).getRows()) as [[bigint | number]];
    return Number(v);
  };

  await conn.run("BEGIN TRANSACTION");
  try {
    const syncRunId = await scalar(
      `INSERT INTO sync_run (source, authenticated, window_start, window_end)
       VALUES ($1, $2, $3, $4) RETURNING entity_id`,
      [String(opts.projectId), !!token, opts.d1 ?? null, opts.d2 ?? null],
    );

    let fetched = 0, newLoads = 0, unchanged = 0, idAbove = 0;
    for (;;) {
      const url = new URL(`${apiBase}/observations`);
      url.searchParams.set("project_id", String(opts.projectId));
      url.searchParams.set("order_by", "id");
      url.searchParams.set("order", "asc");
      url.searchParams.set("id_above", String(idAbove));
      url.searchParams.set("per_page", String(perPage));
      url.searchParams.set("fields", FIELDS);
      if (opts.d1) url.searchParams.set("d1", opts.d1);
      if (opts.d2) url.searchParams.set("d2", opts.d2);

      const response = await fetchImpl(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) {
        throw new Error(`iNat API ${response.status} on ${url.pathname}?id_above=${idAbove}`);
      }
      const body = (await response.json()) as { results: Array<Record<string, unknown>> };
      const results = body.results ?? [];

      for (const obs of results) {
        fetched += 1;
        // Presence first, unconditionally: unchanged observations leave no
        // load row, and deletion detection needs "this run saw it".
        await conn.run(
          `INSERT INTO observation_seen (sync_run_id, inat_id) VALUES ($1, $2)`,
          [syncRunId, Number(obs.id)],
        );
        const content = canonicalJson(obs);
        const hash = createHash("sha256").update(content).digest("hex");
        const seen = await scalar(
          `SELECT count(*) FROM observation_current WHERE inat_id = $1 AND content_hash = $2`,
          [Number(obs.id), hash],
        );
        if (seen > 0) {
          unchanged += 1;
        } else {
          await conn.run(
            `INSERT INTO observation_load (inat_id, sync_run_id, content, content_hash)
             VALUES ($1, $2, $3, $4)`,
            [Number(obs.id), syncRunId, content, hash],
          );
          newLoads += 1;
        }
      }

      if (results.length < perPage) break; // short page is terminal
      idAbove = Number(results[results.length - 1]!.id); // max RAW id
      if (opts.pageDelayMs !== 0) {
        await new Promise((r) => setTimeout(r, opts.pageDelayMs ?? 1100));
      }
    }

    await conn.run(`UPDATE sync_run SET completed_at = now() WHERE entity_id = $1`, [syncRunId]);
    await conn.run("COMMIT");
    return { syncRunId, fetched, newLoads, unchanged };
  } catch (err) {
    await conn.run("ROLLBACK");
    throw err;
  }
}

// CLI: pnpm inat:sync <projectId> [d1] [d2] [--anonymous] [--db path]
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const anonymous = args.includes("--anonymous");
  const dbIdx = args.indexOf("--db");
  const dbPath = dbIdx >= 0 ? args[dbIdx + 1]! : "beeline.duckdb";
  const positional = args.filter((a, i) => !a.startsWith("--") && (dbIdx < 0 || i !== dbIdx + 1));
  const [projectId, d1, d2] = positional;
  if (!projectId) {
    console.error("usage: pnpm inat:sync <projectId> [d1] [d2] [--anonymous] [--db path]");
    process.exit(2);
  }
  const instance = await DuckDBInstance.create(dbPath);
  const conn = await instance.connect();
  const result = await syncINat(conn, { projectId: Number(projectId), d1, d2, anonymous });
  conn.closeSync();
  console.log(JSON.stringify(result));
}
