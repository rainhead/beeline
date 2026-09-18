-- Migration for schema/155_views_print_run.sql: sample_label_in_progress, the
-- view that keeps a sample on its collector's front page between the freeze
-- and the envelope. A view only; nothing to backfill.
CREATE VIEW sample_label_in_progress AS
SELECT sp.sample_id,
       CAST(count(*) FILTER (WHERE r.printed_at IS NULL)     AS INTEGER) AS printing_count,
       CAST(count(*) FILTER (WHERE r.printed_at IS NOT NULL) AS INTEGER) AS printed_count,
       max(r.printed_at) AS printed_at
FROM printed_label pl
JOIN print_run r ON r.entity_id = pl.print_run_id
JOIN specimen sp ON sp.entity_id = pl.specimen_id
WHERE r.canceled_at IS NULL AND r.mailed_at IS NULL
GROUP BY sp.sample_id;
COMMENT ON VIEW sample_label_in_progress IS 'Per sample with labels in a live, unmailed print run: how many are still being printed and how many are printed but not yet mailed. What keeps a sample on its collector''s front page between the freeze and the envelope.';

