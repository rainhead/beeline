-- Migration for schema/050_qc.sql (beeline-pnag): the second half of removing
-- the rule taxon_obscured_awaiting_atlas. 0113 took the view, the rows that
-- referenced the rule and the table of atlas answers away; DuckDB will not
-- delete the rule's own row in that same transaction, so it goes here.

DELETE FROM qc_rule WHERE name = 'taxon_obscured_awaiting_atlas';
