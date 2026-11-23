# Migrations

Deltas that bring an **already-deployed** database up to `schema/*.sql`. The
schema is still the schema ([ADR 0006](../docs/adr/0006-migrations-for-deployed-stores.md));
these files exist only because the sandbox — production after cutover — can't
be blown away and rebuilt.

Write the change in `schema/` first, then copy the delta here as
`NNNN-slug.sql` (filename order is apply order). A migration that changes
something the schema does not make, such as the views legacy promotion
leaves behind, names those objects on its first line, `-- needs: a, b`; a
store lacking any of them records the migration without running it, since
there is nothing there to change (0109 is the first). Local databases never run
them: `pnpm db:build` stamps every migration as applied, because a fresh
build already has the change.

```sh
pnpm db:migrate [db]            # apply what's pending, then CHECKPOINT, then report drift
pnpm db:migrate --status [db]   # read-only: what's applied, what's pending
pnpm db:migrate --check [db]    # read-only: --status, then diff the store against schema/*.sql
pnpm db:migrate --baseline [db] # record as applied without running
```

`--status` and `--check` never write: no migration runs, no ledger is
created, nothing is checkpointed. So `--check` is safe to run to *decide*
whether to migrate. It was not always: it used to migrate first and diff
after, and on a store that already carried a later change by another route
it applied two migrations and stopped at the third (beeline-736).

`--check` compares the names of the tables, views and columns the schema
declares and the `COMMENT` on each. It does not compare a view's definition:
DuckDB stores that text as the version that wrote it serialised it, so
production's differs in text (not in meaning) from a fresh build's, in 85 of
134 views on the backup of 2026-11-22. A migration that replaces a view with
`CREATE OR REPLACE VIEW` must restate its `COMMENT ON VIEW`, because the
replacement drops it. A view reads the views under it as they are now, so
replacing one view needs no migration for the views that read it. Numbers may
skip (the runner orders by filename); two migrations already share some.
See the 2026-11-22 amendment in [ADR 0006](../docs/adr/0006-migrations-for-deployed-stores.md).

**Changing a view, a table or a comment.** A change to a view in `schema/`
needs a new migration that restates the whole view with `CREATE OR REPLACE
VIEW` and then its `COMMENT ON VIEW`, in the same file. Never edit a migration
that has been deployed: production records each file it has run and never runs
it again, so an edit passes the tests and changes nothing there. A migration
that states a view must sort after every existing migration that states the
same view, because the test takes the last one by filename, so if another
branch lands first, renumber yours on rebase. Any changed `COMMENT ON`, for a
view, a table or a column, needs a migration too. For tables and columns
nothing in the test suite checks this yet: only `pnpm db:migrate --check`
against a store shows it.

**What each failure of `test/view-migrations.test.ts` means.**

- *"gives differs from schema/'s", or the comment differs.* The view was
  changed in `schema/` and the newest migration that creates it was not
  updated. Write a new migration that restates the view and its comment.
- *"changed in schema/ and held by a hash".* The view is listed in
  `view-hashes.txt` because no migration since 0071 creates it. Write a new
  migration that restates the whole view and its comment, then delete the
  view's line from the file. A migration with only the comment is not enough:
  the hash covers the text and the comment, and the view has to become one
  that a migration states.
- *"created with no COMMENT ON VIEW after it".* `CREATE OR REPLACE VIEW` drops
  the view's comment. Write a new migration that restates the view and then
  its comment.
- *"neither schema/ nor ingest/ declares it any more".* A view was removed
  from `schema/` and no migration drops it, so a deployed store keeps it.
  Write a new migration with `DROP VIEW`.
- *"DuckDB changed from X to Y".* The hashes were made by another DuckDB
  version, which writes the same view as different text. Run `pnpm
  views:rehash`. It refuses to run when the version has not changed, because
  then a differing hash means the view changed and needs a migration.
- *A view the test cannot see.* The test reads a view's name from the first
  words of a statement, in three forms only: `CREATE [OR REPLACE] VIEW name`,
  `DROP VIEW name` and `COMMENT ON VIEW name IS`, with a bare name. It does not
  recognise `ALTER VIEW ... RENAME`, a quoted or `main.`-qualified name, or
  `CREATE TEMP VIEW`. A migration using one of them is not seen, so the view
  fails as one that no migration states. Use `DROP VIEW` and `CREATE VIEW` with
  a bare name instead.

`view-hashes.txt` holds a hash of the text and comment for each view that no
migration from 0071 on creates (73 on 2026-11-22), since those cannot be
replayed. 0071 is the first migration production ran: its store was built
fresh from `schema/` at cutover, stamped every earlier migration at one
instant, and ran 0071 two hours later (read from the migration ledger of the
backup of 2026-11-22). The file only shrinks, except after a DuckDB upgrade.

Nothing else may hold the database open (ADR 0005), so the app must not be
running. On Fly the entrypoint migrates before it starts the app
([`infra/fly/entrypoint.sh`](../infra/fly/entrypoint.sh)), so a deploy needs no
step of its own.

**Three changes landed before cutover with no migration**, all after 0068,
because the production store is built fresh from `schema/` at cutover and a
referenced table cannot be restructured on a deployed store: two columns
nothing read were dropped, `atlas.inat_place_id` and `qc_rule.instructions`
(beeline-ni5m.4); and the `atlas` table was folded into `program`, with every
`atlas_id` column referencing `program` and `person_membership` keyed by
`program_id` in place of a kind and a nullable atlas (beeline-ni5m.2). A
sandbox store built earlier shows all of it as drift in `--check` until it is
reseeded, correctly. The CHECKs on `determination.sex` and `determination.caste`
(beeline-ni5m.5) are of ADR 0006's other kind: a deployed store cannot gain a
CHECK at all, and `--check` does not compare them, so only the fresh build has
them.

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
[deploy-fly.md](../docs/runbooks/deploy-fly.md#re-deriving-the-model-after-a-promotion-change), not a migration.
