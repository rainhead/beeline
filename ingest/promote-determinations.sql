-- Determinations from staging: expert columns become is_expert=true events
-- (identifiedBy as determiner_name); the *VolDet columns become volunteer
-- events whose determiner is the collector. Both resolve to the deepest
-- taxon the row asserts, joining animal on (rank, scientific_name).

-- ── Determiner resolution ───────────────────────────────────────────────
-- Legacy identifiedBy is free text with spelling variants; the curated
-- alias CSV maps each variant to a canonical display name. Every determiner
-- ends up with a single person record: canonical names matching an existing
-- display_name (most determiners also collect) reuse that person; the rest
-- are created. Verbatim text is always retained in determiner_name.
CREATE TABLE legacy_determiner_alias AS
SELECT trim(alias) AS alias, trim(person) AS person
FROM read_csv('{{DETERMINER_ALIASES}}', header = true);

INSERT INTO person (display_name)
SELECT DISTINCT a.person
FROM legacy_determiner_alias a
JOIN (SELECT DISTINCT trim(identifiedBy) AS ib FROM legacy_promotable WHERE trim(identifiedBy) <> '') u
  ON u.ib = a.alias
WHERE NOT EXISTS (SELECT 1 FROM person p WHERE p.display_name = a.person);

CREATE OR REPLACE VIEW legacy_determiner_person AS
SELECT a.alias, min(p.entity_id) AS person_id
FROM legacy_determiner_alias a
JOIN person p ON p.display_name = a.person
GROUP BY a.alias;

-- The Peter-curated identifier register (origin: beeatlas
-- data/dbt/seeds/identifier_register.csv) knows determiners' iNat logins,
-- including cases the collector-derived unambiguity rule refuses: a login
-- that appears with a second collector name (beesofcanada credits one Rob
-- Caulfield sample) or a family-shared login (molfamily). Register rows
-- resolve through the alias map; people with no legacy determinations are
-- skipped. Accounts attach only when the login's iNat user id is attested
-- in staging — the stable key stays real.
CREATE TABLE legacy_determiner_register AS
SELECT trim(name) AS name, nullif(trim(inat_login), '') AS inat_login
FROM read_csv('{{DETERMINER_REGISTER}}', header = true)
WHERE trim(name) <> '';

INSERT INTO inat_account (person_id, inat_user_id, login)
SELECT dp.person_id, u.uid, r.inat_login
FROM legacy_determiner_register r
JOIN legacy_determiner_person dp ON dp.alias = r.name
JOIN (
  SELECT userLogin, max(try_cast(userId AS BIGINT)) AS uid
  FROM legacy_occurrence
  WHERE try_cast(userId AS BIGINT) IS NOT NULL
  GROUP BY userLogin
) u ON u.userLogin = r.inat_login
WHERE r.inat_login IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM inat_account ia WHERE ia.person_id = dp.person_id)
  AND NOT EXISTS (SELECT 1 FROM inat_account ia WHERE ia.inat_user_id = u.uid)
-- The NOT EXISTS guards see the table before this INSERT, not the other
-- rows of it: dedup within the batch on both keys (person_id is the PK).
QUALIFY row_number() OVER (PARTITION BY u.uid ORDER BY r.name) = 1
    AND row_number() OVER (PARTITION BY dp.person_id ORDER BY r.name) = 1;

-- Curation surface: determiner strings the alias CSV doesn't cover yet.
CREATE OR REPLACE VIEW legacy_determiner_unresolved AS
SELECT trim(identifiedBy) AS identifiedBy, count(*) AS n
FROM legacy_promotable
WHERE trim(identifiedBy) <> ''
  AND trim(identifiedBy) NOT IN (SELECT alias FROM legacy_determiner_alias)
GROUP BY 1;

CREATE OR REPLACE VIEW legacy_expert_target AS
SELECT _id, sci AS verbatim, qualifier,
  CASE
    WHEN trinomial IS NOT NULL THEN 'subspecies'
    WHEN qualified_epithet IS NOT NULL AND base_genus IS NOT NULL THEN 'species'
    WHEN epithet IS NOT NULL AND base_genus IS NOT NULL THEN 'species'
    WHEN sub IS NOT NULL AND base_genus IS NOT NULL THEN 'subgenus'
    WHEN base_genus IS NOT NULL THEN 'genus'
    WHEN family IS NOT NULL THEN 'family'
    WHEN ord IS NOT NULL THEN 'order'
  END AS rank,
  CASE
    WHEN trinomial IS NOT NULL THEN trinomial
    WHEN qualified_epithet IS NOT NULL AND base_genus IS NOT NULL
      THEN concat(base_genus, ' ', qualified_epithet)
    WHEN epithet IS NOT NULL AND base_genus IS NOT NULL THEN concat(base_genus, ' ', epithet)
    WHEN sub IS NOT NULL AND base_genus IS NOT NULL THEN concat(base_genus, ' (', sub, ')')
    WHEN base_genus IS NOT NULL THEN base_genus
    WHEN family IS NOT NULL THEN family
    WHEN ord IS NOT NULL THEN ord
  END AS name
