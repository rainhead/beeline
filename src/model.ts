/**
 * Hand-written Kysely types mirroring schema/*.sql — the schema is the .sql
 * files; this file follows them. Tables first, then the derived views
 * (read-only: never insert into a view type).
 */
import type { ColumnType, Generated } from "kysely";
import type { LocalityBasis } from "./locality-rule.js";

/** BIGINT columns: DuckDB returns bigint; number is accepted on write. */
type BigIntCol = ColumnType<bigint, bigint | number, bigint | number>;
/** TIMESTAMPTZ with DEFAULT now(). */
type Timestamped = ColumnType<Date, Date | string | undefined, Date | string>;

// schema/010_people_atlases.sql

/** A member atlas, or the umbrella program itself with no atlas (beeline-lcl). */
export type MembershipKind = "atlas" | "program";
/**
 * The program-itself answer, wherever it is spelled rather than typed: the
 * overlay's `home_atlas` value, the roster's select, the listings' member
 * filter. One constant because those three have to agree.
 */
export const PROGRAM_MEMBERSHIP: MembershipKind = "program";

export interface PersonTable {
  entity_id: Generated<number>;
  display_name: string;
  given_name: string | null;
  family_name: string | null;
  label_name: string | null;
}

export interface InatAccountTable {
  person_id: number;
  inat_user_id: BigIntCol;
  login: string;
}

export interface PersonOrcidTable {
  person_id: number;
  orcid: string;
}

/** What iNaturalist reports an account has connected (beeline-yaaj). */
export interface InatUserOrcidTable {
  inat_user_id: BigIntCol;
  orcid: string;
  fetched_at: Generated<Date>;
}

export type OrcidSource = "inaturalist" | "staff";

/** schema/103: the iD that credits a person downstream — iNaturalist's, else staff's. */
export interface PersonOrcidOfRecordView {
  person_id: number;
  orcid: string;
  source: OrcidSource;
}

export interface PersonOrcidSharedView {
  orcid: string;
  person_id: number;
  source: OrcidSource;
}

/** Absent = never asked; 'program' = asked, and no member atlas applies. */
export interface PersonMembershipTable {
  person_id: number;
  kind: MembershipKind;
  atlas_id: number | null;
}

export interface PersonAdminTable {
  person_id: number;
  granted_at: Generated<Date>;
  granted_by: string | null;
}

export interface PersonDelegateTable {
  person_id: number;
  acts_for_id: number;
  granted_at: Generated<Date>;
  granted_by: string | null;
}

/** schema/010: a program — each atlas, Master Melittology, the BLM surveys (beeline-7c1). */
export interface ProgramTable {
  entity_id: Generated<number>;
  code: string;
  name: string;
  /** The atlas this program is; null for a program with no region. */
  atlas_id: number | null;
}

/** schema/010: who leads a program — responsibility, never access (beeline-7c1). */
export interface ProgramLeadTable {
  program_id: number;
  person_id: number;
  granted_at: Generated<Date>;
  granted_by: string | null;
}

export interface AtlasTable {
  entity_id: Generated<number>;
  code: string;
  name: string;
}

/** Atlases that print their own labels; a row is the flag. Empty today. */
export interface AtlasPrintingTable {
  atlas_id: number;
}

/** Atlases whose labels may carry a taxon-obscured record's true point; a row is the answer. */
export interface AtlasTaxonObscuredPrintingTable {
  atlas_id: number;
  decided_by: string;
  decided_on: ColumnType<Date, Date | string, Date | string>;
  source: string;
}

/** Null atlas_id = a region no member atlas covers, which is an answer. */
export interface AtlasRegionTable {
  state_province: string;
  country: string;
  atlas_id: number | null;
  /** The region's iNat place — the only route from an observation to a state. */
  inat_place_id: BigIntCol | null;
}

// schema/065_places.sql

export interface InatPlaceTable {
  inat_place_id: BigIntCol;
  name: string;
  /** 0 country, 10 state/province, 20 county; null for the ecoregions and
   *  user-drawn places that make up most of an observation's place_ids. */
  admin_level: number | null;
  ancestor_place_ids: BigIntCol[] | null;
  fetched_at: Generated<Date>;
}

/** Place ids iNat was asked for and did not return: merged or deleted
 *  upstream while an observation still names them. Subtracted from
 *  inat_place_uncached so the fetcher stops re-asking (beeline-0oj). */
export interface InatPlaceAbsentTable {
  inat_place_id: BigIntCol;
  asked_at: Generated<Date>;
}

// schema/private/010_auth.sql — the attached private store (ADR 0003)

export interface InatSignInTable {
  inat_user_id: BigIntCol;
  login: string;
  icon_url: string | null;
  created_at: Generated<Date>;
  last_login_at: Generated<Date>;
}

export interface SessionTable {
  id: string;
  /** Who signed in — stable across a rebuild, unlike an entity_id (beeline-ten). */
  inat_user_id: BigIntCol;
  created_at: Generated<Date>;
  last_seen_at: Generated<Date>;
}

// schema/private/030_activity.sql

/**
 * When somebody was last here, outliving the session that observed it —
 * destroying sessions is a normal part of auth and used to age the roster's
 * "Last seen" silently (beeline-dji).
 */
export interface PersonActivityTable {
  inat_user_id: BigIntCol;
  last_seen_at: Generated<Date>;
}

/**
 * schema/private/040: each time a staff member viewed Beeline as somebody
 * else (beeline-jjt). Append-only; an audit line, never a credential.
 */
