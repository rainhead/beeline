-- Migration for schema/068 and schema/116: a sample with a host name and no
-- iNaturalist id is read through the taxon its name comes to
-- (beeline-rfkj.5, the second part; the lookups were 0096).
--
-- host_name_taxon_cache is new, empty here, and filled by the refresh of the
-- plant name copies, which the app's boot runs (loadPlantListAtBoot) before
-- it serves anything; until then the hosts read as before, by the name as
-- observed. host_name_taxon, host_name_taxon_stale and sample_host_unresolved
-- are new views; sample_host is dropped and made again, with a branch for a
-- host found by name and a column, resolved_by, saying which way it was found.
-- Nothing is written into a sample.

-- The taxon each host name resolves to, kept for the same reason
-- (beeline-rfkj.5). A sample with a host name and no iNaturalist id is read
-- through the taxon its name comes to (sample_host, schema/116), and working
-- that out resolves every name (plant_name_resolution, schema/111: about 60
-- milliseconds on production's store of 2026-11-15, whatever is asked for),
-- too much for a page. So host_name_taxon (schema/116), the definition, is
-- copied here by the same refresh as the common names (refreshPlantCommonNames,
-- src/plant-common-names.ts), which runs after everything that changes what it
-- says: the boot load of the plant list, the plant-names job, the taxa fetch
-- and legacy promotion, the one writer of a host name with no id. Keyed by the
-- name exactly as the sample holds it, so a reader joins on the sample's
-- column and normalises nothing. host_name_taxon_stale (schema/116) lists
-- where the copy and its definition part.
CREATE TABLE host_name_taxon_cache (
  host_name     TEXT PRIMARY KEY,
  inat_taxon_id BIGINT NOT NULL,
  refreshed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE host_name_taxon_cache IS 'A copy of the rows of host_name_taxon (schema/116): each host name of a sample with no host id that resolves to a taxon a host may be read through. Refreshed with plant_common_name_cache by refreshPlantCommonNames; derived, never edited. host_name_taxon_stale says whether it is out of date.';
COMMENT ON COLUMN host_name_taxon_cache.host_name IS 'sample.host_name_as_observed, exactly as stored.';
COMMENT ON COLUMN host_name_taxon_cache.inat_taxon_id IS 'The taxon the name resolves to (plant_name_resolution.inat_taxon_id); need not be in inat_taxon yet.';
COMMENT ON COLUMN host_name_taxon_cache.refreshed_at IS 'When the copy was last refreshed.';

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

DROP VIEW sample_host;
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
--                             (host_name_taxon_cache) does not hold it, or
--                             holds an older answer: a refresh failed or has
--                             not run since; read, if at all, through the
--                             older answer until the next refresh (the app's
--                             boot runs one)
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
--                             (no replacement, or a replacement since retired
--                             with nothing after it, or absent) names no other
--                             plant and does not count.
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
              WHEN NOT EXISTS (SELECT 1 FROM host_name_taxon_cache hc
                               WHERE hc.host_name = s.host_name_as_observed AND hc.inat_taxon_id = r.inat_taxon_id)
                THEN 'not copied yet'
              WHEN c.inat_taxon_id IS NULL OR c.standing = 'pending' THEN 'taxon not read yet'
              WHEN c.is_vascular IS FALSE THEN 'not a vascular plant'
              WHEN EXISTS (SELECT 1 FROM plant_name_hit_current o
                           LEFT JOIN inat_taxon_current oc ON oc.inat_taxon_id = o.current_taxon_id
                           WHERE o.name_key = r.name_key AND o.expected_rank = r.expected_rank
                             AND oc.standing IS DISTINCT FROM 'retired' AND oc.standing IS DISTINCT FROM 'absent'
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
