-- How each animal node stands against ITIS (beeline-45v).
--
-- animal_itis_match is the one definition of what a node matches: the ITIS
-- names at its rank with its exact spelling, current names preferred over
-- outdated ones, and a TSN only where exactly one name remains. Two remaining
-- is a homonym — two current names, different authors — and the node carries
-- no authorship that could tell them apart (the three on the dev store all
-- have NULL authorship), so it is named rather than guessed. ingest/match-itis.sql
-- restates animal.itis_tsn from this view, and animal_itis_stale compares the
-- two, the same shape as sample_elevation_stale (schema/170): an unrestated
-- column is not a visibly broken one.
CREATE VIEW animal_itis_match AS
WITH candidate AS (
  SELECT a.entity_id, t.tsn, t.usage
  FROM animal a
  JOIN itis_taxon t ON t.rank = a.rank AND t.name = a.scientific_name
),
preferred AS (
  SELECT entity_id,
         CASE WHEN count(*) FILTER (WHERE usage = 'valid') > 0 THEN 'valid' ELSE 'invalid' END AS usage
  FROM candidate
  GROUP BY entity_id
)
SELECT p.entity_id, p.usage, count(*) AS candidates,
       CASE WHEN count(*) = 1 THEN min(c.tsn) END AS tsn
FROM preferred p
JOIN candidate c ON c.entity_id = p.entity_id AND c.usage = p.usage
GROUP BY p.entity_id, p.usage;
COMMENT ON VIEW animal_itis_match IS 'What each animal node matches in ITIS: the names at its rank and spelling, current preferred over outdated, with a TSN only where exactly one remains. The definition animal.itis_tsn is restated from (ingest/match-itis.sql) and checked against (animal_itis_stale).';

-- Every node, and what its TSN — or the lack of one — means. `not loaded` is
-- its own answer so that a store nobody has loaded ITIS into never reads as a
-- taxonomy ITIS has never heard of.
CREATE VIEW animal_itis AS
SELECT a.entity_id, a.rank, a.scientific_name, a.itis_tsn,
       CASE
         WHEN NOT EXISTS (SELECT 1 FROM itis_taxon) THEN 'not loaded'
         WHEN m.candidates > 1 THEN 'homonym'
         WHEN t.usage = 'valid' THEN 'valid'
         WHEN t.usage = 'invalid' THEN 'synonym'
         ELSE 'absent'
       END AS standing,
       (SELECT string_agg(cur.name, '; ' ORDER BY cur.name)
        FROM itis_synonym s JOIN itis_taxon cur ON cur.tsn = s.accepted_tsn
        WHERE s.tsn = a.itis_tsn) AS current_name
FROM animal a
LEFT JOIN animal_itis_match m ON m.entity_id = a.entity_id
LEFT JOIN itis_taxon t ON t.tsn = a.itis_tsn;
COMMENT ON VIEW animal_itis IS 'Each animal node against ITIS: valid (matches a current ITIS name), synonym (matches an outdated one; current_name says what ITIS calls it now), homonym (two current ITIS names share the spelling), absent (ITIS has no such name at that rank — a name the program keeps beyond ITIS), or not loaded. What the program does about a synonym or an absent name is beeline-45v.1.';

CREATE VIEW animal_itis_stale AS
SELECT a.entity_id, a.rank, a.scientific_name, a.itis_tsn, m.tsn AS matched_tsn
FROM animal a
LEFT JOIN animal_itis_match m ON m.entity_id = a.entity_id
WHERE a.itis_tsn IS DISTINCT FROM m.tsn;
COMMENT ON VIEW animal_itis_stale IS 'Nodes whose stored itis_tsn disagrees with what they match now: ITIS or the tree changed without ingest/match-itis.sql running. Asserted empty by test; pnpm itis:load and legacy promotion both empty it.';
