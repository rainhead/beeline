-- Migration for schema/010_people_atlases.sql (beeline-uiar): how each program
-- is abbreviated wherever a person reads it, so that Washington's shows as
-- WABA while its code, a key that DuckDB cannot update in place
-- (duckdb/duckdb#20246), stays WaBA. Every program gets a row: its code, or
-- WABA for Washington.
CREATE TABLE program_abbreviation (
  program_id   INTEGER PRIMARY KEY REFERENCES program(entity_id),
  abbreviation TEXT UNIQUE NOT NULL
);
COMMENT ON TABLE program_abbreviation IS 'How each program is abbreviated wherever a person reads it: pages, print-run titles, the atlas column of the exports (beeline-uiar). Usually its code; Washington''s is WABA where its code is WaBA. A satellite of program because the code, a key, cannot be updated in place (duckdb/duckdb#20246). URLs, cookies, the overlay and file names keep the code.';
COMMENT ON COLUMN program_abbreviation.abbreviation IS 'The program''s short name as people write it: WABA, OBA, MM.';
INSERT INTO program_abbreviation (program_id, abbreviation)
SELECT entity_id, CASE code WHEN 'WaBA' THEN 'WABA' ELSE code END FROM program;
