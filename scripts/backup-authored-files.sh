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
#         BEELINE_FLY_TOKEN_EXPIRES=YYYY-MM-DD  (the date the token was minted to expire)
set -eu

# Before anything is created. These files are people: names, account bindings,
# who changed what. Inheriting a caller's 022 would leave the archive readable
# by every other local user on the host that runs this.
umask 077

# The scoped token, insisted on rather than hoped for. flyctl would otherwise
# fall back to whatever `fly auth login` left in ~/.fly — quite possibly a
# personal credential with rights over every app in the org — and an
# unattended job would use it without anyone noticing. Deliberately NOT passed
# as --access-token: a global flag is visible in `ps` to every user on the
# host, and flyctl already reads this variable ahead of its own config.
if [ -z "${FLY_API_TOKEN:-}" ] && [ "${BEELINE_BACKUP_AMBIENT_AUTH:-}" != "1" ]; then
  echo "error: FLY_API_TOKEN is not set." >&2
  echo "  Mint one scoped to SSH on this app, with an expiry that lands in a quiet month (the default is 20 years):" >&2
  echo "    fly tokens create ssh --app beeline --expiry 4320h" >&2
  echo "  To use your own logged-in credentials instead, set BEELINE_BACKUP_AMBIENT_AUTH=1." >&2
  exit 2
fi

APP="${BEELINE_FLY_APP:-beeline}"

# The token's expiry, as written down by whoever minted it (beeline-vl4). Fly
# does not tell a scoped token when it ends, and the night it does this job
# fails with an authentication error that says nothing about why — the one
# quiet failure a backup cannot afford, and one that landed in cutover month
# the first time round. So the date is recorded beside the token and the
# warning starts two weeks out, to stderr, which is what cron mails. Not an
# error: a misremembered date must not refuse a token that still works, and
# flyctl is the authority on whether it does.
EXPIRES="${BEELINE_FLY_TOKEN_EXPIRES:-}"
if [ -n "$EXPIRES" ]; then
  case "$EXPIRES" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
    *) echo "error: BEELINE_FLY_TOKEN_EXPIRES must be YYYY-MM-DD, got '$EXPIRES'" >&2; exit 2 ;;
  esac
  # An ISO date with the dashes removed is a number that orders like the
  # date, and integer comparison is the one POSIX test guarantees — the
  # string form is not (shellcheck SC3012). No date arithmetic beyond "two
  # weeks from now": GNU date first, BSD date as the fallback.
  soon=$(date -u -d '+14 days' +%F 2>/dev/null || date -u -v+14d +%F)
  if [ "$(printf '%s' "$EXPIRES" | tr -d -)" -le "$(printf '%s' "$soon" | tr -d -)" ]; then
    echo "warning: FLY_API_TOKEN expires $EXPIRES (recorded in BEELINE_FLY_TOKEN_EXPIRES) — rotate it:" >&2
    echo "  fly tokens create ssh --app $APP --expiry <hours>h   # and pick an expiry clear of cutover" >&2
  fi
fi

DEST="${1:-${BEELINE_BACKUP_DIR:-$HOME/beeline-backups}}"
KEEP="${BEELINE_BACKUP_KEEP:-30}"
REMOTE_DIR=/app/data

FILES="corrections.csv person-overlay.csv person-change.csv sample-change.csv sample-state.csv"

stamp=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$DEST"
# mktemp, not the timestamp: it has one-second precision, so two runs starting
# together would share a working directory and each one's cleanup trap would
# delete the other's files mid-transfer. The archive carries the pid for the
# same reason.
work=$(mktemp -d "$DEST/.incoming-XXXXXX")
trap 'rm -rf "$work"' EXIT

# One remote call for every checksum rather than one per file: each `fly ssh`
# is a fresh connection through the proxy, and five of them is most of the
# runtime.
# flyctl's stderr is kept, not discarded: when the token has expired this is
# the call that fails, and "every file is missing from the volume" was what
# the run used to say about it.
remote_sums=$(flyctl ssh console --app "$APP" \
  -C "sh -c 'cd $REMOTE_DIR && sha256sum $FILES 2>/dev/null'" 2>"$work/.flyctl-err" | tr -d '\r')
if [ -z "$remote_sums" ]; then
  echo "error: could not read checksums from $APP — flyctl said:" >&2
  sed 's/^/  /' "$work/.flyctl-err" >&2
  [ -n "$EXPIRES" ] && echo "  (the token was minted to expire $EXPIRES)" >&2
  echo "backup INCOMPLETE, keeping nothing" >&2
  exit 1
fi

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

# Built inside the working directory and moved into place, never written to
# the final path. A tar that dies half-way — a full disk, an interrupt — would
# otherwise leave a truncated beeline-authored-*.tar.gz that reads as a
# finished backup, which is the same failure the checksum step above exists to
# prevent, one stage later. $work is inside $DEST, so the move is a rename on
# one filesystem and cannot be seen half-done.
archive="$DEST/beeline-authored-$stamp-$$.tar.gz"
tar -czf "$work/.archive.tar.gz" -C "$work" $FILES
mv "$work/.archive.tar.gz" "$archive"
echo "$(du -h "$archive" | cut -f1)	$archive"

# Retention. Only ever removes files this script names, so a stray file in the
# destination is never collected.
if [ "$KEEP" -gt 0 ]; then
  ls -1t "$DEST"/beeline-authored-*.tar.gz 2>/dev/null | tail -n "+$((KEEP + 1))" | while read -r old; do
    rm -f "$old"
    echo "pruned $(basename "$old")"
  done
fi
