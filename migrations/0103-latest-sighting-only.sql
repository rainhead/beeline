-- Migration for schema/060_sync.sql: the comment on observation_seen, which
-- now holds only the latest sighting of each observation by each source
-- (beeline-amdt). No rows are written here. The sightings a later run has
-- repeated are deleted by the nightly's own step (pruneSightings,
-- src/sync-inat.ts), the first of which removes about 43,000 of production's
-- 109,595.

COMMENT ON TABLE observation_seen IS 'The observations each run returned, changed or not, kept until a later run of the same source returns them again: the latest sighting of each observation by each source. Loads are hash-deduped, so a missing load row cannot distinguish unchanged from gone — deletion detection (qc_rule_observation_missing_upstream) reads presence from here instead.';
