import type { DuckDBConnection } from "@duckdb/node-api";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseCsv } from "./corrections.js";
import { openDuckDb } from "./db.js";
import { DEFAULT_DB } from "./person-change.js";

/**
 * Load old Beeline's plant list from git into the store (schema/067,
 * beeline-rfkj.2). The file keeps only the list's names (Rank, Family,
 * Scientific_name, Synonym, Common_name); see docs/architecture/plant-taxa.md
 * for where it came from and why the other columns are not in it.
 *
 * WHERE IT RUNS. At every boot of the app (src/app/main.ts), and by hand with
 * `pnpm plant:load [db]`. On production the app holds the store alone
 * (ADR 0005), so a CLI cannot write it, and a deploy is the only thing that
 * changes the file: the image carries the new file and the boot that follows
 * is the first moment the store can read it. Nightly would also work and
 * would be a day late for no reason; promotion is for rebuilds and
 * production is never rebuilt (ADR 0006).
 *
 * IDEMPOTENT AND OFFLINE. The file's SHA-256 is kept with the list, and a
 * load that finds the same hash changes nothing. A different hash replaces
 * the list's entries wholesale in one transaction, so an entry removed from
 * the file leaves nothing behind. Nothing here touches the network; the
 * lookups that follow are src/fetch-plant-names.ts.
 */
export const OLD_BEELINE_LIST = "old-beeline";
export const OLD_BEELINE_PLANT_LIST_FILE = "ingest/old-beeline-plant-list.csv";

const COLUMNS = ["Rank", "Family", "Scientific_name", "Synonym", "Common_name"] as const;

export interface LoadPlantListResult {
  /** False when the file's hash was the one already loaded. */
  changed: boolean;
  entries: number;
  /** Rows with no scientific name, which cannot be keyed and are not loaded. */
  skippedWithoutName: number;
}

export interface PlantListRow {
  rank: string | null;
  family: string | null;
  scientific_name: string;
  synonym: string | null;
  common_name: string | null;
}

/** The rows of a list file. Strict: a malformed file stops the load rather than loading part of a list. */
export function parsePlantList(bytes: Buffer): { rows: PlantListRow[]; skippedWithoutName: number } {
  // A byte order mark would otherwise become part of the first header.
  const text = bytes.toString("utf8").replace(/^﻿/, "");
  const [header, ...records] = parseCsv(text).filter((r) => !(r.length === 1 && r[0] === ""));
  if (header === undefined || COLUMNS.some((c, i) => header[i] !== c) || header.length !== COLUMNS.length) {
    throw new Error(`plant list: expected the header ${COLUMNS.join(",")}, found ${header?.join(",") ?? "nothing"}`);
  }
  const rows: PlantListRow[] = [];
  const seen = new Set<string>();
  let skippedWithoutName = 0;
  records.forEach((r, i) => {
    if (r.length !== COLUMNS.length) throw new Error(`plant list: row ${i + 2} has ${r.length} fields, expected ${COLUMNS.length}`);
    const cell = (j: number) => (r[j]!.trim() === "" ? null : r[j]!.trim());
    const name = cell(2);
    if (name === null) {
      skippedWithoutName += 1;
      return;
    }
    if (seen.has(name)) throw new Error(`plant list: ${name} appears twice (row ${i + 2}); the name is the entry's key`);
    seen.add(name);
    rows.push({ rank: cell(0), family: cell(1), scientific_name: name, synonym: cell(3), common_name: cell(4) });
  });
  return { rows, skippedWithoutName };
}

export async function loadPlantList(
  conn: DuckDBConnection,
  opts: { path?: string; listKey?: string } = {},
): Promise<LoadPlantListResult> {
  const path = opts.path ?? OLD_BEELINE_PLANT_LIST_FILE;
  const listKey = opts.listKey ?? OLD_BEELINE_LIST;
  const bytes = await readFile(path);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const { rows, skippedWithoutName } = parsePlantList(bytes);

  const have = (await (
    await conn.run("SELECT content_hash FROM plant_list WHERE list_key = $1", [listKey])
  ).getRows()) as Array<[string]>;
  if (have[0]?.[0] === hash) return { changed: false, entries: rows.length, skippedWithoutName };

  await conn.run("BEGIN TRANSACTION");
  try {
    await conn.run("DELETE FROM plant_list_entry WHERE list_key = $1", [listKey]);
    for (let i = 0; i < rows.length; i += 400) {
      const part = rows.slice(i, i + 400);
      const values = part.map((_, r) => `($1, ${[1, 2, 3, 4, 5].map((c) => `$${r * 5 + c + 1}`).join(", ")})`);
      await conn.run(
        `INSERT INTO plant_list_entry (list_key, scientific_name, rank, family, synonym, common_name) VALUES ${values.join(", ")}`,
        [listKey, ...part.flatMap((p) => [p.scientific_name, p.rank, p.family, p.synonym, p.common_name])] as never[],
      );
    }
    await conn.run(
      `INSERT INTO plant_list (list_key, source_file, content_hash) VALUES ($1, $2, $3)
       ON CONFLICT (list_key) DO UPDATE SET source_file = excluded.source_file,
         content_hash = excluded.content_hash, loaded_at = now()`,
      [listKey, path, hash],
    );
    await conn.run("COMMIT");
  } catch (err) {
    await conn.run("ROLLBACK");
    throw err;
  }
  return { changed: true, entries: rows.length, skippedWithoutName };
}

// CLI: pnpm plant:load [db]
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const instance = await openDuckDb(process.argv[2] ?? DEFAULT_DB);
  const conn = await instance.connect();
  try {
    console.log(JSON.stringify(await loadPlantList(conn), null, 2));
  } finally {
    conn.closeSync();
  }
}
