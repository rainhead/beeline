import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * animal.parent_id is a node's parent at creation and never changes, because
 * DuckDB 2.0 refuses to UPDATE a row another table refers to (schema/020). A
 * node moves by a row in animal_filing, and the parent in effect is
 * animal_tree.filed_under_id. So a read of animal.parent_id anywhere is a bug
 * waiting for the first node that moves (beeline-stoi). Kysely reads fail
 * typecheck, since src/model.ts has no such column; this test catches the raw
 * SQL that typecheck cannot see.
 */

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** A line that may name parent_id, by file; `only` limits it to lines matching the pattern. */
const ALLOWED: { file: string; only?: RegExp; why: string }[] = [
  { file: "schema/020_animal.sql", why: "the column, its comment, and animal_filing's own parent_id" },
  { file: "schema/117_views_animal_tree.sql", why: "the view that reads it" },
  { file: "schema/066_inat_taxa.sql", why: "iNaturalist's taxa have a parent_id of their own, not animal's" },
  { file: "src/fetch-inat-taxa.ts", why: "iNaturalist's taxa again" },
  { file: "src/store-snapshot.ts", why: "copies the table level by level" },
  { file: "src/file-animals.ts", only: /^\s*\*|INSERT INTO animal \(parent_id|INSERT \(animal_id, parent_id,|SET parent_id|f\.parent_id/, why: "writes animal_filing, whose column it is" },
  { file: "src/adopt-ecdysis.ts", only: /INSERT INTO animal \(parent_id/, why: "an insert site" },
  { file: "src/taxon-curation.ts", only: /INSERT INTO animal \(rank, scientific_name, parent_id\)/, why: "an insert site" },
  { file: "ingest/seed-animals.sql", only: /INSERT INTO animal \(/, why: "insert sites" },
  { file: "src/model.ts", only: /^\s*(parent_id: .*|\/\/.*|\*.*|\/\*\*.*|.*parent_id.*inat.*)$/i, why: "iNaturalist's taxon table and animal_filing's column" },
];

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else if (/\.(ts|tsx|sql|mjs|js)$/.test(entry.name)) out.push(path);
  }
  return out;
}

describe("the tree is read through animal_tree", () => {
  test("nothing reads animal.parent_id outside the insert sites, the schema, the view and the snapshot", async () => {
    const offenders: string[] = [];
    for (const dir of ["src", "schema", "ingest", "bench"]) {
      for (const path of await walk(join(ROOT, dir))) {
        const file = relative(ROOT, path);
        const allowed = ALLOWED.find((a) => a.file === file);
        if (allowed !== undefined && allowed.only === undefined) continue;
        const lines = (await readFile(path, "utf8")).split("\n");
        lines.forEach((line, i) => {
          if (!/\bparent_id\b/.test(line)) return;
          if (allowed?.only?.test(line)) return;
          offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        });
      }
    }
    expect(offenders).toEqual([]);
  });
});
