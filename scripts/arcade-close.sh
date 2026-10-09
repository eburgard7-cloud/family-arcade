#!/bin/bash
# Closes the game room: asks Windows to shut down cleanly and posts to Discord.
# Schedule after game night if you like (e.g. "30 20 * * 5").

. /mnt/user/appdata/arcade/scripts/lib.sh
VM="Arcade"
WAIT=240

if [ "$(virsh domstate "$VM" 2>/dev/null)" != "running" ]; then
  echo "$VM is not running."
  bash "$ARCADE/scripts/arcade-state.sh"
  exit 0
fi

virsh shutdown "$VM"
for ((i = 0; i < WAIT; i += 5)); do
  sleep 5
  if [ "$(virsh domstate "$VM" 2>/dev/null)" != "running" ]; then
    echo "$VM shut down after ${i}s."
    bash "$ARCADE/scripts/arcade-state.sh"
    discord_post "${DISCORD_WEBHOOK_GAMENIGHT:-}" "The game room is closed for tonight. Thanks for playing."
    exit 0
  fi
done

# Not forcing it off: Windows may be installing updates. Check the VM console.
echo "WARNING: $VM is still running after ${WAIT}s. Open its VNC console in the VMs tab to see why."
bash "$ARCADE/scripts/arcade-state.sh"
exit 1
