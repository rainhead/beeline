-- Ecdysis's taxonomic thesaurus: the part of it the curated taxonomy is
-- checked against.
--
-- The tree was matched against ITIS until 2026-10-23 (beeline-45v), when the
-- program moved to the thesaurus of Ecdysis, the Symbiota portal its
-- taxonomists determine in (beeline-7gob): ITIS carries no bee subgenus
-- outside Colletidae, lags on recent bee papers, and lacks most of the potter
-- wasps that arrive as bycatch, and Ecdysis holds all of them because it is
-- where those names are used. Each animal node carries the Ecdysis id of the
-- name it matches (animal.ecdysis_tid, schema/020), and this table is what
-- an id means: the insects, at the ranks animal_rank admits.
--
-- All insects rather than only the names already matched, because bycatch
-- arrives from any order and adoption (src/adopt-ecdysis.ts) and the curation
-- layer (beeline-45v.1) look up names the store does not hold yet.
--
-- Reference data keyed by Ecdysis's own id, not an entity (ADR 0002), and
-- filled from outside the store: `pnpm ecdysis:taxonomy` exports the insects
-- from Ecdysis (src/fetch-ecdysis-taxonomy.ts) and replaces these rows
-- wholesale (src/load-ecdysis-taxonomy.ts). Promotion cannot recompute them,
-- so db:reseed carries the table, as it carries inat_place.
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
