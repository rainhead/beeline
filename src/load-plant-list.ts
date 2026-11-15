import type { DuckDBConnection } from "@duckdb/node-api";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseCsv } from "./corrections.js";
import { openDuckDb } from "./db.js";
import { DEFAULT_DB } from "./person-change.js";
import { refreshPlantCommonNames } from "./plant-common-names.js";

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
 * IDEMPOTENT AND OFFLINE. A SHA-256 of the loader's version and the file's
 * bytes is kept with the list, and a load that finds the same hash changes
 * nothing (so a change to the parsing reloads a list whose file did not change). A different hash replaces
 * the list's entries wholesale in one transaction, so an entry removed from
 * the file leaves nothing behind. Nothing here touches the network; the
 * lookups that follow are src/fetch-plant-names.ts.
 */
export const OLD_BEELINE_LIST = "old-beeline";
/**
 * Raise this with any change to how the file is read or what is stored from
 * it (parsePlantList, the columns kept). It is hashed with the file's bytes, so
 * a deployed list whose file did not change is read again by the new loader.
 */
export const PLANT_LIST_LOADER_VERSION = 2;
export const OLD_BEELINE_PLANT_LIST_FILE = "ingest/old-beeline-plant-list.csv";
export const PLANT_PROPER_NOUNS_FILE = "ingest/plant-proper-nouns.csv";
/** Where the files are, whatever directory the process was started in. */
const PLANT_PROPER_NOUNS_PATH = fileURLToPath(new URL(`../${PLANT_PROPER_NOUNS_FILE}`, import.meta.url));
const OLD_BEELINE_PLANT_LIST_PATH = fileURLToPath(new URL(`../${OLD_BEELINE_PLANT_LIST_FILE}`, import.meta.url));

const COLUMNS = ["Rank", "Family", "Scientific_name", "Synonym", "Common_name"] as const;

export interface LoadPlantListResult {
  /** False when the file's hash was the one already loaded. */
  changed: boolean;
  entries: number;
  /** Rows with no name to key them by (no Scientific_name, and no Family on a Family row), which are not loaded. */
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
  const text = bytes.toString("utf8").replace(/^\uFEFF/, "");
  let parsed: string[][];
  try {
    parsed = parseCsv(text, { strict: true });
  } catch (err) {
    throw new Error(`plant list: ${(err as Error).message}`);
  }
  // Numbered before the blank lines are dropped, so a row number is the line a person finds it on.
  const [head, ...records] = parsed.map((r, i) => ({ r, n: i + 1 })).filter(({ r }) => !(r.length === 1 && r[0] === ""));
  const header = head?.r;
  if (header === undefined || COLUMNS.some((c, i) => header[i] !== c) || header.length !== COLUMNS.length) {
    throw new Error(`plant list: expected the header ${COLUMNS.join(",")}, found ${header?.join(",") ?? "nothing"}`);
  }
  const rows: PlantListRow[] = [];
  const seen = new Set<string>();
  let skippedWithoutName = 0;
  records.forEach(({ r, n }) => {
    if (r.length !== COLUMNS.length) throw new Error(`plant list: row ${n} has ${r.length} fields, expected ${COLUMNS.length}`);
    const cell = (j: number) => (r[j]!.trim() === "" ? null : r[j]!.trim());
    // One row files a family under the Family column and leaves the name
    // empty (Family,Ericaceae,,,heath): the family is then its own name.
    const name = cell(2) ?? (cell(0) === "Family" ? cell(1) : null);
    if (name === null) {
      skippedWithoutName += 1;
      return;
    }
    if (seen.has(name)) throw new Error(`plant list: ${name} appears twice (row ${n}); the name is the entry's key`);
    seen.add(name);
    rows.push({ rank: cell(0), family: cell(1), scientific_name: name, synonym: cell(3), common_name: cell(4) });
  });
  return { rows, skippedWithoutName };
}

export interface ProperNounRow {
  word: string;
  treatment: "keep" | "lower";
  reason: string;
}

/** The rows of the proper-noun file. Strict, like the list: a bad row stops the load. */
export function parseProperNouns(bytes: Buffer): ProperNounRow[] {
  const text = bytes.toString("utf8").replace(/^\uFEFF/, "");
  const parsed = parseCsv(text, { strict: true }).filter((r) => !(r.length === 1 && r[0] === ""));
  const [header, ...records] = parsed;
  if (header?.join(",") !== "Word,Treatment,Reason") {
    throw new Error(`plant proper nouns: expected the header Word,Treatment,Reason, found ${header?.join(",") ?? "nothing"}`);
  }
  const seen = new Set<string>();
  return records.map((r, i) => {
    // Only ordinary spaces and tabs are trimmed: a non-breaking space at an edge is a fault to refuse, not to hide.
    const [word, treatment, reason] = r.map((c) => c.replace(/^[ \t]+|[ \t]+$/g, ""));
    if (r.length !== 3 || !word || !reason) throw new Error(`plant proper nouns: row ${i + 2} needs a word, a treatment and a reason`);
    if (treatment !== "keep" && treatment !== "lower") throw new Error(`plant proper nouns: row ${i + 2}: treatment must be keep or lower, not ${treatment}`);
    // Letters, with apostrophes inside or at the end ("Banks'"); a phrase has single ordinary spaces between its words, and a period may end a word
    // inside it ("Mount St. Helens"). No hyphen (the parts of a hyphenated word are judged one at a time), no digit, no other kind of space (a
    // non-breaking space would make a row that no name can match), so a row that could never match is refused.
    const WORD = String.raw`\p{L}+(?:['’]\p{L}*)*`;
    if (!new RegExp(`^${WORD}(?:\\.? ${WORD})*$`, "u").test(word))
      throw new Error(`plant proper nouns: row ${i + 2}: ${JSON.stringify(word)} is not a word or a phrase of words (letters and apostrophes, single ordinary spaces, no hyphen)`);
    if (word.includes(" ") && treatment !== "keep") throw new Error(`plant proper nouns: row ${i + 2}: only a keep row may hold a phrase`);
    // A lower row only matters for a possessive: any other word is lower-cased already.
    if (treatment === "lower" && !/(\p{L}['’]s|s['’])$/u.test(word))
      throw new Error(`plant proper nouns: row ${i + 2}: a lower row is for a possessive (Shepherd's, Ladies'), and ${word} is not one`);
    const folded = word.toLowerCase().replace(/’/g, "'");
    if (seen.has(folded)) throw new Error(`plant proper nouns: ${word} appears twice, ignoring case and the kind of apostrophe (row ${i + 2})`);
    seen.add(folded);
    return { word, treatment, reason };
  });
}

