#!/bin/sh
# Retire beeline.beeatlas.net on maderas: stop proxying to a port with nothing
# behind it, and redirect the hostname to where the app actually lives.
#
# Run as root on maderas:
#   sudo sh ~/retire-beeline-vhost.sh
#
# Safe to re-run: it detects its own work and does nothing the second time.
# It restores both files and leaves Apache untouched if the config does not
# test clean, so the worst case is that nothing changes.
#
# WHAT IT CHANGES, AND WHAT IT DOES NOT
#
# Only the :443 vhost. That is the one carrying ProxyPass to 127.0.0.1:3054,
# which is now a closed port — every request to the site currently ends in a
# proxy error. It becomes a permanent redirect to https://beeline.fly.dev/.
#
# The :80 vhost is deliberately left alone. certbot put a redirect-to-HTTPS in
# it, and that redirect is also the path its renewal check walks; rewriting it
# to point at fly.dev would send the ACME challenge somewhere that knows
# nothing about this certificate. So http reaches https on this host, and
# https redirects onward — two hops, and a certificate that keeps renewing.
# That matters: a browser meeting an expired certificate shows a warning
# rather than following a redirect, which is worse than the error being fixed.
#
# NOT a DNS change. beeline.beeatlas.net still resolves here, on purpose: the
# iNat OAuth app holds exactly one redirect URI and it reads beeline.fly.dev,
# so moving the hostname breaks sign-in until the registration moves with it.
# That is the cutover, and it is a decision rather than a tidy-up.
set -eu

SSL_CONF=/etc/apache2/sites-available/beeline.beeatlas.net-le-ssl.conf
TARGET=https://beeline.fly.dev/
STAMP=$(date -u +%Y%m%dT%H%M%SZ)

[ "$(id -u)" = "0" ] || { echo "run me as root: sudo sh $0" >&2; exit 1; }
[ -f "$SSL_CONF" ] || { echo "not found: $SSL_CONF — nothing to retire" >&2; exit 1; }

if grep -q "beeline.fly.dev" "$SSL_CONF"; then
  echo "already retired: $SSL_CONF redirects to $TARGET"
  exit 0
fi

backup="$SSL_CONF.pre-retire-$STAMP"
cp -p "$SSL_CONF" "$backup"
echo "backed up  -> $backup"

# Comment the proxy out rather than deleting it: this file is the record of
# what the host used to do, and a reader six months from now should be able to
# see that it proxied rather than infer it.
# -E, not basic regex: `\|` alternation is a GNU extension and this was
# written on a Mac, where it silently matches nothing and leaves the proxy in
# place. That is not cosmetic — mod_proxy claims the request before mod_alias
# gets it, so a ProxyPass left behind makes the Redirect below dead text.
# ProxyPassReverse is listed first so it is not half-matched by ProxyPass,
# and the delimiter is @ rather than | because | is the alternation operator:
# as `s|...|` the pattern ended at the first branch and sed refused it.
tmp=$(mktemp)
sed -E -e 's@^( *)(ProxyPassReverse|ProxyPreserveHost|ProxyPass)@\1# retired '"$STAMP"': \2@' \
    -e "s@^( *)ServerName beeline.beeatlas.net@\1ServerName beeline.beeatlas.net\n\1# The app moved to Fly; this host keeps the name pointing at it.\n\1Redirect permanent / $TARGET@" \
    "$SSL_CONF" > "$tmp"

# The redirect is only real if the proxy is gone. Checked here rather than
# trusted, because the failure mode is a site that looks retired and is not.
if grep -Eq '^ *(ProxyPass|ProxyPreserveHost)' "$tmp"; then
  echo "refusing: proxy directives survived the edit — sed did not match" >&2
  rm -f "$tmp"; exit 1
fi
cat "$tmp" > "$SSL_CONF"
rm -f "$tmp"

if ! apachectl configtest; then
  echo "configtest FAILED — restoring and changing nothing" >&2
  cat "$backup" > "$SSL_CONF"
  exit 1
fi

systemctl reload apache2
echo "reloaded apache"

# Prove it, rather than assume it, and prove BOTH schemes. An earlier draft of
# this retirement disabled the TLS site and installed a :80 vhost only, which
# would have left https with no vhost at all — not a redirect that failed, a
# hostname that stopped answering on the scheme every bookmark uses. Checking
# only http would not have noticed.
#
# -I to see status and Location; no -L, so we watch the hop rather than follow
# it off to Fly.
echo "--- http://beeline.beeatlas.net/  (certbot's redirect to https, unchanged) ---"
curl -sI http://beeline.beeatlas.net/ | sed -n '1p;/^[Ll]ocation:/p'
echo "--- https://beeline.beeatlas.net/  (the retirement redirect) ---"
curl -sI https://beeline.beeatlas.net/ | sed -n '1p;/^[Ll]ocation:/p'
echo "--- the whole hop, followed ---"
curl -sIL http://beeline.beeatlas.net/ | sed -n '1p;/^[Ll]ocation:/p' | tail -3
echo "--- and the certificate still has time on it ---"
openssl s_client -connect beeline.beeatlas.net:443 -servername beeline.beeatlas.net </dev/null 2>/dev/null \
  | openssl x509 -noout -enddate 2>/dev/null || echo "  (could not read the certificate)"
echo "--- the other vhosts on this host still answer ---"
curl -sI https://beeatlas.net/ | sed -n '1p'
