-- Three views over a sample's method (beeline-ni5m.15), each a list to look at.
-- Only the second is asserted empty, by the nightly (src/check-sample-methods.ts).

CREATE VIEW sample_without_method AS
SELECT s.entity_id AS sample_id, s.sample_number, s.protocol
FROM sample s
WHERE NOT EXISTS (SELECT 1 FROM sample_method m WHERE m.sample_id = s.entity_id);
COMMENT ON VIEW sample_without_method IS 'Samples with no method: their method as written is empty or is not one method_text knows. A worklist, not a failure: a sample stays on it until someone chooses its method.';

CREATE VIEW sample_method_out_of_step AS
WITH shown AS (
  SELECT s.entity_id AS sample_id, s.protocol, s.sampling_effort,
         m.method_code AS stored_method_code, m.trap_count AS stored_trap_count, d.is_trap,
         t.method_code AS text_method_code,
         -- What the one writer of the old effort column writes (setSampleMethodRow, src/sample-method-row.ts): the count and the method,
         -- plural where there is more than one; none where there is no count.
         CASE WHEN m.trap_count IS NULL THEN NULL
              ELSE concat(m.trap_count, ' ', m.method_code, CASE WHEN m.trap_count = 1 OR lower(m.method_code) LIKE '%s' THEN '' ELSE 's' END)
         END AS expected_effort
  FROM sample s
  LEFT JOIN method_text t ON t.text = s.protocol
  LEFT JOIN sample_method m ON m.sample_id = s.entity_id
  LEFT JOIN method d ON d.code = m.method_code
)
SELECT sample_id, protocol, sampling_effort, stored_method_code, text_method_code, stored_trap_count, expected_effort,
       CASE WHEN stored_method_code IS DISTINCT FROM text_method_code THEN 'method'
            WHEN stored_trap_count IS NOT NULL AND NOT is_trap THEN 'count'
            ELSE 'effort' END AS clause
FROM shown
WHERE stored_method_code IS DISTINCT FROM text_method_code
   OR (stored_trap_count IS NOT NULL AND NOT is_trap)
   OR sampling_effort IS DISTINCT FROM expected_effort;
COMMENT ON VIEW sample_method_out_of_step IS 'Samples whose method, trap count or old effort column is not what the sample says. Each row names the clause it fails: method (the stored method is not the one method_text gives the method as written, and no row where the text is not listed, so a row on an unlisted text and no row on a listed one both fail), count (a trap count on a method that is not a trap), effort (sample.sampling_effort is not the text the one writer would write for the stored count and method). The trap count is sample_method.trap_count and is never read from text. Always empty: every writer keeps all of it in one transaction, and the nightly fails when this view is not empty.';

CREATE VIEW sample_kind_method_mismatch AS
SELECT s.entity_id AS sample_id, s.kind, m.method_code, md.is_trap
FROM sample s
JOIN sample_method m ON m.sample_id = s.entity_id
JOIN method md ON md.code = m.method_code
WHERE (s.kind = 'trap') <> md.is_trap;
COMMENT ON VIEW sample_kind_method_mismatch IS 'Samples whose kind says trap where the method is not a trap, or net where it is. Informational and not asserted: kind is set from the dates and the method as written, so the two disagree where the end date and the words do (976 on production on 2026-11-23, all in settled seasons).';
