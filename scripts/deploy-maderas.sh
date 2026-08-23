#!/bin/sh
# Deploy the sandbox to maderas — the whole of docs/runbooks/deploy-maderas.md
# "Deploying a change", in one command. Temporary hosting: this script goes
# wherever production lands at cutover.
#
# Exactly one process may hold beeline.duckdb (ADR 0005), so the store is only
# free to migrate while the service is down: pull, build, stop, migrate, start.
set -e
cd "$(dirname "$0")/.."

HOST="${1:-maderas}"
APP_DIR="${BEELINE_REMOTE_DIR:-dev/beeline}"
HEALTH_URL="${BEELINE_HEALTH_URL:-https://beeline.beeatlas.net/healthz}"

# The deploy takes origin/main, not this working tree — say so when they differ,
# rather than letting someone believe uncommitted work went out.
git fetch -q origin main
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  echo "warning: local HEAD is not origin/main; deploying origin/main" >&2
fi

# A non-interactive shell loads neither nvm nor node's PATH: source it first.
ssh -o BatchMode=yes "$HOST" "APP_DIR='$APP_DIR' sh -s" <<'REMOTE'
set -e
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
cd "$APP_DIR"
nvm use >/dev/null
git pull --ff-only
pnpm install --frozen-lockfile
pnpm app:build

systemctl --user stop beeline
migrated=0
pnpm db:migrate || migrated=$?
systemctl --user start beeline
if [ "$migrated" -ne 0 ]; then
  echo "MIGRATION FAILED — the new code is now running against an unmigrated store" >&2
  exit 1
fi
git log --oneline -1
REMOTE

printf 'waiting for %s ' "$HEALTH_URL"
i=0
while [ "$i" -lt 20 ]; do
  if curl -sf "$HEALTH_URL" >/dev/null; then
    echo "ok"
    exit 0
  fi
  printf .
  sleep 2
  i=$((i + 1))
done
echo " no healthy response after 40s" >&2
exit 1
