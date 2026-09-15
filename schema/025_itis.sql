-- ITIS: the part of it the curated taxonomy is checked against.
--
-- ITIS is the basis for bee and bycatch taxonomy (Andony, 2026-09-11;
-- beeline-45v), so each animal node carries the TSN of the ITIS name it
-- matches (animal.itis_tsn, schema/020). These two tables are what a TSN
-- means: the insects, at the ranks animal_rank admits, from one ITIS release.
-- The release of 2026-08-26 gives 337,419 names and 92,892 synonym links —
-- about a third of ITIS, and some megabytes here against the 925 MB ITIS
-- database. All insects rather than only the names already matched, because
-- bycatch arrives from any order and the curation layer (beeline-45v.1) has
-- to look up names the store does not hold yet.
--
-- Reference data keyed by ITIS's own id, not an entity (ADR 0002), and filled
-- from outside the store: `pnpm itis:fetch` extracts it from the ITIS download
-- on a host with the bandwidth for it (src/extract-itis.ts), and `pnpm
-- itis:load` replaces these rows wholesale (src/load-itis.ts). Promotion
-- cannot recompute them, so db:reseed carries both, as it carries inat_place.
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
