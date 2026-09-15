-- Migration for schema/020_animal.sql, schema/025_itis.sql and
-- schema/118_views_animal_itis.sql (beeline-45v.4): each animal node carries
-- the TSN of the ITIS name it matches, and the store carries the ITIS insects
-- that TSN is read against.
--
-- No backfill. The ITIS tables arrive empty and animal.itis_tsn NULL, and
-- animal_itis says `not loaded` for every node until `pnpm itis:load` runs,
-- which fills both tables and matches every node in one transaction
-- (docs/runbooks/deploy-fly.md, ITIS). The column is not indexed, which is
-- what lets the load UPDATE it on rows that determinations reference
-- (duckdb/duckdb#20246, pinned in test/schema.test.ts).
CREATE TABLE itis_taxon (
  tsn        BIGINT PRIMARY KEY,
  rank       TEXT NOT NULL REFERENCES animal_rank(rank),
  name       TEXT NOT NULL,
  usage      TEXT NOT NULL CHECK (usage IN ('valid', 'invalid')),
  author     TEXT,
  parent_tsn BIGINT,
  itis_as_of DATE NOT NULL
);
COMMENT ON TABLE itis_taxon IS 'ITIS names for the insects, at the ranks animal_rank admits, from one ITIS release: what animal.itis_tsn is matched against (beeline-45v). Reference data keyed by ITIS''s TSN, filled by pnpm itis:load from an extract pnpm itis:fetch makes, and carried by db:reseed because promotion cannot recompute it.';
COMMENT ON COLUMN itis_taxon.rank IS 'An animal_rank rank. ITIS numbers its ranks exactly as animal_rank.ordinal does (genus 180, species 220), which is where Symbiota''s numbering came from; src/extract-itis.ts maps them and a test pins the two to agree.';
COMMENT ON COLUMN itis_taxon.name IS 'ITIS''s complete name, written as animal.scientific_name is: a subgenus as ''Genus (Subgenus)''. Not unique — a homonym is two names with one spelling and different authors (Hoplitis truncata, Cresson 1878 and Wu 1992), both current in ITIS.';
COMMENT ON COLUMN itis_taxon.usage IS 'ITIS''s name_usage: valid is a current name, invalid an outdated one whose current names are in itis_synonym. ITIS''s judgement, not the program''s, and ITIS lags bee taxonomy: Brachymelecta californica is absent here and Xeromelecta californica valid.';
COMMENT ON COLUMN itis_taxon.author IS 'ITIS''s authorship string, as ITIS writes it.';
COMMENT ON COLUMN itis_taxon.parent_tsn IS 'ITIS''s parent, NULL on an outdated name (ITIS files it under its current name instead). Not a foreign key: the extract keeps only admitted ranks, so a parent can be a tribe or a subfamily this table does not hold.';
COMMENT ON COLUMN itis_taxon.itis_as_of IS 'The newest change recorded in the ITIS release this row came from — the date that identifies the release, since ITIS publishes one monthly and the download carries no version of its own. Every row of a load carries the same value.';

-- The current names an outdated ITIS name points at. Usually one; 87 outdated
-- insect names point at more than one, which a single column on itis_taxon
-- could not hold. No foreign keys to itis_taxon: a load deletes and reinserts
-- both tables in one transaction, which DuckDB's foreign-key checking does
-- not let a referenced table do; the extract keeps only links whose ends it
-- also keeps.
CREATE TABLE itis_synonym (
  tsn          BIGINT NOT NULL,
  accepted_tsn BIGINT NOT NULL,
  PRIMARY KEY (tsn, accepted_tsn)
);
COMMENT ON TABLE itis_synonym IS 'ITIS synonym links: an outdated name (tsn) and a current name it now goes by (accepted_tsn), both in itis_taxon. Usually one current name per outdated one; 87 insect names have more.';

ALTER TABLE animal ADD COLUMN itis_tsn BIGINT;
COMMENT ON TABLE animal IS 'The curated taxonomy — named for its role: every specimen determination (bees and bycatch alike) points here, while floral hosts are iNat taxon references on the sample. Based on ITIS, which volunteers already determine against (beeline-45v): a node carries the TSN of the ITIS name it matches, and a node ITIS does not have is a name the program keeps beyond ITIS. Bees to species; non-bee scaffold deep enough for wasps at species rank. Versioning mechanics and the curation layer over ITIS are open (docs/schema-sketch.md, beeline-45v.1).';
COMMENT ON COLUMN animal.itis_tsn IS 'The ITIS taxonomic serial number of the name this node matches: the one ITIS insect name at the same rank and spelling, a current name preferred over an outdated one. NULL when ITIS has no such name, has two current ones (a homonym), or has not been loaded — animal_itis (schema/118) says which. Derived, not authored: restated by ingest/match-itis.sql whenever ITIS is loaded and after legacy promotion. An outdated name keeps its own TSN rather than moving to the current name, because whether the program follows an ITIS rename is beeline-45v.1''s decision.';

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
