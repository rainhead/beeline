-- Migration for schema/068, schema/113, schema/114, schema/115 and schema/116: what
-- iNaturalist calls a host today, and its common name (beeline-rfkj.3).
--
-- Views over the taxon cache, a copy of the common names that makes one taxon's name a
-- lookup, and a sample's host as those. plant_taxon_common_name (0093, schema/114) is
-- dropped and made again because it now reads inat_taxon_current, which is made here.
--
-- The copy of the common names (plant_common_name_cache) is made empty and not filled
-- here. The app's boot loads the plant list and refreshes the copy before it serves
-- anything (src/load-plant-list.ts, src/app/main.ts), so nothing reads the table
-- before it is filled; a failure in a migration stops the deploy, where a failure of
-- that refresh is reported and costs a page its common names until the next
-- refresh (the plant-names job and the nightly taxon step both do it).

-- What iNaturalist calls a stored plant taxon today (beeline-rfkj.3), in a file
-- after the cache's worklist (schema/112) and before the common names
-- (schema/114), which read it to follow a list entry's taxon to its current one.
--
-- STORED IDS AND NAMES ARE NEVER REWRITTEN TO FOLLOW iNATURALIST. A sample
-- keeps the host id its observation gave it, and the cache keeps a retired
-- taxon as retired (schema/066). These views read the cache and say what the
-- stored taxon stands for now, when somebody looks.
--
-- inat_taxon_replacement_end and inat_taxon_current read only the cache's own
-- tables (inat_taxon, inat_taxon_replacement, inat_taxon_ancestor,
-- inat_taxon_absent). They must not read the plant list's views (schema/111)
-- or plant_taxon_common_name (schema/114): inat_taxon_uncached reads
-- plant_name_hit_current, so a path back from here would make the two depend
-- on each other. The common name is added in the views after them.

-- The end of each retired taxon's chain of replacements: the taxa that nothing
-- replaces any further. A retired taxon is replaced by one or several taxa,
-- each of which may itself have been retired since, so the chain is followed
-- to its end. The walk keeps each (retired taxon, taxon reached) pair once,
-- so a chain that loops back on itself (a taxon replaced by one that was
-- replaced by it) stops at the pair it has already seen and has no end.
--
-- end_kind says what the end is:
--   active   a taxon iNaturalist has not retired: what the retired one means now
--   retired  a retired taxon with no replacement recorded: a dead end
--   absent   a taxon iNaturalist was asked for and answered without
--            (inat_taxon_absent), whether or not the cache holds a row for it:
--            a dead end, whatever its row says, and the walk goes no further
--   unread   a taxon the cache has not read yet (inat_taxon_uncached lists it),
--            so nobody knows yet whether it was replaced in turn
-- A retired taxon whose replacements are all dead ends has ends of kind
-- retired or absent.
CREATE VIEW inat_taxon_replacement_end AS
WITH RECURSIVE reached(retired_taxon_id, taxon_id) AS (
  SELECT inat_taxon_id, inat_taxon_id FROM inat_taxon WHERE NOT is_active
  UNION
  SELECT w.retired_taxon_id, r.replacement_taxon_id
  FROM reached w
  JOIN inat_taxon t ON t.inat_taxon_id = w.taxon_id AND NOT t.is_active
  LEFT JOIN inat_taxon_absent gone ON gone.inat_taxon_id = w.taxon_id
  JOIN inat_taxon_replacement r ON r.retired_taxon_id = w.taxon_id
  WHERE gone.inat_taxon_id IS NULL
)
SELECT w.retired_taxon_id, w.taxon_id AS end_taxon_id,
       CASE WHEN gone.inat_taxon_id IS NOT NULL THEN 'absent'
            WHEN t.inat_taxon_id IS NULL THEN 'unread'
            WHEN t.is_active THEN 'active'
            ELSE 'retired' END AS end_kind