export interface ImpersonationTable {
  admin_login: string;
  person_name: string;
  started_at: Generated<Date>;
}

// schema/020_animal.sql

/** schema/020: the ranks animal.rank may take, in order. */
export interface AnimalRankTable {
  rank: string;
  /** Deeper is larger, gapped by 10. Compare, never display. */
  ordinal: number;
  italic: boolean;
}

/**
 * schema/116: a sample whose primary collector is not well-defined — no
 * position-1 row in its collector list (0), or more than one (2+). The
 * middle arm of the old mismatch view died with sample.collector_id
 * (beeline-6e9): the fact is written once now, so nothing is left to
 * disagree.
 */
export interface SamplePrimaryCollectorInvalidView {
  sample_id: number;
  at_position_1: number;
}

/** schema/100: the head of each sample's collector list — whose sample
 *  numbering it is. The one definition of "primary collector" since
 *  sample.collector_id was dropped (beeline-6e9). */
export interface SamplePrimaryCollectorView {
  sample_id: number;
  person_id: number;
}

/** schema/115: a qualifier on a determination too coarse to carry one. */
export interface DeterminationMisplacedQualifierView {
  entity_id: number;
  specimen_id: number;
  qualifier: DeterminationQualifier;
  rank: string;
  scientific_name: string;
}

export interface AnimalTable {
  entity_id: Generated<number>;
  parent_id: number | null;
  rank: string;
  scientific_name: string;
  authorship: string | null;
  /** The Ecdysis taxon id of the name this node matches, or null (animal_ecdysis says why). Derived by ingest/match-ecdysis.sql. */
  ecdysis_tid: BigIntCol | null;
}

// schema/022_animal_curation.sql

export type CurationKind = "addition" | "departure" | "homonym";

/** The program's stated departures from Ecdysis's thesaurus, one per node, each on a taxonomist's word (beeline-45v.1). Replayed from ingest/taxon-curation.csv. */
export interface AnimalCurationTable {
  animal_id: number;
  kind: CurationKind;
  /** Departure: Ecdysis's id for the program's name. Homonym: the id chosen. Null for an addition. */
  ecdysis_tid: BigIntCol | null;
  /** Departure only: what Ecdysis accepted instead when the decision was made. */
  ecdysis_accepted_name: string | null;
  ecdysis_fetched_on: ColumnType<Date, Date | string, Date | string>;
  taxonomist: string;
  decided_on: ColumnType<Date, Date | string, Date | string>;
  reference: string | null;
  reason: string;
}

// schema/025_ecdysis_taxonomy.sql

/** Ecdysis's thesaurus for the insects, at the ranks animal_rank admits, from one fetch (beeline-7gob). */
export interface EcdysisTaxonTable {
  tid: BigIntCol;
  rank: string;
  name: string;
  author: string | null;
  /** accepted is a current name in Ecdysis; synonym one filed under accepted_tid. */
  status: "accepted" | "synonym";
  /** The row itself for an accepted name. */
  accepted_tid: BigIntCol;
  parent_tid: BigIntCol | null;
  /** An accepted name's nearest ancestor at an admitted rank; what adopting a name walks. */
  admitted_parent_tid: BigIntCol | null;
  fetched_on: ColumnType<Date, Date | string, Date | string>;
}

// schema/030_samples_specimens.sql

export type SampleKind = "net" | "trap";
export type Geoprivacy = "obscured" | "private";
export type LocationSource = "inat_trusted" | "inat_public" | "legacy_import" | "staff_entry";

export interface SampleTable {
  entity_id: Generated<number>;
  kind: SampleKind;
  sample_number: string;
  date_start: ColumnType<Date, Date | string, Date | string>;
  date_end: ColumnType<Date, Date | string, Date | string>;
  specimen_count: Generated<number>;
  inat_observation_id: BigIntCol | null;
  host_inat_taxon_id: BigIntCol | null;
  host_name_as_observed: string | null;
  /** Decides whether the name is italicised; the string cannot be read for it. */
  host_rank: string | null;
  geoprivacy: Geoprivacy | null;
  taxon_geoprivacy: Geoprivacy | null;
  country: string | null;
  state_province: string | null;
  county: string | null;
  locality: string | null;
  protocol: string | null;
  sampling_effort: string | null;
}

export interface ElevationSourceTable {
  entity_id: Generated<number>;
  description: string;
  file_name: string | null;
  file_hash: string | null;
}

export interface SampleLocationTable {
  sample_id: number;
  latitude: number;
  longitude: number;
  coordinate_uncertainty_m: number | null;
  elevation_m: number | null;
  elevation_source_id: number | null;
  /** The coordinates the elevation was read at; CHECK-paired with it. */
  elevation_latitude: number | null;
  elevation_longitude: number | null;
  source: LocationSource;
}

/** schema/170: an elevation no longer about the point it sits beside. */
export interface SampleElevationStaleView {
  sample_id: number;
  latitude: number;
  longitude: number;
  elevation_m: number;
  elevation_latitude: number;
  elevation_longitude: number;
}

/** schema/170: how vague a coordinate may be and still deserve an elevation. */
/** schema/120: the coordinate precision a label may carry, and from when (#22). */
export interface CoordinatePrecisionRuleView {
  uncertainty_m: number;
  grandfathered_uncertainty_m: number;
  effective_from: Date;
}

/** schema/120: the limit that applies to one sample, which depends on when it was collected. */
export interface SampleCoordinateLimitView {
  sample_id: number;
  uncertainty_m: number;
}

