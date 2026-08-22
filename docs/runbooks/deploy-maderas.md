# Deploy the sandbox to maderas (temporary hosting)

Beeline's sandbox runs on maderas at **https://beeline.beeatlas.net** as a
user systemd service behind an Apache `ProxyPass` vhost with certbot TLS —
the `beeatlas-api` pattern. **This hosting is temporary** (decided
2026-08-22): production hosting is re-decided at cutover with Andony.

Tracked config: [`infra/maderas/`](../../infra/maderas/) — the vhost, the
unit, and the env template. The app listens on 3054 (`0xBEE`); Apache owns
80/443.

One process, ever: the service owns `beeline.duckdb` (ADR 0005). Anything
else that wants the database (a CLI run, a rebuild) must stop the service
first. A deploy is `git pull` + restart.

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
ssh maderas 'cd ~/dev/beeline && git pull && pnpm install && pnpm app:build && systemctl --user restart beeline'
```

From a non-interactive shell (agents, scripts), nvm isn't loaded and `node`
is missing from PATH — source it explicitly:

```sh
ssh maderas 'export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; cd ~/dev/beeline && nvm use >/dev/null && git pull && pnpm install && pnpm app:build && systemctl --user restart beeline'
```

Brief downtime is by design (ADR 0005). Schema changes pre-cutover mean a
database rebuild (or a one-off table apply while the service is stopped).
**Any one-off DDL must end with an explicit `CHECKPOINT` before closing**:
DuckDB ≤1.5.5 fails WAL replay of an ALTER on a table with function/sequence
defaults with an INTERNAL error, leaving the file unopenable until the WAL
is deleted. Known upstream (duckdb/duckdb#18259, fixed on main by #21516);
the fix is confirmed in 1.6.0 nightlies, so this rule can be dropped once we
upgrade past 1.5.x (beeline-c1b).

## Operational notes

- The nightly incremental pipeline runs at 02:00 **America/Los_Angeles** and the weekly anti-entropy sweep Sundays at 03:00; the beeatlas
  nightly runs at 03:00 server time — check maderas's timezone once and make
  sure the two don't overlap on the shared two cores.
- Real backups start at roadmap phase 7. Until then the database is
  reconstructible by re-ingestion; the private store's contents (sessions,
  volunteer tokens) are acceptable losses pre-cutover.
