-- Migration for schema/121_views_method.sql and schema/030_samples_specimens.sql
-- (beeline-ni5m.15, stage three): sample.kind now means one thing, trap where the
-- sample's method is a trap and net otherwise, and every writer keeps it so
-- (setSampleMethodRow, src/sample-method-row.ts; promotion, ingest/promote-legacy.sql).
--
-- This sets kind from the method for the samples that disagree: 976 on production
-- on 2026-11-24, all in settled seasons (554 trap nests, 94 pan traps and 31 vane
-- traps from net to trap; 297 aerial nets from trap to net). A sample with no
-- method row is left alone: production has one (133876, kind net). A store
-- rebuilt by promotion gives such a sample kind net instead.
--
-- No history lines are written for the 976. The change log's snapshot still holds
-- kind, but the pass skips it (src/sample-change.ts), so the first pass after this
-- migration neither re-baselines nor logs a change, and rolling back to the old
-- code logs none either. The 14 + 296 + 2,540 Kind lines already in the log stay
-- in it and in the API, and are not shown in the History panel.
--
-- Uploads queued before the deploy: production had 0 pending method_dates outcomes.
-- A queued one would apply through the new code, which sets kind from the method.
--
-- Rolling the release back: the old code writes kind from the end date. This
-- migration never runs again, so a repair after a rollback is a new migration that
-- repeats the UPDATE below. Rehearsed on the backup of 2026-11-24: 976 rows, 17 ms.

UPDATE sample SET kind = x.k
FROM (SELECT m.sample_id, CASE WHEN d.is_trap THEN 'trap' ELSE 'net' END AS k
      FROM sample_method m JOIN method d ON d.code = m.method_code) x
WHERE sample.entity_id = x.sample_id AND sample.kind <> x.k;

CREATE OR REPLACE VIEW sample_kind_method_mismatch AS
SELECT s.entity_id AS sample_id, s.kind, m.method_code, md.is_trap
FROM sample s
JOIN sample_method m ON m.sample_id = s.entity_id
JOIN method md ON md.code = m.method_code
WHERE (s.kind = 'trap') <> md.is_trap;
COMMENT ON VIEW sample_kind_method_mismatch IS 'Samples whose kind says trap where the method is not a trap, or net where it is. Always empty: every writer sets kind from the method in the same transaction as the method (setSampleMethodRow, promotion), and the nightly fails when this view is not empty. A sample with no method is not in it, and its kind is whatever it was.';

COMMENT ON COLUMN sample.kind IS 'Trap where the sample''s method is a trap (method.is_trap), net otherwise: a true copy of the method, kept true by every writer and checked by sample_kind_method_mismatch. It is not the date range (read date_start and date_end) and not whether the sample is managed in Beeline (read sample_entry). A sample with no method keeps whatever kind it had; a rebuilt store gives it net. Kept as a column because DuckDB cannot drop or alter it while 17 tables reference sample.';
