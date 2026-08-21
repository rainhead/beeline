# ADR 0003: Private data lives in a separately-secured store

**Status:** accepted (2026-08-20) · **Review:** phase-4 app-store decision ([roadmap](../roadmap.md))

## Context

Beeline holds three kinds of data that must never travel with the rest of the
database: iNaturalist OAuth tokens (which do not expire — a leaked token is a
credential forever), collectors' mailing addresses (the one truly private
datum per [CONTEXT.md](../../CONTEXT.md)), and any email addresses we come to
hold. Meanwhile the main database file is *meant* to be copied casually —
backups, analytics, handing a snapshot to a student. Per-column encryption
would protect these fields but taxes every read path with crypto code and
leaves the policy invisible in the schema.

The schema style already isolates each private concern in its own satellite
table (ADR 0002 facets; "its own table, no accidental joins"). That seam makes
isolation a matter of *where the table lives*, not how its columns are coded.

## Decision

**Private satellite tables live in a separate database file, encrypted as a
whole, attached at runtime.** The main file contains no secrets and is safe to
copy by construction.

- Concretely today: a second DuckDB file (`private.duckdb`) using DuckDB's
  native database encryption (AES-256, ≥ 1.4), `ATTACH`ed with a key the app
  holds outside both files (environment/secrets manager — never beside the
  file it opens).
- The portable statement, per [ADR 0001](0001-duckdb-first-with-portable-sql.md),
  is *"private tables live in a separately-secured store"* — under a phase-4
  move to PostgreSQL this maps to a separate database or schema with its own
  access controls, not to `ATTACH`.
- Tables that belong there: OAuth tokens, `mailing_address`, email if ever
  held. The default for a new column is the main file; placing a table in the
  private store is a deliberate act, argued from the data.

### Retention is per class, not per store

Sharing a store does not mean sharing a lifecycle:

- **Tokens are credentials** — re-mintable by one OAuth click, so retention is
  minimized: purged after months of login inactivity and on membership drop.
  Stored at first login but not *used* until the person is approved.
- **Addresses are operational data** — expensive to reconstruct (chasing every
  collector) and load-bearing for label mailing, so they are backed up
  (encrypted) and kept.
- Backup policy follows: the main file backs up freely; the private store's
  backup is encrypted, and the tokens inside it are TTL-bounded anyway.

## Consequences

- Queries joining private data name the attached store; keep such joins few
  and deliberate (they already are, by facet-table convention).
- Key management is now the whole game: losing the key is losing the private
  store; the key's home must survive redeploys and never enter the repo or
  backups.
- A future **data catalog / handling policy** document (tracked as a bead)
  will enumerate every column's class and retention; this ADR records the
  storage architecture it will lean on.
