-- The common name of each taxon in the cache (beeline-rfkj.2), in its own file
-- after the cache's worklist (schema/112) and what a stored taxon stands for
-- today (inat_taxon_current, schema/113), which it reads to follow a list
-- entry's taxon to its current one. beeline-rfkj.3 composes on top of it, in
-- files after this one: it resolves a retired host to its current taxon and
-- reads this view's row for that taxon, whose own lineage is the current one,
-- from a copy of this view that the writers keep fresh
-- (plant_common_name_cache, schema/068). So inat_taxon_current must not read
-- this view, or the two would depend on each other.
--
-- The list's names come from schema/111.

-- iNaturalist's and the list's common names, set in sentence case
-- (beeline-rfkj.9). iNaturalist writes many of them in title case
-- ("Silverleaf Phacelia"), the old plant list does too in some 60 rows
-- ("Common Fiddleneck"), and Beeline's style (src/app/views/design/names.tsx)
-- is capitals only for proper nouns ("silverleaf phacelia", "Oregon grape").
-- Neither source is changed: inat_taxon.preferred_common_name and
-- plant_list_entry.common_name stay as they were said. The name is converted
-- here, where it is chosen for display, and plant_common_name_cache keeps the
-- converted one, so a reader pays nothing. It is done in SQL so that
-- plant_common_name_stale, which compares the cache with this view, still
-- judges what a page shows.
--
-- ADR 0001 (dialect-neutral DDL) is broken here on purpose, because no
-- portable construct cuts a name into words: regexp_extract_all splits it,
-- unnest with generate_subscripts numbers the pieces, list slices
-- (tk[p:q]) and array_to_string compare a run of them with a phrase,
-- regexp_matches takes the 'i' option and \p{L} / \p{Lu} / \p{Ll} are Unicode
-- classes. A port to Postgres rewrites them as regexp_matches(..., 'g') with
-- WITH ORDINALITY, array slices, and [[:alpha:]] classes (or a unicode-aware
-- extension), and the tests in test/plant-name-case.test.ts say what the
-- answer must be.
--
-- A name is cut into words (runs of letters and apostrophes) and what lies
-- between them, so a hyphen ends a word and each part of "Douglas-fir" is
-- judged alone. Every word is set in lower case, except that it keeps its
-- capital when
--   1. it is in a phrase that ingest/plant-proper-nouns.csv says keep, of
--      several words ("Rocky Mountain", "Great Basin"), matched on whole
--      consecutive words so that the second word of a place keeps its
--      capital where it is a common noun elsewhere, wherever the phrase
--      occurs in the name (every occurrence), in whatever case the name has
--      it, and set as the file spells it; a phrase is not found next to a
--      hyphen, since then it is part of a longer compound ("Blue
--      Mountain-heath"); or
--   2. it is a word the file says keep (Utah, Oregon, Chinese), likewise set
--      as the file spells it, which also restores the eponyms iNaturalist
--      wrote in lower case ("bebb's"); or
--   3. it is a possessive ("Douglas'", "Nuttall's", "Ladies'": the word ends
--      in 's or in s'), which is nearly always an eponym, unless the file
--      says lower ("Shepherd's", "Devil's", "Lady's"): the file beats the
--      possessive rule. A word that ends in a bare apostrophe after another
--      letter ("O'" in "Jack-O'-Lantern") is not a possessive; or
--   4. it is the abbreviation St or Mt ("St. John's wort", "St John's wort"), a word of its own
--      that does not follow a digit (not the st of 1st).
-- Both the file and the names are compared with the curly apostrophe folded
-- to the straight one, and a word is shown with the apostrophe the name wrote.
-- Nothing is learned from the data: a word keeps its capital only for a reason
-- that is written in the file, so that the behaviour is the same after
-- iNaturalist's names change, and a diff of the file is what changes it.
--
-- What is left alone: the ranks section, subsection, subgenus, series and
-- subseries (their names are scientific names); a name that is the taxon's
-- own scientific name; a list name that is the entry's own scientific name
-- (plant_list_entry_common_name already leaves those out); and a name that begins with a rank ("section Salicaster"), whose capital is scientific.

CREATE VIEW plant_name_to_set AS
SELECT DISTINCT common_name AS name
FROM (
  SELECT t.preferred_common_name AS common_name FROM inat_taxon t
  WHERE t.preferred_common_name IS NOT NULL
    AND t.rank NOT IN ('section', 'subsection', 'subgenus', 'series', 'subseries')
    AND t.preferred_common_name <> t.name
  UNION ALL
  SELECT common_name FROM plant_list_entry_common_name
)
-- A rank before a scientific name ("section Salicaster") is no common name, and its capital is a scientific one
WHERE NOT regexp_matches(common_name, '^(genus|subtribe|tribe|subfamily|family|order|section|subsection|subgenus|series|subseries|superfamily|class) ', 'i');
COMMENT ON VIEW plant_name_to_set IS 'Every distinct common name that is set in sentence case: iNaturalist''s preferred common names of the taxa whose names are not scientific names, and the names the plant list shows (plant_list_entry_common_name).';

CREATE VIEW plant_name_sentence_case AS
WITH names AS (
  -- Each name as alternating words (letters and apostrophes) and what lies between them
  SELECT name, regexp_extract_all(name, '[\p{L}''’]+|[^\p{L}''’]+') AS tk FROM plant_name_to_set
), tokens AS (
  SELECT n.name, u.token, u.pos
  FROM names n,
  LATERAL (SELECT unnest(n.tk) AS token, generate_subscripts(n.tk, 1) AS pos) u
), phrase AS (
  SELECT word AS phrase, regexp_extract_all(word, '[\p{L}''’]+|[^\p{L}''’]+') AS ptk
  FROM plant_proper_noun
  WHERE treatment = 'keep' AND strpos(word, ' ') > 0
), phrase_hit AS (
  -- Where a phrase of the file is in a name: whole words, in any case, with the apostrophes folded, and not touching a hyphen
  SELECT n.name, k.pos AS first_pos, p.phrase, p.ptk, len(p.ptk) AS size
  FROM tokens k
  JOIN names n ON n.name = k.name
  JOIN phrase p ON lower(replace(k.token, '’', '''')) = lower(replace(p.ptk[1], '’', ''''))
  WHERE lower(replace(array_to_string(n.tk[k.pos:k.pos + len(p.ptk) - 1], ''), '’', '''')) = lower(replace(p.phrase, '’', ''''))
    AND NOT (k.pos > 1 AND n.tk[k.pos - 1] LIKE '%-')
    AND NOT coalesce(n.tk[k.pos + len(p.ptk)] LIKE '-%', false)
), judged AS (
  SELECT k.name, k.pos,
         CASE
           -- Inside a phrase of the file: the phrase's own spelling. Of phrases that overlap, the earlier one, then the first by spelling
           WHEN h.phrase IS NOT NULL THEN h.ptk[k.pos - h.first_pos + 1]
           -- A word the file keeps, whatever case the name wrote it in
           WHEN f.treatment = 'keep' THEN f.word
           -- St and Mt, with or without the period, but not the st of 1st
           WHEN lower(k.token) IN ('st', 'mt') AND (k.next_token LIKE '.%' OR k.next_token = ' ') AND NOT coalesce(regexp_matches(k.prev_token, '[0-9]$'), false)
             THEN upper(k.token[1]) || lower(k.token[2:])
           -- A word that does not begin with a capital stays as written, except that a capital after its apostrophe (o'Clock) goes
           WHEN NOT regexp_matches(k.token, '^\p{Lu}') THEN CASE WHEN regexp_matches(k.token, '[''’]') THEN lower(k.token) ELSE k.token END
           -- A possessive keeps its capital unless the file says lower
           WHEN f.word IS NULL AND regexp_matches(k.token, '(\p{L}[''’]s|s[''’])$') THEN k.token
           ELSE lower(k.token)
         END AS shown
  FROM (SELECT *, lag(token) OVER (PARTITION BY name ORDER BY pos) AS prev_token, lead(token) OVER (PARTITION BY name ORDER BY pos) AS next_token FROM tokens) k
  LEFT JOIN LATERAL (
    SELECT h.phrase, h.ptk, h.first_pos FROM phrase_hit h
    WHERE h.name = k.name AND k.pos >= h.first_pos AND k.pos < h.first_pos + h.size
    ORDER BY h.first_pos, h.phrase
    LIMIT 1) h ON true
  LEFT JOIN plant_proper_noun f ON lower(replace(f.word, '’', '''')) = lower(replace(k.token, '’', '''')) AND strpos(f.word, ' ') = 0
)
SELECT name, string_agg(shown, '' ORDER BY pos) AS common_name
FROM judged
GROUP BY name;
COMMENT ON VIEW plant_name_sentence_case IS 'Each name of plant_name_to_set in sentence case: every word in lower case except proper nouns (the rules at the top of schema/114). A phrase of ingest/plant-proper-nouns.csv and a word it keeps are set as the file spells them, whatever case the name had them in; a possessive keeps its capital unless the file says lower; St and Mt keep theirs. A name already in sentence case comes out unchanged apart from its first word, which loses its capital like any other. Nothing is learned from the data.';

CREATE VIEW plant_inat_common_name AS
SELECT t.inat_taxon_id, coalesce(c.common_name, t.preferred_common_name) AS common_name
FROM inat_taxon t
LEFT JOIN plant_name_sentence_case c ON c.name = t.preferred_common_name
WHERE t.preferred_common_name IS NOT NULL
  AND t.rank NOT IN ('section', 'subsection', 'subgenus', 'series', 'subseries')
  AND t.preferred_common_name <> t.name;
COMMENT ON VIEW plant_inat_common_name IS 'iNaturalist''s preferred common name of each taxon that has one, in sentence case (plant_name_sentence_case). Taxa at section, subsection, subgenus, series or subseries rank, and a name that is the taxon''s own scientific name, are not here: plant_taxon_common_name gives those as iNaturalist wrote them.';

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
  SELECT a.inat_taxon_id, coalesce(shown.common_name, c.common_name) AS common_name, c.scientific_name, a.depth,
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
  LEFT JOIN plant_name_sentence_case shown ON shown.name = c.common_name
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
COMMENT ON VIEW plant_taxon_common_name IS 'The common name of each cached taxon that has one, always in sentence case with proper nouns kept (plant_name_sentence_case): the name of the old-Beeline list''s entry for the taxon itself; otherwise iNaturalist''s preferred name for Oregon (plant_inat_common_name); otherwise the name of the nearest coarser list entry that covers it (the entry''s taxon is an ancestor; the lowest depth wins), so a genus or family entry names a species only where iNaturalist has no name for it (Peter, 2026-11-14). An entry''s name is the first of those its cell lists; an entry at genus rank or above whose cell lists several names gives none (plant_list_entry_several_names). source says which; list_entry and list_entry_depth say which entry and how far above the taxon it sits (0 is the taxon''s own entry), and are NULL when the name is iNaturalist''s. An entry''s taxon, and the ancestors it is matched against, are taken as iNaturalist has them today (inat_taxon_current), so an entry whose taxon was replaced covers the replacement''s descendants and one whose taxon was split covers nothing. Reads the taxon''s own stored lineage for the depth, so a retired taxon is judged by its stale one; sample_host reads this view for the retired host''s current taxon instead.';
