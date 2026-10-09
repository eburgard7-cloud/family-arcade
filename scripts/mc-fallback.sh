#!/bin/bash
# Chat-off fallback for when the kids' Minecraft updated before Endstone supports it.
#   mc-fallback.sh on    stop Endstone, copy the world, run plain Bedrock with chat disabled
#   mc-fallback.sh off   copy the world back and return to Endstone + Chat Guard
#   mc-fallback.sh status
# Both directions take a backup first. While fallback is on, nobody can chat at
# all, and guest-list changes have to wait until it's off.

. /mnt/user/appdata/arcade/scripts/lib.sh
set -euo pipefail

FB="$ARCADE/minecraft-fallback"
FLAG="$STATE_DIR/fallback-on"
COMPOSE=(docker compose -f "$ARCADE/docker-compose.yml")
BK="/mnt/user/backups/minecraft"
mkdir -p "$BK" "$STATE_DIR"

wait_stopped() { local i; for ((i = 0; i < $2; i += 2)); do container_running "$1" || return 0; sleep 2; done; return 1; }

snapshot() { [ -d "$2/worlds" ] || return 0; tar -czf "$BK/world_$(date +%F_%H%M)_$1.tar.gz" -C "$2" worlds && log "snapshot: $1"; }

case "${1:-}" in
  on)
    [ -f "$FLAG" ] && { echo "Fallback is already on."; exit 0; }
    if container_running "$MC_CONTAINER"; then
      docker update --restart=no "$MC_CONTAINER" >/dev/null
      if [ "$(heartbeat_age)" -le 180 ]; then
        mc_send "say Switching to update mode. Back in a minute. Chat will be off for a while."
        sleep 10; mc_send "stop"
      fi
      wait_stopped "$MC_CONTAINER" 120 || docker stop -t 90 "$MC_CONTAINER" >/dev/null
    fi
    snapshot "before-fallback" "$MC_DATA"
    mkdir -p "$FB/worlds"
    [ -d "$MC_DATA/worlds" ] && rsync -a --delete "$MC_DATA/worlds/" "$FB/worlds/"
    for f in allowlist.json permissions.json; do [ -f "$MC_DATA/$f" ] && cp -f "$MC_DATA/$f" "$FB/$f"; done
    chown -R 99:100 "$FB"
    docker rm -f "$MC_CONTAINER" >/dev/null 2>&1 || true
    "${COMPOSE[@]}" --profile fallback up -d mc-vanilla
    touch "$FLAG"
    msg="Minecraft is in FALLBACK mode: plain Bedrock, newest version, chat turned off for everyone. Run mc-fallback.sh off once Endstone supports this version."
    log "$msg"; discord_post "${DISCORD_WEBHOOK_MOD:-}" "$msg"; unraid_notify "Minecraft fallback ON" "$msg" warning
    ;;
  off)
    [ -f "$FLAG" ] || { echo "Fallback isn't on."; exit 0; }
    docker stop -t 60 mc-vanilla >/dev/null || true
    snapshot "fallback-end" "$FB"
    snapshot "endstone-old" "$MC_DATA"
    rsync -a --delete "$FB/worlds/" "$MC_DATA/worlds/"
    for f in allowlist.json permissions.json; do [ -f "$FB/$f" ] && cp -f "$FB/$f" "$MC_DATA/$f"; done
    "${COMPOSE[@]}" --profile fallback rm -f mc-vanilla >/dev/null || true
    "${COMPOSE[@]}" pull -q mc-bedrock || true
    docker update --restart=unless-stopped "$MC_CONTAINER" >/dev/null 2>&1 || true
    "${COMPOSE[@]}" up -d mc-bedrock
    rm -f "$FLAG"
    msg="Minecraft is back on Endstone with the chat moderator. Check that Chat Guard checks in: docker logs --tail 30 mc-bedrock"
    log "$msg"; discord_post "${DISCORD_WEBHOOK_MOD:-}" "$msg"; unraid_notify "Minecraft fallback OFF" "$msg" normal
    ;;
  status)
    if [ -f "$FLAG" ]; then echo "Fallback ON (chat off)."; else echo "Normal (Endstone + Chat Guard)."; fi
    ;;
  *)
    sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 1
    ;;
esac
