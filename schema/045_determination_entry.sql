-- Volunteers naming their own specimens (beeline-bcq).
--
-- A determination is an append-only event (schema/040), so a slip made while
-- filling down a column of rows must not become history the moment it is
-- typed. Entry therefore writes a draft, which the person can change freely,
-- and the overnight job (src/commit-determinations.ts, 1am Pacific) turns
-- each draft into a determination with channel 'in_app'. That is the whole
-- draft/commit boundary CONTEXT.md left open: nothing downstream reads a
-- draft — not the determination of record, not a listing, not an export —
-- and the nightly legacy export at 4am reads what the commit made (Peter,
-- 2026-10-01).

-- Which taxa have castes. Sex is recorded as queen, worker or male for a
-- social bee and as female or male for everything else, and the tree cannot
-- say which is which: every Bombus species hangs straight off the genus, so
-- the cuckoo bumble bees (subgenus Psithyrus, no workers) are not visible as
-- a group, and the expert records cannot settle it either — the dev store
-- holds 24 B. flavidus "workers". So it is stated, here, and the nearest
-- stated ancestor-or-self decides (animal_castes, schema/119).
--
-- Keyed by rank and name rather than by entity_id, like the tree's own
-- unique key: this is seeded before promotion mints the tree, and a rebuild
-- redraws ids.
CREATE TABLE animal_caste (
  rank            TEXT NOT NULL REFERENCES animal_rank(rank),
  scientific_name TEXT NOT NULL,
  has_castes      BOOLEAN NOT NULL,
  PRIMARY KEY (rank, scientific_name)
);
COMMENT ON TABLE animal_caste IS 'Reference data: which taxa record sex as queen/worker/male rather than female/male. The nearest stated ancestor-or-self of a node decides (animal_castes); a node with none stated has no castes.';

INSERT INTO animal_caste (rank, scientific_name, has_castes) VALUES
  ('genus',   'Bombus',            true),
  ('genus',   'Apis',              true),
  -- The North American cuckoo bumble bees: social parasites with no worker caste.
  ('species', 'Bombus ashtoni',    false),
  ('species', 'Bombus bohemicus',  false),
  ('species', 'Bombus citrinus',   false),
  ('species', 'Bombus fernaldae',  false),
  ('species', 'Bombus flavidus',   false),
  ('species', 'Bombus insularis',  false),
  ('species', 'Bombus suckleyi',   false),
  ('species', 'Bombus variabilis', false);

-- A draft is the working value of one specimen for one person entering it.
-- One row per (specimen, determiner): the person signed in, never the one
-- being acted for, because delegation grants reach and never credit and a
-- determination records who made it. Mutable by design — it is the one
-- place in the determination model where a value is edited in place.
CREATE TABLE determination_draft (
  specimen_id   INTEGER NOT NULL REFERENCES specimen(entity_id),
  determiner_id INTEGER NOT NULL REFERENCES person(entity_id),
  animal_id     INTEGER REFERENCES animal(entity_id),
  sex           TEXT CHECK (sex IN ('female', 'male')),
  caste         TEXT CHECK (caste IN ('gyne', 'worker', 'drone')),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (specimen_id, determiner_id),
  CHECK (caste IS NULL OR (caste = 'drone') = (sex = 'male'))
);
COMMENT ON TABLE determination_draft IS 'A volunteer''s entry for a specimen that is not a determination yet: freely changeable until the overnight commit turns it into an in_app determination (src/commit-determinations.ts). Nothing downstream reads it. A draft with no animal (sex only, on a specimen never named) waits until it has one.';
COMMENT ON COLUMN determination_draft.determiner_id IS 'Whoever is signed in — never the person being acted for. Becomes determination.determiner_id.';
COMMENT ON COLUMN determination_draft.updated_at IS 'The last change. Its Pacific date becomes determination.determined_on, so a determination says the day it was made rather than the night it was committed.';

-- A batch is a person's list of specimens to work through in the order they
-- added them: a box sorted by genus or morphospecies, found by its label
-- numbers. Scratch work, kept so a box can be worked over several sittings
-- and on another device (Peter, 2026-10-01).
CREATE TABLE determination_batch (
  person_id   INTEGER NOT NULL REFERENCES person(entity_id),
  specimen_id INTEGER NOT NULL REFERENCES specimen(entity_id),
  position    INTEGER NOT NULL,
  PRIMARY KEY (person_id, specimen_id)
);
COMMENT ON TABLE determination_batch IS 'Specimens a person has gathered to name together, in the order added (position). Belongs to whoever is signed in; shows only what they can currently reach.';
