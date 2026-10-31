-- An atlas is a program with a region (CONTEXT.md; beeline-ni5m.2, Peter,
-- 2026-10-31). This view is that sentence in SQL: the programs some
-- atlas_region row names. Every read of "the atlases" — the listings' scope
-- picker, the print-run scope picker, the sample's atlas, a person's
-- membership, the archives — goes through it, and every write references
-- program, so there is one table of programs and one definition of which of
-- them are atlases. It sits ahead of the minting, QC and print-run views
-- that join it, and after the tables it reads (schema/010).
--
-- Until 2026-10-31 this was a table, with program beside it pointing at the
-- atlas it was. Folding the two while the production store could still be
-- built fresh is what let the columns that reference an atlas keep their
-- names and their rows.
CREATE VIEW atlas AS
SELECT p.entity_id, p.code, p.name
FROM program p
WHERE EXISTS (SELECT 1 FROM atlas_region r WHERE r.atlas_id = p.entity_id);
COMMENT ON VIEW atlas IS 'The programs that have a region: the six member atlases, OBA, WaBA, BC, ID, NM, OK. Read wherever "the atlases" are meant; written nowhere, since an atlas is a program (schema/010) plus the atlas_region rows that name it.';
