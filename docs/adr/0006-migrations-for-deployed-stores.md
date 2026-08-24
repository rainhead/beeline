# ADR 0006: Migrations carry deployed stores forward; the schema stays the schema

**Status:** accepted (2026-08-23) · narrows the "no migration system" stance in
[roadmap.md](../roadmap.md) · operational context in
[ADR 0005](0005-app-process-owns-the-store.md)

## Context

The pre-cutover stance is that the database is blown away and rebuilt from
`schema/*.sql` (ADR 0001: the schema files *are* the schema). That works for
every database that can be rebuilt — dev, tests, the pipeline — and it is why
there has been no migration system.

It does not cover a database nobody wants to rebuild. The sandbox on maderas
holds a full legacy ingest that takes real time to reproduce, and volunteers
are signing in to it. Adding one view to it meant stopping the service, hand
writing a throwaway script, remembering the `CHECKPOINT` rule that keeps
DuckDB ≤ 1.5.5 from corrupting its own WAL (beeline-vyi), and remembering it
again next time. At cutover that same store becomes production, holding
minted field numbers that cannot be regenerated.

## Decision

**`schema/*.sql` remains the source of truth. `migrations/NNNN-slug.sql` are
deltas that bring an already-deployed database up to it.**

- A change is written into `schema/` first, then copied into a migration when
  a deployed store has to catch up. Reading the schema never means replaying
  a history of migrations.
- `schema_migration` records what a database has seen. It is an ordinary
  table in `schema/000_schema_migration.sql`, so a fresh build has it, and
  the tool creates it in stores that predate it.
- **A fresh build is current by construction**, so `db:build` *stamps* every
  migration as applied without running any. Migrations therefore only ever
  run against deployed stores — the only databases that need them.
- Each migration runs in its own transaction; a failure rolls back, is not
  recorded, and stops the run. Every run that changed anything ends with an
  explicit `CHECKPOINT`, so the rule that protects the file is in code rather
  than in an operator's memory.
- `db:migrate --check` diffs a store's tables, views, and columns against a
  database built fresh from the schema — the answer to "did I forget to write
  a migration?", which the duplication above makes possible to get wrong. It
  judges only what the schema declares: a real store also holds the ingestion
  pipeline's staging tables (`ingest/*.sql`), which are nobody's drift.
- Deployment ([the runbook](../runbooks/deploy-maderas.md),
  `scripts/deploy-maderas.sh`) stops the service to migrate: one process owns
  the store (ADR 0005), so there is no other moment when the file is free.

## Consequences

- **A change lands twice** — once in `schema/`, once in `migrations/` — for as
  long as any deployed store lags. That duplication is deliberate: it keeps
  the schema readable as a single current statement. `--check` is what keeps
  the two honest.
- **Blow-away stays the dev stance.** Nobody migrates a local database; they
  rebuild it. Migrations that only ever ran on the sandbox are still worth
  keeping, because the sandbox becomes production at cutover.
- **Ordering is filename order**, and applied names are recorded literally, so
  renaming an applied migration makes it pending again. Don't.
- **Post-cutover this is the only path.** The blow-away era ends in December
  2026; from then on every schema change needs its migration, and the
  `--check` drift report becomes a deploy-time gate rather than a warning.
- **The private store still patches itself at boot** (`attachPrivateStore`,
  ADR 0003) — it is attached, not this catalog, and outlives rebuilds for its
  own reasons. Folding it onto this mechanism is a later cleanup.
