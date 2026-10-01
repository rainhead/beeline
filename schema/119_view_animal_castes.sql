-- Whether a node records sex by caste (schema/045): the nearest
-- ancestor-or-self stated in animal_caste decides, so Bombus says yes for
-- every species beneath it and a cuckoo species says no for itself.
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
