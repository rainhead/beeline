-- Three views over a sample's method (beeline-ni5m.15), each a list to look at.
-- Only the second is asserted empty, by the nightly (src/check-sample-methods.ts).

CREATE VIEW sample_without_method AS
SELECT s.entity_id AS sample_id, s.sample_number, s.protocol
FROM sample s
WHERE NOT EXISTS (SELECT 1 FROM sample_method m WHERE m.sample_id = s.entity_id);
COMMENT ON VIEW sample_without_method IS 'Samples with no method: their method as written is empty or is not one method_text knows. A worklist, not a failure: one such sample exists on production. A sample is a row here until someone chooses its method.';

CREATE VIEW sample_method_text_mismatch AS
SELECT s.entity_id AS sample_id, s.protocol, m.method_code AS stored_method_code, t.method_code AS text_method_code,
       m.trap_count AS stored_trap_count, t.trap_count AS text_trap_count
FROM sample s
JOIN method_text t ON t.text = s.protocol
LEFT JOIN sample_method m ON m.sample_id = s.entity_id
WHERE m.method_code IS DISTINCT FROM t.method_code
   OR (t.trap_count IS NOT NULL AND m.trap_count IS NULL);
COMMENT ON VIEW sample_method_text_mismatch IS 'Samples whose method as written is in method_text but whose stored method differs from what the text gives, or has lost the trap count the text states. Always empty: it proves that every writer of sample.protocol writes sample_method in the same transaction, and the nightly fails when it is not. A trap count a person set that differs from the one the text states is a correction and is not listed, and neither is a count the text does not state.';

CREATE VIEW sample_kind_method_mismatch AS
SELECT s.entity_id AS sample_id, s.kind, m.method_code, md.is_trap
FROM sample s
JOIN sample_method m ON m.sample_id = s.entity_id
JOIN method md ON md.code = m.method_code
WHERE (s.kind = 'trap') <> md.is_trap;
COMMENT ON VIEW sample_kind_method_mismatch IS 'Samples whose kind says trap where the method is not a trap, or net where it is. Informational: kind is set from the dates and the method as written, and a later change makes it follow the method (976 on production on 2026-11-23, all in settled seasons).';
