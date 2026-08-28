# Deploy the sandbox to maderas (temporary hosting)

Beeline's sandbox runs on maderas at **https://beeline.beeatlas.net** as a
user systemd service behind an Apache `ProxyPass` vhost with certbot TLS —
the `beeatlas-api` pattern. **This hosting is temporary** (decided
2026-08-22): production hosting is re-decided at cutover with Andony.

Tracked config: [`infra/maderas/`](../../infra/maderas/) — the vhost, the
unit, and the env template. The app listens on 3054 (`0xBEE`); Apache owns
80/443.

One process, ever: the service owns `beeline.duckdb` (ADR 0005). Anything
else that wants the database (a CLI run, a rebuild, a migration) must stop the
service first — which is why deploying is a script
([`scripts/deploy-maderas.sh`](../../scripts/deploy-maderas.sh)) rather than a
restart.

## One-time setup

### 0. Prerequisites, off-host

- **DNS**: `beeline.beeatlas.net` A/AAAA → maderas (45.79.96.48 + its
  Linode IPv6). The `beeatlas.net` zone is CDK-managed in the **beeatlas**
  repo — add the records there and `cdk deploy`; never hand-edit Route 53.
- **OAuth**: register the sandbox's own iNat app (the dev app's single
  callback slot is localhost) at inaturalist.org/oauth/applications, callback
  `https://beeline.beeatlas.net/auth/inat/callback`. Owner: Peter, per the
  standing token policy (production later gets its own under Andony,
  beeline-5ep).

### 1. Code and runtime (on maderas, no sudo)

```sh
git clone https://github.com/rainhead/beeline.git ~/dev/beeline
cd ~/dev/beeline
nvm install            # .nvmrc; install nvm/corepack first if absent
corepack enable && pnpm install
pnpm app:build         # islands + manifest into dist/app
```

### 2. Secrets

```sh
mkdir -p ~/.config/beeline
cp infra/maderas/env.example ~/.config/beeline/env
chmod 600 ~/.config/beeline/env
# fill in: BEELINE_PRIVATE_DB_KEY (openssl rand -hex 32 — losing it is
# losing the private store; keep a copy in your password manager),
# INAT_CLIENT_ID/SECRET from step 0.
```

The nightly sync additionally reads the pipeline access token from
`data/secrets/inat-oauth-token` (see AGENTS.md; run `pnpm inat:login` from a
workstation and copy the file, mode 600).

### 3. Database

Blow-away era: build wherever it's convenient and copy, or build in place.
The service must not be running (single writer).

```sh
# either: build+ingest locally, then
scp beeline.duckdb maderas:dev/beeline/
# or in place: pnpm db:build && pnpm legacy:fetch && pnpm legacy:load && pnpm legacy:promote ...
```

The encrypted `private.duckdb` is created by the app at first boot; it holds
sessions and volunteer OAuth tokens and should not be copied between hosts.

### 4. Service

```sh
mkdir -p ~/.config/systemd/user
cp infra/maderas/beeline.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now beeline
loginctl enable-linger "$USER"     # keep user services alive after logout
curl -s http://127.0.0.1:3054/healthz   # → ok
```

### 5. Apache + TLS (sudo)

```sh
sudo cp ~/dev/beeline/infra/maderas/beeline.beeatlas.net.conf /etc/apache2/sites-available/
sudo a2ensite beeline.beeatlas.net
sudo apachectl configtest && sudo systemctl reload apache2
# after DNS resolves to maderas:
sudo certbot --apache -d beeline.beeatlas.net
```

### 6. Verify

```sh
curl -sI http://beeline.beeatlas.net/healthz | head -1      # 301 → https (once the cert exists)
curl -sI https://beeline.beeatlas.net/healthz | head -1     # 200
curl -s  https://beeline.beeatlas.net/ | grep -o 'Sign in with iNaturalist'
# sign in from a browser: a known member lands on their QC list;
# /jobs shows session-purge succeeding and nightly-pipeline registered.
```

The banner will read "sandbox instance" (BEELINE_ENV=sandbox).

## Deploying a change

```sh
scripts/deploy-maderas.sh          # from a workstation checkout; host defaults to maderas
```

That is: pull `origin/main`, install, build the islands, **stop the service,
`pnpm db:migrate`, start it again**, then wait for
`https://beeline.beeatlas.net/healthz`. The stop is not incidental — one
process owns `beeline.duckdb` (ADR 0005), so the file is only free to migrate
while the app is down. Brief downtime is by design.

