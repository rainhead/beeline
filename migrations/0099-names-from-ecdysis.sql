-- Migration for schema/025 and schema/045: names a volunteer may give a specimen
-- straight from Ecdysis when the tree does not hold them yet (beeline-4wx3).
--
-- ecdysis_adoptable is made and filled from the ecdysis_taxon the store already
-- holds, with a copy of ingest/ecdysis-adoptable.sql as it stands now; every
-- later load of the thesaurus rebuilds it from that file.
--
-- determination_draft gains ecdysis_tid. The schema's CHECK that a draft names
-- at most one of animal_id and ecdysis_tid cannot be added to a deployed table
-- (ADR 0006), so here saveDrafts (src/app/determine.ts) is what keeps it.

CREATE TABLE ecdysis_adoptable (
  tid          BIGINT PRIMARY KEY,
  rank         TEXT NOT NULL,
  name         TEXT NOT NULL,
  family       TEXT,
  insect_order TEXT,
  name_key     TEXT NOT NULL
);
COMMENT ON TABLE ecdysis_adoptable IS 'Ecdysis names the tree could adopt, for the determination picker (beeline-4wx3): accepted, the only accepted name at their spelling, plain ASCII, at order, suborder, superfamily, family, genus or species, and reaching Animalia up admitted_parent_tid. Derived from ecdysis_taxon by ingest/ecdysis-adoptable.sql whenever it is loaded. Names the tree already holds are left in; the search leaves them out.';
COMMENT ON COLUMN ecdysis_adoptable.tid IS 'Ecdysis''s taxon id, as in ecdysis_taxon.tid.';
COMMENT ON COLUMN ecdysis_adoptable.family IS 'The family above the name, or the name itself for a family; NULL above family rank. What the picker shows beside the name, and how it leaves out bees (src/bee-families.ts).';
COMMENT ON COLUMN ecdysis_adoptable.insect_order IS 'The order above the name, or the name itself for an order. Shown beside it so that a katydid cannot be taken for a wasp of the same spelling.';
COMMENT ON COLUMN ecdysis_adoptable.name_key IS 'The name in lower case: what a search compares the first word typed against.';

DELETE FROM ecdysis_adoptable;
INSERT INTO ecdysis_adoptable (tid, rank, name, family, insect_order, name_key)
WITH RECURSIVE homonym AS (
  SELECT name FROM ecdysis_taxon WHERE status = 'accepted' GROUP BY name HAVING count(*) > 1
),
candidate AS (
  SELECT t.tid, t.rank, t.name
  FROM ecdysis_taxon t
  WHERE t.status = 'accepted'
    AND t.rank IN ('order', 'suborder', 'superfamily', 'family', 'genus', 'species')
    AND t.name = regexp_replace(t.name, '[^ -~]', '', 'g')
    AND NOT (t.rank = 'genus' AND t.name LIKE '%(%')
    AND t.name NOT IN (SELECT name FROM homonym)
),
up(start, cur, depth) AS (
  SELECT tid, tid, 0 FROM candidate
  UNION ALL
  SELECT up.start, t.admitted_parent_tid, up.depth + 1
  FROM up JOIN ecdysis_taxon t ON t.tid = up.cur
  WHERE t.admitted_parent_tid IS NOT NULL AND up.depth < 30
)
SELECT c.tid, c.rank, c.name,
       max(a.name) FILTER (WHERE a.rank = 'family') AS family,
       max(a.name) FILTER (WHERE a.rank = 'order') AS insect_order,
       lower(c.name) AS name_key
FROM candidate c
JOIN up ON up.start = c.tid
JOIN ecdysis_taxon a ON a.tid = up.cur
GROUP BY c.tid, c.rank, c.name
HAVING bool_or(a.rank = 'kingdom')
ORDER BY name_key;

ALTER TABLE determination_draft ADD COLUMN ecdysis_tid BIGINT;
COMMENT ON COLUMN determination_draft.ecdysis_tid IS 'A name chosen from Ecdysis that the tree does not hold yet (ecdysis_adoptable, beeline-4wx3), in place of animal_id. The overnight commit adopts it into the tree and records the determination against the new node; until then nothing is added to the tree, so a name picked by mistake and changed leaves no trace. At most one of animal_id and ecdysis_tid is set: a CHECK on a store built from the schema, and saveDrafts on one migrated to it, since a deployed table cannot gain a CHECK.';
