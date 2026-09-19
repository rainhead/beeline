#!/bin/sh
# Runs ON the Fly machine, beside the live app, against a COPY of its store.
# bench/README.md says how it gets there.
#
#   /app/bench/on-machine.sh pages|contention [flags for the benchmark]
#
# The budgets are fly.toml's, restated because `fly ssh console` does not hand
# a command the machine's [env]. That makes this a second process entitled to
# a gigabyte on a 2 GB machine whose live app is entitled to its own, and the
# kernel answers an overdraft with a kill — of either process — rather than a
# spill. So it refuses to start unless the memory is actually there, which on
# an idle sandbox it is (the app serves at well under 300 MB). Capping this
# process lower is not the way out: at 512 MB the first promotion of the
# sandbox's store fails outright, as fly.toml's own note on 384 MB predicts.
set -eu
which="$1"
shift
available_mb=$(awk '/^MemAvailable:/ { print int($2 / 1024) }' /proc/meminfo)
if [ "$available_mb" -lt 1300 ]; then
  echo "only ${available_mb} MB available; not starting a second 1 GB DuckDB beside the live app" >&2
  exit 1
fi
cd /app
mkdir -p /app/data/bench-tmp
BENCH_TMP=/app/data/bench-tmp \
BEELINE_DUCKDB_MEMORY_LIMIT=1024MB \
BEELINE_DUCKDB_THREADS=2 \
  exec node --import tsx "bench/$which.ts" /app/data/beeline.duckdb "--out=/app/data/bench-tmp/$which.json" "$@"
