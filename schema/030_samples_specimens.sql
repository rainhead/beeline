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
COMMENT ON COLUMN sample.geoprivacy IS 'The observer''s own iNat geoprivacy setting — a fact about the source, kept because it drives QC and reads. Both flags blank ⇒ open coordinates. On a linked sample this and taxon_geoprivacy are a copy of observation_field, rewritten by every observation promotion and by nothing else; sample_geoprivacy_stale (schema/105) names a copy left behind.';
COMMENT ON COLUMN sample.taxon_geoprivacy IS 'iNat taxon-driven obscuring: in this program, a host plant iNaturalist treats as rare. Whether its true coordinates may print is each atlas''s answer (atlas_taxon_obscured_printing); until the atlas gives one the sample does not print (docs/questions.md).';
COMMENT ON COLUMN sample.host_rank IS 'The rank host_name_as_observed is at, so the name can be printed correctly: italics are derived from rank and the string cannot be read for it — ''Onagraceae'' (family) and ''Chamaenerion'' (genus) are both one word. From iNaturalist''s taxon.rank where the sample has an observation, and where it does not, from which of the legacy plant columns supplied the name, except that a genus beside a bare epithet, or a binomial typed into the genus column, is a species (ingest/promote-legacy.sql, beeline-32ow). Nullable: the legacy import has hosts whose column is unrecoverable, and an unknown rank prints upright rather than guessing.';
COMMENT ON COLUMN sample.host_inat_taxon_id IS 'Floral host as an iNat taxon reference — hosts never live in the curated animal table. With host_name_as_observed and host_rank it follows the sample''s observation on every promotion, printed or not, while the observation carries a taxon (ingest/mint-samples.sql, beeline-ni5m.7): a label never carries the host, so a later identification is taken. On a sample with no observation it is what the import stated.';
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
  atlas_id    INTEGER REFERENCES program(entity_id),
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

-- A sample somebody entered in Beeline rather than one iNaturalist or the
-- old Beeline supplied (beeline-3vs.2): trap samples, typed into a form by
-- staff or by someone who has handled trap samples before. Present only for
-- those, so its absence is how every older sample reads, and it is what tells
-- an entered sample, which Beeline is the only record of and edits directly,
-- from an imported one, whose corrections go through the corrections overlay.
CREATE TABLE sample_entry (
  sample_id  INTEGER PRIMARY KEY REFERENCES sample(entity_id),
  entered_by INTEGER REFERENCES person(entity_id),
  entered_at TIMESTAMP NOT NULL DEFAULT current_timestamp
);
COMMENT ON TABLE sample_entry IS 'A sample entered in Beeline (beeline-3vs.2), with who entered it and when (UTC). Beeline is the only record of such a sample, so it is edited directly; samples without a row came from iNaturalist or the old Beeline.';
COMMENT ON COLUMN sample_entry.entered_by IS 'The person who entered it, not anyone they were acting for. Null when entered by a staff login that is no person.';

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
COMMENT ON TABLE sample_location IS 'Believed-true coordinates, isolated in their own table: joining them in is a deliberate act, never an accident. Retention of source coordinate pairs (including obscured ones) is unconditional but lives in the staging/observation layer; revelation for taxon-obscured records is each atlas''s answer (atlas_taxon_obscured_printing, docs/questions.md).';
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
-- No occurrenceID. Beeline minted one at the freeze until 2026-10-23; a
-- specimen now gets it from the museum database its record reaches, which
-- Symbiota assigns, and Beeline publishes none of its own (ADR 0008,
-- amended; beeline-1kb.15).
COMMENT ON TABLE specimen IS 'One physical insect. Specimens are individuated by printing: until a print run freezes, a sample has only specimen_count. Historical ingestion also lands here — production is 99.9997% printed.';
COMMENT ON COLUMN specimen.specimen_number IS '1..N within the sample at freeze time.';
COMMENT ON COLUMN specimen.field_number IS 'The number Beeline issues and prints on the label (CONTEXT.md, beeline-nfo) — never the museum''s catalog number, which arrives from Ecdysis with its institutional prefix and gets its own column when import lands. Opaque verbatim text: all four historical identifier eras land here, including the era of duplicates — so no UNIQUE. A number Beeline mints is written here AND as a row in minted_field_number (schema/035), whose PRIMARY KEY is the guarantee (ADR 0008); specimen_field_number_stale (schema/155) checks that the two agree. Not indexed, deliberately: an indexed column on a row a determination references could never be updated (duckdb/duckdb#20246), and a duplicate repair will one day update this one.';

