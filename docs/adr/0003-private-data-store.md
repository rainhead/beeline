# ADR 0003: Private data lives in a separately-secured store

**Status:** accepted (2026-08-20) · **Reviewed:** unchanged by the phase-4
app-store decision ([ADR 0005](0005-app-process-owns-the-store.md),
2026-08-22) — the owning app process `ATTACH`es the private store ·
**Amended** (2026-08-23, beeline-2yh): true coordinates stay in the main
store; the copy claim is qualified. See *Whose privacy?* below. ·
**Amended** (2026-08-28): volunteers' OAuth tokens are no longer stored at
all. See *What is actually in here* below. · **Retired** (2026-11-05,
beeline-4tdh): the store is gone and its tables are in the main store. See
*Retired* below; the rest of this record is kept as the reasoning it was.

## Retired (2026-11-05)

By November the store held four tables: sign-in records (an iNaturalist
login, a public avatar address and two dates per person), sessions, when each
person was last here, and a log of staff viewing Beeline as somebody else.
Only the sessions would do harm in the wrong hands. A session row held the
very value the browser keeps in its cookie, so anyone with a copy of the
table could put that value in their own browser and be signed in as anyone
listed, staff included, for as long as they kept using it. The usual fix
makes that harmless without a second store: keep only the SHA-256 of each
cookie (beeline-5l84), from which the cookie cannot be worked out, so a copy
of the table signs nobody in. The cookie is 256 random bits, so one SHA-256
is enough. A session now also ends 90 days after sign-in however often it is
used (beeline-jpau).

With that done, the rest is less sensitive than what the main store already
holds — people's names, their iNaturalist accounts, and true coordinates —
and the separate store cost more than it protected: a key that had to
survive somewhere other than the server or every backup's copy was lost
(beeline-yml3), a second file in every backup and every restore, and a
boot-time patching mechanism of its own beside migrations (ADR 0006). So the
four tables moved into the main store (`schema/012`, migration 0076), and the
app carried production's rows across at its first boot afterwards
(`absorbPrivateStore`, `src/app/db.ts`) — all but the sessions, which no
browser could have used again, since the session cookie was renamed at the
same time (beeline-73c9). Everyone signed in once more.

**Mailing addresses were this store's reason to exist, and they have not
arrived** (beeline-1kb.6). When they do, how to protect them is a new
decision, made then from what they are and who reads them — not an
assumption that this store's answer still holds.

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
- Tables that belong there: session ids, `mailing_address`, email if ever
  held — and OAuth tokens, had we kept any (2026-08-28: we do not). The
  default for a new column is the main file; placing a table in the private
  store is a deliberate act, argued from the data.

### Whose privacy? (amended 2026-08-23, beeline-2yh)

Trusted syncs store whole observation projections — `private_geojson` included
— in the **main** file (`observation_load`, [schema/060](../../schema/060_sync.sql)),
and believed-true coordinates land in `sample_location`. The review that
surfaced this read it as a leak in the store boundary. It is not, because the
two stores protect **different subjects**:

- **The private store protects participants.** Session ids, addresses, email —
  data that exposes a *person*, who did not sign up to be exposed and cannot
  undo it. (As written this said "tokens" first; see the 2026-08-28 amendment.)
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

- **Credentials are re-mintable** — an OAuth click, a fresh sign-in — so
  retention is minimized: sessions expire on a sliding 30-day idle cutoff and
  are purged. This clause was written about volunteers' OAuth tokens, whose
  retention is now zero (2026-08-28); it holds unchanged for the session ids
  that replaced them as the credential this store keeps.
- **Addresses are operational data** — expensive to reconstruct (chasing every
  collector) and load-bearing for label mailing, so they are backed up
  (encrypted) and kept.
- Backup policy follows: the main file backs up freely; the private store's
  backup is encrypted, and the credentials inside it are TTL-bounded anyway —
  more so since 2026-08-28, when the only non-expiring one stopped being kept.

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
