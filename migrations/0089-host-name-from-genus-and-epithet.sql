-- Data repair for beeline-32ow. No schema change, so there is no matching edit
-- in schema/: a fresh build gets the same result from ingest/promote-legacy.sql.
--
-- Legacy promotion took a sample's host from the first non-empty plant column
-- and rank from which column it was. Hand-typed records of the old Beeline
-- hold only the epithet in speciesPlant ("canadensis", the genus being in
-- genusPlant), so 97 samples of 2025 were stored with a host of "canadensis"
-- at rank species. Others hold the whole binomial in genusPlant and nothing
-- in speciesPlant, so 42 samples of 2023 and 2024 were stored as "Gutierrezia
-- sarothrae" at rank genus. Production is never re-promoted (ADR 0006), so
-- this recomputes both from the legacy rows each sample was made of, with the
-- rule now in promote-legacy.sql (read it for why the patterns are these).
--
-- Only a sample is changed that
--   * has no iNaturalist taxon for its host (a host with one follows its
--     observation and is not read from the legacy rows at all), and
--   * still holds exactly what the old rule produced from its legacy rows,
--     so a host that anyone has changed since promotion is never overwritten.
-- The second condition also makes this safe to run twice: after a repair the
-- stored value is the new one, which no longer equals the old one.
UPDATE sample AS s
SET host_name_as_observed = f.new_name,
    host_rank = 'species'
FROM (
  SELECT n.sample_id,
         arg_min(coalesce(nullif(o.speciesPlant, ''), nullif(o.genusPlant, ''), nullif(o.familyPlant, ''),
                          nullif(o.orderPlant, ''), nullif(o.phylumPlant, '')), o._id) AS old_name,
         arg_min(CASE
           WHEN nullif(o.speciesPlant, '') IS NOT NULL THEN 'species'
           WHEN nullif(o.genusPlant, '')   IS NOT NULL THEN 'genus'
           WHEN nullif(o.familyPlant, '')  IS NOT NULL THEN 'family'
           WHEN nullif(o.orderPlant, '')   IS NOT NULL THEN 'order'
           WHEN nullif(o.phylumPlant, '')  IS NOT NULL THEN 'phylum'
         END, o._id) AS old_rank,
         arg_min(CASE
           WHEN regexp_full_match(coalesce(o.speciesPlant, ''), '[a-z][a-z-]*')
            AND regexp_full_match(coalesce(o.genusPlant, ''), '[A-Z][a-z-]+')
             THEN concat(o.genusPlant, ' ', o.speciesPlant)
           WHEN nullif(o.speciesPlant, '') IS NULL
            AND regexp_full_match(coalesce(o.genusPlant, ''), '[A-Z][a-z-]+ [a-z][a-z-]*')
             THEN o.genusPlant
         END, o._id) AS new_name
  FROM legacy_specimen_number n
  JOIN legacy_occurrence o ON o._id = n._id
  GROUP BY n.sample_id
) f
WHERE s.entity_id = f.sample_id
  AND s.host_inat_taxon_id IS NULL
  AND f.new_name IS NOT NULL
  AND s.host_name_as_observed IS NOT DISTINCT FROM f.old_name
  AND s.host_rank IS NOT DISTINCT FROM f.old_rank;
