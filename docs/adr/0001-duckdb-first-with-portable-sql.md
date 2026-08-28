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
  - No partial unique indexes (Postgres-only) — the `minted_field_number`
    two-table design exists partly for this reason.
  - Known seam, accepted: `JSON` columns (Postgres would want `JSONB`).
  - **Named exceptions, taken deliberately and measured first.** Two so far,
    both DuckDB-only and both because the dialect-neutral spelling was the
    dominant cost of a page: the view that shreds iNaturalist responses
    (`schema/105`, now materialised into `observation_field`), and the
    street-suffix predicate in `qc_rule_locality_format` (`schema/120`),
    which was nineteen `LIKE` passes over every locality in the store and
    is now one `regexp_matches` — 206 ms to 16 ms, and with the two of them
    the whole `qc_finding` union went 518 ms to 25 ms (Peter, 2026-08-28;
    beeline-2c3.36, beeline-2c3.37). Each is marked in place with what a
    port has to rewrite. The rule is not "never"; it is that an exception
    is a decision with a number behind it, not a convenience reached for.
  - **Never `~`.** DuckDB's `~` is `regexp_full_match`; Postgres's is a
    partial match. It is the one construct found so far that answers
    differently in the two engines *without erroring*, so it would survive
    a port and quietly change what a rule fires on. `regexp_matches` breaks
    loudly (boolean here, `text[]` there), which is what makes it the
    honest choice where a regex is worth it at all.
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

## Evidence since

Schema evolution is where this bet is weakest, and the blow-away era hides it:
four distinct DDL limitations were hit on 2026-08-27 alone — no `ALTER TABLE …
ADD CONSTRAINT`, no `DROP COLUMN` on a referenced table, `db:migrate --check`
unable to compare either, and WAL replay after DDL able to leave the file
unopenable ([ADR 0006](0006-migrations-for-deployed-stores.md) records the
first three; beeline-vyi the fourth). Every one costs nothing while a bad
schema is fixed by rebuilding, and starts costing at cutover, when it is not.
[beeline-yfb](../../.beads/) collects the evidence for the re-decision this
ADR's escape hatch exists for.

The hatch itself was tested for the first time on 2026-08-27, against
PostgreSQL 17.11: all 23 tables, the `entity_id_seq` machinery, every CHECK,
foreign key and `COMMENT ON` applied unchanged. Four construct families did
not — `DOUBLE` where Postgres wants `DOUBLE PRECISION` (8, and a plain
violation of the rule above), `json_extract`/`json_extract_string` with
JSONPath (20), `list_contains` (1), and `try_cast` (2) — in three files, of
which the JSON ones are all in the single view that shreds iNaturalist
responses. About a day's work, and only `try_cast` needs thought rather than
substitution. So the hatch is real; it had also drifted, silently, because
nothing checks. [beeline-l6w](../../.beads/) is the check.

Syntax is the shallow layer, though, and no cheaper to fix later than now.
What this rule does **not** cover is where DuckDB's capabilities have shaped
the design, and the sharpest of those is that `schema/*.sql` declares **no
indexes at all**: every lookup is a full scan over 380k specimens and 256k
determinations, which is free in a columnar engine and is not free in
Postgres — and the QC rules, printability and determination-of-record are a
stack of views over exactly those scans. Nobody has had to think about access
paths once. That, [ADR 0005](0005-app-process-owns-the-store.md)'s embedded
single-writer model, and the 1,464 lines of ingestion SQL that materialise
tables from `read_csv`/`read_ndjson` are the real cost of a move;
[ADR 0003](0003-private-data-store.md)'s separate encrypted file is *not* —
it becomes a schema, and its rationale (a main file "meant to be copied
casually") is itself a DuckDB property. beeline-yfb has the reasoning.
