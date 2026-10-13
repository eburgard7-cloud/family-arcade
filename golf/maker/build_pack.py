#!/usr/bin/env python3
"""Zip the golf pack into dist/finsonly-golf-<version>.mcaddon.

    python3 golf/maker/build_pack.py [--overlay DIR] [--out DIR]

--overlay DIR  generated famous holes (holegen with HOLEGEN_OUT=DIR): adds
               DIR/structures/** to the behavior pack and uses DIR/legends_data.js
--out DIR      where to write the .mcaddon (default golf/dist)

Drop the .mcaddon into \\\\192.168.0.128\\data\\minecraft-packs and run mc-packs.
The version comes from pack/BP/manifest.json; bump it in make_assets.py (VERSION)
for every release so mc-packs replaces the old copy.

Never change the pack UUIDs: courses are saved in world dynamic properties,
which Minecraft keys by behavior pack UUID.
"""
from __future__ import annotations

import io
import json
import sys
import zipfile
from pathlib import Path

GOLF = Path(__file__).resolve().parents[1]
PACK = GOLF / "pack"
DIST = GOLF / "dist"
SKIP = {".DS_Store", "Thumbs.db"}


def zip_dir(src: Path, overlay: Path | None = None) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        replaced = set()
        if overlay:
            data_js = overlay / "legends_data.js"
            if data_js.is_file():
                z.write(data_js, "scripts/mc/legends_data.js")
                replaced.add("scripts/mc/legends_data.js")
            for f in sorted((overlay / "structures").rglob("*.mcstructure")):
                rel = "structures/" + f.relative_to(overlay / "structures").as_posix()
                z.write(f, rel)
                replaced.add(rel)
        for f in sorted(src.rglob("*")):
            rel = f.relative_to(src).as_posix()
            if f.is_file() and f.name not in SKIP and rel not in replaced:
                z.write(f, rel)
    return buf.getvalue()


def main() -> int:
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--overlay", type=Path)
    ap.add_argument("--out", type=Path, default=DIST)
    a = ap.parse_args()
    for kind in ("BP", "RP"):
        for j in (PACK / kind).rglob("*.json"):
            try:
                json.loads(j.read_text())
            except Exception as e:  # noqa: BLE001
                print(f"bad JSON: {j}: {e}")
                return 2
    man = json.loads((PACK / "BP" / "manifest.json").read_text())
    ver = ".".join(str(x) for x in man["header"]["version"])
    a.out.mkdir(parents=True, exist_ok=True)
    out = a.out / f"finsonly-golf-{ver}.mcaddon"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_STORED) as z:
        z.writestr("finsonly_golf_BP.mcpack", zip_dir(PACK / "BP", a.overlay))
        z.writestr("finsonly_golf_RP.mcpack", zip_dir(PACK / "RP"))
    print(f"{out}  ({out.stat().st_size // 1024} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
