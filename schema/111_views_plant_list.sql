-- Matching old Beeline's plant list to iNaturalist taxa, and the common names
-- that follows (beeline-rfkj.2). The tables are in schema/067; the cache of
-- taxa the matches point into is schema/066.
--
-- Everything here is resolved on read from rows that keep what their source
-- said. Nothing is stored on an entry, so a taxon swap upstream, or a better
-- lookup later (beeline-rfkj.6), changes the answer without a repair.

-- THE ONE NORMALISATION. A plant name, as the list or iNaturalist wrote it,
-- reduced to what two spellings of the same name share:
--   - case is ignored;
--   - the hybrid sign is dropped, because the list writes Mentha piperita
--     where iNaturalist writes Mentha × piperita;
--   - var., ssp. and subsp. are dropped, because iNaturalist writes a
--     trinomial without them (Carduus pycnocephalus cinereus);
--   - runs of spaces become one.
-- The two kinds of name it is applied to are the list's scientific names and
-- what iNaturalist returned (the name of a hit, and its matched_term), so the
-- rule is stated once here and both sides cannot drift. An 'x' written as a hybrid sign is not
-- handled: the list has none (checked on 2026-11-13).
CREATE VIEW plant_name_normal AS
SELECT raw_name,
       trim(regexp_replace(
         regexp_replace(
           regexp_replace(lower(raw_name), '×', ' ', 'g'),
           '(^| )(var|ssp|subsp)\.', '', 'g'),
         ' +', ' ', 'g')) AS name_key
FROM (
  SELECT scientific_name AS raw_name FROM plant_list_entry
  UNION
  SELECT matched_term FROM plant_name_lookup_hit
  UNION
  SELECT name FROM plant_name_lookup_hit
) raw;
COMMENT ON VIEW plant_name_normal IS 'Every plant name the list wrote or iNaturalist returned (a hit''s name and its matched_term), with its normalised form. The one place the rule is written down: case ignored, the hybrid sign and var./ssp./subsp. dropped, spaces collapsed.';

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
COMMENT ON VIEW plant_expected_rank IS 'The iNaturalist ranks that satisfy each expected rank (plant_list_entry_name.expected_rank). fallback ranks count only for a name with no hit at the expected rank''s own ranks: a genus-shaped name may be a section, subgenus or supertribe when there is no genus of that name.';

