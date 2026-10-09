#!/bin/bash
# Nightly Minecraft maintenance (User Scripts, custom cron: 0 4 * * *)
#   1. Warns players, then stops the server cleanly (Chat Guard runs "stop")
#   2. Archives the world, guest list, permissions and moderation settings
#   3. Pulls the newest Endstone image (= newest supported Bedrock version)
#   4. Starts the server again, and keeps the newest $KEEP archives
# The server is always started again, even if the backup fails.
# In fallback mode (mc-vanilla running), it backs up and restarts that instead.

. /mnt/user/appdata/arcade/scripts/lib.sh
set -uo pipefail

DEST="/mnt/user/backups/minecraft"
KEEP=14
COMPOSE=(docker compose -f "$ARCADE/docker-compose.yml")
mkdir -p "$DEST"

wait_stopped() {  # wait_stopped <container> <seconds>
  local i
  for ((i = 0; i < $2; i += 2)); do
    container_running "$1" || return 0
    sleep 2
  done
  return 1
}

backup() {  # backup <data dir> <label>
  local data=$1 label=$2 items=() f archive
  for f in worlds allowlist.json permissions.json server.properties \
           moderation/settings.json moderation/wordlists moderation/mutes.json; do
    [ -e "$data/$f" ] && items+=("$f")
  done
  archive="$DEST/world_$(date +%F_%H%M)${label}.tar.gz"
  rm -f "$DEST"/*.partial
  if tar -czf "$archive.partial" -C "$data" "${items[@]}" && mv -f "$archive.partial" "$archive"; then
    log "backup written: $archive ($(du -h "$archive" | cut -f1))"
  else
    log "ERROR: backup failed"
    discord_post "${DISCORD_WEBHOOK_MOD:-}" "Minecraft nightly backup FAILED. Check the User Scripts log for mc-nightly."
    unraid_notify "Minecraft backup failed" "Check the mc-nightly log" alert
  fi
  mapfile -t old < <(ls -1t "$DEST"/world_*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)))
  [ "${#old[@]}" -gt 0 ] && rm -f -- "${old[@]}" && log "pruned ${#old[@]} old backup(s)"
}

# ---------- fallback mode ----------
if fallback_on || container_running mc-vanilla; then
  log "fallback mode: backing up mc-vanilla"
  maintenance_on "The Minecraft world is doing its nightly backup. It'll be back in a few minutes."
  trap 'docker start mc-vanilla >/dev/null && log "started mc-vanilla"; sleep 30; maintenance_off' EXIT
  docker stop -t 60 mc-vanilla >/dev/null || true
  backup "$ARCADE/minecraft-fallback" "_fallback"
  exit 0
fi

# ---------- normal mode ----------
restart() {
  docker update --restart=unless-stopped "$MC_CONTAINER" >/dev/null 2>&1
  if "${COMPOSE[@]}" up -d mc-bedrock >/dev/null 2>&1; then
    log "started $MC_CONTAINER"
    # Bedrock takes a moment to come up (longer when it's updating).
    for _ in $(seq 1 60); do [ "$(heartbeat_age)" -le 30 ] && break; sleep 5; done
    maintenance_off
  else
    log "ERROR: could not start $MC_CONTAINER"
    discord_post "${DISCORD_WEBHOOK_MOD:-}" "Minecraft didn't start after the nightly backup. Check: docker logs --tail 50 mc-bedrock"
    unraid_notify "Minecraft didn't restart" "docker logs --tail 50 mc-bedrock" alert
  fi
}
trap restart EXIT
maintenance_on "The Minecraft world is doing its nightly backup and update. It'll be back in a few minutes."

if container_running "$MC_CONTAINER"; then
  docker update --restart=no "$MC_CONTAINER" >/dev/null   # so the clean stop isn't undone by Docker
  if [ "$(heartbeat_age)" -le 180 ]; then
    mc_send "say The server restarts in 20 seconds for its nightly update. Your stuff is saved."
    sleep 20
    log "asking Chat Guard to stop the server"
    mc_send "stop"
    wait_stopped "$MC_CONTAINER" 120 || { log "still running after 120s; sending docker stop"; docker stop -t 90 "$MC_CONTAINER" >/dev/null; }
  else
    log "Chat Guard not responding; using docker stop"
    docker stop -t 90 "$MC_CONTAINER" >/dev/null
  fi
fi

backup "$MC_DATA" ""

before=$(docker image inspect -f '{{.Id}}' endstone/endstone:latest 2>/dev/null)
"${COMPOSE[@]}" pull -q mc-bedrock >/dev/null 2>&1 || log "WARNING: image pull failed; keeping current version"
after=$(docker image inspect -f '{{.Id}}' endstone/endstone:latest 2>/dev/null)
if [ "$before" != "$after" ]; then log "new Endstone image pulled; Bedrock will update on start"; fi
exit 0
