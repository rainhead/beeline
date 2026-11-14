-- Migration for schema/114, schema/115 and schema/116: what iNaturalist calls a host today,
-- and its common name (beeline-rfkj.3).
--
-- Views over the taxon cache, a copy of the common names that makes one taxon's name a
-- lookup, and a sample's host as those. The copy is filled here from the view it copies;
-- the boot load of the plant list, the plant-names job and the nightly taxon step
-- keep it fresh from then on (src/plant-common-names.ts).

-- What iNaturalist calls a stored plant taxon today (beeline-rfkj.3), in a file
-- after the cache's worklist (schema/112) and the common names (schema/113).
--
-- STORED IDS AND NAMES ARE NEVER REWRITTEN TO FOLLOW iNATURALIST. A sample
-- keeps the host id its observation gave it, and the cache keeps a retired
-- taxon as retired (schema/066). These views read the cache and say what the
-- stored taxon stands for now, when somebody looks.
--
-- inat_taxon_replacement_end and inat_taxon_current read only the cache's own
-- tables (inat_taxon, inat_taxon_replacement, inat_taxon_ancestor,
-- inat_taxon_absent). They must not read the plant list's views (schema/111)
-- or plant_taxon_common_name (schema/113): inat_taxon_uncached reads
-- plant_name_hit_current, so a path back from here would make the two depend
-- on each other. The common name is added in the view after them.

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
--   unread   a taxon the cache has not read yet (inat_taxon_uncached lists it),
--            so nobody knows yet whether it was replaced in turn
-- A retired taxon whose replacements are all dead ends has ends of kind retired.
CREATE VIEW inat_taxon_replacement_end AS
WITH RECURSIVE reached(retired_taxon_id, taxon_id) AS (
  SELECT inat_taxon_id, inat_taxon_id FROM inat_taxon WHERE NOT is_active
  UNION
  SELECT w.retired_taxon_id, r.replacement_taxon_id
  FROM reached w
  JOIN inat_taxon t ON t.inat_taxon_id = w.taxon_id AND NOT t.is_active
  JOIN inat_taxon_replacement r ON r.retired_taxon_id = w.taxon_id
)
SELECT w.retired_taxon_id, w.taxon_id AS end_taxon_id,
       CASE WHEN t.inat_taxon_id IS NULL THEN 'unread'
            WHEN t.is_active THEN 'active'
            ELSE 'retired' END AS end_kind
FROM reached w
LEFT JOIN inat_taxon t ON t.inat_taxon_id = w.taxon_id
WHERE t.inat_taxon_id IS NULL
   OR t.is_active
   OR NOT EXISTS (SELECT 1 FROM inat_taxon_replacement r WHERE r.retired_taxon_id = w.taxon_id);
COMMENT ON VIEW inat_taxon_replacement_end IS 'The end of each retired cached taxon''s chain of replacements, one row per end: an active taxon (what the retired one means now), a retired taxon with no replacement recorded (a dead end), or a taxon the cache has not read yet (unread). A split gives several rows. A chain that loops back on itself has no row. Reads only the cache''s tables, never the plant list.';
COMMENT ON COLUMN inat_taxon_replacement_end.retired_taxon_id IS 'The cached taxon iNaturalist has retired, as a sample stores it.';
COMMENT ON COLUMN inat_taxon_replacement_end.end_taxon_id IS 'A taxon at the end of the chain of replacements. The retired taxon itself where nothing replaces it.';
COMMENT ON COLUMN inat_taxon_replacement_end.end_kind IS 'active, retired or unread: see the view.';

