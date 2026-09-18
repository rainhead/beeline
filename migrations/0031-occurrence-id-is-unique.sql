-- The unique index on specimen.occurrence_id (schema/030), in a migration of
-- its own because DuckDB refuses to create an index in the transaction that
-- added the column (0030) — "Cannot create index with outstanding updates" —
-- and pnpm db:migrate runs each file in one transaction. Indexed and never
-- updated, so the index costs nothing on rows determinations and labels
-- reference (duckdb/duckdb#20246).
CREATE UNIQUE INDEX specimen_occurrence_id_idx ON specimen (occurrence_id);
