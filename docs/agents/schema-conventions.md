# Schema and SQL conventions

Read this before changing anything in `schema/`, `migrations/`, `src/model.ts`, or SQL that has to run on both DuckDB and a possible Postgres. Moved out of AGENTS.md, which points here.

## Dialect-neutral DDL

Keep DDL dialect-neutral per ADR 0001: `TEXT` + `CHECK` for enum-ish columns, `concat()`/`concat_ws()` over `||`, no partial unique indexes. Three exceptions are named and taken deliberately — the iNaturalist JSON shredding (`schema/105`), the street-suffix predicate in `observation_locality` (`schema/108`; until 2026-10-31 `qc_rule_locality_format` applied it too, before a volunteer's street address stopped being a fault), and that predicate's pattern as a `MACRO` rather than a one-row view (`schema/108`, because DuckDB recompiles a regex per row unless the pattern is a literal) — each marked in place with what a port must rewrite, and each with a measurement behind it rather than a preference. **Never `~`**: until DuckDB 2.0 it was `regexp_full_match` while Postgres's is a partial match, the one construct found so far that answered differently in the two engines without erroring, and 2.0 made DuckDB's a partial match too (duckdb#23432), so the same query also changed its answer across an upgrade. Write `regexp_matches` (part of the string) or `regexp_full_match` (all of it), so the meaning is in the name. A port was measured on 2026-10-12 and decided against (beeline-yfb); it found three more — `\b` in a regex, `->> '$.key'`, `round(x, n)`'s printing — listed with the reasons for staying in [docs/research/postgres-feasibility.md](../research/postgres-feasibility.md).

## Identity

Identity per [ADR 0002](../adr/0002-entities.md): entity tables have an `entity_id` PK drawn from the global `entity_id_seq`; facet tables (1:1 satellites) are keyed by their parent's id; only global-identity columns are named `entity_id`.

## Documentation in the database

Document tables and columns with `COMMENT ON` (queryable in-database); reserve `--` comments for design rationale spanning statements.

## Types and versions

`src/model.ts` (Kysely types) follows the SQL by hand — update it with any schema change.

Kysely is pinned to 0.28.x until `kysely-duckdb` supports 0.29.

## Changing a view

A view changed in `schema/` needs a migration that restates it with its `COMMENT ON VIEW`; `test/view-migrations.test.ts` fails otherwise. See [migrations/README.md](../../migrations/README.md).

## Timestamps

A `TIMESTAMP` means UTC in every process, not only on Fly: the openers in `src/db.ts` pin DuckDB's session zone to UTC, and `patches/kysely-duckdb.patch` reads the value back as UTC rather than as the machine's local time (beeline-j0aj). Write an instant as `current_timestamp` or `toISOString()`, never as a local-time string. Before this, a workstation stored the SQL clock in Pacific time and JavaScript's instants in UTC, seven hours apart in one column.
