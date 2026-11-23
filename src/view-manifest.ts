import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createMemoryDb } from "./schema.js";

/**
 * Views that no migration states (they were in the schema at cutover and have
 * not changed since) cannot be checked by replaying the migration that last
 * wrote them. migrations/view-hashes.txt holds, for each, a hash of the text
 * and comment a fresh build gives, and test/view-migrations.test.ts fails
 * when a hash stops matching: the view changed in schema/ and needs a
 * migration. The file only shrinks. This script is for the one case that
 * changes every hash with no change in meaning: a DuckDB upgrade that
 * serialises views differently. It rewrites the hashes of the views already
 * in the file and never adds a line, so it cannot be used to skip a migration.
 */

export const VIEW_MANIFEST = fileURLToPath(new URL("../migrations/view-hashes.txt", import.meta.url));

export const viewHash = (sql: string, comment: string | null): string =>
  createHash("sha256").update(JSON.stringify([sql, comment])).digest("hex");

// CLI: pnpm views:rehash
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { conn } = await createMemoryDb();
  const rows = await (
    await conn.run("SELECT view_name, sql, comment FROM duckdb_views() WHERE NOT internal AND schema_name = 'main'")
  ).getRows();
  const fresh = new Map(rows.map(([n, sql, c]) => [String(n), viewHash(String(sql), c === null ? null : String(c))]));
  const lines = (await readFile(VIEW_MANIFEST, "utf8")).split("\n");
  let changed = 0;
  const out = lines.map((line) => {
    if (line.trim() === "" || line.startsWith("#")) return line;
    const [name, old] = line.split(/\s+/) as [string, string];
    const now = fresh.get(name);
    if (now === undefined) throw new Error(`${name} is in the manifest but not in the schema: delete its line`);
    if (now !== old) changed++;
    return `${name} ${now}`;
  });
  await writeFile(VIEW_MANIFEST, out.join("\n"));
  console.log(`${changed} hash(es) rewritten; no view was added`);
}
