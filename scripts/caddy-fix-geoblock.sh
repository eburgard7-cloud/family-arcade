#!/bin/bash
# One-time fix for the US-only geoblock in the main Caddyfile.
#
# Problem: in blocks written as
#     respond @notUS 403
#     route { crowdsec; reverse_proxy ... }
# Caddy runs `route` before `respond` (its default directive order), so the request
# is proxied and the 403 never happens: the geoblock does nothing.
# Fix: move `respond @notUS 403` to the first line inside `route`, where handlers run
# in the order written.
#
# Safe: makes a backup, checks the new file with a throwaway Caddy container first,
# writes it in place (same file, so the container's mount stays valid), then reloads.

set -uo pipefail
F=/mnt/user/appdata/stack/caddy/Caddyfile
NEW=/tmp/Caddyfile.geofix
ENVF=/tmp/caddy.env.geofix
trap 'rm -f "$NEW" "$ENVF"' EXIT

[ -f "$F" ] || { echo "Not found: $F"; exit 1; }

awk '
/^[[:space:]]*respond @notUS 403[[:space:]]*$/ && !inroute { held=$0; next }
/^[[:space:]]*route \{[[:space:]]*$/ { inroute=1 }
inroute && /^[[:space:]]*\}[[:space:]]*$/ { inroute=0 }
held != "" {
  if ($0 ~ /^[[:space:]]*route \{[[:space:]]*$/) { ind=held; sub(/respond.*/, "", ind); print; print ind "\trespond @notUS 403"; n++; held=""; next }
  print held; held=""
}
{ print }
END { if (held != "") print held; print n+0 > "/dev/stderr" }' "$F" > "$NEW" 2> /tmp/geofix.count
moved=$(cat /tmp/geofix.count); rm -f /tmp/geofix.count

if [ "${moved:-0}" -eq 0 ]; then
  echo "Nothing to fix: no 'respond @notUS 403' sits right above a 'route {' block."
  exit 0
fi
echo "Blocks to fix: $moved"
diff -u "$F" "$NEW" | grep '^[-+][^-+]' | sed 's/^/  /'

docker inspect caddy --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -v '^$' > "$ENVF"
img=$(docker inspect caddy --format '{{.Config.Image}}')
if ! docker run --rm --network proxy --env-file "$ENVF" -v "$NEW":/etc/caddy/Caddyfile:ro \
     -v /mnt/user/appdata/stack/geoip:/geoip:ro "$img" \
     caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/tmp/geofix.validate 2>&1; then
  echo "The fixed file did NOT validate, so nothing was changed:"
  tail -3 /tmp/geofix.validate; rm -f /tmp/geofix.validate
  exit 1
fi
rm -f /tmp/geofix.validate
echo "Fixed file validates."

cp "$F" "$F.bak-geofix-$(date +%F_%H%M)"
cat "$NEW" > "$F"     # rewrite in place: keeps the inode the container has mounted
if docker exec caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
  echo "Done: Caddy reloaded. Non-US visitors now get 403 on every fixed site."
  echo "Backup: $(ls -1t "$F".bak-geofix-* | head -n 1)"
else
  echo "Reload failed; restoring the backup."
  cat "$(ls -1t "$F".bak-geofix-* | head -n 1)" > "$F"
  docker exec caddy caddy reload --config /etc/caddy/Caddyfile
  exit 1
fi
