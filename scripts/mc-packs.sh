#!/bin/bash
# Add-ons (mods) for the Minecraft world.
#   1. Copy .mcpack / .mcaddon / .zip files into \\192.168.0.128\data\minecraft-packs
#   2. Run:  mc-packs.sh            (installs them, backs up the world first, restarts the server)
#   mc-packs.sh list                (what the world uses)
#   mc-packs.sh remove "Pack Name"  (name, part of the name, or id)
# Installed files move to minecraft-packs/installed/, broken ones to minecraft-packs/failed/.

. /mnt/user/appdata/arcade/scripts/lib.sh
set -uo pipefail

DROP="/mnt/user/data/minecraft-packs"
BK="/mnt/user/backups/minecraft"
IMAGE="python:3.13-alpine"   # same base as the lobby, so usually already downloaded
mkdir -p "$DROP" "$BK"

if fallback_on; then DATA="$ARCADE/minecraft-fallback"; CT="mc-vanilla"; else DATA="$MC_DATA"; CT="$MC_CONTAINER"; fi

packs_py() {
  docker run --rm -v "$DATA":/data -v "$DROP":/drop -v "$ARCADE/scripts":/scripts:ro "$IMAGE" python3 /scripts/mc_packs.py "$@"
}

stop_mc() {
  if [ "$CT" = "mc-vanilla" ]; then
    docker stop -t 60 mc-vanilla >/dev/null
  else
    docker update --restart=no "$CT" >/dev/null 2>&1
    [ "$(heartbeat_age)" -le 180 ] && mc_send "stop"
    for _ in $(seq 1 45); do container_running "$CT" || break; sleep 2; done
    container_running "$CT" && docker stop -t 90 "$CT" >/dev/null
  fi
}

start_mc() {
  if [ "$CT" = "mc-vanilla" ]; then
    docker start mc-vanilla >/dev/null
  else
    docker update --restart=unless-stopped "$CT" >/dev/null 2>&1
    docker compose -f "$ARCADE/docker-compose.yml" up -d mc-bedrock >/dev/null
  fi
  log "started $CT"
  maintenance_off
}

case "${1:-install}" in
  list)
    packs_py list
    ;;
  install|remove)
    if [ "${1:-install}" = "install" ] && ! compgen -G "$DROP/*.[mMzZ]*" >/dev/null; then
      echo "Nothing to install. Copy .mcpack / .mcaddon files into \\\\192.168.0.128\\data\\minecraft-packs first."
      exit 0
    fi
    if [ "${1:-}" = "remove" ] && [ -z "${2:-}" ]; then echo 'Usage: mc-packs.sh remove "Pack Name"'; exit 1; fi
    docker image inspect "$IMAGE" >/dev/null 2>&1 || docker pull -q "$IMAGE" >/dev/null
    maintenance_on "The Minecraft world is installing something new. It'll be back in a minute."
    if container_running "$CT"; then
      mc_say() { if [ "$CT" = "mc-vanilla" ]; then bash "$ARCADE/scripts/mc-cmd.sh" "$1" >/dev/null 2>&1; else mc_send "$1"; fi; }
      mc_say "say Adding something new to the world. Back in a minute!"
      sleep 10
      stop_mc
    fi
    trap start_mc EXIT
    if tar -czf "$BK/world_$(date +%F_%H%M)_before-packs.tar.gz" -C "$DATA" worlds; then
      log "world backed up to $BK"
    else
      echo "Backup failed, so nothing was changed."; exit 1
    fi
    packs_py "$@"; rc=$?
    chown -R 99:100 "$DATA/behavior_packs" "$DATA/resource_packs" "$DATA/worlds" 2>/dev/null
    case $rc in
      0) echo; echo "Done. The server is restarting with the change." ;;
      3) echo; echo "Nothing changed." ;;
      *) echo; echo "Something went wrong (see above). The server restarts unchanged." ;;
    esac
    ;;
  *)
    sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 1
    ;;
esac
