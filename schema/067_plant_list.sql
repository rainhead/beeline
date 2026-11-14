-- Old Beeline's plant list, kept in git (ingest/old-beeline-plant-list.csv) and
-- loaded here, and what iNaturalist said about each of its names
-- (beeline-rfkj.2). The list is the program's own spelling of plant names and
-- its own common names; iNaturalist's taxonomy is the plant taxonomy (Peter,
-- 2026-11-13), so each entry is matched to an iNaturalist taxon by name, and
-- the match is worked out when read (schema/111), never stored on the entry.
--
-- STORED ROWS KEEP WHAT THEIR SOURCE SAID. An entry is the file's row as
-- written; a lookup is iNaturalist's answer as it was given. The views
-- resolve them.
--
-- Not entities (ADR 0002): nothing anchors on an entry. The list is keyed by
-- a name for it and an entry by its scientific name as written, never by row
-- number, so a re-sorted file changes nothing.
--
-- No foreign keys: the loader replaces a list's entries in one transaction.
CREATE TABLE plant_list (
  list_key     TEXT PRIMARY KEY,
  source_file  TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  loaded_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE plant_list IS 'A list of plant names kept in git and loaded into the store (src/load-plant-list.ts), so far one: old Beeline''s, whose entries are in plant_list_entry. content_hash is what the file said when it was loaded: the load replaces the entries only when the hash differs.';
COMMENT ON COLUMN plant_list.list_key IS 'A short name for the list that entries are keyed under: old-beeline.';
COMMENT ON COLUMN plant_list.source_file IS 'The file in git the entries were read from, as a path from the repository root.';
COMMENT ON COLUMN plant_list.content_hash IS 'SHA-256 of the file''s bytes at the last load, in hexadecimal.';
COMMENT ON COLUMN plant_list.loaded_at IS 'When the entries were last replaced; not moved by a load that found the file unchanged.';

CREATE TABLE plant_list_entry (
  list_key        TEXT NOT NULL,
  scientific_name TEXT NOT NULL,
  rank            TEXT,
  family          TEXT,
  synonym         TEXT,
  common_name     TEXT,
  PRIMARY KEY (list_key, scientific_name)
);
COMMENT ON TABLE plant_list_entry IS 'One row of a plant list, as the file wrote it: only the columns whose republication is not in question (the names), and an empty cell stored as NULL. Nothing here is corrected: the rank column files families and tribes as genera, and genera as species, and the name is matched to a taxon by its shape instead (plant_list_entry_name).';
COMMENT ON COLUMN plant_list_entry.scientific_name IS 'The name as the list wrote it: a hybrid without its sign (Mentha piperita), and ssp. or var. before an infraspecific epithet. The key within the list.';
COMMENT ON COLUMN plant_list_entry.rank IS 'The list''s Rank column. Unreliable: use plant_list_entry_name.expected_rank.';
COMMENT ON COLUMN plant_list_entry.family IS 'The list''s Family column.';
COMMENT ON COLUMN plant_list_entry.synonym IS 'The list''s Synonym column, other scientific names for the same plant separated by commas. Not read yet: matching a name the list calls a synonym is beeline-rfkj.6.';
COMMENT ON COLUMN plant_list_entry.common_name IS 'The list''s Common_name column: one or several names separated by commas or semicolons, the first being the one shown. Sometimes a placeholder that is no name (Abelia Species, tribe Cardamineae); plant_list_entry_common_name leaves those out.';

-- What iNaturalist answered when asked for a normalised name at an expected
-- rank (src/fetch-plant-names.ts), one row per question, whatever the answer.
-- A name with no row has not been asked yet (plant_name_unlooked).
CREATE TABLE plant_name_lookup (
  name_key      TEXT NOT NULL,
  expected_rank TEXT NOT NULL,
  total_results INTEGER NOT NULL,
  read_in_full  BOOLEAN NOT NULL,
  looked_up_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (name_key, expected_rank)
);
COMMENT ON TABLE plant_name_lookup IS 'A question put to iNaturalist''s taxa search (v1 /taxa, is_active=any, under Plantae) for a normalised name at an expected rank, and when. One row even when the answer was nothing. Filled over the network by src/fetch-plant-names.ts and carried by db:reseed, since nothing in the store can recompute it. Delete a row to ask again.';
COMMENT ON COLUMN plant_name_lookup.name_key IS 'The normalised name that was searched for (plant_name_normal.name_key).';
COMMENT ON COLUMN plant_name_lookup.expected_rank IS 'The rank the name''s shape implies (plant_list_entry_name.expected_rank); the search was restricted to the iNaturalist ranks that stand for it (plant_expected_rank).';
COMMENT ON COLUMN plant_name_lookup.total_results IS 'How many taxa iNaturalist said matched. Every page of 30 is read until the results run out, because a second taxon of the name on a later page is what makes the name ambiguous, up to a cap of pages (read_in_full).';
COMMENT ON COLUMN plant_name_lookup.read_in_full IS 'Whether every page of the answer was read. False when the page cap stopped the reading with results left, so a taxon of the name may be among those not read: plant_name_resolution then gives the name no taxon (too many results) rather than judge it on part of the answer.';
COMMENT ON COLUMN plant_name_lookup.looked_up_at IS 'When iNaturalist answered. A name whose taxon the taxon cache read as retired after this is asked again (plant_name_unlooked).';

CREATE TABLE plant_name_lookup_hit (
  name_key      TEXT NOT NULL,
  expected_rank TEXT NOT NULL,
  inat_taxon_id BIGINT NOT NULL,
  name          TEXT NOT NULL,
  rank          TEXT NOT NULL,
  is_active     BOOLEAN NOT NULL,
  matched_term  TEXT NOT NULL,
  PRIMARY KEY (name_key, expected_rank, inat_taxon_id)
);
COMMENT ON TABLE plant_name_lookup_hit IS 'A taxon iNaturalist returned for a lookup, as it was returned: name and rank as they are today, and matched_term, the name or older name that the search matched. Most hits are not the name asked for (a search for a genus returns its species); plant_name_hit_current keeps the ones that are the name asked for.';
COMMENT ON COLUMN plant_name_lookup_hit.inat_taxon_id IS 'An iNaturalist taxon id; need not be in inat_taxon yet.';
COMMENT ON COLUMN plant_name_lookup_hit.name IS 'The scientific name iNaturalist uses for the taxon today, as it was returned (with the hybrid sign, without var. or ssp.).';
COMMENT ON COLUMN plant_name_lookup_hit.rank IS 'The taxon''s rank as iNaturalist writes it: species, hybrid, subspecies, genus, section and so on.';
COMMENT ON COLUMN plant_name_lookup_hit.is_active IS 'False where iNaturalist had retired the taxon when it answered; the replacements it named are in plant_name_lookup_hit_replacement.';
COMMENT ON COLUMN plant_name_lookup_hit.matched_term IS 'iNaturalist''s matched_term: the name of this taxon, or of an older name of it, that the search matched.';

CREATE TABLE plant_name_lookup_hit_replacement (
  name_key             TEXT NOT NULL,
  expected_rank        TEXT NOT NULL,
  inat_taxon_id        BIGINT NOT NULL,
  replacement_taxon_id BIGINT NOT NULL,
  PRIMARY KEY (name_key, expected_rank, inat_taxon_id, replacement_taxon_id)
);
COMMENT ON TABLE plant_name_lookup_hit_replacement IS 'The current_synonymous_taxon_ids a retired hit carried in the same answer: the taxa it was replaced by, as of the lookup. Kept with the hit so that a lookup says what it found without another request; inat_taxon_replacement (schema/066) is the one that is kept up to date.';
COMMENT ON COLUMN plant_name_lookup_hit_replacement.replacement_taxon_id IS 'An iNaturalist taxon id; need not be in inat_taxon yet.';