FROM reached w
LEFT JOIN inat_taxon t ON t.inat_taxon_id = w.taxon_id
LEFT JOIN inat_taxon_absent gone ON gone.inat_taxon_id = w.taxon_id
WHERE gone.inat_taxon_id IS NOT NULL
   OR t.inat_taxon_id IS NULL
   OR t.is_active
   OR NOT EXISTS (SELECT 1 FROM inat_taxon_replacement r WHERE r.retired_taxon_id = w.taxon_id);
COMMENT ON VIEW inat_taxon_replacement_end IS 'The end of each retired cached taxon''s chain of replacements, one row per end: an active taxon (what the retired one means now), a retired taxon with no replacement recorded or a taxon iNaturalist was asked for and did not return (dead ends: retired, absent), or a taxon the cache has not read yet (unread). A split gives several rows. A chain that loops back on itself has no row. Reads only the cache''s tables, never the plant list.';
COMMENT ON COLUMN inat_taxon_replacement_end.retired_taxon_id IS 'The cached taxon iNaturalist has retired, as a sample stores it.';
COMMENT ON COLUMN inat_taxon_replacement_end.end_taxon_id IS 'A taxon at the end of the chain of replacements. The retired taxon itself where nothing replaces it.';
COMMENT ON COLUMN inat_taxon_replacement_end.end_kind IS 'active, retired, absent or unread: see the view.';

