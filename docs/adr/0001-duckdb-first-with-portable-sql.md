# ADR 0001: DuckDB first, behind dialect-neutral SQL

**Status:** accepted (2026-08-20) · **Revisited:** phase-4 decision resolved
by [ADR 0005](0005-app-process-owns-the-store.md) (2026-08-22) — the app
store stays DuckDB, owned by the app process

## Context

Beeline needs one data model to serve three loads: analytical reconciliation
against ~383k legacy records, a re-runnable ingestion pipeline, and eventually a
low-traffic authenticated web app. DuckDB fits the first two perfectly but
allows only **one process** to hold a database read-write, which may or may not
hurt at the app stage. PostgreSQL has no such constraint but adds a server to
develop, deploy, and back up from day one.

The model itself is SQL-first: QC rules, printability, and
determination-of-record are views inside the schema, not app code, so whatever
engine runs them owns the heart of the system.

## Decision

- **DuckDB is the engine for phases 1–3** (data model, legacy ingestion, iNat
  ingestion), and the default candidate for the app store.
- **The DDL stays dialect-neutral by convention** so a phase-4 move of the app
  store to PostgreSQL is a port, not a rewrite. No mechanical enforcement (no
  Postgres CI check) for now; the convention is cheap because the schema is
  hand-written SQL. Concretely:
  - Row ids come from `CREATE SEQUENCE` + `DEFAULT nextval(...)` — identical in
    both engines. (DuckDB has no auto-increment; Postgres identity columns are
    not portable to DuckDB.) A single global `entity_id_seq` feeds every entity
    table — what "entity" means and the naming norms are
    [ADR 0002](0002-entities.md).
  - Enum-ish columns are `TEXT` with `CHECK` constraints, not native enum types.
  - No partial unique indexes (Postgres-only) — the `minted_catalog_number`
    two-table design exists partly for this reason.
  - Known seam, accepted: `JSON` columns (Postgres would want `JSONB`).
- **No ORM owns the schema.** The schema is `.sql` files applied in order;
  Prisma is ruled out (no DuckDB support, migration engine wants schema
  ownership). **Kysely** is the query layer for app/pipeline code — Postgres
  dialect built in, community DuckDB dialect (`kysely-duckdb` on
  `@duckdb/node-api`) — smoke-tested in phase 1 while switching is cheap.
  (Revisit if Drizzle ships an official DuckDB dialect: beeline-wot.)

## Consequences

- Until phase 4, everything (pipeline, tests, app experiments) shares one
  process or hands off the database file; tests run on in-memory databases.
  The single-writer constraint is the tripwire: when it starts hurting, the app
  store moves to Postgres and DuckDB remains the pipeline/analytics engine.
- The decision point is **at phase 4, not during it** — no engine churn while
  the model and ingestion are being built.
- Writing DDL means resisting engine-specific conveniences (DuckDB macros,
  Postgres partial indexes) unless confined to clearly-marked derived layers.
