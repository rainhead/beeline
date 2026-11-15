-- Migration for schema/111 and schema/067: the host names of samples that
-- have a name and no iNaturalist id are looked up like the plant list's names
-- (beeline-rfkj.5).
--
-- Two views are new: plant_name_wanted (the names to match, from the list and
-- from the hosts) and plant_name_shape (the one rule for a name's expected
-- rank, which plant_list_entry_name used to hold). plant_name_normal now reads
-- the wanted names and collapses any whitespace and the mangled hybrid sign;
-- plant_list_entry_name reads plant_name_shape; plant_name_resolution and
-- plant_name_unlooked read every wanted name, and plant_name_resolution gains
-- by_own_name. Each changed view is dropped and made again, as 0095 did.
--
-- Nothing is stored or deleted. The plant-names job (src/app/jobs/registry.ts)
-- finds the hosts' names on its worklist at its next run, 300 requests a night.

DROP VIEW plant_name_normal;

-- THE NAMES TO MATCH. Two sources ask the same question of iNaturalist, which
-- taxon a scientific name is, and are answered by the same lookups:
--   list  the plant list's scientific names;
--   host  the host name of each sample that has a name and no iNaturalist id:
--         3,159 samples and 862 names on production's store of 2026-11-15,
--         nearly all from the seasons before iNaturalist carried the host
--         (old Beeline's speciesPlant, schema/030). A sample with an id is
--         not here: its id is its host (sample_host, schema/116).
-- A name in both is one row per source here and one lookup (the lookup is
-- keyed by the normalised name, not by where it came from). A host name that
-- later leaves (its sample gains an id) keeps its lookup, whose hits go on
-- feeding the taxon cache's worklist (inat_taxon_uncached): a few taxa read
-- for nothing, which is harmless and cheaper than tracking who still wants
-- them.
CREATE VIEW plant_name_wanted AS
SELECT scientific_name AS raw_name, 'list' AS source FROM plant_list_entry
UNION
SELECT host_name_as_observed, 'host' FROM sample
WHERE host_inat_taxon_id IS NULL AND host_name_as_observed IS NOT NULL;
COMMENT ON VIEW plant_name_wanted IS 'Every name to be matched to an iNaturalist taxon, as written, with where it came from: list (a plant list entry''s scientific name) or host (the host name of a sample that has no host id). A name from both sources has a row for each.';

-- THE ONE NORMALISATION. A plant name, as the list, a sample or iNaturalist
-- wrote it, reduced to what two spellings of the same name share:
--   - case is ignored;
--   - the hybrid sign is dropped, because the list writes Mentha piperita
--     where iNaturalist writes Mentha × piperita. A sign mangled by being
--     read in the wrong character set, 'Ã—' (the UTF-8 bytes of × read as
--     Windows-1252), is the hybrid sign too: one sample writes Reynoutria
--     Ã— bohemica (production, 2026-11-15);
--   - var., ssp. and subsp. are dropped, because iNaturalist writes a
--     trinomial without them (Carduus pycnocephalus cinereus);
--   - any run of whitespace becomes one space: one sample's host is
--     'Agastache' and 'urticifolia' with a space and a line break between.
-- The kinds of name it is applied to are the names to match and what
-- iNaturalist returned (the name of a hit, and its matched_term), so the
-- rule is stated once here and the sides cannot drift. An 'x' written as a
-- hybrid sign is not handled: neither the list nor a host name has one
-- (checked on 2026-11-13 and 2026-11-15).
--
-- A doubtful or open name is not trimmed: 'Salix sp.', 'Salix spp.', 'Salix
-- cf. scouleri' and 'Salix?' keep their tails, and so never equal the name of
-- a hit (plant_name_hit_current) and come to no match, for a person to decide
-- (beeline-rfkj.6). None of the list's names or the hosts has such a tail
-- (2026-11-15), iNaturalist never writes one, and reading 'cf.' or '?' as the
-- name it qualifies would assert what the collector doubted.
CREATE VIEW plant_name_normal AS
SELECT raw_name,
       trim(regexp_replace(
         regexp_replace(
           regexp_replace(lower(raw_name), '×|ã—', ' ', 'g'),
           '(^|[[:space:]])(var|ssp|subsp)\.', ' ', 'g'),
         '[[:space:]]+', ' ', 'g')) AS name_key
FROM (
  SELECT raw_name FROM plant_name_wanted
  UNION
  SELECT matched_term FROM plant_name_lookup_hit
  UNION
  SELECT name FROM plant_name_lookup_hit
) raw;
COMMENT ON VIEW plant_name_normal IS 'Every plant name to be matched (plant_name_wanted) or that iNaturalist returned (a hit''s name and its matched_term), with its normalised form. The one place the rule is written down: case ignored, the hybrid sign (and its mangled form Ã—) and var./ssp./subsp. dropped, whitespace collapsed.';

COMMENT ON VIEW plant_expected_rank IS 'The iNaturalist ranks that satisfy each expected rank (plant_name_shape.expected_rank). fallback ranks count only for a name with no hit at the expected rank''s own ranks: a genus-shaped name may be a section, subgenus or supertribe when there is no genus of that name.';

-- Each name to match, normalised, and the rank its shape implies. THE ONE
-- RULE for the rank, for the list's names and the hosts' alike. No rank
-- written beside a name is read. The list's Rank column files families and
-- tribes as genera and genera as species (measured 2026-11-13, 1,368 of 1,405
-- rows match a current iNaturalist name exactly at the shape's rank); a
-- sample's host_rank agrees with the shape on every id-less host but one
-- (production, 2026-11-15: 'Grass cover crop', filed as an order, which is
-- no name at any rank). One word is a taxon above species, told apart by its
-- ending (-aceae a family, -oideae a subfamily, -eae a tribe, -inae a
-- subtribe, -ales an order, anything else a genus); two words are a species or
-- hybrid; more are below species. A name that normalises to nothing has no
-- row.
CREATE VIEW plant_name_shape AS
SELECT n.raw_name, n.name_key,
       CASE
         WHEN words = 1 AND regexp_matches(n.name_key, 'aceae$') THEN 'family'
         WHEN words = 1 AND regexp_matches(n.name_key, 'oideae$') THEN 'subfamily'
         WHEN words = 1 AND regexp_matches(n.name_key, 'inae$') THEN 'subtribe'
         WHEN words = 1 AND regexp_matches(n.name_key, 'eae$') THEN 'tribe'
         WHEN words = 1 AND regexp_matches(n.name_key, 'ales$') THEN 'order'
         WHEN words = 1 THEN 'genus'
         WHEN words = 2 THEN 'species'
         ELSE 'infraspecific'
       END AS expected_rank
FROM (SELECT DISTINCT raw_name FROM plant_name_wanted) w
JOIN plant_name_normal n ON n.raw_name = w.raw_name
CROSS JOIN LATERAL (SELECT length(n.name_key) - length(replace(n.name_key, ' ', '')) + 1 AS words) c
WHERE n.name_key <> '';
COMMENT ON VIEW plant_name_shape IS 'Each name to match (plant_name_wanted), as written, with its normalised name and the rank its shape implies: one word is above species (the ending says which rank), two words a species or hybrid, more a subspecies, variety or form. The one rule for both sources; a name that normalises to nothing has no row.';

DROP VIEW plant_list_entry_name;
CREATE VIEW plant_list_entry_name AS
SELECT e.list_key, e.scientific_name, s.name_key, s.expected_rank
FROM plant_list_entry e
JOIN plant_name_shape s ON s.raw_name = e.scientific_name;
COMMENT ON VIEW plant_list_entry_name IS 'Each entry''s normalised name and the rank its shape implies (plant_name_shape). An entry with no name has no row.';

DROP VIEW plant_name_resolution;
-- What each lookup came to. THE RULE:
--   1. An active hit whose own name is the name wins outright: Abelia is the
--      genus Abelia, whatever a retired Abelia (a synonym of another genus)
--      points at. Two such hits that are different taxa are ambiguous.
--   2. Otherwise every exact hit must come to one current taxon. Three hits
--      for Peritoma serrulata that name the same taxon are one answer; two
--      taxa are no answer; and a retired hit with no replacement is a dead end
--      the name might have meant, so it makes the name ambiguous and no
--      other hit is picked over it. Only dead ends: 'retired, no replacement'.
-- by_own_name says whether a matched name came to its taxon through a hit's
-- own name or only through its matched_term. The second is how an older name
-- finds its taxon, but also how a common name typed where a scientific name
-- belongs would ('Oregon Grape', capitalised like one): a host is a name a
-- volunteer typed, where the list's names were curated, so these are the
-- matches to look over before a host is read through them (beeline-rfkj.5).
CREATE VIEW plant_name_resolution AS
WITH decided AS (
  SELECT c.*, bool_or(c.hit_is_active AND c.own_name) OVER (PARTITION BY c.name_key, c.expected_rank) AS has_winner
  FROM plant_name_hit_current c
), used AS (
  SELECT * FROM decided WHERE NOT has_winner OR (hit_is_active AND own_name)
)
SELECT w.name_key, w.expected_rank,
       CASE
         WHEN l.name_key IS NULL THEN 'not looked up'
         WHEN NOT l.answered THEN 'could not be asked'
         WHEN NOT l.read_in_full THEN 'too many results'
         WHEN count(u.hit_taxon_id) = 0 THEN 'no match'
         WHEN count(DISTINCT u.current_taxon_id) = 0 THEN 'retired, no replacement'
         WHEN count(DISTINCT u.current_taxon_id) = 1 AND count(*) FILTER (WHERE u.current_taxon_id IS NULL) = 0 THEN 'matched'
         ELSE 'ambiguous'
       END AS outcome,
       CASE WHEN l.read_in_full AND count(DISTINCT u.current_taxon_id) = 1 AND count(*) FILTER (WHERE u.current_taxon_id IS NULL) = 0
            THEN min(u.current_taxon_id) END AS inat_taxon_id,
       CASE WHEN l.read_in_full AND count(DISTINCT u.current_taxon_id) = 1 AND count(*) FILTER (WHERE u.current_taxon_id IS NULL) = 0
            THEN bool_or(u.own_name) END AS by_own_name
FROM (SELECT DISTINCT name_key, expected_rank FROM plant_name_shape) w
LEFT JOIN plant_name_lookup l ON l.name_key = w.name_key AND l.expected_rank = w.expected_rank
LEFT JOIN used u ON u.name_key = w.name_key AND u.expected_rank = w.expected_rank
GROUP BY w.name_key, w.expected_rank, l.name_key, l.read_in_full, l.answered;
COMMENT ON VIEW plant_name_resolution IS 'The outcome of each name''s lookup: matched (one current taxon, in inat_taxon_id), ambiguous (more than one distinct current taxon, or a retired hit with no replacement beside another hit, none picked), no match, retired with no replacement (every exact hit is a dead end), too many results (the page cap stopped the reading, so no taxon is given on part of the answer), could not be asked (the request failed in several runs; asked again after 30 days), or not looked up yet. An active hit whose own name is the name wins outright over every other hit. by_own_name, for a matched name only: true when a hit whose own name is the name gave the taxon, false when only matched_term did, that is an older name of the taxon (Aster chilensis, now Symphyotrichum chilense) or a common name written with capitals, which is worth a look before a host is read through it.';

DROP VIEW plant_name_unlooked;
-- The questions still to put to iNaturalist, one per name and rank: names it
-- has not been asked about, and names whose answer is out of date because the
-- taxon cache has since read the taxon the name came to and found it retired
-- (read after the question was asked, so the question is put once per
-- retirement and not every night), and names that could not be asked, once
-- the record of that is 30 days old. A name whose re-ask came back to a taxon
-- that is still retired is asked again only when the cache next reads that
-- taxon (its fetched_at moves past the new answer), so a retired taxon that
-- stays retired costs one question each time the cache refreshes it.
CREATE VIEW plant_name_unlooked AS
SELECT DISTINCT name_key, expected_rank FROM plant_name_shape
EXCEPT
SELECT name_key, expected_rank FROM plant_name_lookup
UNION
SELECT r.name_key, r.expected_rank
FROM plant_name_resolution r
JOIN plant_name_lookup l ON l.name_key = r.name_key AND l.expected_rank = r.expected_rank
JOIN inat_taxon t ON t.inat_taxon_id = r.inat_taxon_id
WHERE NOT t.is_active AND t.fetched_at > l.looked_up_at
UNION
SELECT l.name_key, l.expected_rank FROM plant_name_lookup l
JOIN (SELECT DISTINCT name_key, expected_rank FROM plant_name_shape) n ON n.name_key = l.name_key AND n.expected_rank = l.expected_rank
WHERE NOT l.answered AND l.looked_up_at < now() - INTERVAL 30 DAY;
COMMENT ON VIEW plant_name_unlooked IS 'The normalised names to put to iNaturalist (plant_name_shape: the list''s names and the hosts of samples with no host id): those it has not been asked about, and those whose taxon the cache has since found retired, asked again so the retirement is noticed, and those that could not be asked 30 days ago or more. The worklist of src/fetch-plant-names.ts. Empty once every name has a current answer, including an empty one.';

COMMENT ON COLUMN plant_name_lookup.name_key IS 'The normalised name that was searched for (plant_name_normal.name_key): a plant list name, a sample''s host name, or both (plant_name_wanted).';
COMMENT ON COLUMN plant_name_lookup.expected_rank IS 'The rank the name''s shape implies (plant_name_shape.expected_rank); the search was restricted to the iNaturalist ranks that stand for it (plant_expected_rank).';
