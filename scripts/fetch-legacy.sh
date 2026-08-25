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

echo "exporting the curated usernames register…" >&2
# Hand-curated, keyed by userLogin: the authoritative source for name parts
# and the label initial (beeline-8t8). It also holds emails and mailing
# addresses, which is why the checked-in copy upstream is a header only and
# why this lands in gitignored data/legacy/ — the loader stages the name
# columns and nothing else (src/load-legacy.ts).
ssh -o BatchMode=yes beeline \
  'docker exec server sh -c "cat /app/shared/data/usernames.csv"' \
  > "$dir/usernames.csv.raw"
# The register is hand-edited in Excel and is not UTF-8: it carries stray
# no-break spaces, 0xA0 (Windows-1252/Latin-1) and 0xCA (Mac Roman), inside
# address and state fields — 'PA<0xCA>', '1st<0xA0>Ave'. DuckDB reads UTF-8
# only and rejects the file outright, so normalise those two bytes to a plain
# space here. Any OTHER byte that will not decode is a character we would be
# guessing at, and the fetch fails rather than guess: a name is not a thing to
# mangle quietly.
node -e '
  const fs = require("fs");
  const [src, dst] = process.argv.slice(1);
  const buf = fs.readFileSync(src);
  const NBSP = new Set([0xa0, 0xca]);
  const out = Buffer.from(buf.map((b) => (b > 0x7f && NBSP.has(b) ? 0x20 : b)));
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try { decoder.decode(out); } catch {
    const at = [...out].findIndex((b) => b > 0x7f);
    console.error(`usernames.csv: undecodable byte 0x${out[at].toString(16)} at offset ${at}`);
    process.exit(1);
  }
  fs.writeFileSync(dst, out);
' "$dir/usernames.csv.raw" "$dir/usernames.csv.tmp"
rm -f "$dir/usernames.csv.raw"
mv -f "$dir/usernames.csv.tmp" "$dir/usernames.csv"

count=$(gzip -dc "$dir/occurrences.jsonl.gz" | wc -l | tr -d ' ')
printf '{"fetched_at": "%s", "collection": "api-backend.occurrences", "count": %s}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$count" > "$dir/metadata.json"

echo "wrote $count records to $dir/occurrences.jsonl.gz" >&2
