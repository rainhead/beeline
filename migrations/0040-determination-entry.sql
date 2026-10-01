-- Migration for schema/045_determination_entry.sql, schema/119_view_animal_castes.sql
-- and the sample_season view in schema/160
-- (beeline-bcq): drafts, batches, and which taxa have castes, for volunteers
-- naming their own specimens. New tables and a new view only, so the delta is
-- the schema verbatim.

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

CREATE VIEW animal_castes AS
WITH RECURSIVE up (animal_id, ancestor_id, depth) AS (
  SELECT entity_id, entity_id, 0 FROM animal
  UNION ALL
  SELECT up.animal_id, a.parent_id, up.depth + 1
  FROM up
  JOIN animal a ON a.entity_id = up.ancestor_id
  WHERE a.parent_id IS NOT NULL
),
stated AS (
  SELECT up.animal_id, c.has_castes,
         row_number() OVER (PARTITION BY up.animal_id ORDER BY up.depth) AS nearest
  FROM up
  JOIN animal a ON a.entity_id = up.ancestor_id
  JOIN animal_caste c ON c.rank = a.rank AND c.scientific_name = a.scientific_name
)
SELECT a.entity_id AS animal_id, coalesce(s.has_castes, false) AS has_castes
FROM animal a
LEFT JOIN stated s ON s.animal_id = a.entity_id AND s.nearest = 1;
COMMENT ON VIEW animal_castes IS 'One row per animal node: true when its sex is recorded as queen, worker or male.';

CREATE VIEW sample_season AS
SELECT entity_id AS sample_id,
       CAST(EXTRACT(YEAR FROM date_end) AS INTEGER)
         - CASE WHEN EXTRACT(MONTH FROM date_end) < 3 THEN 1 ELSE 0 END AS season
FROM sample;
COMMENT ON VIEW sample_season IS 'The season each sample belongs to, named by the year it began (1 March). A sample emptied in February belongs to the previous year''s season.';
