#!/bin/bash
# Writes the Arcade VM state for the lobby page.
# User Scripts, custom cron: * * * * *  (every minute)
# The lobby treats the arcade as closed if this file is more than 3 minutes old.

VM="Arcade"
DIR="/mnt/user/appdata/arcade/state"
OUT="$DIR/arcade.json"

mkdir -p "$DIR"
state=$(virsh domstate "$VM" 2>/dev/null | head -n1 | tr -d '\r')
[ -z "$state" ] && state="missing"
running=false
[ "$state" = "running" ] && running=true

printf '{"vm_state":"%s","running":%s,"updated":%s}\n' "$state" "$running" "$(date +%s)" > "$OUT.tmp"
chmod 644 "$OUT.tmp"
mv -f "$OUT.tmp" "$OUT"
