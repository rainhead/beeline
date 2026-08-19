# Roadmap

Ordered build-out toward a **December 2026 cutover**. Vocabulary per [CONTEXT.md](../CONTEXT.md); the model being built is [schema-sketch.md](schema-sketch.md); open items that gate phases are in [questions.md](questions.md).

**Working stance until cutover:** no migration system — the database is blown away and re-ingested freely. A fresh database plus a fresh Mongo dump means corrections never predate the data, so there is no merge problem during development; corrections made in mock exercises are disposable.

## Phases

1. **Data model in SQL, against DuckDB.** Render the schema sketch into runnable DDL and views. QC rule views and printability are part of the model, not an app feature. Smoke-test the intended app toolchain (Kysely + DuckDB dialect) here, while switching is cheap. *Trap tables stay provisional pending the staff trap questions.*
2. **Legacy ingestion (MongoDB).** Single-shot in spirit, but re-runnable — it runs at least once more, at cutover. Includes taxonomy seeding: resolving verbatim determination names against the curated `taxon` table. **Acceptance test:** reconcile derived QC findings and record counts against production (`errorFlags`, ~38k flagged records).
3. **iNaturalist ingestion.** Authenticated sync (trusted coordinate reads), iterated until it looks right. Design the correction-overlay rule here even though it only matters post-cutover: corrections apply over the latest load; upstream changing a corrected field resolves nothing — it surfaces a QC finding.
4. **Web app.** Authenticated from the first page (iNat OAuth; no anonymous reads — `sample_true_location` makes leaks a live hazard). The self-service QC experience is the flagship. **Decision point: DuckDB vs PostgreSQL** for the app store (below).
5. **Label printing.** Design after the Arthur/Andony printing walkthrough (questions P1–P7). Mock exercises end to end: print runs, proofing pulls, reprints, mailing addresses.
6. **Determinations UI.**
7. **Export / archiving.** Ecdysis, Darwin Core/GBIF. Real backups start here — ahead of the first data that can't be regenerated.
8. **Cutover — December 2026.** Collecting is quiet by December (confirm from observation seasonality once the iNat pipeline is up); up to a week of downtime is acceptable. Freeze the legacy system, final Mongo pull into a fresh database, first real print run. The blow-away era ends: minted catalog numbers are forever, backups are mandatory, and the correction overlay goes live. *Gated on the per-atlas geoprivacy answers and any other before-go-live questions.*

**Deferred past cutover:** notifications/feed (derivable from determination and print-run events); trap-sample entry interface (unknowable until the staff registry questions come back — until then iNat and the legacy import are the only data entry points).

## DuckDB vs PostgreSQL

Keep the door open: dialect-neutral DDL, SQL-first, and no ORM that owns the schema — Prisma is ruled out (no DuckDB support, migration engine wants schema ownership); Kysely is the candidate query layer (Postgres dialect built-in, community DuckDB dialect).

What actually decides it: DuckDB's MVCC means writes don't block reads and serialized writes are fine for this load — but only **one process** may hold the database read-write. The ingestion pipeline and the web app must share a process or hand off the file; if that constraint starts hurting, the app store moves to Postgres and DuckDB remains the pipeline/analytics engine. Decide at phase 4, not during it.
