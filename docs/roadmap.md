# Roadmap

Ordered build-out toward a **December 2026 cutover**. Vocabulary per [CONTEXT.md](../CONTEXT.md); the model being built is [schema-sketch.md](schema-sketch.md); open items that gate phases are in [questions.md](questions.md).

**Working stance until cutover:** databases are blown away and re-ingested freely; the schema is `schema/*.sql`, never a history of migrations. The one exception is a database nobody can rebuild — the sandbox, which becomes production at cutover — and [ADR 0006](adr/0006-migrations-for-deployed-stores.md) is how those catch up (`migrations/`, `pnpm db:migrate`). Corrections deliberately sit **outside** the blow-away path (the git-curated CSV and the app-written `data/corrections.csv`, [ADR 0004](adr/0004-correction-overlay.md)) so rebuilding never loses them; a dev environment that wants a truly clean slate deletes `data/corrections.csv` too.

## Phases

1. **Data model in SQL, against DuckDB.** Render the schema sketch into runnable DDL and views. QC rule views and printability are part of the model, not an app feature. Smoke-test the intended app toolchain (Kysely + DuckDB dialect) here, while switching is cheap. *Trap tables stay provisional pending the staff trap questions.*
2. **Legacy ingestion (MongoDB).** Single-shot in spirit, but re-runnable — it runs at least once more, at cutover. Includes taxonomy seeding: resolving verbatim determination names against the curated `taxon` table. **Acceptance test:** reconcile derived QC findings and record counts against production (`errorFlags`, ~38k flagged records).
3. **iNaturalist ingestion.** Authenticated sync (trusted coordinate reads), iterated until it looks right. Design the correction-overlay rule here even though it only matters post-cutover ([ADR 0004](adr/0004-correction-overlay.md)): corrections apply over the latest load; upstream converging to the corrected value auto-retires the correction; upstream moving to a third value leaves the correction standing and surfaces a `correction_conflict` QC finding.
4. **Web app.** Authenticated from the first page (iNat OAuth; no anonymous reads — `sample_true_location` makes leaks a live hazard). The self-service QC experience is the flagship. The app-store decision is made ([ADR 0005](adr/0005-app-process-owns-the-store.md)): the app process owns the DuckDB store, ingestion moves in-process under interactivity SLAs; stack is Hono + SSR with Lit islands. Plan: epic beeline-2c3.
5. **Label printing.** Design after the Arthur/Andony printing walkthrough (questions P1–P7). Mock exercises end to end: print runs, proofing pulls, reprints, mailing addresses.
6. **Determinations UI.**
7. **Export / archiving.** Ecdysis, Darwin Core/GBIF. Real backups start here — ahead of the first data that can't be regenerated.
8. **Cutover — December 2026.** Collecting is quiet by December (confirm from observation seasonality once the iNat pipeline is up); up to a week of downtime is acceptable. Freeze the legacy system, final Mongo pull into a fresh database, first real print run. The blow-away era ends: minted field numbers are forever, backups are mandatory, and the correction overlay goes live. *Gated on the per-atlas geoprivacy answers and any other before-go-live questions.*

**Deferred past cutover:** notifications/feed (derivable from determination and print-run events); trap-sample entry interface (unknowable until the staff registry questions come back — until then iNat and the legacy import are the only data entry points).

## DuckDB vs PostgreSQL

Decided as [ADR 0001](adr/0001-duckdb-first-with-portable-sql.md): DuckDB first, behind dialect-neutral SQL, no ORM owning the schema, Kysely as the query layer. The phase-4 re-decision landed as [ADR 0005](adr/0005-app-process-owns-the-store.md): the app store stays DuckDB, the single app process owns it (ingestion becomes in-process scheduled jobs under interactivity SLAs, with a night-window carve-out), and Postgres remains the escape hatch if the SLAs prove unmeetable.
