-- Migration for schema/067 and schema/114: iNaturalist's common names in sentence case
-- (beeline-rfkj.9).
--
-- plant_proper_noun is a new table, empty here and loaded at the app's boot from
-- ingest/plant-proper-nouns.csv (src/load-plant-list.ts, whose hash now covers the
-- file, so the boot loads it). Three views are new, and plant_taxon_common_name is
-- dropped and made again to read plant_inat_common_name. The copy of the names
-- (plant_common_name_cache) is refreshed by that boot load, which finds the list's
-- hash changed because the loader's version did; until then it holds the names as
-- iNaturalist wrote them.

-- Words that iNaturalist's common names capitalise and that keep the capital
-- when Beeline sets them in sentence case (beeline-rfkj.9), from
-- ingest/plant-proper-nouns.csv. The words the plant list itself capitalises
-- are learned from it (plant_list_proper_noun, schema/114), so this holds only
-- what the list never says.
CREATE TABLE plant_proper_noun (
  word      TEXT PRIMARY KEY,
  treatment TEXT NOT NULL CHECK (treatment IN ('keep', 'lower')),
  reason    TEXT NOT NULL
);
COMMENT ON TABLE plant_proper_noun IS 'Hand-kept exceptions to how iNaturalist''s common names are set in sentence case (src/load-plant-list.ts loads ingest/plant-proper-nouns.csv, replacing the rows). Read by plant_inat_common_name (schema/114). Beyond what the old plant list shows, a word that is a proper noun keeps its capital, and a possessive that is not an eponym loses it.';
COMMENT ON COLUMN plant_proper_noun.word IS 'The word as it is to be written (Utah, Shepherd''s), without a hyphen: the parts of a hyphenated word are judged one at a time. For a keep row, a phrase of words separated by single spaces is allowed (Rocky Mountain), matched on consecutive words; a word or phrase is matched whatever case the name has it in and is set as written here, so a keep row also restores an eponym that iNaturalist wrote in lower case (Bebb''s). No two rows differ only in case.';
COMMENT ON COLUMN plant_proper_noun.treatment IS 'keep: the word or phrase is a proper noun and is set as written here. lower: the word is a possessive that would keep its capital by the possessive rule (plant_inat_common_name) and should not, because it is not an eponym (shepherd''s purse).';
COMMENT ON COLUMN plant_proper_noun.reason IS 'Why, in a few words, with an example.';

-- iNaturalist's common names, set in sentence case (beeline-rfkj.9). iNaturalist
-- writes many of them in title case ("Silverleaf Phacelia"), and Beeline's style
-- (src/app/views/design/names.tsx) is capitals only for proper nouns
-- ("silverleaf phacelia", "Oregon grape"). The stored name is never changed
-- (inat_taxon.preferred_common_name stays what iNaturalist said); the name is
-- converted here, where it is chosen for display, and plant_common_name_cache
-- keeps the converted one, so a reader pays nothing. It is done in SQL so that
-- plant_common_name_stale, which compares the cache with this view, still
-- judges what a page shows.
--
-- A word keeps its capital when:
--   1. the old plant list capitalises it inside a name that is otherwise in
--      sentence case ("tall Oregon-grape", "common California aster"), and the
--      list and iNaturalist never write it in lower case anywhere
--      (plant_list_proper_noun); or
--   2. it is a possessive ("Douglas'", "Nuttall's"), nearly always an
--      eponym, unless the file says lower ("Shepherd's", "Devil's"). The
--      lower-case spellings in iNaturalist's own names are no guide: they
--      include "bird's" but also "greene's" and "scouler's"; or
--   3. ingest/plant-proper-nouns.csv says keep (plant_proper_noun): the
--      proper nouns the list never uses. A row may be a phrase of several
--      words ("Rocky Mountain"), matched on consecutive words, so that the
--      second word of a place keeps its capital where it is a common noun
--      elsewhere. A keep row sets its word or phrase as the file spells it
--      whatever case the name had it in, which restores the eponyms that
--      iNaturalist wrote in lower case ("bebb's"). A phrase is found once
--      in a name, the first time.
-- The parts of a hyphenated word are judged one at a time, since a word is a
-- run of letters and apostrophes: "Douglas-fir" keeps Douglas only if a rule
-- above keeps it, "Love-in-a-mist" becomes "love-in-a-mist". A name of a taxon
-- at section, subsection, subgenus or series rank, and a name that is the
-- taxon's own scientific name, are scientific names and are left as written.

