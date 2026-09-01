import { openDuckDb } from "./db.js";
import { rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { applySchema } from "./schema.js";

// The schema lives in ./schema.ts; re-exported here because callers (tests,
// scratch work) have always reached for build-db.
export { applySchema, createMemoryDb, SCHEMA_DIR } from "./schema.js";

// CLI: pnpm db:build [target.duckdb] — blows away and rebuilds (pre-cutover stance).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const target = process.argv[2] ?? "beeline.duckdb";
  await rm(target, { force: true });
  const instance = await openDuckDb(target);
  const conn = await instance.connect();
  await applySchema(conn);
  // A database built from the schema is current by construction (ADR 0006):
  // stamp every migration so none of them ever runs against it.
  const { baseline } = await import("./migrate.js");
  const stamped = await baseline(conn);
  conn.closeSync();
  console.log(`built ${target} (${stamped.length} migrations stamped)`);
}
