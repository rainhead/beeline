import type { DuckDBConnection } from "@duckdb/node-api";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { parseCsv } from "./corrections.js";
import { openDuckDb } from "./db.js";
import { matchAnimalsToItis } from "./load-itis.js";
import { DEFAULT_DB } from "./person-change.js";

/**
 * The program's stated departures from ITIS (beeline-45v.1), as a curated
 * file replayed onto every rebuild the way ingest/person-overlay.csv is.
 *
 * ITIS is the basis (Andony, 2026-09-11), so the file holds only the claims:
 *
 *   addition    a name ITIS has not got, which the program keeps — the bee
 *               subgenera, Agapostemon subtilior
 *   departure   a name ITIS calls outdated, kept under the program's own
 *               treatment — Protandrena where ITIS says Pseudopanurgus
 *   homonym     two current ITIS names share the spelling; this says which
 *               one the program means, by TSN
 *
 * A name that matches a current ITIS name needs no row, and a synonym with
 * no departure row is ITIS's to rename. Every row is a taxonomist's decision
 * — `taxonomist` and `reason` are required, `reference` carries the DOI or
 * link where a paper is behind it — and records what ITIS said at the time
 * (`itis_tsn`, `itis_current_name`, `itis_release`), which is what
 * animal_curation_stale (schema/118) checks each later release against.
 *
 * A row names its node by rank and name, the table's own key, and never by
 * entity_id, which a rebuild redraws. Where the node does not exist yet the
 * applier creates it, under the parent its name implies — a species under
 * its genus, a subgenus under its genus, a subspecies under its species —
 * or under `parent_rank`/`parent_name` for a rank whose name says nothing
 * about where it goes. That is what lets the seed stop minting a node for
 * every spelling it meets (Peter, 2026-10-02): a name ITIS lacks exists
 * because a row here says so.
 *
 * Read strictly and refused rather than repaired, like the overlays: the
 * file is rewritten wholesale when decisions come back from a taxonomist's
 * sheet, and a row dropped for being unparseable would be erased for good.
 */

export const CURATION_KINDS = ["addition", "departure", "homonym"] as const;
export type CurationKind = (typeof CURATION_KINDS)[number];

export interface TaxonCurationRow {
  kind: CurationKind;
  rank: string;
  name: string;
  /** Both or neither; for a rank whose name does not say where it goes. */
  parent_rank: string;
  parent_name: string;
  /** Departure: the TSN of the program's name in ITIS. Homonym: the TSN chosen. Addition: empty. */
  itis_tsn: string;
  /** Departure only: what ITIS accepted instead, at the time. */
  itis_current_name: string;
  /** ISO date of the ITIS release the decision was made against. */
  itis_release: string;
  taxonomist: string;
  decided_on: string;
  /** A DOI or URL, or empty. */
  reference: string;
  reason: string;
}

export const CURATED_TAXON_CURATION = "ingest/taxon-curation.csv";

export const CURATION_COLUMNS = [
  "kind",
  "rank",
  "name",
  "parent_rank",
  "parent_name",
  "itis_tsn",
  "itis_current_name",
  "itis_release",
  "taxonomist",
  "decided_on",
  "reference",
  "reason",
] as const;
const HEADER = CURATION_COLUMNS.join(",");

export const curationKey = (r: { rank: string; name: string }) => `${r.rank} ${r.name}`;

// The shape and the calendar both: 2026-13-45 is the shape, and would fail
// only at the INSERT, after the table had been emptied.
const isDate = (s: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
};

