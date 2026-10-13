#!/usr/bin/env python3
"""Build famous real golf holes for the Minecraft golf pack.

    holegen.py                      build every hole in presets.json
    holegen.py sawgrass17 pebble7   build some
    holegen.py --synthetic          build a made-up test hole (no internet; used by tests)

Inputs
  * Course layout: OpenStreetMap (Overpass API). golf=hole gives the tee-to-green
    line and par; golf=tee/fairway/green/bunker/rough, water, woods, buildings and
    paths are painted from their polygons.
  * Terrain: USGS 3DEP 1 m bare-earth lidar for US holes, Copernicus GLO-30 (30 m)
    elsewhere.

Outputs (written into the pack)
  * pack/BP/structures/golf/<id>_<i>_<j>.mcstructure   64 x H x 64 tiles
  * pack/BP/scripts/mc/legends_data.js                 tees, pin, par, green contours

Scale is 1 block = 1 meter. Greens and tees are flattened to one block level; the
real green contours (from lidar) go into the putting-slope grid instead, because
1 m blocks can't show a 2 % slope.

Map data © OpenStreetMap contributors (ODbL). Elevation: USGS 3DEP (public
domain); Copernicus DEM © DLR/Airbus, provided under COPERNICUS by the EU and ESA.
"""
from __future__ import annotations

import argparse
import io
import json
import math
import os
import re
import sys
import time
import urllib.parse
import urllib.request
import zlib
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent))
import nbt  # noqa: E402

HERE = Path(__file__).resolve().parent
GOLF = HERE.parents[1]
PACK_BP = GOLF / "pack" / "BP"
# HOLEGEN_OUT (set on Tower) keeps generated files out of the git checkout;
# build_pack.py --overlay merges them into the pack.
_OUT = os.environ.get("HOLEGEN_OUT")
STRUCT_DIR = Path(_OUT) / "structures" / "golf" if _OUT else PACK_BP / "structures" / "golf"
DATA_JS = Path(_OUT) / "legends_data.js" if _OUT else PACK_BP / "scripts" / "mc" / "legends_data.js"
CACHE = Path(os.environ.get("HOLEGEN_CACHE", GOLF / ".holegen-cache"))

OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]
USGS = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage"
COPERNICUS = "https://copernicus-dem-30m.s3.amazonaws.com/{n}/{n}.tif"
UA = "finsonly-golf-holegen/0.1 (family Minecraft server; contact via github eburgard7-cloud)"

TILE = 64
BASE = 6           # layers of ground under the lowest point
SKY = 24           # air above the highest ground (trees, buildings)
BLOCK_VERSION = 18168832  # 1.21.60.0

CREDIT_US = "Map data © OpenStreetMap contributors (ODbL). Elevation: USGS 3DEP."
CREDIT_EU = "Map data © OpenStreetMap contributors (ODbL). Elevation: Copernicus DEM GLO-30 © DLR/Airbus."


# ---------------------------------------------------------------------------
# HTTP with a disk cache
# ---------------------------------------------------------------------------

def fetch(url: str, data: bytes | None = None, key: str | None = None, tries: int = 3) -> bytes:
    CACHE.mkdir(parents=True, exist_ok=True)
    cache = CACHE / (key or re.sub(r"[^A-Za-z0-9]+", "_", url)[-120:])
    if cache.exists() and cache.stat().st_size > 0:
        return cache.read_bytes()
    err = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, data=data, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=180) as r:
                body = r.read()
            cache.write_bytes(body)
            return body
        except Exception as e:  # noqa: BLE001
            err = e
            time.sleep(5 * (i + 1))
    raise RuntimeError(f"download failed: {url[:100]}: {err}")


def overpass(query: str, key: str) -> dict:
    last = None
    for ep in OVERPASS:
        try:
            body = fetch(ep, urllib.parse.urlencode({"data": query}).encode(), key=key)
            return json.loads(body)
        except Exception as e:  # noqa: BLE001
            last = e
    raise RuntimeError(f"Overpass failed: {last}")


# ---------------------------------------------------------------------------
# Geometry
# ---------------------------------------------------------------------------

class Proj:
    """Local equirectangular projection: x east, z SOUTH (Minecraft), meters."""

    def __init__(self, lat0: float, lon0: float):
        self.lat0, self.lon0 = lat0, lon0
        self.kx = 111320.0 * math.cos(math.radians(lat0))
        self.kz = 110540.0

    def xz(self, lat: float, lon: float):
        return ((lon - self.lon0) * self.kx, -(lat - self.lat0) * self.kz)

    def latlon(self, x: float, z: float):
        return (self.lat0 - z / self.kz, self.lon0 + x / self.kx)


def poly_area(pts):
    a = 0.0
    for i in range(len(pts)):
        x1, z1 = pts[i]
        x2, z2 = pts[(i + 1) % len(pts)]
        a += x1 * z2 - x2 * z1
    return abs(a) / 2


def centroid(pts):
    xs = [p[0] for p in pts]
    zs = [p[1] for p in pts]
    return (sum(xs) / len(xs), sum(zs) / len(zs))


def point_in_poly(x, z, pts):
    inside = False
    j = len(pts) - 1
    for i in range(len(pts)):
        xi, zi = pts[i]
        xj, zj = pts[j]
        if (zi > z) != (zj > z) and x < (xj - xi) * (z - zi) / (zj - zi + 1e-12) + xi:
            inside = not inside
        j = i
    return inside


