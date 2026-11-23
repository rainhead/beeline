-- Migration for schema/010_people_atlases.sql: two comments on atlas_region
-- still said "the six" atlases after the schema's wording changed, and no
-- migration carried the change. Found 2026-11-22 against the backup of that
-- night (beeline-0apa). Nothing but the comments changes. The number skips
-- 0119 and 0120, which open branches use; the runner orders by filename.
COMMENT ON TABLE atlas_region IS 'State/province → the member atlas covering it, for the US and Canada. Geography assigns samples to atlases (schema/030); this is the lookup it does, and the programs it names are the atlases. Deliberately complete rather than data-shaped: a region absent from this table means "unrecognised", so listing only the atlases'' regions would make every other real place look like a typo.';
COMMENT ON COLUMN atlas_region.inat_place_id IS 'This region''s iNaturalist place, so a sample minted from an observation can be given a state at all: iNat stamps observations with place ids and place_guess is free text ("Leach Botanical Garden"), so the two-letter code has to be reached through here (beeline-2yt). The one place id in the store for a region, the atlases'' included.';
