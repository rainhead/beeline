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
