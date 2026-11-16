import { DuckDBConnection } from "@duckdb/node-api";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openDuckDb } from "./db.js";
import {
  fetchEcdysisTaxonomy,
  LIVE_ECDYSIS_TAXONOMY_DIR,
  MANIFEST_FILE,
  TAXA_COLUMNS,
  TAXA_FILE,
} from "./fetch-ecdysis-taxonomy.js";
import { DEFAULT_DB } from "./person-change.js";

/**
 * Load a fetch of Ecdysis's thesaurus into the store and match every animal
 * node against it (beeline-7gob, in place of ITIS).
 *
 * The fetch (src/fetch-ecdysis-taxonomy.ts) holds every insect name at every
 * rank Ecdysis uses. The store keeps only the ranks animal_rank admits — a
 * Symbiota rank id is an animal_rank ordinal — and gives each accepted name
 * its nearest admitted ancestor (admitted_parent_tid), walking past the
 * tribes, subfamilies and subclasses in between, so adoption can follow a
 * name up to the tree. The walk passes a subgenus too: Ecdysis files a
 * species under its subgenus (Lasioglossum tenax under Lasioglossum
 * (Dialictus)), but the tree files every species under its genus and keeps
 * subgenera as leaves (ingest/seed-animals.sql), and an adopted species has
 * to land where the tree's own species are. Where a parent is a synonym the
 * walk goes on from its accepted name instead: 12,915 accepted insect names
 * in the 2026-10-23 fetch sit under a synonym (Xeromelecta larreae under
 * Xeromelecta, which Ecdysis files under Brachymelecta), and adopting along
 * that chain would mint a node for a name Ecdysis rejects, on nobody's word
 * (Fable's review). And a genus spelled like a subgenus — Ecdysis holds
 * Lasioglossum (Eickwortia), L. (Habralictellus) and Xenoglossa (Cemolobus) at
 * genus rank, directly under the family — ends the walk with no ancestor,
 * since passing it would file its species under the family: a name below one
 * is left for a person rather than adopted somewhere wrong.
 *
 * Wholesale and in one transaction: a fetch replaces the one before it, and
 * animal.ecdysis_tid is restated from the new rows before anything commits,
 * so no reader sees one fetch's ids read against another's. A fetch with no
 * name at an admitted rank is refused, because loading it would quietly take
 * every node's id away.
 */

export interface LoadEcdysisTaxonomyResult {
  /** Names kept: at a rank animal_rank admits. */
  taxa: number;
  synonyms: number;
  /** Names the fetch held at a rank the store does not admit — tribes, subfamilies — and so not kept. */
  notAdmitted: number;
  /**
   * Synonyms whose accepted name is itself a synonym, or not in the store.
   * 65 on 2026-10-23: 25 filed under another synonym (Crocidosoma under
   * Crocidosema, itself one) and 40 under an accepted name at a rank the
   * store does not keep, none of them a bee. They load as Ecdysis has them —
   * animal_ecdysis.accepted_name is then the synonym, or nothing — and are
   * counted so that a rise is seen.
   */
  synonymsWithoutAcceptedName: number;
  /** The day the fetch was made (ecdysis_taxon.fetched_on). */
  fetchedOn: string;
  /** How the animal nodes stand after matching, by animal_ecdysis.standing. */
  standing: Record<string, number>;
}

const MATCH_SQL = new URL("../ingest/match-ecdysis.sql", import.meta.url).pathname;
const ADOPTABLE_SQL = new URL("../ingest/ecdysis-adoptable.sql", import.meta.url).pathname;

/** Rebuild ecdysis_adoptable from ecdysis_taxon (schema/025): after every load, and after db:reseed carries the thesaurus. */
export async function rebuildEcdysisAdoptable(conn: DuckDBConnection): Promise<void> {
  await conn.run(await readFile(ADOPTABLE_SQL, "utf8"));
}

