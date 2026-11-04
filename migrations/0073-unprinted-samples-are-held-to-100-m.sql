-- Migration for schema/120_views_qc_rules.sql: an unprinted sample in an
-- active season is held to the 100 m coordinate limit whenever it was
-- collected (Peter, 2026-11-04). The 250 m that samples collected before
-- 2 September 2026 kept (0024) now stays only for a sample that has printed
-- or is in a settled season: the ones whose pin nobody can correct any more.
--
-- Measured on production's 11:00Z backup of 2026-11-04: 4 unprinted samples
-- in active seasons sit in the 100-250 m band and collected before the change,
-- and are newly flagged; 3 of them were in that afternoon's print run and
-- were held by hand. The 38 settled ones are not flagged.
--
-- The view's columns do not change, so it is replaced in place; the views
-- that read it (qc_rule_coordinate_uncertainty and the stack above it) bind
-- by name and need nothing.

CREATE OR REPLACE VIEW sample_coordinate_limit AS
SELECT s.entity_id AS sample_id,
       CASE WHEN s.date_end >= r.effective_from
              OR (NOT EXISTS (SELECT 1 FROM printed_sample p WHERE p.sample_id = s.entity_id)
                  AND NOT EXISTS (SELECT 1 FROM settled_sample st WHERE st.sample_id = s.entity_id))
            THEN r.uncertainty_m
            ELSE r.grandfathered_uncertainty_m END AS uncertainty_m
FROM sample s
CROSS JOIN coordinate_precision_rule r;
COMMENT ON VIEW sample_coordinate_limit IS 'Per sample: the coordinate uncertainty above which it cannot be printed. 100 m, except 250 m for a sample collected before 2 September 2026 that has printed or is in a settled season.';