export interface ElevationDerivationLimitView {
  coordinate_uncertainty_m: number;
}

/** schema/170: an elevation the coordinate beside it cannot support. */
export interface SampleElevationUnsupportableView {
  sample_id: number;
  coordinate_uncertainty_m: number;
  elevation_m: number;
  elevation_source_id: number;
}

/** schema/170: what the derive job looks at — never derived, or stale. */
export interface SampleElevationPendingView {
  sample_id: number;
  latitude: number;
  longitude: number;
}

/** schema/037: the localities named for the sample's coordinates (beeline-7i6, beeline-4hxe), best first; proposals never written into the sample. */
export interface SampleLocalityCandidateTable {
  sample_id: number;
  /** 1 is the best (the suggestion), 2 to 4 the alternatives. */
  rank: number;
  locality: string;
  basis: LocalityBasis;
  /** The point it was named at. */
  latitude: number;
  longitude: number;
  gazetteer_build: string;
  derived_at: Date;
}

/** schema/172: every candidate still about the sample's point. */
export interface SampleLocalityCandidateCurrentView {
  sample_id: number;
  rank: number;
  locality: string;
  basis: LocalityBasis;
  gazetteer_build: string;
  derived_at: Date;
}

/** schema/172: the best candidate (rank 1), where it is still about the sample's point. */
export interface SampleLocalitySuggestionCurrentView {
  sample_id: number;
  locality: string;
  basis: LocalityBasis;
  gazetteer_build: string;
  derived_at: Date;
}

/** schema/038: what kind of area (beeline-9jd4). A county includes a BC regional district. */
export type AreaKind = "wilderness" | "county";

/**
 * schema/038: a named place with an outline, keyed by its source's own id.
 * Reference data, not an entity. Its geometry is left out: nothing in the app
 * reads it, and the driver has no type for it without the spatial extension.
 */
export interface AreaTable {
  source: "wilderness.net" | "census" | "bc-abms";
  source_id: string;
  kind: AreaKind;
  name: string;
  gazetteer_build: string;
}

/** schema/038: the point and build a sample's areas were worked out at. */
export interface SampleAreaDerivationTable {
  sample_id: number;
  latitude: number;
  longitude: number;
  gazetteer_build: string;
  derived_at: Date;
}

/** schema/038: an area a sample's point lies inside. */
export interface SampleAreaTable {
  sample_id: number;
  area_source: string;
  area_source_id: string;
}

/** schema/173: the areas, where they were found at the point the sample has now. */
export interface SampleAreaCurrentView {
  sample_id: number;
  source: string;
  source_id: string;
  kind: AreaKind;
  name: string;
}

export interface SampleCollectorTable {
  sample_id: number;
  person_id: number;
  /** 1-based; position 1 IS the primary collector (beeline-6e9). */
  position: number;
}

/** The atlas a sample files under, as a writable satellite (beeline-6e9).
 *  No row ⇒ outside every member atlas. atlas_id NULL only with assigned_by
 *  set: a human stating "belongs to none". */
export interface SampleAtlasTable {
  sample_id: number;
  atlas_id: number | null;
  assigned_by: number | null;
}

/** A locality staff set, which promotion never overwrites (beeline-649). */
export interface SampleLocalityOverrideTable {
  sample_id: number;
  locality: string;
  /** The merge base: what the observation yielded when this was written. */
  observed_locality: string | null;
  set_by: number | null;
  reason: string | null;
}

/** Coordinates staff set, which promotion never overwrites (beeline-942). */
export interface SampleLocationOverrideTable {
  sample_id: number;
  latitude: number;
  longitude: number;
  coordinate_uncertainty_m: number | null;
  /** The sample_location row as it stood when this was written: the merge base, and what removal restores. */
  observed_latitude: number | null;
  observed_longitude: number | null;
  observed_uncertainty_m: number | null;
  observed_source: LocationSource | null;
  set_by: number | null;
  reason: string | null;
}

/** Where an observation says it was, believed true (schema/105). */
export interface ObservationLocationView {
  inat_id: BigIntCol;
  source: "inat_trusted" | "inat_public";
  latitude: number;
  longitude: number;
  coordinate_uncertainty_m: number | null;
}

export interface SampleLocationOverrideStaleView {
  sample_id: number;
  override_latitude: number;
  override_longitude: number;
  sample_latitude: number | null;
  sample_longitude: number | null;
  source: LocationSource | null;
}

export interface SampleLocationOverrideDivergedView {
  sample_id: number;
  override_latitude: number;
  override_longitude: number;
  observed_latitude: number | null;
  observed_longitude: number | null;
  observation_latitude: number;
  observation_longitude: number;
  observation_uncertainty_m: number | null;
}

export interface SampleLocalityOverrideStaleView {
  sample_id: number;
  override_locality: string;
  sample_locality: string | null;
}

export interface SampleLocalityOverrideDivergedView {
  sample_id: number;
  override_locality: string;
  observed_locality: string | null;
  observation_locality: string | null;
}

export interface SpecimenTable {
  entity_id: Generated<number>;
  sample_id: number;
  specimen_number: number;
  field_number: string | null;
  created_at: Timestamped;
}

// schema/035_print_runs.sql

export interface PrintRunTable {
  entity_id: Generated<number>;
  /** Null = every atlas not in atlas_printing, plus samples outside any atlas. */
  atlas_id: number | null;
  prepared_by: number;
  prepared_at: Timestamped;
  /** The *_by columns after prepared_by are person ids without a foreign key: see schema/035. */
  approved_by: number | null;
  approved_at: Date | null;
  printed_by: number | null;
  printed_at: Date | null;
  mailed_by: number | null;
  mailed_at: Date | null;
  canceled_by: number | null;
  canceled_at: Date | null;
  pdf_sha256: string | null;
  note: string | null;
}

