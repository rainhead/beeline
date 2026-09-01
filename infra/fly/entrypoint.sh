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
#
# NOTHING HERE MAY INVOKE pnpm. corepack ships shims, not pnpm itself, so the
# first `pnpm` in a container that has not run one downloads it from
# registry.npmjs.org — which would make every boot, including a 3am restart
# after host maintenance, depend on npm being up. Node and tsx are both in the
# image; use them directly.
set -e

: "${BEELINE_DB:=/app/data/beeline.duckdb}"
export BEELINE_DB

# Drop to an unprivileged user before anything opens the store or serves a
# request. This cannot be a `USER` line in the Dockerfile: a Fly volume mounts
# root-owned, so something privileged has to take ownership of it first — and
# it must be recursive and on every boot, because `fly ssh console` is root,
# so any file a maintenance-mode CLI writes (a reseeded store, a fetched DEM
# tile, an uploaded CSV) lands root-owned and would be unwritable by the app.
# chown of a volume is metadata only; the DEM directory's 213 files cost
# nothing.
#
# setpriv execs, and so does everything after it, so node still ends up as
# PID 1 and still receives SIGTERM directly — see the exec at the foot of this
# file. The sentinel makes the re-exec unrepeatable: without it, a setpriv
# that somehow failed to change uid would loop forever.
if [ "$(id -u)" = "0" ] && [ -z "$BEELINE_DROPPED_PRIVS" ]; then
  # Not `|| true`: an app that cannot write its store is not a degraded app,
  # it is a confusing one — DuckDB fails later with an access error nowhere
  # near the cause. Fail here, with the real chown error still on stderr.
  #
  # Except in maintenance mode, which must still boot: it is how somebody gets
  # a shell to fix exactly this, and a machine that refuses to start at all
  # cannot be reached (`fly ssh console` needs a running machine).
  if ! chown -R node:node /app/data; then
    if [ -n "$BEELINE_MAINTENANCE" ]; then
      echo "warning: could not chown /app/data; continuing, BEELINE_MAINTENANCE is set" >&2
    else
      echo "fatal: could not chown /app/data — the app runs as 'node' and could not write the store." >&2
      echo "Boot with BEELINE_MAINTENANCE=1 for a shell to investigate." >&2
      exit 1
    fi
  fi
  BEELINE_DROPPED_PRIVS=1
  export BEELINE_DROPPED_PRIVS
  exec setpriv --reuid=node --regid=node --init-groups "$0" "$@"
fi

node_run() { node --import tsx "$@"; }

# Maintenance mode. The store is reachable only from inside this machine, and
# a stopped machine cannot be reached at all — so "stop the app but keep the
# volume" needs somewhere to stand:
#
#   fly machine update --env BEELINE_MAINTENANCE=1 <id>   # app down, store free
#   fly ssh console --app <app>                           # pnpm db:reseed, etc.
#   fly machine update --env BEELINE_MAINTENANCE= <id>    # back to serving
#
# Everything below this point can be skipped by it, which is also how you get a
# machine to boot at all when the migration or the store check is broken. Only
# the privilege drop above runs first, and it has to: the first-fill case is
# maintenance mode on an empty volume, which is exactly when the chown is
# needed.
if [ -n "$BEELINE_MAINTENANCE" ]; then
  echo "maintenance mode: app not started; $BEELINE_DB is free for CLI use"
  exec sleep infinity
fi

if [ -f "$BEELINE_DB" ]; then
  # Name the store explicitly. db:migrate CREATES its target if absent, so a
  # missing path is not an error but an empty database that migrates cleanly
  # and reports success while the real store goes untouched.
  #
  # Captured rather than piped into grep: a pipeline's status is the LAST
  # command's, so `... --status | grep -q PENDING` under `set -e` cannot see
  # the status command itself fail — it would read as "nothing pending", skip
  # the backup, and migrate anyway. /bin/sh here is dash, which has no
  # `pipefail`.
  status=$(node_run src/migrate.ts --status "$BEELINE_DB")

  if echo "$status" | grep -q PENDING; then
    # One copy from before this round of migrations. Never overwrite an
    # existing one: a migration that fails mid-way leaves earlier migrations
    # committed and the machine restart-looping, and a blind `cp` on the
    # second boot would replace the pristine copy with the half-migrated
    # store — destroying the only thing that could undo it, seconds after the
    # failure and before anyone could look.
    if [ -f "$BEELINE_DB.pre-migrate" ]; then
      echo "keeping the existing $BEELINE_DB.pre-migrate (an earlier attempt made it)"
    else
      echo "pending migrations: copying $BEELINE_DB aside first"
      cp -f "$BEELINE_DB" "$BEELINE_DB.pre-migrate"
    fi

    # set -e: a failed migration fails the boot. The machine then restart-
    # loops on the NEW image and the site is down — Fly updates the single
    # machine in place, so there is no previous release still serving. What
    # this does guarantee is that new code never serves against an unmigrated
    # store.
    node_run src/migrate.ts "$BEELINE_DB"

    # Migrations are through: retire the backup to one generation back, so the
    # next round takes a fresh copy of a store that is actually current.
    if [ -f "$BEELINE_DB.pre-migrate" ]; then
      mv -f "$BEELINE_DB.pre-migrate" "$BEELINE_DB.pre-migrate.last"
    fi
  fi
else
  # openAppDb would CREATE an empty store here, and seedAdmins then throws on
  # the missing `person` table outside any try/catch — so the machine
  # restart-loops rather than reporting anything. Refuse instead, and say what
  # to do: a machine looping while someone uploads 266 MB into the very path
  # it keeps re-creating is two writers (ADR 0005) on a half-written file.
  echo "no store at $BEELINE_DB." >&2
  echo "Set BEELINE_MAINTENANCE=1 and fill the volume before starting the app;" >&2
  echo "see docs/runbooks/deploy-fly.md." >&2
  exit 1
fi

# Node itself as PID 1, NOT `pnpm app:start`. This is the single most
# important line in the file. pnpm does not forward SIGTERM: it takes the
# signal, kills the app, and exits 1 ("[ELIFECYCLE] Command failed") in about
# a quarter of a second — so main.ts's shutdown handler never runs, the store
# is never closed, and the WAL is left uncheckpointed. That is precisely the
# state DuckDB <= 1.5.5 can fail to replay, leaving the file unopenable
# (beeline-c1b). Measured: through pnpm, SIGTERM gave exit 1 in 0.24s;
# direct, the handler runs and exits 0.
exec node --import tsx src/app/main.ts
