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

-- THE TAXON EACH HOST NAME COMES TO (beeline-rfkj.5). A sample with a host
-- name and no iNaturalist id, nearly all from the seasons before iNaturalist
-- carried the host, is read through the taxon its name resolves to by the
-- plant name lookups (plant_name_resolution, schema/111). The id is never
-- written into the sample (Peter, 2026-11-13): this is worked out when read.
--
-- Only a name whose taxon came through a hit's own name (by_own_name) is
-- read. One that matched only through iNaturalist's matched_term is an older
-- name of the taxon, or a common name a volunteer typed as a host, which
-- iNaturalist also matches there and which no rule here can tell apart; such
-- a name waits for a person (sample_host_unresolved, beeline-rfkj.6). On
-- production's store of 2026-11-15 that is 2 names, 7 samples.
CREATE VIEW host_name_taxon AS
SELECT DISTINCT w.raw_name AS host_name, r.inat_taxon_id
FROM plant_name_wanted w
JOIN plant_name_shape sh ON sh.raw_name = w.raw_name
JOIN plant_name_resolution r ON r.name_key = sh.name_key AND r.expected_rank = sh.expected_rank
WHERE w.source = 'host' AND r.outcome = 'matched' AND r.by_own_name;
COMMENT ON VIEW host_name_taxon IS 'Each host name of a sample with no host id (exactly as the sample holds it) whose plant name lookup matched one taxon through a hit''s own name, with that taxon. The definition of host_name_taxon_cache (schema/068), which a page reads instead, since this resolves every name.';

CREATE VIEW host_name_taxon_stale AS
SELECT host_name FROM (
  SELECT host_name, inat_taxon_id FROM host_name_taxon
  EXCEPT
  SELECT host_name, inat_taxon_id FROM host_name_taxon_cache
) missing_or_changed
UNION
SELECT host_name FROM (
  SELECT host_name, inat_taxon_id FROM host_name_taxon_cache
  EXCEPT
  SELECT host_name, inat_taxon_id FROM host_name_taxon
) left_over;
COMMENT ON VIEW host_name_taxon_stale IS 'Host names where host_name_taxon_cache disagrees with host_name_taxon: a name missing from the copy, one it should no longer hold, or one whose taxon changed. Empty when a refresh has run since the last change to the plant list, the lookups, the taxon cache or a host name with no id; minting, which gives a sample an id and so takes its name out of host_name_taxon, does not refresh, so the name stays in the copy until the next refresh, read by nothing (every reader joins it only for a sample with no id). Reads the whole definition, so it is for tests and for a person checking, not for a page.';

-- A thin layer over it: the sample's host, one row for each sample whose host
-- is in the cache, by its id or, with no id, by the taxon its name comes to
-- (host_name_taxon_cache). resolved_by says which, and stays: a reader that
-- must not trust a name lookup as it trusts an identification (the
-- sensitive-plants rule, beeline-85m.6, which must fail closed) can tell them
-- apart. A sample with neither, or whose taxon the cache has not read yet,
-- has no row, and its page shows the name as observed. The taxon id is looked
-- up once and joined once, so inat_taxon_current_named, which resolves the
-- whole cache, is read once whichever way the host was found.
CREATE VIEW sample_host AS
SELECT s.entity_id AS sample_id,
       h.inat_taxon_id,
       CASE WHEN s.host_inat_taxon_id IS NOT NULL THEN 'id' ELSE 'name' END AS resolved_by,
       h.standing, h.name, h.rank,
       h.current_taxon_id, h.current_name, h.current_rank,
       h.genus_taxon_id, h.genus_name, h.family_taxon_id, h.family_name,
       h.is_plant, h.is_vascular,
       h.common_name, h.common_name_source
FROM sample s
LEFT JOIN host_name_taxon_cache c ON s.host_inat_taxon_id IS NULL AND c.host_name = s.host_name_as_observed
JOIN inat_taxon_current_named h ON h.inat_taxon_id = coalesce(s.host_inat_taxon_id, c.inat_taxon_id);
COMMENT ON VIEW sample_host IS 'A sample''s floral host as iNaturalist knows it today: the stored taxon (inat_taxon_id, name, rank as the cache last read them), how it was found (resolved_by), its standing, the current taxon (id, name, rank) and the genus and family of the current taxon, whether it is a plant and a vascular plant, and the current taxon''s common name. One row for each sample whose host is in the cache. Resolved when read; the sample keeps the id and the name as observed.';
COMMENT ON COLUMN sample_host.inat_taxon_id IS 'The sample''s host id, or, for a sample with none, the taxon its host name resolves to (host_name_taxon_cache).';
COMMENT ON COLUMN sample_host.resolved_by IS 'id: the sample''s own host id, an identification on iNaturalist. name: the sample has no id and its host name was looked up (beeline-rfkj.5).';

