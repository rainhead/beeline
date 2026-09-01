# Deploy to Fly

Beeline runs on Fly as one app, one machine, one volume, in `sea`. Tracked
config: [`fly.toml`](../../fly.toml), [`Dockerfile`](../../Dockerfile),
[`infra/fly/entrypoint.sh`](../../infra/fly/entrypoint.sh). **Temporary hosting** in
the same sense maderas was: the decision is re-made with Andony at cutover.

The shape is not a sandbox shortcut. Exactly one process may hold
`beeline.duckdb` ([ADR 0005](../adr/0005-app-process-owns-the-store.md)), and
a Fly volume attaches to exactly one Machine — so the platform enforces what
the systemd unit could only ask for. A second machine has no store to open.
Never `fly scale count 2`, and never the `bluegreen` strategy: both want a
machine that cannot get the volume.

## The three things that are not obvious

**Migrations run in the entrypoint, not a `release_command`.** Fly runs
release commands on a temporary machine with no volume mounted, so that
machine cannot see the store — the one job it would be for. The entrypoint
migrates and then `exec`s the app, which is the better shape anyway: Fly
replaces the machine in place, so the store is free for the whole of boot and
there is no window for a second process.

A failed migration fails the boot — but be exact about what that buys. There
is one machine and Fly has already replaced it, so **the site goes down**;
nothing keeps serving the previous release. What it guarantees is narrower and
still worth having: new code never serves against an unmigrated store, and the
machine restart-loops visibly rather than corrupting anything. Recovering means
fixing the migration and deploying again, or booting into maintenance mode and
restoring `beeline.duckdb.pre-migrate`.

**Node is PID 1, never `pnpm`.** pnpm does not forward SIGTERM: it takes the
signal, kills the app, and exits 1 in about a quarter of a second, so the
shutdown handler never runs and the WAL is left uncheckpointed — the state
DuckDB ≤ 1.5.5 can fail to replay, leaving the file unopenable (beeline-c1b).
`kill_timeout` cannot help, because nothing is waiting. Hence
`exec node --import tsx src/app/main.ts`.

**DuckDB's budgets are stated, not detected.** `BEELINE_DUCKDB_MEMORY_LIMIT`
and `BEELINE_DUCKDB_THREADS` are set in `fly.toml` and read by `duckDbConfig`
([`src/db.ts`](../../src/db.ts)). Unset, DuckDB sizes itself from a cgroup
reading and can plan a query against memory the machine will not give it,
which the kernel answers with a kill rather than a spill. Stated, an
over-large query spills to disk: measured, a full legacy promotion completes
with the limit at 244 MiB, 16% slower than uncapped.

## One-time setup

Off-host first: DNS for `beeline.beeatlas.net` is CDK-managed in the
**beeatlas** repo — add records there and `cdk deploy`, never hand-edit Route
53. Register the instance's own iNat OAuth app with callback
`https://beeline.beeatlas.net/auth/inat/callback`.

```sh
fly apps create beeline --org osu-mm          # done
fly volumes create beeline_data --size 10 --region sea --app beeline
fly secrets set --app beeline \
  BEELINE_PRIVATE_DB_KEY="$(openssl rand -hex 32)" \
  INAT_CLIENT_ID=... INAT_CLIENT_SECRET=...
```

Keep a copy of the private-store key in your password manager before you set
it: Fly secrets are write-only, and losing the key is losing the private store
([ADR 0003](../adr/0003-private-data-store.md)).

Then deploy, and fill the volume. **Deploy into maintenance mode first.** An
app that boots against an empty volume has no store; the entrypoint refuses to
start rather than letting `openAppDb` create an empty one and crash-loop while
you upload 266 MB into the path it keeps re-creating — which would be two
writers on a half-written file (ADR 0005).

The store must be a **reseeded** one — check with `pnpm db:migrate --check`
first, because a store shaped before beeline-6e9 cannot be migrated forward
and will boot into 500s on every listing
([ADR 0006](../adr/0006-migrations-for-deployed-stores.md)).

