# Migrations

Deltas that bring an **already-deployed** database up to `schema/*.sql`. The
schema is still the schema ([ADR 0006](../docs/adr/0006-migrations-for-deployed-stores.md));
these files exist only because the sandbox — production after cutover — can't
be blown away and rebuilt.

Write the change in `schema/` first, then copy the delta here as
`NNNN-slug.sql` (filename order is apply order). Local databases never run
them: `pnpm db:build` stamps every migration as applied, because a fresh
build already has the change.

```sh
pnpm db:migrate [db]            # apply what's pending, then CHECKPOINT
pnpm db:migrate --status [db]   # what's applied, what's pending
pnpm db:migrate --check [db]    # diff the store against schema/*.sql
pnpm db:migrate --baseline [db] # record as applied without running
```

Nothing else may hold the database open (ADR 0005), so stop the app first —
`scripts/deploy-maderas.sh` does that around the migrate step.

**0001–0023 are the pre-reseed epoch.** beeline-6e9 rebuilt `sample` —
collector and atlas off the table, `sample_atlas` and
`sample_primary_collector` in — which is ADR 0006's "not migratable at all"
case: DuckDB cannot drop a column on a table five others reference, so there
is no migration for it and the deployed store caught up by `pnpm db:reseed`
instead. These files remain correct for the shape they served and can no
longer be applied to a store built from today's `schema/` (0021 recreates
views that read `sample.collector_id`); no store will run them again — fresh
builds and reseeded stores stamp them. A store still shaped before the epoch
shows up in `db:migrate --check` as drift naming the sample rework, and the
answer is the reseed recipe in
[deploy-maderas.md](../docs/runbooks/deploy-maderas.md), not a migration.
