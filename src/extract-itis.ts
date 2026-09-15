import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openMemoryDuckDb } from "./db.js";

/**
 * Extract from an ITIS SQLite download the part of ITIS the curated taxonomy
 * is checked against (beeline-45v.4): the insects, at the ranks animal_rank
 * admits, and the synonym links between them. schema/025_itis.sql says why
 * all insects; src/load-itis.ts puts the result into a store.
 *
 * Runs with no store at all, which is the point — ITIS is a 224 MB download
 * and 925 MB unpacked, so it is extracted where the bandwidth is and only the
 * two CSVs travel. Needs DuckDB's sqlite extension, which INSTALL fetches.
 *
 * Membership comes from ITIS's own hierarchy, which holds current names only:
 * a current name is an insect when Insecta is in its hierarchy string, and an
 * outdated name is one when a current insect name is among the names it now
 * goes by. The chain above Insecta — Animalia, Arthropoda — comes from
 * Insecta's own hierarchy string, so the tree matches all the way up.
 */

/** ITIS rank ids at the ranks animal_rank admits. ITIS's ids are animal_rank's ordinals; a test pins that. */
export const ITIS_RANKS = [
  [10, "kingdom"],
  [30, "phylum"],
  [60, "class"],
  [100, "order"],
  [110, "suborder"],
  [130, "superfamily"],
  [140, "family"],
  [180, "genus"],
  [190, "subgenus"],
  [220, "species"],
  [230, "subspecies"],
] as const;

export interface ExtractItisResult {
  taxa: number;
  synonyms: number;
  itisAsOf: string;
  taxonCsv: string;
  synonymCsv: string;
}

const literal = (s: string) => `'${s.replaceAll("'", "''")}'`;

export async function extractItis(sqlitePath: string, outDir: string): Promise<ExtractItisResult> {
  await mkdir(outDir, { recursive: true });
  const instance = await openMemoryDuckDb();
  const conn = await instance.connect();
  const scalar = async (sql: string): Promise<unknown> => {
    const [[value]] = (await (await conn.run(sql)).getRows()) as [[unknown]];
    return value;
  };
  try {
    // Spill beside the extract rather than into the working directory;
    // scripts/fetch-itis.sh removes it afterwards.
    await conn.run(`SET temp_directory = ${literal(join(outDir, ".extract-tmp"))}`);
    await conn.run("INSTALL sqlite");
    await conn.run("LOAD sqlite");
    await conn.run(`ATTACH ${literal(sqlitePath)} AS itis (TYPE sqlite, READ_ONLY)`);
    await conn.run("CREATE TEMP TABLE rank_map (rank_id INTEGER, rank VARCHAR)");
    await conn.run(`INSERT INTO rank_map VALUES ${ITIS_RANKS.map(([id, rank]) => `(${id}, '${rank}')`).join(", ")}`);

    const insecta = Number(
      await scalar(`SELECT count(*) FROM itis.taxonomic_units
                    WHERE kingdom_id = 5 AND rank_id = 60 AND complete_name = 'Insecta' AND name_usage = 'valid'`),
    );
    if (insecta !== 1) throw new Error(`expected one current Insecta in ${sqlitePath}, found ${insecta}`);

    await conn.run(`CREATE TEMP TABLE current_insect AS
      WITH insecta AS (
        SELECT tsn FROM itis.taxonomic_units
        WHERE kingdom_id = 5 AND rank_id = 60 AND complete_name = 'Insecta' AND name_usage = 'valid'
      )
      SELECT h.TSN AS tsn FROM itis.hierarchy h, insecta i
      WHERE concat('-', h.hierarchy_string, '-') LIKE concat('%-', i.tsn, '-%')
      UNION
      SELECT CAST(unnest(string_split(h.hierarchy_string, '-')) AS BIGINT)
      FROM itis.hierarchy h, insecta i WHERE h.TSN = i.tsn`);
    await conn.run(`CREATE TEMP TABLE synonym AS
      SELECT DISTINCT sl.tsn, sl.tsn_accepted AS accepted_tsn
      FROM itis.synonym_links sl JOIN current_insect c ON c.tsn = sl.tsn_accepted`);
    await conn.run(`CREATE TEMP TABLE taxon AS
      SELECT tu.tsn, r.rank, trim(tu.complete_name) AS name, tu.name_usage AS usage,
             a.taxon_author AS author, nullif(tu.parent_tsn, 0) AS parent_tsn,
             (SELECT max(CAST(update_date AS DATE)) FROM itis.taxonomic_units) AS itis_as_of
      FROM itis.taxonomic_units tu
      JOIN rank_map r ON r.rank_id = tu.rank_id
      LEFT JOIN itis.taxon_authors_lkp a ON a.taxon_author_id = tu.taxon_author_id
      WHERE tu.kingdom_id = 5 AND tu.name_usage IN ('valid', 'invalid')
        AND (tu.tsn IN (SELECT tsn FROM current_insect) OR tu.tsn IN (SELECT tsn FROM synonym))`);

    const taxonCsv = join(outDir, "itis-taxon.csv");
    const synonymCsv = join(outDir, "itis-synonym.csv");
    // Written beside the destination and renamed, so a failed extract never
    // leaves a half-written file where itis:load would read it.
    await conn.run(`COPY (SELECT tsn, rank, name, usage, author, parent_tsn, itis_as_of FROM taxon ORDER BY tsn)
                    TO ${literal(`${taxonCsv}.tmp`)} (FORMAT CSV, HEADER)`);
    await conn.run(`COPY (SELECT s.tsn, s.accepted_tsn FROM synonym s
                          WHERE s.tsn IN (SELECT tsn FROM taxon) AND s.accepted_tsn IN (SELECT tsn FROM taxon)
                          ORDER BY 1, 2)
                    TO ${literal(`${synonymCsv}.tmp`)} (FORMAT CSV, HEADER)`);
    const result: ExtractItisResult = {
      taxa: Number(await scalar("SELECT count(*) FROM taxon")),
      synonyms: Number(
        await scalar(`SELECT count(*) FROM synonym s
                      WHERE s.tsn IN (SELECT tsn FROM taxon) AND s.accepted_tsn IN (SELECT tsn FROM taxon)`),
      ),
      itisAsOf: String(await scalar("SELECT CAST(max(itis_as_of) AS VARCHAR) FROM taxon")),
      taxonCsv,
      synonymCsv,
    };
    await rename(`${taxonCsv}.tmp`, taxonCsv);
    await rename(`${synonymCsv}.tmp`, synonymCsv);
    return result;
  } finally {
    conn.closeSync();
  }
}

// CLI: tsx src/extract-itis.ts <ITIS.sqlite> [outDir]   (run by scripts/fetch-itis.sh)
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [sqlitePath, outDir = "data/itis"] = process.argv.slice(2);
  if (!sqlitePath) {
    console.error("usage: tsx src/extract-itis.ts <ITIS.sqlite> [outDir]");
    process.exit(2);
  }
  console.log(JSON.stringify(await extractItis(sqlitePath, outDir), null, 2));
}
