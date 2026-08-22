#!/usr/bin/env bash
# Export the production occurrences collection to data/legacy/, gzipped.
# Read-only against production. Credentials come from the mongo container's
# own environment — never from this repo. Requires `beeline` in ~/.ssh/config.
set -euo pipefail

dir="$(cd "$(dirname "$0")/.." && pwd)/data/legacy"
mkdir -p "$dir"

# Exports land in a temp file first: the redirection creates the
# destination before ssh can fail, so a broken export must not replace a
# good previous one.
# gzip runs locally so pipefail sees mongoexport's own exit status (a
# remote "… | gzip" reports only gzip's).
echo "exporting occurrences from production…" >&2
ssh -o BatchMode=yes beeline 'docker exec mongo sh -c "
  mongoexport --quiet \
    -u \$MONGO_INITDB_ROOT_USERNAME -p \$MONGO_INITDB_ROOT_PASSWORD \
    --authenticationDatabase admin \
    -d api-backend -c occurrences"' | gzip > "$dir/occurrences.jsonl.gz.tmp"
mv -f "$dir/occurrences.jsonl.gz.tmp" "$dir/occurrences.jsonl.gz"

echo "exporting curated taxonomy CSV…" >&2
ssh -o BatchMode=yes beeline \
  'docker exec server sh -c "cat \"\$(ls -t /app/shared/data/taxonomy/taxonomy_*.csv | head -1)\""' \
  > "$dir/taxonomy.csv.tmp"
mv -f "$dir/taxonomy.csv.tmp" "$dir/taxonomy.csv"

count=$(gzip -dc "$dir/occurrences.jsonl.gz" | wc -l | tr -d ' ')
printf '{"fetched_at": "%s", "collection": "api-backend.occurrences", "count": %s}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$count" > "$dir/metadata.json"

echo "wrote $count records to $dir/occurrences.jsonl.gz" >&2
