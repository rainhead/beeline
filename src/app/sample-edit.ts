import { sql, type Kysely } from "kysely";
import type { Database } from "../model.js";
import { upsertCorrections, type CorrectionEvent } from "../corrections.js";

/**
 * In-app editing for samples with no iNaturalist observation to fix
 * (beeline-2c3.8). A save does two writes: correction events into the
 * app-written store (durability — they re-apply on every rebuild, ADR 0004
 * frozen-upstream case) and the same values onto the live sample row
 * (immediacy — qc_finding is a view, so findings recompute on the next
 * read). A sample-level edit fans out to every staging row grouped into the
 * sample, each event anchored on that row's own raw staged value.
 */

/** Model column ↔ the staging column its correction events name. */
export const EDITABLE_FIELDS = [
  { name: "locality", staging: "locality" },
  { name: "country", staging: "country" },
  { name: "state_province", staging: "stateProvince" },
  { name: "county", staging: "county" },
  { name: "protocol", staging: "samplingProtocol" },
] as const;
export type EditableFieldName = (typeof EDITABLE_FIELDS)[number]["name"];

export interface EditableSample {
  entity_id: number;
  sample_number: string;
  date_start: Date;
  locality: string | null;
  country: string | null;
  state_province: string | null;
  county: string | null;
  protocol: string | null;
}

/** The sample, only if this person may edit it: theirs, and not iNat-backed. */
export async function loadEditableSample(
  db: Kysely<Database>,
  sampleId: number,
  personId: number,
): Promise<EditableSample | undefined> {
  return db
    .selectFrom("sample")
    .where("entity_id", "=", sampleId)
    .where("collector_id", "=", personId)
    .where("inat_observation_id", "is", null)
    .select(["entity_id", "sample_number", "date_start", "locality", "country", "state_province", "county", "protocol"])
    .executeTakeFirst();
}

interface StagingMember {
  _id: string;
  locality: string | null;
  country: string | null;
  stateProvince: string | null;
  county: string | null;
  samplingProtocol: string | null;
}

/** The raw staging rows behind a promoted sample (correction merge bases). */
async function stagingMembers(db: Kysely<Database>, sampleId: number): Promise<StagingMember[]> {
  const result = await sql<StagingMember>`
    SELECT o._id,
           o.locality,
           o.country,
           o."stateProvince" AS "stateProvince",
           o.county,
           o."samplingProtocol" AS "samplingProtocol"
    FROM legacy_sample_map s
    JOIN legacy_person_map m ON m.person_id = s.person_id
    JOIN legacy_promotable r
      ON r.fn IS NOT DISTINCT FROM m.fn
     AND r.ln IS NOT DISTINCT FROM m.ln
     AND r.sid = s.sid
     AND r.p_date_start IS NOT DISTINCT FROM s.p_date_start
    JOIN legacy_occurrence o ON o._id = r._id
    WHERE s.sample_id = ${sampleId}
  `.execute(db);
  return result.rows;
}

export interface SampleEditInput {
  values: Partial<Record<EditableFieldName, string>>;
  /**
   * The values the form was rendered with (hidden base:* fields). A field
   * submitted byte-equal to its base was never touched, so a stale tab
   * cannot revert a newer save it never saw (beeline-0br). A field with no
   * base falls back to diffing against the live row.
   */
  bases: Partial<Record<EditableFieldName, string>>;
  /** Optional free-text note; becomes the events' reason. */
  note: string;
  /** Who is editing (session login); becomes the events' author. */
  author: string;
}

export type SampleEditResult =
  | { outcome: "saved"; changed: EditableFieldName[] }
  | { outcome: "unchanged" }
  /** No staging rows back this sample — nothing durable to anchor on. */
  | { outcome: "no_staging" };

export async function applySampleEdit(
  db: Kysely<Database>,
  correctionsPath: string,
  sample: EditableSample,
  input: SampleEditInput,
): Promise<SampleEditResult> {
  // A field absent from the input is untouched; present-but-empty is a
  // deliberate clearing (the form always posts every field).
  const changed = EDITABLE_FIELDS.filter((f) => {
    const submitted = input.values[f.name];
    if (submitted === undefined) return false;
    const base = input.bases[f.name];
    if (base !== undefined) return submitted !== base;
    return submitted.trim() !== (sample[f.name] ?? "");
  });
  if (changed.length === 0) return { outcome: "unchanged" };

  const members = await stagingMembers(db, sample.entity_id);
  if (members.length === 0) return { outcome: "no_staging" };

  const reason = input.note.trim() !== "" ? input.note.trim() : "edited in Beeline";
  const events: CorrectionEvent[] = [];
  for (const member of members) {
    for (const f of changed) {
      const base = member[f.staging] ?? "";
      const newValue = (input.values[f.name] ?? "").trim();
      // Identity events (base === new) are written too: they replace a stale
      // app row and shadow any git-curated row for the key, so reverting to
      // the staged value retires the correction on rebuild (beeline-eef).
      events.push({ _id: member._id, field: f.staging, base_value: base, new_value: newValue, author: input.author, reason });
    }
  }
  // Durability before immediacy: if the event write fails, nothing applied.
  await upsertCorrections(correctionsPath, events);

  const updates = Object.fromEntries(
    changed.map((f) => {
      const submitted = (input.values[f.name] ?? "").trim();
      return [f.name, submitted === "" ? null : submitted];
    }),
  );
  await db.updateTable("sample").set(updates).where("entity_id", "=", sample.entity_id).execute();

  // A within-sample disagreement on an edited field is settled by the edit:
  // every member row now carries one value, so the stored finding would not
  // re-derive on rebuild — drop it now rather than making the volunteer
  // stare at a resolved warning until cutover.
  for (const f of changed) {
    await db
      .deleteFrom("sample_promotion_finding")
      .where("sample_id", "=", sample.entity_id)
      .where("rule_name", "=", "within_sample_disagreement")
      .where("details", "like", `${f.name}: %`)
      .execute();
  }
  return { outcome: "saved", changed: changed.map((f) => f.name) };
}