/** Restate animal.ecdysis_tid from animal_ecdysis_match. Legacy promotion and every writer of the tree run it too. */
export async function matchAnimalsToEcdysis(conn: DuckDBConnection): Promise<void> {
  await conn.run(await readFile(MATCH_SQL, "utf8"));
}

const literal = (path: string) => `'${path.replaceAll("'", "''")}'`;

/** Symbiota's rank ids for a genus and a subgenus, which are animal_rank's ordinals for them. */
const GENUS = 180;
const SUBGENUS = 190;

/** Ecdysis's few genera spelled like a subgenus: `Lasioglossum (Eickwortia)` at genus rank. */
const SUBGENUS_SHAPED_GENUS = (row: string) => `(${row}.rank_id = ${GENUS} AND ${row}.name LIKE '%(%')`;

/** The day a fetch in `dir` was made, from its manifest. */
async function fetchedOn(dir: string): Promise<string> {
  const manifest = JSON.parse(await readFile(join(dir, MANIFEST_FILE), "utf8")) as { fetchedAt?: unknown };
  const day = typeof manifest.fetchedAt === "string" ? manifest.fetchedAt.slice(0, 10) : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`${join(dir, MANIFEST_FILE)} does not say when the fetch was made`);
  return day;
}

export async function loadEcdysisTaxonomy(
  conn: DuckDBConnection,
  dir: string = LIVE_ECDYSIS_TAXONOMY_DIR,
  options: {
    /**
     * Refuse a fetch keeping fewer than this share of the names the store
     * holds, counted the same way on both sides (at the ranks the store
     * admits). The weekly refresh passes REFRESH_SHRINK_LIMIT; the CLI none.
     */
    refuseBelowShare?: number;
  } = {},
): Promise<LoadEcdysisTaxonomyResult> {
  const path = join(dir, TAXA_FILE);
  for (const p of [path, join(dir, MANIFEST_FILE)]) {
    if (!existsSync(p)) throw new Error(`${p} is missing — run pnpm ecdysis:taxonomy to fetch the thesaurus`);
  }
  const day = await fetchedOn(dir);
  const scalar = async (sql: string): Promise<unknown> => {
    const [[value]] = (await (await conn.run(sql)).getRows()) as [[unknown]];
    return value;
  };
  const types: Record<(typeof TAXA_COLUMNS)[number], string> = {
    tid: "BIGINT",
    name: "VARCHAR",
    author: "VARCHAR",
    rank_id: "INTEGER",
    parent_tid: "BIGINT",
    status: "VARCHAR",
    accepted_tid: "BIGINT",
  };
  const columns = TAXA_COLUMNS.map((c) => `'${c}': '${types[c]}'`).join(", ");

  await conn.run("BEGIN TRANSACTION");
  try {
    await conn.run(
      `CREATE OR REPLACE TEMP TABLE ecd_fetched AS
       SELECT * FROM read_csv(${literal(path)}, header = true, delim = ',', quote = '"', escape = '"', columns = {${columns}})`,
    );
    // The nearest admitted ancestor of each accepted name at an admitted
    // rank: up parent_tid through whatever the store does not admit and
    // through a subgenus, which is a leaf in the tree; from a synonym to its
    // accepted name; and no further than the first accepted name at an
    // admitted rank past those. A genus spelled like a subgenus ends the
    // walk with nothing. Animalia is its own parent in Symbiota, which is
    // where the walk stops.
    await conn.run(`
      CREATE OR REPLACE TEMP TABLE ecd_admitted_parent AS
      WITH RECURSIVE up AS (
        SELECT f.tid AS start, f.parent_tid AS cur, 1 AS depth
        FROM ecd_fetched f JOIN animal_rank r ON r.ordinal = f.rank_id
        WHERE f.status = 'accepted' AND f.parent_tid <> f.tid
        UNION ALL
        SELECT up.start, CASE WHEN p.status = 'synonym' THEN p.accepted_tid ELSE p.parent_tid END, up.depth + 1
        FROM up JOIN ecd_fetched p ON p.tid = up.cur
        WHERE (p.rank_id NOT IN (SELECT ordinal FROM animal_rank) OR p.rank_id = ${SUBGENUS} OR p.status = 'synonym')
          AND NOT ${SUBGENUS_SHAPED_GENUS("p")}
          AND p.parent_tid <> p.tid AND up.depth < 30
      )
      SELECT up.start AS tid, up.cur AS admitted_parent_tid
      FROM up JOIN ecd_fetched p ON p.tid = up.cur JOIN animal_rank r ON r.ordinal = p.rank_id
      WHERE r.rank <> 'subgenus' AND p.status = 'accepted' AND NOT ${SUBGENUS_SHAPED_GENUS("p")}
      QUALIFY row_number() OVER (PARTITION BY up.start ORDER BY up.depth) = 1`);
    if (options.refuseBelowShare !== undefined) {
      const kept = Number(await scalar("SELECT count(*) FROM ecd_fetched f JOIN animal_rank r ON r.ordinal = f.rank_id"));
      const held = Number(await scalar("SELECT count(*) FROM ecdysis_taxon"));
      if (kept < held * options.refuseBelowShare) {
        throw new Error(
          `the fetch keeps ${kept} names against the ${held} the store holds, fewer than ${Math.round(options.refuseBelowShare * 100)}%: ` +
            `not loaded, since a truncated export would take Ecdysis ids away from names in the tree`,
        );
      }
    }
    await conn.run("DELETE FROM ecdysis_taxon");
    await conn.run(
      `INSERT INTO ecdysis_taxon (tid, rank, name, author, status, accepted_tid, parent_tid, admitted_parent_tid, fetched_on)
       SELECT f.tid, r.rank, f.name, nullif(f.author, ''), f.status, f.accepted_tid, f.parent_tid, ap.admitted_parent_tid, DATE ${literal(day)}
       FROM ecd_fetched f
       JOIN animal_rank r ON r.ordinal = f.rank_id
       LEFT JOIN ecd_admitted_parent ap ON ap.tid = f.tid`,
    );
    if (Number(await scalar("SELECT count(*) FROM ecdysis_taxon")) === 0) {
      throw new Error(`${path} holds no name at a rank the store admits — refusing to replace the loaded thesaurus with nothing`);
    }
    await rebuildEcdysisAdoptable(conn);
    await matchAnimalsToEcdysis(conn);
    await conn.run("COMMIT");
  } catch (err) {
    await conn.run("ROLLBACK");
    throw err;
  }

  const standing: Record<string, number> = {};
  const byStanding = (await (
    await conn.run("SELECT standing, count(*) FROM animal_ecdysis GROUP BY standing ORDER BY standing")
  ).getRows()) as [string, bigint][];
  for (const [name, n] of byStanding) standing[name] = Number(n);
  const result = {
    taxa: Number(await scalar("SELECT count(*) FROM ecdysis_taxon")),
    synonyms: Number(await scalar("SELECT count(*) FROM ecdysis_taxon WHERE status = 'synonym'")),
    notAdmitted: Number(await scalar("SELECT count(*) FROM ecd_fetched WHERE rank_id NOT IN (SELECT ordinal FROM animal_rank)")),
    synonymsWithoutAcceptedName: Number(
      await scalar(`SELECT count(*) FROM ecdysis_taxon s LEFT JOIN ecdysis_taxon a ON a.tid = s.accepted_tid
                    WHERE s.status = 'synonym' AND (a.tid IS NULL OR a.status <> 'accepted')`),
    ),
    fetchedOn: day,
    standing,
  };
  await conn.run("DROP TABLE IF EXISTS ecd_fetched");
  await conn.run("DROP TABLE IF EXISTS ecd_admitted_parent");
  return result;
}

