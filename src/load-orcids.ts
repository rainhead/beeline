import type { DuckDBConnection } from "@duckdb/node-api";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { applyPersonOverlay, resolver } from "./apply-person-overlay.js";
import { parseCsv } from "./corrections.js";
import { parseOrcid } from "./orcid.js";
import {
  appendChanges,
  changeLogFor,
  DEFAULT_DB,
  diffPerson,
  duckdbReader,
  knownPerson,
  lastKnown,
  readChanges,
  readPersonStates,
} from "./person-change.js";
import { upsertOverlay, type PersonOverlayRow } from "./person-overlay.js";

/**
 * Record ORCID iDs staff have confirmed, several at once (beeline-0544):
 * what /people/:id does for one, for a list kept outside git because it names
 * volunteers beside their iDs.
 *
 *   display_name,orcid,confirmed_by,confirmed_on,how
 *
 * Each row becomes the overlay decision the page would have written — field
 * `orcid`, the person named by display name, `confirmed_by` as its author and
 * `how` with the date as its reason — so a rebuild replays it like any other,
 * and is applied and entered in the person's history as a staff decision.
 *
 * All or nothing: a name that reaches nobody or two people, an iD that fails
 * its checksum, or one iD given to two names stops the load before anything
 * is written, and every problem is listed at once.
 */

const COLUMNS = ["display_name", "orcid", "confirmed_by", "confirmed_on", "how"] as const;

export interface LoadOrcidsResult {
  recorded: number;
  /** Rows written to the overlay that the store then refused; none is expected. */
  unresolved: string[];
  personChangesRecorded: number | null;
}

/** The file as overlay rows, or every reason it cannot be. */
export function orcidRows(text: string): { rows: PersonOverlayRow[]; problems: string[] } {
  const [header, ...records] = parseCsv(text);
  if (header === undefined || header.join(",") !== COLUMNS.join(",")) {
    return { rows: [], problems: [`header is '${header?.join(",") ?? ""}', expected '${COLUMNS.join(",")}'`] };
  }
  const rows: PersonOverlayRow[] = [];
  const problems: string[] = [];
  const seen = new Map<string, string>();
  records.forEach((r, i) => {
    const line = i + 2;
    const [name, given, by, on, how] = COLUMNS.map((_, j) => (r[j] ?? "").trim());
    const orcid = parseOrcid(given!);
    if (name === "") problems.push(`line ${line}: no display_name`);
    if (orcid === null) problems.push(`line ${line}: '${given}' is not an ORCID iD`);
    if (by === "") problems.push(`line ${line}: no confirmed_by — somebody has to have confirmed it`);
    if (orcid !== null && seen.has(orcid)) problems.push(`line ${line}: ${orcid} is also given to ${seen.get(orcid)}`);
    if (orcid === null || name === "" || by === "") return;
    seen.set(orcid, name!);
    rows.push({
      person_ref: `name:${name}`,
      field: "orcid",
      value: orcid,
      author: by!,
      reason: [how, on === "" ? "" : `(${on})`].filter((s) => s !== "").join(" "),
    });
  });
  return { rows, problems };
}

export async function loadOrcids(
  conn: DuckDBConnection,
  rows: readonly PersonOverlayRow[],
  paths: { overlay: string; changeLog: string | null },
): Promise<LoadOrcidsResult | { problems: string[] }> {
  const { resolve } = await resolver(conn);
  const ids = new Map<PersonOverlayRow, number>();
  const problems: string[] = [];
  for (const row of rows) {
    const found = resolve(row.person_ref);
    if ("problem" in found) {
      problems.push(found.problem);
      continue;
    }
    ids.set(row, found.id);
    // Checked here as well as by the apply step, because the overlay is
    // written first: a row the apply step then refused would stand in the
    // file and fail on every rebuild.
    const holder = (await (
      await conn.run(`SELECT p.display_name FROM person_orcid o JOIN person p ON p.entity_id = o.person_id
                      WHERE o.orcid = $1 AND o.person_id <> $2`, [row.value, found.id] as never)
    ).getRows()) as [string][];
    if (holder.length > 0) problems.push(`${row.value} is already recorded for ${holder[0]![0]}`);
  }
  if (problems.length > 0) return { problems };

  await upsertOverlay(paths.overlay, rows);
  const read = duckdbReader(conn);
  const stateOf = async (personId: number) => {
    const states = await readPersonStates(read, `p.entity_id = ${personId}`);
    return { state: [...states.states.values()][0], names: states.names };
  };
  const unresolved: string[] = [];
  let changes = 0;
  for (const row of rows) {
    const personId = ids.get(row)!;
    const before = (await stateOf(personId)).state;
    const applied = await applyPersonOverlay(conn, [row]);
    unresolved.push(...applied.unresolved.map((u) => `${u.person_ref}: ${u.reason}`));
    if (paths.changeLog === null) continue;
    const { state: after, names } = await stateOf(personId);
    if (after === undefined) continue;
    // Filed under the reference the log knows them by, as the page files it.
    const seen = knownPerson({ known: lastKnown(await readChanges(paths.changeLog)), names }, before ?? after);
    const entries = diffPerson(seen?.ref ?? before?.ref ?? after.ref, before, after, {
      source: "app",
      author: row.author,
      reason: row.reason,
    });
    await appendChanges(paths.changeLog, entries);
    changes += entries.length;
  }
  return { recorded: rows.length - unresolved.length, unresolved, personChangesRecorded: paths.changeLog === null ? null : changes };
}

// CLI: pnpm person:orcids <file> [db]. Holds the store, so on the sandbox it
// runs in maintenance mode like person:apply (docs/runbooks/deploy-fly.md).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { openDuckDb } = await import("./db.js");
  const file = process.argv[2];
  if (file === undefined) {
    console.error("usage: pnpm person:orcids <file.csv> [db]");
    process.exit(2);
  }
  const { rows, problems } = orcidRows(await readFile(file, "utf8"));
  if (problems.length > 0) {
    console.error(`${file}: nothing recorded\n${problems.map((p) => `  ${p}`).join("\n")}`);
    process.exit(1);
  }
  const dbPath = process.argv[3] ?? process.env.BEELINE_DB ?? DEFAULT_DB;
  const instance = await openDuckDb(dbPath);
  const conn = await instance.connect();
  const result = await loadOrcids(conn, rows, {
    overlay: process.env.BEELINE_PERSON_OVERLAY ?? "data/person-overlay.csv",
    changeLog: changeLogFor(dbPath, process.env),
  });
  await conn.run("CHECKPOINT");
  conn.closeSync();
  if ("problems" in result) {
    console.error(`${file}: nothing recorded\n${result.problems.map((p) => `  ${p}`).join("\n")}`);
    process.exit(1);
  }
  console.log(JSON.stringify(result, null, 2));
}
