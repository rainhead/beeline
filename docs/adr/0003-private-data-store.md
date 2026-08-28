# ADR 0003: Private data lives in a separately-secured store

**Status:** accepted (2026-08-20) · **Reviewed:** unchanged by the phase-4
app-store decision ([ADR 0005](0005-app-process-owns-the-store.md),
2026-08-22) — the owning app process `ATTACH`es the private store ·
**Amended** (2026-08-23, beeline-2yh): true coordinates stay in the main
store; the copy claim is qualified. See *Whose privacy?* below. ·
**Amended** (2026-08-28): volunteers' OAuth tokens are no longer stored at
all. See *What is actually in here* below.

## What is actually in here (2026-08-28)

The first of the three motivating data classes is gone. Beeline stored every
volunteer's iNaturalist access token at sign-in and **never read one back**:
the session cookie is what authenticates a request, and sync authenticates as
the pipeline rather than as a volunteer. A non-expiring credential kept for no
reason is one leaked for no reason, so the column is dropped and the app's boot
patch deletes it from stores that have been accumulating them (`src/app/db.ts`).

One iNaturalist token is still kept and is deliberately not in here: the
**pipeline credential** that authenticated sync reads use, in
`data/secrets/inat-oauth-token` at mode 600. It belongs to the program rather
than to a participant — Peter's registration today, Andony's in production
(beeline-5ep) — and losing it costs a re-authorization rather than a person's
account. Whether it should move into this store is worth asking once there is a
second one.

So the store now holds **session ids** — bearer credentials in their own right,
which is reason enough for it to exist and to be encrypted — and **who has been
here and when** (`person_activity`, beeline-dji), which is nobody's business
but the program's. Mailing addresses and email arrive when their features do.

If a per-volunteer token is ever needed, it wants its own decision and its own
retention rule, not the quiet revival of a column nothing read.

## Context

*(As originally written. The token class is no longer held — see above.)*

Beeline holds three kinds of data that must never travel with the rest of the
database: iNaturalist OAuth tokens (which do not expire — a leaked token is a
credential forever), collectors' mailing addresses (the one truly private
datum per [CONTEXT.md](../../CONTEXT.md)), and any email addresses we come to
hold. All three are **participant** data — they expose a person. Meanwhile the main database file is *meant* to be copied casually —
backups, analytics, handing a snapshot to a student. Per-column encryption
would protect these fields but taxes every read path with crypto code and
leaves the policy invisible in the schema.

The schema style already isolates each private concern in its own satellite
table (ADR 0002 facets; "its own table, no accidental joins"). That seam makes
isolation a matter of *where the table lives*, not how its columns are coded.

## Decision

**Private satellite tables live in a separate database file, encrypted as a
whole, attached at runtime.** The main file contains no participant secrets,
and may be copied among people trusted with it.

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

### Whose privacy? (amended 2026-08-23, beeline-2yh)

Trusted syncs store whole observation projections — `private_geojson` included
— in the **main** file (`observation_load`, [schema/060](../../schema/060_sync.sql)),
and believed-true coordinates land in `sample_location`. The review that
surfaced this read it as a leak in the store boundary. It is not, because the
two stores protect **different subjects**:

- **The private store protects participants.** Tokens, addresses, email —
  data that exposes a *person*, who did not sign up to be exposed and cannot
  undo it.
- **True coordinates protect sensitive plants.** Taxon-driven geoprivacy hides
  a *population's* location from the public, to keep it from being dug up.
  That is a real duty, but it is not participant privacy and it does not want
  the same mechanism.

**Anyone trusted with the main store is trusted to protect the plants too.**
That is the decision: true coordinates are ordinary main-store data, no
redaction on load, no private projection of `observation_load`.

Two things follow. First, collector locations were never private anyway —
collecting for the program implies willingness to say where
([CONTEXT.md](../../CONTEXT.md)), so the only secrecy interest in a coordinate
is the taxon-driven one. Second, the control moves from the file to the
recipient: "safe to copy by construction" becomes "safe to copy to someone
trusted", and the ADR's own casual example — handing a snapshot to a student
— is the case that stops being casual. A student wants a derived export, and
redaction belongs there (roadmap phase 7), not in the store.

This says nothing about **revelation**: whether an atlas may show
taxon-obscured coordinates on a label, in the app, or in an export remains
per-atlas, open, and a go-live blocker ([questions](../questions.md)). Holding
the data is what keeps either answer implementable.

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
- Who may receive a main-store copy is now a judgement, not a property of the
  file. The data catalog below should say so explicitly, and any snapshot
  handed outside the trusted circle goes through an export that redacts
  taxon-obscured coordinates.
- Key management is now the whole game: losing the key is losing the private
  store; the key's home must survive redeploys and never enter the repo or
  backups.
- A future **data catalog / handling policy** document (tracked as a bead)
  will enumerate every column's class and retention; this ADR records the
  storage architecture it will lean on.