/** What the weekly refresh did (refreshEcdysisTaxonomy). */
export interface RefreshEcdysisTaxonomyResult {
  load: LoadEcdysisTaxonomyResult;
  /** The day of the fetch it replaced, or null when the store held none. */
  previousFetchedOn: string | null;
  /** Nodes of the tree whose standing in Ecdysis changed, with what it was and is: "accepted", "synonym of X", "absent". */
  moved: { rank: string; name: string; was: string; now: string }[];
  /** Curation decisions the new fetch has moved from under (animal_curation_stale). */
  curationStale: number;
  /** Volunteers' drafts naming an Ecdysis taxon the store no longer offers for adoption (beeline-n06p), by season. */
  draftsNoLongerOffered: { active: number; settled: number };
}

/** A refresh refuses a fetch with fewer names than this share of what the store holds: Ecdysis does not lose a twentieth of its insects in a week. */
export const REFRESH_SHRINK_LIMIT = 0.95;

/**
 * Fetch Ecdysis's thesaurus afresh and load it (beeline-xni1): the weekly job
 * on production, so names added to Ecdysis reach the determination picker
 * and the importer without anyone running pnpm ecdysis:taxonomy.
 *
 * The fetch (about five minutes of exports from ecdysis.org) happens before
 * the store is touched and writes its file only once it is whole, so a
 * failed fetch changes nothing. A fetch with markedly fewer names than the
 * store holds is refused rather than loaded: loading it would take Ecdysis
 * ids away from names in the tree and stop offering names to the picker,
 * and a truncated export looks exactly like that. Then the load replaces
 * the table in one transaction, as the CLI's does.
 *
 * What it reports is what someone might need to act on: the tree's names
 * whose standing in Ecdysis changed, the curation decisions the new fetch
 * has moved from under, and volunteers' drafts whose name Ecdysis no longer
 * offers, which wait at the overnight commit.
 */
