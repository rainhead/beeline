-- Which specimen rows count as individuated — as holding a place in the
-- sample's 1..N that a label has been, or is about to be, printed for. Every
-- specimen row does, except one whose every label belongs to a canceled
-- print run. Cancelling a run destroys nothing (schema/035): DuckDB cannot
-- delete a referenced row in the transaction that removed its references
-- (its foreign-key checking is eager), and a cancel that half-succeeded
-- would leave specimens no run holds, which read as printed. So a canceled
-- run keeps its labels as history, its specimens keep their rows with the
-- field number cleared and burned in the registry, and this view is what
-- takes them back out of the count — pending_print_sample (schema/150) and
-- qc_rule_count_below_printed (schema/120) both read it, and the next run's
-- freeze re-adopts the rows rather than inserting beside them. An imported
-- specimen has no labels at all and is individuated by the first test.
CREATE VIEW individuated_specimen AS
SELECT sp.entity_id AS specimen_id, sp.sample_id, sp.specimen_number
FROM specimen sp
WHERE NOT EXISTS (SELECT 1 FROM printed_label pl WHERE pl.specimen_id = sp.entity_id)
   OR EXISTS (SELECT 1 FROM printed_label pl
              JOIN print_run r ON r.entity_id = pl.print_run_id
              WHERE pl.specimen_id = sp.entity_id AND r.canceled_at IS NULL);
COMMENT ON VIEW individuated_specimen IS 'Specimen rows that occupy a place in their sample''s count: imported ones, and ones a live (uncanceled) print run holds a label for. A specimen left behind by a canceled run is not here until a later run re-adopts it.';
