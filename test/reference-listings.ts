import { sql, type Kysely } from "kysely";
import { REPRINT_BLOCKER, type ReprintBlocker } from "../src/print-run.js";
import type { Database } from "../src/model.js";
import {
  filteredSamples,
  filteredSpecimens,
  needsRollup,
  observationGone,
  PAGE_SIZE,
  placeColumns,
  sampleOrder,
  specimenOrder,
  withheld,
  type ListingPageOptions,
  type ListingQuery,
  type Reader,
} from "../src/app/listings.js";

/**
 * The rows statements of both listings as they were before the page was chosen first (beeline-amdt.5 and .6): every
 * per-row subquery and joined view computed for every sample or specimen, then the sort and the page. Kept here,
 * unchanged but for its name, as the reference the page-first statements are held equal to row for row, in every
 * column, for every sort and filter (test/listing-page-first.test.ts) and on a real store. Not a thing to call
 * from the app.
 */

const located = <T>(hidden: ReturnType<typeof withheld>, column: ReturnType<typeof sql<T>>) =>
  sql<T | null>`CASE WHEN ${hidden} THEN NULL ELSE ${column} END`;
const blockingCount = sql<number>`coalesce(qc.blocking, 0)`;
const warningCount = sql<number>`coalesce(qc.warning, 0)`;

/** The page's rows as the old statement chose them, before the host's names are looked up. */
export async function referenceSampleRows(
  db: Kysely<Database>,
  query: ListingQuery,
  personId: number,
  reader: Reader,
  opts: ListingPageOptions = {},
) {
  const hidden = withheld(reader);
  const place = placeColumns(reader);
  const base = await filteredSamples(db, query, personId, reader, opts.exact, true, opts.ids);
  const limit = opts.limit ?? PAGE_SIZE;
  const offset = opts.offset ?? (query.page - 1) * PAGE_SIZE;
  return await base
    .leftJoin("sample_location as loc", "loc.sample_id", "s.entity_id")
      .select([
        "s.entity_id as sample_id",
        "s.sample_number",
        "s.kind",
        "s.date_start",
        "s.date_end",
        place.locality.as("locality"),
        place.county.as("county"),
        "s.state_province",
        "s.country",
        "s.protocol",
        "s.sampling_effort",
        sql<number | null>`(SELECT m.trap_count FROM sample_method m WHERE m.sample_id = s.entity_id)`.as("trap_count"),
        "s.specimen_count",
        "s.inat_observation_id",
        observationGone.as("observation_gone"),
        sql<string | null>`coalesce(pab.abbreviation, a.code)`.as("atlas_abbreviation"),
        "s.host_name_as_observed as host_name",
        "s.host_rank",
        "s.host_inat_taxon_id",
        "hnt.inat_taxon_id as host_name_taxon_id",
        located(hidden, sql<number | null>`loc.latitude`).as("latitude"),
        located(hidden, sql<number | null>`loc.longitude`).as("longitude"),
        located(hidden, sql<number | null>`loc.coordinate_uncertainty_m`).as("coordinate_uncertainty_m"),
        located(hidden, sql<number | null>`loc.elevation_m`).as("elevation_m"),
        located(hidden, sql<string | null>`loc.source`).as("location_source"),
        "s.geoprivacy",
        "s.taxon_geoprivacy",
        hidden.as("location_withheld"),
        blockingCount.as("blocking"),
        warningCount.as("warning"),
        sql<string | null>`qc.flag_list`.as("flag_list"),
        sql<boolean>`EXISTS (SELECT 1 FROM sample_collector mine
                             WHERE mine.sample_id = s.entity_id AND mine.person_id = ${personId})`.as("mine"),
        sql<boolean>`EXISTS (SELECT 1 FROM printed_sample ps WHERE ps.sample_id = s.entity_id)`.as("printed"),
        sql<number>`coalesce((SELECT w.waiting FROM sample_labels_waiting w WHERE w.sample_id = s.entity_id), 0)`.as(
          "labels_waiting",
        ),
        located(
          hidden,
          sql<string | null>`(SELECT string_agg(concat(g.locality, chr(9), g.basis), chr(10) ORDER BY g.rank)
                              FROM sample_locality_candidate_current g WHERE g.sample_id = s.entity_id)`,
        ).as("locality_choices"),
        located(
          hidden,
          sql<string | null>`(SELECT ol.locality FROM observation_locality ol WHERE ol.inat_id = s.inat_observation_id)`,
        ).as("observed_locality"),
        sql<boolean>`EXISTS (SELECT 1 FROM sample_locality_override lo
                             WHERE lo.sample_id = s.entity_id AND lo.set_by IS DISTINCT FROM ${personId})`.as(
          "locality_set_by_other",
        ),
        sql<boolean>`EXISTS (SELECT 1 FROM sample_entry e WHERE e.sample_id = s.entity_id)`.as("entered"),
        sql<boolean>`EXISTS (SELECT 1 FROM sample_entry e WHERE e.sample_id = s.entity_id AND e.entered_by = ${personId})`.as(
          "entered_by_me",
        ),
        sql<boolean>`EXISTS (SELECT 1 FROM sample_entry e JOIN settled_sample ss ON ss.sample_id = e.sample_id WHERE e.sample_id = s.entity_id)`.as("entered_settled"),
      ])
      .orderBy(sampleOrder(query, place))
      .orderBy("s.entity_id")
      .limit(limit)
      .offset(offset)
      .execute();
}

