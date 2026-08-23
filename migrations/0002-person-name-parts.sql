-- Migration for the person name parts added to
-- schema/010_people_atlases.sql (beeline-77j): a label prints "P. Abrahamsen",
-- which display_name cannot yield. Existing rows get NULL parts and keep
-- rendering as display_name until legacy promotion re-runs and fills them.

ALTER TABLE person ADD COLUMN given_name TEXT;
ALTER TABLE person ADD COLUMN family_name TEXT;
ALTER TABLE person ADD COLUMN label_name TEXT;