```sh
fly deploy --env BEELINE_MAINTENANCE=1
fly ssh sftp shell --app beeline
#   put beeline.duckdb                       -> /app/data/beeline.duckdb
#   put data/corrections.csv                 -> /app/data/corrections.csv
#   put data/person-overlay.csv              (and person-change, sample-change,
#   put data/sample-state.csv                 sample-state — the five that a
#                                             rebuild cannot reconstruct)
#   put data/secrets/inat-oauth-token        -> /app/data/secrets/
fly machine update --env BEELINE_MAINTENANCE= <id>
```

`data/secrets/inat-oauth-token` is easy to forget and nothing fails until 2am:
the nightly mints its 24h JWT from it (`src/app/jobs/registry.ts`) and aborts
the whole run rather than syncing anonymously. It cannot be minted on the
machine — `pnpm inat:login` is a browser flow — so run that on a workstation
and upload the file, mode 600.

The DEM tiles are the exception: 4.6 GB across 213 files, from two public
datasets that want no credential. Fetch them **on the machine** rather than
uploading them — see below.

`private.duckdb` is not copied between hosts. The app creates it at first
boot; sessions and volunteer tokens are acceptable losses pre-cutover.

## Deploying a change

`fly deploy`. The machine is replaced in place: migrations run, then the app
starts. Downtime is one boot.

## Running a CLI against the store

The store is reachable only from inside the single machine that also runs the
app, and a stopped machine cannot be reached at all. Maintenance mode is where
you stand:

```sh
fly machine list --app beeline
fly machine update --env BEELINE_MAINTENANCE=1 <id>   # app down, volume mounted
fly ssh console --app beeline
  cd /app && pnpm db:reseed data/beeline.duckdb data/new.duckdb   # etc.
fly machine update --env BEELINE_MAINTENANCE= <id>    # back to serving
```

This is where `pnpm db:reseed`, `pnpm person:apply` and
`pnpm elevation:fetch` run. The re-derivation procedure itself — what to run
after a change under `ingest/`, and why re-fetching is not the fix — is
unchanged from [deploy-maderas.md](deploy-maderas.md#re-deriving-the-model-after-a-promotion-change);
only the way you get a shell has changed.

## The pre-migrate copy

When a boot finds pending migrations it copies the store to
`beeline.duckdb.pre-migrate` first, and on success rotates that to
`.pre-migrate.last`. An existing `.pre-migrate` is never overwritten: a
migration that fails part-way leaves the earlier ones committed and the
machine restart-looping, and a blind copy on the second boot would replace the
pristine store with the half-migrated one, seconds after the failure.

To restore one, boot into maintenance mode and move it back over
`beeline.duckdb` — **and delete any `beeline.duckdb.wal` beside it first**, or
DuckDB replays the newer WAL onto the older file.

## Backups

Fly's own advice is that an app should have two volumes and that snapshots are
not a primary backup. **We can take neither**: ADR 0005 and single-attach
volumes mean there is one copy of the store on one host's local disk, with a
daily block-level snapshot (`snapshot_retention = 14`).

Pre-cutover most of that is tolerable — `beeline.duckdb` is reconstructible by
re-ingestion. What is **not** reconstructible is `data/corrections.csv`,
`data/person-overlay.csv`, `data/person-change.csv`, `data/sample-change.csv`
and `data/sample-state.csv`: they sit outside the blow-away path precisely
because a rebuild must not lose them, and
[ADR 0007](../adr/0007-authored-changes-are-events.md)'s whole argument is
that a history a rebuild erases answers "who changed this" with "nobody, we
rebuilt it". A volume failure would answer it the same way. They total about
250 KB, so an off-host copy costs nothing — and it is a prerequisite for
trusting this hosting, not a phase-7 item.

## What stays on maderas

`pnpm legacy:fetch` pulls the Mongo export, the taxonomy CSV and the usernames
register from production over SSH (`beeline` in `~/.ssh/config`). A Fly machine
does not have that key and should not be given it. So legacy pull, load and
promote stay a maderas or workstation job, and the rebuilt store is shipped to
Fly. Fly hosts the app; maderas is where legacy ingestion runs.