# ---------------------------------------------------------------------------
# OSM
# ---------------------------------------------------------------------------

def element_rings(el, proj):
    """Outer rings (as lists of (x, z)) for a way or multipolygon relation. Lines come back as one open ring."""
    if el["type"] == "way" and "geometry" in el:
        return [[proj.xz(g["lat"], g["lon"]) for g in el["geometry"]]], []
    if el["type"] == "relation":
        outer, inner = [], []
        for m in el.get("members", []):
            if m.get("type") == "way" and "geometry" in m:
                ring = [proj.xz(g["lat"], g["lon"]) for g in m["geometry"]]
                (inner if m.get("role") == "inner" else outer).append(ring)
        return outer, inner
    if el["type"] == "node":
        return [[proj.xz(el["lat"], el["lon"])]], []
    return [], []


def find_hole(p: dict) -> dict:
    lat, lon = p["near"]
    q = f"""[out:json][timeout:90];
(
  way["golf"="hole"]["ref"="{p['hole']}"](around:3500,{lat},{lon});
  way["leisure"="golf_course"](around:3500,{lat},{lon});
  relation["leisure"="golf_course"](around:3500,{lat},{lon});
);
out geom tags;"""
    data = overpass(q, f"overpass_hole_{p['id']}.json")
    proj = Proj(lat, lon)
    holes = [e for e in data["elements"] if e.get("tags", {}).get("golf") == "hole"]
    courses = [e for e in data["elements"] if e.get("tags", {}).get("leisure") == "golf_course"]
    if not holes:
        raise RuntimeError(f"No OSM golf=hole ref={p['hole']} near {lat},{lon}. Check presets.json 'near'.")
    rx = re.compile(p.get("course_match", "."), re.I)

    def course_name(h):
        pts = [proj.xz(g["lat"], g["lon"]) for g in h["geometry"]]
        mx, mz = centroid(pts)
        for c in courses:
            outer, _ = element_rings(c, proj)
            if any(len(r) > 2 and point_in_poly(mx, mz, r) for r in outer):
                return c.get("tags", {}).get("name", "")
        return ""

    named = [(h, course_name(h)) for h in holes]
    matches = [h for h, n in named if rx.search(n)]
    if not matches:
        print("   courses found:", sorted({n for _, n in named if n}) or "none named")
        if len(holes) == 1:
            matches = holes
        else:
            raise RuntimeError(f"Several hole {p['hole']}s nearby and none in a course matching /{p['course_match']}/.")
    if len(matches) > 1:
        def d(h):
            g = h["geometry"][0]
            return (g["lat"] - lat) ** 2 + (g["lon"] - lon) ** 2
        matches.sort(key=d)
    h = matches[0]
    return {"line": [(g["lat"], g["lon"]) for g in h["geometry"]], "tags": h.get("tags", {})}


def fetch_features(p: dict, bbox) -> list:
    s, w, n, e = bbox
    b = f"{s},{w},{n},{e}"
    q = f"""[out:json][timeout:120];
(
  way["golf"]({b}); relation["golf"]({b});
  way["leisure"="golf_course"]({b}); relation["leisure"="golf_course"]({b});
  way["natural"]({b}); relation["natural"~"water|wood|scrub|sand|beach|wetland"]({b});
  way["water"]({b}); relation["water"]({b});
  way["waterway"]({b});
  way["landuse"]({b}); relation["landuse"~"forest|grass|meadow|reservoir"]({b});
  way["building"]({b}); relation["building"]({b});
  way["highway"]({b});
  node["natural"="tree"]({b});
);
out geom tags;"""
    return overpass(q, f"overpass_feat_{p['id']}.json")["elements"]


# ---------------------------------------------------------------------------
# Elevation
# ---------------------------------------------------------------------------

def dem_usgs(p, bbox, w, h):
    s, west, n, e = bbox
    params = {
        "bbox": f"{west},{s},{e},{n}", "bboxSR": 4326, "imageSR": 4326, "size": f"{w},{h}",
        "format": "tiff", "pixelType": "F32", "noDataInterpretation": "esriNoDataMatchAny",
        "interpolation": "RSP_BilinearInterpolation", "f": "image",
    }
    body = fetch(USGS + "?" + urllib.parse.urlencode(params), key=f"usgs_{p['id']}_{w}x{h}.tif")
    import tifffile
    arr = tifffile.imread(io.BytesIO(body)).astype(np.float64)
    if arr.ndim > 2:
        arr = arr[..., 0]
    arr[arr < -1000] = np.nan
    if np.isnan(arr).all():
        raise RuntimeError("USGS returned no elevation data here.")
    return np.nan_to_num(arr, nan=np.nanmin(arr))


