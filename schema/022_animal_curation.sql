-- Where the program's taxonomy departs from ITIS, and on whose word
-- (beeline-45v.1). ITIS is the basis (Andony, 2026-09-11), so a node that
-- matches a current ITIS name needs no row here: this table holds only the
-- claims — a name ITIS does not have that the program keeps, a name ITIS
-- calls outdated that the program keeps anyway, and which of two ITIS names
-- with one spelling the program means. Each is a taxonomist's decision with
-- a reason and, where a paper is behind it, a reference, and each records
-- what ITIS said at the time, which is what lets animal_curation_stale
-- (schema/118) check every later release against it: ITIS adopting a
-- departure retires it, ITIS gaining an addition flags it.
--
-- A satellite keyed by the node, like person_admin: the rows are replayed
-- from ingest/taxon-curation.csv onto every rebuild (src/taxon-curation.ts),
-- so the per-store entity_id never leaves the store. Nothing references this
-- table, so it stays writable (duckdb/duckdb#20246).
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
