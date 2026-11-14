-- The common name of each taxon in the cache (beeline-rfkj.2), in its own file
-- after the cache's worklist (schema/112). beeline-rfkj.3 composes on top of
-- it, in files after this one: it resolves a retired host to its current taxon
-- (inat_taxon_current, schema/114) and reads this view's row for that taxon,
-- whose own lineage is the current one, from a copy of this view that the
-- writers keep fresh (plant_common_name_cache, schema/115). So this view never reads
-- inat_taxon_current, and inat_taxon_current must not read this view, or the
-- two would depend on each other.
--
-- The list's names come from schema/111.

-- One row per cached taxon that has a common name: the taxon's own list
-- entry, else iNaturalist's name for Oregon, else the nearest coarser list
-- entry that covers it. An entry covers a taxon when the entry's own taxon is
-- that taxon or one of its ancestors (inat_taxon_ancestor, which includes the
-- taxon at depth 0); the nearest is the lowest depth, and an entry with no
-- usable name does not cover, since it has nothing to say. Two entries at one
-- depth (plant_list_taxon_shared) are settled by scientific name so the answer
-- does not move.
--
-- It reads the taxon's own stored lineage, which for a retired taxon is stale
-- (schema/066): a retired host is resolved to its current taxon first, and
-- this view is read for that taxon, by beeline-rfkj.3 in a later file.
CREATE VIEW plant_taxon_common_name AS
WITH covering AS (
  SELECT a.inat_taxon_id, c.common_name, c.scientific_name, a.depth,
         row_number() OVER (PARTITION BY a.inat_taxon_id ORDER BY a.depth, c.list_key, c.scientific_name) AS place
  FROM inat_taxon_ancestor a
  JOIN plant_list_entry_taxon t ON t.inat_taxon_id = a.ancestor_id
  JOIN plant_list_entry_common_name c ON c.list_key = t.list_key AND c.scientific_name = t.scientific_name
)
-- The list's name wins only for the taxon's own entry. A coarser entry (a
-- genus or a family) names a species only where iNaturalist has no name for
-- it: "mustard" for Sisymbrium altissimum, which iNaturalist calls Tall
-- Tumblemustard, is worse than either (Peter, 2026-11-14).
, chosen AS (
  SELECT taxon.inat_taxon_id, taxon.preferred_common_name, cv.common_name AS list_name, cv.scientific_name, cv.depth,
         cv.common_name IS NOT NULL AND (cv.depth = 0 OR taxon.preferred_common_name IS NULL) AS from_list
  FROM inat_taxon taxon
  LEFT JOIN covering cv ON cv.inat_taxon_id = taxon.inat_taxon_id AND cv.place = 1
)
SELECT inat_taxon_id,
       CASE WHEN from_list THEN list_name ELSE preferred_common_name END AS common_name,
       CASE WHEN from_list THEN 'list' ELSE 'inaturalist' END AS source,
       CASE WHEN from_list THEN scientific_name END AS list_entry,
       CASE WHEN from_list THEN depth END AS list_entry_depth
FROM chosen
WHERE CASE WHEN from_list THEN list_name ELSE preferred_common_name END IS NOT NULL;
COMMENT ON VIEW plant_taxon_common_name IS 'The common name of each cached taxon that has one: the name of the old-Beeline list''s entry for the taxon itself; otherwise iNaturalist''s preferred name for Oregon; otherwise the name of the nearest coarser list entry that covers it (the entry''s taxon is an ancestor; the lowest depth wins), so a genus or family entry names a species only where iNaturalist has no name for it (Peter, 2026-11-14). An entry''s name is the first of those its cell lists; an entry at genus rank or above whose cell lists several names gives none (plant_list_entry_several_names). source says which; list_entry and list_entry_depth say which entry and how far above the taxon it sits (0 is the taxon''s own entry), and are NULL when the name is iNaturalist''s. Reads the taxon''s own stored lineage, so a retired taxon is judged by its stale one; beeline-rfkj.3 reads this view for the retired host''s current taxon instead.';
