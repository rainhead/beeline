import { openDuckDb } from "./db.js";
import { rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { applySchema } from "./schema.js";
import { PrintedStoreRefused, refuseToReplacePrintedStore } from "./registry-guard.js";

// The schema lives in ./schema.ts; re-exported here because callers (tests,
// scratch work) have always reached for build-db.
export { applySchema, createMemoryDb, SCHEMA_DIR } from "./schema.js";

/**
 * Blow away `target` and build it from the schema (pre-cutover stance).
 * Refuses, before deleting anything, a target that has printed
 * (beeline-83b8.13): `pnpm db:build data/beeline.duckdb` on production would
 * otherwise delete the live store's print runs and minted numbers. Returns
 * the migrations stamped.
 */
export async function buildStore(target: string): Promise<string[]> {
  await refuseToReplacePrintedStore(target, "db:build");
  await rm(target, { force: true });
  const instance = await openDuckDb(target);
  const conn = await instance.connect();
  try {
    await applySchema(conn);
    // A database built from the schema is current by construction (ADR 0006):
    // stamp every migration so none of them ever runs against it.
    const { baseline } = await import("./migrate.js");
    return await baseline(conn);
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
}

// CLI: pnpm db:build [target.duckdb]
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const target = process.argv[2] ?? "beeline.duckdb";
  const stamped = await buildStore(target).catch((err: unknown) => {
    if (!(err instanceof PrintedStoreRefused)) throw err;
    console.error(err.message);
    process.exit(1);
  });
  console.log(`built ${target} (${stamped.length} migrations stamped)`);
}
