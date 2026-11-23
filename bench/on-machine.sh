#!/bin/sh
# Runs ON the Fly machine, beside the live app, against a COPY of its store.
# bench/README.md says how it gets there.
#
#   /app/bench/on-machine.sh pages|contention [flags for the benchmark]
#
# The budgets are fly.production.toml's, restated because `fly ssh console` does not hand
# a command the machine's [env]. That makes this a second process entitled to
# a gigabyte on a machine whose live app is entitled to its own 1.5 GB, and the
# kernel answers an overdraft with a kill — of either process — rather than a
# spill. So it refuses to start unless the memory is actually there, which on
# an idle machine it is (the app serves at well under 300 MB). Capping this
# process lower is not the way out: at 512 MB the first promotion of the
# sandbox's store failed outright, as fly.production.toml's own note on 384 MB predicts.
set -eu

# Where the kernel's CPU counters are; a test points it at a fixture.
PROC_STAT=${PROC_STAT:-/proc/stat}

# Prints the share of CPU time stolen between two readings, as a whole
# number of percent. Each argument is a `cpu` line from /proc/stat: counts
# since boot, in the order user nice system idle iowait irq softirq steal
# guest guest_nice. Steal is the growth of the eighth figure as a share of the
# growth of the first eight. The last two are left out of the total because the
# kernel already counts guest in user and guest_nice in nice. Prints 0 when
# the counters did not move.
steal_percent() {
  printf '%s\n%s\n' "$1" "$2" | awk '
    { total = 0; for (i = 2; i <= 9; i++) total += $i; t[NR] = total; s[NR] = $9 }
    END {
      dt = t[2] - t[1]
      if (dt <= 0) { print 0; exit }
      print int(100 * (s[2] - s[1]) / dt)
    }'
}

# Succeeds when steal between two readings is strictly above $3 percent. It
# compares the exact ratio, not the whole number steal_percent prints, so 20.9%
# is above 20 and exactly 20% is not.
steal_exceeds() {
  printf '%s\n%s\n' "$1" "$2" | awk -v limit="$3" '
    { total = 0; for (i = 2; i <= 9; i++) total += $i; t[NR] = total; s[NR] = $9 }
    END { exit !(t[2] > t[1] && 100 * (s[2] - s[1]) > limit * (t[2] - t[1])) }'
}

# A test sources this file to reach the function above, and stops here.
[ "${ON_MACHINE_SOURCE_ONLY:-}" = 1 ] && return 0

which="$1"
shift

# Refuse while the machine is already being throttled. A shared vCPU may run
# flat out only while its burst balance lasts and is held to a lower baseline
# once it is spent (2026-11-07: `pages --n=15` spent the balance, then ran 50
# minutes at 89% steal, slowing the live site throughout). The balance itself
# cannot be read from inside the machine, so steal is the only sign. An idle
# healthy machine reads about 0; 89% was a spent balance. 20% sits well clear
# of the noise on a healthy host and well short of the throttled reading.
# BENCH_ALLOW_STEAL=1 starts anyway. Skipped where /proc/stat cannot be read.
if [ "${BENCH_ALLOW_STEAL:-}" != 1 ] && [ -r "$PROC_STAT" ]; then
  before=$(head -n 1 "$PROC_STAT")
  sleep 5
  after=$(head -n 1 "$PROC_STAT")
  if steal_exceeds "$before" "$after" 20; then
    steal=$(steal_percent "$before" "$after")
    echo "${steal}% of CPU time was stolen over the last 5 seconds: the burst balance is probably spent. Not starting; check the balance in Fly's metrics, wait, or set BENCH_ALLOW_STEAL=1" >&2
    exit 1
  fi
fi
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
