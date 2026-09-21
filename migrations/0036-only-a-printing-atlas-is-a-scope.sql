-- Migration for schema/010_people_atlases.sql: a print run scoped to one
-- atlas is only possible for an atlas in atlas_printing (Peter, 2026-09-21).
-- The rule is enforced by src/print-run.ts; this restates the table's comment
-- to say so. No data changes.
COMMENT ON TABLE atlas_printing IS 'Atlases that print their own labels; presence is the flag. Empty today: Oregon prints for every atlas. An unscoped print run freezes the samples of every atlas NOT here (print_scope_sample), and an atlas here gets labels only from a run scoped to it. Only an atlas here can be a run''s scope: the rest are the program''s to print, and src/print-run.ts refuses a run scoped to one.';
