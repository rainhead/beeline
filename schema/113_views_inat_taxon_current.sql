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