-- Each entry's normalised name, and the rank its shape implies. The list's
-- Rank column is not read: it files families and tribes as genera and genera
-- as species (measured 2026-11-13, 1,368 of 1,405 rows match a current
-- iNaturalist name exactly at the shape's rank). One word is a taxon above
-- species, told apart by its ending (-aceae a family, -oideae a subfamily,
-- -eae a tribe, -inae a subtribe, -ales an order, anything else a genus); two
-- words are a species or hybrid; more are below species.
CREATE VIEW plant_list_entry_name AS
SELECT e.list_key, e.scientific_name, n.name_key,
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
FROM plant_list_entry e
JOIN plant_name_normal n ON n.raw_name = e.scientific_name
CROSS JOIN LATERAL (SELECT length(n.name_key) - length(replace(n.name_key, ' ', '')) + 1 AS words) w
WHERE n.name_key <> '';
COMMENT ON VIEW plant_list_entry_name IS 'Each entry''s normalised name and the rank its shape implies: one word is above species (the ending says which rank), two words a species or hybrid, more a subspecies, variety or form. An entry with no name has no row.';

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
-- from the lookup's own answer; beeline-rfkj.3 follows a replacement that has
-- itself been retired since, and takes over here.
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
         WHEN NOT l.read_in_full THEN 'too many results'
         WHEN count(u.hit_taxon_id) = 0 THEN 'no match'
         WHEN count(DISTINCT u.current_taxon_id) = 0 THEN 'retired, no replacement'
         WHEN count(DISTINCT u.current_taxon_id) = 1 AND count(*) FILTER (WHERE u.current_taxon_id IS NULL) = 0 THEN 'matched'
         ELSE 'ambiguous'
       END AS outcome,
       CASE WHEN l.read_in_full AND count(DISTINCT u.current_taxon_id) = 1 AND count(*) FILTER (WHERE u.current_taxon_id IS NULL) = 0
            THEN min(u.current_taxon_id) END AS inat_taxon_id
FROM (SELECT DISTINCT name_key, expected_rank FROM plant_list_entry_name) w
LEFT JOIN plant_name_lookup l ON l.name_key = w.name_key AND l.expected_rank = w.expected_rank
LEFT JOIN used u ON u.name_key = w.name_key AND u.expected_rank = w.expected_rank
GROUP BY w.name_key, w.expected_rank, l.name_key, l.read_in_full;
COMMENT ON VIEW plant_name_resolution IS 'The outcome of each name''s lookup: matched (one current taxon, in inat_taxon_id), ambiguous (more than one distinct current taxon, or a retired hit with no replacement beside another hit, none picked), no match, retired with no replacement (every exact hit is a dead end), too many results (the page cap stopped the reading, so no taxon is given on part of the answer), or not looked up yet. An active hit whose own name is the name wins outright over every other hit.';

-- The questions still to put to iNaturalist, one per name and rank: names it
-- has not been asked about, and names whose answer is out of date because the
-- taxon cache has since read the taxon the name came to and found it retired
-- (read after the question was asked, so the question is put once per
-- retirement and not every night).
CREATE VIEW plant_name_unlooked AS
SELECT DISTINCT name_key, expected_rank FROM plant_list_entry_name
EXCEPT
SELECT name_key, expected_rank FROM plant_name_lookup
UNION
SELECT r.name_key, r.expected_rank
FROM plant_name_resolution r
JOIN plant_name_lookup l ON l.name_key = r.name_key AND l.expected_rank = r.expected_rank
JOIN inat_taxon t ON t.inat_taxon_id = r.inat_taxon_id
WHERE NOT t.is_active AND t.fetched_at > l.looked_up_at;
COMMENT ON VIEW plant_name_unlooked IS 'The normalised names of list entries to put to iNaturalist: those it has not been asked about, and those whose taxon the cache has since found retired, asked again so the retirement is noticed. The worklist of src/fetch-plant-names.ts. Empty once every name has a current answer, including an empty one.';

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
COMMENT ON VIEW plant_list_entry_unmatched IS 'Entries with no iNaturalist taxon, and why: not looked up yet, no match, ambiguous, retired with no replacement, or no name to look up. The work for a person (or for beeline-rfkj.6): the synonym column is the likeliest way to a match.';

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
-- A GROUP CELL IS NO NAME (Peter, 2026-11-14). For a taxon above species the
-- list sometimes writes the members of a group where a name belongs: 'Plums,
-- cherries, and allies' for Prunus, 'cucumber, gourd family' for
-- Cucurbitaceae. Cut at the first comma it would read 'Plums' and 'cucumber',
-- and shown whole it is a sentence, so the entry gives no name, and a host
-- takes iNaturalist's name for Oregon instead (plant_taxon_common_name). The
-- rule is the one view below, so it is changed in one place: the entry's name
-- is one word (above species; a species' cell is synonyms, and 'butter and
-- eggs, common toadflax' is one name and then another) and the cell contains
-- ' and ' or ends in ' family' or ' tribe'.
CREATE VIEW plant_list_entry_group_cell AS
SELECT list_key, scientific_name, common_name
FROM plant_list_entry
WHERE common_name IS NOT NULL
  AND position(' ' IN trim(scientific_name)) = 0
  AND (regexp_matches(lower(trim(common_name)), ' and ')
       OR regexp_matches(lower(trim(common_name)), ' (family|tribe)$'));
COMMENT ON VIEW plant_list_entry_group_cell IS 'Entries whose common-name cell lists the members of a group (Plums, cherries, and allies) and not names for the taxon: a taxon above species whose cell contains " and " or ends in " family" or " tribe". They give no common name (plant_list_entry_common_name).';

CREATE VIEW plant_list_entry_common_name AS
SELECT list_key, scientific_name, shown AS common_name
FROM (
  SELECT e.list_key, e.scientific_name, e.scientific_name AS sci,
         trim(regexp_replace(e.common_name, '[,;].*$', '')) AS shown
  FROM plant_list_entry e
  WHERE e.common_name IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM plant_list_entry_group_cell g WHERE g.list_key = e.list_key AND g.scientific_name = e.scientific_name)
) x
CROSS JOIN LATERAL (
  SELECT lower(regexp_replace(regexp_replace(shown, '^(genus|subtribe|tribe|subfamily|family|order) ', '', 'i'), ' species$', '', 'i')) AS bare
) b
WHERE shown <> ''
  AND NOT (bare = lower(sci) AND lower(shown) <> bare)
  AND shown <> sci;
COMMENT ON VIEW plant_list_entry_common_name IS 'The common name each entry shows: the first of those its cell lists (commas or semicolons separate them). None where the cell is empty, a placeholder (the scientific name with Species after it or a rank word before it, or the scientific name capitalised), or a group''s members (plant_list_entry_group_cell).';
