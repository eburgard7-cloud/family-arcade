#!/bin/bash
# Finsonly Golf: build the golf add-on from this repo and install it.
#   golf-pack.sh                  build + install (after arcade-update pulls a new version)
#   golf-pack.sh holes            also (re)generate every famous hole, then build + install
#   golf-pack.sh holes pebble7    just these holes (ids are in golf/maker/holegen/presets.json)
#   golf-pack.sh build            build only: the .mcaddon lands in minecraft-packs, not installed
# Famous holes download OpenStreetMap + USGS/Copernicus terrain (cached in state/golf).

. /mnt/user/appdata/arcade/scripts/lib.sh
set -uo pipefail

DROP="/mnt/user/data/minecraft-packs"
GEN="$STATE_DIR/golf"          # generated holes + download cache (not in git)
IMAGE="python:3.13-slim"
mkdir -p "$DROP" "$GEN/out" "$GEN/cache" "$GEN/pip"

py() {
  docker run --rm \
    -v "$ARCADE/golf":/golf -v "$GEN":/gen -v "$DROP":/drop \
    -e HOLEGEN_OUT=/gen/out -e HOLEGEN_CACHE=/gen/cache -e PIP_CACHE_DIR=/gen/pip \
    "$IMAGE" sh -c "$1"
}

mode="${1:-install}"
docker image inspect "$IMAGE" >/dev/null 2>&1 || docker pull -q "$IMAGE" >/dev/null

if [ "$mode" = "holes" ]; then
  shift
  log "generating famous holes: ${*:-all}"
  py "pip install -q --root-user-action=ignore numpy pillow tifffile imagecodecs && python3 /golf/maker/holegen/holegen.py $*" || {
    echo "Hole generation failed (see above). Nothing installed."; exit 1; }
fi

log "building the golf pack"
rm -f "$DROP"/finsonly-golf-*.mcaddon
py "python3 /golf/maker/build_pack.py --overlay /gen/out --out /drop" || { echo "Build failed."; exit 1; }
chown -R 99:100 "$GEN" "$DROP" 2>/dev/null

if [ "$mode" = "build" ]; then
  echo "Built. The .mcaddon is in \\\\192.168.0.128\\data\\minecraft-packs; run mc-packs to install it."
  exit 0
fi
bash "$ARCADE/scripts/mc-packs.sh" install
