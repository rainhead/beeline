#!/usr/bin/env bash
# PROTOTYPE, throwaway (beeline-2zej.4): the Collect tab. Builds site/ (index.html, data.js, the app's stylesheets).
# Needs ../prototype-collection-targets/build.sh run first, data/communiques/ (targets, and events.json there
# too: both are kept out of git because the mailing list is for members), and network access to iNaturalist.
set -euo pipefail
cd "$(dirname "$0")"
DATA=${DATA:-$(git rev-parse --path-format=absolute --git-common-dir)/../data}
ROOT=$(git rev-parse --show-toplevel)
duckdb -no-agent ../prototype-collection-targets/out/proto.duckdb < ours-weekly.sql
python3 -I fetch_inat.py "$DATA/communiques"      # about 460 requests to iNat; resumes from inat.json
cp -f "$DATA/communiques/events.json" events.json
mkdir -p site && cp -f index.html site/
(cd "$ROOT" && node --import tsx -e 'import("./src/app/theme/tokens.ts").then(m=>process.stdout.write(m.tokensCss()))') > site/tokens.css
cp -f "$ROOT"/src/app/static/{elements,layout,components}.css site/
python3 -I build_plan.py "$DATA/communiques"
echo "open site/index.html through any static server, e.g. python3 -m http.server -d site"
