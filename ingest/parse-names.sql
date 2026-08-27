-- Taking a verbatim scientific name apart: the one place it happens.
--
-- Everything downstream — the animal nodes seed-animals.sql mints, both
-- determination targets in promote-determinations.sql, the survey below —
-- reads the outcome rather than parsing the string again. A parser is a pile
-- of assumptions about strings nobody here wrote, and the only way to know
-- which ones hold is to run it over all of them and read the residue
-- (beeline-qcd); test/legacy-name-parse.test.ts is that run, against strings
-- lifted from production staging.
--
-- Depends on legacy_promotable (promote-legacy.sql); read by seed-animals.sql
-- and promote-determinations.sql, both of which run after it.

-- ── Normalized determination taxonomy from staging ──────────────────────
-- Two rules here were wrong until the survey ran them over all 727 distinct
-- scientificName values in production staging:
--
-- * `authorship` is whatever follows the binomial, which on a trinomial is
--   the third epithet. Three species nodes carried one — Osmia montana
--   authored "montana", Bembix americana "spinolae", Colletes consors
--   "pascoensis" — and authorship prints on labels. Nomenclatural authorship
--   is a surname or a parenthesised one, so a remainder starting lowercase
--   is not authorship and is dropped.
-- * `taxonRank` is not to be trusted about subspecies: of the five trinomials
--   in the corpus it calls two of them 'Species' (Osmia montana montana,
--   Bembix americana spinolae), which would have landed those determinations
--   on the species node and dropped a third epithet a determiner wrote on
--   purpose. `trinomial` reads the name instead — this row's own genus and
--   epithet, then one more bare lowercase epithet — which excludes every
--   authorship (they capitalise), `Lasioglossum nr. tenax`, and the sp.N
--   morphospecies.
CREATE OR REPLACE VIEW legacy_det_taxa AS
SELECT * EXCLUDE (tail),
  -- Authorship only where the remainder looks like one: '(' or a capital.
  CASE WHEN regexp_matches(remainder, '^[(A-Z]') THEN remainder END AS authorship,
  -- A trinomial is this row's own genus and epithet followed by one more
  -- bare epithet — anchored on the parted columns rather than on the shape
  -- alone, which would read the string 'Not a bee' as a subspecies of Not a.
  CASE WHEN tail IS NOT NULL AND regexp_matches(tail, '^[a-z-]+$') THEN sci END AS trinomial,
  -- Open nomenclature: 'Lasioglossum nr. tenax' says the determiner got to a
  -- species and stopped short of asserting it. The parted columns are no help
  -- — specificEpithet is empty on these rows, which is how the intent used to
  -- be lost, the determination landing on the bare genus. Only nr. is attested
  -- in the corpus (3 records); cf. and aff. are the same construction and the
  -- glossary already teaches them (beeline-tgu).
  -- cfr. is a spelling of cf.; determination.qualifier's CHECK holds the
  -- three the domain distinguishes, so it normalises here rather than there.
  CASE regexp_extract(sci, '^[A-Z][a-z]+ (nr|cf|cfr|aff)\. [a-z-]+$', 1)
    WHEN 'nr'  THEN 'nr.'  WHEN 'cf'  THEN 'cf.'
    WHEN 'cfr' THEN 'cf.'  WHEN 'aff' THEN 'aff.' END AS qualifier,
  nullif(regexp_extract(sci, '^[A-Z][a-z]+ (?:nr|cf|cfr|aff)\. ([a-z-]+)$', 1), '') AS qualified_epithet
FROM (
  SELECT *,
    CASE WHEN base_genus IS NOT NULL AND epithet IS NOT NULL
          AND starts_with(sci, concat(base_genus, ' ', epithet, ' '))
         THEN substr(sci, length(base_genus) + length(epithet) + 3) END AS tail
  FROM (
    SELECT _id,
      nullif(trim("order"), '')                                    AS ord,
      nullif(trim(family), '')                                     AS family,
      nullif(regexp_extract(trim(genus), '^([A-Za-z]+)', 1), '')   AS base_genus,
      coalesce(nullif(trim(subgenus), ''),
               nullif(regexp_extract(trim(genus), '\(([A-Za-z]+)\)', 1), '')) AS sub,
      nullif(trim(specificEpithet), '')                            AS epithet,
      nullif(trim(scientificName), '')                             AS sci,
      taxonRank                                                    AS legacy_rank,
      -- What is left after a binomial, and only where there was one: with no
      -- epithet to consume, regexp_replace returns the string unchanged, and
      -- 'Andrenidae' would go on to look exactly like an authorship.
      CASE WHEN regexp_matches(trim(scientificName), '^[A-Za-z]+( \([A-Za-z]+\))? [a-z-]+')
           THEN nullif(trim(regexp_replace(trim(scientificName),
                            '^[A-Za-z]+( \([A-Za-z]+\))? [a-z-]+', '')), '') END AS remainder
    FROM legacy_promotable
  )
);

