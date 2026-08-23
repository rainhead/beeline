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
