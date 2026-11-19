import { sql, type Kysely } from "kysely";
import { AREA_RULE_VERSION, followsPointSql } from "../derive-area.js";
import type { Database } from "../model.js";
import { withPrintRunLock } from "../print-run.js";
import { isWriteConflict } from "../write-conflict.js";
import { applySampleEdit } from "./sample-edit.js";
import { fromOldRecords } from "./sample-method.js";

/**
 * Staff correcting the country, state and county a sample was collected in
 * (beeline-kgyd.4.3), for the samples upload (beeline-kgyd.4) and the API. No
 * page offers it yet (Peter, 2026-11-18).
 *
 * Where the correction is kept depends on what the sample was built from, as
 * for the method (src/app/sample-method.ts):
 *
 * - A sample built from the old Beeline's records, with an iNaturalist
 *   observation or without: one event per record and field in the
 *   corrections file, mirrored into the store's correction tables, then the
 *   sample. That is the collector's own edit (src/app/sample-edit.ts), so the
 *   legacy-format export and `legacy:compare-export` read the records as
 *   corrected, and a development store rebuilt from the file makes the same
 *   sample.
 * - Any other sample, entered in Beeline or minted from an observation: the
 *   sample directly, since there is no record outside the store to name.
 *
 * What it refuses, besides a value that would print wrong:
 *
 * - A sample whose place follows its point (src/derive-area.ts,
 *   `followsPointSql`): a staff point, or a sample still to print with an
 *   observation or entered in Beeline. The nightly writes those from the
 *   point, so a correction would be undone by morning; staff correct the
 *   point instead. A sample whose point the areas step found in no county,
 *   or in two, is not refused, since the nightly then writes nothing.
 * - A sample whose labels are in a print run that has not printed: the run
 *   froze the place its labels carry, as it froze the point.
 * - A blank county on a sample with an observation: minting fills an empty
 *   county from iNaturalist on every promotion (ingest/mint-samples.sql), so
 *   a blank would come back by morning.
 *
 * A changed state moves the atlas where geography had assigned it, as the
 * nightly's stamp does; an atlas a person assigned stays.
 *
 * Everything from the reads to the write is behind the print runs' lock, as
 * the stamp and the trap form are, so a run cannot be prepared between the
 * check and the write, and the stamp cannot write a county between them. The
 * store write is one transaction through Kysely, which takes a connection of
 * its own for it (kysely-duckdb connects afresh for each), so it shares
 * nothing with the app's connection. Callers run it inside the sample's
 * queue turn (src/app/sample-queue.ts) and record the history after it.
 */

export type PlaceField = "country" | "state_province" | "county";
export const PLACE_FIELDS: readonly PlaceField[] = ["country", "state_province", "county"];

export interface PlaceInput {
  /** Absent fields stay as they are; a county may be blank, the other two may not. */
  values: Partial<Record<PlaceField, string>>;
  note: string;
  /** iNat login of whoever is acting: the events' author. */
  author: string;
}

/** One value the correction changed: the field, what it was and what it is. The atlas is the program's code. */
export interface PlaceChange {
  field: PlaceField | "atlas";
  from: string | null;
  to: string | null;
}

export type PlaceResult =
  | { outcome: "saved"; changes: PlaceChange[] }
  | { outcome: "unchanged" }
  | { outcome: "not_found" }
  | { outcome: "invalid"; problem: string }
  | { outcome: "follows_point" }
  | { outcome: "in_print_run" }
  /** The store write lost a write conflict and nothing was recorded anywhere. */
  | { outcome: "conflict" }
  /** The corrections file holds the change, but the store write lost a write conflict. */
  | { outcome: "not_applied" };

/** Countries whose states and provinces atlas_region lists in full, so a code it does not list is a mistake. */
const LISTED_COUNTRIES = new Set(["USA", "CAN"]);

