---
name: populate-store
description: Commands that fill a Beeline store from its sources (the old system's Mongo, iNaturalist, elevation tiles, the gazetteer, Ecdysis, taxonomists' worksheets, staff inventories) and check a downloaded backup. Use when building or refreshing a dev store end to end, re-running one ingestion step by hand, or checking a nightly backup.
---

# Populating a Beeline store

The nightly runs most of these on deployed stores (`src/app/jobs/registry.ts`); by hand they are for a workstation's dev store, or a step re-run on purpose. How each step works is in [`docs/architecture/`](../../../docs/architecture/README.md), mostly [Ingestion, jobs, and elevation](../../../docs/architecture/ingestion-jobs-and-elevation.md).

Populating a fresh store end to end (production access = `beeline` in
`~/.ssh/config`; iNat access = dev OAuth credentials in `data/secrets/`):

```bash
pnpm legacy:fetch && pnpm legacy:load && pnpm legacy:promote  # production Mongo → model
pnpm inat:login                             # OAuth sign-in; mints the 24h JWT sync reads
pnpm inat:sync <projectId> [d1] [d2]        # observation window → append-only loads
pnpm inat:promote                           # current observation state → samples
pnpm inat:backfill-accounts                 # resolve legacy logins → iNat accounts
pnpm elevation:fetch && pnpm elevation:derive  # DEM tiles (SRTM 1-arc-second, Copernicus GLO-30 where SRTM does not reach) → missing elevations
pnpm locality:fetch && pnpm locality:gazetteer  # public place names and outlines (about 2 GB) → data/gazetteer.duckdb, on a workstation
pnpm area:derive [db] [gazetteer]              # the areas (federal wildernesses, counties and BC districts, EPA ecoregions) each sample's coordinates lie inside (the nightly runs it)
pnpm locality:derive [db] [gazetteer]          # a locality named from each sample's coordinates, offered beside its own (the nightly runs it)
pnpm ecdysis:taxonomy [db] [--cached]        # Ecdysis's thesaurus, every insect (about 3 minutes) → data/ecdysis-taxonomy/ → ecdysis_taxon, every animal node matched
pnpm taxon:fetch-sheet <sheet-id> [dir]      # a taxonomist's worksheet, every tab as CSV, to data/taxon-decisions/<modified instant>/ — to be read, not parsed
pnpm taxon:decide <kind> <rank> "<name>" --by … --reason …   # record one decision (or --batch file.csv): Ecdysis's facts filled from the store, the row validated, the file merged
pnpm taxon:apply [db]                        # replay ingest/taxon-curation.csv onto a store: the program's departures from Ecdysis, and what a later fetch moved from under
pnpm received:store <file> --from "<who>" --sent <instant>  # any file someone sends, kept as sent on the shared drive, as the backup's service account (key in data/secrets/drive-key.json); prints its Drive id
pnpm received:fetch <drive-id>                # → data/received/<id>/, the file and file.json, which the loaders below read
pnpm determinations:load data/received/<id> [db] [--dry-run]  # an expert's own sheet of determinations (Darwin Core headers) → expert determinations; what it cannot place goes to held.csv beside it
pnpm disposition:load <file> [db] --by <name> --on <date>  # a staff inventory's remark on each specimen (Andony's 2025 master file) → specimen_disposition; what it cannot place goes to <file>.held.csv
pnpm legacy:export [db] [out.csv]            # every specimen as the legacy occurrences file (the app writes it nightly)
pnpm legacy:compare-export [db] [export.csv] # how far that file is from the staged legacy records, by kind and by column, in records split by season with a few examples each, less what ingest/legacy-export-rulings.csv explains
pnpm backup:check <archive.tar.gz> [dir]     # a nightly backup downloaded from Drive: hashes against its manifest, the store opened (and, in an archive from before 2026-11-05, the retired private store, with BEELINE_PRIVATE_DB_KEY), left extracted for a restore
```
