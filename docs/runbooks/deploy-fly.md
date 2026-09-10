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

**Shutdown settles the running job before it closes the store** (beeline-fth).
On `SIGTERM` the app stops listening, gives whatever job is running a minute to
finish on its own, and past that interrupts it: the job's next step refuses,
the sync's paging loop stops at its next request, and a DuckDB query in flight
is cancelled so its transaction rolls back. The failure is recorded in
`job_run` like any other and the daily schedule retries it after its usual
pause. Only then is the store checkpointed — both catalogs, explicitly, with a
failure said out loud — and closed, and the close is reached whatever happened
before it. The whole thing fits inside the 120s `kill_timeout` with room to
spare, which is the point: host maintenance restarts a machine with little
warning and can land inside the 2am window, and the version that closed a busy
connection from an async callback could lose the checkpoint to an unhandled
rejection. A second signal is not handled: Node's default takes over and the
process dies on the spot, which is the escape hatch and exactly the unclean
exit the first signal avoids.

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

## Knowing the nightly is running

`/healthz` proves the store is readable, and Fly restarts the machine when it
fails — which is why job staleness is **not** on it. Restarting is the wrong
answer to a job that failed, and on a bad night it would loop.

`/healthz/jobs` is the one to poll: `ok` when every registered job is healthy,
503 with a line per problem otherwise. It distinguishes `failing` (the last run
happened and did not work — no waiting period, this is true now), `overdue`
(nothing has succeeded in two full periods, so the scheduler or the machine is
the suspect) and `never-run` (registered but never scheduled, which is a
half-finished deployment rather than a breakage). Unauthenticated: job names
are already public in this repo and no record data passes through it.

Polled from maderas beside the backup, so a silent stall reaches somebody:

```cron
*/20 * * * * out=$(curl -sS --fail-with-body --connect-timeout 10 --max-time 30 https://beeline.fly.dev/healthz/jobs) || echo "$out"
```

`echo`, not `printf "%s\n"`: in a crontab a `%` is a newline and what follows it
is stdin, so the `printf` version ran as an unterminated string and never
polled anything. It mailed a shell syntax error to a local mailbox every
twenty minutes for a week — 1,400 of them — which is a second way for the
one alarm that mattered to go unread (beeline-vl4).

`--fail-with-body` rather than `-f`, because plain `-f` throws the body away
and the body is the whole message — you would be mailed that something failed
without being told which job. The timeouts bound the poll: without them a
stalled connection leaves `curl` running until something else kills it, and at
three runs an hour those accumulate.

The capture is what makes the mail worth reading. The endpoint prints `ok` on
success, and cron mails anything a job writes to stdout — so the obvious
version of this line mails `ok` every twenty minutes, which is how somebody
learns to filter it, which is how the one that mattered goes unread. Holding
the body in a variable and printing it only when `curl` exits non-zero means
**silence is the healthy state**. Errors curl writes to stderr — a refused
connection, a DNS failure, a timeout — are mailed either way, which is right:
being unable to ask is also an answer.

The response says which job and what kind of wrong — `failing`, `overdue`,
`never-run` — and deliberately not why. `job_run.detail` holds whatever a
caught error said, and those come from DuckDB, the filesystem and the iNat
API; a constraint violation quotes the offending value, so a failure in person
promotion would put a volunteer's name on an endpoint anybody can read. The
reason is on `/jobs`, behind the admin gate, which is where this sends you.

This exists because the nightly failed on every run for about half a day and
nothing said so (beeline-6td): `job_run` recorded it and `/jobs` displayed it,
to an admin who went looking. It was found by accident.

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
fly tokens create ssh --app beeline --expiry 4320h   # 180 days
```

**Pick the expiry by where it lands, not by how long it is.** The first token
was minted for 90 days on 2 September 2026 and so expired on 1 December —
cutover month, the weeks the backup first genuinely matters and everyone is
looking elsewhere (beeline-vl4). A rotation is routine only when it falls in a
quiet month; check the [roadmap](../roadmap.md) before choosing.

Store it mode 600, **`export` it** — cron sources the file and then runs the
script as a child, so a bare assignment would not reach it and the token check
would fail every night — and **write the expiry down beside it**. Fly does not
tell a scoped token when it ends, and the night it does the run fails with an
authentication error that says nothing about why; with the date recorded the
script warns to stderr from two weeks out, which cron mails, and names the
date when the run does fail:

```sh
# ~/.config/beeline/backup-env   (chmod 600)
export FLY_API_TOKEN='FlyV1 fm2_...'
export BEELINE_FLY_TOKEN_EXPIRES=2027-03-09   # from `fly tokens create --expiry`
```

Then, on maderas, a little after the 02:00 nightly so each day's writes are
captured, and clear of the 03:00 beeatlas job:

```cron
MAILTO=you@example.com
30 2 * * *  mkdir -p $HOME/.local/state && . $HOME/.config/beeline/backup-env && $HOME/dev/beeline/scripts/backup-authored-files.sh >> $HOME/.local/state/beeline-backup.log
```

The `mkdir` is not decoration. The shell opens the redirect *before* it runs
the script, so a missing `~/.local/state` — hardly guaranteed on an older
account — means the backup never runs at all, every night, and what arrives is
a redirection error rather than anything about backups.

The redirect is what makes the mail worth reading: cron mails **captured
output**, not failing exit codes, and this script prints the archive path on
every successful run. Left alone it would mail nightly, which is how a person
learns to filter it, which is how the one night it mattered goes unread.
Sending stdout to a log leaves only stderr, and stderr means something went
wrong.

The backup cannot report that it did not run, and an expired token, a missing
`flyctl`, a full disk and a host that was down at 02:30 all look the same from
outside: the archive that should be there is not. So a second cron line asks
the question the runbook used to leave to a person —
[`scripts/check-backup-age.sh`](../../scripts/check-backup-age.sh) prints
nothing while the newest archive is under two days old, reads as an archive,
and holds all five files, and speaks only when one of those is false. Two
days, so a single missed night is not an alarm and two in a row is:

```cron
0 9 * * *  $HOME/dev/beeline/scripts/check-backup-age.sh
```

All three lines — the backup, the `/healthz/jobs` poll and this — reach a
person only through cron's mail, so they depend on the host having a working
transport and a `MAILTO` that goes somewhere. maderas runs exim4 and delivers
off-host; the `MAILTO` is the part to check, since without it everything lands
in a local mailbox nobody opens. When any of this has to be done by hand, the
check is still the same one the script runs:

```sh
find ~/beeline-backups -name 'beeline-authored-*.tar.gz' -mtime -2 | head -1   # silence = stale
```

Restoring is `tar -xzf` and putting the files back under `/app/data` in
maintenance mode. Verify a backup by extracting it, not by trusting the run
that made it.

## What stays on maderas

`pnpm legacy:fetch` pulls the Mongo export, the taxonomy CSV and the usernames
register from production over SSH (`beeline` in `~/.ssh/config`). A Fly machine
does not have that key and should not be given it. So legacy pull, load and
promote stay a maderas or workstation job, and the rebuilt store is shipped to
Fly. Fly hosts the app; maderas is where legacy ingestion runs.
