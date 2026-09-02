#!/bin/sh
# Copy the authored-history files off the Fly volume.
#
# These five are the only things on that volume a rebuild cannot reconstruct.
# beeline.duckdb can be re-derived by re-ingestion and is deliberately NOT
# copied here — it is 211 MB, and copying it would turn a cheap, frequent job
# into an expensive, occasional one. What these hold is decisions and history:
# who was bound to which account and why, what changed about a person or a
# sample and when (ADR 0004, ADR 0007). A rebuild answers "who changed this"
# with "nobody, we rebuilt it", and so would a lost volume.
#
# Pull, never push: the Fly machine holds no credential and cannot reach this
# host, so a compromised app cannot touch the backups. The credential lives
# here instead, and `fly tokens create ssh --app beeline` scopes it to SSH on
# that one app and nothing else.
#
# Fly's own advice is at least two volumes per app and don't treat snapshots
# as a backup. ADR 0005 plus single-attach volumes mean we can take neither,
# so this is the whole of the backup story for the irreplaceable half.
#
# Usage:  scripts/backup-authored-files.sh [dest-dir]
#         BEELINE_FLY_APP=beeline  FLY_API_TOKEN=...  BEELINE_BACKUP_KEEP=30
set -eu

APP="${BEELINE_FLY_APP:-beeline}"
DEST="${1:-${BEELINE_BACKUP_DIR:-$HOME/beeline-backups}}"
KEEP="${BEELINE_BACKUP_KEEP:-30}"
REMOTE_DIR=/app/data

FILES="corrections.csv person-overlay.csv person-change.csv sample-change.csv sample-state.csv"

stamp=$(date -u +%Y%m%dT%H%M%SZ)
work="$DEST/.incoming-$stamp"
mkdir -p "$work"
trap 'rm -rf "$work"' EXIT

# One remote call for every checksum rather than one per file: each `fly ssh`
# is a fresh connection through the proxy, and five of them is most of the
# runtime.
remote_sums=$(flyctl ssh console --app "$APP" \
  -C "sh -c 'cd $REMOTE_DIR && sha256sum $FILES 2>/dev/null'" 2>/dev/null | tr -d '\r')

failed=""
for f in $FILES; do
  want=$(printf '%s\n' "$remote_sums" | awk -v f="$f" '$2 == f || $2 == "./" f {print $1}' | tail -1)
  if [ -z "$want" ]; then
    # Absent is not always wrong — a store promoted before the sample log was
    # baselined has no sample-state.csv — but it is never silently fine.
    echo "warning: $f is not on the volume" >&2
    failed="$failed $f"
    continue
  fi
  flyctl ssh sftp get --app "$APP" "$REMOTE_DIR/$f" "$work/$f" >/dev/null 2>&1 || true
  got=$(sha256sum "$work/$f" 2>/dev/null | cut -d' ' -f1)
  # Verified, not assumed: a truncated transfer produces a file that looks
  # like a backup and is not one, which is the failure this job exists to
  # prevent rather than to imitate.
  if [ "$got" != "$want" ]; then
    echo "error: $f did not transfer intact (want ${want:-?}, got ${got:-nothing})" >&2
    failed="$failed $f"
  fi
done

if [ -n "$failed" ]; then
  echo "backup INCOMPLETE, keeping nothing:$failed" >&2
  exit 1
fi

archive="$DEST/beeline-authored-$stamp.tar.gz"
tar -czf "$archive" -C "$work" $FILES
echo "$(du -h "$archive" | cut -f1)	$archive"

# Retention. Only ever removes files this script names, so a stray file in the
# destination is never collected.
if [ "$KEEP" -gt 0 ]; then
  ls -1t "$DEST"/beeline-authored-*.tar.gz 2>/dev/null | tail -n "+$((KEEP + 1))" | while read -r old; do
    rm -f "$old"
    echo "pruned $(basename "$old")"
  done
fi
