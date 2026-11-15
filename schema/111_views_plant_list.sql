-- Matching plant names to iNaturalist taxa, and the common names that follow:
-- the names of old Beeline's plant list (beeline-rfkj.2), and the floral hosts
-- of samples that have a name and no iNaturalist id (beeline-rfkj.5). The
-- tables are in schema/067; the cache of taxa the matches point into is
-- schema/066.
--
-- Everything here is resolved on read from rows that keep what their source
-- said. Nothing is stored on an entry or a sample, so a taxon swap upstream,
-- or a better lookup later (beeline-rfkj.6), changes the answer without a
-- repair.

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

-- Which iNaturalist ranks stand for each expected rank. A binomial can be a
-- species or a hybrid (iNaturalist files Mentha × piperita as a hybrid); a
-- trinomial is a subspecies, variety or form. A one-word name the shape calls
-- a genus is sometimes a taxon below or beside one: the list's Salicaster and
-- Simiolus are sections, and Brassicodae is a supertribe (asked of iNaturalist
-- on 2026-11-14). Those ranks are `fallback`: they count only where the name
-- has no hit at the shape's own rank, so a genus such as Rubus, which is also
-- the name of a subgenus, stays one taxon and not two.
CREATE VIEW plant_expected_rank AS
SELECT * FROM (VALUES
  ('species',       'species',     false),
  ('species',       'hybrid',      false),
  ('infraspecific', 'subspecies',  false),
  ('infraspecific', 'variety',     false),
  ('infraspecific', 'form',        false),
  ('infraspecific', 'infrahybrid', false),
  ('genus',         'genus',       false),
  ('genus',         'subgenus',    true),
  ('genus',         'section',     true),
  ('genus',         'supertribe',  true),
  ('family',        'family',      false),
  ('subfamily',     'subfamily',   false),
  ('tribe',         'tribe',       false),
  ('subtribe',      'subtribe',    false),
  ('order',         'order',       false)
) AS t(expected_rank, inat_rank, fallback);
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

CREATE VIEW plant_list_entry_name AS
SELECT e.list_key, e.scientific_name, s.name_key, s.expected_rank
FROM plant_list_entry e
JOIN plant_name_shape s ON s.raw_name = e.scientific_name;
COMMENT ON VIEW plant_list_entry_name IS 'Each entry''s normalised name and the rank its shape implies (plant_name_shape). An entry with no name has no row.';

-- The hits that are the name asked for: the hit's own name or its matched_term
-- is exactly the name (after normalisation) and the rank is one the name's
-- shape allows. Both are tried because matched_term is ONE of the terms that
-- matched, and when a taxon has several that begin the same way it is not
-- necessarily the current name: asked for Salix lasiolepis, iNaturalist
-- returned the taxon of that name with matched_term 'Salix lasiolepis
-- lasiolepis' (found on 2026-11-14: reading matched_term alone left 22 of the
-- list's current names unmatched). The name is what the taxon is called
-- today; matched_term is what makes an older name findable (Aster chilensis,
-- now Symphyotrichum chilense). matched_term is also where iNaturalist puts a
-- common name that matched, so it counts only when it is written as a
-- scientific name, with a capital first letter. Of the hits in the 1,404
-- lookups of 2026-11-14, 35 have a lower-case matched_term and none had been
-- taken for a name, so this guards against a case not yet seen, and the capital letter is the cheapest test
-- that is true of every scientific name (the case is read here, not in
-- plant_name_normal, which ignores it on purpose).
-- A hit that iNaturalist has retired stands for the taxa it was replaced by;
-- an active one stands for itself. This is where a replacement chain is read
-- from the lookup's own answer, one step. A replacement that has itself been
-- retired since is not followed here: the entry's taxon stays the one the
-- lookup named, and plant_taxon_common_name (schema/114, beeline-rfkj.3)
-- takes it through inat_taxon_current (schema/113) when it works out what the
-- entry covers, which follows the chain to its end. Nothing here changes when
-- it does.
-- inat_taxon_current must not read plant_taxon_common_name or the views
-- below, or inat_taxon_uncached (which reads this view) would depend on
-- itself.
--
-- Of a name's hits, fallback ranks (plant_expected_rank) are kept only when it
-- has none at the shape's own ranks.
CREATE VIEW plant_name_hit_current AS
WITH exact AS (
  SELECT h.name_key, h.expected_rank, h.inat_taxon_id, h.is_active, x.fallback,
         own.name_key = h.name_key AS own_name
  FROM plant_name_lookup_hit h
  JOIN plant_name_normal own ON own.raw_name = h.name
  JOIN plant_name_normal term ON term.raw_name = h.matched_term
  JOIN plant_expected_rank x ON x.expected_rank = h.expected_rank AND x.inat_rank = h.rank
  WHERE own.name_key = h.name_key
     OR (term.name_key = h.name_key AND regexp_matches(h.matched_term, '^[A-Z]'))
), kept AS (
  SELECT *, min(CAST(fallback AS INTEGER)) OVER (PARTITION BY name_key, expected_rank) AS best
  FROM exact
)
SELECT DISTINCT k.name_key, k.expected_rank, k.inat_taxon_id AS hit_taxon_id, k.is_active AS hit_is_active, k.own_name,
       CASE WHEN k.is_active THEN k.inat_taxon_id ELSE r.replacement_taxon_id END AS current_taxon_id
