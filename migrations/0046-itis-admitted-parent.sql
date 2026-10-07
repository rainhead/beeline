-- Migration for schema/025 (beeline-45v.1.1): itis_taxon gains
-- admitted_parent_tsn, a current name's nearest ancestor at an admitted rank,
-- which adopting an ITIS name into the tree walks. Appended last, as a new
-- column on this table must be. Empty until the store loads an extract made
-- by the new src/extract-itis.ts; pnpm itis:load fills it.
ALTER TABLE itis_taxon ADD COLUMN admitted_parent_tsn BIGINT;
COMMENT ON COLUMN itis_taxon.admitted_parent_tsn IS 'A current name''s nearest ancestor at a rank animal_rank admits, read from ITIS''s hierarchy: where parent_tsn is a tribe, a subfamily or an infraorder this table does not hold, this skips to the family or superfamily above it, so every current name but Animalia can be followed up to the root inside this table. What adopting an ITIS name into the tree walks (beeline-45v.1.1). NULL on an outdated name, and on a store loaded from an extract made before the column existed.';
