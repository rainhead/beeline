-- Migration for schema/020, 025, 117 and 119 (beeline-stoi): the tree gains the ranks subfamily, tribe and subtribe, and a node can be filed
-- under one after it exists. animal.parent_id stays as the parent at creation, because DuckDB refuses to update a row another table's key
-- refers to; animal_filing holds each node that has moved, and animal_tree reads it before the column. animal_castes (made by 0040, so restated here with CREATE OR REPLACE, which drops its comment, so the comment follows) now walks animal_tree.
-- No row of animal changes here: src/file-animals.ts does the filing, run by the job `ecdysis-taxonomy` after the deploy.

INSERT INTO animal_rank (rank, ordinal, italic) VALUES
  ('subfamily', 150, false),
  ('tribe', 160, false),
  ('subtribe', 170, false);

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

-- A node's anchor: its nearest ancestor in the tree that is not a subfamily,
-- tribe or subtribe (a genus's is its family). Moving a node among those
-- three ranks never changes its anchor, which is what lets the rule below
-- promise never to move a node across families.
CREATE VIEW animal_anchor AS
WITH RECURSIVE climb(node_id, cur_id, depth) AS (
  SELECT entity_id, filed_under_id, 1 FROM animal_tree WHERE filed_under_id IS NOT NULL
  UNION ALL
  SELECT climb.node_id, c.filed_under_id, climb.depth + 1
  FROM climb
  JOIN animal_tree c ON c.entity_id = climb.cur_id
  WHERE c.rank IN ('subfamily', 'tribe', 'subtribe') AND c.filed_under_id IS NOT NULL AND climb.depth < 32
)
SELECT climb.node_id AS entity_id, c.entity_id AS anchor_id, c.ecdysis_tid AS anchor_tid
FROM climb
JOIN animal_tree c ON c.entity_id = climb.cur_id
WHERE c.rank NOT IN ('subfamily', 'tribe', 'subtribe');
COMMENT ON VIEW animal_anchor IS 'The nearest ancestor of each node that is not a subfamily, tribe or subtribe, by the tree as it stands: a genus''s family, a species'' genus. A root has none. Filing a node among subfamilies, tribes and subtribes never changes it.';
COMMENT ON COLUMN animal_anchor.entity_id IS 'The node, animal.entity_id.';
COMMENT ON COLUMN animal_anchor.anchor_id IS 'Its anchor, animal.entity_id.';
COMMENT ON COLUMN animal_anchor.anchor_tid IS 'The anchor''s Ecdysis taxon id, or NULL where it has none.';

-- The names Ecdysis puts between a node and its anchor: walking up Ecdysis's
-- admitted_parent_tid from the node, past subfamilies, tribes and subtribes
-- only, the names met (pos 1 is the node's admitted parent) up to and
-- including the first name of any other rank. Only for a node whose anchor is
-- that last name, so where the two trees disagree about the anchor, or the
-- node is a synonym (no admitted_parent_tid), it has no rows.
CREATE VIEW animal_filing_chain AS
WITH RECURSIVE hop(node_id, tid, pos) AS (
  SELECT n.entity_id, t.admitted_parent_tid, 1
  FROM animal_tree n
  JOIN ecdysis_taxon t ON t.tid = n.ecdysis_tid
  WHERE t.admitted_parent_tid IS NOT NULL
  UNION ALL
  SELECT hop.node_id, t.admitted_parent_tid, hop.pos + 1
  FROM hop
  JOIN ecdysis_taxon t ON t.tid = hop.tid
  WHERE t.rank IN ('subfamily', 'tribe', 'subtribe') AND t.admitted_parent_tid IS NOT NULL AND hop.pos < 8
)
SELECT a.entity_id AS node_id, a.anchor_id, hop.tid, hop.pos
FROM animal_anchor a
JOIN hop ON hop.node_id = a.entity_id
WHERE a.anchor_tid IS NOT NULL
  AND EXISTS (SELECT 1 FROM hop e JOIN ecdysis_taxon et ON et.tid = e.tid AND et.rank NOT IN ('subfamily', 'tribe', 'subtribe')
              WHERE e.node_id = a.entity_id AND e.tid = a.anchor_tid);
COMMENT ON VIEW animal_filing_chain IS 'For each node the filing rule reaches, the Ecdysis names between it and its anchor, nearest first, ending with the anchor itself. What src/file-animals.ts creates missing subfamilies, tribes and subtribes from.';
COMMENT ON COLUMN animal_filing_chain.node_id IS 'The node, animal.entity_id.';
COMMENT ON COLUMN animal_filing_chain.anchor_id IS 'The node''s anchor in the tree (animal_anchor).';
COMMENT ON COLUMN animal_filing_chain.tid IS 'The Ecdysis taxon id of a name on the walk.';
COMMENT ON COLUMN animal_filing_chain.pos IS 'Its place on the walk: 1 for the node''s admitted_parent_tid.';

-- Where Ecdysis would file each node the rule reaches: under the first name
-- on its chain, which is its admitted_parent_tid. The target is accepted only
-- when it is the node's own anchor, or when its anchor in the tree is the
-- node's: so the rule follows Ecdysis between tribes of one family, and never
-- puts a node under a subfamily, tribe or subtribe that sits in another
-- family, however it got there. filed_under_id is NULL when no node can take
-- it: target_id is NULL too when the tree holds no node for the name (which
-- src/file-animals.ts creates), and set when a node holds it in another
-- family (which it reports and leaves, and animal_filing_stale lists).
CREATE VIEW animal_filing_rule AS
WITH held AS (
  SELECT ecdysis_tid AS tid, min(entity_id) AS entity_id FROM animal_tree WHERE ecdysis_tid IS NOT NULL GROUP BY ecdysis_tid
)
SELECT c.node_id AS entity_id, c.tid AS filed_under_tid, h.entity_id AS target_id,
       CASE WHEN h.entity_id = c.anchor_id OR ta.anchor_id = c.anchor_id THEN h.entity_id END AS filed_under_id,
       n.parent_id AS created_under_id
FROM animal_filing_chain c
JOIN animal n ON n.entity_id = c.node_id
LEFT JOIN held h ON h.tid = c.tid
LEFT JOIN animal_anchor ta ON ta.entity_id = h.entity_id
WHERE c.pos = 1;
COMMENT ON VIEW animal_filing_rule IS 'The node Ecdysis files each node under, for the nodes the rule reaches: a node whose anchor (animal_anchor) is the one Ecdysis reaches walking up past subfamilies, tribes and subtribes belongs under the name Ecdysis gives as its admitted parent, if that node is its anchor or sits under the same anchor. NULL filed_under_id means no node can take it. What src/file-animals.ts writes into animal_filing, and what animal_filing_stale checks it against.';
COMMENT ON COLUMN animal_filing_rule.entity_id IS 'The node, animal.entity_id.';
COMMENT ON COLUMN animal_filing_rule.filed_under_tid IS 'The Ecdysis taxon id of the name the node belongs under: the node''s admitted_parent_tid.';
COMMENT ON COLUMN animal_filing_rule.target_id IS 'The animal node carrying that Ecdysis id wherever it sits, or NULL where the tree has none.';
COMMENT ON COLUMN animal_filing_rule.filed_under_id IS 'target_id when it can take the node (it is the node''s anchor, or sits under the same anchor); otherwise NULL.';
COMMENT ON COLUMN animal_filing_rule.created_under_id IS 'The parent the node was created under (animal.parent_id), so the filing can tell a node that belongs where it was made from one that has to be moved. Read nowhere else.';

CREATE VIEW animal_filing_stale AS
SELECT r.entity_id, a.rank, a.scientific_name, r.filed_under_tid, r.filed_under_id AS should_be_under_id, r.target_id, t.filed_under_id AS is_under_id
FROM animal_filing_rule r
JOIN animal a ON a.entity_id = r.entity_id
JOIN animal_tree t ON t.entity_id = r.entity_id
WHERE r.filed_under_id IS NULL OR r.filed_under_id IS DISTINCT FROM t.filed_under_id;
COMMENT ON VIEW animal_filing_stale IS 'Nodes the rule reaches that sit somewhere other than where it would file them, or that it cannot file because no usable node holds the name (should_be_under_id is NULL; target_id says whether a node in another family holds it). Empty after src/file-animals.ts runs unless Ecdysis and the tree disagree in a way the rule will not resolve by moving. It says nothing about nodes the rule does not reach: a genus whose family Ecdysis spells differently, a synonym, a name Ecdysis lacks.';

-- Whether a node records sex by caste (schema/045): the nearest
-- ancestor-or-self stated in animal_caste decides, so Bombus says yes for
-- every species beneath it and a cuckoo species says no for itself.
CREATE OR REPLACE VIEW animal_castes AS
WITH RECURSIVE up (animal_id, ancestor_id, depth) AS (
  SELECT entity_id, entity_id, 0 FROM animal
  UNION ALL
  SELECT up.animal_id, a.filed_under_id, up.depth + 1
  FROM up
  JOIN animal_tree a ON a.entity_id = up.ancestor_id
  WHERE a.filed_under_id IS NOT NULL
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
COMMENT ON VIEW animal_castes IS 'One row per animal node: true when a caste (gyne, worker or drone) is recorded beside its sex.';


-- Comments that changed.
COMMENT ON COLUMN animal.parent_id IS 'The node''s parent when it was created, and never changed: DuckDB 2.0 refuses to UPDATE a row another table''s foreign key refers to, and every node with a determination or a child is one. Where a node now sits is animal_tree.filed_under_id, which reads animal_filing before this column. Never read this column to walk the tree: a test (test/animal-tree.test.ts) fails on any read outside the insert sites, this schema, the views and src/store-snapshot.ts.';
COMMENT ON COLUMN animal.rank IS 'A rank animal_rank admits — which is why that table carries suborder and superfamily, where coarse bycatch determinations land (Symphyta, Ichneumonoidea), though nothing sits at either yet, and subfamily, tribe and subtribe, which Ecdysis files a genus under and where a determination such as Eumeninae lands.';
COMMENT ON COLUMN ecdysis_taxon.rank IS 'An animal_rank rank. Symbiota numbers its ranks as animal_rank.ordinal does (genus 180, species 220) — animal_rank''s numbering was copied from Symbiota''s — so the load joins rankID to ordinal, and a name at a rank the store does not admit (a subclass, say) is not kept. Subfamilies, tribes and subtribes are kept (beeline-stoi).';
COMMENT ON COLUMN ecdysis_taxon.parent_tid IS 'Ecdysis''s parent. Not a foreign key: it can be a subclass or a synonym''s parent at a rank this table does not hold.';
COMMENT ON COLUMN ecdysis_taxon.admitted_parent_tid IS 'An accepted name''s nearest ancestor at a rank animal_rank admits: where parent_tid is a subclass or a subgenus this table does not hold, the load walks past it, so every accepted name but Animalia can be followed up to the root inside this table. A genus''s is its subtribe, tribe, subfamily or family, whichever Ecdysis gives; src/file-animals.ts files a node under the one its admitted_parent_tid names. A subgenus is walked past too: Ecdysis files a species under its subgenus, the tree under its genus with subgenera as leaves. A synonym on the way is left for its accepted name, so a name Ecdysis rejects is never an ancestor, and a genus Ecdysis spells like a subgenus (Lasioglossum (Eickwortia)) ends the walk: NULL there, as on a synonym. What adopting a name into the tree walks (src/adopt-ecdysis.ts).';
COMMENT ON TABLE ecdysis_adoptable IS 'Ecdysis names the tree could adopt, for the determination picker (beeline-4wx3): accepted, the only accepted name at their spelling, plain ASCII, at order, suborder, superfamily, family, subfamily, tribe, subtribe, genus or species, and reaching Animalia up admitted_parent_tid. Derived from ecdysis_taxon by ingest/ecdysis-adoptable.sql whenever it is loaded. Names the tree already holds are left in; the search leaves them out.';