-- One row per cached taxon: its standing, and the current taxon it stands for.
--
-- Standing is worked out from the end of the chain and never from whether a
-- row exists:
--   current   iNaturalist has not retired the taxon: it is its own current taxon
--   replaced  retired, and every chain ends at one active taxon: that is the current taxon
--   split     retired and replaced by several active taxa, or by one and a dead end:
--             no current taxon, so nothing is picked
--   retired   retired with no active taxon at the end of any chain
--   pending   retired, and a chain reaches a taxon the cache has not read yet, so
--             the standing is not known until the nightly step has read it
--   absent    iNaturalist was asked for the taxon and answered without it
--             (inat_taxon_known_absent): deleted upstream, its row kept
-- The current taxon's id, name and rank are those of the active taxon at the end
-- of the chain, and italics follow its rank. Lineage is taken from the current
-- taxon, never from the stored one's own ancestry, which for a retired taxon is
-- stale (schema/066). For a split there is no current taxon, but a genus or a
-- family is given where every active taxon the split came to shares it, so a
-- count by genus can still use it.
CREATE VIEW inat_taxon_current AS
WITH heads AS (
  -- Each stored taxon with the active taxa it comes to.
  SELECT inat_taxon_id AS taxon_id, inat_taxon_id AS head_id
  FROM inat_taxon
  WHERE is_active AND inat_taxon_id NOT IN (SELECT inat_taxon_id FROM inat_taxon_known_absent)
  UNION ALL
  SELECT retired_taxon_id, end_taxon_id FROM inat_taxon_replacement_end WHERE end_kind = 'active'
), lineage AS (
  -- A lineage holds one genus and one family at most, so the lowest id is the
  -- only one. Joins and aggregates rather than a lookup per row: read for one
  -- taxon this costs the same as for all of them, and the aggregates are
  -- cheaper than 5,000 correlated lookups.
  SELECT h.taxon_id, h.head_id, g.genus_id, f.family_id
  FROM heads h
  LEFT JOIN (SELECT ga.inat_taxon_id, min(ga.ancestor_id) AS genus_id
             FROM inat_taxon_ancestor ga JOIN inat_taxon gt ON gt.inat_taxon_id = ga.ancestor_id AND gt.rank = 'genus'
             GROUP BY ga.inat_taxon_id) g ON g.inat_taxon_id = h.head_id
  LEFT JOIN (SELECT fa.inat_taxon_id, min(fa.ancestor_id) AS family_id
             FROM inat_taxon_ancestor fa JOIN inat_taxon ft ON ft.inat_taxon_id = fa.ancestor_id AND ft.rank = 'family'
             GROUP BY fa.inat_taxon_id) f ON f.inat_taxon_id = h.head_id
), shared AS (
  SELECT taxon_id,
         count(*) AS heads,
         min(head_id) AS head_id,
         CASE WHEN count(genus_id) = count(*) AND count(DISTINCT genus_id) = 1 THEN min(genus_id) END AS genus_id,
         CASE WHEN count(family_id) = count(*) AND count(DISTINCT family_id) = 1 THEN min(family_id) END AS family_id
  FROM lineage
  GROUP BY taxon_id
), ends AS (
  SELECT retired_taxon_id,
         count(*) FILTER (WHERE end_kind = 'active') AS active_ends,
         count(*) FILTER (WHERE end_kind = 'retired') AS dead_ends,
         count(*) FILTER (WHERE end_kind = 'unread') AS unread_ends
  FROM inat_taxon_replacement_end
  GROUP BY retired_taxon_id
)
SELECT t.inat_taxon_id,
       CASE WHEN t.is_active AND k.inat_taxon_id IS NOT NULL THEN 'absent'
            WHEN t.is_active THEN 'current'
            WHEN coalesce(e.unread_ends, 0) > 0 THEN 'pending'
            WHEN coalesce(e.active_ends, 0) = 1 AND coalesce(e.dead_ends, 0) = 0 THEN 'replaced'
            WHEN coalesce(e.active_ends, 0) >= 1 THEN 'split'
            ELSE 'retired' END AS standing,
       t.name, t.rank,
       c.inat_taxon_id AS current_taxon_id, c.name AS current_name, c.rank AS current_rank,
       g.inat_taxon_id AS genus_taxon_id, g.name AS genus_name,
       f.inat_taxon_id AS family_taxon_id, f.name AS family_name
FROM inat_taxon t
LEFT JOIN inat_taxon_known_absent k ON k.inat_taxon_id = t.inat_taxon_id
LEFT JOIN ends e ON e.retired_taxon_id = t.inat_taxon_id
LEFT JOIN shared s ON s.taxon_id = t.inat_taxon_id
-- Nothing is said of a taxon whose chain reaches one not read yet: what it
-- will come to is not known.
LEFT JOIN inat_taxon c ON c.inat_taxon_id = s.head_id AND s.heads = 1
  AND coalesce(e.unread_ends, 0) = 0 AND coalesce(e.dead_ends, 0) = 0
