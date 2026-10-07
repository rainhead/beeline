import { DuckDBConnection } from "@duckdb/node-api";
import { existsSync } from "node:fs";
import { open, readFile } from "node:fs/promises";
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
 * extracted on a workstation and only these files travel to a store — the
 * Fly machine included (docs/runbooks/deploy-fly.md, ITIS).
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

/** A CSV's header line, without reading the rest of a 27 MB file. */
async function firstLine(path: string): Promise<string> {
  const handle = await open(path);
  try {
    const { buffer, bytesRead } = await handle.read({ buffer: Buffer.alloc(4096), position: 0 });
    return buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0] ?? "";
  } finally {
    await handle.close();
  }
}

export async function loadItis(conn: DuckDBConnection, files: ItisFiles = LIVE_ITIS_FILES): Promise<LoadItisResult> {
  for (const path of [files.taxonCsv, files.synonymCsv]) {
    if (!existsSync(path)) throw new Error(`${path} is missing — run pnpm itis:fetch to make the extract`);
  }
  const scalar = async (sql: string): Promise<unknown> => {
    const [[value]] = (await (await conn.run(sql)).getRows()) as [[unknown]];
    return value;
  };

  // An extract made before admitted_parent_tsn existed still loads, with the
  // column empty; adopting ITIS names needs a newer one (beeline-45v.1.1).
  const header = await firstLine(files.taxonCsv).then((line) => line.trim().split(","));
  const hasAdmittedParent = header.includes("admitted_parent_tsn");

  await conn.run("BEGIN TRANSACTION");
  try {
    await conn.run("DELETE FROM itis_synonym");
    await conn.run("DELETE FROM itis_taxon");
    await conn.run(
      `INSERT INTO itis_taxon (tsn, rank, name, usage, author, parent_tsn, itis_as_of, admitted_parent_tsn)
       SELECT tsn, rank, name, usage, nullif(author, ''), parent_tsn, itis_as_of,
              ${hasAdmittedParent ? "admitted_parent_tsn" : "CAST(NULL AS BIGINT)"}
       FROM read_csv(${literal(files.taxonCsv)}, header = true,
         columns = {'tsn': 'BIGINT', 'rank': 'VARCHAR', 'name': 'VARCHAR', 'usage': 'VARCHAR',
                    'author': 'VARCHAR', 'parent_tsn': 'BIGINT', 'itis_as_of': 'DATE'${hasAdmittedParent ? ", 'admitted_parent_tsn': 'BIGINT'" : ""}})`,
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
    // A link runs from an outdated name to a current one, and both ends are
    // names this extract holds. animal_itis.current_name reads straight
    // through these, so a malformed extract would load cleanly and print a
    // wrong current name. Every link in the 2026-08-26 release passes.
    const badLinks = Number(
      await scalar(`SELECT count(*) FROM itis_synonym s
                    LEFT JOIN itis_taxon outdated ON outdated.tsn = s.tsn
                    LEFT JOIN itis_taxon current ON current.tsn = s.accepted_tsn
                    WHERE outdated.tsn IS NULL OR current.tsn IS NULL
                       OR outdated.usage <> 'invalid' OR current.usage <> 'valid'`),
    );
    if (badLinks > 0) {
      throw new Error(`${files.synonymCsv} has ${badLinks} synonym link(s) that do not run from an outdated ITIS name to a current one — refusing to load it`);
    }
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
