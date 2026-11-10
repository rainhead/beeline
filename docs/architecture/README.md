# Architecture

How each part of Beeline works, one file per area. Read the file for the area you are about to change before changing it: each records the decisions and traps behind that code, with the issues and ADRs that carry them. When a change alters how an area works, update its file in the same pull request, and add a line here for a new area.

- [Store and schema](store-and-schema.md) — `schema/*.sql`, `migrations/NNNN-slug.sql`
- [The app process, and its gate](the-app-process-and-its-gate.md) — `src/app/`, `src/app/theme/tokens.ts`
- [Browsing: scope, filters, sort](browsing-scope-filters-sort.md) — `src/app/listings.ts`, `src/app/views/listings.tsx`
- [The front page](the-front-page.md) — `src/app/dashboard.ts`, `src/app/views/qc.tsx`
- [One record](one-record.md) — `src/app/record.ts`, `src/app/views/record.tsx`
- [Printing](printing.md) — `schema/035`, `schema/155`, `src/registry-mark.ts`
- [Determinations from Ecdysis](determinations-from-ecdysis.md) — `src/load-ecdysis.ts`, `src/adopt-ecdysis.ts`
- [Volunteers identifying their own specimens](volunteers-identifying-their-own-specimens.md) — `src/app/determine.ts`, `src/app/views/determine.tsx`
- [Determinations from worksheets](determinations-from-worksheets.md) — `src/fetch-worksheets.ts`, `src/load-worksheets.ts`
- [Files people send, and expert determination sheets](files-people-send-and-expert-sheets.md) — `src/received-files.ts`, `src/load-determination-sheet.ts`
- [Copy](copy.md) — `src/app/messages/`
- [A value that is not there](a-value-that-is-not-there.md) — `src/app/views/components/text.tsx`
- [Determinations and names](determinations-and-names.md) — `schema/020`, `schema/115`
- [The roster](the-roster.md) — `src/app/roster.ts`, `src/app/views/roster.tsx`
- [The person's own page, and the overlay](the-persons-own-page-and-the-overlay.md) — `src/person-overlay.ts`, `src/apply-person-overlay.ts`
- [Collectors Beeline doesn't know](collectors-beeline-doesnt-know.md) — `src/app/unclaimed.ts`, `src/app/views/unclaimed.tsx`
- [What happened to a person, and when](what-happened-to-a-person-and-when.md) — `schema/040`, `src/person-change.ts`
- [And to a sample](and-to-a-sample.md) — `src/sample-change.ts`
- [Delegation](delegation.md) — `src/app/acting.ts`
- [Membership](membership.md)
- [Programs](programs.md) — `src/app/programs.ts`, `src/app/views/programs.tsx`
- [ORCID](orcid.md) — `schema/103`
- [Addressing a person, and admin](addressing-a-person-and-admin.md)
- [Editing and corrections](editing-and-corrections.md) — `src/corrections.ts`, `ingest/legacy-corrections.csv`
- [Entering trap samples](entering-trap-samples.md) — `src/trap-sample.ts`, `src/app/views/trap-sample.tsx`
- [The legacy-format export](the-legacy-format-export.md) — `src/legacy-export.ts`, `src/legacy-copy.ts`, `ingest/collector-aliases.csv`
- [Errors and logs](errors-and-logs.md) — `src/app/error-reporting.ts`, `src/app/usage.ts`
- [Backups](backups.md) — `src/store-backup.ts`, `src/store-snapshot.ts`
- [Ingestion, jobs, and elevation](ingestion-jobs-and-elevation.md) — `src/app/jobs/`, `src/write-conflict.ts`
- [Localities from coordinates](localities-from-coordinates.md) — `src/locality-rule.ts`, `src/derive-locality.ts`, `ingest/gazetteer.sql`
- [Areas](areas.md) — `schema/038`, `src/derive-area.ts`