LEFT JOIN inat_taxon g ON g.inat_taxon_id = s.genus_id AND coalesce(e.unread_ends, 0) = 0
LEFT JOIN inat_taxon f ON f.inat_taxon_id = s.family_id AND coalesce(e.unread_ends, 0) = 0;
COMMENT ON VIEW inat_taxon_current IS 'Every cached taxon with what iNaturalist calls it today, resolved when read and never stored. standing: current (not retired), replaced (retired, and the chain of replacements ends at one active taxon, the current taxon), split (replaced by several, or by one and a dead end: no current taxon, nothing picked), retired (no active taxon at the end of any chain), pending (a chain reaches a taxon the cache has not read yet) or absent (iNaturalist was asked and answered without it). The genus and the family are those of the current taxon, never of the stored one''s own stale lineage; for a split, the one that every active taxon it came to shares, else NULL. Reads only the cache''s tables, never the plant list or plant_taxon_common_name.';
COMMENT ON COLUMN inat_taxon_current.inat_taxon_id IS 'The cached taxon, as a sample stores it.';
COMMENT ON COLUMN inat_taxon_current.standing IS 'current, replaced, split, retired, pending or absent: see the view.';
COMMENT ON COLUMN inat_taxon_current.name IS 'The stored taxon''s own name, as the cache last read it.';
COMMENT ON COLUMN inat_taxon_current.rank IS 'The stored taxon''s own rank.';
COMMENT ON COLUMN inat_taxon_current.current_taxon_id IS 'The taxon iNaturalist means by it now: itself when current, the end of the chain when replaced; NULL when split, retired, pending or absent.';
COMMENT ON COLUMN inat_taxon_current.current_name IS 'The current taxon''s name.';
COMMENT ON COLUMN inat_taxon_current.current_rank IS 'The current taxon''s rank, which italics follow: a species replaced by a genus is set as a genus.';
COMMENT ON COLUMN inat_taxon_current.genus_taxon_id IS 'The genus of the current taxon (the taxon itself at genus rank). For a split, the genus all its active taxa share. NULL where the taxon is above a genus, the cache lacks the lineage, or a split spans genera.';
COMMENT ON COLUMN inat_taxon_current.genus_name IS 'The name of genus_taxon_id.';
COMMENT ON COLUMN inat_taxon_current.family_taxon_id IS 'The family of the current taxon, on the terms of genus_taxon_id.';
COMMENT ON COLUMN inat_taxon_current.family_name IS 'The name of family_taxon_id.';

-- The common names of the cached taxa, kept (beeline-rfkj.3), so that a page
-- reads one taxon's name in a lookup and not in a recomputation.
--
-- plant_taxon_common_name (schema/113) is the definition, and it is correct,
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
-- creates this table fills it.
--
-- A copy of derived rows, so nothing here is kept for its own sake: it is
-- rebuilt from the list, the lookups and the cache, and `db:reseed` need not
-- carry it. plant_common_name_stale lists any taxon where the copy and the
-- view disagree, and is empty when a refresh has run since the last change.
CREATE TABLE plant_common_name_cache (
  inat_taxon_id   BIGINT PRIMARY KEY,
  common_name     TEXT NOT NULL,
  source          TEXT NOT NULL CHECK (source IN ('list', 'inaturalist')),
  list_entry      TEXT,
  list_entry_depth INTEGER,
  refreshed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE plant_common_name_cache IS 'A copy of the rows of plant_taxon_common_name (schema/113), refreshed by refreshPlantCommonNames after anything that changes them (the list''s boot load, the plant-names job, the nightly taxon step), so that reading one taxon''s name is a lookup. Derived, never edited; rebuild it by refreshing. plant_common_name_stale says whether it is out of date.';
COMMENT ON COLUMN plant_common_name_cache.inat_taxon_id IS 'The cached taxon. A taxon with no common name has no row.';
COMMENT ON COLUMN plant_common_name_cache.common_name IS 'plant_taxon_common_name.common_name.';
COMMENT ON COLUMN plant_common_name_cache.source IS 'list or inaturalist: where the name came from.';
COMMENT ON COLUMN plant_common_name_cache.list_entry IS 'The scientific name of the list entry the name came from, when it came from the list.';
COMMENT ON COLUMN plant_common_name_cache.list_entry_depth IS 'How far above the taxon its entry sits; 0 is the taxon''s own entry.';
COMMENT ON COLUMN plant_common_name_cache.refreshed_at IS 'When the copy was last refreshed.';

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
-- inat_taxon_current (schema/114) with the common name of the CURRENT taxon
-- from plant_common_name_cache (schema/115): a host that was replaced is named
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
       n.common_name, n.source AS common_name_source
FROM inat_taxon_current c
LEFT JOIN plant_common_name_cache n ON n.inat_taxon_id = c.current_taxon_id;
COMMENT ON VIEW inat_taxon_current_named IS 'inat_taxon_current with the common name of the current taxon (plant_common_name_cache, so the list''s name for it, else iNaturalist''s for Oregon, else the nearest coarser list entry''s). NULL where there is no current taxon (split, retired, pending, absent) or no name. One row per cached taxon, to be joined by id.';
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
       h.common_name, h.common_name_source
FROM sample s
JOIN inat_taxon_current_named h ON h.inat_taxon_id = s.host_inat_taxon_id;
COMMENT ON VIEW sample_host IS 'A sample''s floral host as iNaturalist knows it today: the stored taxon (inat_taxon_id, name, rank as the cache last read them), its standing, the current taxon (id, name, rank) and the genus and family of the current taxon, and the current taxon''s common name. One row for each sample whose host id is in the cache. Resolved when read; the sample keeps the id and the name as observed.';

INSERT INTO plant_common_name_cache (inat_taxon_id, common_name, source, list_entry, list_entry_depth)
SELECT inat_taxon_id, common_name, source, list_entry, list_entry_depth FROM plant_taxon_common_name;