-- One row per cached taxon: its standing, and the current taxon it stands for.
--
-- Standing is worked out from the end of the chain and never from whether a
-- row exists:
--   current   iNaturalist has not retired the taxon: it is its own current taxon
--   replaced  retired, and every chain ends at one active taxon: that is the current taxon
--   split     retired and replaced by more than one active taxon (a dead end
--             beside them does not change that): no current taxon, so nothing is picked
--   retired   retired, with no active taxon at the end of any chain, or with
--             one and a dead end beside it, which might be the other half of a
--             split, so nothing is picked
--   pending   retired, and a chain reaches a taxon the cache has not read yet, so
--             the standing is not known until the nightly step has read it
--   absent    iNaturalist was asked for the taxon and answered without it
--             (inat_taxon_absent): deleted upstream, its row kept
-- A taxon that is absent stays absent until a fetch returns it, which removes
-- the row from inat_taxon_absent (src/fetch-inat-taxa.ts). It does not go back
-- to current when the 30 days of inat_taxon_known_absent pass: that rule says
-- when the fetcher asks again, and until it has asked, the last answer is the
-- best there is. A replacement that is absent is a dead end for the same
-- reason, cached or not, so a retired taxon whose replacements are all absent
-- is retired.
-- The current taxon's id, name and rank are those of the active taxon at the end
-- of the chain, and italics follow its rank. Lineage is taken from the current
-- taxon, never from the stored one's own ancestry, which for a retired taxon is
-- stale (schema/066), and an ancestor that is itself retired is passed through
-- the same resolution: it is replaced by what it came to when that is one taxon
-- of the same rank, and is no genus or family otherwise. For a split there is no
-- current taxon, but a genus or a family is given where every active taxon the
-- split came to shares it, so a count by genus can still use it. is_plant and
-- is_vascular say whether the lineage reaches Plantae (47126) and Tracheophyta
-- (211194); for a split, whether every one of them does.
CREATE VIEW inat_taxon_current AS
WITH ends AS (
  SELECT retired_taxon_id AS taxon_id,
         count(*) FILTER (WHERE end_kind = 'active') AS active_ends,
         count(*) FILTER (WHERE end_kind IN ('retired', 'absent')) AS dead_ends,
         count(*) FILTER (WHERE end_kind = 'unread') AS unread_ends
  FROM inat_taxon_replacement_end
  GROUP BY retired_taxon_id
), standing AS (
  SELECT t.inat_taxon_id,
         CASE WHEN gone.inat_taxon_id IS NOT NULL THEN 'absent'
              WHEN t.is_active THEN 'current'
              WHEN coalesce(e.unread_ends, 0) > 0 THEN 'pending'
              WHEN coalesce(e.active_ends, 0) = 1 AND coalesce(e.dead_ends, 0) = 0 THEN 'replaced'
              WHEN coalesce(e.active_ends, 0) >= 2 THEN 'split'
              ELSE 'retired' END AS standing,
         -- A split with a dead end beside it: the dead end may be another half,
         -- so nothing shared is claimed for it, as for one active taxon and a
         -- dead end (retired).
         coalesce(e.active_ends, 0) >= 2 AND coalesce(e.dead_ends, 0) > 0 AS split_beside_dead_end
  FROM inat_taxon t
  LEFT JOIN inat_taxon_absent gone ON gone.inat_taxon_id = t.inat_taxon_id
  LEFT JOIN ends e ON e.taxon_id = t.inat_taxon_id
), heads AS (
  -- Each stored taxon with the active taxa it comes to.
  SELECT inat_taxon_id AS taxon_id, inat_taxon_id AS head_id, standing FROM standing WHERE standing = 'current'
  UNION ALL
  SELECT s.inat_taxon_id, e.end_taxon_id, s.standing
  FROM standing s
  JOIN inat_taxon_replacement_end e ON e.retired_taxon_id = s.inat_taxon_id AND e.end_kind = 'active'
  WHERE s.standing IN ('replaced', 'split')
), single AS (
  -- The taxa that have one current taxon: what an ancestor is resolved with.
  SELECT taxon_id, head_id FROM heads WHERE standing IN ('current', 'replaced')
), lineage AS (
  -- A lineage holds one genus and one family at most, and an ancestor counts
  -- only where it was stored at that rank and resolves to that rank, so the
  -- lowest id is the only one: a retired genus replaced by a family is not
  -- taken for the family. Joins and aggregates rather than a lookup per row: read for one
  -- taxon this costs the same as for all of them, and the aggregates are
  -- cheaper than 5,000 correlated lookups. Only the ancestors stored as a
  -- genus or a family are resolved (a retired genus is stored as a genus), and
  -- Plantae and Tracheophyta are read off the whole lineage separately, so
  -- the join that resolves ancestors carries about three rows per taxon and
  -- not fifteen.
  SELECT h.taxon_id, h.head_id,
         gf.genus_id, gf.family_id,
         coalesce(l.ancestors, 0) AS ancestors, coalesce(l.is_plant, false) AS is_plant, coalesce(l.is_vascular, false) AS is_vascular
  FROM heads h
  LEFT JOIN (SELECT a.inat_taxon_id,
                    min(s.head_id) FILTER (WHERE st.rank = 'genus' AND ct.rank = 'genus') AS genus_id,
                    min(s.head_id) FILTER (WHERE st.rank = 'family' AND ct.rank = 'family') AS family_id
             FROM inat_taxon_ancestor a
             JOIN inat_taxon st ON st.inat_taxon_id = a.ancestor_id AND st.rank IN ('genus', 'family')
             JOIN single s ON s.taxon_id = a.ancestor_id
             JOIN inat_taxon ct ON ct.inat_taxon_id = s.head_id
             GROUP BY a.inat_taxon_id) gf ON gf.inat_taxon_id = h.head_id
  LEFT JOIN (SELECT inat_taxon_id, count(*) AS ancestors,
                    bool_or(ancestor_id = 47126) AS is_plant, bool_or(ancestor_id = 211194) AS is_vascular
             FROM inat_taxon_ancestor GROUP BY inat_taxon_id) l ON l.inat_taxon_id = h.head_id
), shared AS (
  SELECT taxon_id,
         count(*) AS heads,
         min(head_id) AS head_id,
         CASE WHEN count(genus_id) = count(*) AND count(DISTINCT genus_id) = 1 THEN min(genus_id) END AS genus_id,
         CASE WHEN count(family_id) = count(*) AND count(DISTINCT family_id) = 1 THEN min(family_id) END AS family_id,
         CASE WHEN min(ancestors) > 0 THEN bool_and(is_plant) END AS is_plant,
         CASE WHEN min(ancestors) > 0 THEN bool_and(is_vascular) END AS is_vascular
  FROM lineage
  GROUP BY taxon_id
)
SELECT t.inat_taxon_id, st.standing,
       t.name, t.rank,
       c.inat_taxon_id AS current_taxon_id, c.name AS current_name, c.rank AS current_rank,
       g.inat_taxon_id AS genus_taxon_id, g.name AS genus_name,
       f.inat_taxon_id AS family_taxon_id, f.name AS family_name,
       CASE WHEN NOT st.split_beside_dead_end THEN sh.is_plant END AS is_plant,
       CASE WHEN NOT st.split_beside_dead_end THEN sh.is_vascular END AS is_vascular