/** One row per number Beeline has minted; the PRIMARY KEY is the guarantee. */
export interface MintedFieldNumberTable {
  field_number: string;
  entity_id: Generated<number>;
  print_run_id: number;
  /** Null = burned: minted for a run that was then canceled. */
  specimen_id: number | null;
  minted_at: Timestamped;
}

/** What went on paper for one specimen in one run: the six rendered strings and the values behind them. */
export interface PrintedLabelTable {
  print_run_id: number;
  specimen_id: number;
  sheet: number;
  cell: number;
  location_text: string;
  coordinates_text: string;
  date_text: string;
  collector_text: string;
  method_text: string;
  number_text: string;
  latitude: number;
  longitude: number;
  elevation_m: number | null;
  date_start: ColumnType<Date, Date | string, Date | string>;
  date_end: ColumnType<Date, Date | string, Date | string>;
  locality: string | null;
  county: string | null;
  state_province: string | null;
  country: string | null;
  warnings: string | null;
}

export type ReprintReason = "never_received" | "damaged" | "data_corrected";

/** A label to print again under its existing number (gh-218). Answered is derived: pending_reprint. */
export interface ReprintRequestTable {
  entity_id: Generated<number>;
  specimen_id: number;
  requested_by: number;
  requested_at: Timestamped;
  /** Optional (Peter, 2026-10-30): a quick choice, or nothing. */
  reason: ReprintReason | null;
  note: string | null;
  /** A person id without a foreign key, as on print_run. */
  withdrawn_by: number | null;
  withdrawn_at: Date | null;
}

// schema/040_determinations.sql

export type DeterminationChannel = "in_app" | "ecdysis_import" | "legacy_import" | "worksheet_import";

/** Open nomenclature: how sure the determiner was. Never sp./spp., which a
 * genus-rank determination already says. */
export type DeterminationQualifier = "cf." | "aff." | "nr.";

export interface DeterminationTable {
  entity_id: Generated<number>;
  specimen_id: number;
  animal_id: number;
  qualifier: DeterminationQualifier | null;
  verbatim_identification: string | null;
  sex: string | null;
  caste: string | null;
  determiner_id: number | null;
  determiner_name: string | null;
  is_expert: boolean;
  channel: DeterminationChannel;
  determined_on: ColumnType<Date | null, Date | string | null, Date | string | null>;
  /** How much of determined_on the source stated; null is the day (beeline-9ut). */
  determined_on_precision: DeterminedOnPrecision | null;
  recorded_at: Timestamped;
  notes: string | null;
}

export type DeterminedOnPrecision = "month" | "year";

/** The Ecdysis identification an imported determination came from (beeline-9ut). */
export interface EcdysisIdentificationTable {
  record_id: string;
  determination_id: number;
  occurrence_id: string | null;
  entered_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  loaded_at: Timestamped;
}

/** The museum's catalog number for a specimen, as Ecdysis reports it (gh-98). */
export interface SpecimenCatalogNumberTable {
  specimen_id: number;
  catalog_number: string;
  occurrence_id: string | null;
  loaded_at: Timestamped;
}

/** The worksheet row an imported volunteer determination came from (beeline-pbk). */
export interface WorksheetDeterminationTable {
  determination_id: number;
  file_id: string;
  file_name: string;
  file_modified_at: ColumnType<Date, Date | string, Date | string>;
  sheet: string;
  row_number: number;
  loaded_at: Timestamped;
}

// schema/045_determination_entry.sql, schema/119 (beeline-bcq)

/** Which taxa record sex as queen/worker/male; the nearest stated ancestor decides. */
export interface AnimalCasteTable {
  rank: string;
  scientific_name: string;
  has_castes: boolean;
}

export type DraftSex = "female" | "male";
export type DraftCaste = "gyne" | "worker" | "drone";

/** A volunteer's entry, changeable until the overnight commit makes it a determination. */
export interface DeterminationDraftTable {
  specimen_id: number;
  determiner_id: number;
  animal_id: number | null;
  sex: DraftSex | null;
  caste: DraftCaste | null;
  updated_at: Timestamped;
}

/** Specimens a person has gathered to name together, in the order added. */
export interface DeterminationBatchTable {
  person_id: number;
  specimen_id: number;
  position: number;
}

export interface SampleSeasonView {
  sample_id: number;
  season: number;
}

export interface AnimalCastesView {
  animal_id: number;
  has_castes: boolean;
}

// schema/050_qc.sql

export type QcSeverity = "blocking" | "warning";

/** Rule metadata; the copy shown with a finding is `qcInstructions` in the message catalog. */
export interface QcRuleTable {
  name: string;
  severity: QcSeverity;
}

export interface SamplePromotionFindingTable {
  sample_id: number;
  rule_name: string;
  details: string;
}

/** A sample staff are holding back from printing (beeline-plu); applied from the sample overlay. */
export interface SampleHoldTable {
  sample_id: number;
  reason: string;
  held_by: number | null;
}

/** The blocking rules no waiver can set aside (beeline-1kb.9). */
export interface QcRuleUnwaivableTable {
  name: string;
}