-- The worklist for hand decisions on host names (beeline-rfkj.6): each
-- sample with a host name and no id that is not read through a taxon, or is
-- read through one a person should look at, and why. The outcomes are
-- plant_name_resolution's (not looked up, could not be asked, too many
-- results, no match, retired with no replacement, ambiguous), and:
--   matched by another name   the taxon came only through matched_term, an
--                             older name or a common name (host_name_taxon);
--                             not read
--   not copied yet            the name resolves, but the copy a page reads
--                             (host_name_taxon_cache) does not hold it yet: a
--                             refresh failed or has not run since; not read
--                             until the next one (the app's boot runs one)
--   taxon not read yet        the name came to a taxon the taxon cache has
--                             not read, or whose replacement it has not read
--                             (pending); not read until it has, which the
--                             nightly taxa step does
--   not a vascular plant      read through its taxon, which is a plant but
--                             not a vascular one (a moss): the lookups search
--                             plants only, so it can never be an animal
--   other taxa had this name  read through its taxon, the active one of that
--                             name, but another hit of the lookup, a retired
--                             or an older name, stands for a different taxon:
--                             a name written years ago may have meant the
--                             other (Mimulus, which iNaturalist has since
--                             split, on 6 samples of 2018 to 2020). Both
--                             sides are followed to what they are now
--                             (inat_taxon_current), since the lookup's answer
--                             names one replacement, which may itself have
--                             been replaced since; a hit that is a dead end
--                             (no replacement) names no other plant and does
--                             not count.
--   no name                   the name is only whitespace
-- So every sample with a host name and no id is read (sample_host), or is
-- here, or both. With each sample's season and whether it has settled, so a
-- count can be split as AGENTS.md asks. Reads the name views whole, so it is
-- for a person and for tests, not for a page.
CREATE VIEW sample_host_unresolved AS
WITH judged AS (
  SELECT s.entity_id AS sample_id, s.host_name_as_observed AS host_name, sh.name_key, sh.expected_rank,
         CASE WHEN sh.raw_name IS NULL THEN 'no name'
              WHEN r.outcome <> 'matched' THEN r.outcome
              WHEN NOT r.by_own_name THEN 'matched by another name'
              WHEN NOT EXISTS (SELECT 1 FROM host_name_taxon_cache hc WHERE hc.host_name = s.host_name_as_observed)
                THEN 'not copied yet'
              WHEN c.inat_taxon_id IS NULL OR c.standing = 'pending' THEN 'taxon not read yet'
              WHEN c.is_vascular IS FALSE THEN 'not a vascular plant'
              WHEN EXISTS (SELECT 1 FROM plant_name_hit_current o
                           LEFT JOIN inat_taxon_current oc ON oc.inat_taxon_id = o.current_taxon_id
                           WHERE o.name_key = r.name_key AND o.expected_rank = r.expected_rank
                             AND coalesce(oc.current_taxon_id, o.current_taxon_id)
                                 <> coalesce(c.current_taxon_id, r.inat_taxon_id))
                THEN 'other taxa had this name'
         END AS outcome,
         r.inat_taxon_id AS candidate_taxon_id,
         CAST(EXTRACT(YEAR FROM s.date_start) AS INTEGER) AS season,
         s.date_start < season.active_since AS settled
  FROM sample s
  CROSS JOIN season
  LEFT JOIN plant_name_shape sh ON sh.raw_name = s.host_name_as_observed
  LEFT JOIN plant_name_resolution r ON r.name_key = sh.name_key AND r.expected_rank = sh.expected_rank
  LEFT JOIN inat_taxon_current c ON c.inat_taxon_id = r.inat_taxon_id
  WHERE s.host_inat_taxon_id IS NULL AND s.host_name_as_observed IS NOT NULL
)
SELECT * FROM judged WHERE outcome IS NOT NULL;
COMMENT ON VIEW sample_host_unresolved IS 'Samples with a host name and no host id that are not read through a taxon, or are read through one a person should look at, with why (outcome: plant_name_resolution''s, or matched by another name, not copied yet, taxon not read yet, not a vascular plant, other taxa had this name, no name), the taxon a match came to (candidate_taxon_id), the season and whether it has settled. The worklist for hand decisions on host names (beeline-rfkj.6).';
