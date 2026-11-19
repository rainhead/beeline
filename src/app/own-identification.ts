import { createHash } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { Database, DraftCaste, DraftSex } from "../model.js";
import type { SpecimenRow } from "./listings.js";

/**
 * What a volunteer's copy of the specimens download says a bee is (beeline-kgyd.7,
 * Peter, 2026-11-18: "Volunteers should download their own latest
 * identification only"): the draft they have on Identify specimens, else the
 * newest identification of their own that is not an expert's, else nothing.
 * Never the identification of record, and never an expert's, so that an
 * expert's name cannot reach a volunteer's file and come back as theirs.
 *
 * "Their own" is the determiner's: whoever the drafts would be credited to.
 * Identify specimens credits the person signed in, never the one a delegate
 * acts for (src/app/determine.ts), so a delegate's file holds the delegate's
 * own identifications of the specimens they reach for the household.
 *
 * The file's comparison reads the same thing (src/app/upload-plan.ts), so a
 * cell the person left alone is never a difference.
 */
export interface OwnIdentification {
  /** The name's node in the tree; null for a draft naming a taxon from Ecdysis, or a draft that names nothing. */
  animalId: number | null;
  /** A draft's name from Ecdysis that the tree does not hold yet. */
  ecdysisTid: number | null;
  name: string | null;
  rank: string | null;
  authorship: string | null;
  sex: string | null;
  caste: string | null;
  /** Whether this is a draft, which the person can still change on Identify specimens until 1am. */
  draft: boolean;
}

const CHUNK = 1000;

/** The person's own identification of each specimen that has one. */
export async function ownIdentifications(
  db: Kysely<Database>,
  determinerId: number,
  specimenIds: readonly number[],
): Promise<Map<number, OwnIdentification>> {
  const out = new Map<number, OwnIdentification>();
  for (let i = 0; i < specimenIds.length; i += CHUNK) {
    const list = sql.join(specimenIds.slice(i, i + CHUNK).map((id) => sql`${id}`));
    const found = await sql<{
      specimen_id: number;
      animal_id: number | null;
      ecdysis_tid: number | null;
      name: string | null;
      rank: string | null;
      authorship: string | null;
      sex: DraftSex | string | null;
      caste: DraftCaste | string | null;
      draft: boolean;
    }>`
      WITH drafted AS (
        SELECT dd.specimen_id, dd.animal_id, CAST(dd.ecdysis_tid AS INTEGER) AS ecdysis_tid,
               coalesce(a.scientific_name, et.name) AS name, coalesce(a.rank, et.rank) AS rank,
               coalesce(a.authorship, et.author) AS authorship, dd.sex, dd.caste, true AS draft
        FROM determination_draft dd
        LEFT JOIN animal a ON a.entity_id = dd.animal_id
        LEFT JOIN ecdysis_taxon et ON et.tid = dd.ecdysis_tid AND dd.animal_id IS NULL
        WHERE dd.determiner_id = ${determinerId} AND dd.specimen_id IN (${list})
      ),
      determined AS (
        SELECT specimen_id, animal_id, NULL AS ecdysis_tid, name, rank, authorship, sex, caste, false AS draft FROM (
          SELECT d.specimen_id, d.animal_id, a.scientific_name AS name, a.rank, a.authorship, d.sex, d.caste,
                 row_number() OVER (PARTITION BY d.specimen_id ORDER BY d.recorded_at DESC, d.entity_id DESC) AS rn
          FROM determination d
          JOIN animal a ON a.entity_id = d.animal_id
          WHERE d.determiner_id = ${determinerId} AND NOT d.is_expert AND d.specimen_id IN (${list})
        ) ranked WHERE rn = 1
      )
      SELECT * FROM drafted
      UNION ALL
      SELECT * FROM determined WHERE specimen_id NOT IN (SELECT specimen_id FROM drafted)`.execute(db);
    for (const r of found.rows) {
      out.set(Number(r.specimen_id), {
        animalId: r.animal_id === null ? null : Number(r.animal_id),
        ecdysisTid: r.ecdysis_tid === null ? null : Number(r.ecdysis_tid),
        name: r.name,
        rank: r.rank,
        authorship: r.authorship,
        sex: r.sex,
        caste: r.caste,
        draft: r.draft === true,
      });
    }
  }
  return out;
}

/**
 * A row of the specimens listing as a volunteer's file writes it: their own
 * identification in place of the record's, and none of the record's
 * determiner, date, qualifier or expert flag. The disposition and its remark
 * go too: a volunteer's file does not carry them, and they would otherwise
 * make the row's version change when staff record what became of the pin.
 */
export function withOwnIdentification(row: SpecimenRow, own: OwnIdentification | undefined): SpecimenRow {
  return {
    ...row,
    scientific_name: own?.name ?? null,
    authorship: own?.authorship ?? null,
    taxon_rank: own?.rank ?? null,
    qualifier: null,
    verbatim_identification: null,
    sex: own?.sex ?? null,
    caste: own?.caste ?? null,
    determination_id: null,
    is_expert: null,
    determiner: null,
    determiner_orcid: null,
    determined_on: null,
    determined_on_precision: null,
    disposition: null,
    occurrence_remarks: null,
  };
}

/**
 * The `specimenVersion` of a volunteer's row: a short name for their own
 * identification as the file gave it, and the specimen's id. It starts with
 * `o` where staff's starts with `s`, so the two are never equal: a row from
 * one kind of file is never taken as current in the other. It does not change
 * when the overnight commit turns a draft into the same identification, or
 * when anyone else identifies the bee, since neither changes what the person's
 * own file says.
 */
export const ownVersion = (row: Pick<SpecimenRow, "specimen_id" | "scientific_name" | "sex" | "caste">): string =>
  `o${createHash("sha256")
    .update(JSON.stringify([row.specimen_id, row.scientific_name, row.sex, row.caste]))
    .digest("hex")
    .slice(0, 12)}`;
