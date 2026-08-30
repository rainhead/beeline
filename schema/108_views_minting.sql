-- Turning an observation into a sample (beeline-oyq).
--
-- Until this file existed, ingest/promote-observations.sql started every join
-- from a sample that already existed, so observation promotion was a
-- provenance UPGRADE on records the legacy Mongo dump had already supplied
-- and never a source of records. An observation with no matching legacy row
-- was synced, shredded into observation_field, and stopped there — 6,105 of
-- them on the dev store, 1,625 of those in the open season against 4,480 in
-- settled ones, the newest five days old. At cutover the legacy
-- import freezes and iNaturalist becomes the only entry point, so a season
-- collected after the freeze would have been invisible end to end rather
-- than visibly broken.
--
-- Everything here is a view because the reconcile has several readers that
-- must agree: ingest/mint-samples.sql writes from it, beeline-e85's unclaimed
-- screen reads the residue, and the alarms below are how "the tie-break never
-- had to fire" stays checkable rather than assumed.

-- ── The street-suffix predicate, stated once ─────────────────────────────
-- The same seventeen words in two places now: qc_rule_locality_format
-- (schema/120) judges a locality a sample already carries, and
-- observation_locality below picks one that does not exist yet. A word list
-- duplicated across two files is a word list that will one day be two word
-- lists — and there is a live edit pending against it (beeline-4dt: `st` is
-- the abbreviation for Street, so "St Helens" reads as a street address),
-- which must land in one place and take both readers with it.
--
-- A one-row view rather than a macro for the reason elevation_derivation_limit
-- gives (schema/170): ADR 0001 keeps schema SQL portable and a DuckDB macro
-- is not.
--
-- The pattern requires each word to stand alone between spaces, and its
-- reader is expected to have normalised the text the way qc_rule_locality_format
-- does — lowercased, commas and periods to spaces, wrapped in spaces.
-- regexp_matches is one of ADR 0001's two named dialect exceptions.
CREATE VIEW locality_street_suffix_pattern AS
SELECT ' (road|rd|street|str|st|avenue|ave|av|drive|dr|boulevard|blvd|court|ct|lane|ln|county) ' AS pattern;
COMMENT ON VIEW locality_street_suffix_pattern IS 'The street-suffix word list, in one place, read by qc_rule_locality_format (schema/120) and observation_locality. A one-row view rather than a macro because ADR 0001 keeps schema SQL portable.';

