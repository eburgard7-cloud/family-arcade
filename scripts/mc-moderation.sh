#!/bin/bash
# Chat Guard watchdog + alerts (User Scripts, custom cron: * * * * *)
#   1. If the moderator stops checking in while Minecraft is running, stop
#      Minecraft (no unmoderated chat) and alert you.
#   2. Send new moderation flags to Discord #mod-alerts and Unraid notifications.
#      Alerts carry the player name and what kind of thing happened, never the
#      personal info itself. Full messages stay in moderation/logs on the server.
#   3. Write state/minecraft.json so the lobby can say whether chat is moderated.

. /mnt/user/appdata/arcade/scripts/lib.sh
mkdir -p "$STATE_DIR"
now=$(date +%s)
chat="none"

# ---------- 1. watchdog ----------
if container_running "$MC_CONTAINER"; then
  started=$(docker inspect -f '{{.State.StartedAt}}' "$MC_CONTAINER")
  up=$(( now - $(date -d "$started" +%s) ))
  age=$(heartbeat_age)
  if [ "$age" -le 180 ]; then
    chat="moderated"
  elif [ "$up" -gt 600 ]; then
    log "Chat Guard silent for ${age}s; stopping $MC_CONTAINER"
    docker stop -t 90 "$MC_CONTAINER" >/dev/null
    msg="Minecraft was stopped because the chat moderator stopped responding. Kids can't join until it's fixed. Check: docker logs --tail 80 mc-bedrock"
    discord_post "${DISCORD_WEBHOOK_MOD:-}" "$msg"
    unraid_notify "Minecraft stopped: chat moderator down" "$msg" alert
  fi
elif container_running mc-vanilla; then
  chat="off"
fi

printf '{"chat":"%s","updated":%s}\n' "$chat" "$now" > "$STATE_DIR/minecraft.json.tmp"
chmod 644 "$STATE_DIR/minecraft.json.tmp"
mv -f "$STATE_DIR/minecraft.json.tmp" "$STATE_DIR/minecraft.json"

# ---------- 2. flags ----------
F="$MOD_DIR/flags.jsonl"
OFF="$STATE_DIR/flags.offset"
[ -f "$F" ] || exit 0
size=$(stat -c %s "$F")
off=$(cat "$OFF" 2>/dev/null || echo 0)
[ "$size" -lt "$off" ] && off=0
[ "$size" -eq "$off" ] && exit 0

field() { sed -n "s/.*\"$1\": *\"\\([^\"]*\\)\".*/\\1/p" <<<"$2"; }

lines=()
while IFS= read -r line; do
  [ -n "$line" ] || continue
  player=$(field player "$line"); detail=$(field detail "$line"); action=$(field action "$line")
  lines+=("- ${player}: ${detail} (${action})")
done < <(tail -c +$((off + 1)) "$F" | head -c $((size - off)))
echo "$size" > "$OFF"

[ "${#lines[@]}" -gt 0 ] || exit 0
body=$(printf '%s\n' "${lines[@]}")
[ "${#body}" -gt 1800 ] && body="${body:0:1800}"$'\n(more in moderation/flags.jsonl)'
discord_post "${DISCORD_WEBHOOK_MOD:-}" "Minecraft chat moderator:"$'\n'"$body"
unraid_notify "Minecraft chat: ${#lines[@]} flag(s)" "$(head -n 3 <<<"$body")" warning
exit 0
