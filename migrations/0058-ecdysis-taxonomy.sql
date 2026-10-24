-- Migration for schema/020, schema/022, schema/025 and schema/118
-- (beeline-7gob): the curated taxonomy is matched against Ecdysis's taxonomic
-- thesaurus instead of ITIS.
--
-- The ITIS tables and the views over them go. animal_curation is dropped and
-- recreated with Ecdysis's columns: nothing references it, and it holds only
-- what ingest/taxon-curation.csv replays, which held no decisions when this
-- was written; `pnpm taxon:apply` or the next legacy promotion refills it.
-- ecdysis_taxon arrives empty, animal.ecdysis_tid NULL, and animal_ecdysis
-- says `not loaded` for every node until `pnpm ecdysis:taxonomy` runs
-- (docs/runbooks/deploy-fly.md, The taxonomy's reference).
--
-- animal.itis_tsn stays behind. DuckDB cannot drop a column on a table
-- others reference (migrations/README.md), and determinations reference
-- animal, so a deployed store keeps the column, unread, until its next
-- reseed; `db:migrate --check` names it as drift until then. The rest of the
-- delta is the schema verbatim.

DROP VIEW animal_curation_stale;
DROP VIEW animal_itis_stale;
DROP VIEW animal_itis;
DROP VIEW animal_itis_match;
DROP TABLE itis_synonym;
DROP TABLE itis_taxon;
DROP TABLE animal_curation;

CREATE TABLE ecdysis_taxon (
  tid                 BIGINT PRIMARY KEY,
  rank                TEXT NOT NULL REFERENCES animal_rank(rank),
  name                TEXT NOT NULL,
  author              TEXT,
  status              TEXT NOT NULL CHECK (status IN ('accepted', 'synonym')),
  accepted_tid        BIGINT NOT NULL,
  parent_tid          BIGINT,
  admitted_parent_tid BIGINT,
  fetched_on          DATE NOT NULL,
  CHECK ((status = 'accepted') = (accepted_tid = tid))
);
COMMENT ON TABLE ecdysis_taxon IS 'Names in Ecdysis''s taxonomic thesaurus for the insects, at the ranks animal_rank admits: what animal.ecdysis_tid is matched against (beeline-7gob, replacing ITIS). Reference data keyed by Ecdysis''s taxon id, replaced wholesale by pnpm ecdysis:taxonomy, and carried by db:reseed because promotion cannot recompute it.';
COMMENT ON COLUMN ecdysis_taxon.tid IS 'Ecdysis''s taxon id (Symbiota''s taxa.tid): the number in https://ecdysis.org/taxa/index.php?taxon=<tid>.';
COMMENT ON COLUMN ecdysis_taxon.rank IS 'An animal_rank rank. Symbiota numbers its ranks as animal_rank.ordinal does (genus 180, species 220) — animal_rank''s numbering was copied from Symbiota''s — so the load joins rankID to ordinal, and a name at a rank the store does not admit (a tribe, a subfamily) is not kept.';
COMMENT ON COLUMN ecdysis_taxon.name IS 'Ecdysis''s scientific name, written as animal.scientific_name is: a subgenus as ''Genus (Subgenus)'', a species never with its subgenus. Not unique — a homonym is two names with one spelling and different authors. Kept as Ecdysis stores it, including the double-encoded characters of some Diptera names (no bee name has any).';
COMMENT ON COLUMN ecdysis_taxon.author IS 'Ecdysis''s authorship string, as Ecdysis writes it.';
COMMENT ON COLUMN ecdysis_taxon.status IS 'accepted: a current name in Ecdysis. synonym: a name Ecdysis files under another, accepted_tid. Ecdysis''s judgement, not the program''s; where the program keeps a name Ecdysis calls a synonym, animal_curation (schema/022) says so.';
COMMENT ON COLUMN ecdysis_taxon.accepted_tid IS 'The accepted name: the row itself for an accepted name, the name it is filed under for a synonym. Symbiota gives a synonym exactly one accepted name within a thesaurus. Not a foreign key: the accepted name of a synonym can sit at a rank this table does not keep.';
COMMENT ON COLUMN ecdysis_taxon.parent_tid IS 'Ecdysis''s parent. Not a foreign key: it can be a tribe or a subfamily this table does not hold.';
COMMENT ON COLUMN ecdysis_taxon.admitted_parent_tid IS 'An accepted name''s nearest ancestor at a rank animal_rank admits: where parent_tid is a tribe, a subfamily or a subclass this table does not hold, the load walks past it to the family or superfamily above, so every accepted name but Animalia can be followed up to the root inside this table. A subgenus is walked past too: Ecdysis files a species under its subgenus, the tree under its genus with subgenera as leaves. A synonym on the way is left for its accepted name, so a name Ecdysis rejects is never an ancestor, and a genus Ecdysis spells like a subgenus (Lasioglossum (Eickwortia)) ends the walk: NULL there, as on a synonym. What adopting a name into the tree walks (src/adopt-ecdysis.ts).';
COMMENT ON COLUMN ecdysis_taxon.fetched_on IS 'The day the names were exported from Ecdysis. Ecdysis has no releases — it is edited name by name — so this is what identifies the version a decision was checked against. Every row of a load carries the same value.';

ALTER TABLE animal ADD COLUMN ecdysis_tid BIGINT;
COMMENT ON COLUMN determination.verbatim_identification IS 'The name as the determiner wrote it, kept beside the node it resolved to — and required — never blank — on every channel but legacy_import, because not every name will resolve to a name in Ecdysis''s thesaurus, which the tree is matched against, and this is then the only record of what was said (beeline-45v). Legacy import may omit it, never blank it: most of its determinations arrive as parted columns with no whole name to keep, and promotion invents none — with one exception, where a curated decision (a spelling alias, an adopted Ecdysis name) moves a determination to a node other than the one its own columns spell. The spelling the source used is recorded here then, because nothing else would say what was written (beeline-bph). Ecdysis import (phase 7) brings names from a system that records both.';
COMMENT ON TABLE animal IS 'The curated taxonomy — named for its role: every specimen determination (bees and bycatch alike) points here, while floral hosts are iNat taxon references on the sample. Based on the taxonomic thesaurus of Ecdysis, where the program''s taxonomists determine (beeline-7gob; ITIS until 2026-10-23): a node carries the id of the Ecdysis name it matches, and a node Ecdysis does not have is a name the program keeps beyond it. Bees to species; non-bee scaffold deep enough for wasps at species rank. Where the program departs from Ecdysis on purpose, animal_curation (schema/022) says so and on whose word.';
COMMENT ON COLUMN animal.ecdysis_tid IS 'The Ecdysis taxon id of the name this node matches: the one Ecdysis insect name at the same rank and spelling, an accepted name preferred over a synonym. NULL when Ecdysis has no such name, has two accepted ones (a homonym), or has not been loaded — animal_ecdysis (schema/118) says which. Derived, not authored: restated by ingest/match-ecdysis.sql whenever the thesaurus is loaded and after legacy promotion. A synonym keeps its own id rather than moving to the accepted name, because whether the program follows a rename is a curation decision (beeline-45v.1). Not indexed, which is what lets a load UPDATE it on rows determinations reference (duckdb/duckdb#20246).';

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
