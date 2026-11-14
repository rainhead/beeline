-- The taxa the store refers to but has not yet read from iNaturalist
-- (beeline-rfkj.1), and the taxa worth reading again.
--
-- What refers to a taxon: a sample's floral host (sample.host_inat_taxon_id)
-- and an observation's (observation_field.host_taxon_id, which the dashboard
-- shows before the observation is minted into a sample). Fetching a taxon
-- brings in its ancestors and, if it was retired, its replacements, so the
-- worklist grows as it is worked: the fetcher reads this view again after
-- each batch until it is empty. The view is also what anything asking "is the
-- cache complete" reads, so the definition of missing is stated once.
--
-- beeline-rfkj.2 adds the old plant list's entries as one more branch of the
-- first SELECT below (a UNION of its resolved taxon ids). Nothing else here
-- changes when it does.
--
-- An id iNaturalist was asked for and did not return (inat_taxon_absent) is
-- not missing, it is gone; subtracting it is what lets the view be empty.
CREATE VIEW inat_taxon_uncached AS
SELECT inat_taxon_id FROM (
  SELECT host_inat_taxon_id AS inat_taxon_id FROM sample
  UNION
  SELECT host_taxon_id FROM observation_field
  UNION
  SELECT ancestor_id FROM inat_taxon_ancestor
  UNION
  SELECT replacement_taxon_id FROM inat_taxon_replacement
) wanted
WHERE inat_taxon_id IS NOT NULL
EXCEPT
SELECT inat_taxon_id FROM inat_taxon
EXCEPT
SELECT inat_taxon_id FROM inat_taxon_absent;

-- Stored taxa that stand in for a retired one and so are read again every
-- night, ahead of the rolling refresh: a taxon a retired taxon was replaced
-- by may itself be retired later, and the fetcher can only follow that chain
-- (to the replacement's own replacements, which join the worklist when the
-- row is re-read) if it notices. Only rows older than a day, so a taxon read
-- tonight is not read again tonight.
CREATE VIEW inat_taxon_recheck AS
SELECT t.inat_taxon_id
FROM inat_taxon t
WHERE t.is_active
  AND t.fetched_at < now() - INTERVAL '1 day'
  AND t.inat_taxon_id IN (SELECT replacement_taxon_id FROM inat_taxon_replacement)
  AND t.inat_taxon_id NOT IN (SELECT inat_taxon_id FROM inat_taxon_absent);
