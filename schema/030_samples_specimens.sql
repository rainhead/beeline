-- Nullability is a stance (docs/schema-sketch.md): identity fields are
-- NOT NULL — a record without a collector, date, and sample number isn't
-- identifiable as a sample, and stays at the source/staging stage with a
-- finding there. Descriptive fields are nullable because completeness is QC's
-- job, not the schema's.

CREATE TABLE sample (
  entity_id          INTEGER PRIMARY KEY DEFAULT nextval('entity_id_seq'),
  kind               TEXT NOT NULL CHECK (kind IN ('net', 'trap')),
  collector_id       INTEGER NOT NULL REFERENCES person(entity_id),
  atlas_id           INTEGER REFERENCES atlas(entity_id),
  atlas_assigned_by  INTEGER REFERENCES person(entity_id),
  sample_number      TEXT NOT NULL,
  date_start         DATE NOT NULL,
  date_end           DATE NOT NULL,
  specimen_count     INTEGER NOT NULL DEFAULT 0 CHECK (specimen_count >= 0),
  inat_observation_id BIGINT,
  host_inat_taxon_id BIGINT,
  host_name_as_observed TEXT,
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
COMMENT ON TABLE sample IS 'The collecting event that yields specimens: one collector, one place, one floral host (or none), one day (net) or date range (trap). Coordinates live in sample_location — and only believed-true ones; deliberately-shifted (geoprivacy-obscured) coordinates never enter the sample layer, remaining verbatim in the ingestion staging/observation history.';
COMMENT ON COLUMN sample.atlas_assigned_by IS 'Null ⇒ assigned by geography; set ⇒ explicit administrative assignment (border ambiguity, out-of-region collecting).';
COMMENT ON COLUMN sample.sample_number IS 'Per collector per day for net (''3''); trap series numbers (''OBAS-00657'') for trap.';
COMMENT ON COLUMN sample.specimen_count IS 'The working count: free to move up or down until printing freezes specimens.';
COMMENT ON COLUMN sample.geoprivacy IS 'The observer''s own iNat geoprivacy setting — a fact about the source, kept because it drives QC and reads. Both flags blank ⇒ open coordinates.';
COMMENT ON COLUMN sample.taxon_geoprivacy IS 'iNat taxon-driven obscuring. Whether an atlas may reveal true coordinates of taxon-obscured records is per-atlas, open, and a go-live blocker (docs/questions.md).';
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
COMMENT ON TABLE sample_collector IS 'Everyone who collected a sample, in order — including the primary collector at position 1. Sample.collector_id stays the primary (whose sample numbering it is); this table is what "my samples" and label attribution read, so a second collector is not invisible.';
COMMENT ON COLUMN sample_collector.position IS 'Darwin Core recordedBy order, 1-based. Position 1 is sample.collector_id — an invariant promotion maintains, not a constraint the engine can express.';

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
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sample_id, specimen_number)
);
COMMENT ON TABLE specimen IS 'One physical insect. Specimens are individuated by printing: until a print run freezes, a sample has only specimen_count. Historical ingestion also lands here — production is 99.9997% printed.';
COMMENT ON COLUMN specimen.specimen_number IS '1..N within the sample at freeze time.';
COMMENT ON COLUMN specimen.field_number IS 'The number Beeline issues and prints on the label (CONTEXT.md, beeline-nfo) — never the museum''s catalog number, which arrives from Ecdysis with its institutional prefix and gets its own column when import lands. Opaque verbatim text: all four historical identifier eras land here, including the era of duplicates — so no UNIQUE. Uniqueness becomes a hard guarantee only for the numbers Beeline itself mints, returning with the printing phase.';
