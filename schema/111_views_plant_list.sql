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
-- trinomial is a subspecies, variety or form.
CREATE VIEW plant_expected_rank AS
SELECT * FROM (VALUES
  ('species',       'species'),
  ('species',       'hybrid'),
  ('infraspecific', 'subspecies'),
  ('infraspecific', 'variety'),
  ('infraspecific', 'form'),
  ('infraspecific', 'infrahybrid'),
  ('genus',         'genus'),
  ('family',        'family'),
  ('subfamily',     'subfamily'),
  ('tribe',         'tribe'),
  ('subtribe',      'subtribe'),
  ('order',         'order')
) AS t(expected_rank, inat_rank);
COMMENT ON VIEW plant_expected_rank IS 'The iNaturalist ranks that satisfy each expected rank (plant_list_entry_name.expected_rank).';

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

-- The questions still to put to iNaturalist, one per name and rank.
CREATE VIEW plant_name_unlooked AS
SELECT DISTINCT name_key, expected_rank FROM plant_list_entry_name
EXCEPT
SELECT name_key, expected_rank FROM plant_name_lookup;
COMMENT ON VIEW plant_name_unlooked IS 'The normalised names of list entries that iNaturalist has not been asked about: the worklist of src/fetch-plant-names.ts. Empty once every name has an answer, including an empty one.';

-- The hits that are the name asked for: the hit's own name or its matched_term
-- is exactly the name (after normalisation) and the rank is one the name's
-- shape allows. Both are tried because matched_term is ONE of the terms that
-- matched, and when a taxon has several that begin the same way it is not
-- necessarily the current name: asked for Salix lasiolepis, iNaturalist
-- returned the taxon of that name with matched_term 'Salix lasiolepis
-- lasiolepis' (found on 2026-11-14: reading matched_term alone left 22 of the
-- list's current names unmatched). The name is what the taxon is called
-- today; matched_term is what makes an older name findable. A hit
-- that iNaturalist has retired stands for the taxa it was replaced by; an
-- active one stands for itself. This is where a replacement chain is read
-- from the lookup's own answer; beeline-rfkj.3 follows a replacement that has
-- itself been retired since, and takes over here.
CREATE VIEW plant_name_hit_current AS
SELECT DISTINCT h.name_key, h.expected_rank, h.inat_taxon_id AS hit_taxon_id,
       CASE WHEN h.is_active THEN h.inat_taxon_id ELSE r.replacement_taxon_id END AS current_taxon_id
FROM plant_name_lookup_hit h
JOIN plant_name_normal m ON m.raw_name IN (h.matched_term, h.name) AND m.name_key = h.name_key
JOIN plant_expected_rank x ON x.expected_rank = h.expected_rank AND x.inat_rank = h.rank
LEFT JOIN plant_name_lookup_hit_replacement r
  ON NOT h.is_active
 AND r.name_key = h.name_key AND r.expected_rank = h.expected_rank AND r.inat_taxon_id = h.inat_taxon_id;
COMMENT ON VIEW plant_name_hit_current IS 'The hits of each lookup whose own name or matched_term is exactly the name asked for, at a rank its shape allows, each with the current taxon it stands for: itself if iNaturalist has it active, otherwise what the answer said replaced it (several rows for a split, none for a retired taxon with no replacement, where current_taxon_id is NULL).';

-- What each lookup came to. A name is matched only when every exact hit
-- agrees on one current taxon: three hits for Peritoma serrulata that name
-- the same taxon are one answer, and two taxa are no answer.
CREATE VIEW plant_name_resolution AS
SELECT w.name_key, w.expected_rank,
       CASE
         WHEN l.name_key IS NULL THEN 'not looked up'
         WHEN count(c.hit_taxon_id) = 0 THEN 'no match'
         WHEN count(DISTINCT c.current_taxon_id) = 0 THEN 'retired, no replacement'
         WHEN count(DISTINCT c.current_taxon_id) = 1 THEN 'matched'
         ELSE 'ambiguous'
       END AS outcome,
       CASE WHEN count(DISTINCT c.current_taxon_id) = 1 THEN min(c.current_taxon_id) END AS inat_taxon_id
