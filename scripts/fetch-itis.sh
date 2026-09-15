#!/usr/bin/env bash
# Download the current ITIS release and extract the insects Beeline checks its
# taxonomy against (beeline-45v.4) into data/itis/. Load them with
# `pnpm itis:load [db]`.
#
# Network-heavy — 224 MB zipped, 925 MB unpacked — so run it on maderas, never
# over a home connection. Only the two extracted CSVs need to travel to a
# store. Needs curl and unzip.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
dir="$root/data/itis"
mkdir -p "$dir"
url="https://www.itis.gov/downloads/itisSqlite.zip"

# Into a temp file first, so a failed download never replaces a good one.
echo "downloading $url…" >&2
curl -fsSL --retry 3 -o "$dir/itisSqlite.zip.tmp" "$url"
mv -f "$dir/itisSqlite.zip.tmp" "$dir/itisSqlite.zip"

rm -rf "$dir/unpacked"
mkdir -p "$dir/unpacked"
unzip -q -o "$dir/itisSqlite.zip" -d "$dir/unpacked"
sqlite="$(find "$dir/unpacked" -name ITIS.sqlite | head -1)"
if [ -z "$sqlite" ]; then
  echo "no ITIS.sqlite in the download" >&2
  exit 1
fi

cd "$root"
tsx src/extract-itis.ts "$sqlite" "$dir"
# The unpacked database is only an input to the extract; the zip stays, so
# the extract can be remade from the same release without downloading again.
rm -rf "$dir/unpacked" "$dir/.extract-tmp"
echo "extracted to $dir — load with: pnpm itis:load [db]" >&2