-- ── The locality a minted sample carries ─────────────────────────────────
-- place_guess is not raw geocoder output to be discarded: shaping it is part
-- of the volunteer's collecting workflow, and the reference implementation
-- reads it as the designed input to locality
-- (OccurrenceService.parseLocalityFromPlaceGuess). That rule produced the
-- corpus we have — of 45,906 linked samples whose place_guess has three
-- parts, 38,212 carry exactly its first component.
--
-- This is NOT that rule. The reference takes component 1 only when there are
-- EXACTLY three and otherwise wraps the whole string in quotes, which refuses
-- two shapes that are not dirty data at all: a hand-typed place name with no
-- commas ('Steigerwald NWR'), and a four-part guess whose second component is
-- the town ('Peckham Rd, Wilder, ID, US' -> 'Wilder'). Measured over the
-- samples a first minting pass creates, split at season.started_on
-- (schema/160): the reference rule yields a usable locality for 24% of the
-- settled seasons and 68% of the open one; this rule yields 66% (596 of 903)
-- and 86% (445 of 518).
--
-- So: the FIRST comma-separated component that reads like a place name.
-- Each clause was measured against the corpus rather than supposed —
--
--   2..18 characters   the length qc_rule_locality_format already enforces,
--                      so a longer component would be written only to be
--                      flagged on the same promotion run. It costs the
--                      single-component garden names ('Leach Botanical
--                      Garden', 22 chars), which arrive as
--                      missing_required_field instead and are the
--                      volunteer's to shorten upstream — and it costs them
--                      only in the past: 166 settled samples against 0 in the
--                      open season, so current practice does not write that
--                      shape at all.
--   no street suffix   the shared pattern above. Also what refuses
--                      county-only guesses, `county` being one of the words.
--   no postcode        a run of five digits.
--   no house number    a component starting with a digit: '3334 NW Covey
--                      Run' carries no listed suffix and would otherwise
--                      pass at 17 characters.
--   not administrative a component naming a state or a country is not a
--                      locality. Data-driven off atlas_region plus the
--                      country spellings place_guess actually writes, and
--                      off the observation's OWN country and state names —
--                      which is what lets 'Oregon' be a locality in
--                      Wisconsin and not in Oregon.
--
-- The administrative clause is why this is not a pure string function: 1,620
-- of the 1,624 two- and three-letter components in the corpus are state or
-- country codes ('US' 615, 'OR' 362, 'USA' 250). The three that are not are
-- real ('Bly', 'TFO', 'Mae'), which is the argument for a lookup rather than
-- a blanket length floor that would refuse them.
--
-- What it refuses is genuinely coarse and belongs to the volunteer, who fixes
-- it upstream on iNaturalist where the next sync collects it: over the 2026
-- mint set the refusals are state-only ('Oregon, US', 25), county-only
-- ('Linn County, US-OR, US', 8) and country-only ('United States', 2) —
-- with one exception, 'St Helens, OR, US', which is beeline-4dt's inherited
-- defect and not this rule's. Six of the 1,421 minted samples are refused a
-- locality for that reason alone — and unlike everything else here that count
-- does NOT fall away with the wild west: 4 of the 6 are open-season records
-- against 2 settled, so it is live work rather than residue. Fixing the word
-- list above fills them in on the next promotion, because the descriptive
-- fields are a fill-only refresh (ingest/mint-samples.sql) rather than
-- written once.
CREATE VIEW observation_locality AS
WITH guess AS (
  -- Private first, exactly as observation_place and the coordinate rule do.
  SELECT f.inat_id,
         coalesce(nullif(trim(f.private_place_guess), ''),
                  nullif(trim(f.place_guess), '')) AS text
  FROM observation_field f
),
component AS (
  SELECT g.inat_id, c.position, trim(c.part) AS part
  FROM guess g,
  LATERAL (SELECT unnest(str_split_regex(g.text, ',\s*'))                  AS part,
                  generate_subscripts(str_split_regex(g.text, ',\s*'), 1)  AS position) c
  WHERE g.text IS NOT NULL
),
usable AS (
  SELECT c.inat_id, c.position, c.part
  FROM component c
  WHERE length(c.part) BETWEEN 2 AND 18
    AND NOT regexp_matches(
          concat(' ', replace(replace(lower(c.part), ',', ' '), '.', ' '), ' '),
          (SELECT pattern FROM locality_street_suffix_pattern))
    AND NOT regexp_matches(c.part, '[0-9]{5}')
    AND NOT regexp_matches(c.part, '^[0-9]')
    AND upper(c.part) NOT IN (SELECT state_province FROM atlas_region)
    AND upper(c.part) NOT IN (SELECT country FROM atlas_region)
    AND upper(c.part) NOT IN ('US', 'CA', 'MX', 'UNITED STATES', 'CANADA', 'MEXICO')
    AND NOT regexp_full_match(upper(c.part), '(US|CA)-[A-Z]{2}')
    AND NOT EXISTS (SELECT 1 FROM observation_place p
                    WHERE p.inat_id = c.inat_id
                      AND (upper(c.part) = upper(p.country_name)
                        OR upper(c.part) = upper(p.state_name)))
)
SELECT inat_id, part AS locality, position AS component
FROM (SELECT u.*, row_number() OVER (PARTITION BY u.inat_id ORDER BY u.position) AS rn FROM usable u) ranked
WHERE rn = 1;
COMMENT ON VIEW observation_locality IS 'The locality a sample minted from an observation carries: the first comma-separated component of its (private-preferred) place_guess that reads like a place name. An observation with no such component is absent here, and the sample it mints blocks honestly as missing_required_field — which the volunteer fixes upstream on iNaturalist, as SOP.';

-- ── Which observations are samples ───────────────────────────────────────
-- A sample number and a positive specimen count and a date. Count zero is
-- the project's own signal that nothing was collected — the reference
-- implementation's fan-out yields no rows for those either — so it is not a
-- gap to be flagged but an observation that is not a collection record.
--
-- Shared with beeline-e85's unclaimed screen deliberately, so that "which
-- observations are samples" has one answer rather than two that drift.
CREATE VIEW observation_sample_candidate AS
SELECT f.inat_id,
       f.user_id,
       f.user_login,
       trim(f.sample_number_raw)                  AS sample_number,
       try_cast(f.specimen_count_raw AS INTEGER)  AS specimen_count,
       f.observed_on
FROM observation_field f
WHERE nullif(trim(f.sample_number_raw), '') IS NOT NULL
  AND try_cast(f.specimen_count_raw AS INTEGER) > 0
  AND f.observed_on IS NOT NULL;
COMMENT ON VIEW observation_sample_candidate IS 'An observation the project''s own fields say is a collection record: a non-blank sample number, a positive specimen count, and a date. The single definition of "which observations are samples", read by minting and by the unclaimed screen.';

-- An observation carrying a sample number that fails the rest of the test.
-- Not a QC rule: a finding is keyed to a sample (schema/050) and these have
-- none, which is the whole point of them.
CREATE VIEW observation_sample_unusable AS
SELECT f.inat_id, f.user_id, f.user_login, f.observed_on,
       f.sample_number_raw, f.specimen_count_raw,
       concat_ws('; ',
         CASE WHEN f.specimen_count_raw IS NULL THEN 'no specimen count' END,
         CASE WHEN f.specimen_count_raw IS NOT NULL
               AND try_cast(f.specimen_count_raw AS INTEGER) IS NULL
              THEN concat('specimen count ''', f.specimen_count_raw, ''' is not a number') END,
         CASE WHEN try_cast(f.specimen_count_raw AS INTEGER) = 0 THEN 'specimen count is zero' END,
         -- Six on the dev store, 1 open-season and 5 settled. Without an arm
         -- of their own they
         -- fall out of the candidate set correctly and arrive here with an
         -- EMPTY reason, which is worse than either answer: the unclaimed
         -- screen shows a record with nothing said about it.
         CASE WHEN try_cast(f.specimen_count_raw AS INTEGER) < 0
              THEN concat('specimen count ', f.specimen_count_raw, ' is negative') END,
         CASE WHEN f.observed_on IS NULL THEN 'no observed date' END
       ) AS reason
FROM observation_field f
WHERE nullif(trim(f.sample_number_raw), '') IS NOT NULL
  -- coalesce, not a bare NOT: with no count at all the comparison is NULL,
  -- `NULL AND true` is NULL, and NOT NULL is NULL — so the row an absent
  -- count should put here would have been dropped from both this view and
  -- the candidate set, and gone missing entirely. Three-valued logic, and
  -- the same shape of mistake the blank-sampleId coalesce made in
  -- schema/105.
  AND NOT coalesce(try_cast(f.specimen_count_raw AS INTEGER) > 0
                   AND f.observed_on IS NOT NULL, false);
COMMENT ON VIEW observation_sample_unusable IS 'An observation that names a sample number and cannot become a sample: no specimen count, an unparseable one, a count of zero (nothing was collected), or no date.';

-- A collection record whose observer the store cannot resolve to a person.
-- These are NOT minted: sample.collector_id is NOT NULL, and a placeholder
-- person would be a person the roster then has to explain. They are staged
-- here instead, which is what beeline-e85's per-atlas unclaimed screen reads.
CREATE VIEW observation_sample_unresolved AS
SELECT c.*
FROM observation_sample_candidate c
WHERE NOT EXISTS (SELECT 1 FROM inat_account a WHERE a.inat_user_id = c.user_id)
  AND NOT EXISTS (SELECT 1 FROM sample s WHERE s.inat_observation_id = c.inat_id);
COMMENT ON VIEW observation_sample_unresolved IS 'A collection record from an iNaturalist user the store holds no account for: nothing mints it, because sample.collector_id is NOT NULL and a placeholder person is worse than a queue. The unclaimed-samples screen (beeline-e85) reads this.';

-- ── The reconcile ────────────────────────────────────────────────────────
-- Every unlinked candidate whose observer resolves, grouped into the sample
-- it belongs to. An observation already named by some sample's
-- inat_observation_id is excluded before grouping: once linked, THE LINK IS
-- THE IDENTITY, which is what stops an upstream edit to a sampleId minting a
-- second sample for a collecting event that already exists (the reference
-- implementation's sha256-primary-key bug).
CREATE VIEW sample_mint_group AS
SELECT a.person_id,
       c.sample_number,
       c.observed_on,
       CAST(count(*) AS INTEGER)      AS observations,
       -- Lowest id where the group holds several, as legacy_sample_map's
       -- arg_min does: arbitrary but stable, and stability is the property
       -- that matters when the choice decides which observation a sample
       -- cites.
       min(c.inat_id)                 AS lead_inat_id,
       CAST(sum(c.specimen_count) AS INTEGER) AS specimen_count
FROM observation_sample_candidate c
JOIN inat_account a ON a.inat_user_id = c.user_id
WHERE NOT EXISTS (SELECT 1 FROM sample s WHERE s.inat_observation_id = c.inat_id)
GROUP BY a.person_id, c.sample_number, c.observed_on;
COMMENT ON VIEW sample_mint_group IS 'Unlinked collection records grouped into the sample each belongs to, by (collector, sample number, date). Specimen count is the group total; lead_inat_id is the observation the sample will cite.';

-- Which existing sample, if any, a group is already recorded as.
--
-- THE KEY IS A DATE RANGE, NOT date_start. legacy_sample_map derives
-- kind='trap' from the presence of a second date, so a trap sample spans a
-- range and its observation is dated on the END. Keying on date_start misses
-- 20 samples whose observed_on falls strictly inside [date_start, date_end],
-- and all 20 cite no observation — so they are free links that would instead
-- have become duplicate collecting events, invisible because
-- qc_rule_duplicate_sample_number (schema/120) also groups on date_start.
-- "Cannot manufacture a duplicate finding" is not a safety property when the
-- finding is blind to the failure mode.
CREATE VIEW sample_mint_match AS
SELECT g.person_id, g.sample_number, g.observed_on, g.lead_inat_id,
       s.entity_id AS sample_id,
       s.inat_observation_id
FROM sample_mint_group g
JOIN sample s ON s.collector_id = g.person_id
             AND s.sample_number = g.sample_number
             AND g.observed_on BETWEEN s.date_start AND s.date_end;
COMMENT ON VIEW sample_mint_match IS 'A group of unlinked observations against the existing sample it is already recorded as, keyed on the collector, the sample number, and the observed date falling inside the sample''s date range.';

-- A group matching more than one existing sample.
--
-- In observation_place_ambiguous's idiom (schema/107) and for the same
-- reason: the reconcile has to do something definite here, and what it does
-- is refuse — neither linking nor minting — because attaching an observation
-- to the wrong collecting event is silent, and minting a third sample for a
-- number two samples already carry manufactures the duplicate it was trying
-- to avoid.
--
-- Three on the dev store, none in the open season: all one collector, all
-- trap samples of the same number with overlapping ranges — pre-existing
-- duplicate collecting events
-- that qc_rule_duplicate_sample_number cannot see because it groups on
-- date_start. Refusing names them; a test asserts nothing more than that the
-- refusal is what happens.
CREATE VIEW sample_mint_ambiguous AS
SELECT person_id, sample_number, observed_on, lead_inat_id,
       CAST(count(*) AS INTEGER) AS samples,
       array_to_string(list_sort(list(sample_id)), ' | ') AS sample_ids
FROM sample_mint_match
GROUP BY person_id, sample_number, observed_on, lead_inat_id
HAVING count(*) > 1;
COMMENT ON VIEW sample_mint_ambiguous IS 'A group of unlinked observations that matches two or more existing samples. Neither linked nor minted — the store already holds duplicate collecting events under that number, and picking one silently would be worse than saying so.';

-- A group whose sample exists and cites no observation yet: free evidence.
--
-- ONE ROW PER SAMPLE, and the tie-break is not a formality. sample_mint_group
-- groups by observed_on, so a trap sample spanning several days matches one
-- group per day its observations fall on: two on the dev store, both settled,
-- both trap samples running 2019-08-08 to 2019-08-10 with an observation when the trap
-- went in and another when it came out. Both belong to the sample and
-- inat_observation_id can hold one, so something has to choose — and
-- `UPDATE ... FROM` with several source rows for one target does not: DuckDB
-- deduplicates to an arbitrary match, unspecified as in Postgres and SQLite.
-- Left alone, which observation a sample cites — and therefore its
-- coordinates, its geoprivacy and its host taxon — would be settled by
-- whatever the join happened to emit, differently on a re-promotion or a
-- db:reseed, with nothing to show for the change. That is the same objection
-- observation_place's tie-break comment makes (schema/107).
--
-- Lowest inat_id, as everywhere else here and as legacy_sample_map's arg_min
-- does: arbitrary, but STABLE, which is the property that matters. (Preferring
-- the observation dated on date_end — a trap's retrieval, the one that
-- actually carries the catch — is arguable and is a domain claim nobody has
-- made; noted here so choosing the id stays a choice rather than an oversight.)
-- The group not chosen is not lost: it matches the sample on the next run,
-- finds it citing another observation, and is left alone, which is what
-- sample_multi_observation names.
CREATE VIEW sample_mint_free_link AS
SELECT sample_id, lead_inat_id, person_id, sample_number, observed_on
FROM (
  SELECT m.sample_id, m.lead_inat_id, m.person_id, m.sample_number, m.observed_on,
         row_number() OVER (PARTITION BY m.sample_id ORDER BY m.lead_inat_id) AS rn
  FROM sample_mint_match m
  WHERE m.inat_observation_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM sample_mint_ambiguous a
                    WHERE a.person_id = m.person_id
                      AND a.sample_number = m.sample_number
                      AND a.observed_on = m.observed_on)
) ranked
WHERE rn = 1;
COMMENT ON VIEW sample_mint_free_link IS 'An existing sample that cites no observation and whose collector, number and date range an unlinked observation matches: the link is free, and it is what carries believed-true coordinates and geoprivacy onto a record the legacy dump supplied without them.';

-- What minting actually creates: a group that matches no existing sample.
CREATE VIEW sample_mint_pending AS
SELECT g.*
FROM sample_mint_group g
WHERE NOT EXISTS (SELECT 1 FROM sample_mint_match m
                  WHERE m.person_id = g.person_id
                    AND m.sample_number = g.sample_number
                    AND m.observed_on = g.observed_on);
COMMENT ON VIEW sample_mint_pending IS 'The samples ingest/mint-samples.sql will create on its next run: a collecting event iNaturalist evidences and the store does not hold.';

-- A sample whose state names an atlas and which carries none, with no human
-- having placed it deliberately.
--
-- This exists because nothing can repair it. DuckDB will not update an
-- indexed column on a row an incoming foreign key references, and
-- sample.atlas_id is a foreign key with a sample_collector row pointing at
-- every sample — so the atlas is set at INSERT and never afterwards
-- (ingest/mint-samples.sql). A sample minted before pnpm inat:fetch-places
-- had run would land here permanently, which is why the reseed recipe fetches
-- places first. Empty on the dev store, and a test says so.
CREATE VIEW sample_atlas_unfilled AS
SELECT s.entity_id AS sample_id, s.state_province, reg.atlas_id AS should_be
FROM sample s
JOIN atlas_region reg ON reg.state_province = s.state_province
WHERE s.atlas_id IS NULL
  AND s.atlas_assigned_by IS NULL
  AND reg.atlas_id IS NOT NULL;
COMMENT ON VIEW sample_atlas_unfilled IS 'A sample in a member atlas''s region carrying no atlas, which no UPDATE can fix: DuckDB will not write an indexed column on a row an incoming foreign key references, so sample.atlas_id is set when the row is inserted or never. Empty, and meant to stay that way.';

-- ── What the scalar link cannot say ──────────────────────────────────────
-- sample.inat_observation_id stays scalar (no sample_observation list), which
-- is what makes minting never rewrite an existing sample and so what protects
-- a staff edit to any field minting writes. These two views are the cost of
-- that decision, made visible rather than argued away.

-- A sample evidenced by more than one observation. It cites one of them, and
-- its specimen_count is the total over all of them, so
-- qc_rule_count_mismatch — which compares against the ONE cited observation
-- — reports a disagreement in which both sides are right. 33 minted samples
-- are born flagged this way, 12 of them in the open season and 21 settled. The finding is a warning, not a block, and this
-- is what explains it; teaching the rule to sum would take count_mismatch
-- from 1,121 findings to 1,959 across the existing corpus, which is a change
-- to a live rule and not this step's to make.
CREATE VIEW sample_multi_observation AS
SELECT s.entity_id AS sample_id, s.inat_observation_id AS cited_inat_id,
       CAST(count(*) AS INTEGER) AS other_observations,
       CAST(sum(c.specimen_count) AS INTEGER) AS other_specimen_count
FROM sample s
JOIN inat_account a ON a.person_id = s.collector_id
JOIN observation_sample_candidate c ON c.user_id = a.inat_user_id
                                   AND c.sample_number = s.sample_number
                                   AND c.observed_on BETWEEN s.date_start AND s.date_end
WHERE s.inat_observation_id IS NOT NULL
  AND c.inat_id <> s.inat_observation_id
GROUP BY s.entity_id, s.inat_observation_id;
COMMENT ON VIEW sample_multi_observation IS 'A sample whose collecting event iNaturalist records in several observations. It cites one; a scalar link cannot say more. This is what explains a count_mismatch finding on a sample whose count is right.';

-- A sample whose cited observation no longer says what the sample does.
-- Minting never rewrites number, date or count, so an upstream edit after
-- the sample exists is silent. This is that silence, named.
CREATE VIEW sample_observation_number_mismatch AS
SELECT s.entity_id AS sample_id, s.inat_observation_id,
       s.sample_number, trim(f.sample_number_raw) AS observation_sample_number,
       s.date_start, s.date_end, f.observed_on,
       concat_ws('; ',
         CASE WHEN trim(f.sample_number_raw) IS DISTINCT FROM s.sample_number
              THEN concat('observation says number ''', f.sample_number_raw,
                          ''', sample says ''', s.sample_number, '''') END,
         CASE WHEN f.observed_on NOT BETWEEN s.date_start AND s.date_end
              THEN concat('observation dated ', f.observed_on,
                          ', outside ', s.date_start, '..', s.date_end) END
       ) AS details
FROM sample s
JOIN observation_field f ON f.inat_id = s.inat_observation_id
WHERE nullif(trim(f.sample_number_raw), '') IS NOT NULL
  AND (trim(f.sample_number_raw) IS DISTINCT FROM s.sample_number
    OR f.observed_on NOT BETWEEN s.date_start AND s.date_end);
COMMENT ON VIEW sample_observation_number_mismatch IS 'A sample whose evidencing observation now reports a different sample number or a date outside its range — the cost of never rewriting an existing sample, made visible instead of silent. Descriptive, not a QC rule: which side is right is a staff judgement.';
