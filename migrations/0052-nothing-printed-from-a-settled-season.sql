-- Nothing from a settled season is printed (Peter, 2026-10-14). The reasoning
-- is in schema/102, which now sits ahead of the printing views so that
-- pending_print_sample (schema/150) can read settled_sample. A deployed store
-- already holds the season views, so only the pending view and the comment
-- change here.
CREATE OR REPLACE VIEW pending_print_sample AS
SELECT s.entity_id AS sample_id,
       -- CAST because count() is 64-bit: the app reads this as a plain number.
       CAST(s.specimen_count - coalesce(printed.n, 0) AS INTEGER) AS pending_count
FROM printable_sample p
JOIN sample s ON s.entity_id = p.sample_id
LEFT JOIN (
  SELECT sample_id, count(*) AS n FROM individuated_specimen GROUP BY sample_id
) printed ON printed.sample_id = s.entity_id
WHERE s.specimen_count > coalesce(printed.n, 0)
  AND NOT EXISTS (SELECT 1 FROM settled_sample st WHERE st.sample_id = s.entity_id);

COMMENT ON VIEW settled_sample IS 'Samples from a closed season. Settled means "no longer asking", never "no longer changeable": these samples keep their flags and stay editable. Nothing of theirs is printed any more: pending_print_sample leaves them out (Peter, 2026-10-14).';
