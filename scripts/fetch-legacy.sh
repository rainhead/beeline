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
# Hand-curated, keyed by userLogin: name parts, the label initial, and the
# mailing addresses that are why the copy checked into OBP-Server is a header
# and nothing else. A second opinion about names rather than an authority over
# them — see ingest/promote-register.sql, which stages the name columns and
# leaves the addresses here.
#
# The file is hand-edited in Excel and is not always UTF-8: it carries stray
# no-break spaces, 0xA0 (Windows-1252) and 0xCA (Mac Roman), inside address
# fields — 'PA<0xCA>', '1st<0xA0>Ave'. DuckDB reads UTF-8 only and rejects the
# file outright, so those two bytes are normalised to a plain space — but ONLY
# once the file has already failed to decode, because both are also legal
# UTF-8 lead bytes: 0xCA starts 'ʻ' (U+02BB), which is a letter in Hawaiian
# names, and substituting blind would mangle a correctly encoded file. A file
# that still will not decode names the lines at fault and fails: a name is not
# a thing to guess at.
ssh -o BatchMode=yes beeline \
  'docker exec server sh -c "cat /app/shared/data/usernames.csv"' \
  | node -e '
  const fs = require("fs");
  const raw = fs.readFileSync(0);
  const decodes = (b) => {
    try { new TextDecoder("utf-8", { fatal: true }).decode(b); return true; }
    catch { return false; }
  };
  const NBSP = new Set([0xa0, 0xca]);
  let out = raw;
  if (!decodes(out)) out = Buffer.from(raw.map((b) => (NBSP.has(b) ? 0x20 : b)));
  if (!decodes(out)) {
    const lines = new TextDecoder("utf-8").decode(out).split("\n");
    const bad = lines.flatMap((l, i) => (l.includes("\uFFFD") ? [i + 1] : []));
    console.error(`usernames.csv: line(s) ${bad.join(", ")} are not UTF-8 and are not a`
      + ` known stray no-break space — refusing to guess at them`);
    process.exit(1);
  }
  fs.writeFileSync(process.argv[1], out);
' "$dir/usernames.csv.tmp"
mv -f "$dir/usernames.csv.tmp" "$dir/usernames.csv"

count=$(gzip -dc "$dir/occurrences.jsonl.gz" | wc -l | tr -d ' ')
printf '{"fetched_at": "%s", "collection": "api-backend.occurrences", "count": %s}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$count" > "$dir/metadata.json"

echo "wrote $count records to $dir/occurrences.jsonl.gz" >&2
