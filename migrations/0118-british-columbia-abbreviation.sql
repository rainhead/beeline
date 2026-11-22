-- Migration for schema/010_people_atlases.sql (beeline-mm3b): the British
-- Columbia Bee Atlas writes itself BCBA (Peter, 2026-11-22; its Ecdysis
-- collection is NBSBC:BCBA and its catalog numbers begin BCBA_). Its code stays
-- BC, a key. Nothing refers to program_abbreviation, so the row can be updated
-- in place, and no other program's abbreviation changes.
UPDATE program_abbreviation SET abbreviation = 'BCBA'
WHERE program_id = (SELECT entity_id FROM program WHERE code = 'BC');
COMMENT ON TABLE program_abbreviation IS 'How each program is abbreviated wherever a person reads it: pages, print-run titles, the atlas column of the exports (beeline-uiar). Usually its code; Washington''s is WABA where its code is WaBA, and British Columbia''s is BCBA where its code is BC. A satellite of program because the code, a key, cannot be updated in place (duckdb/duckdb#20246). URLs, cookies, the overlay and file names keep the code.';
COMMENT ON COLUMN program_abbreviation.abbreviation IS 'The program''s short name as people write it: WABA, BCBA, OBA, MM.';
