-- Migration for animal_curation (schema/022) and the animal_itis views that
-- read it (schema/118), beeline-45v.1: the program's stated departures from
-- ITIS, and the release check against them. A new table and a new view, plus
-- two views recreated because the match now honours a taxonomist's choice
-- between two ITIS names at one spelling. The delta is the schema verbatim.

CREATE TABLE animal_curation (
  animal_id         INTEGER PRIMARY KEY REFERENCES animal(entity_id),
  kind              TEXT NOT NULL CHECK (kind IN ('addition', 'departure', 'homonym')),
  itis_tsn          BIGINT,
  itis_current_name TEXT,
  itis_release      DATE NOT NULL,
  taxonomist        TEXT NOT NULL CHECK (taxonomist <> ''),
  decided_on        DATE NOT NULL,
  reference         TEXT,
  reason            TEXT NOT NULL CHECK (reason <> ''),
  -- An addition is a name ITIS has not got, so it has no TSN to record; the
  -- other two kinds are about an ITIS name and must say which.
  CHECK ((kind = 'addition') = (itis_tsn IS NULL)),
  CHECK ((kind = 'departure') = (itis_current_name IS NOT NULL))
);
COMMENT ON TABLE animal_curation IS 'The program''s stated departures from ITIS, one per node (beeline-45v.1): an addition (a name ITIS lacks, kept), a departure (a name ITIS calls outdated, kept under the program''s treatment), or a homonym resolution (which of two current ITIS names at one spelling is meant). Every row names the taxonomist who decided and why; replayed from ingest/taxon-curation.csv on every rebuild. A node matching a current ITIS name has no row: ITIS is the default.';
COMMENT ON COLUMN animal_curation.kind IS 'addition: ITIS has no name at this rank and spelling. departure: ITIS has it as a synonym of itis_current_name and the program keeps it. homonym: ITIS has two current names at this spelling and itis_tsn is the one meant.';
COMMENT ON COLUMN animal_curation.itis_tsn IS 'What ITIS said at the time: for a departure the TSN of the program''s name (an outdated one in ITIS), for a homonym the TSN chosen. NULL for an addition, which has none.';
COMMENT ON COLUMN animal_curation.itis_current_name IS 'For a departure, the name ITIS accepted instead when the decision was made; animal_curation_stale compares it against what ITIS says now.';
COMMENT ON COLUMN animal_curation.itis_release IS 'The ITIS release (itis_taxon.itis_as_of) the decision was made against.';
COMMENT ON COLUMN animal_curation.taxonomist IS 'Who decided, by name. Required: the loader transcribes a decision and never makes one, so a row nobody signed is refused.';
COMMENT ON COLUMN animal_curation.reference IS 'A DOI or URL for the paper behind the decision, where there is one.';
COMMENT ON COLUMN animal_curation.reason IS 'Why, in the taxonomist''s words — the part a later reader needs and cannot reconstruct.';

CREATE OR REPLACE VIEW animal_itis_match AS
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
),
matched AS (
  SELECT p.entity_id, p.usage, count(*) AS candidates,
         CASE WHEN count(*) = 1 THEN min(c.tsn) END AS tsn
  FROM preferred p
  JOIN candidate c ON c.entity_id = p.entity_id AND c.usage = p.usage
  GROUP BY p.entity_id, p.usage
),
chosen AS (
  SELECT cu.animal_id, cu.itis_tsn AS tsn
  FROM animal_curation cu
  JOIN candidate c ON c.entity_id = cu.animal_id AND c.tsn = cu.itis_tsn
  WHERE cu.kind = 'homonym'
)
SELECT m.entity_id, m.usage, m.candidates, coalesce(h.tsn, m.tsn) AS tsn
FROM matched m
LEFT JOIN chosen h ON h.animal_id = m.entity_id;
COMMENT ON VIEW animal_itis_match IS 'What each animal node matches in ITIS: the names at its rank and spelling, current preferred over outdated, with a TSN only where exactly one remains — or where a taxonomist has chosen between two (animal_curation, kind homonym). The definition animal.itis_tsn is restated from (ingest/match-itis.sql) and checked against (animal_itis_stale).';

CREATE OR REPLACE VIEW animal_itis AS
SELECT a.entity_id, a.rank, a.scientific_name, a.itis_tsn,
       CASE
         WHEN NOT EXISTS (SELECT 1 FROM itis_taxon) THEN 'not loaded'
         WHEN m.candidates > 1 AND m.tsn IS NULL THEN 'homonym'
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
COMMENT ON VIEW animal_itis IS 'Each animal node against ITIS: valid (matches a current ITIS name, or a homonym a taxonomist has resolved), synonym (matches an outdated one; current_name says what ITIS calls it now), homonym (two current ITIS names share the spelling and nobody has chosen), absent (ITIS has no such name at that rank — a name the program keeps beyond ITIS), or not loaded. What the program does about a synonym or an absent name is animal_curation (schema/022).';

