-- The common names of the cached taxa, kept (beeline-rfkj.3), so that a page
-- reads one taxon's name in a lookup and not in a recomputation.
--
-- plant_taxon_common_name (schema/114) is the definition, and it is correct,
-- but to say what one taxon is called it first works out which taxon each of
-- the plant list's 1,405 names is (plant_name_resolution, schema/111). That
-- takes about 20 milliseconds whichever taxon is asked about, as long as
-- reading the view whole (measured 2026-11-14 on a copy of production's
-- store), and a record page already takes about 130. Filtering the view to one
-- taxon does not help, because the cost is not in the filtered part.
--
-- So the rows of the view are copied here, and everything that changes what
-- the view says refreshes the copy when it finishes: the boot load of the
-- list (src/load-plant-list.ts), the names job (src/fetch-plant-names.ts) and
-- the nightly step that reads taxa (src/fetch-inat-taxa.ts), through
-- refreshPlantCommonNames (src/plant-common-names.ts). The migration that
-- creates this table does not fill it: the app's boot loads the plant list
-- and refreshes the copy before it serves anything, and a failure of the
-- migration stops a deploy where a failure of the refresh costs only a page
-- its common names until the next refresh.
--
-- The table is in this file, beside the plant list's (schema/067), because it
-- depends on no view; the view that says where it parts from its source is
-- schema/115_view_plant_common_name_stale.sql, after the source.
--
-- A copy of derived rows, so nothing here is kept for its own sake: it is
-- rebuilt from the list, the lookups and the cache, and `db:reseed` need not
-- carry it. plant_common_name_stale (schema/115) lists any taxon where the copy and the
-- view disagree, and is empty when a refresh has run since the last change.
CREATE TABLE plant_common_name_cache (
  inat_taxon_id   BIGINT PRIMARY KEY,
  common_name     TEXT NOT NULL,
  source          TEXT NOT NULL CHECK (source IN ('list', 'inaturalist')),
  list_entry      TEXT,
  list_entry_depth INTEGER,
  refreshed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE plant_common_name_cache IS 'A copy of the rows of plant_taxon_common_name (schema/114), refreshed by refreshPlantCommonNames after anything that changes them (the list''s boot load, the plant-names job, the nightly taxon step), so that reading one taxon''s name is a lookup. Derived, never edited; rebuild it by refreshing. plant_common_name_stale says whether it is out of date.';
COMMENT ON COLUMN plant_common_name_cache.inat_taxon_id IS 'The cached taxon. A taxon with no common name has no row.';
COMMENT ON COLUMN plant_common_name_cache.common_name IS 'plant_taxon_common_name.common_name.';
COMMENT ON COLUMN plant_common_name_cache.source IS 'list or inaturalist: where the name came from.';
COMMENT ON COLUMN plant_common_name_cache.list_entry IS 'The scientific name of the list entry the name came from, when it came from the list.';
COMMENT ON COLUMN plant_common_name_cache.list_entry_depth IS 'How far above the taxon its entry sits; 0 is the taxon''s own entry.';
COMMENT ON COLUMN plant_common_name_cache.refreshed_at IS 'When the copy was last refreshed.';
