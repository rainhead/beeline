#!/bin/sh
# Boot sequence for the Fly machine. Migrations run HERE, not in a Fly
# release_command: that command runs on a temporary machine with no volume
# mounted (fly.io/docs/reference/configuration), so it cannot see the store.
#
# Running them in the entrypoint is not a workaround but the better shape.
# Exactly one process may hold beeline.duckdb (ADR 0005), and Fly replaces the
# machine in place, so the store is free for the whole of this script and
# there is no window in which a second process could open it — the thing
# scripts/deploy-maderas.sh has to stop the service to achieve.
set -e

: "${BEELINE_DB:=/app/data/beeline.duckdb}"
export BEELINE_DB

# Maintenance mode. The store is reachable only from inside this machine, and
# a stopped machine cannot be reached at all — so "stop the app but keep the
# volume" needs somewhere to stand:
#
#   fly machine update --env BEELINE_MAINTENANCE=1 <id>   # app down, store free
#   fly ssh console --app <app>                           # pnpm db:reseed, etc.
#   fly machine update --env BEELINE_MAINTENANCE= <id>    # back to serving
#
# Without this the first db:reseed or person:apply is an emergency.
if [ -n "$BEELINE_MAINTENANCE" ]; then
  echo "maintenance mode: app not started; $BEELINE_DB is free for CLI use"
  exec sleep infinity
fi

if [ -f "$BEELINE_DB" ]; then
  # One copy from immediately before a migration. DuckDB <= 1.5.5 can leave the
  # file unopenable when DDL reaches the WAL without a checkpoint (beeline-c1b,
  # duckdb/duckdb#18259), and this store is production after cutover.
  # Name the store explicitly. db:migrate CREATES its target if absent, so a
  # missing path is not an error but an empty database that migrates cleanly
  # and reports success while the real store goes untouched.
  if pnpm db:migrate --status "$BEELINE_DB" | grep -q PENDING; then
    echo "pending migrations: copying $BEELINE_DB aside first"
    cp -f "$BEELINE_DB" "$BEELINE_DB.pre-migrate"
  fi
  # set -e: a failed migration fails the boot, so the health check never
  # passes and Fly keeps the previous release rather than serving new code
  # against an unmigrated store.
  pnpm db:migrate "$BEELINE_DB"
else
  echo "no store at $BEELINE_DB — starting anyway; the app will report it"
fi

# Node itself as PID 1, NOT `pnpm app:start`. This is the single most
# important line in the file. pnpm does not forward SIGTERM to its child: it
# takes the signal, kills the app, and exits 1 ("[ELIFECYCLE] Command failed")
# in about a quarter of a second — so main.ts's shutdown handler never runs,
# the store is never closed, and the WAL is left uncheckpointed. That is
# precisely the state DuckDB <= 1.5.5 can fail to replay, leaving the file
# unopenable (beeline-c1b), and no kill_timeout can help because nothing is
# waiting. Measured: through pnpm, SIGTERM gave exit 1 in 0.24s; direct, the
# handler runs and exits 0.
exec node --import tsx src/app/main.ts
