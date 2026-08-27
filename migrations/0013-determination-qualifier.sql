-- Migration for schema/040_determinations.sql and
-- schema/110_view_determination_of_record.sql (beeline-tgu): a determination
-- can say how sure it was, and what the source actually wrote.
--
-- The renderer and the glossary already had qualifiers: TaxonName places cf.,
-- aff., sp. and spp. by rank, and the volunteer glossary defines them as
-- things a volunteer will meet. The store had nowhere to put any of them, so
-- a determiner meaning "cf. Bombus occidentalis" had to assert the species
-- flat — overclaiming, on a label that is permanent once printed — or drop to
-- genus and throw away the resemblance they observed.
--
-- sp./spp. are deliberately not here: a genus-rank determination already
-- means "genus known, species not", so storing it would be storing the rank
-- twice.
ALTER TABLE determination ADD COLUMN qualifier TEXT;
ALTER TABLE determination ADD COLUMN verbatim_identification TEXT;

COMMENT ON COLUMN determination.qualifier IS 'Open nomenclature: how sure the determiner was. cf. — resembles this species, needs confirming; aff. — close to it but probably something else; nr. — near it. All three modify a species-rank assertion and none of them is expressible as a coarser one: dropping to genus throws away the resemblance the determiner actually observed. sp./spp. are deliberately absent, being what a genus-rank determination already means (beeline-tgu).';
COMMENT ON COLUMN determination.verbatim_identification IS 'The name as the source wrote it, kept beside the node it resolved to. Legacy staging is re-pullable today and frozen at cutover, after which this is the only record of what was actually said; Ecdysis import (phase 7) brings names from a system that records both.';

-- No backfill. Both columns are populated by legacy promotion, which a
-- deployed store picks up on its next re-promotion rather than from here —
-- the verbatim string lives in that store's own staging, not in this file.
-- DuckDB cannot add a CHECK to an existing table, so the vocabulary
-- constraint arrives with the next rebuild; nothing writes this column in a
-- deployed store until then.

DROP VIEW determination_of_record;
CREATE VIEW determination_of_record AS
SELECT entity_id, specimen_id, animal_id, qualifier, verbatim_identification,
       sex, caste, determiner_id, determiner_name,
       is_expert, channel, determined_on, recorded_at, notes
FROM (
  SELECT d.*,
         row_number() OVER (
           PARTITION BY specimen_id
           ORDER BY is_expert DESC, recorded_at DESC, entity_id DESC
         ) AS rn
  FROM determination d
) ranked
WHERE rn = 1;
