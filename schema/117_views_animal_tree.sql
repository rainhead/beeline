-- The tree as it stands now, and the rule that decides where Ecdysis files a
-- node (beeline-stoi).
--
-- animal.parent_id is a node's parent at creation and is never updated
-- (schema/020), so the parent in effect is animal_filing's row for the node
-- if it has one and animal.parent_id otherwise. animal_tree is `animal` with
-- that parent under a name that cannot be mistaken for the column: every
-- walk of the tree reads this view, and a test fails on a read of
-- animal.parent_id anywhere else.
CREATE VIEW animal_tree AS
SELECT a.entity_id,
       coalesce(f.parent_id, a.parent_id) AS filed_under_id,
       a.rank,
       a.scientific_name,
       a.authorship,
       a.ecdysis_tid
FROM animal a
LEFT JOIN animal_filing f ON f.animal_id = a.entity_id;
COMMENT ON VIEW animal_tree IS 'Every animal node with the parent it is filed under now: animal_filing''s where the node has been moved, animal.parent_id where it has not. The only way to read a node''s parent. Walk it with filed_under_id; the creation parent is a column nobody should read.';
COMMENT ON COLUMN animal_tree.filed_under_id IS 'The node this one sits under now, animal.entity_id; NULL for a root.';

-- Where Ecdysis would file each node, for the nodes the rule reaches. A
-- node's anchor is its nearest ancestor in the tree that is not a subfamily,
-- tribe or subtribe (a genus's is its family). Walking up Ecdysis's own
-- parents from the node, past subfamilies, tribes and subtribes only, the
-- first name of any other rank is Ecdysis's anchor. When that is the node's
-- anchor, the node is filed under the first name on the walk, which is the
-- node's admitted_parent_tid. So the rule follows Ecdysis between tribes of
-- one family and never moves a node across families, and where the two trees
-- disagree about the anchor it does nothing. filed_under_id is NULL while
-- the tree holds no node for that name, which animal_filing_stale reports
-- and src/file-animals.ts creates.
CREATE VIEW animal_filing_rule AS
WITH RECURSIVE climb(node_id, cur_id, depth) AS (
  SELECT entity_id, filed_under_id, 1 FROM animal_tree WHERE filed_under_id IS NOT NULL
  UNION ALL
  SELECT climb.node_id, c.filed_under_id, climb.depth + 1
  FROM climb
  JOIN animal_tree c ON c.entity_id = climb.cur_id
  WHERE c.rank IN ('subfamily', 'tribe', 'subtribe') AND c.filed_under_id IS NOT NULL AND climb.depth < 32
),
anchor AS (
  SELECT climb.node_id, c.ecdysis_tid AS anchor_tid
  FROM climb
  JOIN animal_tree c ON c.entity_id = climb.cur_id
  WHERE c.rank NOT IN ('subfamily', 'tribe', 'subtribe') AND c.ecdysis_tid IS NOT NULL
),
hop(node_id, tid, pos) AS (
  SELECT n.entity_id, t.admitted_parent_tid, 1
  FROM animal_tree n
  JOIN ecdysis_taxon t ON t.tid = n.ecdysis_tid
  WHERE t.admitted_parent_tid IS NOT NULL
  UNION ALL
  SELECT hop.node_id, t.admitted_parent_tid, hop.pos + 1
  FROM hop
  JOIN ecdysis_taxon t ON t.tid = hop.tid
  WHERE t.rank IN ('subfamily', 'tribe', 'subtribe') AND t.admitted_parent_tid IS NOT NULL AND hop.pos < 8
),
held AS (
  SELECT ecdysis_tid AS tid, min(entity_id) AS entity_id FROM animal_tree WHERE ecdysis_tid IS NOT NULL GROUP BY ecdysis_tid
)
SELECT a.node_id AS entity_id, first.tid AS filed_under_tid, h.entity_id AS filed_under_id, n.parent_id AS created_under_id
FROM anchor a
JOIN animal n ON n.entity_id = a.node_id
JOIN hop ends ON ends.node_id = a.node_id AND ends.tid = a.anchor_tid
JOIN ecdysis_taxon et ON et.tid = ends.tid AND et.rank NOT IN ('subfamily', 'tribe', 'subtribe')
JOIN hop first ON first.node_id = a.node_id AND first.pos = 1
LEFT JOIN held h ON h.tid = first.tid;
COMMENT ON VIEW animal_filing_rule IS 'The node Ecdysis files each node under, for the nodes the rule reaches: the nearest ancestor that is not a subfamily, tribe or subtribe must be the one Ecdysis reaches walking up past those three ranks, and then the node belongs under the name Ecdysis gives as its admitted parent. NULL filed_under_id means the tree holds no node for that name yet. What src/file-animals.ts writes into animal_filing, and what animal_filing_stale checks it against.';
COMMENT ON COLUMN animal_filing_rule.entity_id IS 'The node, animal.entity_id.';
COMMENT ON COLUMN animal_filing_rule.filed_under_tid IS 'The Ecdysis taxon id of the name the node belongs under: the node''s admitted_parent_tid.';
COMMENT ON COLUMN animal_filing_rule.filed_under_id IS 'The animal node carrying that Ecdysis id, or NULL where the tree has none.';
COMMENT ON COLUMN animal_filing_rule.created_under_id IS 'The parent the node was created under (animal.parent_id), so the filing can tell a node that belongs where it was made from one that has to be moved. Read nowhere else.';

CREATE VIEW animal_filing_stale AS
SELECT r.entity_id, a.rank, a.scientific_name, r.filed_under_tid, r.filed_under_id AS should_be_under_id, t.filed_under_id AS is_under_id
FROM animal_filing_rule r
JOIN animal a ON a.entity_id = r.entity_id
JOIN animal_tree t ON t.entity_id = r.entity_id
WHERE r.filed_under_id IS NULL OR r.filed_under_id IS DISTINCT FROM t.filed_under_id;
COMMENT ON VIEW animal_filing_stale IS 'Nodes the filing rule (animal_filing_rule) would file somewhere else than where they sit: the thesaurus or the tree changed without src/file-animals.ts running. Asserted empty by test after every writer of the tree, and reported empty or not by the weekly Ecdysis refresh, the same shape as animal_ecdysis_stale.';
