-- Provisional rule (to confirm with staff): latest expert determination wins;
-- else latest volunteer determination. "Latest" is by recorded_at — a late
-- import of an old determination still supersedes, matching append-only intent.
CREATE VIEW determination_of_record AS
SELECT entity_id, specimen_id, animal_id, sex, caste, determiner_id, determiner_name,
       is_expert, channel, determined_on, recorded_at, notes
FROM (
  SELECT d.*,
         row_number() OVER (
           PARTITION BY specimen_id
           ORDER BY is_expert DESC, recorded_at DESC, entity_id DESC
         ) AS rn
  FROM determination d
) ranked
WHERE rn = 1;