/** The value a field will hold, from the input or the sample as it is. A blank county is none. */
function nextValues(current: Record<PlaceField, string | null>, values: PlaceInput["values"]): Record<PlaceField, string | null> {
  const given = (f: PlaceField) => values[f];
  const country = given("country");
  const state = given("state_province");
  const county = given("county");
  return {
    country: country === undefined ? current.country : country.trim().toUpperCase(),
    state_province: state === undefined ? current.state_province : state.trim().toUpperCase(),
    county: county === undefined ? current.county : county.trim() === "" ? null : county.trim(),
  };
}

/** Why these values would be wrong on a label, or null. */
async function problemWith(db: Kysely<Database>, next: Record<PlaceField, string | null>, observed: boolean): Promise<string | null> {
  const country = next.country ?? "";
  const state = next.state_province ?? "";
  if (!/^[A-Z]{3}$/.test(country)) return "The country is the three-letter code Beeline keeps, such as USA or CAN.";
  if (!/^[A-Z]{2,3}$/.test(state)) return "The state or province is its two-letter code, such as OR, WA or BC.";
  const region = (
    await sql<{ country: string }>`SELECT country FROM atlas_region WHERE state_province = ${state}`.execute(db)
  ).rows[0];
  if (region !== undefined && region.country !== country) return `${state} is in ${region.country}, not ${country}.`;
  if (region === undefined && LISTED_COUNTRIES.has(country)) return `${state} is not a state or province of ${country}.`;
  const county = next.county;
  if (county === null) {
    if (observed) {
      return "A sample with an iNaturalist observation takes its county from the observation whenever it has none, so a blank county would be filled again tonight. Give the county.";
    }
    return null;
  }
  // A label prints the county as `USA:OR:BentonCo`, so a name with a comma or
  // its own "County" would print wrong (src/label-text.ts, locationText).
  if (county.includes(",")) return "Write the county's name alone, with no state or country after it.";
  if (country === "USA" && /\scounty$/i.test(county)) return `Write the county's name alone, as ${county.replace(/\s+county$/i, "")}: the label adds "Co".`;
  if (/[\u0000-\u001f\u007f]/.test(county) || county.length > 100) return "The county is a name of at most 100 characters.";
  return null;
}

/**
 * Whether the nightly writes this sample's place from its point: it follows
 * the point, and has one, and the areas step has not found that point to be
 * in no county or in two. A point not yet tested may be in one, and so may
 * one tested under an older rule or against an older gazetteer, which the
 * next nightly tests again (CodeRabbit): only a derivation under the current
 * rule and the newest build any derivation used counts. The store does not
 * hold which gazetteer is current, so the newest build in use stands for it.
 */
async function followsItsPoint(db: Kysely<Database>, sampleId: number): Promise<boolean> {
  const found = await sql<{ follows: boolean }>`
    SELECT ${sql.raw(followsPointSql("s"))}
           AND EXISTS (
             SELECT 1 FROM sample_location l
             WHERE l.sample_id = s.entity_id
               AND NOT EXISTS (SELECT 1 FROM sample_area_derivation d
                               WHERE d.sample_id = s.entity_id
                                 AND abs(d.latitude - l.latitude) <= 5e-5
                                 AND abs(d.longitude - l.longitude) <= 5e-5
                                 AND d.rule_version = ${AREA_RULE_VERSION}
                                 AND d.gazetteer_build = (SELECT arg_max(gazetteer_build, derived_at) FROM sample_area_derivation)
                                 AND d.country IS NULL)) AS follows
    FROM sample s WHERE s.entity_id = ${sampleId}`.execute(db);
  return Boolean(found.rows[0]?.follows);
}

/** Whether labels for this sample are in a print run that has not printed (as setStaffCoordinates asks). */
async function heldByUnprintedRun(db: Kysely<Database>, sampleId: number): Promise<boolean> {
  const found = await sql<{ e: boolean }>`
    SELECT EXISTS (SELECT 1 FROM sample_label_in_progress WHERE sample_id = ${sampleId} AND printing_count > 0) AS e`.execute(db);
  return Boolean(found.rows[0]?.e);
}