-- Where a specimen physically stands, as a person who looked has said
-- (beeline-fud5): Darwin Core's disposition and occurrenceRemarks, on the
-- specimen, because the exports carry both and nothing else records what
-- became of a pin. It exists for the 2025 season. The old system printed
-- one specimen under two or three numbers, issued one number to collectors
-- in two states, and left some labels unprinted; Andony's inventory of the
-- boxes in the autumn of 2026 wrote a remark on every record it found
-- wanting (docs/research/2025-inventory.md), and src/load-dispositions.ts
-- brings those remarks in, corrected where Beeline's reading differs: a
-- record he called lost whose bee the inventory found under its other number
-- is a surplus label, and the remark goes on the specimen that exists. One
-- row per specimen, replaced by a later load that says something different.
-- The repair of what legacy promotion set aside writes here too, for records
-- of earlier years nobody has looked at the pins of: Andony asked that what
-- is in doubt be said where a taxonomist will read it, rather than wait for
-- somebody to settle it (GitHub #303).
CREATE TABLE specimen_disposition (
  specimen_id INTEGER PRIMARY KEY REFERENCES specimen(entity_id),
  disposition TEXT CHECK (disposition IN ('in collection', 'missing')),
  remarks     TEXT NOT NULL CHECK (remarks <> ''),
  stated_by   TEXT NOT NULL CHECK (stated_by <> ''),
  stated_on   DATE NOT NULL,
  source      TEXT NOT NULL CHECK (source <> ''),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE specimen_disposition IS 'What became of the pin, as a person stated it after looking, or what the old Beeline''s records leave in doubt about it (dwc:disposition, dwc:occurrenceRemarks). Absent for the ordinary specimen nobody has had cause to remark on. Written by pnpm disposition:load from a staff inventory file, and by pnpm legacy:repair-skipped where an old record was placed by an assumption, a specimen printed twice has its identifications under the other number, or another old record shares its numbers but may be a second bee (beeline-iuva); the legacy-format export and the Darwin Core archives carry both columns.';
COMMENT ON COLUMN specimen_disposition.disposition IS 'Darwin Core''s vocabulary, the two values the inventory can say: in collection (a pin with this label is in a box) or missing (no pin, and the record cannot be matched to one). Null where the remark says something else, such as that a label is still to print.';
COMMENT ON COLUMN specimen_disposition.remarks IS 'The remark as stated, or as corrected by the load: the words the exports write as occurrenceRemarks.';
COMMENT ON COLUMN specimen_disposition.stated_by IS 'Who looked: the name given to the load, not a person reference, since the inventory is a file and not an act in Beeline. Beeline itself where the remark was read from the old Beeline''s records and nobody has looked.';
COMMENT ON COLUMN specimen_disposition.stated_on IS 'The date the statement is good for, given to the load: the inventory''s date rather than the load''s. For a remark read from the old Beeline''s records, the day the repair wrote it.';
COMMENT ON COLUMN specimen_disposition.source IS 'The file the remark was read from, by name, or the command that read it from the old Beeline''s records; pnpm disposition:load holds a row rather than replace a remark of that command''s.';

-- Which iNaturalist observations an imported sample's legacy records came
-- from. Legacy promotion merges records on (collector, sample number, date),
-- and a record carries its observation's URL; only staging can see that a
-- merged sample came from several observations, and staging is not the
-- schema, so promotion writes it down here. One observation per sample is the
-- rule (Peter, 2026-10-04: several observations claiming one sample number is
-- collector error), and sample_claiming_observation (schema/108) reads this
-- with the iNaturalist side to say when it is broken.
CREATE TABLE sample_legacy_observation (
  sample_id           INTEGER NOT NULL REFERENCES sample(entity_id),
  inat_observation_id BIGINT NOT NULL,
  PRIMARY KEY (sample_id, inat_observation_id)
);
COMMENT ON TABLE sample_legacy_observation IS 'The iNaturalist observations an imported sample''s legacy records named in their URLs, written by legacy promotion because staging is the only place that can see them. More than one row for a sample is a collector error the reference system merged and printed (beeline-0199).';
