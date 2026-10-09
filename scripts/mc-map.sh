#!/bin/bash
# Renders the world into a zoomable web map for play.finsonly.net/map (family password).
# User Scripts, custom cron: 30 4 * * *  (after mc-nightly's 4 AM backup)
#
# Works from the newest nightly backup, never the live world, so it can't
# disturb the running server. Uses uNmINeD's free command-line renderer
# (free for personal use); only changed areas are re-rendered after the first run.

. /mnt/user/appdata/arcade/scripts/lib.sh
set -uo pipefail

UNMINED="$ARCADE/tools/unmined-cli/unmined-cli"
WORK="$ARCADE/map-work"
OUT="$ARCADE/map"
BK="/mnt/user/backups/minecraft"
export DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1   # no ICU libraries on Unraid

if [ ! -x "$UNMINED" ]; then
  log "uNmINeD CLI not found at $UNMINED (see ARCADE_SETUP.md, map phase)"; exit 1
fi

if fallback_on; then
  latest=$(ls -1t "$BK"/world_*_fallback.tar.gz 2>/dev/null | head -n 1)
else
  latest=$(ls -1t "$BK"/world_*.tar.gz 2>/dev/null | grep -v '_fallback\|before-\|fallback-end\|endstone-old' | head -n 1)
fi
[ -n "$latest" ] || { log "no backup found in $BK"; exit 1; }

rm -rf "$WORK" && mkdir -p "$WORK" "$OUT"
tar -xzf "$latest" -C "$WORK" worlds || { log "could not extract $latest"; exit 1; }
world=$(find "$WORK/worlds" -mindepth 1 -maxdepth 1 -type d | head -n 1)
[ -n "$world" ] || { log "no world folder inside $latest"; exit 1; }

log "rendering $(basename "$world") from $(basename "$latest")"
start=$(date +%s)
if nice -n 15 "$UNMINED" web render --world="$world" --output="$OUT" >"$ARCADE/state/map-render.log" 2>&1; then
  log "map updated in $(( $(date +%s) - start ))s"
  printf '{"updated":%s,"source":"%s"}\n' "$(date +%s)" "$(basename "$latest")" > "$STATE_DIR/map.json"
  chmod -R a+rX "$OUT"
else
  log "ERROR: render failed; see $ARCADE/state/map-render.log"
  discord_post "${DISCORD_WEBHOOK_MOD:-}" "World map render failed. See /mnt/user/appdata/arcade/state/map-render.log"
fi
rm -rf "$WORK"
exit 0
