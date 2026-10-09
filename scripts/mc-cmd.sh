#!/bin/bash
# Run Minecraft console commands through Chat Guard, then show the server's reply.
#   mc-cmd.sh "say Dinner in 10 minutes"
#   mc-cmd.sh list
#   mc-cmd.sh 'kick "Gamer Tag"'
#   mc-cmd.sh "op \"Your Gamertag\""        (the player must be online)
#   mc-cmd.sh "mute Gamer Tag 10"            (Chat Guard: chat off for 10 minutes)
#   mc-cmd.sh "unmute Gamer Tag"
#   mc-cmd.sh reload-moderation              (after editing settings.json or word lists)

. /mnt/user/appdata/arcade/scripts/lib.sh

[ $# -gt 0 ] || { sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }

if fallback_on; then
  container_running mc-vanilla || { echo "mc-vanilla isn't running."; exit 1; }
  since=$(date +%s)
  # Write straight to the Bedrock process's console (like itzg's send-command, but
  # without tripping over PID 1, which belongs to root and can't be inspected).
  for c in "$@"; do
    docker exec -u 99:100 mc-vanilla sh -c '
      for p in /proc/[0-9]*; do
        case "$(readlink "$p/exe" 2>/dev/null)" in
          /data/bedrock_server*) printf "%s\n" "$1" > "$p/fd/0" && exit 0 ;;
        esac
      done
      echo "Bedrock server process not found"; exit 2' _ "$c"
  done
  sleep 3
  docker logs --since "$since" mc-vanilla 2>&1 | grep -v '^\s*$' | tail -n 15
  exit 0
fi

if ! container_running "$MC_CONTAINER"; then
  echo "$MC_CONTAINER isn't running."; exit 1
fi
age=$(heartbeat_age)
if [ "$age" -gt 180 ]; then
  echo "Chat Guard hasn't checked in for ${age}s, so it can't take commands. Check: docker logs --tail 50 $MC_CONTAINER"
  exit 1
fi

since=$(date +%s)
mc_send "$@"
sleep 3
docker logs --since "$since" "$MC_CONTAINER" 2>&1 | grep -v '^\s*$' | tail -n 15