async function atlasOf(db: Kysely<Database>, sampleId: number): Promise<string | null> {
  const found = await sql<{ code: string | null }>`
    SELECT p.code FROM sample_atlas sa LEFT JOIN program p ON p.entity_id = sa.atlas_id WHERE sa.sample_id = ${sampleId}`.execute(db);
  return found.rows[0]?.code ?? null;
}

/**
 * The atlas follows a changed state where geography assigned it: the
 * nightly's stamp in src/derive-area.ts, for one sample. An atlas a person
 * assigned, a "none" included, stays.
 */
async function reassignAtlas(trx: Kysely<Database>, sampleId: number): Promise<void> {
  await sql`DELETE FROM sample_atlas WHERE sample_id = ${sampleId} AND assigned_by IS NULL`.execute(trx);
  await sql`INSERT INTO sample_atlas (sample_id, atlas_id)
            SELECT sample_id, should_be FROM sample_atlas_unfilled WHERE sample_id = ${sampleId}`.execute(trx);
}

export function setStaffPlace(db: Kysely<Database>, correctionsPath: string, sampleId: number, input: PlaceInput): Promise<PlaceResult> {
  return withPrintRunLock(async (): Promise<PlaceResult> => {
    const sample = await db
      .selectFrom("sample")
      .where("entity_id", "=", sampleId)
      .select(["entity_id", "sample_number", "date_start", "locality", "country", "state_province", "county", "protocol", "inat_observation_id"])
      .executeTakeFirst();
    if (sample === undefined) return { outcome: "not_found" };
    const current = { country: sample.country, state_province: sample.state_province, county: sample.county };
    const next = nextValues(current, input.values);
    const changed = PLACE_FIELDS.filter((f) => next[f] !== (current[f] ?? null));
    if (changed.length === 0) return { outcome: "unchanged" };
    const problem = await problemWith(db, next, sample.inat_observation_id !== null);
    if (problem !== null) return { outcome: "invalid", problem };
    if (await heldByUnprintedRun(db, sampleId)) return { outcome: "in_print_run" };
    if (await followsItsPoint(db, sampleId)) return { outcome: "follows_point" };

    const atlasBefore = await atlasOf(db, sampleId);
    const stateChanged = changed.includes("state_province");
    const oldRecords = await fromOldRecords(db, sampleId);
    try {
      if (oldRecords) {
        const values = Object.fromEntries(changed.map((f) => [f, next[f] ?? ""]));
        const written = await applySampleEdit(
          db,
          correctionsPath,
          sample,
          { values, bases: {}, note: input.note, author: input.author },
          { inTransaction: async (trx) => (stateChanged ? reassignAtlas(trx, sampleId) : undefined) },
        );
        // fromOldRecords found the records the plan reads, so neither can happen; said rather than assumed.
        if (written.outcome !== "saved") return { outcome: "unchanged" };
      } else {
        await db.transaction().execute(async (trx) => {
          await trx
            .updateTable("sample")
            .set(Object.fromEntries(changed.map((f) => [f, next[f]])))
            .where("entity_id", "=", sampleId)
            .execute();
          if (stateChanged) await reassignAtlas(trx, sampleId);
        });
      }
    } catch (err) {
      // The old records' events are in the file by now; nothing else is recorded anywhere.
      if (isWriteConflict(err)) return { outcome: oldRecords ? "not_applied" : "conflict" };
      throw err;
    }
    const changes: PlaceChange[] = changed.map((f) => ({ field: f, from: current[f] ?? null, to: next[f] }));
    const atlasAfter = await atlasOf(db, sampleId);
    if (atlasAfter !== atlasBefore) changes.push({ field: "atlas", from: atlasBefore, to: atlasAfter });
    return { outcome: "saved", changes };
  });
}
