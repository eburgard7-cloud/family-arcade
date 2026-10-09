#!/bin/bash
# Get the latest arcade files from GitHub and apply them.
#   arcade-update.sh           update (edits you made on Tower are sent to GitHub first)
#   arcade-update.sh status    what's changed on Tower, and what's waiting on GitHub
#
# Only files tracked in the repo are touched. The world, backups, .env and logs are
# never in git (see .gitignore).

. /mnt/user/appdata/arcade/scripts/lib.sh
set -uo pipefail
cd "$ARCADE" || exit 1
git() { command git -c safe.directory="$ARCADE" "$@"; }

[ -d .git ] || { echo "GitHub isn't set up in $ARCADE yet. See README.md, 'One-time GitHub setup'."; exit 1; }

if [ "${1:-}" = "status" ]; then
  git fetch -q origin || echo "WARNING: couldn't reach GitHub"
  git status -sb
  echo "Waiting on GitHub:"; git log --oneline HEAD..@{u} | sed 's/^/  /'
  exit 0
fi

old=$(git rev-parse HEAD)

# 1. Keep edits made on Tower (config.json, word lists...). Tracked files only.
if ! git diff --quiet || ! git diff --cached --quiet; then
  git add -u
  git commit -q -m "Edits on Tower $(date '+%F %H:%M')"
  log "saved your edits on Tower"
fi

# 2. Get updates.
if ! git pull -q --no-rebase --no-edit; then
  git merge --abort 2>/dev/null
  echo "Your edits on Tower and the GitHub version changed the same lines, so nothing was updated."
  echo "Send Claude the output of:  git -C $ARCADE log --oneline -3; git -C $ARCADE diff HEAD @{u} --stat"
  exit 1
fi

# 3. Send Tower's edits to GitHub (needs the deploy key with write access).
if [ -n "$(git log --oneline @{u}..HEAD 2>/dev/null)" ]; then
  if git push -q; then log "sent your edits to GitHub"; else log "WARNING: couldn't push to GitHub; your edits are still saved on Tower"; fi
fi

chmod +x scripts/*.sh
new=$(git rev-parse HEAD)
if [ "$old" = "$new" ]; then echo "Already up to date."; exit 0; fi

echo "Updated:"
git log --oneline --no-merges "$old..$new" | sed 's/^/  /'
changed=$(git diff --name-only "$old" "$new")

# 4. Apply what changed.
if grep -qE '^(lobby/|docker-compose\.yml)' <<<"$changed"; then
  log "rebuilding the lobby"
  docker compose -f "$ARCADE/docker-compose.yml" up -d --build lobby >/dev/null 2>&1 && log "lobby rebuilt" || log "WARNING: lobby rebuild failed: cd $ARCADE && docker compose up -d --build lobby"
fi
if grep -q '^lobby-config/config.json' <<<"$changed"; then
  if docker exec arcade-lobby python3 -m json.tool /config/config.json >/dev/null 2>&1; then
    log "lobby page content updated (live now)"
  else
    log "WARNING: lobby-config/config.json has a typo; the lobby keeps showing the last good version"
  fi
fi
if grep -q '^minecraft-seed/plugins/' <<<"$changed" && ! fallback_on; then
  cp -f "$ARCADE"/minecraft-seed/plugins/*.whl "$MC_DATA/plugins/" && chown 99:100 "$MC_DATA"/plugins/*.whl
  log "Minecraft plugins updated; they load at the next restart (4 AM, or now: docker restart mc-bedrock)"
fi
if grep -q '^docker-compose\.yml' <<<"$changed"; then
  if fallback_on; then c="docker compose --profile fallback up -d mc-vanilla"; else c="docker compose up -d mc-bedrock"; fi
  log "NOTE: docker-compose.yml changed. To apply it to Minecraft (kicks players for a minute): cd $ARCADE && $c"
fi
if grep -q '^caddy/' <<<"$changed"; then
  log "NOTE: caddy/play.Caddyfile changed. Copy the change into your Caddyfile and reload Caddy."
fi
exit 0
