import { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const PROMOTE_SQL = new URL("../ingest/promote-legacy.sql", import.meta.url).pathname;

export interface PromotionCounts {
  staged: number;
  people: number;
  samples: number;
  specimens: number;
  locations: number;
  blockedRows: number;
}

/** Promote staged legacy_occurrence rows into the model. Fresh model only. */
export async function promoteLegacy(conn: DuckDBConnection): Promise<PromotionCounts> {
  const scalar = async (sql: string): Promise<number> => {
    const [[v]] = (await (await conn.run(sql)).getRows()) as [[bigint]];
    return Number(v);
  };
  if ((await scalar("SELECT count(*) FROM person")) > 0) {
    throw new Error("model already contains people — promotion runs only against a freshly built database");
  }
  await conn.run(await readFile(PROMOTE_SQL, "utf8"));
  return {
    staged: await scalar("SELECT count(*) FROM legacy_occurrence"),
    people: await scalar("SELECT count(*) FROM person"),
    samples: await scalar("SELECT count(*) FROM sample"),
    specimens: await scalar("SELECT count(*) FROM specimen"),
    locations: await scalar("SELECT count(*) FROM sample_location"),
    blockedRows: await scalar(
      "SELECT count(DISTINCT _id) FROM legacy_promotion_finding WHERE severity = 'blocking'",
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