CREATE OR REPLACE VIEW animal_itis_stale AS
SELECT a.entity_id, a.rank, a.scientific_name, a.itis_tsn, m.tsn AS matched_tsn
FROM animal a
LEFT JOIN animal_itis_match m ON m.entity_id = a.entity_id
WHERE a.itis_tsn IS DISTINCT FROM m.tsn;
COMMENT ON VIEW animal_itis_stale IS 'Nodes whose stored itis_tsn disagrees with what they match now: ITIS or the tree changed without ingest/match-itis.sql running. Asserted empty by test; pnpm itis:load and legacy promotion both empty it.';

CREATE OR REPLACE VIEW animal_curation_stale AS
WITH loaded AS (SELECT max(itis_as_of) AS itis_as_of FROM itis_taxon),
current_name AS (
  -- A current ITIS name at the node's rank and spelling, if there is exactly
  -- one; its count where there are more.
  SELECT a.entity_id, count(*) AS n, CASE WHEN count(*) = 1 THEN min(t.tsn) END AS tsn
  FROM animal a
  JOIN itis_taxon t ON t.rank = a.rank AND t.name = a.scientific_name AND t.usage = 'valid'
  GROUP BY a.entity_id
),
accepted AS (
  -- What ITIS now calls an outdated TSN.
  SELECT s.tsn, string_agg(cur.name, '; ' ORDER BY cur.name) AS names
  FROM itis_synonym s JOIN itis_taxon cur ON cur.tsn = s.accepted_tsn
  GROUP BY s.tsn
)
SELECT c.animal_id, a.rank, a.scientific_name, c.kind, c.itis_release, l.itis_as_of,
       concat('ITIS now has this name as current (TSN ', cn.tsn, ')') AS problem
FROM animal_curation c
JOIN animal a ON a.entity_id = c.animal_id
JOIN current_name cn ON cn.entity_id = c.animal_id
CROSS JOIN loaded l
WHERE c.kind = 'addition' AND cn.n = 1
UNION ALL
SELECT c.animal_id, a.rank, a.scientific_name, c.kind, c.itis_release, l.itis_as_of,
       CASE
         WHEN cn.tsn IS NOT NULL THEN 'ITIS now accepts this name: the departure can be retired'
         WHEN t.tsn IS NULL THEN concat('ITIS no longer carries TSN ', c.itis_tsn)
         WHEN t.usage = 'valid' THEN concat('TSN ', c.itis_tsn, ' is now a current name under a different spelling: ', t.name)
         WHEN acc.names IS DISTINCT FROM c.itis_current_name
           THEN concat('ITIS now calls it ', coalesce(acc.names, 'nothing'), ', not ', c.itis_current_name)
       END AS problem
FROM animal_curation c
JOIN animal a ON a.entity_id = c.animal_id
CROSS JOIN loaded l
LEFT JOIN current_name cn ON cn.entity_id = c.animal_id
LEFT JOIN itis_taxon t ON t.tsn = c.itis_tsn
LEFT JOIN accepted acc ON acc.tsn = c.itis_tsn
WHERE c.kind = 'departure'
  AND l.itis_as_of IS NOT NULL
  AND (cn.tsn IS NOT NULL OR t.tsn IS NULL OR t.usage = 'valid' OR acc.names IS DISTINCT FROM c.itis_current_name)
UNION ALL
SELECT c.animal_id, a.rank, a.scientific_name, c.kind, c.itis_release, l.itis_as_of,
       CASE
         WHEN t.tsn IS NULL THEN concat('ITIS no longer carries the chosen TSN ', c.itis_tsn)
         WHEN t.usage <> 'valid' THEN concat('the chosen TSN ', c.itis_tsn, ' is no longer a current name')
         WHEN t.rank <> a.rank OR t.name <> a.scientific_name
           THEN concat('the chosen TSN ', c.itis_tsn, ' is ', t.name, ' (', t.rank, '), not a name at this rank and spelling')
         WHEN coalesce(cn.n, 0) < 2 THEN 'ITIS now has one current name at this spelling: the choice is no longer needed'
       END AS problem
FROM animal_curation c
JOIN animal a ON a.entity_id = c.animal_id
CROSS JOIN loaded l
LEFT JOIN current_name cn ON cn.entity_id = c.animal_id
LEFT JOIN itis_taxon t ON t.tsn = c.itis_tsn
WHERE c.kind = 'homonym'
  AND l.itis_as_of IS NOT NULL
  AND (t.tsn IS NULL OR t.usage <> 'valid' OR t.rank <> a.rank OR t.name <> a.scientific_name OR coalesce(cn.n, 0) < 2);
COMMENT ON VIEW animal_curation_stale IS 'Curation rows the ITIS release now loaded has moved from under: an addition ITIS now carries, a departure ITIS has adopted (retire it) or renamed again, a homonym choice ITIS no longer offers. Each names the problem; a taxonomist decides what follows. Empty while ITIS is not loaded.';