/** A blocking flag staff judged fine on one sample, in force while the flag still says `finding` (beeline-1kb.9). */
export interface SampleQcWaiverTable {
  sample_id: number;
  rule_name: string;
  finding: string;
  reason: string;
  waived_by: number | null;
  /** Whether the flag still says `finding`, as of the last time the overlay was applied. */
  in_force: boolean;
}

// schema/030_samples_specimens.sql — written by legacy promotion (beeline-0199)
export interface SampleLegacyObservationTable {
  sample_id: number;
  inat_observation_id: BigIntCol;
}

// schema/060_sync.sql

export interface SyncRunTable {
  entity_id: Generated<number>;
  source: string;
  authenticated: boolean;
  window_start: ColumnType<Date, Date | string, Date | string> | null;
  window_end: ColumnType<Date, Date | string, Date | string> | null;
  updated_since: ColumnType<Date, Date | string, Date | string> | null;
  started_at: Timestamped;
  completed_at: ColumnType<Date, Date | string, Date | string> | null;
  /** One observer's observations only: the dashboard's check (beeline-yso). */
  observer_user_id: BigIntCol | null;
  /** Particular observations by id, covering nothing for deletion detection (beeline-7vsw). */
  fetched_by_id: ColumnType<boolean | null, boolean | undefined, boolean>;
}

/**
 * schema/060: the stored form of the projection observation_current_fields
 * defines. Read this rather than the view — the view costs ~200 ms a scan
 * and three QC rules go through it (beeline-2c3.36). Refreshed whole inside
 * the sync run that writes observation_load, and never otherwise.
 */
export interface ObservationFieldTable {
  inat_id: BigIntCol;
  observed_on: ColumnType<Date, Date | string, Date | string> | null;
  latitude: number | null;
  longitude: number | null;
  private_latitude: number | null;
  private_longitude: number | null;
  positional_accuracy: number | null;
  public_positional_accuracy: number | null;
  geoprivacy: string | null;
  taxon_geoprivacy: string | null;
  viewer_trusted: boolean | null;
  user_id: BigIntCol | null;
  user_login: string | null;
  place_guess: string | null;
  host_taxon_id: BigIntCol | null;
  host_taxon_name: string | null;
  /** Null = no taxon, or a load predating ancestor_ids — not "not a plant". */
  host_is_tracheophyte: boolean | null;
  quality_grade: string | null;
  sample_number_raw: string | null;
  specimen_count_raw: string | null;
  /** 'OBA Collection Method': net, pan trap, vane trap, nest block. New
   *  columns go LAST — the refresh inserts positionally (schema/060). */
  collection_method_raw: string | null;
  /** The locality text iNat withholds on a private observation and delivers
   *  to a trusted reader. Preferred over place_guess wherever a locality is
   *  derived; empty across the dev corpus, synced without trust. LAST — the
   *  refresh inserts positionally (schema/060). */
  private_place_guess: string | null;
  /** iNaturalist's rank for the floral host — what italics are derived from. */
  host_taxon_rank: string | null;
  /** The observer's free text (iNat's `description`), verbatim and possibly
   *  containing markup — escaped where it is rendered, never here. Null on
   *  every load synced before beeline-hza: the sync's whitelist is the
   *  projection and never asked for it. LAST — positional (schema/060). */
  notes: string | null;
  /** Whether a sample-number field is attached at all, blank or not — what a
   *  blank sample_number_raw cannot say (beeline-a04). LAST — positional. */
  sample_number_field_attached: boolean | null;
}

/** schema/105: observation_field disagreeing with a fresh shred of the loads. */
export interface ObservationFieldStaleView {
  inat_id: BigIntCol;
}

/** schema/105: an observation whose two sample-number fields disagree. */
export interface ObservationSampleNumberConflictView {
  inat_id: BigIntCol;
  sample_id_value: string | null;
  sample_id_2018_value: string | null;
}

// schema/107_views_place.sql

/** An observation's place_ids resolved to country / state / county. */
export interface ObservationPlaceView {
  inat_id: BigIntCol;
  country_place_id: BigIntCol | null;
  country_name: string | null;
  state_place_id: BigIntCol | null;
  state_name: string | null;
  /** The two-letter code a sample carries; null when atlas_region has no row. */
  state_province: string | null;
  country_code: string | null;
  county_place_id: BigIntCol | null;
  county_name: string | null;
}

/** Two places at one administrative level — the tie observation_place breaks. */
export interface ObservationPlaceAmbiguousView {
  inat_id: BigIntCol;
  admin_level: number;
  places: number;
  names: string;
}

/** The locality a sample minted from an observation carries: the first
 *  comma-separated component of its place_guess that reads like a place name.
 *  Absent for an observation with no such component — the sample it mints
 *  blocks as missing_required_field, which the volunteer fixes upstream. */
export interface ObservationLocalityView {
  inat_id: BigIntCol;
  locality: string;
  /** Which comma-separated component it came from, 1-based. */
  component: number;
}

/** An observation the project's own fields say is a collection record: a
 *  sample number, a positive specimen count, a date. The single definition,
 *  shared by minting and by the unclaimed screen (beeline-e85). */
export interface ObservationSampleCandidateView {
  inat_id: BigIntCol;
  user_id: BigIntCol | null;
  user_login: string | null;
  sample_number: string;
  specimen_count: number;
  observed_on: ColumnType<Date, Date | string, Date | string>;
}

/** An observation naming a sample number that cannot become a sample. */
export interface ObservationSampleUnusableView {
  inat_id: BigIntCol;
  user_id: BigIntCol | null;
  user_login: string | null;
  observed_on: ColumnType<Date, Date | string, Date | string> | null;
  sample_number_raw: string | null;
  specimen_count_raw: string | null;
  reason: string;
}

