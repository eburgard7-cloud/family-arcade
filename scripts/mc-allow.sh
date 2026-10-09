#!/bin/bash
# Manage the Minecraft guest list.
#   mc-allow.sh add "Gamer Tag"
#   mc-allow.sh remove "Gamer Tag"
#   mc-allow.sh list
#   mc-allow.sh reload        (after editing allowlist.json by hand)

. /mnt/user/appdata/arcade/scripts/lib.sh
FILE="$MC_DATA/allowlist.json"
fallback_on && FILE="$ARCADE/minecraft-fallback/allowlist.json"

usage() { sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }

case "${1:-}" in
  add|remove)
    [ -n "${2:-}" ] || usage
    bash "$ARCADE/scripts/mc-cmd.sh" "allowlist $1 \"$2\""
    ;;
  list)
    if [ -f "$FILE" ]; then
      grep -oE '"name"[[:space:]]*:[[:space:]]*"[^"]*"' "$FILE" | sed -E 's/.*:[[:space:]]*"([^"]*)"/\1/' | sort -f
    else
      echo "No guest list yet ($FILE not found)."
    fi
    ;;
  reload)
    bash "$ARCADE/scripts/mc-cmd.sh" "allowlist reload"
    ;;
  *)
    usage
    ;;
esac
