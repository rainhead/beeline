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

`BEELINE_FEEDBACK_EMAIL` is optional: set, it puts a "Send feedback" email
link in every page's header, pre-filled with the page, time, browser and a
short hash of the session; unset, there is no link. It is a secret only so the
address stays out of this public repository.

`SENTRY_DSN` is optional too: set, the app reports errors, its console log and
each job run to Sentry (see [Errors, logs and job check-ins](#errors-logs-and-job-check-ins));
unset, it reports nothing and behaves exactly the same.

`ECDYSIS_USERNAME` and `ECDYSIS_PASSWORD` are the Ecdysis login the
`ecdysis-fetch` job signs in with ([Ecdysis](#ecdysis)); set both or neither,
since half a login stops the app at boot.

`BEELINE_DRIVE_KEY` is the service account's JSON key, whole, that the
`store-backup` job writes with ([Backups](#backups)); `BEELINE_BACKUP_FOLDER`,
in `fly.toml`, is the folder. Set both or neither, as with Ecdysis.

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
#   put data/person-overlay.csv              (and sample-overlay, person-change,
#   put data/sample-state.csv                 sample-change, sample-state — the
#                                             six that a rebuild cannot reconstruct)
#   put data/secrets/inat-oauth-token        -> /app/data/secrets/
fly machine update --env BEELINE_MAINTENANCE= <id>
```

`data/secrets/inat-oauth-token` is easy to forget and nothing fails until 2am:
the nightly mints its 24h JWT from it (`src/app/jobs/registry.ts`) and aborts
the whole run rather than syncing anonymously. It cannot be minted on the
machine — `pnpm inat:login` is a browser flow — so run that on a workstation
and upload the file, mode 600.

The DEM tiles are the exception: 1.7 GB across 123 files on the sandbox,
from two public datasets that want no credential. The nightly fetches the
ones it needs by itself, up to 25 a night (beeline-z08), so a new volume fills
over a few nights; to fill it at once, run `pnpm elevation:fetch` **on the
machine** rather than uploading them — see below.

`private.duckdb` is not copied between hosts. The app creates it at first
boot; sessions and sign-in records are acceptable losses pre-cutover. A
restore from a backup is the exception ([Backups](#backups)).

## Deploying a change

`fly deploy`. The machine is replaced in place: migrations run, then the app
starts. Downtime is one boot.

**A change to the curated person overlay is not live after a deploy.** The
app reads `ingest/person-overlay.csv` at boot only to guard the admin seed; it
applies nothing from it. Only a legacy promotion, `pnpm person:apply`, and the
People screen's own saves do. So a merged overlay row — a person created, an
account bound, an admin granted — changes nothing on a deployed store until it
is applied there, and a person who exists only in that file still cannot sign
in. After the deploy is healthy:

```sh
fly machine update --env BEELINE_MAINTENANCE=1 <id> --yes
fly ssh console --app beeline -C "sh -c 'cd /app && pnpm person:apply'"
fly machine update --env BEELINE_MAINTENANCE= <id> --yes
```

`person:apply` prints how many rows it applied and lists any it could not
resolve — a row naming a person the store does not hold, say. An unresolved
row is reported and skipped, not an error: it changes nothing, and since
applying is idempotent the fix is to correct the row and run it again. The
next boot then logs `recorded N person change(s) made while the app was
down`, which is the applied rows reaching the change log, attributed to the
pass rather than to a person. `N` counts what *changed*, not what was applied:
replaying a row the store already agrees with changes nothing, so on
2026-09-17 the whole overlay went on as 417 rows and the boot recorded 7, all
of them one new person.

**Maintenance mode answers the health check.** While the app is stopped, a
small responder (`src/app/maintenance.ts`) answers `/healthz` with 200 and
every other path with a 503 page saying Beeline is down for maintenance, and
never opens the store. So switching into the mode — `fly machine update` or
`fly deploy --env BEELINE_MAINTENANCE=1` — finishes in a boot, like any other
update. Until 2026-10-04 nothing listened: the update sat for five minutes on a
check nothing could pass, holding the machine's lease, so the update back out
had to wait for the lease to lapse, and a deploy into maintenance always
reported a timeout. If the responder itself ever fails to start, the entrypoint
says so in `fly logs` and holds the machine up anyway, since a shell is what
the mode is for; the check then fails as it used to, and the wait is back.

One thing about the **first** deploy that looks like a failure and is not
yours:

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

This is where `pnpm db:reseed`, `pnpm person:apply`,
`pnpm person:orcids`, `pnpm inat:fetch-orcids` and
`pnpm elevation:fetch` run. A list of confirmed ORCID iDs names people, so it
goes up with `fly ssh sftp put` into `data/` and never into git. The image
has `curl` and `jq` for asking iNaturalist or Ecdysis something with the
machine's own secrets, `unzip`, `ps`/`top`/`free` for watching a long run, and
`less`. It has no editor, and no `duckdb` command, which would have to stay
on the same version as `@duckdb/node-api` to be safe on the store. What to run
after a change under `ingest/`, and why re-fetching is not the fix, is
[below](#re-deriving-the-model-after-a-promotion-change).

The CLIs do not read `BEELINE_DB` for the store they open: `inat:sync` takes
`--db <path>`, and `inat:promote`, `inat:fetch-places` and `legacy:promote`
take it as their first positional argument, defaulting to `./beeline.duckdb` —
which on the machine is a store that does not exist and would be created empty.
Name `data/beeline.duckdb` every time. A promotion pointed at the live store
records into the change logs; pointed anywhere else it says so and records
nothing. Syncing one project by hand — the 2026-09-23 case was project 99706
after rainhead was made its manager, so that its obscured observations arrive
with their true coordinates — is:

```sh
wc -l data/sample-change.csv                    # before: expect hundreds to low thousands appended, never ~1M (beeline-hrw)
INAT_JWT=<minted> pnpm inat:sync 99706 --db data/beeline.duckdb   # the CLI reads INAT_JWT or data/secrets/inat-jwt; the machine
                                                                  # holds only the OAuth token — mint from it as mintJwt does (src/app/jobs/registry.ts)
pnpm inat:fetch-places data/beeline.duckdb
pnpm inat:promote data/beeline.duckdb
wc -l data/sample-change.csv
```

## Re-deriving the model after a promotion change

Migrations carry a change to the **schema**. They cannot carry a change to
**promotion**, the rules that derive the model from staged rows, so after one
the store is shaped right and derived wrong, and `pnpm db:migrate --check`
sees nothing, because no table has drifted. Check after any change under
`ingest/`. The same procedure is the answer to a schema change that cannot be
migrated at all, such as dropping a column from `person`, which nine tables
reference ([ADR 0006](../adr/0006-migrations-for-deployed-stores.md)).

Re-promoting is the fix and re-fetching is not, because the staged sources are
already in the store: `legacy_occurrence`, and the `observation_*` rows whose
presence proof deletion detection reads (beeline-3hj). `pnpm db:reseed` builds
a fresh store from `schema/*.sql` and carries exactly those across,
renumbered, with the tables promotion cannot recompute (`inat_place`, the
Ecdysis thesaurus). Then the promotions run over the new store.

Deploy the code first, since the reseed runs the new rules. Then, in
maintenance mode ([above](#running-a-cli-against-the-store)), write the steps
as a script in `data/`, named for the day, and run it with `nohup` so that a
dropped SSH session does not stop it, its log beside it:

```sh
nohup sh data/reseed-<date>.sh > data/reseed-<date>.log 2>&1 &
```

The script builds `data/beeline-new.duckdb` from the live store and never
writes the live one. The usual steps, in order: `pnpm db:reseed
data/beeline.duckdb data/beeline-new.duckdb`, `legacy:promote`,
`inat:fetch-places`, `inat:promote`, `inat:backfill-accounts`,
`elevation:derive`, then the loads a reseed does not carry —
`ecdysis:load data/ecdysis/44 <new> --prefix WSDA_` and `worksheets:load
data/worksheets <new>` — each naming `data/beeline-new.duckdb`, and finally
`chown -R node:node` over what it wrote, since the shell is root and the app
is not. Loading a new legacy pull adds `legacy:load` after the reseed
([Legacy pulls](#legacy-pulls)). The scripts already on the volume
(`data/reseed-*.sh`) are the worked examples, with the reasons for each step in
their comments; copy the latest.

**Leave `BEELINE_DB` set to the live store.** A change log belongs to one
store, and each promotion records into the change logs only when its target
is that store. Pointed at the half-built new one, every step would record its
intermediate state as changes nobody made, which on 2026-09-15 appended 70,380
false sample entries (beeline-6cr). Left alone, each step says it is not
recording, and the app's first boot on the new store records the net
difference once, as `reconcile`. Read the boot log for `recorded N sample
change(s) made while the app was down`: a large N is either the promotion
change that was the point of the rebuild, or a derivation that went wrong.

Once the counts look right, swap, keeping the old store until the app has been
checked against the new one:

```sh
ls data/beeline.duckdb.wal       # must not exist: a WAL left beside a store is replayed onto it
mv -f data/beeline.duckdb data/beeline-prev-<date>.duckdb
mv -f data/beeline-new.duckdb data/beeline.duckdb
```

Then leave maintenance mode. `private.duckdb` is untouched, and sessions
survive, since they are keyed by the iNaturalist user, not by the person
number a reseed redraws (beeline-ten). The overlays in `data/` replay onto the
new store during promotion, which is what they are for. Delete old
`beeline-prev-*` stores when the volume needs the room. Rehearse on a copy of
the store first when the change is large: comparing the two side by side is
how 1,019 new findings turned out to be the sandbox catching up rather than a
regression.

## Admitting a person who has no records

Promotion makes people from the records, so somebody who collects nothing,
such as an intern or a coordinator, is in no store and cannot sign in: what
lets a person in is an iNaturalist account bound to a person. The unknown
collectors' screen admits only somebody with records (beeline-2c3.33), so
this goes through
[`ingest/person-overlay.csv`](../../ingest/person-overlay.csv): `create` first,
then the account and whatever else is true of them.

```csv
name:Nora Jacobi,create,yes,rainhead,"why they belong in the store"
name:Nora Jacobi,inat_user_id,10206031 njacobi,rainhead,"verified against the iNat API"
name:Nora Jacobi,admin,yes,rainhead,"why"
```

Check the iNaturalist id first (`curl -s https://api.inaturalist.org/v1/users/<login>`),
because the id is the binding and a lookalike account has survived review
before. Deploy, then run `pnpm person:apply` in maintenance mode. It prints
what it applied and every row it could not resolve, it is idempotent, and the
same rows rebuild the person after the next reseed.

## The taxonomy's reference

The curated taxonomy is matched against the taxonomic thesaurus of Ecdysis
(beeline-7gob): `ecdysis_taxon` holds every insect name Ecdysis has at the
ranks the tree admits, and `animal.ecdysis_tid` is read against it. The
machine fetches it itself — Symbiota exports it without a sign-in, about three
minutes of requests and a 72 MB CSV in `/app/data/ecdysis-taxonomy/` — so
fetch while the app runs and stop it only for the load, which writes the store:

```sh
fly ssh console --app beeline -C "sh -c 'cd /app && pnpm ecdysis:taxonomy --fetch-only'"
fly machine update --env BEELINE_MAINTENANCE=1 <id>    # the load writes the store
fly ssh console --app beeline -C "sh -c 'cd /app && pnpm ecdysis:taxonomy --cached'"
fly machine update --env BEELINE_MAINTENANCE= <id>
```

`--cached` loads the last fetch into the machine's `BEELINE_DB`, replaces the
table and re-matches every node in one transaction, in about three seconds,
and refuses a fetch with no name at a rank the tree admits. A reseed carries
the table and legacy promotion re-matches the tree it rebuilds, so this is
needed only when Ecdysis's names should be read again — they change name by
name, with no releases. Until it has run, `animal_ecdysis` answers
`not loaded` for every node. A store migrated past 0058 keeps the old
`animal.itis_tsn` column, unread, until its next reseed.

## The gazetteer

The nightly names each sample's locality from its coordinates, out of a
gazetteer of public place names and outlines
([Localities from coordinates](../architecture/localities-from-coordinates.md),
beeline-7i6). Unlike the DEM tiles, the machine cannot fetch it itself: it is
built from about 2 GB of downloads, most of them OpenStreetMap extracts. So
build it on a workstation and put the file up. It is read only while the
nightly's "name localities" step runs, so it can be replaced while the app
serves; put it beside its place and move it in, so no run ever opens half a
file:

```sh
pnpm locality:fetch                      # once; later runs keep what is there
pnpm locality:gazetteer                  # about a minute → data/gazetteer.duckdb
fly ssh sftp shell --app beeline
#   put data/gazetteer.duckdb  -> /app/data/gazetteer.duckdb.new
fly ssh console --app beeline -C "mv -f /app/data/gazetteer.duckdb.new /app/data/gazetteer.duckdb"
```

Each build has its own id, so the next nightly names every sample again,
about 70,000 on the sandbox. Until a gazetteer is there, the nightly's detail
reads "localities: no gazetteer on this machine" and nothing else changes. To
see the names straight away, run `pnpm locality:derive data/beeline.duckdb`
in maintenance mode, as for any CLI that writes the store. Rebuild when a
source changes enough to matter: a new Census vintage, BC's boundaries, a
refuge added. Delete the files in `data/gazetteer-sources/` to fetch them
again.

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

## Errors, logs and job check-ins

With `SENTRY_DSN` set ([`src/app/error-reporting.ts`](../../src/app/error-reporting.ts),
beeline-8w6.1), the app sends Sentry five things, tagged with `BEELINE_ENV` as
the environment and the Fly deployment as the release:

- **Errors.** A request that fails with a 500 is reported with its route
  pattern (`GET /samples/:id`, never the id), the signed-in iNaturalist
  login, and a `reference` tag; a failed job is reported with the job's name.
  The reference is the eight hex digits the person's error page shows and
  their feedback email carries ("Error reference: …"): search Sentry for
  `reference:<it>`, or `fly logs` for `[<it>]`, which ends the failure's log
  line.
- **The console log.** Every `console.log`, `warn` and `error`, searchable,
  and kept past the rolling window `fly logs` shows — which is where the boot
  pass's `recorded N sample change(s)` line lives.
- **Listing usage.** Each request to `/samples`, `/specimens` or `/people`,
  page or CSV, is counted as the metric `listing.view` with the scope, sort,
  page band and the filters in use as attributes — which filters, never what
  was typed in them — and whether the viewer was staff, a volunteer, or staff
  impersonating one. Query it in Sentry's metrics explorer, grouped by
  `filters` or `sort`.
- **Request durations.** Every request records the metric `request.duration`
  in milliseconds ([`src/app/request-timing.ts`](../../src/app/request-timing.ts)),
  with the route pattern, method and status as attributes: a route's p95 over
  time is a query grouped by `route`, and a Sentry alert on it is how a page
  getting slower gets noticed. A request over a second also logs
  `[request] slow: GET /samples/:id took 2345ms (status 200, signed in as …)`,
  so search the log for `[request] slow` to see which pages and whose. It is
  the time to a response; a listing's CSV fetches its rows after that, as the
  client reads, so that time is its own metric, `csv.generation` — the time
  its pages spent in the store, by listing and by whether the download
  completed, failed or was abandoned — with its own slow line past a second.
  It leaves out the client's connection, so a slow download over a slow link
  is not a slow server.
- **Job check-ins.** Every job sends its runs as check-ins to a cron monitor
  named after it, which Sentry creates on the first run from the schedule the
  scheduler already uses. **Only `nightly-pipeline`'s is active**: Sentry's
  free plan includes [one cron monitor](https://docs.sentry.io/pricing/quotas/manage-cron-monitors/),
  and more need a pay-as-you-go budget, so when the organisation's trial of
  the Business plan ended on 2026-10-12 Sentry disabled the other eight, and
  it drops their check-ins. So Sentry says when the nightly fails
  or has not started by the end of the night window, and about any other job
  only through the error a failed run reports and through the uptime monitor
  below. Which monitor holds the one slot is set on Sentry's Crons page.

A Sentry uptime monitor polls [`/healthz/jobs`](#knowing-the-nightly-is-running)
every five minutes and alerts after two failures in a row. It is the plan's
one uptime monitor, which is why it watches `/healthz/jobs` rather than
`/healthz`: `/healthz/jobs` reads the store, so it fails when the app is down
or the store cannot be read as well as when a job is failing or overdue,
while Fly already restarts the machine on `/healthz` itself. A monitor alerts
only through an alert it is connected to, and until 2026-10-24 neither was, so
neither had ever told anybody anything. Both are now connected to the alert
"Monitors: the sandbox or its jobs are down, or the nightly failed", which
emails Peter when a monitor's issue first appears, comes back after being
resolved, or recurs. A new monitor needs connecting to it too. Tested on
2026-10-24 by pointing the monitor at an address that answers 401: the email
arrived within a minute of the second failed check, once Peter had turned on
alert emails in his own Sentry notification settings, which were off and
which an alert's own settings do not override (beeline-997i). Anyone else to
be told needs the same setting, and adding to the alert's actions. All of this
lives in Sentry's settings, not in this repo.

**What never leaves the machine.** An error from DuckDB quotes the value it
choked on, and a stack frame's locals hold the row being read. So the SDK
collects no request body, query string, cookie, header other than the user
agent, database parameter or local variable. Every message that does go —
exception text, log line, breadcrumb — is passed through `redact` first:
anything quoted, any decimal with four or more places (every coordinate this
store holds), tokens, and email addresses are replaced. Log a message as a
string, not as an object: the log integration serialises an object as JSON,
whose every key is quoted and so redacted into nothing.

## The machine's budget

The machine is `shared-cpu-2x`, 3 GB with 1 GB of swap (2 GB until
2026-10-04, beeline-1w2d), and a volume Fly grows by 5 GB at 80% full — 10 GB
until a failed reseed filled it on 2026-10-04, 15 GB since ([`fly.toml`](../../fly.toml)). What it actually used,
2026-09-12 to 10-01 from Fly's own metrics: a normal day ~0.003 cores and
0.5–0.65 GB of memory, no swap, ~2.4 GB on the volume, no OOM kills. The one
limit it reaches is the **CPU burst balance**: a shared vCPU may run above its
baseline only while the balance lasts, and a reseed or a large manual load
empties it and is held to the baseline for the rest of the run — 15–40
minutes on each of the three days it happened, and most likely why the
2026-10-01 reseed took 38 minutes where the 09-28 one took 23. Memory peaked
at 1.4 GB during those runs.

The `resource-budget` job reads the last 24 hours at 4am Pacific
([`src/fly-usage.ts`](../../src/fly-usage.ts)) and **fails** when a limit in
`BUDGET` was crossed — memory past 85%, swap past 256 MB, any OOM kill, the
volume past 70% (short of the 80% that costs money), or the burst balance empty
for an hour — so `/healthz/jobs` and its Sentry check-in say so. Otherwise its
`job_run.detail` on `/jobs` is the day's numbers. A day with one reseed in it
stays green; a machine throttled every night does not.

It reads Fly's Prometheus store with a read-only org token held as the
`FLY_METRICS_TOKEN` secret; the app name comes from `FLY_APP_NAME`, which Fly
sets. An expired token fails the job with `Fly metrics answered 401`. To mint
or rotate it, and to measure by hand:

```sh
fly tokens create readonly osu-mm --name "beeline resource-budget job" --expiry 8760h
fly secrets set --app beeline FLY_METRICS_TOKEN='FlyV1 …'      # restarts the machine
FLY_METRICS_TOKEN="$(fly tokens create readonly osu-mm --expiry 1h)" pnpm fly:usage 168
```

Read `fly_instance_cpu` as clock ticks, a hundredth of a second, not seconds:
it matches the machine's `/proc/stat` tick for tick, and read as seconds it
says the machine is a hundred times busier than it is.

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

Sentry's uptime monitor polls it every five minutes and alerts after two
failures in a row ([above](#errors-logs-and-job-check-ins)), so a silent stall
reaches somebody. It replaced a cron
line on maderas that polled every twenty minutes until 2026-10-24
(beeline-htcw.1), whose mail went to a mailbox on maderas that nobody read:
the polls that failed, `legacy-export` on every one from 5 to 8 October
among them, were all found there unread that day. The monitor has response capture
turned on, so Sentry keeps a failed check's response, whose lines name the
jobs; `/healthz/jobs` itself says the same thing to anyone who asks. A job that keeps failing keeps the endpoint at 503 until its next
success, which for a nightly job is a day, and that is one issue, not one per
check.

The response says which job and what kind of wrong — `failing`, `overdue`,
`never-run` — and deliberately not why. `job_run.detail` holds whatever a
caught error said, and those come from DuckDB, the filesystem and the iNat
API; a constraint violation quotes the offending value, so a failure in person
promotion would put a volunteer's name on an endpoint anybody can read. The
reason is on `/jobs`, behind the admin gate, which is where this sends you.

This exists because the nightly failed on every run for about half a day and
nothing said so (beeline-6td): `job_run` recorded it and `/jobs` displayed it,
to an admin who went looking. It was found by accident.

## Ecdysis

The `ecdysis-fetch` job brings back determinations made in Ecdysis at 3am
Pacific, between the nightly sync and the legacy export (beeline-9ut.1). It
asks Ecdysis's public API whether Washington's dataset has changed since the
last download, signs in and downloads the archive (about two minutes for
Ecdysis to build) only if it has, and otherwise reloads the archive it kept.
The loader is idempotent, so a reload records nothing on an ordinary night,
and after a reseed — which drops every Ecdysis determination — it puts them
back by the next morning. The archive and the probe's baseline live in
`data/ecdysis/` (config `ecdysisDir`, `BEELINE_ECDYSIS`) as `44.zip` and
`44.probe.json`; deleting the baseline forces the next run to download. The
run's detail on `/jobs` says what it did and why, and names any names it
adopted from Ecdysis's thesaurus or could not place. Without the login (above) the job
reports that it has nothing to fetch.

## The legacy-format export

The `legacy-export` job writes every specimen as the legacy system's
occurrences file at 4am Pacific, to `data/exports/occurrences.csv` (config
`exportsDir`, `BEELINE_EXPORTS`), and admins download it from `/exports`
(beeline-6q8). It is regenerable, so the backup below leaves it out. To write
it now, press Run now on `legacy-export` at `/jobs`. It runs on one thread
whoever starts it, the job or `pnpm legacy:export`: on two it needs 1,150 MB
of the 1.5 GB DuckDB is given here, where one needs 830 MB (beeline-1w2d). It
sorts its rows only after writing them to a temporary table, because sorting
them straight out of the joins failed at 1.5 GB while fitting in 1 GB — more
memory did not cure it, and it failed every night from 5 to 7 October; a
"failed to pin block" from this job is that, not a budget to raise. To check how close it is
to what the legacy system held, run `pnpm legacy:compare-export` against a
copy of the store — it needs the staged legacy records, which a reseeded
store carries. It lists every kind of difference with how many records it touches and a few
examples, and says which of them
[`ingest/legacy-export-rulings.csv`](../../ingest/legacy-export-rulings.csv)
explains and which nobody has.

## Backups

Fly's own advice is that an app should have two volumes and that snapshots are
not a primary backup. **We can take neither**: ADR 0005 and single-attach
volumes mean there is one copy of the store on one host's local disk, with a
daily block-level snapshot (`snapshot_retention = 14`). From cutover the store
holds what exists nowhere else — the numbers printed on pins, print runs,
determinations entered in the app, staff decisions — so the backup is a copy
somewhere else, every night, that has been shown to restore.

### The nightly copy on the OSU shared drive

The `store-backup` job ([`src/store-backup.ts`](../../src/store-backup.ts),
beeline-elf, [#126](https://github.com/rainhead/beeline/issues/126)) runs at
3am Pacific, after the night's determinations and promotion (and ahead of the
Sunday sweep and the Ecdysis fetch, so neither can push it past the 5am end of
the night window; what Ecdysis sends back is in the next night's copy), and
puts one file, `beeline-backup-<UTC instant>.tar.gz`, in the
`databaseBackups` folder inside Bee Line on the OSU shared drive
(`BEELINE_BACKUP_FOLDER` in [`fly.toml`](../../fly.toml)). It is for recovery
only: nobody opens these. **The main store's copy is not encrypted**, so every
member of the drive can read the whole store, the true coordinates of obscured
observations and every volunteer's name included. That is a decision, not an
oversight: the drive's members are the staff already trusted with the store
(Andony, 2026-09-11, beeline-elf). Encrypting it too would take one argument
to the copy, if that ever changes. Inside:

- `beeline.duckdb` and `private.duckdb` — consistent copies of both stores,
  taken inside the app because nothing else may open them (ADR 0005). Each is
  an ordinary store the app opens as it is. The private one is encrypted with
  `BEELINE_PRIVATE_DB_KEY`, the same key the running store uses
  ([ADR 0003](../adr/0003-private-data-store.md)), so **a backup of it is only
  as recoverable as that key**: copies are kept off the server, in Peter's
  password manager and (beeline-yml3) Andony's.
- `authored/` — the overlays and change logs a rebuild cannot reconstruct.
- `manifest.json` — what each store held, table by table and in the rest of
  its schema, the DuckDB version that wrote the copies, and the SHA-256 of
  every file.

Why the copy is made the way it is — DuckDB's one-line `COPY FROM DATABASE`
cannot copy this schema — is in
[`src/store-snapshot.ts`](../../src/store-snapshot.ts).

**Each step is checked rather than trusted.** The copies are reopened on an
instance of their own, and their rows, constraints, indexes, views, macros,
sequences and comments counted against the store's, so a DuckDB upgrade that
stops carrying any of them fails the night it is deployed. The size and MD5
that Drive computed from what it stored must match the file sent; an upload
that does not is moved to the bin before the run fails, so it can never become
a month's kept copy. Only then are old copies moved
to the drive's bin, which empties itself after 30 days: every night's copy is
kept for two weeks, and the first copy of each month for a year (Peter,
2026-10-12). A shared drive's Content manager cannot delete outright, which is
why it is the bin. Anything that fails, fails the run, so a missing backup
shows on `/jobs` and on `/healthz/jobs`, which Sentry polls, with the step
that failed named in the run's detail. Its own Sentry cron monitor is one of
the eight the plan keeps disabled.
Outside development it also fails rather than succeeding at nothing when the
folder or the Drive key is not set, and rather than upload the private store
unencrypted when the store's key is not. A run killed partway, by memory or a
restart, leaves its work directory under `data/backups/`; the next run
removes it and says so.

The writer is a service account,
`beeline-production@beeline-510517.iam.gserviceaccount.com`, whose JSON key is
the secret `BEELINE_DRIVE_KEY`. It holds the `drive.file` scope, so it sees
only the files it made: a key that leaked reaches the backups, which are the
whole store, and nothing else on the drive. The Cloud project that owns it,
`beeline-510517`, is under Peter's account with Nora as a second owner; moving
it under OSU's Google organisation is to come.

**Rotate the key, never the account.** Because the scope is `drive.file`, a
new service account cannot see the old one's files: it would never move them
to the bin, and the year of monthly copies would start again from nothing. So
a new key is made for the same account
(`gcloud iam service-accounts keys create … --iam-account beeline-production@beeline-510517.iam.gserviceaccount.com`),
set with `fly secrets set BEELINE_DRIVE_KEY=…`, and the old key deleted once
a night's run has succeeded with the new one.

### Restoring, and the drill

Download the copy from the folder (any member of the drive can), then check
it before trusting it:

```sh
BEELINE_PRIVATE_DB_KEY=… pnpm backup:check ~/Downloads/beeline-backup-….tar.gz [dir]
```

It extracts the archive with the system's tar, checks every file against the
manifest, and opens and counts both stores; without the key it says the
private store was **not** checked rather than passing it. What it leaves in
`dir` is what a restore puts back. Unlike a first install, the private store
**is** restored: from cutover it holds what volunteers cannot simply redo.

1. `fly deploy --env BEELINE_MAINTENANCE=1`, so nothing holds the store.
2. On the volume, **delete `beeline.duckdb.wal` and `private.duckdb.wal`** if
   they exist. A WAL left beside an older store is replayed onto it, as with
   [the pre-migrate copy](#the-pre-migrate-copy).
3. `fly ssh sftp shell`, and `put` the two stores to `/app/data/beeline.duckdb`
   and `/app/data/private.duckdb`, and each `authored/*.csv` to `/app/data/`.
4. On a new volume, also what the archive does not hold: the pipeline's
   `data/secrets/inat-oauth-token` ([One-time setup](#one-time-setup)), and
   the DEM tiles, which the nightly fetches again by itself, 25 a night, or
   `pnpm elevation:fetch` on the machine at once. Ecdysis's archive and
   the print runs' sheets come back by themselves: the first is fetched
   again, the second re-rendered from the store.
5. `fly machine update --env BEELINE_MAINTENANCE= <id>`. Boot applies any
   migration newer than the copy, as it does for every deploy.

**`store-backup` then reads as failing on `/jobs` and `/healthz/jobs`, and
that is expected.** The copy was taken while that run was in progress, so the
restored store holds it unfinished, and boot marks every unfinished run
failed as "orphaned". It clears with the next backup, which can be run from
`/jobs` straight away; the restored store is a good reason to.

The drill is to download a real copy, `backup:check` it, and start a scratch
app against what it extracted. Point every path the app writes — the stores,
`BEELINE_CORRECTIONS`, both overlays, `BEELINE_SAMPLE_CHANGES`,
`BEELINE_SAMPLE_STATE`, `BEELINE_PERSON_CHANGES` — at a copy, never at
`data/`, and give it `BEELINE_DEV_LOGIN` and placeholder
`INAT_CLIENT_ID`/`INAT_CLIENT_SECRET`, since it signs nobody in. Run it once
before cutover, not after something has gone wrong. **First run, 2026-10-12**
(beeline-elf): the sandbox's first copy, downloaded by a member of the drive,
passed `backup:check` with both stores opened, and the scratch app served
every main page from it, the orphaned run above included.

### The pull from maderas, retired

Before the nightly copy existed, maderas pulled the authored files alone off
the volume every night. That pull stopped on 2026-10-24, after twelve nights
of Drive copies without a miss and a passed drill (beeline-elf), and its
scripts are in git history before that date.

## Legacy pulls

`pnpm legacy:fetch` pulls the Mongo export, the taxonomy CSV and the usernames
register from the legacy production host over SSH, as `beeline` in
`~/.ssh/config`. The Fly machine does not hold that key and must not be given
it, so the pull is made on Peter's workstation (`desktop-wsl`), whose key the
production host accepts, and the files are uploaded to the volume. Legacy
pulls end at cutover, when the legacy system freezes.

```sh
pnpm legacy:fetch                          # data/legacy/: occurrences.jsonl.gz, taxonomy.csv, usernames.csv
fly ssh sftp shell --app beeline
  mkdir /app/data/legacy-<date>
  put data/legacy/occurrences.jsonl.gz /app/data/legacy-<date>/occurrences.jsonl.gz
  put data/legacy/taxonomy.csv /app/data/legacy-<date>/taxonomy.csv
  put data/legacy/usernames.csv /app/data/legacy-<date>/usernames.csv
```

Then rebuild from it as in
[re-deriving the model](#re-deriving-the-model-after-a-promotion-change), with
two more steps in the script: copy the two CSVs into `data/legacy/` before the
reseed, and load the pull into the new store with `pnpm legacy:load <new>
data/legacy-<date>/occurrences.jsonl.gz` straight after it.
`data/reseed-2026-10-24b.sh` on the volume did exactly this.