FROM legacy_det_taxa;

CREATE OR REPLACE VIEW legacy_volunteer_target AS
SELECT _id,
  CASE
    WHEN sp IS NOT NULL AND g IS NOT NULL THEN 'species'
    WHEN g IS NOT NULL THEN 'genus'
    WHEN f IS NOT NULL THEN 'family'
  END AS rank,
  CASE
    WHEN sp IS NOT NULL AND g IS NOT NULL THEN concat(g, ' ', sp)
    WHEN g IS NOT NULL THEN g
    WHEN f IS NOT NULL THEN f
  END AS name
FROM (
  SELECT _id,
    nullif(trim(familyVolDet), '')  AS f,
    nullif(trim(genusVolDet), '')   AS g,
    nullif(trim(speciesVolDet), '') AS sp
  FROM legacy_promotable
);

-- Promoted rows joined back to their specimen entity. The link is the staged
-- row's _id, not its legacy specimen number: promotion assigns numbers per
-- sample (see promote-legacy.sql), so the legacy number is no longer a key
-- into `specimen` once two legacy series merge into one sample.
CREATE OR REPLACE VIEW legacy_specimen_map AS
SELECT n._id, sp.entity_id AS specimen_id, pc.person_id AS collector_id
FROM legacy_specimen_number n
JOIN specimen sp ON sp.sample_id = n.sample_id AND sp.specimen_number = n.specimen_number
JOIN sample_primary_collector pc ON pc.sample_id = n.sample_id;

-- The verbatim name rides along with the node it resolved to: staging is
-- re-pullable today and frozen at cutover, after which this is the only
-- record of what the determiner actually wrote (beeline-tgu).
INSERT INTO determination (specimen_id, animal_id, qualifier,
                           verbatim_identification, sex, caste,
                           determiner_id, determiner_name, is_expert, channel)
SELECT s.specimen_id, an.entity_id, t.qualifier, t.verbatim,
       nullif(lower(trim(r.sex)), ''), nullif(lower(trim(r.caste)), ''),
       dp.person_id, nullif(trim(r.identifiedBy), ''), true, 'legacy_import'
FROM legacy_promotable r
JOIN legacy_expert_target t ON t._id = r._id AND t.rank IS NOT NULL
JOIN animal an ON an.rank = t.rank AND an.scientific_name = t.name
JOIN legacy_specimen_map s ON s._id = r._id
LEFT JOIN legacy_determiner_person dp ON dp.alias = trim(r.identifiedBy);

-- Volunteer determinations arrive already parted (familyVolDet/genusVolDet/
-- speciesVolDet), so there is no verbatim string to keep and none is invented.
INSERT INTO determination (specimen_id, animal_id, sex, caste,
                           determiner_id, is_expert, channel)
SELECT s.specimen_id, an.entity_id,
       nullif(lower(trim(r.sexVolDet)), ''), nullif(lower(trim(r.casteVolDet)), ''),
       s.collector_id, false, 'legacy_import'
FROM legacy_promotable r
JOIN legacy_volunteer_target t ON t._id = r._id AND t.rank IS NOT NULL
JOIN animal an ON an.rank = t.rank AND an.scientific_name = t.name
JOIN legacy_specimen_map s ON s._id = r._id;

-- Loud failure surface: rows asserting a taxon that failed to resolve.
CREATE OR REPLACE VIEW legacy_unresolved_determination AS
SELECT t._id, 'expert' AS channel, t.rank, t.name
FROM legacy_expert_target t
WHERE t.rank IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM animal a WHERE a.rank = t.rank AND a.scientific_name = t.name)
UNION ALL
SELECT t._id, 'volunteer', t.rank, t.name
FROM legacy_volunteer_target t
WHERE t.rank IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM animal a WHERE a.rank = t.rank AND a.scientific_name = t.name);