/** Why this row cannot be stored, or null if it can. */
export function rowProblem(row: TaxonCurationRow): string | null {
  if (!(CURATION_KINDS as readonly string[]).includes(row.kind)) return `'${row.kind}' is not a kind (${CURATION_KINDS.join(", ")})`;
  if (row.rank === "" || row.name === "") return "rank and name are required";
  if ((row.parent_rank === "") !== (row.parent_name === "")) return "parent_rank and parent_name go together";
  if (row.kind === "addition") {
    if (row.itis_tsn !== "") return "an addition has no ITIS TSN: ITIS does not have the name";
    if (row.itis_current_name !== "") return "an addition has no ITIS current name";
  } else {
    if (!/^\d+$/.test(row.itis_tsn)) return `a ${row.kind} needs the ITIS TSN it is about`;
    if (row.kind === "departure" && row.itis_current_name === "") return "a departure says what ITIS calls the name instead";
    if (row.kind === "homonym" && row.itis_current_name !== "") return "a homonym resolution has no ITIS current name";
  }
  if (!isDate(row.itis_release)) return `itis_release '${row.itis_release}' is not a date (YYYY-MM-DD)`;
  if (!isDate(row.decided_on)) return `decided_on '${row.decided_on}' is not a date (YYYY-MM-DD)`;
  if (row.taxonomist.trim() === "") return "every row names the taxonomist who decided";
  if (row.reason.trim() === "") return "every row says why";
  return null;
}

export function parseTaxonCuration(text: string, where: string): TaxonCurationRow[] {
  const records = parseCsv(text).filter((r) => !(r.length === 1 && r[0] === ""));
  if (records.length === 0) return [];
  const header = records[0]!;
  if (header.join(",") !== HEADER) {
    throw new Error(`${where}: header is '${header.join(",")}', expected '${HEADER}'`);
  }
  const seen = new Set<string>();
  return records.slice(1).map((r, i) => {
    const line = i + 2;
    if (r.length !== CURATION_COLUMNS.length) {
      throw new Error(`${where} line ${line}: ${r.length} fields, expected ${CURATION_COLUMNS.length}`);
    }
    const row = Object.fromEntries(CURATION_COLUMNS.map((c, j) => [c, r[j]!])) as unknown as TaxonCurationRow;
    const bad = rowProblem(row);
    if (bad !== null) throw new Error(`${where} line ${line}: ${bad}`);
    const key = curationKey(row);
    if (seen.has(key)) throw new Error(`${where} line ${line}: '${row.name}' (${row.rank}) is decided twice`);
    seen.add(key);
    return row;
  });
}

export async function readTaxonCuration(path: string): Promise<TaxonCurationRow[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return parseTaxonCuration(text, path);
}

// RFC 4180 and nothing more: no formula guard, since a reason beginning with
// a dash must read back as written, and this file is for the loader, not a
// spreadsheet.
const cell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);

export function formatTaxonCuration(rows: readonly TaxonCurationRow[]): string {
  const body = rows.map((r) => CURATION_COLUMNS.map((c) => cell(r[c])).join(","));
  return `${[HEADER, ...body].join("\n")}\n`;
}

/**
 * Rewrite the file whole, sorted so a diff reads as a change to a decision
 * and not a reshuffle: kind, then rank, then name. Atomic, like the overlays.
 */
export async function writeTaxonCuration(path: string, rows: readonly TaxonCurationRow[]): Promise<void> {
  const sorted = [...rows].sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.rank.localeCompare(b.rank) || a.name.localeCompare(b.name),
  );
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, formatTaxonCuration(sorted));
  await rename(tmp, path);
}

/** Where a node's name says it goes: the parent rank and name, or null where it does not. */
export function impliedParent(rank: string, name: string): { rank: string; name: string } | null {
  const words = name.split(" ");
  if (rank === "species" && words.length === 2) return { rank: "genus", name: words[0]! };
  if (rank === "subspecies" && words.length === 3) return { rank: "species", name: `${words[0]} ${words[1]}` };
  if (rank === "subgenus") {
    const m = /^(\S+) \((\S+)\)$/.exec(name);
    if (m !== null) return { rank: "genus", name: m[1]! };
  }
  return null;
}

export interface Unplaced {
  rank: string;
  name: string;
  problem: string;
}

export interface ApplyResult {
  /** Rows written to animal_curation. */
  applied: number;
  /** Nodes the file brought into existence on this store. */
  created: number;
  /** Rows whose node could not be made: a parent nowhere in the tree, or a rank whose parent the row did not name. */
  unplaced: Unplaced[];
}

const lit = (s: string) => `'${s.replaceAll("'", "''")}'`;

