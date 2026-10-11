-- Migration for schema/010_people_atlases.sql and schema/103 (beeline-0544,
-- beeline-yaaj): what iNaturalist reports an account's ORCID iD to be, and
-- which iD credits a person downstream. The reasoning is in those files.
--
-- person_orcid is unchanged but for its comments; nothing has ever written
-- to it. inat_user_orcid is new: sign-in fills it, or pnpm inat:fetch-orcids.
COMMENT ON TABLE person_orcid IS 'An ORCID iD staff recorded for this person, from one the person gave or confirmed: set on /people/:id through the person overlay (field orcid) and replayed onto every rebuild. Never guessed. The one an archive writes is person_orcid_of_record, where the person''s own iNaturalist profile wins (inat_user_orcid).';
COMMENT ON COLUMN person_orcid.orcid IS 'The bare iD, 0000-0002-1825-0097, checksum verified; an export writes it as https://orcid.org/<iD>.';

CREATE TABLE inat_user_orcid (
  inat_user_id BIGINT PRIMARY KEY,
  orcid        TEXT NOT NULL,
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE inat_user_orcid IS 'The ORCID iD an iNaturalist account has connected, as iNaturalist''s API reports it (user.orcid). Written when the account signs in to Beeline (src/app/auth.tsx), and for every bound account by pnpm inat:fetch-orcids; an account that has none has no row. Fetched, not derived, so db:reseed carries it.';
COMMENT ON COLUMN inat_user_orcid.inat_user_id IS 'The account. Not a foreign key: an account keeps its iD while it is bound to nobody.';
COMMENT ON COLUMN inat_user_orcid.orcid IS 'The bare iD, as person_orcid.orcid; iNaturalist reports it as a URL.';
COMMENT ON COLUMN inat_user_orcid.fetched_at IS 'When iNaturalist last reported it.';

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