/** A collection record whose observer the store holds no account for.
 *  Nothing mints it; beeline-e85's unclaimed screen reads this. */
export interface ObservationSampleUnresolvedView {
  inat_id: BigIntCol;
  user_id: BigIntCol | null;
  user_login: string | null;
  sample_number: string;
  specimen_count: number;
  observed_on: ColumnType<Date, Date | string, Date | string>;
}

/** An unresolved record with the program whose region it fell in (beeline-e85). */
export interface UnclaimedRecordView extends ObservationSampleUnresolvedView {
  state_province: string | null;
  county_name: string | null;
  program_id: number;
  program_code: string;
}

/** Unlinked collection records grouped into the sample each belongs to. */
export interface SampleMintGroupView {
  person_id: number;
  sample_number: string;
  observed_on: ColumnType<Date, Date | string, Date | string>;
  observations: number;
  lead_inat_id: BigIntCol;
  specimen_count: number;
}

/** A group against the existing sample it is already recorded as. */
export interface SampleMintMatchView {
  person_id: number;
  sample_number: string;
  observed_on: ColumnType<Date, Date | string, Date | string>;
  lead_inat_id: BigIntCol;
  sample_id: number;
  inat_observation_id: BigIntCol | null;
}

/** A group matching two or more existing samples: neither linked nor minted.
 *  The alarm on the reconcile, in observation_place_ambiguous's idiom. */
export interface SampleMintAmbiguousView {
  person_id: number;
  sample_number: string;
  observed_on: ColumnType<Date, Date | string, Date | string>;
  lead_inat_id: BigIntCol;
  samples: number;
  sample_ids: string;
}

/** An existing sample that cites no observation and matches one. */
export interface SampleMintFreeLinkView {
  sample_id: number;
  lead_inat_id: BigIntCol;
  person_id: number;
  sample_number: string;
  observed_on: ColumnType<Date, Date | string, Date | string>;
}

/** What the next mint will create. */
export interface SampleMintPendingView {
  person_id: number;
  sample_number: string;
  observed_on: ColumnType<Date, Date | string, Date | string>;
  observations: number;
  lead_inat_id: BigIntCol;
  specimen_count: number;
}

/** A sample in a member atlas's region with no sample_atlas row: the
 *  worklist the fill-only atlas refresh drains on every promotion
 *  (beeline-6e9 made the assignment writable). */
export interface SampleAtlasUnfilledView {
  sample_id: number;
  state_province: string;
  should_be: number;
}

/** A sample iNaturalist records in several observations. It cites one; this
 *  is what explains a count_mismatch on a printed sample whose count is
 *  right. An unprinted sample's count follows the observation it cites. */
export interface SampleMultiObservationView {
  sample_id: number;
  cited_inat_id: BigIntCol;
  other_observations: number;
  other_specimen_count: number;
}

/** A sample whose cited observation another sample also cites (beeline-15k); shape is the group's. */
export interface SampleSharedObservationView {
  sample_id: number;
  inat_observation_id: BigIntCol;
  samples_sharing: number;
  shape: "different_collectors" | "collector_unknown" | "same_date" | "same_number" | "duplicate" | "other";
}

// schema/109_views_sample_numbering.sql

/** An observation in a sampling project with its sample number left blank, not a sample (beeline-a04). */
export interface ObservationUnnumberedView {
  inat_id: BigIntCol;
  person_id: number;
  user_id: BigIntCol;
  user_login: string | null;
  observed_on: ColumnType<Date, Date | string, Date | string>;
  notes: string | null;
}

/** A number missing from a daily-numbering collector's run on one day (beeline-virz). */
export interface SampleNumberGapView {
  person_id: number;
  collected_on: ColumnType<Date, Date | string, Date | string>;
  season: number;
  sample_number: number;
}

/** A sample whose cited observation now reports a different number or date —
 *  the cost of never rewriting an existing sample, made visible. */
export interface SampleObservationNumberMismatchView {
  sample_id: number;
  inat_observation_id: BigIntCol;
  sample_number: string;
  observation_sample_number: string | null;
  date_start: ColumnType<Date, Date | string, Date | string>;
  date_end: ColumnType<Date, Date | string, Date | string>;
  observed_on: ColumnType<Date, Date | string, Date | string> | null;
  details: string;
}

/** Places an observation names that the cache has never been asked about —
 *  neither cached nor recorded as gone. */
export interface InatPlaceUncachedView {
  inat_place_id: BigIntCol;
}

// schema/070_jobs.sql

export type JobOutcome = "succeeded" | "failed";

export interface JobRunTable {
  entity_id: Generated<number>;
  job_name: string;
  started_at: Timestamped;
  completed_at: ColumnType<Date, Date | string, Date | string> | null;
  outcome: JobOutcome | null;
  detail: string | null;
  sla_breaches: Generated<number>;
}

// schema/000_schema_migration.sql
export interface SchemaMigrationTable {
  name: string;
  applied_at: Generated<Date>;
}

// Derived views (schema/1xx) — read-only.

export interface QcFindingView {
  sample_id: number | null;
  specimen_id: number | null;
  rule_name: string;
  details: string | null;
  /**
   * Set only by the one rule whose detail is a scientific name rather than
   * prose about one, so the view can render it through TaxonName instead of
   * as a machine value (beeline-dys). Rank travels with it because that is
   * what decides italics.
   */
  detail_taxon_name: string | null;
  detail_taxon_rank: string | null;
}

