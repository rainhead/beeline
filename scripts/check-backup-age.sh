#!/bin/sh
# Is the newest backup young enough, and is it a backup?
#
# The backup job cannot report that it did not run: an expired token, a
# missing flyctl, a full disk, a host that was down at 02:30 all look the same
# from the outside — the archive that should be there is not (beeline-vl4).
# This is the check the runbook told a person to run by hand, made into
# something cron can run: it prints nothing while the newest archive is young
# enough and lists cleanly, and speaks — on stderr, which cron mails — only
# when it is not. Silence is the healthy state, on purpose: a check that
# reports success every day is one somebody learns to filter.
#
# Usage:  scripts/check-backup-age.sh [dest-dir]
#         BEELINE_BACKUP_DIR=~/beeline-backups  BEELINE_BACKUP_MAX_AGE_DAYS=2
set -eu

DEST="${1:-${BEELINE_BACKUP_DIR:-$HOME/beeline-backups}}"
# Two days, so one missed night — the machine was mid-restart at 02:30 — is
# not an alarm, and two in a row is.
MAX_DAYS="${BEELINE_BACKUP_MAX_AGE_DAYS:-2}"
FILES="corrections.csv person-overlay.csv person-change.csv sample-change.csv sample-state.csv"

newest=$(ls -1t "$DEST"/beeline-authored-*.tar.gz 2>/dev/null | head -1 || true)
if [ -z "$newest" ]; then
  echo "error: no backup archive in $DEST" >&2
  exit 1
fi

fresh=$(find "$DEST" -maxdepth 1 -name 'beeline-authored-*.tar.gz' -mtime "-$MAX_DAYS" | head -1)
if [ -z "$fresh" ]; then
  echo "error: the newest backup is more than $MAX_DAYS day(s) old: $(basename "$newest")" >&2
  echo "  see \$HOME/.local/state/beeline-backup.log on the backup host, and docs/runbooks/deploy-fly.md (Backups)" >&2
  exit 1
fi

# Young is not enough. The backup script builds each archive under a
# temporary name and renames it into place, so a truncated one should be
# impossible — and "should be" is what a check exists to replace. Listing it
# reads every block, and the five names are the five the runbook says a
# rebuild cannot reconstruct.
listed=$(tar -tzf "$newest" 2>&1) || {
  echo "error: the newest backup does not read as an archive: $(basename "$newest")" >&2
  printf '%s\n' "$listed" | sed 's/^/  /' >&2
  exit 1
}
for f in $FILES; do
  if ! printf '%s\n' "$listed" | grep -qx "$f"; then
    echo "error: the newest backup is missing $f: $(basename "$newest")" >&2
    exit 1
  fi
done
