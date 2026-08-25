-- The legacy usernames register: OBP-Server's hand-curated per-person file
-- (shared/data/usernames.csv, UsernamesService), keyed by iNat login. Fetched
-- by scripts/fetch-legacy.sh into gitignored data/legacy/ because it also
-- holds emails and mailing addresses — which is why the copy checked into
-- OBP-Server is a header and nothing else.
--
-- WHAT THIS TABLE DELIBERATELY OMITS: email, address, city, stateProvince,
-- zipPostal, country. A mailing address is a private satellite that does not
-- exist yet (beeline-1kb.6, ADR 0003), and until it does, the addresses stay
-- in the fetched file and out of beeline.duckdb. beeline-fie's address-derived
-- home-atlas list reads that file directly for the same reason: the store is
-- not the place to park data whose home has not been designed.
CREATE OR REPLACE TABLE legacy_username_register AS
SELECT lower(trim(userLogin))          AS login,
       nullif(trim(fullName), '')      AS full_name,
       nullif(trim(firstName), '')     AS given_name,
       nullif(trim(lastName), '')      AS family_name,
       nullif(trim(firstNameInitial), '') AS label_initial
FROM {{REGISTER_SOURCE}}
WHERE nullif(trim(userLogin), '') IS NOT NULL;
COMMENT ON TABLE legacy_username_register IS 'Legacy hand-curated name register keyed by iNat login (beeline-8t8). Name columns only — the file''s email and mailing-address columns are deliberately not staged here. A second opinion about names, not an authority: see legacy_register_name_conflict.';

-- One login, two names. Twenty logins repeat in the real register; most are a
-- person re-registering in a later season with the same name, which dedupes
-- to nothing. The rest disagree, and they disagree the same way the store
-- does: 'nflowers2' is Patricia Ellerby and Nancy Flowers, a household
-- sharing one login (beeline-oyl). A disagreeing login names nobody in
-- particular, so it is excluded from the comparison below rather than picked
-- between.
CREATE OR REPLACE VIEW legacy_register_ambiguous_login AS
SELECT login, count(*) AS register_rows,
       array_to_string(list_sort(list(DISTINCT full_name)), ' | ') AS names
FROM legacy_username_register
GROUP BY login
HAVING count(DISTINCT coalesce(full_name, '')) > 1;

-- Who the register cannot reach at all. It is keyed by iNat login, so a
-- person without one is invisible to it however well it knows the name — and
-- that is most co-collectors, who appear only inside somebody else's joint
-- recordedBy. This is the view behind the finding that the register fills no
-- missing name part: every person with NULL parts is in here.
CREATE OR REPLACE VIEW legacy_register_unreached AS
SELECT p.entity_id AS person_id, p.display_name,
       a.login,
       CASE WHEN a.person_id IS NULL THEN 'no iNat account'
            ELSE 'login absent from the register' END AS reason,
       p.given_name IS NULL AND p.family_name IS NULL AS parts_missing
FROM person p
LEFT JOIN inat_account a ON a.person_id = p.entity_id
WHERE NOT EXISTS (
  SELECT 1 FROM legacy_username_register r WHERE r.login = lower(a.login)
);

-- What the register says that the store does not — a worklist, not a merge.
--
-- The register was assumed authoritative when this was filed. Measured
-- against the real store it is not: of 414 people it matches, it fills no
-- missing name part at all (the 15 people with no parts have no login, so the
-- register cannot reach them), and it disagrees about 25. Some of those
-- disagreements are the register being right in a way promotion cannot see
-- ('MaryJo' → 'Mary Jo', which src/person-name.ts already cites as its worked
-- example); some are the register being plainly WRONG, which is the half
-- worth expecting — it says 'Hermann' for a woman whose login is 'mherrmann'
-- and whose iNat profile reads 'Mady Herrmann'; some are a nickname against a
-- formal name in both directions (Kim/Kimberly, but also William/Bill),
-- which is a question
-- about what a person calls themselves and not an error either way; some are
-- the register's own bad rows ('Heather Davis' whose firstName is 'Davis');
-- and one is a shared household login handing Tom Robertson the name Julie
-- Biddle. Overwriting from it would fix perhaps one name and break several.
--
-- The cheap adjudicator, where one exists, is the login. 'blancefield'
-- corroborates that Betsy Lane's fuller name really is Lancefield Lane — a
-- maiden name, not the street it reads as — though she signs 'Betsy Lane' on
-- all 37 of her records, which makes it hers to choose and not ours to fix.
-- 'mherrmann' settles Herrmann against the register. Where the login says
-- nothing — 'hailey_bird', for the Balock/Blalock question — nothing in this
-- store can settle it and the person has to be asked.
--
-- So it lands where every other name decision in this project lands: a human
-- reads the worklist and writes the verdicts into ingest/person-overlay.csv,
-- which is replayed onto every rebuild (ADR 0004). Same shape as
-- legacy_collector_duplicate_candidate and legacy_collector_alias_unused.
CREATE OR REPLACE VIEW legacy_register_name_conflict AS
WITH matched AS (
  SELECT p.entity_id AS person_id, a.login, p.display_name,
         p.given_name, p.family_name, p.label_name,
         r.full_name AS reg_full, r.given_name AS reg_given,
         r.family_name AS reg_family, r.label_initial AS reg_initial
  FROM person p
  JOIN inat_account a ON a.person_id = p.entity_id
  JOIN legacy_username_register r ON r.login = lower(a.login)
  WHERE r.login NOT IN (SELECT login FROM legacy_register_ambiguous_login)
), field_value AS (
  SELECT person_id, login, display_name, 'given_name' AS field,
         given_name AS store_value, reg_given AS register_value FROM matched
  UNION ALL
  SELECT person_id, login, display_name, 'family_name', family_name, reg_family FROM matched
  UNION ALL
  SELECT person_id, login, display_name, 'display_name', display_name, reg_full FROM matched
  UNION ALL
  -- The label form, and the only column the register holds that promotion
  -- cannot derive: firstNameInitial is almost always the mechanical first
  -- letter, but where it is not, it is a genuine override — 'Juan Manuel
  -- Benitez Alvarez' initialises to 'J.M.', which src/person-name.ts would
  -- render 'J.' See person.label_name.
  SELECT person_id, login, display_name, 'label_name',
         label_name,
         concat_ws(' ', reg_initial, reg_family)
  FROM matched
  WHERE reg_initial IS NOT NULL
    AND reg_initial <> concat(upper(left(coalesce(reg_given, ''), 1)), '.')
)
SELECT person_id, login, display_name, field, store_value, register_value
FROM field_value
WHERE register_value IS NOT NULL
  AND store_value IS DISTINCT FROM register_value;