FROM kept k
LEFT JOIN plant_name_lookup_hit_replacement r
  ON NOT k.is_active
 AND r.name_key = k.name_key AND r.expected_rank = k.expected_rank AND r.inat_taxon_id = k.inat_taxon_id
WHERE CAST(k.fallback AS INTEGER) = k.best;
COMMENT ON VIEW plant_name_hit_current IS 'The hits of each lookup that are the name asked for, at a rank its shape allows (fallback ranks only where there is no hit at the shape''s own ranks), each with the current taxon it stands for: itself if iNaturalist has it active, otherwise what the answer said replaced it (several rows for a split, and NULL in current_taxon_id for a retired taxon with no replacement). own_name says the hit''s own name is the name, and not only an older name of it that matched.';

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

-- Each entry with its taxon, if it has one.
CREATE VIEW plant_list_entry_taxon AS
SELECT n.list_key, n.scientific_name, n.name_key, n.expected_rank, r.outcome, r.inat_taxon_id
FROM plant_list_entry_name n
JOIN plant_name_resolution r ON r.name_key = n.name_key AND r.expected_rank = n.expected_rank;
COMMENT ON VIEW plant_list_entry_taxon IS 'Every entry that has a name, with the outcome of looking it up and, where matched, its iNaturalist taxon. Entries with no name are not listed (and cannot be matched).';

-- Views a person works from.
CREATE VIEW plant_list_entry_unmatched AS
SELECT e.list_key, e.scientific_name, e.rank AS listed_rank, t.expected_rank,
       coalesce(t.outcome, 'no name') AS outcome, e.synonym, e.common_name
FROM plant_list_entry e
LEFT JOIN plant_list_entry_taxon t ON t.list_key = e.list_key AND t.scientific_name = e.scientific_name
WHERE t.inat_taxon_id IS NULL;
COMMENT ON VIEW plant_list_entry_unmatched IS 'Entries with no iNaturalist taxon, and why: not looked up yet, could not be asked, no match, ambiguous, retired with no replacement, or no name to look up. The work for a person (or for beeline-rfkj.6): the synonym column is the likeliest way to a match.';