/**
 * Every finding keyed to the sample it belongs to, whether it arrived on the
 * sample or on one of its specimens. The one roll-up both printability and the
 * listings' flag chips read (beeline-2c3.29).
 */
export interface SampleQcFindingView {
  sample_id: number | null;
  specimen_id: number | null;
  rule_name: string;
  details: string | null;
  detail_taxon_name: string | null;
  detail_taxon_rank: string | null;
}

/**
 * One row, about today in Oregon: the current season (this calendar year), and
 * the first day of the oldest active season — last season stays active until
 * 1 March.
 */
export interface SeasonView {
  current_season: number;
  active_since: Date;
}

/** Samples from a settled season — still flagged and still editable, just not asking. */
export interface SettledSampleView {
  sample_id: number;
}

/** Samples carrying a blocking finding, by either route it can arrive on. */
export interface BlockingSampleView {
  sample_id: number;
}

export interface PrintableSampleView {
  sample_id: number;
}

export interface PendingPrintSampleView {
  sample_id: number;
  /** Labels still to come: the working count less the specimens already printed. */
  pending_count: number;
}

// schema/155_views_print_run.sql

export type PrintRunState = "prepared" | "approved" | "printed" | "mailed" | "canceled";

export interface PrintRunStateView {
  print_run_id: number;
  state: PrintRunState;
  label_count: number;
  sheet_count: number;
  sample_count: number;
  collector_count: number;
  /** Of label_count, how many are reprints (printed_label_reprint). */
  reprint_count: number;
}

/** Labels whose run did not mint the number they carry: reprints. */
export interface PrintedLabelReprintView {
  print_run_id: number;
  specimen_id: number;
}

/** Reprint requests not withdrawn and not yet taken by an uncanceled run; printable_reprint and print_scope_reprint narrow it. */
export interface PendingReprintView {
  reprint_request_id: number;
  specimen_id: number;
  sample_id: number;
  requested_by: number;
  requested_at: Date;
  reason: ReprintReason | null;
  note: string | null;
}

/** The pending samples an unscoped run freezes. */
export interface PrintScopeSampleView {
  sample_id: number;
  pending_count: number;
}

/** Samples with a label on paper: locked against upstream date, locality and coordinates. */
export interface PrintedSampleView {
  sample_id: number;
}

/** Per sample with labels in a live, unmailed run: still printing, or printed and not yet mailed. */
export interface SampleLabelInProgressView {
  sample_id: number;
  printing_count: number;
  printed_count: number;
  printed_at: Date | null;
}

export interface SpecimenLabelView {
  specimen_id: number;
  print_run_id: number;
  sheet: number;
  cell: number;
  number_text: string;
  state: PrintRunState;
  prepared_at: Date;
  approved_at: Date | null;
  printed_at: Date | null;
  mailed_at: Date | null;
  canceled_at: Date | null;
  /** The run did not mint this number: a reprint. */
  reprint: boolean;
}

export interface SpecimenMintedFieldNumberView {
  specimen_id: number;
  field_number: string;
  print_run_id: number;
  minted_at: Date;
}

export interface SpecimenFieldNumberStaleView {
  specimen_id: number;
  carried: string | null;
  minted: string;
}

export interface MintedFieldNumberCollisionView {
  field_number: string;
  minted_for: number | null;
  also_on: number;
}

// schema/118_views_animal_ecdysis.sql

export type AnimalEcdysisStanding = "accepted" | "synonym" | "homonym" | "absent" | "not loaded";

export interface AnimalEcdysisMatchView {
  entity_id: number;
  status: "accepted" | "synonym";
  candidates: bigint;
  tid: bigint | null;
}

export interface AnimalEcdysisView {
  entity_id: number;
  rank: string;
  scientific_name: string;
  ecdysis_tid: bigint | null;
  standing: AnimalEcdysisStanding;
  /** For a synonym, the name Ecdysis files it under. */
  accepted_name: string | null;
}

/** Curation rows the loaded thesaurus has moved from under (schema/118). */
export interface AnimalCurationStaleView {
  animal_id: number;
  rank: string;
  scientific_name: string;
  kind: CurationKind;
  ecdysis_fetched_on: Date;
  fetched_on: Date;
  problem: string;
}

export interface AnimalEcdysisStaleView {
  entity_id: number;
  rank: string;
  scientific_name: string;
  ecdysis_tid: bigint | null;
  matched_tid: bigint | null;
}

