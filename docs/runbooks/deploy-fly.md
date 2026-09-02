# Deploy to Fly

Beeline runs on Fly as one app, one machine, one volume, in `sjc`. Tracked
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

Off-host first: the iNat OAuth app. There is one, called **Beeline**, and it
holds exactly **one** redirect URI — iNaturalist does not take a list, despite
Doorkeeper supporting them elsewhere. It currently reads
`https://beeline.fly.dev/auth/inat/callback`, which is why `BEELINE_ORIGIN` in
`fly.toml` is the `.fly.dev` hostname and not the eventual one. The two move
together or not at all: `BEELINE_ORIGIN` is concatenated into the
`redirect_uri` (`src/app/auth.tsx`), and iNat matches it exactly, on the token
exchange as well as the authorize redirect — so a mismatch fails *after* the
person has signed in and shows only the generic sign-in failure page.
`configFromEnv` refuses a non-bare origin at boot for the same reason.

DNS comes later, at cutover: `beeline.beeatlas.net` is CDK-managed in the
**beeatlas** repo — add records there and `cdk deploy`, never hand-edit Route
53 — and the OAuth app's redirect URI changes to match in the same sitting.

```sh
fly apps create beeline --org osu-mm          # done
fly volumes create beeline_data --size 10 --region sjc --app beeline
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

Two things about the **first** deploy that look like failures and are not, or
are not yours:

**Deploying into maintenance mode always "fails".** `fly deploy --env
BEELINE_MAINTENANCE=1` ends with `timeout reached waiting for health checks to
pass`, because the app deliberately is not listening. The machine and the
volume are created correctly regardless — check with `fly machine list` and
`fly logs` rather than believing the exit code.

**IP allocation can fail on a first deploy.** Ours did, with an internal error
(`org_slug is only supported with private_v6 type`), leaving the app with no
addresses and `beeline.fly.dev` unresolvable. `fly ips allocate-v6` and
`fly ips allocate-v4 --shared` fixed it in one go. Check `fly ips list` if the
hostname does not resolve.

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
rebuilt it". A volume failure would answer it the same way.

So those five are copied off the volume by
[`scripts/backup-authored-files.sh`](../../scripts/backup-authored-files.sh),
which pulls them over `fly ssh sftp`, checks each against a `sha256sum` taken
on the machine, and writes one gzipped tarball per run (~1.7 MB). A file that
does not transfer intact fails the whole run and writes nothing, because a
truncated backup is worse than a missing one — it looks like a backup.
`beeline.duckdb` is deliberately not included: at 211 MB it would turn a cheap
frequent job into an expensive occasional one, and unlike these it can be
re-derived by re-ingestion.

It **pulls** rather than pushes, so the Fly machine holds no credential and
cannot reach the backup host — a compromised app cannot touch the history.
The credential lives on the host that runs the job, and
`fly tokens create ssh --app beeline` scopes it to SSH on that one app:

**Give the token an expiry.** flyctl's default is `175200h` — twenty years —
which is not a credential anyone should leave on a cron host. The script
refuses to run without `FLY_API_TOKEN` rather than falling back to whatever
`fly auth login` left behind, because that fallback is very likely a personal
credential with rights over every app in the org, and an unattended job would
use it without anyone noticing. (`BEELINE_BACKUP_AMBIENT_AUTH=1` overrides
that for an interactive run.) The token is passed in the environment and never
as `--access-token`, which would put it in `ps` for every user on the host.

```sh
fly tokens create ssh --app beeline --expiry 2160h   # 90 days
```

Store it mode 600, and **`export` it** — cron sources the file and then runs
the script as a child, so a bare assignment would not reach it and the token
check would fail every night:

```sh
# ~/.config/beeline/backup-env   (chmod 600)
export FLY_API_TOKEN='FlyV1 fm2_...'
```

Then, on maderas, a little after the 02:00 nightly so each day's writes are
captured, and clear of the 03:00 beeatlas job:

```cron
MAILTO=you@example.com
30 2 * * *  . $HOME/.config/beeline/backup-env && $HOME/dev/beeline/scripts/backup-authored-files.sh >> $HOME/.local/state/beeline-backup.log
```

The redirect is what makes the mail worth reading: cron mails **captured
output**, not failing exit codes, and this script prints the archive path on
every successful run. Left alone it would mail nightly, which is how a person
learns to filter it, which is how the one night it mattered goes unread.
Sending stdout to a log leaves only stderr, and stderr means something went
wrong.

That still depends on the host having a working mail transport and a `MAILTO`
that reaches somebody — neither is a given. So the check that does not depend
on any of it is the age of the newest archive:

```sh
find ~/beeline-backups -name 'beeline-authored-*.tar.gz' -mtime -2 | head -1   # silence = stale
```

Diarised: the token expires after 90 days and the job starts failing when it
does, which is the shape to want — a credential that silently outlived its
purpose would be worse.

Restoring is `tar -xzf` and putting the files back under `/app/data` in
maintenance mode. Verify a backup by extracting it, not by trusting the run
that made it.

## What stays on maderas

`pnpm legacy:fetch` pulls the Mongo export, the taxonomy CSV and the usernames
register from production over SSH (`beeline` in `~/.ssh/config`). A Fly machine
does not have that key and should not be given it. So legacy pull, load and
promote stay a maderas or workstation job, and the rebuilt store is shipped to
Fly. Fly hosts the app; maderas is where legacy ingestion runs.