FROM inat_taxon t
JOIN standing st ON st.inat_taxon_id = t.inat_taxon_id
LEFT JOIN shared sh ON sh.taxon_id = t.inat_taxon_id
-- A split has no current taxon: nothing is picked among its heads.
LEFT JOIN inat_taxon c ON c.inat_taxon_id = sh.head_id AND st.standing IN ('current', 'replaced')
LEFT JOIN inat_taxon g ON g.inat_taxon_id = sh.genus_id AND NOT st.split_beside_dead_end
LEFT JOIN inat_taxon f ON f.inat_taxon_id = sh.family_id AND NOT st.split_beside_dead_end;
COMMENT ON VIEW inat_taxon_current IS 'Every cached taxon with what iNaturalist calls it today, resolved when read and never stored. standing: current (not retired), replaced (retired, and the chain of replacements ends at one active taxon, the current taxon), split (replaced by more than one active taxon: no current taxon, nothing picked), retired (no active taxon at the end of any chain, or one and a dead end beside it), pending (a chain reaches a taxon the cache has not read yet) or absent (iNaturalist was asked and answered without it, and stays absent until a fetch returns it). A replacement that is absent is a dead end. The genus, the family, is_plant and is_vascular are those of the current taxon, never of the stored one''s own stale lineage, and a retired ancestor is resolved to its own current taxon (a genus or family only if that is one); for a split, what every active taxon it came to shares, else NULL, and NULL for a split with a dead end beside it, since the dead end may be another half. Reads only the cache''s tables, never the plant list or plant_taxon_common_name.';
COMMENT ON COLUMN inat_taxon_current.inat_taxon_id IS 'The cached taxon, as a sample stores it.';
COMMENT ON COLUMN inat_taxon_current.standing IS 'current, replaced, split, retired, pending or absent: see the view.';
COMMENT ON COLUMN inat_taxon_current.name IS 'The stored taxon''s own name, as the cache last read it.';
COMMENT ON COLUMN inat_taxon_current.rank IS 'The stored taxon''s own rank.';
COMMENT ON COLUMN inat_taxon_current.current_taxon_id IS 'The taxon iNaturalist means by it now: itself when current, the end of the chain when replaced; NULL when split, retired, pending or absent.';
COMMENT ON COLUMN inat_taxon_current.current_name IS 'The current taxon''s name.';
COMMENT ON COLUMN inat_taxon_current.current_rank IS 'The current taxon''s rank, which italics follow: a species replaced by a genus is set as a genus.';
COMMENT ON COLUMN inat_taxon_current.genus_taxon_id IS 'The genus of the current taxon (the taxon itself at genus rank), never a retired taxon. For a split, the genus all its active taxa share. NULL where the taxon is above a genus, the cache lacks the lineage, a retired genus came to no single genus, or a split spans genera.';
COMMENT ON COLUMN inat_taxon_current.genus_name IS 'The name of genus_taxon_id.';
COMMENT ON COLUMN inat_taxon_current.family_taxon_id IS 'The family of the current taxon, on the terms of genus_taxon_id.';
COMMENT ON COLUMN inat_taxon_current.family_name IS 'The name of family_taxon_id.';
COMMENT ON COLUMN inat_taxon_current.is_plant IS 'Whether the current taxon''s lineage reaches Plantae (iNaturalist 47126), the taxon itself included. For a split, whether every taxon it came to does. NULL where there is no current taxon or the cache holds no lineage for it.';
COMMENT ON COLUMN inat_taxon_current.is_vascular IS 'Whether the lineage reaches Tracheophyta (iNaturalist 211194), on the terms of is_plant.';

