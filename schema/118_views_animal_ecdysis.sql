-- How each animal node stands against Ecdysis's thesaurus (beeline-7gob).
--
-- animal_ecdysis_match is the one definition of what a node matches: the
-- Ecdysis names at its rank with its exact spelling, accepted names preferred
-- over synonyms, and an id only where exactly one name remains. Two remaining
-- is a homonym — two accepted names, different authors — and the node carries
-- no authorship that could tell them apart, so it is named rather than
-- guessed — unless a taxonomist has said which one is meant (animal_curation,
-- kind 'homonym'), whose choice is taken only while it is still one of the
-- candidates: a choice Ecdysis has since moved from under is reported by
-- animal_curation_stale, not silently honoured. ingest/match-ecdysis.sql
-- restates animal.ecdysis_tid from this view, and animal_ecdysis_stale
-- compares the two, the same shape as sample_elevation_stale (schema/170): an
-- unrestated column is not a visibly broken one.
CREATE VIEW animal_ecdysis_match AS
WITH candidate AS (
  SELECT a.entity_id, t.tid, t.status
  FROM animal a
  JOIN ecdysis_taxon t ON t.rank = a.rank AND t.name = a.scientific_name
),
preferred AS (
  SELECT entity_id,
         CASE WHEN count(*) FILTER (WHERE status = 'accepted') > 0 THEN 'accepted' ELSE 'synonym' END AS status
  FROM candidate
  GROUP BY entity_id
),
matched AS (
  SELECT p.entity_id, p.status, count(*) AS candidates,
         CASE WHEN count(*) = 1 THEN min(c.tid) END AS tid
  FROM preferred p
  JOIN candidate c ON c.entity_id = p.entity_id AND c.status = p.status
  GROUP BY p.entity_id, p.status
),
chosen AS (
  SELECT cu.animal_id, cu.ecdysis_tid AS tid
  FROM animal_curation cu
  JOIN candidate c ON c.entity_id = cu.animal_id AND c.tid = cu.ecdysis_tid
  WHERE cu.kind = 'homonym'
)
SELECT m.entity_id, m.status, m.candidates, coalesce(h.tid, m.tid) AS tid
FROM matched m
LEFT JOIN chosen h ON h.animal_id = m.entity_id;
COMMENT ON VIEW animal_ecdysis_match IS 'What each animal node matches in Ecdysis''s thesaurus: the names at its rank and spelling, accepted preferred over synonyms, with an id only where exactly one remains — or where a taxonomist has chosen between two (animal_curation, kind homonym). The definition animal.ecdysis_tid is restated from (ingest/match-ecdysis.sql) and checked against (animal_ecdysis_stale).';

-- Every node, and what its id — or the lack of one — means. `not loaded` is
-- its own answer so that a store nobody has loaded the thesaurus into never
-- reads as a taxonomy Ecdysis has never heard of.
CREATE VIEW animal_ecdysis AS
SELECT a.entity_id, a.rank, a.scientific_name, a.ecdysis_tid,
       CASE
         WHEN NOT EXISTS (SELECT 1 FROM ecdysis_taxon) THEN 'not loaded'
         WHEN m.candidates > 1 AND m.tid IS NULL THEN 'homonym'
         WHEN t.status = 'accepted' THEN 'accepted'
         WHEN t.status = 'synonym' THEN 'synonym'
         ELSE 'absent'
       END AS standing,
       CASE WHEN t.status = 'synonym' THEN acc.name END AS accepted_name
FROM animal a
LEFT JOIN animal_ecdysis_match m ON m.entity_id = a.entity_id
LEFT JOIN ecdysis_taxon t ON t.tid = a.ecdysis_tid
LEFT JOIN ecdysis_taxon acc ON acc.tid = t.accepted_tid;
COMMENT ON VIEW animal_ecdysis IS 'Each animal node against Ecdysis''s thesaurus: accepted (matches an accepted name, or a homonym a taxonomist has resolved), synonym (matches a synonym; accepted_name says what Ecdysis files it under), homonym (two accepted names share the spelling and nobody has chosen), absent (Ecdysis has no such name at that rank — a name the program keeps beyond it), or not loaded. What the program does about a synonym or an absent name is animal_curation (schema/022).';

CREATE VIEW animal_ecdysis_stale AS
SELECT a.entity_id, a.rank, a.scientific_name, a.ecdysis_tid, m.tid AS matched_tid
FROM animal a
LEFT JOIN animal_ecdysis_match m ON m.entity_id = a.entity_id
WHERE a.ecdysis_tid IS DISTINCT FROM m.tid;
COMMENT ON VIEW animal_ecdysis_stale IS 'Nodes whose stored ecdysis_tid disagrees with what they match now: the thesaurus or the tree changed without ingest/match-ecdysis.sql running. Asserted empty by test; pnpm ecdysis:taxonomy and legacy promotion both empty it.';

