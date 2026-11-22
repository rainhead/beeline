import { sql, type Kysely } from "kysely";
import type { Database } from "../model.js";
import { CATCH_ALL, scopePrograms, sampleIdsInScope } from "./listings.js";
import type { SeasonSplit } from "./upload-plan.js";

/**
 * Whose records an upload would change (beeline-kgyd.13). Staff are one role, so an upload may change any program's
 * records, and a staff member who types into the wrong row of a file of every atlas changes another atlas's record with
 * every check passing. Nothing is refused: taxonomists identify bees for one another's atlases, so changes outside the
 * programs a person leads are ordinary. The preview names those programs with how many records would change in each,
 * and applying asks once. See docs/architecture/loading-an-edited-download.md.
 *
 * A person's own programs are the ones they lead (`program_lead`). Someone who leads none has no program of their own,
 * so for them every record is another program's (Peter, 2026-11-21: they are administrators, who rarely upload).
 */

/** One record an upload would change: a sample that Beeline has, or a new trap sample whose programs are already known. */
export interface ChangedRecord {
  /** The sample, for a record Beeline has. Null for a new trap sample, whose programs are given. */
  sampleId: number | null;
  /** The program codes of a new trap sample, which is in no store yet. */
  programs?: readonly string[];
  season: keyof SeasonSplit;
}

/** A program that is not the person's own, with how many of the upload's changes are to its records. */
export interface OtherProgram {
  code: string;
  /** As people write it (program_abbreviation). */
  abbreviation: string;
  /** Records changed there, each counted by the season of its sample. */
  records: SeasonSplit;
}

/** The codes of the programs a person leads. */
export async function programsLed(db: Kysely<Database>, personId: number): Promise<Set<string>> {
  const { rows } = await sql<{ code: string }>`
    SELECT p.code FROM program_lead pl JOIN program p ON p.entity_id = pl.program_id WHERE pl.person_id = ${personId}`.execute(db);
  return new Set(rows.map((r) => r.code));
}

/** How each program is abbreviated, by code; the code where none is recorded. */
async function abbreviations(db: Kysely<Database>): Promise<Map<string, string>> {
  const { rows } = await sql<{ code: string; abbreviation: string | null }>`
    SELECT p.code, pab.abbreviation FROM program p LEFT JOIN program_abbreviation pab ON pab.program_id = p.entity_id`.execute(db);
  return new Map(rows.map((r) => [r.code, r.abbreviation ?? r.code]));
}

/**
 * Every program each of the samples belongs to, as the listings scope them (`sampleIdsInScope`): an atlas by where the
 * sample fell, Master Melittology when no atlas covers it, and the refuges when its point lies in one. A sample can
 * belong to more than one, so a program is asked of each in turn.
 */
export async function programsOfSamples(db: Kysely<Database>, sampleIds: readonly number[]): Promise<Map<number, string[]>> {
  const by = new Map<number, string[]>(sampleIds.map((id) => [id, []]));
  if (sampleIds.length === 0) return by;
  const scopes = [...(await scopePrograms(db)).map((p) => p.code), CATCH_ALL];
  const CHUNK = 500;
  for (const scope of scopes) {
    for (let i = 0; i < sampleIds.length; i += CHUNK) {
      for (const id of await sampleIdsInScope(db, scope, sampleIds.slice(i, i + CHUNK))) by.get(id)!.push(scope);
    }
  }
  return by;
}

/**
 * The program a new trap sample would be filed under, from its state, as it is when the sample is made
 * (`writeParts` in src/trap-sample.ts): the atlas `atlas_region` gives the state, else Master Melittology. Whether its
 * point lies in a refuge is not judged: that is worked out from the gazetteer once the sample exists, so a new sample
 * is never found to be in the refuges' records here. `state` is as the trap form reads it (trimmed, upper case).
 */
export async function programsOfNewState(db: Kysely<Database>, states: readonly string[]): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>(states.map((s) => [s, [CATCH_ALL]]));
  if (states.length === 0) return found;
  const { rows } = await sql<{ state_province: string; code: string }>`
    SELECT r.state_province, p.code FROM atlas_region r JOIN program p ON p.entity_id = r.atlas_id
    WHERE r.state_province IN (${sql.join(states.map((s) => sql`${s}`))}) AND r.atlas_id IS NOT NULL`.execute(db);
  for (const r of rows) if (found.has(r.state_province)) found.set(r.state_province, [r.code]);
  return found;
}

/**
 * The programs, other than the ones the person leads, whose records the changes are to, each with its count: a record
 * is the person's own if any program it belongs to is one they lead. Empty where nothing is outside their own. In the
 * order the abbreviations sort.
 */
export async function otherPrograms(db: Kysely<Database>, personId: number, changed: readonly ChangedRecord[]): Promise<OtherProgram[]> {
  if (changed.length === 0) return [];
  const [led, names, byId] = await Promise.all([
    programsLed(db, personId),
    abbreviations(db),
    programsOfSamples(db, [...new Set(changed.flatMap((r) => (r.sampleId === null ? [] : [r.sampleId])))]),
  ]);
  const counts = new Map<string, SeasonSplit>();
  for (const record of changed) {
    const programs = record.sampleId === null ? (record.programs ?? []) : (byId.get(record.sampleId) ?? []);
    if (programs.some((p) => led.has(p))) continue;
    for (const code of programs) {
      const split = counts.get(code) ?? counts.set(code, { active: 0, settled: 0, unplaced: 0 }).get(code)!;
      split[record.season]++;
    }
  }
  return [...counts]
    .map(([code, records]) => ({ code, abbreviation: names.get(code) ?? code, records }))
    .sort((a, b) => (a.abbreviation < b.abbreviation ? -1 : a.abbreviation > b.abbreviation ? 1 : 0));
}
