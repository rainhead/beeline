-- The record of applied migrations. Fresh builds get this table with every
-- migration already stamped (a database built from schema/*.sql is current by
-- construction); only a deployed store that must catch up ever runs one.
-- See ADR 0006 and migrations/README.md.
CREATE TABLE schema_migration (
  name       TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE schema_migration IS 'One row per migrations/*.sql that has been applied (or stamped) against this database. The schema itself is schema/*.sql; migrations only carry deployed stores forward.';
COMMENT ON COLUMN schema_migration.name IS 'The migration file name, e.g. 0001-pending-print-sample.sql — filename order is apply order.';
COMMENT ON COLUMN schema_migration.applied_at IS 'When it ran here; a stamped (baselined) migration records the time it was stamped.';
