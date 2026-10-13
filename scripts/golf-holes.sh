#!/bin/bash
# Finsonly Golf: generate the famous holes (all, or the ids given) and install the pack.
#   golf-holes.sh              every hole in golf/maker/holegen/presets.json
#   golf-holes.sh augusta12    just one
exec bash /mnt/user/appdata/arcade/scripts/golf-pack.sh holes "$@"
