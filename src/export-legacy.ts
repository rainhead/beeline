import { pathToFileURL } from "node:url";
import { openDuckDb } from "./db.js";
import { writeLegacyExport } from "./legacy-export.js";

// CLI: pnpm legacy:export [db] [out.csv]
// The legacy-format occurrences file (beeline-6q8), written from a store the
// app is not holding. The app writes the same file nightly; this is for a
// scratch store, or for writing one by hand in maintenance mode.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const dbPath = process.argv[2] ?? process.env.BEELINE_DB ?? "beeline.duckdb";
  const out = process.argv[3] ?? "data/exports/occurrences.csv";
  const instance = await openDuckDb(dbPath);
  const conn = await instance.connect();
  const { rows, staged } = await writeLegacyExport(conn, out);
  conn.closeSync();
  console.log(`wrote ${rows} rows to ${out}${staged ? "" : " (no legacy staging in this store: legacy-only columns are blank)"}`);
}
