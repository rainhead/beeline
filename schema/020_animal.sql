-- The ranks this store admits, and how they order. Rank is the switch for a
-- lot: whether a name italicises, which node a determination is the deepest
-- assertion of, whether a qualifier is even meaningful. Ordinal comparison —
-- "species or finer" — is the operation the domain actually needs, and a bare
-- TEXT column cannot answer it, so every caller was growing its own copy of
-- the ladder (beeline-a2p).
--
-- Gapped by 10, after Symbiota's rank ids: the gaps are so a rank can be
-- inserted between two others without renumbering, which is the part of that
-- design worth copying. What is not worth copying is their ~150 bare integer
-- literals — `rankid > 220` spelled out in 49 files — so the numbers live
-- here and callers join.
--
-- Holds the nine ranks promotion mints plus suborder and superfamily, which
-- coarse bycatch determinations land at (Symphyta, Ichneumonoidea) and which
-- the animal.rank comment has always said must be admissible, and the three
-- ranks between family and genus (subfamily, tribe, subtribe) that Ecdysis
-- files a genus under and a determination may name (beeline-stoi). Nothing
-- else: a rank with no node and no stated need is a row nobody can justify.
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
  ('subfamily',   150, false),
  ('tribe',       160, false),
  ('subtribe',    170, false),
  ('genus',       180, true),
  ('subgenus',    190, true),
  ('species',     220, true),
  ('subspecies',  230, true);

CREATE TABLE animal (
  entity_id       INTEGER PRIMARY KEY DEFAULT nextval('entity_id_seq'),
  parent_id       INTEGER REFERENCES animal(entity_id),
  rank            TEXT NOT NULL REFERENCES animal_rank(rank),
  scientific_name TEXT NOT NULL,
  authorship      TEXT,
  ecdysis_tid     BIGINT,
  UNIQUE (rank, scientific_name)
);
COMMENT ON TABLE animal IS 'The curated taxonomy — named for its role: every specimen determination (bees and bycatch alike) points here, while floral hosts are iNat taxon references on the sample. Based on the taxonomic thesaurus of Ecdysis, where the program''s taxonomists determine (beeline-7gob; ITIS until 2026-10-23): a node carries the id of the Ecdysis name it matches, and a node Ecdysis does not have is a name the program keeps beyond it. Bees to species; non-bee scaffold deep enough for wasps at species rank. Where the program departs from Ecdysis on purpose, animal_curation (schema/022) says so and on whose word.';
COMMENT ON COLUMN animal.parent_id IS 'The node''s parent when it was created, and never changed: DuckDB 2.0 refuses to UPDATE a row another table''s foreign key refers to, and every node with a determination or a child is one. Where a node now sits is animal_tree.filed_under_id, which reads animal_filing before this column. Never read this column to walk the tree: a test (test/animal-tree.test.ts) fails on any read outside the insert sites, this schema, the views and src/store-snapshot.ts.';
COMMENT ON COLUMN animal.ecdysis_tid IS 'The Ecdysis taxon id of the name this node matches: the one Ecdysis insect name at the same rank and spelling, an accepted name preferred over a synonym. NULL when Ecdysis has no such name, has two accepted ones (a homonym), or has not been loaded — animal_ecdysis (schema/118) says which. Derived, not authored: restated by ingest/match-ecdysis.sql whenever the thesaurus is loaded and after legacy promotion. A synonym keeps its own id rather than moving to the accepted name, because whether the program follows a rename is a curation decision (beeline-45v.1). Not indexed, which is what lets a load UPDATE it on rows determinations reference (duckdb/duckdb#20246).';
COMMENT ON COLUMN animal.rank IS 'A rank animal_rank admits — which is why that table carries suborder and superfamily, where coarse bycatch determinations land (Symphyta, Ichneumonoidea), though nothing sits at either yet, and subfamily, tribe and subtribe, which Ecdysis files a genus under and where a determination such as Eumeninae lands.';
COMMENT ON COLUMN animal.scientific_name IS 'Scientific name, disambiguated from vernacular names, which this table does not carry.';
-- (rank, scientific_name) is unique because it is the key seeding and both
-- determination targets already join on (ingest/seed-animals.sql,
-- promote-determinations.sql) — the constraint says out loud what those joins
-- assume. Verified against production staging before adding: 0 collisions
-- across 3,567 nodes (beeline-4zi).

-- Where a node sits now, when that is not where it was created. A node's
-- parent cannot be updated once something refers to it (see the comment on
-- animal.parent_id), and the tree has to follow Ecdysis's subfamilies, tribes
-- and subtribes after the nodes exist (beeline-stoi). So a move is a row here,
-- and animal_tree (schema/117) reads it before animal.parent_id. Written only
-- by src/file-animals.ts, with MERGE ... IS DISTINCT FROM so a second run
-- writes nothing. Nothing refers to this table, which is what keeps it
-- writable, and it has no foreign key of its own for the same reason.
CREATE TABLE animal_filing (
  animal_id          INTEGER PRIMARY KEY,
  parent_id          INTEGER NOT NULL,
  ecdysis_fetched_on DATE,
  filed_at           TIMESTAMP NOT NULL DEFAULT current_timestamp
);
COMMENT ON TABLE animal_filing IS 'One row for each node whose parent in effect differs from animal.parent_id: the node is filed under another one, as Ecdysis files it (a genus under its tribe rather than its family). Derived from the thesaurus by src/file-animals.ts and restated whenever the tree or the thesaurus changes; a node that sits where it was created has no row, and a row is deleted when the rule stops reaching its node. Read through animal_tree, never directly.';
COMMENT ON COLUMN animal_filing.animal_id IS 'The node that was filed, animal.entity_id. Not a foreign key, on purpose: see the note above this table.';
COMMENT ON COLUMN animal_filing.parent_id IS 'The node it is filed under, animal.entity_id. Not a foreign key.';
COMMENT ON COLUMN animal_filing.ecdysis_fetched_on IS 'The day of the Ecdysis export the filing was decided against (ecdysis_taxon.fetched_on).';
COMMENT ON COLUMN animal_filing.filed_at IS 'When this row was written or last changed, UTC.';