-- Each curation row against the thesaurus the store holds now. A decision
-- records what Ecdysis said when it was made (schema/022); this is the check
-- of every later fetch against it, which is what keeps the layer from going
-- stale in the opposite direction from Ecdysis (beeline-45v.1). Empty while
-- the thesaurus is not loaded — there is nothing to compare, and the branches
-- that LEFT JOIN ecdysis_taxon would otherwise call every id gone — and
-- otherwise one row per decision the thesaurus has moved from under, saying
-- how. Three kinds, three selects, rather than one CASE over all of them:
-- each kind's question is different.
CREATE VIEW animal_curation_stale AS
WITH loaded AS (SELECT max(fetched_on) AS fetched_on FROM ecdysis_taxon),
accepted_name AS (
  -- An accepted Ecdysis name at the node's rank and spelling, if there is
  -- exactly one; its count where there are more.
  SELECT a.entity_id, count(*) AS n, CASE WHEN count(*) = 1 THEN min(t.tid) END AS tid
  FROM animal a
  JOIN ecdysis_taxon t ON t.rank = a.rank AND t.name = a.scientific_name AND t.status = 'accepted'
  GROUP BY a.entity_id
)
-- An addition Ecdysis now carries: the program's name has caught on, or was
-- always there under a spelling the match could not see.
SELECT c.animal_id, a.rank, a.scientific_name, c.kind, c.ecdysis_fetched_on, l.fetched_on,
       concat('Ecdysis now has this name as accepted (taxon ', an.tid, ')') AS problem
FROM animal_curation c
JOIN animal a ON a.entity_id = c.animal_id
JOIN accepted_name an ON an.entity_id = c.animal_id
CROSS JOIN loaded l
WHERE c.kind = 'addition' AND an.n = 1
UNION ALL
-- A departure Ecdysis has since adopted — retire it — or moved further from:
-- the id gone, or filed under a third name.
SELECT c.animal_id, a.rank, a.scientific_name, c.kind, c.ecdysis_fetched_on, l.fetched_on,
       CASE
         WHEN an.tid IS NOT NULL THEN 'Ecdysis now accepts this name: the departure can be retired'
         WHEN t.tid IS NULL THEN concat('Ecdysis no longer carries taxon ', c.ecdysis_tid)
         WHEN t.status = 'accepted' THEN concat('taxon ', c.ecdysis_tid, ' is now an accepted name under a different spelling: ', t.name)
         WHEN acc.name IS DISTINCT FROM c.ecdysis_accepted_name
           THEN concat('Ecdysis now files it under ', coalesce(acc.name, 'nothing'), ', not ', c.ecdysis_accepted_name)
       END AS problem
FROM animal_curation c
JOIN animal a ON a.entity_id = c.animal_id
CROSS JOIN loaded l
LEFT JOIN accepted_name an ON an.entity_id = c.animal_id
LEFT JOIN ecdysis_taxon t ON t.tid = c.ecdysis_tid
LEFT JOIN ecdysis_taxon acc ON acc.tid = t.accepted_tid
WHERE c.kind = 'departure'
  AND l.fetched_on IS NOT NULL
  AND (an.tid IS NOT NULL OR t.tid IS NULL OR t.status = 'accepted' OR acc.name IS DISTINCT FROM c.ecdysis_accepted_name)
UNION ALL
-- A homonym resolution whose choice is no longer one of two: the chosen name
-- gone or a synonym, the other one gone so there is nothing left to choose,
-- or an id that is accepted but names something else — which the match
-- already refuses to honour (animal_ecdysis_match takes a choice only from
-- among the candidates), so without this row the node would silently read as
-- an unresolved homonym.
SELECT c.animal_id, a.rank, a.scientific_name, c.kind, c.ecdysis_fetched_on, l.fetched_on,
       CASE
         WHEN t.tid IS NULL THEN concat('Ecdysis no longer carries the chosen taxon ', c.ecdysis_tid)
         WHEN t.status <> 'accepted' THEN concat('the chosen taxon ', c.ecdysis_tid, ' is no longer an accepted name')
         WHEN t.rank <> a.rank OR t.name <> a.scientific_name
           THEN concat('the chosen taxon ', c.ecdysis_tid, ' is ', t.name, ' (', t.rank, '), not a name at this rank and spelling')
         WHEN coalesce(an.n, 0) < 2 THEN 'Ecdysis now has one accepted name at this spelling: the choice is no longer needed'
       END AS problem
FROM animal_curation c
JOIN animal a ON a.entity_id = c.animal_id
CROSS JOIN loaded l
LEFT JOIN accepted_name an ON an.entity_id = c.animal_id
LEFT JOIN ecdysis_taxon t ON t.tid = c.ecdysis_tid
WHERE c.kind = 'homonym'
  AND l.fetched_on IS NOT NULL
  AND (t.tid IS NULL OR t.status <> 'accepted' OR t.rank <> a.rank OR t.name <> a.scientific_name OR coalesce(an.n, 0) < 2);
COMMENT ON VIEW animal_curation_stale IS 'Curation rows the thesaurus now loaded has moved from under: an addition Ecdysis now carries, a departure Ecdysis has adopted (retire it) or filed under another name, a homonym choice Ecdysis no longer offers. Each names the problem; a taxonomist decides what follows. Empty while the thesaurus is not loaded.';
