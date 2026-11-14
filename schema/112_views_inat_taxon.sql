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
-- not missing, it is gone; subtracting it is what lets the view be empty. The
-- verdict lasts 30 days (inat_taxon_known_absent), because a taxon deleted by
-- mistake or brought back should not stay unread for good: after that the id
-- is asked for again, and recorded again if it is still gone.
CREATE VIEW inat_taxon_known_absent AS
SELECT inat_taxon_id FROM inat_taxon_absent
WHERE asked_at >= now() - INTERVAL '30 days';

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
SELECT inat_taxon_id FROM inat_taxon_known_absent;

-- The two rules for reading a stored taxon again, each defined here so the
-- fetcher and anything that wants to know what tonight will read agree. Both
-- leave out a taxon read within 12 hours, so that a taxon read tonight is
-- not read again tonight and a cold fill does not refresh itself, while a
-- nightly run, about a day after the last, always finds the taxon due.
--
-- inat_taxon_recheck: stored taxa that stand in for a retired one, read
-- every night, ahead of the rolling refresh. A taxon a retired taxon was
-- replaced by may itself be retired later, and the fetcher can only follow
-- that chain (to the replacement's own replacements, which join the worklist
-- when the row is read again) if it notices.
CREATE VIEW inat_taxon_recheck AS
SELECT t.inat_taxon_id
FROM inat_taxon t
WHERE t.is_active
  AND t.fetched_at < now() - INTERVAL '12 hours'
  AND t.inat_taxon_id IN (SELECT replacement_taxon_id FROM inat_taxon_replacement)
  AND t.inat_taxon_id NOT IN (SELECT inat_taxon_id FROM inat_taxon_known_absent);

-- inat_taxon_stalest: the rolling refresh, the stalest thirtieth (rounded up)
-- of the stored taxa not known to be absent, by when each was read, so every
-- taxon is read again within about a month.
CREATE VIEW inat_taxon_stalest AS
SELECT inat_taxon_id FROM (
  SELECT inat_taxon_id, fetched_at,
         row_number() OVER (ORDER BY fetched_at, inat_taxon_id) AS place,
         count(*) OVER () AS total
  FROM inat_taxon
  WHERE inat_taxon_id NOT IN (SELECT inat_taxon_id FROM inat_taxon_known_absent)
) ranked
WHERE place <= ceil(total / 30.0)
  AND fetched_at < now() - INTERVAL '12 hours';
