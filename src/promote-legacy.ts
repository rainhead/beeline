import { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const INGEST_DIR = new URL("../ingest/", import.meta.url).pathname;

export interface PromotionCounts {
  staged: number;
  people: number;
  samples: number;
  specimens: number;
  locations: number;
  animals: number;
  determinations: number;
  blockedRows: number;
  unresolvedDeterminations: number;
  unresolvedDeterminerNames: number;
  correctionsApplied: number;
  correctionsRetired: number;
  correctionConflicts: number;
}

/** Promote staged legacy_occurrence rows into the model. Fresh model only. */
export async function promoteLegacy(
  conn: DuckDBConnection,
  taxonomyCsvPath = "data/legacy/taxonomy.csv",
  determinerAliasesPath = "ingest/determiner-aliases.csv",
  determinerRegisterPath = "ingest/determiner-register.csv",
  legacyCorrectionsPath = "ingest/legacy-corrections.csv",
): Promise<PromotionCounts> {
  const scalar = async (sql: string): Promise<number> => {
    const [[v]] = (await (await conn.run(sql)).getRows()) as [[bigint]];
    return Number(v);
  };
  if ((await scalar("SELECT count(*) FROM person")) > 0) {
    throw new Error("model already contains people — promotion runs only against a freshly built database");
  }
  const promoteSql = await readFile(`${INGEST_DIR}promote-legacy.sql`, "utf8");
  await conn.run(
    promoteSql.replaceAll("{{LEGACY_CORRECTIONS}}", legacyCorrectionsPath.replaceAll("'", "''")),
  );
  const seedSql = await readFile(`${INGEST_DIR}seed-animals.sql`, "utf8");
  await conn.run(seedSql.replaceAll("{{TAXONOMY_CSV}}", taxonomyCsvPath.replaceAll("'", "''")));
  const detSql = await readFile(`${INGEST_DIR}promote-determinations.sql`, "utf8");
  await conn.run(
    detSql
      .replaceAll("{{DETERMINER_ALIASES}}", determinerAliasesPath.replaceAll("'", "''"))
      .replaceAll("{{DETERMINER_REGISTER}}", determinerRegisterPath.replaceAll("'", "''")),
  );
  return {
    staged: await scalar("SELECT count(*) FROM legacy_occurrence"),
    people: await scalar("SELECT count(*) FROM person"),
    samples: await scalar("SELECT count(*) FROM sample"),
    specimens: await scalar("SELECT count(*) FROM specimen"),
    locations: await scalar("SELECT count(*) FROM sample_location"),
    animals: await scalar("SELECT count(*) FROM animal"),
    determinations: await scalar("SELECT count(*) FROM determination"),
    blockedRows: await scalar(
      "SELECT count(DISTINCT _id) FROM legacy_promotion_finding WHERE severity = 'blocking'",
    ),
    unresolvedDeterminations: await scalar("SELECT count(*) FROM legacy_unresolved_determination"),
    unresolvedDeterminerNames: await scalar("SELECT count(*) FROM legacy_determiner_unresolved"),
    correctionsApplied: await scalar(
      "SELECT count(*) FROM legacy_correction_state WHERE status IN ('applies', 'conflict')",
    ),
    correctionsRetired: await scalar(
      "SELECT count(*) FROM legacy_correction_state WHERE status = 'retired'",
    ),
    correctionConflicts: await scalar(
      "SELECT count(*) FROM legacy_correction_state WHERE status = 'conflict'",
    ),
  };
}

// CLI: pnpm legacy:promote [db]
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const dbPath = process.argv[2] ?? "beeline.duckdb";
  const instance = await DuckDBInstance.create(dbPath);
  const conn = await instance.connect();
  const counts = await promoteLegacy(conn);
  conn.closeSync();
  console.log(JSON.stringify(counts, null, 2));
  if (counts.specimens + counts.blockedRows !== counts.staged) {
    console.error("specimens + blocked rows ≠ staged rows — investigate before trusting this run");
    process.exit(1);
  }
}