def dem_copernicus(p, proj, w, h):
    import tifffile
    lat0, lon0 = proj.latlon(w / 2, h / 2)
    la, lo = math.floor(lat0), math.floor(lon0)
    name = f"Copernicus_DSM_COG_10_{'N' if la >= 0 else 'S'}{abs(la):02d}_00_{'E' if lo >= 0 else 'W'}{abs(lo):03d}_00_DEM"
    body = fetch(COPERNICUS.format(n=name), key=name + ".tif")
    tile = tifffile.imread(io.BytesIO(body)).astype(np.float64)
    th, tw = tile.shape
    out = np.zeros((h, w))
    for j in range(h):
        for i in range(w):
            lat, lon = proj.latlon(i + 0.5, j + 0.5)
            fx = (lon - lo) * tw - 0.5
            fy = (la + 1 - lat) * th - 0.5
            x0, y0 = int(math.floor(fx)), int(math.floor(fy))
            tx, ty = fx - x0, fy - y0
            x0 = max(0, min(tw - 2, x0)); y0 = max(0, min(th - 2, y0))
            a, b = tile[y0, x0], tile[y0, x0 + 1]
            c, d = tile[y0 + 1, x0], tile[y0 + 1, x0 + 1]
            out[j, i] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty
    return out


def box_blur(a, r):
    if r <= 0:
        return a
    k = 2 * r + 1
    pad = np.pad(a, r, mode="edge")
    c = pad.cumsum(0).cumsum(1)
    c = np.pad(c, ((1, 0), (1, 0)))
    return (c[k:, k:] - c[:-k, k:] - c[k:, :-k] + c[:-k, :-k]) / (k * k)


# ---------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------

# label values, painted in this order (later wins)
L_GRASS, L_ROUGH, L_DEEP, L_SAND, L_FOREST, L_FAIRWAY, L_PATH, L_TEE, L_FRINGE, L_GREEN, L_BUNKER, L_WATER, L_BUILDING = range(13)


class Canvas:
    def __init__(self, w, h):
        self.w, self.h = w, h
        self.label = np.full((h, w), L_GRASS, dtype=np.int16)
        self.course = np.zeros((h, w), dtype=bool)
        self.bheight = np.zeros((h, w), dtype=np.int16)
        self.trees: list[tuple[float, float]] = []
        self.tee_polys: list[list] = []
        self.green_polys: list[list] = []

    def mask(self, rings, holes=(), line_width=None):
        im = Image.new("L", (self.w, self.h), 0)
        d = ImageDraw.Draw(im)
        for r in rings:
            pts = [(x, z) for x, z in r]
            if line_width:
                if len(pts) >= 2:
                    d.line(pts, fill=1, width=max(1, int(round(line_width))), joint="curve")
            elif len(pts) >= 3:
                d.polygon(pts, fill=1)
        for r in holes:
            if len(r) >= 3:
                d.polygon([(x, z) for x, z in r], fill=0)
        return np.array(im, dtype=bool)

    def paint(self, m, value):
        self.label[m] = value


WATER_TAGS = {"water", "bay", "coastline"}
FOREST_TAGS = {"wood", "tree_row"}


def classify(features, proj, cv: Canvas, origin):
    ox, oz = origin

    def rings(el):
        o, i = element_rings(el, proj)
        return [[(x - ox, z - oz) for x, z in r] for r in o], [[(x - ox, z - oz) for x, z in r] for r in i]

    layers = {k: [] for k in range(13)}
    for el in features:
        t = el.get("tags", {})
        golf, nat, lu = t.get("golf"), t.get("natural"), t.get("landuse")
        if el["type"] == "node":
            if nat == "tree":
                (x, z), = rings(el)[0][0]
                cv.trees.append((x, z))
            continue
        o, i = rings(el)
        closed = all(len(r) > 3 and abs(r[0][0] - r[-1][0]) < 0.01 and abs(r[0][1] - r[-1][1]) < 0.01 for r in o) if o else False
        if t.get("leisure") == "golf_course":
            cv.course |= cv.mask(o, i)
        elif golf == "green":
            layers[L_GREEN].append((o, i, None)); cv.green_polys += o
        elif golf == "tee":
            layers[L_TEE].append((o, i, None)); cv.tee_polys += o
        elif golf == "fairway":
            layers[L_FAIRWAY].append((o, i, None))
        elif golf == "bunker":
            layers[L_BUNKER].append((o, i, None))
        elif golf in ("rough",):
            layers[L_ROUGH].append((o, i, None))
        elif golf in ("water_hazard", "lateral_water_hazard"):
            layers[L_WATER].append((o, i, None if closed else 3))
        elif golf == "cartpath" or golf == "path":
            layers[L_PATH].append((o, i, 2.5))
        elif nat in WATER_TAGS or "water" in t or lu in ("reservoir", "basin"):
            if nat == "coastline":
                continue  # handled by water_level
            layers[L_WATER].append((o, i, None if closed else 3))
        elif "waterway" in t:
            w = {"river": 8, "canal": 6, "stream": 2.5, "ditch": 1.5, "drain": 1.5}.get(t["waterway"], 2)
            layers[L_WATER].append((o, i, w))
        elif nat in FOREST_TAGS or lu == "forest":
            if nat == "tree_row":
                for r in o:
                    for k in range(len(r) - 1):
                        (x1, z1), (x2, z2) = r[k], r[k + 1]
                        n = max(1, int(math.hypot(x2 - x1, z2 - z1) / 7))
                        for s in range(n):
                            cv.trees.append((x1 + (x2 - x1) * s / n, z1 + (z2 - z1) * s / n))
            else:
                layers[L_FOREST].append((o, i, None))
        elif nat in ("scrub", "heath", "wetland"):
            layers[L_DEEP].append((o, i, None))
        elif nat in ("sand", "beach"):
            layers[L_SAND].append((o, i, None))
        elif lu in ("grass", "meadow", "recreation_ground"):
            layers[L_ROUGH].append((o, i, None))
        elif "building" in t:
            lv = t.get("building:levels")
            try:
                height = float(str(t.get("height", "")).replace("m", "").strip())
            except ValueError:
                height = None
            if height is None:
                try:
                    height = float(lv) * 3.2 if lv else 6.0
                except ValueError:
                    height = 6.0
            layers[L_BUILDING].append((o, i, None, max(3, min(30, int(round(height))))))
        elif "highway" in t and t["highway"] not in ("proposed", "construction"):
            w = {"footway": 1.5, "path": 1.5, "track": 3, "service": 4, "residential": 6}.get(t["highway"], 3)
            layers[L_PATH].append((o, i, w))

    # Water first: island greens and fairways are usually mapped on top of the lake.
    for lvl in (L_ROUGH, L_DEEP, L_SAND, L_FOREST, L_WATER, L_FAIRWAY, L_PATH, L_TEE, L_GREEN, L_BUNKER, L_BUILDING):
        for item in layers[lvl]:
            o, i, lw = item[0], item[1], item[2]
            m = cv.mask(o, i, lw)
            if lvl == L_BUILDING:
                cv.bheight[m] = item[3]
            cv.paint(m, lvl)
    # fringe: 2 m collar around greens
    g = cv.label == L_GREEN
    near = box_blur(g.astype(float), 2) > 0
    collar = near & ~g & np.isin(cv.label, [L_GRASS, L_ROUGH, L_FAIRWAY, L_DEEP, L_WATER])
    cv.label[collar] = L_FRINGE
    # inside the golf course, plain grass is maintained rough
    cv.label[(cv.label == L_GRASS) & cv.course] = L_ROUGH