-- plant_taxon_common_name, made again over inat_taxon_current (schema/114).
DROP VIEW plant_taxon_common_name;
-- One row per cached taxon that has a common name: the taxon's own list
-- entry, else iNaturalist's name for Oregon, else the nearest coarser list
-- entry that covers it. An entry covers a taxon when the entry's own taxon is
-- that taxon or one of its ancestors (inat_taxon_ancestor, which includes the
-- taxon at depth 0); the nearest is the lowest depth, and an entry with no
-- usable name does not cover, since it has nothing to say. Two entries at one
-- depth (plant_list_taxon_shared) are settled by scientific name so the answer
-- does not move.
--
-- An entry is the taxon it is today: its stored taxon is resolved through
-- inat_taxon_current first, so an entry whose taxon iNaturalist has replaced
-- covers what lies beneath the replacement. An entry whose taxon was split,
-- is retired with nothing to replace it, is pending or is absent has no
-- current taxon and covers nothing. A taxon's ancestors are resolved the same
-- way, so a retired genus in a lineage matches the entry for the genus that
-- replaced it. The depth is still the stored lineage's. A taxon that is not in
-- the cache at all has nothing to resolve and stands for itself, as it did before.
--
-- It reads the taxon's own stored lineage, which for a retired taxon is stale
-- (schema/066): a retired host is resolved to its current taxon first, and
-- this view is read for that taxon (schema/116).
CREATE VIEW plant_taxon_common_name AS
WITH covering AS (
  SELECT a.inat_taxon_id, c.common_name, c.scientific_name, a.depth,
         -- At one depth, an entry written for the current taxon itself comes before one that reaches it
         -- only through a replacement (an older synonym the list also holds).
         row_number() OVER (PARTITION BY a.inat_taxon_id ORDER BY a.depth, t.stored_taxon_id IS DISTINCT FROM t.current_taxon_id, c.list_key, c.scientific_name) AS place
  FROM inat_taxon_ancestor a
  LEFT JOIN inat_taxon_current ancestor_now ON ancestor_now.inat_taxon_id = a.ancestor_id
  JOIN (SELECT t.list_key, t.scientific_name, t.inat_taxon_id AS stored_taxon_id,
               CASE WHEN e.inat_taxon_id IS NULL THEN t.inat_taxon_id ELSE e.current_taxon_id END AS current_taxon_id
        FROM plant_list_entry_taxon t
        LEFT JOIN inat_taxon_current e ON e.inat_taxon_id = t.inat_taxon_id) t
    ON t.current_taxon_id = CASE WHEN ancestor_now.inat_taxon_id IS NULL THEN a.ancestor_id ELSE ancestor_now.current_taxon_id END
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
COMMENT ON VIEW plant_taxon_common_name IS 'The common name of each cached taxon that has one: the name of the old-Beeline list''s entry for the taxon itself; otherwise iNaturalist''s preferred name for Oregon; otherwise the name of the nearest coarser list entry that covers it (the entry''s taxon is an ancestor; the lowest depth wins), so a genus or family entry names a species only where iNaturalist has no name for it (Peter, 2026-11-14). An entry''s name is the first of those its cell lists; an entry at genus rank or above whose cell lists several names gives none (plant_list_entry_several_names). source says which; list_entry and list_entry_depth say which entry and how far above the taxon it sits (0 is the taxon''s own entry), and are NULL when the name is iNaturalist''s. An entry''s taxon, and the ancestors it is matched against, are taken as iNaturalist has them today (inat_taxon_current), so an entry whose taxon was replaced covers the replacement''s descendants and one whose taxon was split covers nothing. Reads the taxon''s own stored lineage for the depth, so a retired taxon is judged by its stale one; sample_host reads this view for the retired host''s current taxon instead.';

-- The common names of the cached taxa, kept (beeline-rfkj.3), so that a page
-- reads one taxon's name in a lookup and not in a recomputation.
--
-- plant_taxon_common_name (schema/114) is the definition, and it is correct,
-- but to say what one taxon is called it first works out which taxon each of
-- the plant list's 1,405 names is (plant_name_resolution, schema/111). That
-- takes about 27 milliseconds whichever taxon is asked about, as long as
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

-- A stored taxon with what iNaturalist calls it today and that taxon's common
-- name (beeline-rfkj.3), and a sample's floral host as that.
--
-- This is the primitive, one row per cached taxon, joined by id. It is
-- inat_taxon_current (schema/113) with the common name of the CURRENT taxon
-- from plant_common_name_cache (schema/068): a host that was replaced is named
-- for the plant it now is, since the retired taxon's own lineage, which the
-- list's coarser entries are found through, is stale (schema/066). A split,
-- a retired taxon, a pending one and an absent one have no current taxon and
-- so no common name.
--
-- Nothing is stored on the sample: the sample keeps the id and the name as
-- observed (schema/030) and this resolves them when read.
CREATE VIEW inat_taxon_current_named AS
SELECT c.inat_taxon_id, c.standing, c.name, c.rank,
       c.current_taxon_id, c.current_name, c.current_rank,
       c.genus_taxon_id, c.genus_name, c.family_taxon_id, c.family_name,
       c.is_plant, c.is_vascular,
       n.common_name, n.source AS common_name_source
FROM inat_taxon_current c
LEFT JOIN plant_common_name_cache n ON n.inat_taxon_id = c.current_taxon_id;
COMMENT ON VIEW inat_taxon_current_named IS 'inat_taxon_current with the common name of the current taxon (plant_common_name_cache, so the list''s name for it, else iNaturalist''s for Oregon, else the nearest coarser list entry''s). NULL where there is no current taxon (split, retired, pending, absent) or no name. One row per cached taxon, to be joined by id.';
COMMENT ON COLUMN inat_taxon_current_named.is_plant IS 'inat_taxon_current.is_plant.';
COMMENT ON COLUMN inat_taxon_current_named.is_vascular IS 'inat_taxon_current.is_vascular.';
COMMENT ON COLUMN inat_taxon_current_named.common_name IS 'The current taxon''s common name.';
COMMENT ON COLUMN inat_taxon_current_named.common_name_source IS 'list or inaturalist.';

-- A thin layer over it: the sample's host, one row for each sample whose host
-- id is in the cache. A sample with no id, or one the cache has not read
-- yet, has no row, and its page shows the name as observed (hosts with a
-- name and no id are beeline-rfkj.5's).
CREATE VIEW sample_host AS
SELECT s.entity_id AS sample_id,
       h.inat_taxon_id, h.standing, h.name, h.rank,
       h.current_taxon_id, h.current_name, h.current_rank,
       h.genus_taxon_id, h.genus_name, h.family_taxon_id, h.family_name,
       h.is_plant, h.is_vascular,
       h.common_name, h.common_name_source
FROM sample s
JOIN inat_taxon_current_named h ON h.inat_taxon_id = s.host_inat_taxon_id;
COMMENT ON VIEW sample_host IS 'A sample''s floral host as iNaturalist knows it today: the stored taxon (inat_taxon_id, name, rank as the cache last read them), its standing, the current taxon (id, name, rank) and the genus and family of the current taxon, whether it is a plant and a vascular plant, and the current taxon''s common name. One row for each sample whose host id is in the cache. Resolved when read; the sample keeps the id and the name as observed.';
