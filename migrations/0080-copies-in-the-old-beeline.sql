-- Migration for schema/035_print_runs.sql: what Beeline last copied into the
-- old Beeline's master list for each specimen it printed (beeline-83b8.18).
-- The table starts empty; the nightly legacy-copy job fills it.

CREATE TABLE legacy_copy (
  specimen_id     INTEGER PRIMARY KEY REFERENCES specimen(entity_id),
  field_number    TEXT NOT NULL CHECK (field_number <> ''),
  content_sha256  TEXT NOT NULL CHECK (length(content_sha256) = 64),
  first_copied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_copied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (last_copied_at >= first_copied_at)
);
COMMENT ON TABLE legacy_copy IS 'A specimen printed by Beeline as last copied into the old Beeline''s master list, so volunteers can enter determinations for it there until February 2027 (beeline-83b8.18, src/legacy-copy.ts). One row per specimen, written only once the old system has been read back and holds what was sent. The old record''s id is not a column because it is derived: beeline-specimen- followed by specimen_id, which is how beeline-c43w tells a record that started here from one the old system made.';
COMMENT ON COLUMN legacy_copy.field_number IS 'The field number the copy carried. Kept because a duplicate repair can give a printed specimen a second number, and the old record is then found by the number it still holds.';
COMMENT ON COLUMN legacy_copy.content_sha256 IS 'The SHA-256 of the row as sent, in the legacy column order; a night whose row hashes the same sends nothing.';
COMMENT ON COLUMN legacy_copy.first_copied_at IS 'When the old system first held this specimen.';
COMMENT ON COLUMN legacy_copy.last_copied_at IS 'When the copy was last brought up to date.';
