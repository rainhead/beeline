#!/usr/bin/env bash
# Export the production occurrences collection to data/legacy/, gzipped.
# Read-only against production. Credentials come from the mongo container's
# own environment — never from this repo. Requires `beeline` in ~/.ssh/config.
set -euo pipefail

dir="$(cd "$(dirname "$0")/.." && pwd)/data/legacy"
mkdir -p "$dir"

echo "exporting occurrences from production…" >&2
ssh -o BatchMode=yes beeline 'docker exec mongo sh -c "
  mongoexport --quiet \
    -u \$MONGO_INITDB_ROOT_USERNAME -p \$MONGO_INITDB_ROOT_PASSWORD \
    --authenticationDatabase admin \
    -d api-backend -c occurrences | gzip"' > "$dir/occurrences.jsonl.gz"

count=$(gzip -dc "$dir/occurrences.jsonl.gz" | wc -l | tr -d ' ')
printf '{"fetched_at": "%s", "collection": "api-backend.occurrences", "count": %s}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$count" > "$dir/metadata.json"

echo "wrote $count records to $dir/occurrences.jsonl.gz" >&2