# ---------------------------------------------------------------------------
# Voxels
# ---------------------------------------------------------------------------

AIR = "minecraft:air"
TREES = {
    "pine": [("minecraft:spruce_log", "minecraft:spruce_leaves", 12, 3.0, "pine")],
    "oak": [("minecraft:oak_log", "minecraft:oak_leaves", 6, 3.0, "ball"), ("minecraft:birch_log", "minecraft:birch_leaves", 7, 2.4, "ball")],
    "cypress": [("minecraft:dark_oak_log", "minecraft:dark_oak_leaves", 5, 4.0, "flat")],
    "mixed": [("minecraft:oak_log", "minecraft:oak_leaves", 6, 3.0, "ball"), ("minecraft:spruce_log", "minecraft:spruce_leaves", 9, 2.6, "pine")],
    "links": [("minecraft:oak_log", "minecraft:oak_leaves", 4, 2.2, "ball")],
}


def block_state(name):
    if name.endswith("_log"):
        return {"pillar_axis": "y"}
    if name.endswith("_leaves"):
        return {"persistent_bit": nbt.Byte(1), "update_bit": nbt.Byte(0)}
    if name == "minecraft:water":
        return {"liquid_depth": nbt.Int(0)}
    return {}


def build_hole(p, features, line_ll, hole_tags, proj, dem, origin, w, h, rng):
    cv = Canvas(w, h)
    classify(features, proj, cv, origin)
    ox, oz = origin

    # terrain: smooth lidar noise (more for the 30 m surface model)
    hm = box_blur(dem, 1 if p.get("dem", "usgs") == "usgs" else 4)
    if p.get("water_level") is not None:
        sea = hm < p["water_level"]
        natural = np.isin(cv.label, [L_GRASS, L_ROUGH, L_DEEP, L_SAND, L_FOREST])
        cv.label[sea & natural] = L_WATER

    land = cv.label != L_WATER
    lo = float(np.min(hm[land])) if land.any() else float(np.min(hm))
    H = np.round(hm - lo).astype(np.int32) + BASE
    H = np.maximum(H, 2)

    # water bodies: flat surface at the lowest rim height, 2 deep
    water = cv.label == L_WATER
    if water.any():
        comp = np.zeros_like(H) - 1
        n_comp = 0
        for (j, i) in zip(*np.nonzero(water)):
            if comp[j, i] >= 0:
                continue
            stack = [(j, i)]
            comp[j, i] = n_comp
            cells = []
            while stack:
                a, b = stack.pop()
                cells.append((a, b))
                for da, db in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    c, d = a + da, b + db
                    if 0 <= c < h and 0 <= d < w and water[c, d] and comp[c, d] < 0:
                        comp[c, d] = n_comp
                        stack.append((c, d))
            js, is_ = zip(*cells)
            js, is_ = np.array(js), np.array(is_)
            level = int(np.round(np.percentile(hm[js, is_], 15) - lo)) + BASE
            if p.get("water_level") is not None:
                level = min(level, int(round(p["water_level"] - lo)) + BASE)
            H[js, is_] = level
            n_comp += 1

    # flatten greens and tees; real contours go into the putting grid
    greens = []
    for poly in cv.green_polys:
        m = cv.mask([poly])
        if m.sum() < 20:
            continue
        lvl = int(np.round(np.mean(hm[m]) - lo)) + BASE
        H[m] = lvl
        # feather 3 m around the green toward its level
        ring = (box_blur(m.astype(float), 3) > 0) & ~m & (cv.label != L_WATER)
        H[ring] = np.round((H[ring] + lvl) / 2).astype(np.int32)
        greens.append((poly, m, lvl))
    for poly in cv.tee_polys:
        m = cv.mask([poly])
        if m.sum() < 4:
            continue
        H[m] = int(np.round(np.mean(hm[m]) - lo)) + BASE

    # the hole line
    line = [proj.xz(*ll) for ll in line_ll]
    line = [(x - ox, z - oz) for x, z in line]
    gx, gz = line[-1]
    green = None
    for poly, m, lvl in greens:
        if point_in_poly(gx, gz, poly):
            green = (poly, m, lvl)
    if green is None and greens:
        green = min(greens, key=lambda g: math.hypot(centroid(g[0])[0] - gx, centroid(g[0])[1] - gz))
    if green is None:
        raise RuntimeError("No green polygon found at the end of the hole line.")
    gpoly, gmask, glvl = green
    if not point_in_poly(gx, gz, gpoly):
        gx, gz = centroid(gpoly)
    pin = (int(math.floor(gx)), glvl + 1, int(math.floor(gz)))

    # stripes follow the hole
    tx, tz = line[0]
    dx, dz = gx - tx, gz - tz
    L = math.hypot(dx, dz) or 1
    ux, uz = dx / L, dz / L

    # tees: every tee box near the start; sort by distance to the pin
    tees = []
    for poly in cv.tee_polys:
        cx, cz = centroid(poly)
        if math.hypot(cx - tx, cz - tz) < 90 and poly_area(poly) > 6:
            m = cv.mask([poly])
            if m.any():
                lvl = int(H[m].max())
                tees.append((math.hypot(cx - gx, cz - gz), (math.floor(cx) + 0.5, lvl + 1, math.floor(cz) + 0.5)))
    if not tees:
        j, i = int(min(h - 1, max(0, tz))), int(min(w - 1, max(0, tx)))
        tees.append((L, (math.floor(tx) + 0.5, int(H[j, i]) + 1, math.floor(tz) + 0.5)))
    tees.sort(key=lambda t: -t[0])
    tee_sets = {"back": tees[0][1], "middle": tees[len(tees) // 2][1], "forward": tees[-1][1], "kids": None}
    par = int(re.sub(r"\D", "", str(hole_tags.get("par", ""))) or 0) or (3 if L < 230 else 4 if L < 430 else 5)
    if par >= 4:
        kd = tees[-1][0] * 0.6
        kx, kz = gx - ux * kd, gz - uz * kd
        j, i = int(kz), int(kx)
        if 0 <= j < h and 0 <= i < w and cv.label[j, i] in (L_FAIRWAY, L_ROUGH, L_TEE):
            tee_sets["kids"] = (math.floor(kx) + 0.5, int(H[j, i]) + 1, math.floor(kz) + 0.5)

    # green contour grid from lidar, in cm, relative to the pin
    gj, gi = np.nonzero(gmask)
    x0, x1 = max(0, gi.min() - 1), min(w - 1, gi.max() + 1)
    z0, z1 = max(0, gj.min() - 1), min(h - 1, gj.max() + 1)
    x1 = min(x1, x0 + 63)
    z1 = min(z1, z0 + 63)
    raw = box_blur(dem, 2)[z0:z1 + 1, x0:x1 + 1]
    cm = (raw - raw[min(raw.shape[0] - 1, max(0, pin[2] - z0)), min(raw.shape[1] - 1, max(0, pin[0] - x0))]) * 100
    cm = np.clip(cm, -150, 150)
    green_grid = {"x0": int(x0), "z0": int(z0), "w": int(x1 - x0 + 1), "h": int(z1 - z0 + 1),
                  "mm": ",".join(str(int(round(v * 10))) for v in cm.flatten())}

    # trees
    style = TREES.get(p.get("trees", "mixed"), TREES["mixed"])
    forest = cv.label == L_FOREST
    if forest.any():
        for j in range(2, h - 2, 6):
            for i in range(2, w - 2, 6):
                jj = j + rng.integers(-2, 3)
                ii = i + rng.integers(-2, 3)
                if 0 <= jj < h and 0 <= ii < w and forest[jj, ii]:
                    cv.trees.append((ii + 0.5, jj + 0.5))
    playable = np.isin(cv.label, [L_FAIRWAY, L_GREEN, L_TEE, L_FRINGE, L_BUNKER, L_WATER, L_PATH, L_BUILDING])

    return {
        "cv": cv, "H": H, "tees": tee_sets, "pin": pin, "par": par, "length": L, "green": green_grid,
        "stripe": (ux, uz), "style": style, "playable": playable, "lo": lo,
    }


def voxelize(b, rng):
    cv, H = b["cv"], b["H"]
    h, w = H.shape
    ux, uz = b["stripe"]
    top = int(H.max()) + 1 + max(SKY, int(cv.bheight.max()) + 2)
    ny = top + 1
    vox = np.zeros((w, ny, h), dtype=np.int16)  # x, y, z -> palette index
    palette = [AIR]
    pidx = {AIR: 0}

    def P(name):
        if name not in pidx:
            pidx[name] = len(palette)
            palette.append(name)
        return pidx[name]

    stone, dirt, water, sandb = P("minecraft:stone"), P("minecraft:dirt"), P("minecraft:water"), P("minecraft:sand")
    grass = P("minecraft:grass_block")
    surf = {
        L_ROUGH: P("golf:turf_rough"), L_DEEP: P("golf:turf_deep_rough"), L_SAND: sandb, L_FOREST: grass,
        L_PATH: P("golf:cart_path"), L_FRINGE: P("golf:turf_fringe"), L_BUNKER: P("golf:bunker_sand"), L_GRASS: grass,
    }
    fw = (P("golf:turf_fairway_a"), P("golf:turf_fairway_b"))
    gr = (P("golf:turf_green_a"), P("golf:turf_green_b"))
    te = (P("golf:turf_tee_a"), P("golf:turf_tee_b"))
    brick, roof = P("minecraft:bricks"), P("minecraft:deepslate_tiles")

    bunker = cv.label == L_BUNKER
    bunker_core = box_blur(bunker.astype(float), 1) > 0.99

    for j in range(h):
        for i in range(w):
            y = int(H[j, i])
            lab = int(cv.label[j, i])
            vox[i, 0:max(0, y - 3), j] = stone
            vox[i, max(0, y - 3):y, j] = dirt
            if lab == L_WATER:
                # water surface level with the land around it, 2 deep, on a sand bed
                vox[i, y - 1:y + 1, j] = water
                vox[i, max(0, y - 2), j] = sandb
                continue
            along = i * ux + j * uz
            if lab == L_FAIRWAY:
                blk = fw[int(math.floor(along / 4)) % 2]
            elif lab == L_GREEN:
                blk = gr[int(math.floor(along / 2)) % 2]
            elif lab == L_TEE:
                blk = te[int(math.floor(along / 2)) % 2]
            elif lab == L_BUILDING:
                blk = dirt
            else:
                blk = surf.get(lab, grass)
            if lab == L_BUNKER and bunker_core[j, i]:
                vox[i, y, j] = 0
                vox[i, y - 1, j] = blk
            else:
                vox[i, y, j] = blk
            if lab == L_BUILDING:
                bh = int(cv.bheight[j, i])
                edge = any(
                    not (0 <= j + dj < h and 0 <= i + di < w) or cv.label[j + dj, i + di] != L_BUILDING
                    for dj, di in ((1, 0), (-1, 0), (0, 1), (0, -1))
                )
                if edge:
                    vox[i, y + 1:y + 1 + bh, j] = brick
                vox[i, y + bh, j] = roof

    # pin cup
    px, py, pz = b["pin"]
    if 0 <= px < w and 0 <= pz < h:
        vox[px, py - 1, pz] = P("golf:cup")

    # trees (not on playable surfaces)
    for (x, z) in cv.trees:
        i, j = int(x), int(z)
        if not (2 <= i < w - 2 and 2 <= j < h - 2) or b["playable"][j, i]:
            continue
        log, leaves, height, rad, shape = b["style"][int(rng.integers(0, len(b["style"])))]
        lg, lv = P(log), P(leaves)
        y0 = int(H[j, i]) + 1
        th = height + int(rng.integers(-1, 3))
        for k in range(th):
            if y0 + k < ny:
                vox[i, y0 + k, j] = lg
        R = int(math.ceil(rad))
        for dy in range(-3, 4):
            for di in range(-R, R + 1):
                for dj in range(-R, R + 1):
                    yy = y0 + th - 1 + dy
                    ii, jj = i + di, j + dj
                    if not (0 <= ii < w and 0 <= jj < h and 0 <= yy < ny):
                        continue
                    if shape == "pine":
                        r = max(0.6, rad * (1 - (dy + 3) / 7))
                        ok = math.hypot(di, dj) <= r + rng.random() * 0.3
                    elif shape == "flat":
                        ok = dy in (0, 1) and math.hypot(di, dj) <= rad + rng.random() * 0.5 - (0.8 if dy == 1 else 0)
                    else:
                        ok = math.hypot(di, dj, dy * 0.9) <= rad + rng.random() * 0.4
                    if ok and vox[ii, yy, jj] == 0:
                        vox[ii, yy, jj] = lv
    return vox, palette


def write_tiles(pid, vox, palette):
    STRUCT_DIR.mkdir(parents=True, exist_ok=True)
    for old in STRUCT_DIR.glob(f"{pid}_*.mcstructure"):
        old.unlink()
    w, ny, h = vox.shape
    pal = nbt.CompoundList([{"name": n, "states": block_state(n), "version": nbt.Int(BLOCK_VERSION)} for n in palette])
    tiles = []
    for ti in range(0, w, TILE):
        for tj in range(0, h, TILE):
            sub = vox[ti:ti + TILE, :, tj:tj + TILE]
            sx, sy, sz = sub.shape
            flat = np.ascontiguousarray(sub, dtype="<i4").reshape(-1)  # x, then y, then z fastest
            layer0 = _PreList(flat.tobytes(), flat.size)
            layer1 = _PreList(np.full(flat.size, -1, dtype="<i4").tobytes(), flat.size)
            root = {
                "format_version": nbt.Int(1),
                "size": nbt.IntList([sx, sy, sz]),
                "structure_world_origin": nbt.IntList([0, 0, 0]),
                "structure": {
                    "block_indices": nbt.ListOf(nbt.LIST, [layer0, layer1]),
                    "entities": nbt.CompoundList([]),
                    "palette": {"default": {"block_palette": pal, "block_position_data": {}}},
                },
            }
            name = f"{pid}_{ti // TILE}_{tj // TILE}"
            (STRUCT_DIR / f"{name}.mcstructure").write_bytes(_dumps(root))
            tiles.append({"id": f"golf:{name}", "dx": ti, "dz": tj, "w": sx, "d": sz})
    return tiles, ny


class _PreList:
    """A LIST<INT> whose payload is already packed little-endian bytes."""

    def __init__(self, data: bytes, n: int):
        self.bytes = data
        self.n = n


def _dumps(root):
    # nbt.dumps handles everything except our pre-packed int lists; patch them in.
    import struct

    def payload(out, kind, v):
        if isinstance(v, _PreList):
            out += struct.pack("<bi", nbt.INT, v.n) + v.bytes
            return
        if isinstance(v, nbt.Tag) and v.kind == nbt.LIST and v.item_kind == nbt.LIST:
            out += struct.pack("<bi", nbt.LIST, len(v.value))
            for item in v.value:
                payload(out, nbt.LIST, item)
            return
        if isinstance(v, dict):
            for name, item in v.items():
                k = nbt.LIST if isinstance(item, _PreList) else nbt._kind(item)
                out += struct.pack("<b", k)
                nbt._payload(out, nbt.STRING, name)
                payload(out, k, item)
            out += struct.pack("<b", nbt.END)
            return
        nbt._payload(out, kind, v)

    out = bytearray()
    out += struct.pack("<b", nbt.COMPOUND)
    nbt._payload(out, nbt.STRING, "")
    payload(out, nbt.COMPOUND, root)
    return bytes(out)


# ---------------------------------------------------------------------------
# legends_data.js
# ---------------------------------------------------------------------------

def write_data_js(entries: dict, presets: list):
    DATA_JS.parent.mkdir(parents=True, exist_ok=True)
    catalog = [{"id": p["id"], "name": p["name"], "course": p["course"], "hole": int(p["hole"])} for p in presets]
    legends = [entries[k] for k in sorted(entries)]
    DATA_JS.write_text(
        "// GENERATED by golf/maker/holegen/holegen.py. Do not edit by hand: re-run the generator.\n"
        f"// Last run: {time.strftime('%Y-%m-%d %H:%M')}\n\n"
        "/** Holes the generator knows how to build. */\n"
        f"export const CATALOG = {json.dumps(catalog, indent=2)};\n\n"
        "/** Generated holes. */\n"
        f"export const LEGENDS = {json.dumps(legends, indent=1)};\n"
    )


def read_data_js() -> dict:
    if not DATA_JS.exists():
        return {}
    m = re.search(r"export const LEGENDS = (\[.*\]);", DATA_JS.read_text(), re.S)
    if not m:
        return {}
    try:
        return {e["id"]: e for e in json.loads(m.group(1))}
    except json.JSONDecodeError:
        return {}


def entry_for(p, b, tiles, ny, credit):
    rel = lambda t: None if t is None else {"x": round(t[0], 2), "y": int(t[1]), "z": round(t[2], 2)}  # noqa: E731
    return {
        "id": p["id"], "name": p["name"], "course": p["course"], "hole": int(p["hole"]), "par": b["par"],
        "lengthM": round(b["length"], 1),
        "size": {"x": int(b["H"].shape[1]), "y": int(ny), "z": int(b["H"].shape[0])},
        "tiles": tiles,
        "tees": {k: rel(v) for k, v in b["tees"].items()},
        "pin": {"x": int(b["pin"][0]), "y": int(b["pin"][1]), "z": int(b["pin"][2])},
        "green": b["green"],
        "credit": credit,
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def build_real(p) -> dict:
    print(f"== {p['id']}: {p['course']} #{p['hole']}")
    hole = find_hole(p)
    lat0 = sum(ll[0] for ll in hole["line"]) / len(hole["line"])
    lon0 = sum(ll[1] for ll in hole["line"]) / len(hole["line"])
    proj = Proj(lat0, lon0)
    pts = [proj.xz(*ll) for ll in hole["line"]]
    mg = p.get("margin", 45)
    minx, maxx = min(x for x, _ in pts) - mg, max(x for x, _ in pts) + mg
    minz, maxz = min(z for _, z in pts) - mg, max(z for _, z in pts) + mg
    w, h = int(math.ceil(maxx - minx)), int(math.ceil(maxz - minz))
    if w * h > 700 * 700:
        raise RuntimeError(f"Area {w}x{h} m is too big; lower the margin.")
    n, wlon = proj.latlon(minx, minz)
    s, elon = proj.latlon(maxx, maxz)
    bbox = (s, wlon, n, elon)
    print(f"   hole line found ({hole['tags'].get('par', '?')} par), area {w} x {h} m")
    feats = fetch_features(p, bbox)
    print(f"   {len(feats)} map features")
    if p.get("dem", "usgs") == "usgs":
        dem = dem_usgs(p, bbox, w, h)
        credit = CREDIT_US
    else:
        sub = Proj(proj.latlon(minx, minz)[0], proj.latlon(minx, minz)[1])
        dem = dem_copernicus(p, sub, w, h)
        credit = CREDIT_EU
    if dem.shape != (h, w):
        dem = np.array(Image.fromarray(dem.astype(np.float32)).resize((w, h), Image.BILINEAR), dtype=np.float64)
    print(f"   terrain {dem.min():.1f} to {dem.max():.1f} m")
    rng = np.random.default_rng(zlib.crc32(p["id"].encode()))
    b = build_hole(p, feats, hole["line"], hole["tags"], proj, dem, (minx, minz), w, h, rng)
    vox, palette = voxelize(b, rng)
    tiles, ny = write_tiles(p["id"], vox, palette)
    print(f"   par {b['par']}, {b['length']:.0f} m, {len(tiles)} tiles, {ny} blocks tall")
    return entry_for(p, b, tiles, ny, credit)


def synthetic_features(proj, center):
    """A made-up 150 m par 3 to an island green, in OSM JSON shape."""
    lat0, lon0 = center

    def ll(x, z):
        la, lo = proj.latlon(x, z)
        return {"lat": la, "lon": lo}

    def circle(cx, cz, r, n=28):
        g = [ll(cx + r * math.cos(2 * math.pi * k / n), cz + r * math.sin(2 * math.pi * k / n)) for k in range(n)]
        return g + [g[0]]

    def rect(x0, z0, x1, z1):
        g = [ll(x0, z0), ll(x1, z0), ll(x1, z1), ll(x0, z1)]
        return g + [g[0]]

    els = [
        {"type": "way", "tags": {"leisure": "golf_course", "name": "Synthetic Links"}, "geometry": rect(-60, -200, 60, 30)},
        {"type": "way", "tags": {"golf": "hole", "ref": "1", "par": "3"}, "geometry": [ll(0, 0), ll(0, -150)]},
        {"type": "way", "tags": {"golf": "tee"}, "geometry": rect(-4, -3, 4, 4)},
        {"type": "way", "tags": {"golf": "tee"}, "geometry": rect(-3, -28, 3, -22)},
        {"type": "way", "tags": {"natural": "water"}, "geometry": circle(0, -150, 32)},
        {"type": "way", "tags": {"golf": "fairway"}, "geometry": circle(0, -150, 17)},
        {"type": "way", "tags": {"golf": "green"}, "geometry": circle(0, -150, 13)},
        {"type": "way", "tags": {"golf": "bunker"}, "geometry": circle(9, -158, 3)},
        {"type": "way", "tags": {"natural": "wood"}, "geometry": rect(25, -60, 55, 0)},
        {"type": "way", "tags": {"golf": "cartpath"}, "geometry": [ll(-10, 0), ll(-12, -100)]},
        {"type": "way", "tags": {"building": "yes", "building:levels": "2"}, "geometry": rect(-50, 5, -35, 20)},
        {"type": "node", "tags": {"natural": "tree"}, "lat": ll(-20, -40)["lat"], "lon": ll(-20, -40)["lon"]},
    ]
    line = [(ll(0, 0)["lat"], ll(0, 0)["lon"]), (ll(0, -150)["lat"], ll(0, -150)["lon"])]
    return els, line


def build_synthetic() -> dict:
    p = {"id": "synthetic1", "name": "Test Island", "course": "Synthetic Links", "hole": "1", "trees": "pine", "margin": 40, "dem": "usgs", "water_level": None}
    center = (30.0, -81.0)
    proj = Proj(*center)
    feats, line = synthetic_features(proj, center)
    pts = [proj.xz(*x) for x in line]
    mg = p["margin"]
    minx, maxx = min(x for x, _ in pts) - mg, max(x for x, _ in pts) + mg
    minz, maxz = min(z for _, z in pts) - mg, max(z for _, z in pts) + mg
    w, h = int(math.ceil(maxx - minx)), int(math.ceil(maxz - minz))
    jj, ii = np.mgrid[0:h, 0:w]
    dem = 10 + 3 * np.sin(ii / 25.0) + 2 * np.cos(jj / 30.0) + 0.02 * (h - jj)
    rng = np.random.default_rng(1)
    b = build_hole(p, feats, line, {"par": "3"}, proj, dem, (minx, minz), w, h, rng)
    vox, palette = voxelize(b, rng)
    tiles, ny = write_tiles(p["id"], vox, palette)
    return entry_for(p, b, tiles, ny, "synthetic test hole")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ids", nargs="*", help="preset ids (default: all)")
    ap.add_argument("--synthetic", action="store_true", help="build the offline test hole")
    a = ap.parse_args(argv)
    presets = json.loads((HERE / "presets.json").read_text())["holes"]
    entries = read_data_js()
    if a.synthetic:
        e = build_synthetic()
        entries[e["id"]] = e
        write_data_js(entries, presets)
        print("synthetic hole written")
        return 0
    want = a.ids or [p["id"] for p in presets]
    bad = 0
    for pid in want:
        p = next((x for x in presets if x["id"] == pid), None)
        if not p:
            print(f"unknown hole id: {pid}. Known: {', '.join(x['id'] for x in presets)}")
            bad += 1
            continue
        try:
            entries[pid] = build_real(p)
        except Exception as e:  # noqa: BLE001
            print(f"   FAILED: {e}")
            bad += 1
    entries.pop("synthetic1", None)
    write_data_js(entries, presets)
    print(f"\n{len(want) - bad} of {len(want)} holes built.")
    return 1 if bad == len(want) else 0


if __name__ == "__main__":
    sys.exit(main())
