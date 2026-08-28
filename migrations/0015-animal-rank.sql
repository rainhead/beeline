-- Migration for schema/020_animal.sql and
-- schema/115_view_determination_misplaced_qualifier.sql (beeline-a2p,
-- beeline-4zi): the ranks this store admits, and how they order.
--
-- Rank was TEXT with no vocabulary and no ordering, so "species or finer" —
-- the comparison the domain actually needs — had no answer, and each caller
-- grew its own copy of the ladder: a set of italic ranks in a TSX file, a
-- CASE cascade in promotion, and two more callers due in phases 5 and 6.
CREATE TABLE animal_rank (
  rank    TEXT PRIMARY KEY,
  ordinal INTEGER NOT NULL UNIQUE,
  italic  BOOLEAN NOT NULL
);
COMMENT ON TABLE animal_rank IS 'The ranks animal.rank may take, in order. Reference data, seeded here like qc_rule: a rank is not a decision anyone makes at runtime.';
COMMENT ON COLUMN animal_rank.ordinal IS 'Deeper is larger, gapped by 10 so a rank can be inserted without renumbering. Compare, never display.';
COMMENT ON COLUMN animal_rank.italic IS 'Genus and below are italic (/design/names). The renderer keeps its own wider list — it must do something sensible with a rank this table has never heard of — and a test pins the two to agree wherever they overlap.';

INSERT INTO animal_rank (rank, ordinal, italic) VALUES
  ('kingdom',      10, false),
  ('phylum',       30, false),
  ('class',        60, false),
  ('order',       100, false),
  ('suborder',    110, false),
  ('superfamily', 130, false),
  ('family',      140, false),
  ('genus',       180, true),
  ('subgenus',    190, true),
  ('species',     220, true),
  ('subspecies',  230, true);

CREATE VIEW determination_misplaced_qualifier AS
SELECT d.entity_id, d.specimen_id, d.qualifier, a.rank, a.scientific_name
FROM determination d
JOIN animal a ON a.entity_id = d.animal_id
JOIN animal_rank r ON r.rank = a.rank
WHERE d.qualifier IS NOT NULL
  AND r.ordinal < (SELECT ordinal FROM animal_rank WHERE rank = 'species');

-- animal.rank REFERENCES animal_rank(rank) and UNIQUE (rank, scientific_name)
-- exist on a fresh build and not here: DuckDB has no ALTER TABLE ADD
-- CONSTRAINT (ADR 0006). Both arrive at the next rebuild, and unlike the
-- elevation pairing they get no view standing in for them, because nothing
-- writes `animal` in a deployed store — the rows come from legacy promotion,
-- which refuses to run against a store that already has people, and the
-- curation workflow that would write them later is still an open design point
-- (docs/schema-sketch.md). If that changes, this is the note that is now wrong.