-- Every word that the list and iNaturalist write beginning with a lower-case
-- letter, in lower case, so a word that also has a capital form is a common
-- noun that happened to begin a name (stonecrop, willow), not a proper noun.
CREATE VIEW plant_list_name AS
SELECT DISTINCT name
FROM (SELECT trim(unnest(string_split_regex(common_name, '[,;]'))) AS name FROM plant_list_entry WHERE common_name IS NOT NULL)
WHERE name <> ''
  AND NOT regexp_matches(name, ' species$', 'i')
  AND NOT regexp_matches(name, '^(genus|subtribe|tribe|subfamily|family|order|section|subgenus|series|superfamily|class) ', 'i');
COMMENT ON VIEW plant_list_name IS 'Every name in the plant list''s common-name cells, one to a row, including the second and later names of a cell that plant_list_entry_common_name leaves out, since the list''s capitals are evidence wherever it wrote them. Placeholders ("Abelia Species") and rank-and-name cells ("tribe Cardueae") are left out.';
CREATE VIEW plant_lowercase_word AS
SELECT DISTINCT word
FROM (
  SELECT unnest(regexp_extract_all(name, '[\p{L}''’]+')) AS word FROM plant_list_name
  UNION ALL
  SELECT unnest(regexp_extract_all(preferred_common_name, '[\p{L}''’]+')) FROM inat_taxon WHERE preferred_common_name IS NOT NULL
)
WHERE regexp_matches(word, '^\p{Ll}');
COMMENT ON VIEW plant_lowercase_word IS 'The words, in lower case, that the plant list''s common names and iNaturalist''s preferred common names write beginning with a lower-case letter. A word the list capitalises inside a name is a proper noun only if it is not in here (plant_list_proper_noun).';

CREATE VIEW plant_list_proper_noun AS
WITH names AS (
  SELECT name FROM plant_list_name
), words AS (
  SELECT n.name, u.word, u.pos
  FROM names n,
  LATERAL (SELECT unnest(ws) AS word, generate_subscripts(ws, 1) AS pos
           FROM (SELECT regexp_extract_all(n.name, '[\p{L}''’]+') AS ws)) u
), in_sentence_case AS (
  -- A name with a lower-case word that is not a connector: the list wrote it in sentence case, so its capitals were chosen
  SELECT DISTINCT name FROM words
  WHERE regexp_matches(word, '^\p{Ll}') AND word NOT IN ('of', 'the', 'and', 'in', 'a', 'de', 'la', 'or', 'to', 'on', 'for', 'with')
)
SELECT DISTINCT word
FROM words
WHERE pos > 1
  AND regexp_matches(word, '^\p{Lu}')
  AND name IN (SELECT name FROM in_sentence_case)
  AND lower(word) NOT IN (SELECT word FROM plant_lowercase_word);
COMMENT ON VIEW plant_list_proper_noun IS 'Words the old plant list''s common names capitalise after their first word, in a name that has a lower-case word of its own (so the list chose the capitals; its title-case rows, "Perennial Sow Thistle", say nothing), and that neither the list nor iNaturalist writes in lower case anywhere: Oregon, California, Canada, St, John''s. The first word of a name says nothing, since a name begins with a capital whatever the word is.';

