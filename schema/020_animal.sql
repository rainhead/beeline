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
-- the animal.rank comment has always said must be admissible. Nothing else:
-- a rank with no node and no stated need is a row nobody can justify.
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

CREATE TABLE animal (
  entity_id       INTEGER PRIMARY KEY DEFAULT nextval('entity_id_seq'),
  parent_id       INTEGER REFERENCES animal(entity_id),
  rank            TEXT NOT NULL REFERENCES animal_rank(rank),
  scientific_name TEXT NOT NULL,
  authorship      TEXT,
  UNIQUE (rank, scientific_name)
);
COMMENT ON TABLE animal IS 'The curated taxonomy — named for its role: every specimen determination (bees and bycatch alike) points here, while floral hosts are iNat taxon references on the sample. Bees to species; non-bee scaffold deep enough for wasps at species rank. Versioning mechanics are an open design point (docs/schema-sketch.md).';
COMMENT ON COLUMN animal.rank IS 'A rank animal_rank admits — which is why that table carries suborder and superfamily, where coarse bycatch determinations land (Symphyta, Ichneumonoidea), though nothing sits at either yet.';
COMMENT ON COLUMN animal.scientific_name IS 'Scientific name, disambiguated from vernacular names, which this table does not carry.';
-- (rank, scientific_name) is unique because it is the key seeding and both
-- determination targets already join on (ingest/seed-animals.sql,
-- promote-determinations.sql) — the constraint says out loud what those joins
-- assume. Verified against production staging before adding: 0 collisions
-- across 3,567 nodes (beeline-4zi).
