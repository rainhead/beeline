-- animal.ecdysis_tid, restated from animal_ecdysis_match (schema/118), which
-- is the one definition of what a node matches and what animal_ecdysis_stale
-- checks the column against. Run by pnpm ecdysis:taxonomy after it replaces
-- the thesaurus, and by legacy promotion after seed-animals.sql mints the
-- nodes, so a rebuilt tree is matched against whatever thesaurus the store
-- carries (beeline-7gob). A node that matches nothing, or two accepted names,
-- is set back to NULL: an id from an earlier fetch is not evidence about this
-- one.
UPDATE animal SET ecdysis_tid = m.tid
FROM (
  SELECT a.entity_id, x.tid
  FROM animal a
  LEFT JOIN animal_ecdysis_match x ON x.entity_id = a.entity_id
) m
WHERE animal.entity_id = m.entity_id
  AND animal.ecdysis_tid IS DISTINCT FROM m.tid;