CREATE VIEW plant_inat_common_name AS
WITH tokens AS (
  -- Each name as alternating words (letters and apostrophes) and what lies between them, numbered,
  -- with the 1-based character where each begins
  SELECT t.inat_taxon_id, t.preferred_common_name AS name, u.token, u.pos,
         1 + CAST(coalesce(sum(length(u.token)) OVER (PARTITION BY t.inat_taxon_id ORDER BY u.pos ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS BIGINT) AS starts_at
  FROM inat_taxon t,
  LATERAL (SELECT unnest(tk) AS token, generate_subscripts(tk, 1) AS pos
           FROM (SELECT regexp_extract_all(t.preferred_common_name, '[\p{L}''’]+|[^\p{L}''’]+') AS tk)) u
  WHERE t.preferred_common_name IS NOT NULL
    AND t.rank NOT IN ('section', 'subsection', 'subgenus', 'series', 'subseries')
    AND t.preferred_common_name <> t.name
), phrase_hit AS (
  -- Where a phrase of the file is in a name, whatever case the name has it in, between two characters that are not letters
  SELECT t.inat_taxon_id, p.word AS phrase, strpos(lower(t.preferred_common_name), lower(p.word)) AS found_at
  FROM inat_taxon t
  JOIN plant_proper_noun p ON p.treatment = 'keep' AND strpos(p.word, ' ') > 0
  WHERE t.preferred_common_name IS NOT NULL
    AND strpos(lower(t.preferred_common_name), lower(p.word)) > 0
    AND NOT regexp_matches(substr(' ' || t.preferred_common_name || ' ', strpos(lower(t.preferred_common_name), lower(p.word)), 1), '[\p{L}''’]')
    AND NOT regexp_matches(substr(' ' || t.preferred_common_name || ' ', strpos(lower(t.preferred_common_name), lower(p.word)) + length(p.word) + 1, 1), '[\p{L}''’]')
), judged AS (
  SELECT k.inat_taxon_id, k.pos,
         CASE
           -- Inside a phrase of the file: the phrase's own spelling
           WHEN h.phrase IS NOT NULL THEN substr(h.phrase, k.starts_at - h.found_at + 1, length(k.token))
           -- A word the file keeps, whatever case the name wrote it in
           WHEN f.treatment = 'keep' THEN f.word
           -- A word that does not begin with a capital stays as written, except that a capital after its apostrophe (o'Clock) goes
           WHEN NOT regexp_matches(k.token, '^\p{Lu}') THEN CASE WHEN regexp_matches(k.token, '[''’]') THEN lower(k.token) ELSE k.token END
           WHEN f.word IS NULL AND (l.word IS NOT NULL OR regexp_matches(k.token, '\p{L}[''’]s?$')) THEN k.token
           ELSE lower(k.token)
         END AS shown
  FROM tokens k
  LEFT JOIN LATERAL (
    SELECT phrase, found_at FROM phrase_hit h
    WHERE h.inat_taxon_id = k.inat_taxon_id AND k.starts_at >= h.found_at AND k.starts_at < h.found_at + length(h.phrase)
    LIMIT 1) h ON true
  LEFT JOIN plant_proper_noun f ON lower(f.word) = lower(k.token) AND strpos(f.word, ' ') = 0
  LEFT JOIN plant_list_proper_noun l ON l.word = k.token
)
SELECT inat_taxon_id, string_agg(shown, '' ORDER BY pos) AS common_name
FROM judged
GROUP BY inat_taxon_id;
COMMENT ON VIEW plant_inat_common_name IS 'iNaturalist''s preferred common name of each taxon that has one, in sentence case: every word in lower case except proper nouns (rules at the top of schema/114). A phrase of the file (Rocky Mountain) and a word the file keeps are set as the file spells them, whatever case the name had them in. Taxa at section, subsection, subgenus or series rank, and a name that is the taxon''s own scientific name, are not here: plant_taxon_common_name gives those as iNaturalist wrote them. A name already in sentence case comes out unchanged, apart from its first word, which loses its capital like any other.';

DROP VIEW plant_taxon_common_name;
-- One row per cached taxon that has a common name: the taxon's own list
-- entry, else iNaturalist's name for Oregon, else the nearest coarser list
-- entry that covers it. An entry covers a taxon when the entry's own taxon is
-- that taxon or one of its ancestors (inat_taxon_ancestor, which includes the
-- taxon at depth 0); the nearest is the lowest depth, and an entry with no
-- usable name does not cover, since it has nothing to say. Of two entries at
-- one depth, one written for the current taxon itself comes before one that
-- reaches it only through a replacement (an older synonym the list also holds),
-- even from a later list; then the list and the scientific name settle it, so
-- the answer does not move.
--
-- An entry is the taxon it is today: its stored taxon is resolved through
-- inat_taxon_current first, so an entry whose taxon iNaturalist has replaced
-- covers what lies beneath the replacement. An entry whose taxon was split,
-- is retired with nothing to replace it, is pending or is absent has no
-- current taxon and covers nothing. A taxon's ancestors are resolved the same
-- way, so a retired genus in a lineage matches the entry for the genus that
-- replaced it. The depth is still the stored lineage's. A taxon that is not in
-- the cache at all has nothing to resolve and stands for itself, as it did before.
--
-- It reads the taxon's own stored lineage, which for a retired taxon is stale
-- (schema/066): a retired host is resolved to its current taxon first, and
-- this view is read for that taxon (schema/116).
CREATE VIEW plant_taxon_common_name AS
WITH covering AS (
  SELECT a.inat_taxon_id, c.common_name, c.scientific_name, a.depth,
         -- At one depth, an entry written for the current taxon itself comes before one that reaches it
         -- only through a replacement (an older synonym the list also holds).
         row_number() OVER (PARTITION BY a.inat_taxon_id ORDER BY a.depth, t.stored_taxon_id IS DISTINCT FROM t.current_taxon_id, c.list_key, c.scientific_name) AS place
  FROM inat_taxon_ancestor a
  LEFT JOIN inat_taxon_current ancestor_now ON ancestor_now.inat_taxon_id = a.ancestor_id
  JOIN (SELECT t.list_key, t.scientific_name, t.inat_taxon_id AS stored_taxon_id,
               CASE WHEN e.inat_taxon_id IS NULL THEN t.inat_taxon_id ELSE e.current_taxon_id END AS current_taxon_id
        FROM plant_list_entry_taxon t
        LEFT JOIN inat_taxon_current e ON e.inat_taxon_id = t.inat_taxon_id) t
    ON t.current_taxon_id = CASE WHEN ancestor_now.inat_taxon_id IS NULL THEN a.ancestor_id ELSE ancestor_now.current_taxon_id END
  JOIN plant_list_entry_common_name c ON c.list_key = t.list_key AND c.scientific_name = t.scientific_name
)
-- The list's name wins only for the taxon's own entry (iNaturalist's name is the one in sentence case, plant_inat_common_name). A coarser entry (a
-- genus or a family) names a species only where iNaturalist has no name for
-- it: "mustard" for Sisymbrium altissimum, which iNaturalist calls Tall
-- Tumblemustard, is worse than either (Peter, 2026-11-14).
, chosen AS (
  SELECT taxon.inat_taxon_id, coalesce(inat.common_name, taxon.preferred_common_name) AS preferred_common_name, cv.common_name AS list_name, cv.scientific_name, cv.depth,
         cv.common_name IS NOT NULL AND (cv.depth = 0 OR taxon.preferred_common_name IS NULL) AS from_list
  FROM inat_taxon taxon
  LEFT JOIN plant_inat_common_name inat ON inat.inat_taxon_id = taxon.inat_taxon_id
  LEFT JOIN covering cv ON cv.inat_taxon_id = taxon.inat_taxon_id AND cv.place = 1
)
SELECT inat_taxon_id,
       CASE WHEN from_list THEN list_name ELSE preferred_common_name END AS common_name,
       CASE WHEN from_list THEN 'list' ELSE 'inaturalist' END AS source,
       CASE WHEN from_list THEN scientific_name END AS list_entry,
       CASE WHEN from_list THEN depth END AS list_entry_depth
FROM chosen
WHERE CASE WHEN from_list THEN list_name ELSE preferred_common_name END IS NOT NULL;
COMMENT ON VIEW plant_taxon_common_name IS 'The common name of each cached taxon that has one: the name of the old-Beeline list''s entry for the taxon itself; otherwise iNaturalist''s preferred name for Oregon, in sentence case with proper nouns kept (plant_inat_common_name); otherwise the name of the nearest coarser list entry that covers it (the entry''s taxon is an ancestor; the lowest depth wins), so a genus or family entry names a species only where iNaturalist has no name for it (Peter, 2026-11-14). An entry''s name is the first of those its cell lists; an entry at genus rank or above whose cell lists several names gives none (plant_list_entry_several_names). source says which; list_entry and list_entry_depth say which entry and how far above the taxon it sits (0 is the taxon''s own entry), and are NULL when the name is iNaturalist''s. An entry''s taxon, and the ancestors it is matched against, are taken as iNaturalist has them today (inat_taxon_current), so an entry whose taxon was replaced covers the replacement''s descendants and one whose taxon was split covers nothing. Reads the taxon''s own stored lineage for the depth, so a retired taxon is judged by its stale one; sample_host reads this view for the retired host''s current taxon instead.';
