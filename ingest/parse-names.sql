-- Taking a verbatim scientific name apart: the one place it happens. Pipeline
-- SQL, not schema: DuckDB-specific constructs (macros, SELECT * EXCLUDE,
-- GROUP BY, starts_with, regexp_matches, array_agg) are fine here per
-- ADR 0001.
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

-- The shape of a binomial: genus, an optional parenthesised subgenus, and a
-- lowercase epithet. Four rules ask about it — what authorship is left over,
-- and three of the survey's categories — so it is written once. Macros are
-- how the pipeline layer already shares SQL (legacy_month, legacy_date).
CREATE OR REPLACE MACRO binomial_prefix() AS '^[A-Za-z]+( \([A-Za-z]+\))? [a-z-]+';

-- ── Parts of a name, from whichever column wrote them ───────────────────
-- Three sources write names in columns rather than as one string: the expert
-- columns (genus, subgenus, specificEpithet), the volunteer ones
-- (familyVolDet, genusVolDet, speciesVolDet) and the staff taxonomy list
-- (family, genus, species). Each has put a subgenus in brackets somewhere the
-- parser did not look — the subgenus column says 'Andrena (Andrena)' on 2,888
-- rows, which seeding minted as 'Andrena (Andrena (Andrena))';
-- specificEpithet says '(Lasioglossum)'; genusVolDet and the staff list say
-- 'Xenoglossa (Peponapis)' — and a genus has arrived lowercase ('andrena') and
-- an epithet capitalised ('Mesillae'), each minting a taxon of its own
-- (beeline-45v.2). These are rules rather than a list because they are facts
-- about zoological names: a genus or subgenus is capitalised and an epithet
-- never is, and a bracketed name is a subgenus wherever it was written.
CREATE OR REPLACE MACRO name_capitalised(s) AS
  nullif(concat(upper(left(s, 1)), lower(substr(s, 2))), '');
CREATE OR REPLACE MACRO name_genus(s) AS
  name_capitalised(nullif(regexp_extract(trim(s), '^([A-Za-z]+)', 1), ''));
CREATE OR REPLACE MACRO name_bracketed(s) AS
  name_capitalised(nullif(regexp_extract(trim(s), '\(([A-Za-z]+)\)', 1), ''));
-- A subgenus column holds the bare name or the whole 'Genus (Subgenus)'.
CREATE OR REPLACE MACRO name_subgenus(s) AS
  coalesce(name_bracketed(s),
           name_capitalised(nullif(regexp_extract(trim(s), '^([A-Za-z]+)$', 1), '')));
CREATE OR REPLACE MACRO name_epithet(s) AS
  CASE WHEN regexp_matches(trim(s), '^\([A-Za-z]+\)$') THEN NULL
       ELSE nullif(lower(trim(s)), '') END;

-- What the rules cannot recognise is misspelling: 'Agopostemon',
-- 'Lassioglossum'. ingest/taxon-aliases.csv maps each to the name its writer
-- meant. A genus alias matches a genus column as written; a species alias
-- matches the genus and epithet as written, once case and brackets are
-- settled, and replaces both. `basis` says what a mapping rests on, as in
-- collector-aliases.csv. Spelling only: a gender ending or a name ITIS lacks
-- is a taxonomic choice, which belongs to beeline-45v.1 and not to this file.
-- One row per (rank, alias), because two lines claiming one spelling are a
-- mistake in the file, not a choice to make here.
CREATE TABLE legacy_taxon_alias AS
SELECT rank, alias, name, basis FROM (
  SELECT trim(rank) AS rank, trim(alias) AS alias, trim(name) AS name, trim(basis) AS basis,
         row_number() OVER (PARTITION BY trim(rank), trim(alias) ORDER BY trim(name)) AS rn
  FROM read_csv('{{TAXON_ALIASES}}', header = true,
                columns = {'rank': 'VARCHAR', 'alias': 'VARCHAR', 'name': 'VARCHAR', 'basis': 'VARCHAR'})
) deduped
WHERE rn = 1;

CREATE OR REPLACE MACRO legacy_genus_alias(s) AS
  coalesce((SELECT a.name FROM legacy_taxon_alias a WHERE a.rank = 'genus' AND a.alias = trim(s)), s);
CREATE OR REPLACE MACRO legacy_species_alias(g, e) AS
  (SELECT a.name FROM legacy_taxon_alias a WHERE a.rank = 'species' AND a.alias = concat_ws(' ', g, e));

