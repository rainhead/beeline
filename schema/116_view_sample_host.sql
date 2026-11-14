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
