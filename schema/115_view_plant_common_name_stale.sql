-- Where the copy of the common names (plant_common_name_cache, schema/068)
-- parts from the view it copies (plant_taxon_common_name, schema/114).
-- Where the copy differs from the view it copies. Empty when it is fresh.
-- It reads plant_taxon_common_name whole, which takes as long as the refresh,
-- so a page never reads it: a test and an operator do.
CREATE VIEW plant_common_name_stale AS
SELECT inat_taxon_id FROM (
  SELECT inat_taxon_id, common_name, source, list_entry, list_entry_depth FROM plant_taxon_common_name
  EXCEPT
  SELECT inat_taxon_id, common_name, source, list_entry, list_entry_depth FROM plant_common_name_cache
) missing_or_changed
UNION
SELECT inat_taxon_id FROM (
  SELECT inat_taxon_id, common_name, source, list_entry, list_entry_depth FROM plant_common_name_cache
  EXCEPT
  SELECT inat_taxon_id, common_name, source, list_entry, list_entry_depth FROM plant_taxon_common_name
) left_over;
COMMENT ON VIEW plant_common_name_stale IS 'Taxa where plant_common_name_cache disagrees with plant_taxon_common_name: a name missing from the copy, a name it should no longer hold, or a name that changed. Empty when a refresh has run since the last change to the list, the lookups or the cache. Reads the whole view, so it is for tests and for a person checking, not for a page.';