-- ── Normalized determination taxonomy from staging ──────────────────────
-- Two rules here were wrong until the survey ran them over every distinct
-- scientificName value in production staging:
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
SELECT * EXCLUDE (tail, qual_tail),
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
  -- Both are gated on qual_tail, which anchors on this row's own genus the
  -- way trinomial does — without that a row whose genus column is empty
  -- yields a qualifier with no species to attach it to, and it would ride
  -- along on a family- or order-rank determination.
  CASE regexp_extract(qual_tail, '^(nr|cf|cfr|aff)\.', 1)
    WHEN 'nr'  THEN 'nr.'  WHEN 'cf'  THEN 'cf.'
    WHEN 'cfr' THEN 'cf.'  WHEN 'aff' THEN 'aff.' END AS qualifier,
  nullif(regexp_extract(qual_tail, '^(?:nr|cf|cfr|aff)\. ([a-z-]+)$', 1), '') AS qualified_epithet
FROM (
  SELECT *,
    CASE WHEN base_genus IS NOT NULL AND epithet IS NOT NULL
          AND starts_with(sci, concat(base_genus, ' ', epithet, ' '))
         THEN substr(sci, length(base_genus) + length(epithet) + 3) END AS tail,
    CASE WHEN base_genus IS NOT NULL AND starts_with(sci, concat(base_genus, ' '))
         THEN substr(sci, length(base_genus) + 2) END AS qual_tail
  FROM (
    -- A species alias replaces the genus and the epithet together.
    SELECT _id, ord, family,
      coalesce(split_part(species_alias, ' ', 1), base_genus) AS base_genus,
      sub,
      coalesce(split_part(species_alias, ' ', 2), epithet)    AS epithet,
      sci, legacy_rank, remainder
    FROM (
      SELECT *, legacy_species_alias(written_genus, epithet) AS species_alias
      FROM (
        SELECT _id,
          nullif(trim("order"), '')                                    AS ord,
          nullif(trim(family), '')                                     AS family,
          name_genus(genus)                                            AS written_genus,
          name_genus(legacy_genus_alias(genus))                        AS base_genus,
          -- The subgenus column first, then a bracket in the genus column, then
          -- one in the epithet column ('(Lasioglossum)', 72 records).
          coalesce(name_subgenus(subgenus),
                   name_bracketed(legacy_genus_alias(genus)),
                   name_bracketed(specificEpithet))                    AS sub,
          name_epithet(specificEpithet)                                AS epithet,
          nullif(trim(scientificName), '')                             AS sci,
          taxonRank                                                    AS legacy_rank,
          -- What is left after a binomial, and only where there was one: with no
          -- epithet to consume, regexp_replace returns the string unchanged, and
          -- 'Andrenidae' would go on to look exactly like an authorship.
          CASE WHEN regexp_matches(trim(scientificName), binomial_prefix())
               THEN nullif(trim(regexp_replace(trim(scientificName),
                                binomial_prefix(), '')), '') END AS remainder
        FROM legacy_promotable
      )
    )
  )
);

-- ── The volunteer columns, by the same rules ────────────────────────────
-- Volunteer determinations arrive parted (familyVolDet, genusVolDet,
-- speciesVolDet), and each place that used them used to read them raw, so
-- none of the rules above reached them. They carry no whole name, so there is
-- no verbatim string to keep beside them (promote-determinations.sql).
CREATE OR REPLACE VIEW legacy_vol_det_taxa AS
SELECT _id, family,
  coalesce(split_part(species_alias, ' ', 1), base_genus) AS base_genus,
  sub,
  coalesce(split_part(species_alias, ' ', 2), epithet)    AS epithet
FROM (
  SELECT *, legacy_species_alias(written_genus, epithet) AS species_alias
  FROM (
    SELECT _id,
      nullif(trim(familyVolDet), '')                  AS family,
      name_genus(genusVolDet)                         AS written_genus,
      name_genus(legacy_genus_alias(genusVolDet))     AS base_genus,
      name_bracketed(legacy_genus_alias(genusVolDet)) AS sub,
      name_epithet(speciesVolDet)                     AS epithet
    FROM legacy_promotable
  )
);

-- An alias line no staged row carries: a typo in the alias file itself, or a
-- spelling the source has since corrected. The same check
-- legacy_collector_alias_unused makes.
CREATE OR REPLACE VIEW legacy_taxon_alias_unused AS
SELECT a.rank, a.alias, a.name, a.basis
FROM legacy_taxon_alias a
WHERE NOT EXISTS (
  SELECT 1 FROM legacy_promotable p
  WHERE (a.rank = 'genus' AND a.alias IN (trim(p.genus), trim(p.genusVolDet)))
     OR (a.rank = 'species' AND a.alias IN (
          concat_ws(' ', name_genus(p.genus), name_epithet(p.specificEpithet)),
          concat_ws(' ', name_genus(p.genusVolDet), name_epithet(p.speciesVolDet))))
);