-- ── Parse survey: what the name rules do to every verbatim string ───────
-- One row per distinct scientificName in staging, with what came out of it.
-- The point is that the tail is visible rather than inferred: a parser is a
-- pile of assumptions about strings we did not write, and the only way to
-- know which ones hold is to run it over all of them and read the residue
-- (beeline-qcd). Everything not classified below is `unparsed`, which is the
-- row a test asserts about and a human reads.
--
-- What the corpus actually holds, measured 2026-08-27 over 727 distinct
-- names in 383,032 staged records:
--   binomial 455 · binomial with authorship 156 · uninomial 86
--   subgenus 3 · trinomial 5 · morphospecies 25 · qualified 1 · unparsed 1
-- The unparsed one is the string 'Not a bee' — which a shape-only trinomial
-- rule cheerfully read as a subspecies, and which anchoring on the parted
-- columns excludes.
CREATE OR REPLACE VIEW legacy_name_parse AS
SELECT sci, legacy_rank, count(*) AS records,
  base_genus, sub, epithet, authorship, trinomial,
  CASE
    WHEN trinomial IS NOT NULL                                      THEN 'trinomial'
    WHEN regexp_matches(sci, '\bsp+\.[0-9]')                       THEN 'morphospecies'
    WHEN qualified_epithet IS NOT NULL                              THEN 'qualified'
    WHEN regexp_matches(sci, '^[A-Za-z]+ \([A-Za-z]+\)$')           THEN 'subgenus'
    WHEN regexp_matches(sci, '^[A-Za-z]+$')                         THEN 'uninomial'
    WHEN authorship IS NOT NULL
     AND regexp_matches(sci, '^[A-Za-z]+( \([A-Za-z]+\))? [a-z-]+ ') THEN 'binomial with authorship'
    WHEN regexp_matches(sci, '^[A-Za-z]+( \([A-Za-z]+\))? [a-z-]+$') THEN 'binomial'
    ELSE 'unparsed'
  END AS parse
FROM legacy_det_taxa
WHERE sci IS NOT NULL
GROUP BY ALL;

-- ── The other verbatim fields, surveyed the same way ────────────────────
-- Scientific names are not the only strings promotion takes apart. This is
-- one row per assumption the other parsers make, counted, so a Mongo pull
-- that starts breaking one says so instead of quietly parsing it wrong. Read
-- it after `pnpm legacy:load`; the counts below are from 2026-08-27.
--
-- What it said then, and what each answer licenses:
--   recordedBy: 25,949 records use '|', and *nothing* uses '&', ',', ';' or
--     ' and '. So splitting on '|' alone is complete, and the matcher that
--     read 'B. & C. Durden' as three people cannot happen here.
--   month: 1,731 records spell the month in Roman numerals (VI, VII, IV,
--     VIII, V) beside the Arabic ones — legacy_month (promote-legacy.sql)
--     takes both, and an unparseable date is already a promotion finding.
--   url: 297,852 canonical, 41 on plain http, and 5 pointing at an iNat
--     *taxon* page rather than an observation. The trailing-digits rule
--     reads the first two right and yields nothing for the taxon pages,
--     which is the correct answer rather than a lucky one.
-- (Counts are over legacy_promotable, so they exclude the rows that never
-- became samples — the view answers "what do the strings we parse look
-- like", not "what is in Mongo".)
CREATE OR REPLACE VIEW legacy_verbatim_shape AS
SELECT 'recordedBy' AS field, 'pipe-separated' AS shape, count(*) AS records FROM legacy_promotable WHERE recordedBy LIKE '%|%'
UNION ALL SELECT 'recordedBy', 'other separator (& , ; and)', count(*) FROM legacy_promotable
  WHERE recordedBy LIKE '%&%' OR recordedBy LIKE '%,%' OR recordedBy LIKE '%;%' OR recordedBy LIKE '% and %'
UNION ALL SELECT 'recordedBy', 'non-ASCII', count(*) FROM legacy_promotable WHERE NOT regexp_matches(recordedBy, '^[\x20-\x7E]*$')
UNION ALL SELECT 'month', 'roman numeral', count(*) FROM legacy_promotable WHERE month <> '' AND try_cast(month AS INTEGER) IS NULL
UNION ALL SELECT 'url', 'canonical observation', count(*) FROM legacy_promotable WHERE regexp_matches(url, '^https://www\.inaturalist\.org/observations/[0-9]+$')
UNION ALL SELECT 'url', 'observation, other scheme or host', count(*) FROM legacy_promotable
  WHERE url <> '' AND url LIKE '%/observations/%' AND NOT regexp_matches(url, '^https://www\.inaturalist\.org/observations/[0-9]+$')
UNION ALL SELECT 'url', 'not an observation', count(*) FROM legacy_promotable WHERE url <> '' AND url NOT LIKE '%/observations/%';

-- Names carrying information the model has nowhere to put, so a determination
-- on one lands coarser than the determiner meant. Not a QC rule and not a
-- promotion finding: nobody typed these wrong, and no volunteer can fix them
-- (beeline-8g7). Qualified names used to be on this list — 'Lasioglossum nr.
-- tenax' landed on the bare genus, because the parted columns say nothing and
-- the string was all there was — and are not any more (beeline-tgu).
CREATE OR REPLACE VIEW legacy_name_flattened AS
SELECT sci, parse, records, concat_ws(' ', base_genus, epithet) AS lands_on
FROM legacy_name_parse
WHERE parse IN ('morphospecies', 'unparsed');