Schema changes reach this store as migrations ([ADR
0006](../adr/0006-migrations-for-deployed-stores.md)): write the change in
`schema/`, copy the delta to `migrations/NNNN-slug.sql`, and the deploy
applies it. `pnpm db:migrate --check` (service stopped) reports where the
store has drifted from `schema/*.sql`, which is how a forgotten migration
shows up. The tool `CHECKPOINT`s after every run, which matters: DuckDB
≤1.5.5 fails WAL replay of an ALTER on a table with function/sequence
defaults with an INTERNAL error, leaving the file unopenable until the WAL is
deleted — so **any hand-written DDL must end with an explicit `CHECKPOINT`
before closing**. Known upstream (duckdb/duckdb#18259, fixed on main by
#21516); the fix is confirmed in 1.6.0 nightlies, so this rule can be dropped
once we upgrade past 1.5.x (beeline-c1b).

By hand, if the script isn't available — nvm isn't loaded in a
non-interactive shell, so `node` is missing from PATH:

```sh
ssh maderas 'export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; cd ~/dev/beeline && nvm use >/dev/null && git pull && pnpm install && pnpm app:build && systemctl --user stop beeline && pnpm db:migrate && systemctl --user start beeline'
```

## Re-deriving the model after a promotion change

(Also the answer when a schema change cannot be migrated at all — dropping a
column from `person` is refused by DuckDB whatever order the statements are
in, because nine tables reference it. [ADR 0006](../adr/0006-migrations-for-deployed-stores.md)
has the reasoning; the procedure is the one below.)

Migrations carry a change to the **schema**. They cannot carry a change to
**promotion** — the rules deriving the model from staged rows — which leaves
this store shaped right and derived wrong. `pnpm db:migrate --check` sees
nothing, because nothing has drifted: the tables are correct and the rows in
them are stale. beeline-eyk was the first of these; assume more before
cutover, and check after any change under `ingest/`.

Re-promoting is the fix and re-fetching is not, because the staged sources
are already in the file — `legacy_occurrence`, and the `observation_*` rows
whose presence proof deletion detection reads (beeline-3hj). `pnpm db:reseed`
builds a fresh store from `schema/*.sql` and carries exactly those across —
renumbering them, because a new database renumbers everything else too and a
sync run's id is no more permanent than a person's (ADR 0002). Only the
association between a run and the rows pointing at it survives.

```sh
scripts/deploy-maderas.sh          # code first — reseed runs the new rules
scp data/legacy/taxonomy.csv maderas:dev/beeline/data/legacy/   # an input, not state
ssh maderas 'export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; cd ~/dev/beeline && nvm use >/dev/null \
  && systemctl --user stop beeline \
  && pnpm db:reseed beeline.duckdb beeline-new.duckdb \
  && export BEELINE_DB=beeline-new.duckdb \
  && pnpm legacy:promote beeline-new.duckdb \
  && pnpm inat:promote beeline-new.duckdb \
  && pnpm inat:backfill-accounts beeline-new.duckdb \
  && pnpm elevation:derive beeline-new.duckdb'
# swap only once the counts look right; keep the old file until the app is verified
ssh maderas 'cd ~/dev/beeline && mv -f beeline.duckdb beeline-prev.duckdb \
  && mv -f beeline-new.duckdb beeline.duckdb && systemctl --user start beeline'
```

The service must be stopped throughout: one process owns the store (ADR
0005), and `db:reseed` reads it while promotion writes the new one. Downtime
is the length of a promotion — about a minute for 383k rows.

`private.duckdb` is untouched, and sessions and volunteer tokens both survive
a reseed: `inat_oauth_token` is keyed by `inat_user_id`, and since
[beeline-ten](../../.beads/) so is `session`. They used to hold
`person.entity_id`, which a reseed redraws — so every surviving session
resolved to whoever inherited its number, and a volunteer browsed and acted as
somebody else under a `mine` scope forced for them. Sessions now resolve their
person through `inat_account` per request, so a renumbering is invisible to
them, unbinding an account ends its sessions, and rebinding moves them. A
private store predating the change is repaired at boot (`src/app/db.ts`), which
signs everyone out exactly once.

`data/person-overlay.csv` survives too; the curated `ingest/person-overlay.csv`
replays over the rebuilt store, which is what the overlay is for.

`data/person-change.csv` survives as well, and the exported `BEELINE_DB` above
is what makes both promotion steps record into it — each of them records, so
it has to be set for the pair ([ADR
0007](../adr/0007-authored-changes-are-events.md)). A change log belongs to
exactly one database, so a run pointed at a file that is not the one this
environment keeps a log for records nothing and says so — which is what should
happen when somebody promotes a scratch copy, and would otherwise diff its
people against the deployed store's history. Without the prefix nothing is
lost: the app records the same differences at its next boot, attributed to
that pass rather than to the promotion.

Rehearse on a copy first — `scp` the store down and run the same sequence
locally. Comparing the two side by side is how the 1,019
`within_sample_disagreement` findings turned out to be the sandbox catching
up rather than a regression.

## Admitting a person who has no records

Promotion mints people from the records — recordedBy names and iNat observers
— so somebody who collects nothing (an intern, a coordinator) is in no store
until the overlay says they exist, and cannot sign in at all: the approval
gate is an `inat_account` row bound to a person. There is no screen for this
yet (beeline-2c3.33); it is a curated-file decision.

Add the rows to [`ingest/person-overlay.csv`](../../ingest/person-overlay.csv)
— `create` first, then the account binding and whatever else is true of them:

```csv
name:Nora Jacobi,create,yes,rainhead,"why they belong in the store"
name:Nora Jacobi,inat_user_id,10206031 njacobi,rainhead,"verified against the iNat API"
name:Nora Jacobi,admin,yes,rainhead,"why"
```

Verify the iNat id first — `curl -s https://api.inaturalist.org/v1/users/<login>`
— because the id is the binding and a lookalike account has survived review
before. Then deploy the file and replay it (the service must be down: one
process owns the store):

```sh
scripts/deploy-maderas.sh
ssh maderas 'export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; cd ~/dev/beeline && nvm use >/dev/null \
  && systemctl --user stop beeline && pnpm person:apply && systemctl --user start beeline'
```

`person:apply` prints what it applied and every row it could not resolve; it
is idempotent, so a row that has already landed is a no-op and the same file
replays on the next rebuild. A later `db:reseed` reconstructs this person from
the same rows, which a hand-written `INSERT` would not survive.

## Operational notes

- The nightly incremental pipeline runs at 02:00 **America/Los_Angeles** and the weekly anti-entropy sweep Sundays at 03:00; the beeatlas
  nightly runs at 03:00 server time — check maderas's timezone once and make
  sure the two don't overlap on the shared two cores.
- Real backups start at roadmap phase 7. Until then the database is
  reconstructible by re-ingestion; the private store's contents (sessions,
  volunteer tokens) are acceptable losses pre-cutover.
