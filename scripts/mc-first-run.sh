#!/bin/bash
# One-time world rules for a family server. Saved in the world itself, so run once
# after the first start. Delete any line you don't want before running.

. /mnt/user/appdata/arcade/scripts/lib.sh

bash "$ARCADE/scripts/mc-cmd.sh" \
  "gamerule keepinventory true" \
  "gamerule mobgriefing false" \
  "gamerule tntexplodes false" \
  "gamerule dofiretick false" \
  "gamerule pvp false" \
  "gamerule showcoordinates true"
# keepinventory:   dying doesn't drop your items (far fewer tears)
# mobgriefing:     creepers can't blow holes in builds
# tntexplodes:     TNT can't wreck someone else's house
# dofiretick:      fire doesn't spread and burn builds down
# pvp:             players can't hurt each other
# showcoordinates: easier to tell each other where you are