-- ── Parse survey: what the name rules do to every verbatim string ───────
-- One row per distinct scientificName in staging, with what came out of it.
-- The point is that the tail is visible rather than inferred: a parser is a
-- pile of assumptions about strings we did not write, and the only way to
-- know which ones hold is to run it over all of them and read the residue
-- (beeline-qcd). Everything not classified below is `unparsed`, which is the
-- row a test asserts about and a human reads.
--
-- What the corpus actually holds, measured 2026-08-27 over the 725 distinct
-- names in legacy_promotable (383,032 rows are staged; the ones that never
-- became samples are not names this pipeline parses):
--   binomial 455 · binomial with authorship 156 · uninomial 79
--   subgenus 3 · trinomial 5 · morphospecies 25 · qualified 1 · unparsed 1
-- Those sum to 725, and a category count that stops summing to the corpus
-- size is the first sign the grouping has drifted — it did once already.
-- The unparsed one is the string 'Not a bee' — which a shape-only trinomial
-- rule cheerfully read as a subspecies, and which anchoring on the parted
-- columns excludes.
CREATE OR REPLACE VIEW legacy_name_parse AS
SELECT sci, records, legacy_ranks,
  base_genus, sub, epithet, authorship, trinomial,
  CASE
    WHEN trinomial IS NOT NULL                                      THEN 'trinomial'
    WHEN regexp_matches(sci, '\bsp+\.[0-9]')                       THEN 'morphospecies'
    WHEN qualified_epithet IS NOT NULL                              THEN 'qualified'
    WHEN regexp_matches(sci, '^[A-Za-z]+ \([A-Za-z]+\)$')           THEN 'subgenus'
    WHEN regexp_matches(sci, '^[A-Za-z]+$')                         THEN 'uninomial'
    WHEN authorship IS NOT NULL
     AND regexp_matches(sci, concat(binomial_prefix(), ' ')) THEN 'binomial with authorship'
    WHEN regexp_matches(sci, concat(binomial_prefix(), '$')) THEN 'binomial'
    ELSE 'unparsed'
  END AS parse
FROM (
  -- One row per distinct name, which is what the header promises and what
  -- makes the counts add up. GROUP BY ALL grouped by the parted columns and
  -- legacy_rank too, so a name spelled once but staged with two taxonRank
  -- values was two rows and the categories summed past the corpus size. The
  -- ranks a name arrives under are worth seeing — that disagreement is how
  -- the trinomial bug surfaced — so they are collected rather than grouped by.
  SELECT sci, count(*) AS records,
         list_sort(array_agg(DISTINCT nullif(legacy_rank, ''))) AS legacy_ranks,
         any_value(base_genus) AS base_genus, any_value(sub) AS sub,
         any_value(epithet) AS epithet, any_value(authorship) AS authorship,
         any_value(trinomial) AS trinomial,
         any_value(qualified_epithet) AS qualified_epithet
  FROM legacy_det_taxa WHERE sci IS NOT NULL GROUP BY sci
);

-- ── The other verbatim fields, surveyed the same way ────────────────────
-- Scientific names are not the only strings promotion takes apart. This is
-- one row per assumption the other parsers make, counted, so a Mongo pull
-- that starts breaking one says so instead of quietly parsing it wrong. It
-- reads legacy_promotable, so it answers after `pnpm legacy:promote`, not
-- after the load; the counts below are from 2026-08-27.
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
UNION ALL SELECT 'url', 'not an observation', count(*) FROM legacy_promotable WHERE url <> '' AND url NOT LIKE '%/observations/%'
-- Two more verbatim fields, both of which already answer through a worklist
-- rather than a rule — an identifiedBy the alias CSV does not cover is
-- legacy_determiner_unresolved (promote-determinations.sql, which runs after
-- this file, so it is named rather than joined), and a date that will not
-- parse is a bad_date promotion finding. Sized here so the survey says how
-- much there is to work through without anyone going looking.
UNION ALL SELECT 'identifiedBy', 'named', count(*) FROM legacy_promotable WHERE trim(identifiedBy) <> ''
UNION ALL SELECT 'verbatimEventDate', 'present', count(*) FROM legacy_promotable WHERE trim(verbatimEventDate) <> ''
UNION ALL SELECT 'verbatimEventDate', 'date did not parse',
  (SELECT count(*) FROM legacy_promotion_finding WHERE rule = 'bad_date');

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
