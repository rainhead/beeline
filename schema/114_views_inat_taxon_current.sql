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