/** What the list's stored hash is: the loader's version, then the list's bytes, then the proper nouns' bytes. */
export function plantListHash(bytes: Buffer, properNounBytes: Buffer = Buffer.alloc(0)): string {
  return createHash("sha256")
    .update(`loader ${PLANT_LIST_LOADER_VERSION}\n`)
    .update(bytes)
    .update("\nproper nouns\n")
    .update(properNounBytes)
    .digest("hex");
}

/**
 * Load the list, and refresh the copy of the common names (schema/068)
 * whether or not the list changed. A list that did not change still gets
 * its names refreshed because a load that stored the list and then failed to
 * refresh leaves the copy behind, and a retry with the same file finds the
 * same hash: the retry is when the copy is put right. `refresh: false` is for
 * a caller that refreshes itself later (`db:reseed`).
 */
export async function loadPlantList(
  conn: DuckDBConnection,
  opts: { path?: string; properNounsPath?: string; listKey?: string; refresh?: boolean } = {},
): Promise<LoadPlantListResult> {
  const path = opts.path ?? OLD_BEELINE_PLANT_LIST_PATH;
  const listKey = opts.listKey ?? OLD_BEELINE_LIST;
  const bytes = await readFile(path);
  const properNounBytes = await readFile(opts.properNounsPath ?? PLANT_PROPER_NOUNS_PATH);
  const hash = plantListHash(bytes, properNounBytes);
  const { rows, skippedWithoutName } = parsePlantList(bytes);
  const properNouns = parseProperNouns(properNounBytes);

  const have = (await (
    await conn.run("SELECT content_hash FROM plant_list WHERE list_key = $1", [listKey])
  ).getRows()) as Array<[string]>;
  if (have[0]?.[0] === hash) {
    if (opts.refresh !== false) await refreshPlantCommonNames(conn);
    return { changed: false, entries: rows.length, skippedWithoutName };
  }

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
    // All the rows, not one list's: the file of proper nouns belongs to no list and there is one of it, so a load replaces it whole.
    await conn.run("DELETE FROM plant_proper_noun");
    for (const n of properNouns) {
      await conn.run("INSERT INTO plant_proper_noun (word, treatment, reason) VALUES ($1, $2, $3)", [n.word, n.treatment, n.reason]);
    }
    await conn.run(
      `INSERT INTO plant_list (list_key, source_file, content_hash) VALUES ($1, $2, $3)
       ON CONFLICT (list_key) DO UPDATE SET source_file = excluded.source_file,
         content_hash = excluded.content_hash, loaded_at = now()`,
      [listKey, opts.path ?? OLD_BEELINE_PLANT_LIST_FILE, hash],
    );
    await conn.run("COMMIT");
  } catch (err) {
    await conn.run("ROLLBACK");
    throw err;
  }
  // The list's own common names are what a host is called (schema/068).
  if (opts.refresh !== false) await refreshPlantCommonNames(conn);
  return { changed: true, entries: rows.length, skippedWithoutName };
}

/**
 * The boot's load (src/app/main.ts), here so a test can run it. A list that
 * cannot be read costs common names and not the service, so a failure is
 * reported and swallowed; the boot goes on. When the list changed, says how
 * many of its names iNaturalist has not been asked about yet, which is the
 * work the plant-names job has ahead of it.
 */
export async function loadPlantListAtBoot(
  connect: () => Promise<DuckDBConnection>,
  opts: { path?: string; log?: (message: string) => void; report?: (err: unknown) => void } = {},
): Promise<LoadPlantListResult | null> {
  const log = opts.log ?? console.log;
  const report = opts.report ?? (() => {});
  try {
    const conn = await connect();
    try {
      const loaded = await loadPlantList(conn, { path: opts.path });
      if (loaded.changed) {
        const [[unlooked]] = (await (await conn.run("SELECT count(*) FROM plant_name_unlooked")).getRows()) as [[bigint]];
        log(
          `plant list loaded: ${loaded.entries} entries (${loaded.skippedWithoutName} without a name skipped); ` +
            `${unlooked} name(s) not yet looked up in iNaturalist, which the plant-names job does a night at a time`,
        );
      }
      return loaded;
    } finally {
      conn.closeSync();
    }
  } catch (err) {
    console.error(`could not load the plant list: ${String(err)}`);
    report(err);
    return null;
  }
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
