# The reference implementation (OBP-Server)

What [OBP-Server](https://github.com/oregon-bee-project/OBP-Server/) actually does, recorded here so the replacement is designed against facts rather than folklore. Surveyed 2026-08-18. File references are paths into that repo (as of branch `fix/refresh-privacy-on-repull`).

Architecture in one line: Express API → RabbitMQ → a single worker container, MongoDB, an nginx front, a React SPA, and a `shared/data/` directory of CSVs and JSON files that is as much the system of record as the database is.

## Data model

- **MongoDB, schemaless, everything a string** — including coordinates, dates, and counts. Sorting requires derived fields: a hand-built `composite_sort` string (zero-padded numbers, `zzzz…` sentinels) and a parallel BSON `date` with a year-2100 sentinel (`shared/lib/repositories/OccurrenceRepository.js:12-61`).
- **Collections**: `occurrences` (one row per specimen, ~60 Darwin-Core-flavored string columns), `observations` (whitelisted raw iNat JSON — a scratch cache truncated at the start of each ingest subtask), `determinations` and `plants` (ephemeral join buffers round-tripped through CSVs), `tasks`, `admins`.
- **The primary key is a SHA-256 of mutable business data**: `sha256(sampleId, specimenId, day, month, year, url)` (`shared/lib/services/OccurrenceService.js:123-141`). If a volunteer corrects a date or sample number on iNaturalist — or an operator edits one via CSV — the next sync computes a different hash and *inserts a duplicate*; the original is never reconciled. This is the structural root of much observed fragility.
- **Reference data is flat files, gitignored**: collectors (`usernames.csv` — re-read from disk on every lookup), bee taxonomy (`beeTaxonomy.json`, used only to validate volunteer determinations; expert determinations are free text), iNat places and plant-taxon caches, sex/caste. No version control, no schema.
- **No atlas/project entity.** iNat project ids are per-task parameters (OBA 18521, Master Melittologist 99706, WaBA 166376 hardcoded as UI defaults); nothing on a record says which atlas owns it. The only regional marks are `stateProvince` and an Oregon-only special case. One hardcoded person-split hack: iNat login `pandg` after 2021 resolves to Gretchen or Robert by `sampleId > 100`.

## Identity and catalog numbers

- The label identifier is `fieldNumber`: 2-digit year + zero-padded sequence (`25000001`). Assigned only to flag-free records, in sort order, by scanning for the current max and incrementing in memory. **No unique index; uniqueness is advisory.** Two generator implementations exist and disagree on scope — one takes the global max, the other the max within the current working set, which can reissue held numbers (`worker/src/handlers/ObservationsSubtaskHandler.js:83-146` vs `OccurrencesSubtaskHandler.js:118-184`).
- The year prefix is vestigial: the year is consulted only when the collection is empty; otherwise 2026 records continue incrementing `25xxxxxx`.
- `catalogNumber` in their schema means the *museum's* identifier: read from Ecdysis determination exports by stripping `WSDA_`. Oregon records additionally get an OSAC URI (`https://osac.oregonstate.edu/OBS/OBA_<fieldNumber>`) as `occurrenceID`; other states get no stable public identifier.

## iNaturalist ingestion

- v1 API; project pulls by date range (6-month windows), 200/page. One app-wide OAuth token, admin-linked, AES-encrypted on disk, exchanged for a ~24 h JWT per process.
- **Nothing runs on a schedule.** All ingestion is an admin submitting task pipelines by hand.
- The sample→specimen fan-out: OFVs `sampleId` and `numberOfSpecimens` drive everything; an observation with count N yields N occurrence rows (`specimenId` 1..N). No sample id ⇒ no rows.
- **Deletions are never detected.** An observation deleted or removed from the project leaves its occurrences in the database and every export forever.
- **Count increases are dead code, twice over**: the Mongo view feeding `#insertOccurrencesFromBeeIncreases` `$project`s away the `ofvs` the handler reads, *and* its `$match` tests a misspelled field (`occurrencesCount` vs `occurrenceCount`), so it always returns nothing (`shared/lib/database/DatabaseManager.js:202-247`). The stated workflow of incrementally growing a sample's specimen count does not currently work via sync.
- **Silent degradation is the norm**: if the OAuth token fails, requests proceed anonymously — which makes every trusted record's private coordinates disappear and triggers a mass coordinate *downgrade* on the next refresh. Failed/rate-limited pages return `undefined`, coerced to "zero observations" by every caller. Pulls exceeding iNat's 10,000-record search window silently drop the tail.

## Coordinates and privacy

The best-engineered corner (and, note, still on branch `fix/refresh-privacy-on-repull`, not `main`): private coordinates preferred field-by-field over public ones, provenance tracked in `coordinateSource`, obscured-but-untrusted records flagged and blocked from labels, revoked trust withdraws true coordinates (`OccurrenceService.js:82-107, 970-991`).

Then it's all undone at the API layer: `GET /api/occurrences?userLogin=X` is unauthenticated and returns full rows including coordinates derived from private ones, and most output directories (`/api/occurrences`, `/api/flags`, `/api/labels`, …) are unauthenticated static serves with predictable filenames. CORS is wide open alongside cookie auth.

## Users and auth

- **Admins**: bcrypt + JWT cookie, flat permissions (any admin can create/delete any admin), no audit trail, username uniqueness enforced only by a read-then-write check.
- **Volunteers are not accounts.** The "volunteer login" compares a single shared password baked into the public JS bundle, client-side, then filters by whatever `userLogin` the visitor typed. Volunteers may anonymously write exactly five fields (their own determination columns) on any record.

## Quality control

- One function computes `errorFlags` — a semicolon-joined string of offending field names (missing required fields; obscured coords; unabbreviated country/state; locality containing street suffixes, commas, quotes, or >18 chars; coordinate uncertainty >250 m; non-tracheophyte host). String-typed, so "which records are flagged for X" cannot be queried server-side; printability is decided by loading rows into Node.
- Wyoming is missing from the state-abbreviation table, so every WY record is permanently flagged.
- **Duplicate sample numbers between collectors are never detected** (same-collector duplicates collide on the hash id and are counted, not reported).
- The "weekly emails" are a CSV of addresses bucketed by error category that a human downloads and pastes into a mail client. There is no SMTP anywhere. The weekly cadence is operator convention.

## Labels

- 250 labels per US Letter sheet via pdf-lib; 3–5 pt auto-shrinking Oxygen Mono; DataMatrix barcode of the catalog number; blank cell between collectors. Location `USA:OR:BentonCo Corvallis`, date `14.VII2025-3.2` (day.RomanMonth year - sample.specimen).
- **A label carries no taxon.** `LabelsSubtaskHandler.js:59-113` builds exactly six fields — location, coordinates (+elevation), date, collector, method, field number — and never reads `scientificName`, `genus`, `specificEpithet` or `identifiedBy`. The determinations subtask merges determination data into the database and produces no label of its own. So a label is a *collecting-event* label: printing happens before determination and is not gated on one (`errorFlags` names no taxon field either). The determination reaches the museum through Ecdysis, not through the pin.
- Print state is a single mutable `dateLabelPrint` string per record. Reprints (via an ignore flag) overwrite it. **No print history, no sheet/batch record, no way to identify which physical labels a later data correction invalidates.**

## The task system

- A task = ordered subtask array (13 types: pull observations, refresh occurrences, labels, determinations merge, emails, addresses, pivots, plant list, stewardship R report, overwrite, upload, download, CSV sync). Admin-built pipelines; outputs chain by filename convention into `shared/data/`.
- **Single-threadedness is load-bearing**: nearly every handler stages work by flipping a global `scratch: true` flag on occurrence rows and *begins by deleting whatever is in scratch*. Concurrent tasks would destroy each other. One worker, `prefetch(1)`.
- **Tasks are not durable**: messages published non-persistent, the queue is *purged on every server start*, and the worker acks before doing the work. Restarts silently lose queued work; crashes strand tasks in `Running` and leave orphaned scratch rows for the next task to delete.
- The canonical export/backup/seed is `workingOccurrences.csv` — a full CSV dump synced both ways with the database (also the DB seed when empty). Google Drive upload is the only automated outbound integration. **There is no GBIF/Ecdysis/DwC-A export**; the vocabulary is Darwin-Core-flavored but everything leaves as CSV.

## Production data census (2026-08-18)

Read-only survey of the production MongoDB (383,032 occurrence records, 2017–2026, growing ~72k/year):

- **Everything in the database is printed** — 383,031 of 383,032 records have `dateLabelPrint`. The production database is in effect the *archive of printed labels*; the pre-print lifecycle (pull, QC, fix, number, print) happens in transit through scratch state and CSVs and leaves no resident population. The replacement owns that entire pre-print lifecycle as first-class data.
- **By state**: OR 270k, WA 72k, BC 17k, NM 13k, ID 7k, OK 48 — plus ~2,500 records from outside the atlases entirely (NV 1,238; KS 291; MT, CA, YT, AZ, TX, WY, NY…).
- **10% of printed records are currently flagged** (38,302), and one rule dominates: `locality` (37,174 — 97% of all flags), then `coordinateUncertaintyInMeters` (1,100), with everything else in the tens. Since these records were all printable once, the flags reflect rules recomputed after printing — a live demonstration that findings are derived data, and that the locality rule is where machine-proposed rewrites would pay off.
- **Four identifier eras** in `fieldNumber`: 2018 name-based ids (`First_Last:18.sss.nnn`, ~18.5k records, several length variants including sample ids like `18.140c` and `18.22vi7`), 7-digit numbers (`1800001`–`2463721`), 1,400 `E`-prefixed numbers (`E2000000`–`E2332481`, all Oregon 2020–2022; meaning unknown even to the current project lead), and 8-digit numbers (`25000001`+). The E-prefix is a live join hazard: 411 of the 1,400 collide with existing plain numbers if the letter is ever stripped — and prefix-stripping is an established pattern in this codebase (`WSDA_`). The 7→8 digit transition happened at 2025; WABA's Ecdysis suffixes fall inside the same ranges, confirming one sequence shared across atlases.
- **One live duplicate**: `25051768` was issued twice to the same collector (samples 1 and 2), printed 17-Aug-25 and 16-Sep-25 — the scratch-scoped max-scan reissue predicted from the code, observed in the wild. Two physical specimens bear this number.

## Requirements the replacement inherits from these findings

1. Specimen identity must be stable and independent of correctable fields (dates, sample numbers, upstream URLs).
2. Catalog-number uniqueness must be a hard guarantee (database constraint / sequence), not a scan-and-increment convention.
3. Ingestion must be scheduled, authenticated-or-abort (never silently anonymous), and must detect edits, deletions, and count changes — with partial fetches failing loudly rather than reporting empty success.
4. Private/obscured coordinate handling must extend to the read path: real authentication, per-user authorization, no anonymous coordinate reads.
5. Print events need durable history (what was printed, when, on which sheet, from which data), so later corrections can name the physical labels they invalidate.
6. Atlases, collectors, and the curated taxonomy must be first-class, versioned entities, not flat files or per-task parameters.
7. QC flags must be queryable data (typed, per-rule), surfaced to the responsible user in-app, with resolution trackable in one session.
8. Concurrency safety must come from the data model (transactions, ownership), not from having exactly one careful operator.
