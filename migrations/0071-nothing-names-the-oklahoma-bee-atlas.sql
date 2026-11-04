-- Migration for schema/010_people_atlases.sql: there is no Oklahoma Bee Atlas
-- (gh-251, beeline-ln8w).
--
-- The program list was seeded with six atlases, Oklahoma among them, and the
-- program has five. Oklahoma becomes a region no atlas covers, like Nevada or
-- Kansas, so its samples file under no atlas: on production that is 31
-- samples, 29 from 2024 and 2 from 2025, none printed in a run of Beeline's
-- own. The one person whose membership was Oklahoma (Sean Washington, from the
-- old system's name register) becomes a member of Master Melittology with no
-- atlas, which is what ingest/person-overlay.csv now says, and a lead of the
-- program, if the store holds one, goes.
--
-- This migration clears every table that references the program of it, and
-- 0072 deletes the program row. They are two because DuckDB will not delete a
-- referenced row in the transaction that removed its references, and each
-- migration is one transaction. A print run scoped to Oklahoma would make
-- 0072 fail, which is right: a run is permanent, and its scope cannot be
-- quietly rewritten. None exists, since no atlas prints its own labels yet.

UPDATE atlas_region SET atlas_id = NULL WHERE state_province = 'OK';

-- Geography's "no atlas" is no row (schema/030), so the rows go rather than
-- being set to NULL, which is reserved for a person saying so.
DELETE FROM sample_atlas
WHERE atlas_id = (SELECT entity_id FROM program WHERE code = 'OK');

UPDATE person_membership
SET program_id = (SELECT entity_id FROM program WHERE code = 'MM')
WHERE program_id = (SELECT entity_id FROM program WHERE code = 'OK');

DELETE FROM program_lead
WHERE program_id = (SELECT entity_id FROM program WHERE code = 'OK');

DELETE FROM atlas_printing
WHERE atlas_id = (SELECT entity_id FROM program WHERE code = 'OK');

DELETE FROM atlas_taxon_obscured_printing
WHERE atlas_id = (SELECT entity_id FROM program WHERE code = 'OK');