export async function refreshEcdysisTaxonomy(
  conn: DuckDBConnection,
  options: {
    dir: string;
    signal?: AbortSignal;
    fetchTaxonomy?: typeof fetchEcdysisTaxonomy;
    /** The job's step(), which times each part; run directly otherwise. */
    step?: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
  },
): Promise<RefreshEcdysisTaxonomyResult> {
  const step = options.step ?? (<T>(_: string, fn: () => Promise<T>) => fn());
  const rowsOf = async (sql: string) => (await conn.run(sql)).getRows();
  await step("fetch from Ecdysis", () =>
    (options.fetchTaxonomy ?? fetchEcdysisTaxonomy)({ dir: options.dir, signal: options.signal }),
  );
  const [[previous]] = (await rowsOf("SELECT CAST(max(fetched_on) AS TEXT) FROM ecdysis_taxon")) as [[string | null]];
  const standing = `SELECT entity_id, rank, scientific_name,
                           CASE WHEN standing = 'synonym' THEN concat('synonym of ', accepted_name) ELSE standing END
                    FROM animal_ecdysis`;
  const before = new Map((await rowsOf(standing)).map((r) => [Number(r[0]), String(r[3])]));
  // The shrink check is the load's, inside its transaction, counting the
  // names it keeps against those the store holds: the fetch's own count
  // includes ranks the store drops, so a loss there could pass unseen.
  const load = await step("load into the store", () =>
    loadEcdysisTaxonomy(conn, options.dir, { refuseBelowShare: REFRESH_SHRINK_LIMIT }),
  );
  const moved = (await rowsOf(standing))
    .map((r) => ({ id: Number(r[0]), rank: String(r[1]), name: String(r[2]), now: String(r[3]) }))
    .filter((n) => before.has(n.id) && before.get(n.id) !== n.now)
    .map((n) => ({ rank: n.rank, name: n.name, was: before.get(n.id)!, now: n.now }))
    .sort((a, b) => a.name.localeCompare(b.name));
  // "not loaded" to anything is the first load, not a move.
  const realMoves = moved.filter((m) => m.was !== "not loaded");
  const [[curationStale]] = (await rowsOf("SELECT count(*) FROM animal_curation_stale")) as [[bigint]];
  // Split by season, as every check count is (AGENTS.md): settled_sample
  // (schema/102) is the store's own line between them.
  const [[active, settled]] = (await rowsOf(
    `SELECT count(*) FILTER (WHERE s.sample_id IS NULL), count(*) FILTER (WHERE s.sample_id IS NOT NULL)
     FROM determination_draft d
     JOIN specimen sp ON sp.entity_id = d.specimen_id
     LEFT JOIN settled_sample s ON s.sample_id = sp.sample_id
     WHERE d.ecdysis_tid IS NOT NULL AND d.animal_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM ecdysis_adoptable e WHERE e.tid = d.ecdysis_tid)
       AND NOT EXISTS (SELECT 1 FROM animal a WHERE a.ecdysis_tid = d.ecdysis_tid)`,
  )) as [[bigint, bigint]];
  return {
    load,
    previousFetchedOn: previous,
    moved: realMoves,
    curationStale: Number(curationStale),
    draftsNoLongerOffered: { active: Number(active), settled: Number(settled) },
  };
}

