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

export interface PersonTable {
  id: Generated<number>;
  display_name: string;
}

export interface InatAccountTable {
  person_id: number;
  inat_user_id: BigIntCol;
  login: string;
}

export interface AtlasTable {
  id: Generated<number>;
  code: string;
  name: string;
  inat_place_id: BigIntCol | null;
}

// schema/020_animal.sql

export interface AnimalTable {
  id: Generated<number>;
  parent_id: number | null;
  rank: string;
  scientific_name: string;
  authorship: string | null;
}

// schema/030_samples_specimens.sql

export type SampleKind = "net" | "trap";
export type Geoprivacy = "obscured" | "private";
export type LocationSource = "inat_trusted" | "inat_public" | "legacy_private" | "staff_entry";

export interface SampleTable {
  id: Generated<number>;
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
  id: Generated<number>;
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
  source: LocationSource;
}

export interface SpecimenTable {
  id: Generated<number>;
  sample_id: number;
  specimen_number: number;
  catalog_number: string | null;
  created_at: Timestamped;
}

// schema/040_determinations.sql

export type DeterminationChannel = "in_app" | "ecdysis_import" | "legacy_import";

export interface DeterminationTable {
  id: Generated<number>;
  specimen_id: number;
  animal_id: number;
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

// Derived views (schema/1xx) — read-only.

export interface QcFindingView {
  sample_id: number | null;
  specimen_id: number | null;
  rule_name: string;
  details: string | null;
}

export interface PrintableSampleView {
  sample_id: number;
}

export interface Database {
  person: PersonTable;
  inat_account: InatAccountTable;
  atlas: AtlasTable;
  animal: AnimalTable;
  sample: SampleTable;
  elevation_source: ElevationSourceTable;
  sample_location: SampleLocationTable;
  specimen: SpecimenTable;
  determination: DeterminationTable;
  qc_rule: QcRuleTable;
  determination_of_record: DeterminationTable;
  qc_finding: QcFindingView;
  printable_sample: PrintableSampleView;
}
