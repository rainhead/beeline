#!/usr/bin/env bash
# PROTOTYPE (beeline-7i6) — throwaway. Builds
# data/prototype-locality/PROTOTYPE-coordinate-locality.html from a store.
#   scripts/prototype-coordinate-locality/build.sh [store.duckdb]
# The page holds sample coordinates and localities: keep it off the web.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
STORE=$(realpath "${1:-data/sandbox/beeline.duckdb}")
OUT=$(realpath -m data/prototype-locality)
mkdir -p "$OUT"
"$HERE/fetch.sh" "$OUT/downloads"
rm -f "$OUT/gazetteer.duckdb"
# BEELINE_PROTOTYPE_COLLECTOR="Peter Abrahamsen" adds every sample of that
# collector to the local page.
COLLECTOR=${BEELINE_PROTOTYPE_COLLECTOR:-}
COLLECTOR=${COLLECTOR//\'/\'\'}
sed -e "s#__STORE__#$STORE#g" -e "s#__COLLECTOR__#$COLLECTOR#g" -e "s#__DL__#$OUT/downloads#g" -e "s#__OUT__#$OUT#g" "$HERE/build.sql" \
  | duckdb "$OUT/gazetteer.duckdb" 2>&1 | grep -v -e 'CRS will not be persisted' -e 'WARNING' || true
node "$HERE/inline.mjs" "$HERE/page.html" "$OUT"
echo "$OUT/PROTOTYPE-coordinate-locality.html"
