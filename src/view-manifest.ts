import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createMemoryDb } from "./schema.js";

/**
 * Views that no migration states cannot be checked by replaying the
 * migration that last wrote them. migrations/view-hashes.txt holds, for each,
 * a hash of the text and comment a fresh build gives, and
 * test/view-migrations.test.ts fails when a hash stops matching: the view
 * changed in schema/ and needs a NEW migration that restates it. The file
 * only shrinks.
 *
 * DuckDB stores a view's text as the version that wrote it serialised it, so
 * an upgrade can change every hash with no change in any view. The file's
 * header records the DuckDB version the hashes were made with. The test fails
 * when the running version differs, and `pnpm views:rehash` runs only then:
 * with the same version it refuses, so it cannot stand in for a migration.
 * It rewrites the hashes of the views already listed and never adds one.
 */

export const VIEW_MANIFEST = fileURLToPath(new URL("../migrations/view-hashes.txt", import.meta.url));

export const viewHash = (sql: string, comment: string | null): string =>
  createHash("sha256").update(JSON.stringify([sql, comment])).digest("hex");

export interface Manifest {
  /** The DuckDB version the hashes were made with, from the header line `# duckdb <version>`; null if none. */
  version: string | null;
  hashes: Map<string, string>;
}

export function parseManifest(text: string): Manifest {
  let version: string | null = null;
  const hashes = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    if (line.startsWith("#")) {
      const m = /^#\s*duckdb\s+(\S+)/.exec(line);
      if (m) version = m[1]!;
      continue;
    }
    const [name, hash] = line.split(/\s+/) as [string, string];
    hashes.set(name, hash);
  }
  return { version, hashes };
}

/**
 * The manifest text with every listed view's hash made by `running`. Refuses
 * when `running` is the version the hashes were made with: then a differing
 * hash means the view changed, and a migration is what that needs.
 */
export function rehashManifest(text: string, fresh: ReadonlyMap<string, string>, running: string): string {
  const { version } = parseManifest(text);
  if (version === running) {
    throw new Error(
      `the hashes were made with DuckDB ${running}, which is the version running: a view that differs has changed, and needs a new migration that restates it. This script is only for after a DuckDB upgrade.`,
    );
  }
  const out = text.split("\n").map((line) => {
    if (line.trim() === "") return line;
    if (line.startsWith("#")) return /^#\s*duckdb\s/.test(line) ? `# duckdb ${running}` : line;
    const name = line.split(/\s+/)[0]!;
    const now = fresh.get(name);
    if (now === undefined) throw new Error(`${name} is in the manifest but not in the schema: delete its line`);
    return `${name} ${now}`;
  });
  if (version === null) out.unshift(`# duckdb ${running}`);
  return out.join("\n");
}

// CLI: pnpm views:rehash
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { conn } = await createMemoryDb();
  const rows = await (
    await conn.run("SELECT view_name, sql, comment FROM duckdb_views() WHERE NOT internal AND schema_name = 'main' AND database_name = current_database()")
  ).getRows();
  const fresh = new Map(rows.map(([n, sql, c]) => [String(n), viewHash(String(sql), c === null ? null : String(c))]));
  const [[running]] = (await (await conn.run("SELECT version()")).getRows()) as [[string]];
  try {
    await writeFile(VIEW_MANIFEST, rehashManifest(await readFile(VIEW_MANIFEST, "utf8"), fresh, running));
    console.log(`hashes rewritten for DuckDB ${running}; no view was added`);
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}
