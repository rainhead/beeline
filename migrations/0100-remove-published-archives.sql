-- Takes out what migration 0099-published-archives.sql added and what the one
-- load made through it wrote (beeline-muke, removed by beeline-wjwa; Peter,
-- 2026-11-16: roll back the ingest of the Oregon Bee Atlas's determinations
-- from OSAC, everything the load wrote, and remove the loader).
--
-- Production loaded version 1.9 of OSAC's "Oregon Bee Atlas" dataset on
-- 2026-11-16 at 17:13 UTC. Replayed on production's copy of 11:01 UTC that
-- day, the load wrote 64,927 statements, 64,927 readings, one version, and
-- 17,274 determinations with a row each in archive_determination; it adopted
-- no name and created no person. So the determinations to delete are exactly
-- the ones archive_determination names, and nothing else the load wrote lies
-- outside the tables dropped here.
--
-- This deletes determinations, which schema/040 calls append-only. They are
-- deleted and not answered with newer events because they were never a
-- person's statement to Beeline: a load made them the same day, and the
-- decision is that the load should not have been made. Between the load and
-- the deploy that runs this, specimen pages, the listings and the API showed
-- these names, so somebody may have seen one; after it the store keeps no
-- trace of them, and this file and beeline-wjwa are the record. The night
-- jobs (backup at 3am Pacific, exports at 4am) had not run on the loaded
-- store when this was written; a deploy after they have must run the export
-- jobs again, since their files would carry the names. The entity ids the
-- determinations held are not reused (entity_id_seq only moves forward).
--
-- The provenance table goes before the determinations it points at, since its
-- foreign key would refuse the delete; the ids are kept aside first.

CREATE TEMP TABLE removed_archive_determination AS
SELECT determination_id FROM archive_determination;

DROP VIEW archive_disagreement;
DROP VIEW archive_note;
DROP VIEW archive_statement_current;

DROP TABLE archive_determination;

DELETE FROM determination
WHERE entity_id IN (SELECT determination_id FROM removed_archive_determination);

DROP TABLE removed_archive_determination;

DROP TABLE archive_reading;
DROP TABLE archive_statement;
DROP TABLE archive_version;
DROP TABLE archive_dataset;
