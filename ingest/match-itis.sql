-- animal.itis_tsn, restated from animal_itis_match (schema/118), which is
-- the one definition of what a node matches and what animal_itis_stale checks
-- the column against. Run by pnpm itis:load after it replaces the ITIS rows,
-- and by legacy promotion after seed-animals.sql mints the nodes, so a
-- rebuilt tree is matched against whatever ITIS the store carries
-- (beeline-45v). A node that matches nothing, or two current names, is set
-- back to NULL: a TSN from an earlier release is not evidence about this one.
UPDATE animal SET itis_tsn = m.tsn
FROM (
  SELECT a.entity_id, x.tsn
  FROM animal a
  LEFT JOIN animal_itis_match x ON x.entity_id = a.entity_id
) m
WHERE animal.entity_id = m.entity_id
  AND animal.itis_tsn IS DISTINCT FROM m.tsn;