FROM (SELECT DISTINCT name_key, expected_rank FROM plant_list_entry_name) w
LEFT JOIN plant_name_lookup l ON l.name_key = w.name_key AND l.expected_rank = w.expected_rank
LEFT JOIN plant_name_hit_current c ON c.name_key = w.name_key AND c.expected_rank = w.expected_rank
GROUP BY w.name_key, w.expected_rank, l.name_key;
COMMENT ON VIEW plant_name_resolution IS 'The outcome of each name''s lookup: matched (one current taxon, in inat_taxon_id), ambiguous (more than one distinct current taxon after following replacements, none picked), no match, retired with no replacement, or not looked up yet.';

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
-- An entry's names: the first of the several the list may give, leaving out
-- a placeholder. The list fills a genus's name with 'Abelia Species' and a
-- tribe's with 'tribe Cardamineae' where it has none (182 and about 30 rows,
-- measured 2026-11-13); those are not names. A placeholder is the entry's own
-- scientific name with 'Species' after it or a rank word before it, in any
-- case, or the scientific name itself written with its capital: 'magnolia' is
-- a name, 'Magnolia species' is not.
CREATE VIEW plant_list_entry_common_name AS
SELECT list_key, scientific_name, first_name AS common_name
FROM (
  SELECT list_key, scientific_name,
         trim(regexp_replace(common_name, '[,;].*$', '')) AS first_name,
         lower(regexp_replace(regexp_replace(trim(regexp_replace(common_name, '[,;].*$', '')),
           '^(genus|subtribe|tribe|subfamily|family|order) ', '', 'i'), ' species$', '', 'i')) AS bare,
         common_name AS whole, scientific_name AS sci
  FROM plant_list_entry
  WHERE common_name IS NOT NULL
) x
WHERE first_name <> ''
  AND NOT (bare = lower(sci) AND lower(first_name) <> bare)
  AND first_name <> sci;
COMMENT ON VIEW plant_list_entry_common_name IS 'The common name each entry shows: the first of those it lists (commas or semicolons separate them), and none where the list''s cell is empty or a placeholder (the scientific name with Species after it or a rank word before it, or the scientific name capitalised).';

-- One row per cached taxon that has a common name: the nearest list entry
-- that covers it, else iNaturalist's name for Oregon. An entry covers a taxon
-- when the entry's own taxon is that taxon or one of its ancestors
-- (inat_taxon_ancestor, which includes the taxon at depth 0); the nearest is
-- the lowest depth, and an entry with no usable name does not cover, since it
-- has nothing to say. Two entries at one depth (plant_list_taxon_shared) are
-- settled by scientific name so the answer does not move.
--
-- It reads the taxon's own stored lineage, which for a retired taxon is stale
-- (schema/066): resolving a retired host to its current taxon first is
-- beeline-rfkj.3, which replaces `taxon` below.
CREATE VIEW plant_taxon_common_name AS
WITH covering AS (
  SELECT a.inat_taxon_id, c.common_name, c.scientific_name, a.depth,
         row_number() OVER (PARTITION BY a.inat_taxon_id ORDER BY a.depth, c.list_key, c.scientific_name) AS place
  FROM inat_taxon_ancestor a
  JOIN plant_list_entry_taxon t ON t.inat_taxon_id = a.ancestor_id
  JOIN plant_list_entry_common_name c ON c.list_key = t.list_key AND c.scientific_name = t.scientific_name
)
SELECT taxon.inat_taxon_id,
       coalesce(cv.common_name, taxon.preferred_common_name) AS common_name,
       CASE WHEN cv.common_name IS NOT NULL THEN 'list' ELSE 'inaturalist' END AS source,
       cv.scientific_name AS list_entry,
       cv.depth AS list_entry_depth
FROM inat_taxon taxon
LEFT JOIN covering cv ON cv.inat_taxon_id = taxon.inat_taxon_id AND cv.place = 1
WHERE coalesce(cv.common_name, taxon.preferred_common_name) IS NOT NULL;
COMMENT ON VIEW plant_taxon_common_name IS 'The common name of each cached taxon that has one: the first name of the nearest old-Beeline list entry that covers it (the entry''s taxon is the taxon or an ancestor; the lowest depth wins), otherwise iNaturalist''s preferred name for Oregon. source says which; list_entry and list_entry_depth say which entry and how far above the taxon it sits (0 is an entry for the taxon itself, anything more is a coarser entry, a genus or a family, covering a species that has none of its own). Reads the taxon''s own stored lineage, so a retired taxon is judged by its stale one until beeline-rfkj.3 resolves it first.';
