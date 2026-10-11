-- Which ORCID iD credits a person downstream (beeline-0544, beeline-yaaj).
--
-- Two sources, and the person's own wins (Peter, 2026-10-10): an iD
-- connected on their iNaturalist account is one they proved by signing in to
-- ORCID, where a staff entry is somebody else's reading of what they said.
-- Staff record one for the people who will not connect it there — most of
-- the determiners who matter are not on iNaturalist at all.
CREATE VIEW person_orcid_of_record AS
SELECT a.person_id, o.orcid, 'inaturalist' AS source
FROM inat_account a
JOIN inat_user_orcid o ON o.inat_user_id = a.inat_user_id
UNION ALL
SELECT s.person_id, s.orcid, 'staff' AS source
FROM person_orcid s
WHERE NOT EXISTS (
  SELECT 1 FROM inat_account a
  JOIN inat_user_orcid o ON o.inat_user_id = a.inat_user_id
  WHERE a.person_id = s.person_id
);
COMMENT ON VIEW person_orcid_of_record IS 'One ORCID iD per person who has one: their iNaturalist account''s where it has connected one, else the one staff recorded. What the specimen listing, its CSV and the program archives write as recordedByID and identifiedByID.';

-- person_orcid's UNIQUE holds among staff entries only. An iD staff gave one
-- person and an iNaturalist account bound to another can still meet here —
-- a household's shared login connected to the partner's ORCID would — and
-- then two people's records credit one researcher. Named, not prevented:
-- which of them it belongs to is a person's question. Asserted empty by test
-- and shown on both people's pages.
CREATE VIEW person_orcid_shared AS
SELECT orcid, person_id, source
FROM person_orcid_of_record
WHERE orcid IN (SELECT orcid FROM person_orcid_of_record GROUP BY orcid HAVING count(*) > 1);
COMMENT ON VIEW person_orcid_shared IS 'ORCID iDs that credit more than one person, each with whose and where from. Empty unless a staff entry and an iNaturalist account disagree about who an iD belongs to.';
