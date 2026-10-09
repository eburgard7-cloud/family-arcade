#!/usr/bin/env python3
"""Install, list and remove Bedrock add-ons (behavior and resource packs).

Run by mc-packs.sh inside a throwaway python container (Unraid has no Python):
    /data   the Minecraft server folder (server.properties, worlds/, *_packs/)
    /drop   the drop folder people copy .mcpack / .mcaddon / .zip files into

Commands:
    install            install every file in /drop, then move it to /drop/installed/
    list               show the packs the world uses
    remove <name|id>   take a pack out of the world and delete its folder

Exit codes: 0 = something changed (restart needed), 3 = nothing to do, 2 = error.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import sys
import tempfile
import time
import zipfile
from pathlib import Path

DATA = Path(os.environ.get("PACKS_DATA", "/data"))
DROP = Path(os.environ.get("PACKS_DROP", "/drop"))
ARCHIVES = (".mcpack", ".mcaddon", ".zip")
KINDS = {"behavior": "behavior_packs", "resource": "resource_packs"}
CHANGED, NOTHING, ERROR = 0, 3, 2


# ---------- helpers ----------
def lenient_json(text: str):
    """Pack manifests often have comments or trailing commas; strip them."""
    text = text.lstrip("﻿")
    out, i, in_str = [], 0, False
    while i < len(text):
        c = text[i]
        if in_str:
            out.append(c)
            if c == "\\" and i + 1 < len(text):
                out.append(text[i + 1]); i += 2; continue
            if c == '"':
                in_str = False
        elif c == '"':
            in_str = True; out.append(c)
        elif text.startswith("//", i):
            j = text.find("\n", i); i = len(text) if j < 0 else j; continue
        elif text.startswith("/*", i):
            j = text.find("*/", i + 2); i = len(text) if j < 0 else j + 2; continue
        else:
            out.append(c)
        i += 1
    cleaned = re.sub(r",(\s*[}\]])", r"\1", "".join(out))
    return json.loads(cleaned)


def read_manifest(pack_dir: Path):
    try:
        return lenient_json((pack_dir / "manifest.json").read_text(encoding="utf-8", errors="replace"))
    except Exception:
        return None


def level_name() -> str:
    props = DATA / "server.properties"
    if props.exists():
        for line in props.read_text(encoding="utf-8", errors="replace").splitlines():
            if line.startswith("level-name="):
                return line.split("=", 1)[1].strip() or "Bedrock level"
    return "Bedrock level"


def world_dir() -> Path:
    return DATA / "worlds" / level_name()


def world_json(kind: str) -> Path:
    return world_dir() / f"world_{kind}_packs.json"


def load_list(path: Path) -> list:
    if not path.exists():
        return []
    try:
        data = lenient_json(path.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except Exception:
        return []


def save_list(path: Path, items: list) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(items, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def norm_version(v):
    if isinstance(v, list):
        return v
    if isinstance(v, str):
        parts = re.match(r"^(\d+)\.(\d+)\.(\d+)", v)
        if parts:
            return [int(x) for x in parts.groups()]
    return v


def show_version(v) -> str:
    return ".".join(str(x) for x in v) if isinstance(v, list) else str(v)


def clean_name(name: str) -> str:
    return re.sub(r"§.", "", name or "").strip()


def display_name(man: dict | None, folder: Path | None) -> str:
    name = clean_name((man or {}).get("header", {}).get("name", ""))
    if (not name or ("." in name and " " not in name)) and folder is not None:  # localisation key
        name = re.sub(r"_[0-9a-fA-F]{8}$", "", folder.name).replace("_", " ")
    return name


def classify(manifest: dict) -> str | None:
    types = {str(m.get("type", "")).lower() for m in manifest.get("modules", []) if isinstance(m, dict)}
    if "resources" in types:
        return "resource"
    if types & {"data", "script", "javascript", "client_data"}:
        return "behavior"
    return None  # skin packs, world templates, ...


def needs_beta(manifest: dict) -> bool:
    for dep in manifest.get("dependencies", []) or []:
        if isinstance(dep, dict) and str(dep.get("module_name", "")).startswith("@minecraft/"):
            if "beta" in str(dep.get("version", "")).lower():
                return True
    return False


def extract(archive: Path, dest: Path) -> None:
    """Unzip, then unzip any packs nested inside (.mcaddon files hold several)."""
    with zipfile.ZipFile(archive) as z:
        for member in z.namelist():
            target = (dest / member).resolve()
            if not str(target).startswith(str(dest.resolve())):
                raise ValueError(f"unsafe path in archive: {member}")
        z.extractall(dest)
    for _ in range(3):
        nested = [p for p in dest.rglob("*") if p.is_file() and p.suffix.lower() in ARCHIVES]
        if not nested:
            break
        for n in nested:
            sub = n.with_name(n.stem + "__unpacked")
            sub.mkdir(exist_ok=True)
            extract(n, sub)
            n.unlink()


def find_pack_dirs(root: Path) -> list[Path]:
    found: list[Path] = []
    for m in sorted(root.rglob("manifest.json"), key=lambda p: len(p.parts)):
        d = m.parent
        if not any(parent in found for parent in d.parents):
            found.append(d)
    return found


def installed_index() -> dict:
    """uuid -> (kind, folder, manifest) for every pack folder on the server."""
    idx = {}
    for kind, folder in KINDS.items():
        base = DATA / folder
        if not base.is_dir():
            continue
        for d in base.iterdir():
            if d.is_dir():
                man = read_manifest(d)
                if man and isinstance(man.get("header"), dict):
                    idx.setdefault(man["header"].get("uuid", ""), (kind, d, man))
    return idx


def set_texturepack_required() -> bool:
    props = DATA / "server.properties"
    if not props.exists():
        return False
    lines = props.read_text(encoding="utf-8", errors="replace").splitlines()
    for i, line in enumerate(lines):
        if line.startswith("texturepack-required="):
            if line.strip() == "texturepack-required=true":
                return False
            lines[i] = "texturepack-required=true"
            break
    else:
        lines.append("texturepack-required=true")
    props.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return True


# ---------- commands ----------
def install() -> int:
    files = sorted(p for p in DROP.iterdir() if p.is_file() and p.suffix.lower() in ARCHIVES) if DROP.is_dir() else []
    if not files:
        print(f"No .mcpack, .mcaddon or .zip files in the drop folder.")
        return NOTHING
    if not world_dir().is_dir():
        print(f"ERROR: world folder not found: {world_dir()}. Start the server once first.")
        return ERROR

    stamp = time.strftime("%Y-%m-%d_%H%M")
    (DROP / "installed").mkdir(exist_ok=True)
    (DROP / "failed").mkdir(exist_ok=True)
    changed, resource_added = False, False

    for f in files:
        print(f"\n== {f.name}")
        try:
            with tempfile.TemporaryDirectory() as tmp:
                tmp = Path(tmp)
                extract(f, tmp)
                packs = find_pack_dirs(tmp)
                if not packs:
                    raise ValueError("no manifest.json inside; this isn't a Bedrock pack")
                done = 0
                for d in packs:
                    man = read_manifest(d)
                    if not man or not isinstance(man.get("header"), dict):
                        print(f"   skipped {d.name}: unreadable manifest.json")
                        continue
                    h = man["header"]
                    uuid, ver = h.get("uuid"), norm_version(h.get("version"))
                    name = clean_name(h.get("name", ""))
                    if not name or "." in name and " " not in name:  # localisation key like pack.name
                        name = f.stem
                    kind = classify(man)
                    if kind is None or not uuid:
                        print(f"   skipped '{name}': not a behavior or resource pack (skin pack or world template?)")
                        continue
                    base = DATA / KINDS[kind]
                    base.mkdir(exist_ok=True)
                    # Replace an older copy of the same pack.
                    for other in base.iterdir():
                        om = read_manifest(other) if other.is_dir() else None
                        if om and om.get("header", {}).get("uuid") == uuid and not other.name.startswith(("vanilla", "chemistry", "experimental")):
                            shutil.rmtree(other)
                    folder = re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("_")[:50] or "pack"
                    target = base / f"{folder}_{uuid[:8]}"
                    shutil.copytree(d, target)
                    entries = [e for e in load_list(world_json(kind)) if e.get("pack_id") != uuid]
                    entries.append({"pack_id": uuid, "version": ver})
                    save_list(world_json(kind), entries)
                    print(f"   installed {kind} pack '{name}' v{show_version(ver)}")
                    if needs_beta(man):
                        print("   WARNING: this pack uses Minecraft's beta scripting. It only runs in worlds with the")
                        print("            'Beta APIs' experiment turned on, so it may do nothing here.")
                    if kind == "resource":
                        resource_added = True
                    done += 1
                    changed = True
                if not done:
                    raise ValueError("nothing installable inside")
            shutil.move(str(f), str(DROP / "installed" / f"{stamp}_{f.name}"))
        except Exception as e:  # keep going with the other files
            print(f"   FAILED: {e}")
            shutil.move(str(f), str(DROP / "failed" / f"{stamp}_{f.name}"))

    if resource_added and set_texturepack_required():
        print("\nResource pack added: players will be asked to download it when they join (texturepack-required=true).")
    return CHANGED if changed else NOTHING


def list_packs() -> int:
    idx = installed_index()
    any_ = False
    for kind in KINDS:
        for e in load_list(world_json(kind)):
            uuid = e.get("pack_id", "")
            info = idx.get(uuid)
            name = display_name(info[2], info[1]) if info else "(folder missing)"
            folder = info[1].name if info else "-"
            print(f"{kind:9} {name[:40]:40} v{show_version(e.get('version')):10} {uuid}  [{folder}]")
            any_ = True
    if not any_:
        print("No add-ons installed in this world.")
    return CHANGED


def remove(query: str) -> int:
    q = query.lower()
    idx = installed_index()
    matches = []
    for kind in KINDS:
        for e in load_list(world_json(kind)):
            uuid = e.get("pack_id", "")
            info = idx.get(uuid)
            name = display_name(info[2], info[1]) if info else ""
            folder = info[1].name if info else ""
            if uuid.lower().startswith(q) or q in name.lower() or q in folder.lower():
                matches.append((kind, uuid, name, info))
    if not matches:
        print(f"No installed pack matches '{query}'. See: mc-packs.sh list")
        return NOTHING
    if len(q) < 3:
        print("Use at least 3 letters of the pack's name (or its id).")
        return ERROR
    # An add-on is usually a behavior + resource pair with the same name; remove every match.
    for kind, uuid, name, info in matches:
        save_list(world_json(kind), [e for e in load_list(world_json(kind)) if e.get("pack_id") != uuid])
        if info and not info[1].name.startswith(("vanilla", "chemistry", "experimental")):
            shutil.rmtree(info[1])
        print(f"Removed {kind} pack '{name or uuid}'.")
    return CHANGED


def main(argv: list[str]) -> int:
    cmd = argv[1] if len(argv) > 1 else "install"
    if cmd == "install":
        return install()
    if cmd == "list":
        return list_packs()
    if cmd == "remove" and len(argv) > 2:
        return remove(" ".join(argv[2:]))
    print(__doc__)
    return ERROR


if __name__ == "__main__":
    sys.exit(main(sys.argv))