/** The page's rows as the old statement chose them, before the host's names are looked up. */
export async function referenceSpecimenRows(
  db: Kysely<Database>,
  query: ListingQuery,
  personId: number,
  reader: Reader,
  opts: ListingPageOptions = {},
) {
  const hidden = withheld(reader);
  const place = placeColumns(reader);
  const base = await filteredSpecimens(db, query, personId, reader, opts.year, opts.exact, needsRollup(query), opts.ids);
  const limit = opts.limit ?? PAGE_SIZE;
  const offset = opts.offset ?? (query.page - 1) * PAGE_SIZE;
  return await base
    .leftJoin("sample_location as loc", "loc.sample_id", "s.entity_id")
      .select([
        "sp.entity_id as specimen_id",
        "sp.specimen_number",
        "sp.field_number",
        sql<boolean>`sp.field_number IS NULL AND EXISTS (SELECT 1 FROM printed_label pl WHERE pl.specimen_id = sp.entity_id)`.as(
          "awaiting_number",
        ),
        sql<boolean>`EXISTS (SELECT 1 FROM pending_reprint pr WHERE pr.specimen_id = sp.entity_id)`.as("reprint_requested"),
        sql<ReprintBlocker | null>`${query.act === "reprint" ? sql.raw(REPRINT_BLOCKER) : sql`CAST(NULL AS TEXT)`}`.as(
          "reprint_blocker",
        ),
        "s.entity_id as sample_id",
        "s.sample_number",
        "s.date_start",
        "s.date_end",
        place.locality.as("locality"),
        place.county.as("county"),
        "s.state_province",
        "s.country",
        "s.protocol",
        "s.kind as sample_kind",
        sql<string | null>`(SELECT c.catalog_number FROM specimen_catalog_number c WHERE c.specimen_id = sp.entity_id)`.as(
          "catalog_number",
        ),
        sql<string | null>`(SELECT sd.disposition FROM specimen_disposition sd WHERE sd.specimen_id = sp.entity_id)`.as("disposition"),
        sql<string | null>`(SELECT sd.remarks FROM specimen_disposition sd WHERE sd.specimen_id = sp.entity_id)`.as(
          "occurrence_remarks",
        ),
        sql<string | null>`coalesce(pab.abbreviation, a.code)`.as("atlas_abbreviation"),
        "s.host_name_as_observed as host_name",
        "s.host_rank",
        "s.host_inat_taxon_id",
        "hnt.inat_taxon_id as host_name_taxon_id",
        "an.entity_id as animal_id",
        "an.rank as taxon_rank",
        "an.scientific_name",
        "an.authorship",
        "d.qualifier",
        "d.verbatim_identification",
        "d.sex",
        "d.caste",
        "d.entity_id as determination_id",
        "d.is_expert",
        "d.determined_on",
        "d.determined_on_precision",
        located(hidden, sql<number | null>`loc.latitude`).as("latitude"),
        located(hidden, sql<number | null>`loc.longitude`).as("longitude"),
        located(hidden, sql<number | null>`loc.coordinate_uncertainty_m`).as("coordinate_uncertainty_m"),
        located(hidden, sql<number | null>`loc.elevation_m`).as("elevation_m"),
        located(hidden, sql<string | null>`loc.source`).as("location_source"),
        "s.geoprivacy",
        "s.taxon_geoprivacy",
        hidden.as("location_withheld"),
        sql<string | null>`coalesce(det.display_name, d.determiner_name)`.as("determiner"),
        "det_orcid.orcid as determiner_orcid",
      ])
      .orderBy(specimenOrder(query, place))
      .orderBy("sp.sample_id")
      .orderBy("sp.specimen_number")
      .limit(limit)
      .offset(offset)
      .execute();
}