export interface Database {
  schema_migration: SchemaMigrationTable;
  person: PersonTable;
  inat_account: InatAccountTable;
  person_orcid: PersonOrcidTable;
  inat_user_orcid: InatUserOrcidTable;
  person_orcid_of_record: PersonOrcidOfRecordView;
  person_orcid_shared: PersonOrcidSharedView;
  person_membership: PersonMembershipTable;
  person_admin: PersonAdminTable;
  person_delegate: PersonDelegateTable;
  program: ProgramTable;
  program_lead: ProgramLeadTable;
  atlas: AtlasTable;
  atlas_printing: AtlasPrintingTable;
  atlas_taxon_obscured_printing: AtlasTaxonObscuredPrintingTable;
  atlas_region: AtlasRegionTable;
  animal: AnimalTable;
  animal_curation: AnimalCurationTable;
  ecdysis_taxon: EcdysisTaxonTable;
  sample: SampleTable;
  elevation_source: ElevationSourceTable;
  sample_location: SampleLocationTable;
  sample_locality_candidate: SampleLocalityCandidateTable;
  area: AreaTable;
  sample_area_derivation: SampleAreaDerivationTable;
  sample_area: SampleAreaTable;
  sample_collector: SampleCollectorTable;
  specimen: SpecimenTable;
  determination: DeterminationTable;
  ecdysis_identification: EcdysisIdentificationTable;
  specimen_catalog_number: SpecimenCatalogNumberTable;
  worksheet_determination: WorksheetDeterminationTable;
  animal_caste: AnimalCasteTable;
  determination_draft: DeterminationDraftTable;
  determination_batch: DeterminationBatchTable;
  animal_castes: AnimalCastesView;
  sample_season: SampleSeasonView;
  qc_rule: QcRuleTable;
  sample_promotion_finding: SamplePromotionFindingTable;
  sample_hold: SampleHoldTable;
  qc_rule_unwaivable: QcRuleUnwaivableTable;
  sample_qc_waiver: SampleQcWaiverTable;
  sample_legacy_observation: SampleLegacyObservationTable;
  sync_run: SyncRunTable;
  observation_field: ObservationFieldTable;
  job_run: JobRunTable;
  determination_of_record: DeterminationTable;
  qc_finding: QcFindingView;
  sample_qc_finding: SampleQcFindingView;
  blocking_sample: BlockingSampleView;
  season: SeasonView;
  settled_sample: SettledSampleView;
  animal_rank: AnimalRankTable;
  determination_misplaced_qualifier: DeterminationMisplacedQualifierView;
  sample_primary_collector: SamplePrimaryCollectorView;
  sample_primary_collector_invalid: SamplePrimaryCollectorInvalidView;
  sample_atlas: SampleAtlasTable;
  sample_locality_override: SampleLocalityOverrideTable;
  sample_locality_override_stale: SampleLocalityOverrideStaleView;
  sample_locality_override_diverged: SampleLocalityOverrideDivergedView;
  sample_location_override: SampleLocationOverrideTable;
  sample_location_override_stale: SampleLocationOverrideStaleView;
  sample_location_override_diverged: SampleLocationOverrideDivergedView;
  observation_location: ObservationLocationView;
  elevation_derivation_limit: ElevationDerivationLimitView;
  coordinate_precision_rule: CoordinatePrecisionRuleView;
  sample_coordinate_limit: SampleCoordinateLimitView;
  observation_locality: ObservationLocalityView;
  observation_sample_candidate: ObservationSampleCandidateView;
  observation_sample_unusable: ObservationSampleUnusableView;
  observation_sample_unresolved: ObservationSampleUnresolvedView;
  unclaimed_record: UnclaimedRecordView;
  sample_mint_group: SampleMintGroupView;
  sample_mint_match: SampleMintMatchView;
  sample_mint_ambiguous: SampleMintAmbiguousView;
  sample_mint_free_link: SampleMintFreeLinkView;
  sample_mint_pending: SampleMintPendingView;
  sample_atlas_unfilled: SampleAtlasUnfilledView;
  sample_multi_observation: SampleMultiObservationView;
  sample_shared_observation: SampleSharedObservationView;
  sample_observation_number_mismatch: SampleObservationNumberMismatchView;
  observation_unnumbered: ObservationUnnumberedView;
  sample_number_gap: SampleNumberGapView;
  sample_elevation_unsupportable: SampleElevationUnsupportableView;
  sample_elevation_stale: SampleElevationStaleView;
  sample_elevation_pending: SampleElevationPendingView;
  sample_locality_candidate_current: SampleLocalityCandidateCurrentView;
  sample_locality_suggestion_current: SampleLocalitySuggestionCurrentView;
  sample_area_current: SampleAreaCurrentView;
  printable_sample: PrintableSampleView;
  pending_print_sample: PendingPrintSampleView;
  print_run: PrintRunTable;
  minted_field_number: MintedFieldNumberTable;
  printed_label: PrintedLabelTable;
  reprint_request: ReprintRequestTable;
  printed_label_reprint: PrintedLabelReprintView;
  pending_reprint: PendingReprintView;
  printable_reprint: PendingReprintView;
  print_scope_reprint: PendingReprintView;
  print_run_state: PrintRunStateView;
  print_scope_sample: PrintScopeSampleView;
  printed_sample: PrintedSampleView;
  specimen_label: SpecimenLabelView;
  sample_label_in_progress: SampleLabelInProgressView;
  specimen_minted_field_number: SpecimenMintedFieldNumberView;
  specimen_field_number_stale: SpecimenFieldNumberStaleView;
  minted_field_number_collision: MintedFieldNumberCollisionView;
  observation_field_stale: ObservationFieldStaleView;
  observation_sample_number_conflict: ObservationSampleNumberConflictView;
  inat_place: InatPlaceTable;
  inat_place_absent: InatPlaceAbsentTable;
  observation_place: ObservationPlaceView;
  observation_place_ambiguous: ObservationPlaceAmbiguousView;
  inat_place_uncached: InatPlaceUncachedView;
  animal_ecdysis: AnimalEcdysisView;
  animal_ecdysis_match: AnimalEcdysisMatchView;
  animal_ecdysis_stale: AnimalEcdysisStaleView;
  animal_curation_stale: AnimalCurationStaleView;
  // Attached private store (ADR 0003), catalog-qualified:
  "private.inat_sign_in": InatSignInTable;
  "private.session": SessionTable;
  "private.person_activity": PersonActivityTable;
  "private.impersonation": ImpersonationTable;
}
