-- Three views over a sample's method (beeline-ni5m.15), each a list to look at.
-- Only the second is asserted empty, by the nightly (src/check-sample-methods.ts).

CREATE VIEW sample_without_method AS
SELECT s.entity_id AS sample_id, s.sample_number, s.protocol
FROM sample s
WHERE NOT EXISTS (SELECT 1 FROM sample_method m WHERE m.sample_id = s.entity_id);
COMMENT ON VIEW sample_without_method IS 'Samples with no method: their method as written is empty or is not one method_text knows. A worklist, not a failure: a sample stays on it until someone chooses its method.';

CREATE VIEW sample_method_text_mismatch AS
SELECT s.entity_id AS sample_id, s.protocol, m.method_code AS stored_method_code, t.method_code AS text_method_code,
       m.trap_count AS stored_trap_count, coalesce(trap_count_stated(s.sampling_effort), t.trap_count) AS expected_trap_count
FROM sample s
LEFT JOIN method_text t ON t.text = s.protocol
LEFT JOIN sample_method m ON m.sample_id = s.entity_id
WHERE m.method_code IS DISTINCT FROM t.method_code
   OR (m.sample_id IS NOT NULL AND m.trap_count IS DISTINCT FROM coalesce(trap_count_stated(s.sampling_effort), t.trap_count));
COMMENT ON VIEW sample_method_text_mismatch IS 'Samples whose stored method or trap count is not what the sample says. A sample''s method is the method method_text gives its method as written, and no row where that text is not listed (so a row on an unlisted text, and no row on a listed one, are both listed here). Its trap count is the count sample.sampling_effort states in the form the forms write (trap_count_stated), or else the count the method as written states. Always empty: every writer of sample.protocol, sample.sampling_effort or a sample''s method keeps all three together in one transaction, and the nightly fails when this view is not empty.';

CREATE VIEW sample_kind_method_mismatch AS
SELECT s.entity_id AS sample_id, s.kind, m.method_code, md.is_trap
FROM sample s
JOIN sample_method m ON m.sample_id = s.entity_id
JOIN method md ON md.code = m.method_code
WHERE (s.kind = 'trap') <> md.is_trap;
COMMENT ON VIEW sample_kind_method_mismatch IS 'Samples whose kind says trap where the method is not a trap, or net where it is. Informational and not asserted: kind is set from the dates and the method as written, so the two disagree where the end date and the words do (976 on production on 2026-11-23, all in settled seasons).';
