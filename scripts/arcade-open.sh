#!/bin/bash
# Opens the game room: starts the Arcade VM and posts to the adults' Discord.
# Run from User Scripts before game night, or schedule it (e.g. "45 17 * * 5" = Fridays 5:45 PM).

. /mnt/user/appdata/arcade/scripts/lib.sh
VM="Arcade"

if [ "$(virsh domstate "$VM" 2>/dev/null)" = "running" ]; then
  echo "$VM is already running."
  exit 0
fi

if virsh start "$VM"; then
  echo "$VM starting. Windows signs in and the game menu opens on its own in about a minute."
  bash "$ARCADE/scripts/arcade-state.sh"
  sleep 90
  discord_post "${DISCORD_WEBHOOK_GAMENIGHT:-}" "The game room is open. Hop in the #${DISCORD_VOICE_CHANNEL:-game-night} voice channel, then connect to Finsonly Arcade in Parsec."
else
  echo "Could not start $VM."
  exit 1
fi
