# ADR 0005: The app process owns the store; ingestion moves in-process

**Status:** accepted (2026-08-22) · resolves the phase-4 decision point of
[ADR 0001](0001-duckdb-first-with-portable-sql.md)

## Context

ADR 0001 chose DuckDB for phases 1–3 and deferred the app-store engine to
phase 4, naming the single-writer constraint as the thing that would decide
it: only one process may hold a DuckDB database read-write, and the web app
is not the only writer — the iNat sync, promotes, and elevation jobs write
too.

Meanwhile the replacement's requirements
([reference-implementation.md](../reference-implementation.md) §requirements)
already demand that ingestion be *scheduled* rather than hand-run, and that
concurrency safety come from the data model rather than from having exactly
one careful operator. The legacy system's task queue — non-durable, purged on
restart, safe only because a single worker existed — is the cautionary tale.

The app itself is low-traffic: hundreds of volunteers, a handful of staff,
bursts around QC sessions and print days.

## Decision

**DuckDB stays as the app store. The app process owns `beeline.duckdb`
read-write — exactly one instance, ever — and every other writer moves inside
it.** Single-writer stops being a constraint and becomes the concurrency
model.

- **Ingestion becomes in-process scheduled jobs.** `inat:sync`, the promotes,
  and elevation derivation run inside the app process on a schedule, which
  they needed to grow anyway. The CLI entry points remain for dev/bootstrap
  use against a database no app is holding.
- **Interactivity SLAs bound what any job may do.** The database serves
  interactive pages first; batch work fits in around that:
  - During **interactive hours**, no transaction — a request handler's or a
    job chunk's — may hold the write path longer than **1 second**; jobs
    chunk their work and yield between chunks. Interactive pages target
    **p95 under ~300 ms**.
  - A **night window (00:00–05:00 America/Los_Angeles)** is the carve-out:
    tasks scheduled there (full re-syncs, elevation derivation, snapshotting
    the database for backup) may hold the database for minutes.
  - Enforcement is measurement, not mechanism: the job framework times each
    chunk and logs SLA breaches (operational logging, beeline-8w6). Killing
    long transactions is not worth building at this scale.
- **[ADR 0003](0003-private-data-store.md) carries over unchanged**: the
  encrypted `private.duckdb` is `ATTACH`ed by the same owning process.
- **The Postgres escape hatch stays open.** The DDL remains dialect-neutral
  per ADR 0001. The new tripwire: if the SLAs prove unmeetable with chunked
  jobs — or a second app instance ever becomes necessary — the app store
  ports to PostgreSQL and DuckDB remains the pipeline/analytics engine.

### The stack around it

Decided with the same dependency philosophy (light, well-understood,
long-lived, easily replaced) and recorded here to keep ADRs few:

- **Hono** is the HTTP layer: TypeScript-first, built on web-standard
  `Request`/`Response`, so handlers are portable functions and the framework
  is replaceable. Kysely (ADR 0001) stays the query layer.
- **Server-rendered HTML with Lit light-DOM islands.** Pages are rendered on
  the server — a page cannot exist client-side without a session, which is
  how "no anonymous reads" stays structural — with Lit components (built by
  Vite) adding interactivity where a page needs it (QC triage, maps).
- **A message catalog from page one.** Every user-facing string goes through
  a lightweight keyed catalog even while `en` is the only locale, keeping
  the fr-CA question (beeline-1a7) and pronoun vocabulary (beeline-0qr)
  content questions rather than architecture questions.

## Consequences

- **Exactly one app instance.** No horizontal scaling, and a deploy is a
  restart with brief downtime — acceptable at this traffic, and stated here
  so nobody discovers it as a surprise. The deployment substrate
  (beeline-2c3.7) supervises that one process.
- **Jobs share the process's fate.** A crash takes running jobs with it, so
  jobs must be resumable-or-rerunnable — which the append-only load design
  already gives the sync pipeline. Job state and run history live in the
  database, not the queue (the legacy system's non-durable queue is the
  anti-pattern).
- **Backups happen from inside.** Nothing else may open the file, so
  snapshotting is a night-window job (`CHECKPOINT` + copy, or
  `EXPORT DATABASE`) — designed when real backups arrive (phase 7), but the
  night window is where it will live.
- **The SLA is a convention with a dashboard, not a guardrail.** Chunk
  timings and breach logs are the evidence the tripwire reads; if breaches
  become routine, that is the Postgres signal, not a reason to relax the
  budget.
