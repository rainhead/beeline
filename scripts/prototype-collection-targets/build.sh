#!/usr/bin/env bash
# PROTOTYPE, throwaway (beeline-2zej.4). Builds out/collection-targets.html from the legacy pull,
# the gazetteer and the communique targets. DATA defaults to the main checkout's data/ (gitignored),
# which needs data/legacy (pnpm legacy:fetch), data/gazetteer.duckdb (pnpm locality:gazetteer)
# and data/communiques/batch*-targets.jsonl (kept out of git: the mailing list is for members).
set -euo pipefail
cd "$(dirname "$0")"
DATA=${DATA:-$(git rev-parse --path-format=absolute --git-common-dir)/../data}
rm -rf out && mkdir -p out
sed "s#\.\./\.\./data#$DATA#g" build.sql | duckdb -no-agent out/proto.duckdb
sed "s#\.\./\.\./data#$DATA#g" build.py | python3 -
