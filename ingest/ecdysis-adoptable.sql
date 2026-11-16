-- ecdysis_adoptable (schema/025), rebuilt from ecdysis_taxon: the names the
-- determination picker may offer from Ecdysis and the overnight commit then
-- adopts (beeline-4wx3). Run by pnpm ecdysis:taxonomy after it replaces the
-- thesaurus, inside the same transaction, and by db:reseed after it carries
-- the thesaurus across. migrations/0099 holds a copy as it stood then.
--
-- The rule is adoption's (src/adopt-ecdysis.ts): accepted, the only accepted
-- name at its spelling, plain ASCII, and not a genus Ecdysis spells like a
-- subgenus. Two narrowings: only the ranks a person names a pinned insect at
-- (no subgenus, which the tree keeps as a leaf, and no subspecies, which
-- adoption refuses), and only names whose walk up admitted_parent_tid reaches
-- Animalia, which every tree holds, so that the walk adoption makes is sure
-- to find a node to hang the name from.
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
