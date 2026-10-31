-- An atlas is a program with states or provinces assigned to it (CONTEXT.md;
-- beeline-ni5m.2, Peter, 2026-10-31). This view is that sentence in SQL: the
-- programs some atlas_region row names, which is how a sample is filed under
-- an atlas by where it fell. Every read of "the atlases" — the listings'
-- scope picker, the print-run scope picker, the sample's atlas, a person's
-- membership, the archives — goes through it, and every write references
-- program, so there is one table of programs and one definition of which of
-- them are atlases. It sits ahead of the minting, QC and print-run views
-- that join it, and after the tables it reads (schema/010).
--
-- Having a geography is NOT what makes an atlas (Peter, 2026-10-31). The
-- refuge program (beeline-8zlh) will own its refuges, which are areas
-- (schema/038) lying inside the atlases, and a sample inside one will be
-- that program's by geography while staying its atlas's by state; no
-- atlas_region row will ever name it, so it never appears here. A program's
-- places are a link from program to area when that arrives, not a region.
--
-- Until 2026-10-31 this was a table, with program beside it pointing at the
-- atlas it was. Folding the two while the production store could still be
-- built fresh is what let the columns that reference an atlas keep their
-- names and their rows.
CREATE VIEW atlas AS
SELECT p.entity_id, p.code, p.name
FROM program p
WHERE EXISTS (SELECT 1 FROM atlas_region r WHERE r.atlas_id = p.entity_id);
COMMENT ON VIEW atlas IS 'The programs with states or provinces assigned (atlas_region): the six member atlases, OBA, WaBA, BC, ID, NM, OK. Read wherever "the atlases" are meant; written nowhere, since an atlas is a program (schema/010) plus the atlas_region rows that name it. A program that owns places, as the refuge program will own its refuges, is not an atlas and is not here.';
