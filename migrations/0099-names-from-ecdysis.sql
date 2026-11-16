-- Migration for schema/025 and schema/045: names a volunteer may give a specimen
-- straight from Ecdysis when the tree does not hold them yet (beeline-4wx3).
--
-- ecdysis_adoptable is made and filled from the ecdysis_taxon the store already
-- holds, with a copy of ingest/ecdysis-adoptable.sql as it stands now; every
-- later load of the thesaurus rebuilds it from that file. On a copy of the
-- thesaurus of 2026-11-15 (1,022,951 names) the fill took 3.6 s with DuckDB
-- held to 768 MB and two threads; production's app has 1,536 MB.
--
-- determination_draft gains ecdysis_tid. The schema's CHECK that a draft names
-- at most one of animal_id and ecdysis_tid cannot be added to a deployed table
-- (ADR 0006), so here saveDrafts (src/app/determine.ts) is what keeps it.

CREATE TABLE ecdysis_adoptable (
  tid          BIGINT PRIMARY KEY,
  rank         TEXT NOT NULL,
  name         TEXT NOT NULL,
  family       TEXT,
  superfamily  TEXT,
  insect_order TEXT,
  name_key     TEXT NOT NULL
);
COMMENT ON TABLE ecdysis_adoptable IS 'Ecdysis names the tree could adopt, for the determination picker (beeline-4wx3): accepted, the only accepted name at their spelling, plain ASCII, at order, suborder, superfamily, family, genus or species, and reaching Animalia up admitted_parent_tid. Derived from ecdysis_taxon by ingest/ecdysis-adoptable.sql whenever it is loaded. Names the tree already holds are left in; the search leaves them out.';
COMMENT ON COLUMN ecdysis_adoptable.tid IS 'Ecdysis''s taxon id, as in ecdysis_taxon.tid.';
COMMENT ON COLUMN ecdysis_adoptable.family IS 'The family above the name, or the name itself for a family; NULL above family rank. What the picker shows beside the name, and how it leaves out bees (src/bee-families.ts).';
COMMENT ON COLUMN ecdysis_adoptable.superfamily IS 'The superfamily above the name, or the name itself for a superfamily. Read only to keep out a bee that Ecdysis files under Apoidea with no family between.';
COMMENT ON COLUMN ecdysis_adoptable.insect_order IS 'The order above the name, or the name itself for an order. Shown beside it so that a katydid cannot be taken for a wasp of the same spelling.';
COMMENT ON COLUMN ecdysis_adoptable.name_key IS 'The name in lower case: what a search compares the first word typed against.';

DELETE FROM ecdysis_adoptable;
INSERT INTO ecdysis_adoptable (tid, rank, name, family, superfamily, insect_order, name_key)
WITH RECURSIVE homonym AS (
  SELECT name FROM ecdysis_taxon WHERE status = 'accepted' GROUP BY name HAVING count(*) > 1
),
-- The accepted names, narrowed to what the walk needs: ids, the rank, and
-- whether another accepted name shares this one's rank and spelling.
node AS MATERIALIZED (
  SELECT t.tid, t.admitted_parent_tid, t.rank,
         (SELECT count(*) FROM ecdysis_taxon u WHERE u.status = 'accepted' AND u.rank = t.rank AND u.name = t.name) > 1 AS shared
  FROM ecdysis_taxon t WHERE t.status = 'accepted'
),
-- Ids only on the way down; the names are joined on once at the end.
down(tid, family_tid, superfamily_tid, order_tid, under_shared, depth) AS (
  SELECT tid, NULL::BIGINT, NULL::BIGINT, NULL::BIGINT, false, 0 FROM node WHERE rank = 'kingdom'
  UNION ALL
  SELECT c.tid,
         CASE WHEN c.rank = 'family' THEN c.tid ELSE d.family_tid END,
         CASE WHEN c.rank = 'superfamily' THEN c.tid ELSE d.superfamily_tid END,
         CASE WHEN c.rank = 'order' THEN c.tid ELSE d.order_tid END,
         d.under_shared OR p.shared,
         d.depth + 1
  FROM down d
  JOIN node p ON p.tid = d.tid
  JOIN node c ON c.admitted_parent_tid = d.tid
  WHERE d.depth < 30
)
SELECT t.tid, t.rank, t.name, f.name AS family, sf.name AS superfamily, o.name AS insect_order, lower(t.name) AS name_key
FROM down d
JOIN ecdysis_taxon t ON t.tid = d.tid
LEFT JOIN ecdysis_taxon f ON f.tid = d.family_tid
LEFT JOIN ecdysis_taxon sf ON sf.tid = d.superfamily_tid
LEFT JOIN ecdysis_taxon o ON o.tid = d.order_tid
WHERE t.rank IN ('order', 'suborder', 'superfamily', 'family', 'genus', 'species')
  AND NOT d.under_shared
  AND t.name NOT IN (SELECT name FROM homonym)
  AND t.name = regexp_replace(t.name, '[^ -~]', '', 'g')
  AND NOT (t.rank = 'genus' AND t.name LIKE '%(%')
ORDER BY name_key;

ALTER TABLE determination_draft ADD COLUMN ecdysis_tid BIGINT;
COMMENT ON COLUMN determination_draft.ecdysis_tid IS 'A name chosen from Ecdysis that the tree does not hold yet (ecdysis_adoptable, beeline-4wx3), in place of animal_id. The overnight commit adopts it into the tree and records the determination against the new node; until then nothing is added to the tree, so a name picked by mistake and changed leaves no trace. At most one of animal_id and ecdysis_tid is set: a CHECK on a store built from the schema, and saveDrafts on one migrated to it, since a deployed table cannot gain a CHECK.';