CREATE VIEW plant_list_taxon_shared AS
SELECT list_key, inat_taxon_id, count(*) AS entries, string_agg(scientific_name, '; ' ORDER BY scientific_name) AS scientific_names
FROM plant_list_entry_taxon
WHERE inat_taxon_id IS NOT NULL
GROUP BY list_key, inat_taxon_id
HAVING count(*) > 1;
COMMENT ON VIEW plant_list_taxon_shared IS 'Taxa that two or more entries of one list reach, usually the list holding a name and its synonym, or a species twice at different spellings. Where the entries have different common names, the first by scientific name is used (plant_taxon_common_name).';

-- THE COMMON NAME A PLANT IS KNOWN BY.
-- An entry's name: the first of the several its cell may give, leaving out a
-- placeholder. The list fills a genus's name with 'Abelia Species' and a
-- tribe's with 'tribe Cardamineae' where it has none (202 rows and 35 empty cells,
-- measured 2026-11-14); those are not names. A placeholder is the entry's own
-- scientific name with 'Species' after it or a rank word before it, in any
-- case, or the scientific name itself written with its capital: 'magnolia' is
-- a name, 'Magnolia species' is not.
--
-- SEVERAL NAMES ABOVE SPECIES ARE NO NAME (Peter, 2026-11-14). For a taxon at
-- genus rank or above the list sometimes writes several names, or the members
-- of a group, where one name belongs: 'Plums, cherries, and allies' for
-- Prunus, 'cucumber, gourd family' for Cucurbitaceae, 'forget-me-not or
-- borage' for Boraginaceae. Cut at the first separator it would show one of
-- them as if it were the taxon's name, so the entry gives no name, and a host takes
-- iNaturalist's name for Oregon instead (plant_taxon_common_name), and the
-- entry does not name the hosts beneath it either. At species rank and below
-- the cell is synonyms and the first is shown ('butter and eggs, common
-- toadflax'). The rule is the one view below, so it is changed in one place:
-- the entry's expected rank (plant_list_entry_name) is genus or above, not
-- species or infraspecific, and the cell holds more than one name: a comma, a
-- semicolon, ' or ' or ' and ' separates them.
CREATE VIEW plant_list_entry_several_names AS
SELECT e.list_key, e.scientific_name, e.common_name
FROM plant_list_entry e
JOIN plant_list_entry_name n ON n.list_key = e.list_key AND n.scientific_name = e.scientific_name
WHERE e.common_name IS NOT NULL
  AND n.expected_rank NOT IN ('species', 'infraspecific')
  AND regexp_matches(lower(trim(e.common_name)), '[,;]| or | and ');
COMMENT ON VIEW plant_list_entry_several_names IS 'Entries whose expected rank is genus or above (plant_list_entry_name; not species or infraspecific) and whose common-name cell holds more than one name, separated by a comma, a semicolon, " or " or " and " (Plums, cherries, and allies; forget-me-not or borage). They give no common name (plant_list_entry_common_name), so a host takes iNaturalist''s. A species'' or lower entry with several names shows the first and is not listed here.';

CREATE VIEW plant_list_entry_common_name AS
SELECT list_key, scientific_name, shown AS common_name
FROM (
  SELECT e.list_key, e.scientific_name, e.scientific_name AS sci,
         trim(regexp_replace(e.common_name, '[,;].*$', '')) AS shown
  FROM plant_list_entry e
  WHERE e.common_name IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM plant_list_entry_several_names g WHERE g.list_key = e.list_key AND g.scientific_name = e.scientific_name)
) x
CROSS JOIN LATERAL (
  SELECT lower(regexp_replace(regexp_replace(shown, '^(genus|subtribe|tribe|subfamily|family|order) ', '', 'i'), ' species$', '', 'i')) AS bare
) b
WHERE shown <> ''
  AND NOT (bare = lower(sci) AND lower(shown) <> bare)
  AND shown <> sci;
COMMENT ON VIEW plant_list_entry_common_name IS 'The common name each entry shows: the first of those its cell lists (commas or semicolons separate them). None where the cell is empty, a placeholder (the scientific name with Species after it or a rank word before it, or the scientific name capitalised), or, at genus rank or above, several names (plant_list_entry_several_names).';
