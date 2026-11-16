-- ecdysis_adoptable (schema/025), rebuilt from ecdysis_taxon: the names the
-- determination picker may offer from Ecdysis and the overnight commit then
-- adopts (beeline-4wx3). Run by pnpm ecdysis:taxonomy after it replaces the
-- thesaurus, inside the same transaction, and by db:reseed after it carries
-- the thesaurus across. migrations/0099 holds a copy as it stood then.
--
-- The rule is adoption's (src/adopt-ecdysis.ts): accepted, the only accepted
-- name at its spelling, plain ASCII, and not a genus Ecdysis spells like a
-- subgenus. Three narrowings:
--  - only the ranks a person names a pinned insect at: no subgenus, which the
--    tree keeps as a leaf, and no subspecies, which adoption refuses;
--  - only names reached walking down admitted_parent_tid from Animalia, which
--    every tree holds, so adoption is sure to find a node to hang them from;
--  - nothing below a name that two accepted names share at the same rank.
--    Adoption finds a parent in the tree by rank and spelling, so a species
--    of the sawfly genus Euura could be hung from the other Euura (40 species
--    on production, 2026-11-15; 86 under the three such genera, Euura, Rileya
--    and Tmetolophota). The same spelling at another rank cannot be confused
--    that way, and must not count: Ecdysis spells the beetle suborder
--    Polyphaga as it does a genus, and counting it dropped 200,000 beetles.
--
-- The walk goes down from the root, carrying the order, superfamily and
-- family it passes, so it visits each name once. The first version walked up
-- from each name to the root, about seven rows per name: on production's
-- thesaurus that ran out of memory where the query process is limited to
-- 768 MB.
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