/**
 * Replay the file onto the store: the table is restated wholesale, so a row
 * removed from the file — a departure ITIS has since adopted — is gone from
 * the store too. Missing nodes are created under their parent; a row whose
 * parent is not in the tree is reported and skipped rather than guessed at,
* since minting a chain of ancestors from one row would invent placements
 * nobody decided. Ends by restating animal.itis_tsn, because a homonym
 * resolution changes what its node matches.
 *
 * Opens no transaction of its own: legacy promotion runs it as one step of
 * building a store that is thrown away if any step fails, and a BEGIN here
 * would refuse to nest should promotion ever wrap itself. The CLI, which
 * writes to a store that is kept, wraps it.
 */
export async function applyTaxonCuration(conn: DuckDBConnection, rows: readonly TaxonCurationRow[]): Promise<ApplyResult> {
  const one = async (sql: string): Promise<unknown[] | undefined> => (await (await conn.run(sql)).getRows())[0];
  const nodeId = async (rank: string, name: string): Promise<number | null> => {
    const r = await one(`SELECT entity_id FROM animal WHERE rank = ${lit(rank)} AND scientific_name = ${lit(name)}`);
    return r === undefined ? null : Number(r[0]);
  };

  const result: ApplyResult = { applied: 0, created: 0, unplaced: [] };
  await conn.run("DELETE FROM animal_curation");
  for (const row of rows) {
    let id = await nodeId(row.rank, row.name);
    if (id === null) {
      const parent =
        row.parent_rank !== "" ? { rank: row.parent_rank, name: row.parent_name } : impliedParent(row.rank, row.name);
      if (parent === null) {
        result.unplaced.push({ rank: row.rank, name: row.name, problem: "the name does not say where it goes: give parent_rank and parent_name" });
        continue;
      }
      const parentId = await nodeId(parent.rank, parent.name);
      if (parentId === null) {
        result.unplaced.push({ rank: row.rank, name: row.name, problem: `its ${parent.rank} '${parent.name}' is not in the tree` });
        continue;
      }
      await conn.run(
        `INSERT INTO animal (rank, scientific_name, parent_id) VALUES (${lit(row.rank)}, ${lit(row.name)}, ${parentId})`,
      );
      id = await nodeId(row.rank, row.name);
      result.created += 1;
    }
    await conn.run(
      `INSERT INTO animal_curation (animal_id, kind, itis_tsn, itis_current_name, itis_release, taxonomist, decided_on, reference, reason)
       VALUES (${id}, ${lit(row.kind)}, ${row.itis_tsn === "" ? "NULL" : row.itis_tsn},
               ${row.itis_current_name === "" ? "NULL" : lit(row.itis_current_name)}, DATE ${lit(row.itis_release)},
               ${lit(row.taxonomist)}, DATE ${lit(row.decided_on)}, ${row.reference === "" ? "NULL" : lit(row.reference)}, ${lit(row.reason)})`,
    );
    result.applied += 1;
  }
  await matchAnimalsToItis(conn);
  return result;
}

// CLI: pnpm taxon:apply [db] — replay ingest/taxon-curation.csv onto an existing store.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const dbPath = process.argv[2] ?? DEFAULT_DB;
  const rows = await readTaxonCuration(CURATED_TAXON_CURATION);
  const instance = await openDuckDb(dbPath);
  const conn = await instance.connect();
  try {
    // One transaction: the table is emptied before it is refilled, and a row
    // that fails halfway must not leave the store with half the decisions.
    await conn.run("BEGIN TRANSACTION");
    let result: ApplyResult;
    try {
      result = await applyTaxonCuration(conn, rows);
      await conn.run("COMMIT");
    } catch (err) {
      await conn.run("ROLLBACK").catch(() => {});
      throw err;
    }
    const stale = await (await conn.run("SELECT rank, scientific_name, problem FROM animal_curation_stale ORDER BY 1, 2")).getRows();
    console.log(JSON.stringify({ ...result, stale }, null, 2));
  } finally {
    conn.closeSync();
  }
}
