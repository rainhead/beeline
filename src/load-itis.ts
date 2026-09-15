import { DuckDBConnection } from "@duckdb/node-api";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { openDuckDb } from "./db.js";
import { DEFAULT_DB } from "./person-change.js";

/**
 * Load an ITIS extract into the store and match every animal node against it
 * (beeline-45v.4).
 *
 * The extract is two CSVs `pnpm itis:fetch` writes (src/extract-itis.ts): the
 * insects from one ITIS release at the ranks animal_rank admits, and the
 * synonym links between them. The ITIS download is 925 MB unpacked, so it is
 * extracted on a host with the bandwidth for it and only these files travel
 * to a store — the Fly machine included (docs/runbooks/deploy-fly.md, ITIS).
 *
 * Wholesale and in one transaction: a release replaces the one before it, and
 * animal.itis_tsn is restated from the new rows before anything commits, so no
 * reader sees one release's TSNs read against another's. An empty extract is
 * refused, because loading it would quietly take every node's TSN away.
 */

export interface ItisFiles {
  taxonCsv: string;
  synonymCsv: string;
}

/** Where `pnpm itis:fetch` writes, relative to the working directory like every other data/ input. */
export const LIVE_ITIS_FILES: ItisFiles = {
  taxonCsv: "data/itis/itis-taxon.csv",
  synonymCsv: "data/itis/itis-synonym.csv",
};

export interface LoadItisResult {
  taxa: number;
  synonyms: number;
  /** The release, as the newest change it records (itis_taxon.itis_as_of). */
  itisAsOf: string | null;
  /** How the animal nodes stand after matching, by animal_itis.standing. */
  standing: Record<string, number>;
}

const MATCH_SQL = new URL("../ingest/match-itis.sql", import.meta.url).pathname;

/** Restate animal.itis_tsn from animal_itis_match. Legacy promotion runs it too. */
export async function matchAnimalsToItis(conn: DuckDBConnection): Promise<void> {
  await conn.run(await readFile(MATCH_SQL, "utf8"));
}

const literal = (path: string) => `'${path.replaceAll("'", "''")}'`;

export async function loadItis(conn: DuckDBConnection, files: ItisFiles = LIVE_ITIS_FILES): Promise<LoadItisResult> {
  for (const path of [files.taxonCsv, files.synonymCsv]) {
    if (!existsSync(path)) throw new Error(`${path} is missing — run pnpm itis:fetch to make the extract`);
  }
  const scalar = async (sql: string): Promise<unknown> => {
    const [[value]] = (await (await conn.run(sql)).getRows()) as [[unknown]];
    return value;
  };

  await conn.run("BEGIN TRANSACTION");
  try {
    await conn.run("DELETE FROM itis_synonym");
    await conn.run("DELETE FROM itis_taxon");
    await conn.run(
      `INSERT INTO itis_taxon (tsn, rank, name, usage, author, parent_tsn, itis_as_of)
       SELECT tsn, rank, name, usage, nullif(author, ''), parent_tsn, itis_as_of
       FROM read_csv(${literal(files.taxonCsv)}, header = true,
         columns = {'tsn': 'BIGINT', 'rank': 'VARCHAR', 'name': 'VARCHAR', 'usage': 'VARCHAR',
                    'author': 'VARCHAR', 'parent_tsn': 'BIGINT', 'itis_as_of': 'DATE'})`,
    );
    if (Number(await scalar("SELECT count(*) FROM itis_taxon")) === 0) {
      throw new Error(`${files.taxonCsv} is empty — refusing to replace the loaded ITIS with nothing`);
    }
    await conn.run(
      `INSERT INTO itis_synonym (tsn, accepted_tsn)
       SELECT tsn, accepted_tsn
       FROM read_csv(${literal(files.synonymCsv)}, header = true,
         columns = {'tsn': 'BIGINT', 'accepted_tsn': 'BIGINT'})`,
    );
    await matchAnimalsToItis(conn);
    await conn.run("COMMIT");
  } catch (err) {
    await conn.run("ROLLBACK");
    throw err;
  }

  const standing: Record<string, number> = {};
  const byStanding = (await (
    await conn.run("SELECT standing, count(*) FROM animal_itis GROUP BY standing ORDER BY standing")
  ).getRows()) as [string, bigint][];
  for (const [name, n] of byStanding) standing[name] = Number(n);
  const asOf = await scalar("SELECT CAST(max(itis_as_of) AS VARCHAR) FROM itis_taxon");
  return {
    taxa: Number(await scalar("SELECT count(*) FROM itis_taxon")),
    synonyms: Number(await scalar("SELECT count(*) FROM itis_synonym")),
    itisAsOf: asOf === null ? null : String(asOf),
    standing,
  };
}

// CLI: pnpm itis:load [db]
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const dbPath = process.argv[2] ?? process.env.BEELINE_DB ?? DEFAULT_DB;
  const instance = await openDuckDb(dbPath);
  const conn = await instance.connect();
  try {
    const result = await loadItis(conn);
    await conn.run("CHECKPOINT");
    console.log(JSON.stringify(result, null, 2));
  } finally {
    conn.closeSync();
  }
}
