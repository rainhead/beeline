/**
 * Hand-written Kysely types mirroring schema/*.sql — the schema is the .sql
 * files; this file follows them. Tables first, then the derived views
 * (read-only: never insert into a view type).
 */
import type { ColumnType, Generated } from "kysely";

/** BIGINT columns: DuckDB returns bigint; number is accepted on write. */
type BigIntCol = ColumnType<bigint, bigint | number, bigint | number>;
/** TIMESTAMPTZ with DEFAULT now(). */
type Timestamped = ColumnType<Date, Date | string | undefined, Date | string>;

// schema/010_people_atlases.sql

export type Pronouns = "he" | "she" | "they";
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
  pronouns: Pronouns | null;
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

export interface AtlasTable {
  entity_id: Generated<number>;
  code: string;
  name: string;
  inat_place_id: BigIntCol | null;
}

/** Null atlas_id = a region no member atlas covers, which is an answer. */
export interface AtlasRegionTable {
  state_province: string;
  country: string;
  atlas_id: number | null;
}

// schema/private/010_auth.sql — the attached private store (ADR 0003)

export interface InatOauthTokenTable {
  inat_user_id: BigIntCol;
  login: string;
  icon_url: string | null;
  access_token: string;
  created_at: Generated<Date>;
  last_login_at: Generated<Date>;
}

export interface SessionTable {
  id: string;
  person_id: number;
  created_at: Generated<Date>;
  last_seen_at: Generated<Date>;
}

// schema/020_animal.sql

export interface AnimalTable {
  entity_id: Generated<number>;
  parent_id: number | null;
  rank: string;
  scientific_name: string;
  authorship: string | null;
}

// schema/030_samples_specimens.sql

export type SampleKind = "net" | "trap";
export type Geoprivacy = "obscured" | "private";
export type LocationSource = "inat_trusted" | "inat_public" | "legacy_import" | "staff_entry";

export interface SampleTable {
  entity_id: Generated<number>;
  kind: SampleKind;
  collector_id: number;
  atlas_id: number | null;
  atlas_assigned_by: number | null;
  sample_number: string;
  date_start: ColumnType<Date, Date | string, Date | string>;
  date_end: ColumnType<Date, Date | string, Date | string>;
  specimen_count: Generated<number>;
  inat_observation_id: BigIntCol | null;
  host_inat_taxon_id: BigIntCol | null;
  host_name_as_observed: string | null;
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

/** schema/170: what the derive job looks at — never derived, or stale. */
export interface SampleElevationPendingView {
  sample_id: number;
  latitude: number;
  longitude: number;
}

export interface SampleCollectorTable {
  sample_id: number;
  person_id: number;
  /** 1-based; position 1 is the sample's collector_id. */
  position: number;
}

export interface SpecimenTable {
  entity_id: Generated<number>;
  sample_id: number;
  specimen_number: number;
  field_number: string | null;
  created_at: Timestamped;
}

// schema/040_determinations.sql

export type DeterminationChannel = "in_app" | "ecdysis_import" | "legacy_import";

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
  recorded_at: Timestamped;
  notes: string | null;
}

// schema/050_qc.sql

export type QcSeverity = "blocking" | "warning";

export interface QcRuleTable {
  name: string;
  severity: QcSeverity;
  instructions: string;
}

export interface SamplePromotionFindingTable {
  sample_id: number;
  rule_name: string;
  details: string;
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
}

/** One row: when the current collecting season began (1 March). */
export interface SeasonView {
  started_on: Date;
}

/** Samples from a closed season — still flagged and still editable, just not asking. */
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

export interface Database {
  schema_migration: SchemaMigrationTable;
  person: PersonTable;
  inat_account: InatAccountTable;
  person_orcid: PersonOrcidTable;
  person_membership: PersonMembershipTable;
  person_admin: PersonAdminTable;
  person_delegate: PersonDelegateTable;
  atlas: AtlasTable;
  atlas_region: AtlasRegionTable;
  animal: AnimalTable;
  sample: SampleTable;
  elevation_source: ElevationSourceTable;
  sample_location: SampleLocationTable;
  sample_collector: SampleCollectorTable;
  specimen: SpecimenTable;
  determination: DeterminationTable;
  qc_rule: QcRuleTable;
  sample_promotion_finding: SamplePromotionFindingTable;
  sync_run: SyncRunTable;
  job_run: JobRunTable;
  determination_of_record: DeterminationTable;
  qc_finding: QcFindingView;
  sample_qc_finding: SampleQcFindingView;
  blocking_sample: BlockingSampleView;
  season: SeasonView;
  settled_sample: SettledSampleView;
  sample_elevation_stale: SampleElevationStaleView;
  sample_elevation_pending: SampleElevationPendingView;
  printable_sample: PrintableSampleView;
  pending_print_sample: PendingPrintSampleView;
  // Attached private store (ADR 0003), catalog-qualified:
  "private.inat_oauth_token": InatOauthTokenTable;
  "private.session": SessionTable;
}