/** The refresh in a line for the jobs page: counts first, then the names that moved, the first ten of them. */
export function describeRefresh(r: RefreshEcdysisTaxonomyResult): string {
  const parts = [
    `${r.load.taxa} names from the fetch of ${r.load.fetchedOn}` + (r.previousFetchedOn !== null ? ` (replacing ${r.previousFetchedOn})` : ""),
    `the tree's names: ${Object.entries(r.load.standing)
      .map(([standing, n]) => `${n} ${standing}`)
      .join(", ")}`,
  ];
  if (r.moved.length > 0) {
    const shown = r.moved.slice(0, 10).map((m) => `${m.name} (was ${m.was}, now ${m.now})`);
    parts.push(`${r.moved.length} moved in Ecdysis: ${shown.join("; ")}${r.moved.length > 10 ? "; …" : ""}`);
  } else {
    parts.push("none of the tree's names moved in Ecdysis");
  }
  if (r.curationStale > 0) parts.push(`${r.curationStale} curation decision(s) Ecdysis has moved from under (/taxonomy?decided=moved)`);
  const { active, settled } = r.draftsNoLongerOffered;
  if (active + settled > 0) {
    parts.push(`volunteer drafts naming a taxon Ecdysis no longer offers: ${active} in the active seasons, ${settled} in settled ones`);
  }
  return parts.join("; ");
}

// CLI: pnpm ecdysis:taxonomy [db] [--fetch-only | --cached]
//   Fetch the insects of Ecdysis's thesaurus into data/ecdysis-taxonomy/ and
//   load them. --fetch-only stops before the store, which is what lets the
//   three minutes of fetching happen while the app holds it; --cached loads
//   the last fetch without asking Ecdysis again.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const cached = args.includes("--cached");
  const fetchOnly = args.includes("--fetch-only");
  const unknown = args.filter((a) => a.startsWith("--") && a !== "--cached" && a !== "--fetch-only");
  if (unknown.length > 0 || (cached && fetchOnly)) {
    console.error("usage: pnpm ecdysis:taxonomy [db] [--fetch-only | --cached]");
    process.exit(2);
  }
  const dbPath = args.find((a) => !a.startsWith("--")) ?? process.env.BEELINE_DB ?? DEFAULT_DB;
  if (!cached) {
    const fetched = await fetchEcdysisTaxonomy({ progress: (m) => console.error(m) });
    console.error(`fetched ${fetched.taxa} names in ${fetched.exports.length} exports to ${fetched.path}`);
    if (fetchOnly) process.exit(0);
  }
  // Opened only once the fetch is done: it takes minutes, and the store is
  // the app's while it is not ours (ADR 0005).
  const instance = await openDuckDb(dbPath);
  const conn = await instance.connect();
  try {
    const result = await loadEcdysisTaxonomy(conn);
    await conn.run("CHECKPOINT");
    console.log(JSON.stringify(result, null, 2));
  } finally {
    conn.closeSync();
  }
}
