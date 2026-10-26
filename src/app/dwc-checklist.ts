import { strToU8, zipSync } from "fflate";
import { sql, type Kysely } from "kysely";
import type { Database } from "../model.js";
import { DWC, fields, tabLine } from "./dwc-archive.js";
import { OUTSIDE } from "./listings.js";
import { CLASSIFICATION, treeInOrder, type PlacedTaxon } from "./taxonomy.js";

/**
 * One program's checklist (beeline-024a, Peter 2026-10-26): the names its
 * specimens are identified to, as a Darwin Core archive with Taxon as its
 * core — the shape GBIF calls a checklist dataset. Darwin Core has no Taxon
 * extension to hang off the occurrence archives, so it is a file of its own,
 * and one per program rather than one for the tree, since a checklist says
 * what somebody recorded.
 *
 * A name is on it when one of the program's specimens is identified to it by
 * its determination of record, the identification the occurrence archive
 * carries on the specimen; its ancestors come with it, so the classification
 * is whole. The program's specimens are the ones its yearly archives hold,
 * selected the same way: an atlas's ground, or for Master Melittology the
 * specimens no atlas covers. Its counts are of those specimens, at the name
 * and below it, as /taxonomy counts the whole store's, with how many an
 * expert identified — which volunteer identifications go downstream is the
 * program's call (beeline-pyr) — and the first and last year, by the year the
 * archives use.
 *
 * `taxonID` and `parentNameUsageID` are the store's ids, the same rule as the
 * occurrence archives' `id`: only the sandbox is ever rebuilt, and no file
 * the sandbox writes is published. Ecdysis's view of a name — its id, how it
 * stands there, and the name it files a synonym under — follows as Beeline's
 * own columns rather than as `taxonomicStatus`: the tree is the program's
 * classification, and a name Ecdysis calls a synonym is still the name its
 * specimens carry until somebody decides otherwise.
 *
 * No licence: the programs decide theirs a year at a time
 * (src/program-governance.ts), and a checklist spans every year. No
 * `eml.xml`, as with the yearly archives.
 */

/** The Taxon columns meta.xml declares, after `taxonID`, which is also the archive's `id`. */
export const CHECKLIST_DWC_COLUMNS = [
  "parentNameUsageID",
  "scientificName",
  "scientificNameAuthorship",
  "taxonRank",
  ...CLASSIFICATION,
] as const;

/** Beeline's own, with no term. */
export const CHECKLIST_OWN_COLUMNS = [
  "ecdysisTaxonID",
  "ecdysisStanding",
  "ecdysisAcceptedName",
  "specimens",
  "specimensByExperts",
  "firstYear",
  "lastYear",
] as const;

export interface ChecklistRow extends PlacedTaxon {
  /** The program's specimens identified to this name or below it. */
  programSpecimens: number;
  byExperts: number;
  firstYear: number;
  lastYear: number;
}

/** The names the program's specimens are identified to, with their ancestors, in tree order. */
export async function programChecklist(db: Kysely<Database>, scope: string): Promise<ChecklistRow[]> {
  const inScope = scope === OUTSIDE ? sql`sa.atlas_id IS NULL` : sql`a.code = ${scope}`;
  const counted = await sql<{ entity_id: number; specimens: number | bigint; by_experts: number | bigint; first_year: number; last_year: number }>`
    WITH RECURSIVE recorded AS (
      SELECT d.animal_id, count(*) AS specimens,
             sum(CASE WHEN d.is_expert THEN 1 ELSE 0 END) AS by_experts,
             min(extract(year FROM s.date_start)) AS first_year,
             max(extract(year FROM s.date_start)) AS last_year
      FROM determination_of_record d
      JOIN specimen sp ON sp.entity_id = d.specimen_id
      JOIN sample s ON s.entity_id = sp.sample_id
      LEFT JOIN sample_atlas sa ON sa.sample_id = s.entity_id
      LEFT JOIN atlas a ON a.entity_id = sa.atlas_id
      WHERE (${inScope})
      GROUP BY d.animal_id
    ),
    up(animal_id, ancestor, depth) AS (
      SELECT animal_id, animal_id, 0 FROM recorded
      UNION ALL
      SELECT up.animal_id, a.parent_id, up.depth + 1
      FROM up JOIN animal a ON a.entity_id = up.ancestor
      WHERE a.parent_id IS NOT NULL AND up.depth < 32
    )
    SELECT up.ancestor AS entity_id, sum(r.specimens) AS specimens, sum(r.by_experts) AS by_experts,
           min(r.first_year) AS first_year, max(r.last_year) AS last_year
    FROM up JOIN recorded r ON r.animal_id = up.animal_id
    GROUP BY up.ancestor
  `.execute(db);
  const byId = new Map(counted.rows.map((r) => [Number(r.entity_id), r]));
  return (await treeInOrder(db)).flatMap((taxon) => {
    const count = byId.get(taxon.entity_id);
    if (count === undefined) return [];
    return [
      {
        ...taxon,
        programSpecimens: Number(count.specimens),
        byExperts: Number(count.by_experts),
        firstYear: Number(count.first_year),
        lastYear: Number(count.last_year),
      },
    ];
  });
}

/** The descriptor: one core file, Taxon rows, `taxonID` declared on the id column. */
export const checklistMetaXml = () => `<?xml version="1.0" encoding="UTF-8"?>
<archive xmlns="http://rs.tdwg.org/dwc/text/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://rs.tdwg.org/dwc/text/ http://rs.tdwg.org/dwc/text/tdwg_dwc_text.xsd">
  <core encoding="UTF-8" fieldsTerminatedBy="\\t" linesTerminatedBy="\\n" fieldsEnclosedBy="" ignoreHeaderLines="1" rowType="${DWC}Taxon">
    <files><location>taxon.txt</location></files>
    <id index="0"/>
    <field index="0" term="${DWC}taxonID"/>
${fields(CHECKLIST_DWC_COLUMNS.map((t) => `${DWC}${t}`))}
    <!-- Columns ${CHECKLIST_DWC_COLUMNS.length + 1} onwards are Beeline's own and have no Darwin Core term: ${CHECKLIST_OWN_COLUMNS.join(", ")}. -->
  </core>
</archive>
`;

/** The archive, whole: a program's checklist is a few hundred names, so it is built in memory rather than streamed. */
export function checklistArchive(rows: readonly ChecklistRow[]): Uint8Array {
  const taxa =
    tabLine(["taxonID", ...CHECKLIST_DWC_COLUMNS, ...CHECKLIST_OWN_COLUMNS]) +
    rows
      .map((r) =>
        tabLine([
          r.entity_id,
          r.parent_id,
          r.scientific_name,
          r.authorship,
          r.rank,
          ...CLASSIFICATION.map((rank) => r.classification[rank]),
          r.ecdysis_tid,
          r.standing,
          r.accepted?.scientific_name ?? null,
          r.programSpecimens,
          r.byExperts,
          r.firstYear,
          r.lastYear,
        ]),
      )
      .join("");
  return zipSync({ "meta.xml": strToU8(checklistMetaXml()), "taxon.txt": strToU8(taxa) }, { level: 6 });
}
