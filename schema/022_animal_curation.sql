-- Where the program's taxonomy departs from Ecdysis's thesaurus, and on whose
-- word (beeline-45v.1). Ecdysis is the basis (beeline-7gob; ITIS until
-- 2026-10-23), so a node that matches an accepted Ecdysis name needs no row
-- here: this table holds only the claims — a name Ecdysis does not have that
-- the program keeps, a name Ecdysis calls a synonym that the program keeps
-- anyway, and which of two Ecdysis names with one spelling the program means.
-- Each is a taxonomist's decision with a reason and, where a paper is behind
-- it, a reference, and each records what Ecdysis said at the time, which is
-- what lets animal_curation_stale (schema/118) check every later fetch
-- against it: Ecdysis adopting a departure retires it, Ecdysis gaining an
-- addition flags it.
--
-- A satellite keyed by the node, like person_admin: the rows are replayed
-- from ingest/taxon-curation.csv onto every rebuild (src/taxon-curation.ts),
-- so the per-store entity_id never leaves the store. Nothing references this
-- table, so it stays writable (duckdb/duckdb#20246).
CREATE TABLE animal_curation (
  animal_id             INTEGER PRIMARY KEY REFERENCES animal(entity_id),
  kind                  TEXT NOT NULL CHECK (kind IN ('addition', 'departure', 'homonym')),
  ecdysis_tid           BIGINT,
  ecdysis_accepted_name TEXT,
  ecdysis_fetched_on    DATE NOT NULL,
  taxonomist            TEXT NOT NULL CHECK (taxonomist <> ''),
  decided_on            DATE NOT NULL,
  reference             TEXT,
  reason                TEXT NOT NULL CHECK (reason <> ''),
  -- An addition is a name Ecdysis has not got, so it has no id to record;
  -- the other two kinds are about an Ecdysis name and must say which.
  CHECK ((kind = 'addition') = (ecdysis_tid IS NULL)),
  CHECK ((kind = 'departure') = (ecdysis_accepted_name IS NOT NULL))
);
COMMENT ON TABLE animal_curation IS 'The program''s stated departures from Ecdysis''s thesaurus, one per node (beeline-45v.1): an addition (a name Ecdysis lacks, kept), a departure (a name Ecdysis calls a synonym, kept under the program''s treatment), or a homonym resolution (which of two accepted Ecdysis names at one spelling is meant). Every row names the taxonomist who decided and why; replayed from ingest/taxon-curation.csv on every rebuild. A node matching an accepted Ecdysis name has no row: Ecdysis is the default.';
COMMENT ON COLUMN animal_curation.kind IS 'addition: Ecdysis has no name at this rank and spelling. departure: Ecdysis has it as a synonym of ecdysis_accepted_name and the program keeps it. homonym: Ecdysis has two accepted names at this spelling and ecdysis_tid is the one meant.';
COMMENT ON COLUMN animal_curation.ecdysis_tid IS 'What Ecdysis said at the time: for a departure the id of the program''s name (a synonym in Ecdysis), for a homonym the id chosen. NULL for an addition, which has none.';
COMMENT ON COLUMN animal_curation.ecdysis_accepted_name IS 'For a departure, the name Ecdysis accepted instead when the decision was made; animal_curation_stale compares it against what Ecdysis says now.';
COMMENT ON COLUMN animal_curation.ecdysis_fetched_on IS 'The fetch of Ecdysis''s thesaurus (ecdysis_taxon.fetched_on) the decision was made against. Ecdysis has no releases, so the day it was read is the version.';
COMMENT ON COLUMN animal_curation.taxonomist IS 'Who decided, by name. Required: the loader transcribes a decision and never makes one, so a row nobody signed is refused.';
COMMENT ON COLUMN animal_curation.reference IS 'A DOI or URL for the paper behind the decision, where there is one.';
COMMENT ON COLUMN animal_curation.reason IS 'Why, in the taxonomist''s words — the part a later reader needs and cannot reconstruct.';
