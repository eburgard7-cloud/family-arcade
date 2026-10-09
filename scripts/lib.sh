#!/bin/bash
# Shared helpers for the arcade scripts. Sourced, not run.

ARCADE="/mnt/user/appdata/arcade"
MC_DATA="$ARCADE/minecraft"
MOD_DIR="$MC_DATA/moderation"
STATE_DIR="$ARCADE/state"
MC_CONTAINER="mc-bedrock"

# shellcheck disable=SC1091
[ -f "$ARCADE/.env" ] && . "$ARCADE/.env"

log() { echo "$(date '+%F %T') $*"; }

json_escape() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\r'/}
  s=${s//$'\t'/ }
  printf '%s' "$s"
}

# discord_post <webhook-url> <message>
discord_post() {
  local url=$1 msg=$2
  [ -n "$url" ] || return 0
  curl -fsS -m 10 -H "Content-Type: application/json" \
    -d "{\"content\":\"$(json_escape "$msg")\",\"allowed_mentions\":{\"parse\":[]}}" \
    "$url" >/dev/null || log "WARNING: Discord post failed"
}

# unraid_notify <subject> <description> [normal|warning|alert]
unraid_notify() {
  [ "${UNRAID_NOTIFY:-1}" = "1" ] || return 0
  local n=/usr/local/emhttp/webGui/scripts/notify
  [ -x "$n" ] && "$n" -e "Family Arcade" -s "$1" -d "$2" -i "${3:-normal}" >/dev/null 2>&1
  return 0
}

# Chat-off mode: plain Bedrock (mc-vanilla) instead of Endstone. See mc-fallback.sh.
fallback_on() { [ -f "$STATE_DIR/fallback-on" ]; }

container_running() {
  [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = "true" ]
}

# Seconds since the Chat Guard heartbeat was written; 999999 if missing.
heartbeat_age() {
  local f="$MOD_DIR/heartbeat.json" t
  [ -f "$f" ] || { echo 999999; return; }
  t=$(sed -n 's/.*"time": *\([0-9]*\).*/\1/p' "$f")
  [ -n "$t" ] || { echo 999999; return; }
  echo $(( $(date +%s) - t ))
}

# mc_send <command line>... : hands console commands to Chat Guard's inbox.
mc_send() {
  mkdir -p "$MOD_DIR/inbox"
  local tmp="$MOD_DIR/inbox/$(date +%s%N).tmp"
  printf '%s\n' "$@" > "$tmp"
  chmod 666 "$tmp"
  mv -f "$tmp" "${tmp%.tmp}.cmd"
}

# maintenance_on "<message>" / maintenance_off : the lobby shows a banner while on.
maintenance_on() {
  mkdir -p "$STATE_DIR"
  printf '{"active":true,"started":%s,"message":"%s"}\n' "$(date +%s)" "$(json_escape "$1")" > "$STATE_DIR/maintenance.json.tmp"
  chmod 644 "$STATE_DIR/maintenance.json.tmp"; mv -f "$STATE_DIR/maintenance.json.tmp" "$STATE_DIR/maintenance.json"
}
maintenance_off() {
  mkdir -p "$STATE_DIR"
  printf '{"active":false,"started":%s}\n' "$(date +%s)" > "$STATE_DIR/maintenance.json.tmp"
  chmod 644 "$STATE_DIR/maintenance.json.tmp"; mv -f "$STATE_DIR/maintenance.json.tmp" "$STATE_DIR/maintenance.json"
}
