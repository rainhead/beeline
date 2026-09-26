-- Nullability is a stance (docs/schema-sketch.md): identity fields are
-- NOT NULL — a record without a collector, date, and sample number isn't
-- identifiable as a sample, and stays at the source/staging stage with a
-- finding there. Descriptive fields are nullable because completeness is QC's
-- job, not the schema's.

-- No collector column and no atlas column, and that is the fix for a real
-- bug rather than a style choice (beeline-6e9): DuckDB refuses an UPDATE
-- that writes an INDEXED column of a row an incoming foreign key references
-- (duckdb/duckdb#20246, dormant upstream), and every sample is referenced by
-- its sample_collector rows. With collector_id and atlas_id on this table,
-- reassigning a collector or moving a sample between atlases was impossible
-- for every sample in the store, always. So the primary collector is
-- sample_collector position 1 — the fact was already there, written twice —
-- and the atlas lives in sample_atlas below, a satellite nothing references,
-- where both columns stay writable with every foreign key intact.
CREATE TABLE sample (
  entity_id          INTEGER PRIMARY KEY DEFAULT nextval('entity_id_seq'),
  kind               TEXT NOT NULL CHECK (kind IN ('net', 'trap')),
  sample_number      TEXT NOT NULL,
  date_start         DATE NOT NULL,
  date_end           DATE NOT NULL,
  specimen_count     INTEGER NOT NULL DEFAULT 0 CHECK (specimen_count >= 0),
  inat_observation_id BIGINT,
  host_inat_taxon_id BIGINT,
  host_name_as_observed TEXT,
  host_rank          TEXT,
  geoprivacy         TEXT CHECK (geoprivacy IN ('obscured', 'private')),
  taxon_geoprivacy   TEXT CHECK (taxon_geoprivacy IN ('obscured', 'private')),
  country            TEXT,
  state_province     TEXT,
  county             TEXT,
  locality           TEXT,
  protocol           TEXT,
  sampling_effort    TEXT,
  CHECK (date_end >= date_start)
);
COMMENT ON TABLE sample IS 'The collecting event that yields specimens: collectors in sample_collector (position 1 is the primary), atlas in sample_atlas, one place, one floral host (or none), one day (net) or date range (trap). Coordinates live in sample_location — and only believed-true ones; deliberately-shifted (geoprivacy-obscured) coordinates never enter the sample layer, remaining verbatim in the ingestion staging/observation history.';
COMMENT ON COLUMN sample.sample_number IS 'Per collector per day for net (''3''); trap series numbers (''OBAS-00657'') for trap.';
COMMENT ON COLUMN sample.specimen_count IS 'The working count: free to move up or down until printing freezes specimens.';
COMMENT ON COLUMN sample.geoprivacy IS 'The observer''s own iNat geoprivacy setting — a fact about the source, kept because it drives QC and reads. Both flags blank ⇒ open coordinates.';
COMMENT ON COLUMN sample.taxon_geoprivacy IS 'iNat taxon-driven obscuring. Whether an atlas may reveal true coordinates of taxon-obscured records is per-atlas, open, and a go-live blocker (docs/questions.md).';
COMMENT ON COLUMN sample.host_rank IS 'The rank host_name_as_observed is at, so the name can be printed correctly: italics are derived from rank and the string cannot be read for it — ''Onagraceae'' (family) and ''Chamaenerion'' (genus) are both one word. From iNaturalist''s taxon.rank where the sample has an observation, and from which of the legacy plant columns supplied the name where it does not. Nullable: the legacy import has hosts whose column is unrecoverable, and an unknown rank prints upright rather than guessing.';
COMMENT ON COLUMN sample.host_inat_taxon_id IS 'Floral host as an iNat taxon reference — hosts never live in the curated animal table.';
COMMENT ON COLUMN sample.locality IS 'Place text (with country/state_province/county): label text at place-name granularity, ingested private-preferred like the reference implementation.';
COMMENT ON COLUMN sample.protocol IS 'Free text today (''vane trap'', ''6 Vane Traps''); controlled vocabulary pending staff answers (docs/questions.md, Trap sampling q3).';
COMMENT ON COLUMN sample.sampling_effort IS 'Trap-count × trap-days etc., pending staff answers (docs/questions.md, Trap sampling q6).';

-- Collecting is often a pair: two thirds of trap specimens in the legacy data
-- were recorded by two people (a couple running a trap line), and the same
-- people also collect alone — so this is per sample, never a property of a
-- person. The legacy system already wrote them as a Darwin Core list
-- ('Michael O''Loughlin | Dan O''Loughlin' in recordedBy); this is that list,
-- resolved to people and kept in order.
CREATE TABLE sample_collector (
  sample_id INTEGER NOT NULL REFERENCES sample(entity_id),
  person_id INTEGER NOT NULL REFERENCES person(entity_id),
  position  INTEGER NOT NULL CHECK (position >= 1),
  PRIMARY KEY (sample_id, person_id)
);
COMMENT ON TABLE sample_collector IS 'Everyone who collected a sample, in order. Position 1 IS the primary collector — whose sample numbering it is — not a copy of a column elsewhere: sample.collector_id was dropped (beeline-6e9) because a second copy of the same fact needed a view to police it and made the primary unchangeable. This table is what "my samples", label attribution, and every primary-collector read go through.';
COMMENT ON COLUMN sample_collector.position IS 'Darwin Core recordedBy order, 1-based. Exactly one row per sample at position 1 is the invariant — the primary key (sample_id, person_id) cannot express it, so sample_primary_collector_invalid (schema/116) is the check, asserted empty by test.';

-- Which atlas a sample belongs to, as a satellite rather than a column, so
-- that it can be WRITTEN (beeline-6e9): nothing references this table, so its
-- indexed columns stay updatable, where a column on sample was frozen at
-- INSERT by the engine limitation described above. Absence of a row is the
-- ordinary answer — collected where no member atlas reaches — and a row with
-- a NULL atlas is reserved for a human stating that a sample geography would
-- file under an atlas belongs to none: the CHECK admits that state only with
-- assigned_by set, so geography's "no atlas" stays no-row and the two cannot
-- be confused.
CREATE TABLE sample_atlas (
  sample_id   INTEGER PRIMARY KEY REFERENCES sample(entity_id),
  atlas_id    INTEGER REFERENCES atlas(entity_id),
  assigned_by INTEGER REFERENCES person(entity_id),
  CHECK (atlas_id IS NOT NULL OR assigned_by IS NOT NULL)
);
COMMENT ON TABLE sample_atlas IS 'The atlas a sample files under. No row ⇒ no member atlas covers where it was collected (ordinary, what the "outside" scope lists). A satellite of sample so the assignment is writable — beeline-6e9: DuckDB will not update an indexed column on a row an incoming foreign key references, and every sample is referenced.';
COMMENT ON COLUMN sample_atlas.assigned_by IS 'Null ⇒ assigned by geography (atlas_region lookup at promotion, or the fill-only refresh); set ⇒ explicit administrative assignment (border ambiguity, out-of-region collecting), which the refresh never overwrites.';

-- A locality staff have set, standing over whatever the observation says
-- (beeline-649). Until its labels print a sample's locality FOLLOWS its
-- observation on every promotion (ingest/mint-samples.sql), and nobody can
-- edit an iNat-linked sample in the app — so a place name the observation
-- cannot yield had nowhere to go. This is where it goes: a satellite in the
-- shape of sample_atlas, present only where a person has spoken, and the
-- follow rule leaves a sample with a row here alone. The durable record is
-- data/sample-overlay.csv (src/sample-overlay.ts), keyed by observation id
-- because entity_id is a per-store draw a rebuild redraws; this table is
-- what promotion re-derives from it, so a rebuild reproduces the override
-- exactly. observed_locality is the three-way merge's base (ADR 0004): what
-- the observation yielded when the override was written, so a later upstream
-- change is tellable from the one the staffer already saw.
CREATE TABLE sample_locality_override (
  sample_id         INTEGER PRIMARY KEY REFERENCES sample(entity_id),
  locality          TEXT NOT NULL CHECK (locality <> ''),
  observed_locality TEXT,
  set_by            INTEGER REFERENCES person(entity_id),
  reason            TEXT
);
COMMENT ON TABLE sample_locality_override IS 'A locality a staff member set on a sample, which promotion never overwrites: the follow rule (ingest/mint-samples.sql) skips samples with a row here. Re-derived at the end of observation promotion from data/sample-overlay.csv, the durable record; sample.locality is written beside it because every read uses that column, and sample_locality_override_stale asserts the two agree.';
COMMENT ON COLUMN sample_locality_override.observed_locality IS 'What observation_locality yielded when the override was written — the merge base. sample_locality_override_diverged names the overrides whose observation has since moved to a third value.';
COMMENT ON COLUMN sample_locality_override.set_by IS 'Whoever set it, resolved from the overlay row''s author login through inat_account at apply time; null where the login no longer resolves.';

-- Coordinates staff have set, the same shape (beeline-942). Promotion used
-- to rewrite sample_location unconditionally on every run, so a staff
-- override survived until the next nightly and then vanished. A row here
-- holds promotion off that sample; sample_location is written beside it
-- with source 'staff_entry', the provenance every read already carries.
-- The observed_* columns are the merge base: what sample_location held when
-- the override was written, whatever its source, so removing the override
-- can hand the sample back exactly what it had — an imported coordinate as
-- readily as an observation's — and the diverged view can tell an upstream
-- move from the point the staffer already saw.
CREATE TABLE sample_location_override (
  sample_id                INTEGER PRIMARY KEY REFERENCES sample(entity_id),
  latitude                 DOUBLE NOT NULL,
  longitude                DOUBLE NOT NULL,
  coordinate_uncertainty_m INTEGER,
  observed_latitude        DOUBLE,
  observed_longitude       DOUBLE,
  observed_uncertainty_m   INTEGER,
  observed_source          TEXT,
  set_by                   INTEGER REFERENCES person(entity_id),
  reason                   TEXT,
  CHECK (latitude BETWEEN -90 AND 90),
  CHECK (longitude BETWEEN -180 AND 180),
  CHECK (coordinate_uncertainty_m IS NULL OR coordinate_uncertainty_m > 0),
  CHECK ((observed_latitude IS NULL) = (observed_longitude IS NULL)),
  CHECK ((observed_latitude IS NULL) = (observed_source IS NULL))
);
COMMENT ON TABLE sample_location_override IS 'Coordinates a staff member set on a sample, which promotion never overwrites: the location upgrade (ingest/promote-observations.sql) skips samples with a row here. Re-derived at the end of observation promotion from data/sample-overlay.csv; sample_location carries the same point with source staff_entry, and sample_location_override_stale asserts the two agree.';
COMMENT ON COLUMN sample_location_override.observed_latitude IS 'With observed_longitude, observed_uncertainty_m and observed_source: the sample_location row as it stood when the override was written — the merge base, and what removal restores. All null where the sample had no coordinates then.';

-- Where an elevation value came from: the legacy import, or (once Beeline
-- derives its own) a specific DEM tile, identified by name and content hash so
-- a re-derivation against updated data is distinguishable from the original.
CREATE TABLE elevation_source (
  entity_id   INTEGER PRIMARY KEY DEFAULT nextval('entity_id_seq'),
  description TEXT NOT NULL,
  file_name   TEXT,
  file_hash   TEXT
);
COMMENT ON TABLE elevation_source IS 'Provenance for derived elevations. One row per distinct source: the legacy verbatimElevation import, or a DEM tile Beeline read itself.';
COMMENT ON COLUMN elevation_source.file_name IS 'DEM tile file name (e.g. N44_W124_1arc_v3.tif) when derived from one; null for e.g. the legacy import.';
COMMENT ON COLUMN elevation_source.file_hash IS 'Content hash of that file, so the same tile name re-downloaded with different data is a different source.';

-- Where we believe collection happened, and why we believe it. Row present ⇒
-- believed true; row absent ⇒ location unknown (obscured without trust, or
-- source had no coordinates). Never a deliberately-shifted pair: interpreting
-- a coordinate here requires consulting nothing else.
CREATE TABLE sample_location (
  sample_id  INTEGER PRIMARY KEY REFERENCES sample(entity_id),
  latitude   DOUBLE NOT NULL,
  longitude  DOUBLE NOT NULL,
  coordinate_uncertainty_m INTEGER,
  elevation_m INTEGER,
  elevation_source_id INTEGER REFERENCES elevation_source(entity_id),
  elevation_latitude  DOUBLE,
  elevation_longitude DOUBLE,
  source     TEXT NOT NULL CHECK (source IN ('inat_trusted', 'inat_public', 'legacy_import', 'staff_entry')),
  CHECK ((elevation_m IS NULL) = (elevation_source_id IS NULL)),
  CHECK ((elevation_m IS NULL) = (elevation_latitude IS NULL)),
  CHECK ((elevation_latitude IS NULL) = (elevation_longitude IS NULL))
);
COMMENT ON TABLE sample_location IS 'Believed-true coordinates, isolated in their own table: joining them in is a deliberate act, never an accident. Retention of source coordinate pairs (including obscured ones) is unconditional but lives in the staging/observation layer; revelation for taxon-obscured records is the open per-atlas question (docs/questions.md).';
COMMENT ON COLUMN sample_location.coordinate_uncertainty_m IS 'iNat positional_accuracy describes the true location even when public coordinates are obscured — it belongs with the true coordinates.';
COMMENT ON COLUMN sample_location.elevation_latitude IS 'The coordinates the elevation was derived from, so the store can answer whether it is still about this point. Without them, moving latitude/longitude leaves an elevation that is silently about somewhere else and no query can tell — the drift is only visible if every writer remembers to clear it (beeline-x5c).';
COMMENT ON COLUMN sample_location.elevation_longitude IS 'See elevation_latitude. Paired with it by CHECK, and with elevation_m through it: an elevation never exists without the point it describes.';
COMMENT ON COLUMN sample_location.elevation_m IS 'A property of these believed-true coordinates, derived from them (legacy: SRTM 1-arc-second tiles). Always paired with elevation_source_id (CHECK) — an elevation never arrives without provenance. Obscured-untrusted records have no location row and therefore no elevation — the legacy fictional elevations for such records stay in staging.';
COMMENT ON COLUMN sample_location.source IS 'Why we believe it: inat_trusted (private geojson via project trust), inat_public (open observation — public coordinates are true), staff_entry, or legacy_import — production Mongo carries no coordinate provenance at all (the coordinateSource work never merged), so legacy coordinates are printed-on-labels believed-true with unknowable provenance; phase-3 sync can upgrade them.';

-- Specimens are individuated by printing: until a print run freezes, a sample
-- has only specimen_count. Historical ingestion also lands here.
CREATE TABLE specimen (
  entity_id       INTEGER PRIMARY KEY DEFAULT nextval('entity_id_seq'),
  sample_id       INTEGER NOT NULL REFERENCES sample(entity_id),
  specimen_number INTEGER NOT NULL,
  field_number    TEXT,
  occurrence_id   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sample_id, specimen_number)
);
-- A unique index rather than an inline UNIQUE, so the migration that adds the
-- column can enforce the same thing: DuckDB cannot ADD COLUMN with a
-- constraint. Never updated, so the index costs nothing on referenced rows.
CREATE UNIQUE INDEX specimen_occurrence_id_idx ON specimen (occurrence_id);
COMMENT ON TABLE specimen IS 'One physical insect. Specimens are individuated by printing: until a print run freezes, a sample has only specimen_count. Historical ingestion also lands here — production is 99.9997% printed.';
COMMENT ON COLUMN specimen.specimen_number IS '1..N within the sample at freeze time.';
COMMENT ON COLUMN specimen.field_number IS 'The number Beeline issues and prints on the label (CONTEXT.md, beeline-nfo) — never the museum''s catalog number, which arrives from Ecdysis with its institutional prefix and gets its own column when import lands. Opaque verbatim text: all four historical identifier eras land here, including the era of duplicates — so no UNIQUE. A number Beeline mints is written here AND as a row in minted_field_number (schema/035), whose PRIMARY KEY is the guarantee (ADR 0008); specimen_field_number_stale (schema/155) checks that the two agree. Not indexed, deliberately: an indexed column on a row a determination references could never be updated (duckdb/duckdb#20246), and a duplicate repair will one day update this one.';
COMMENT ON COLUMN specimen.occurrence_id IS 'dwc:occurrenceID — the specimen''s permanent identity downstream, minted once by a print run (a UUID v7, generated in src/print-run.ts) and never changed (ADR 0008 §1). NULL on every imported specimen: the legacy corpus''s own occurrenceIDs are not unique (216 values on 598 records, beeline-1kb.14) and are kept in staging until the export phase decides what to publish for them. Nothing reads meaning out of it.';
