-- Migration for schema/047 (beeline-kgyd.1): each uploaded file is also kept
-- in the Drive folder of received files, and its row says where. A new column
-- that starts empty; uploads made before it have no copy in Drive.

ALTER TABLE upload ADD COLUMN drive_file_id TEXT;
COMMENT ON TABLE upload IS 'A file somebody uploaded to be compared with what Beeline says: an edited copy of the specimens download. The bytes are kept on disk as upload.xlsx in a folder named for the upload''s id under the uploads directory, and a copy in the Drive folder of received files (drive_file_id); this row never changes. The CHECKs are here because a deployed store can never gain one (ADR 0006): a file is never empty, holds a row, and its hash is 64 hex digits.';
COMMENT ON COLUMN upload.drive_file_id IS 'The Drive id of the copy kept in the "Beeline received files" folder (RECEIVED_FOLDER in src/received-files.ts), stored as the file arrived and before this row was written. NULL where the app keeps no copy in Drive (a workstation or a test, which have no key) and for uploads made before 2026-11-18.';
