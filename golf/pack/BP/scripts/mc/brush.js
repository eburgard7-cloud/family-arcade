// The Course Brush: paint golf surfaces and shape the ground from a distance.
//   Use        paint where you're looking
//   Sneak+Use  brush menu (mode, size, undo)
// Every stroke can be undone (last 15 per builder).

import { BlockPermutation } from "@minecraft/server";
import { isPassThrough, isCanopy, isLiquid, surfaceOf } from "../lib/surfaces.js";
import { bump, smooth as smoothGrid, encode, decode } from "../lib/greens.js";
import { overworld, msg, sound, safe, particle } from "./util.js";
import { getHole, saveHole, teeFor } from "./store.js";

export const BRUSH_MODES = [
  { id: "fairway", label: "Fairway", kind: "surface", a: "golf:turf_fairway_a", b: "golf:turf_fairway_b", stripe: 4 },
  { id: "rough", label: "Rough", kind: "surface", a: "golf:turf_rough" },
  { id: "deep", label: "Deep Rough", kind: "surface", a: "golf:turf_deep_rough" },
  { id: "green", label: "Green (+ fringe edge)", kind: "green", a: "golf:turf_green_a", b: "golf:turf_green_b", stripe: 2 },
  { id: "fringe", label: "Fringe", kind: "surface", a: "golf:turf_fringe" },
  { id: "tee", label: "Tee Box", kind: "surface", a: "golf:turf_tee_a", b: "golf:turf_tee_b", stripe: 2 },
  { id: "bunker", label: "Bunker (dig + sand)", kind: "bunker", a: "golf:bunker_sand" },
  { id: "water", label: "Water Hazard (dig + fill)", kind: "water" },
  { id: "path", label: "Cart Path", kind: "surface", a: "golf:cart_path" },
  { id: "raise", label: "Raise Ground", kind: "raise" },
  { id: "lower", label: "Lower Ground", kind: "lower" },
  { id: "smooth", label: "Smooth Ground", kind: "smooth" },
  { id: "flatten", label: "Flatten To This Height", kind: "flatten" },
  { id: "tree", label: "Plant Trees", kind: "tree" },
  { id: "clear", label: "Clear Trees & Plants", kind: "clear" },
  { id: "g_raise", label: "Green Contour: Raise", kind: "contour", delta: 3 },
  { id: "g_lower", label: "Green Contour: Lower", kind: "contour", delta: -3 },
  { id: "g_smooth", label: "Green Contour: Smooth", kind: "contour", delta: 0 },
];
export const modeById = (id) => BRUSH_MODES.find((m) => m.id === id) ?? BRUSH_MODES[0];

/** @type {Map<string, any>} */
const builders = new Map();
export function builderState(p) {
  let s = builders.get(p.id);
  if (!s) {
    s = { courseId: null, holeId: null, mode: "fairway", radius: 3, undo: [], showSlope: false };
    builders.set(p.id, s);
  }
  return s;
}
export const allBuilders = () => builders;

const permCache = new Map();
function perm(id) {
  let p = permCache.get(id);
  if (!p) { p = BlockPermutation.resolve(id); permCache.set(id, p); }
  return p;
}

const isGround = (id) => !isPassThrough(id) && !isCanopy(id) && !isLiquid(id);

/** Top ground block in a column near yRef. Returns { y, block } or null. */
function topGround(dim, x, yRef, z, includeLiquid = false) {
  for (let y = yRef + 10; y >= yRef - 16; y--) {
    let b;
    try { b = dim.getBlock({ x, y, z }); } catch { return null; }
    if (!b) return null;
    const id = b.typeId;
    if (isGround(id) || (includeLiquid && isLiquid(id))) {
      // don't treat logs as ground
      if (id.includes("_log") || id.includes("_wood") || id.endsWith("_stem")) continue;
      return { y, block: b };
    }
  }
  return null;
}

class Recorder {
  constructor() { this.changes = []; this.seen = new Set(); }
  set(dim, x, y, z, id) {
    let b;
    try { b = dim.getBlock({ x, y, z }); } catch { return; }
    if (!b || b.typeId === id) return;
    const k = x + "," + y + "," + z;
    if (!this.seen.has(k)) { this.seen.add(k); this.changes.push({ x, y, z, perm: b.permutation }); }
    b.setPermutation(perm(id));
  }
}

function stripeDir(state) {
  const h = state.holeId ? getHole(state.holeId) : null;
  const t = h ? teeFor(h, "middle") : null;
  if (t && h?.pin) {
    const dx = h.pin.x + 0.5 - t.x, dz = h.pin.z + 0.5 - t.z;
    const l = Math.hypot(dx, dz) || 1;
    return { x: dx / l, z: dz / l };
  }
  return { x: 1, z: 0 };
}

function striped(mode, x, z, dir) {
  if (!mode.b) return mode.a;
  const along = x * dir.x + z * dir.z;
  return Math.floor(along / mode.stripe) % 2 === 0 ? mode.a : mode.b;
}

function clearAbove(dim, rec, x, y, z) {
  for (let k = 1; k <= 2; k++) {
    let b;
    try { b = dim.getBlock({ x, y: y + k, z }); } catch { return; }
    if (b && isPassThrough(b.typeId) && b.typeId !== "minecraft:air") rec.set(dim, x, y + k, z, "minecraft:air");
  }
}

function columns(cx, cz, r) {
  const out = [];
  for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
    const d = Math.hypot(dx, dz);
    if (d <= r + 0.35) out.push({ x: cx + dx, z: cz + dz, d });
  }
  return out;
}

export function paint(p) {
  const state = builderState(p);
  const mode = modeById(state.mode);
  const dim = p.dimension;
  const hit = safe("ray", () => p.getBlockFromViewDirection({ maxDistance: 200, includeLiquidBlocks: true, includePassableBlocks: false }));
  if (!hit) return msg(p, "§7Look at the ground (within 200 blocks) and use the brush.");
  const c = hit.block.location;
  const r = state.radius;

  if (mode.kind === "contour") return paintContour(p, state, mode, c);

  const rec = new Recorder();
  const dir = stripeDir(state);
  const cols = columns(c.x, c.z, r);

  safe("paint", () => {
    switch (mode.kind) {
      case "surface":
        for (const col of cols) {
          const t = topGround(dim, col.x, c.y, col.z);
          if (!t) continue;
          clearAbove(dim, rec, col.x, t.y, col.z);
          rec.set(dim, col.x, t.y, col.z, striped(mode, col.x, col.z, dir));
        }
        break;
      case "green": {
        for (const col of columns(c.x, c.z, r + 1)) {
          const t = topGround(dim, col.x, c.y, col.z);
          if (!t) continue;
          clearAbove(dim, rec, col.x, t.y, col.z);
          const inner = col.d <= r + 0.35;
          const cur = surfaceOf(t.block.typeId);
          if (inner) rec.set(dim, col.x, t.y, col.z, striped(mode, col.x, col.z, dir));
          else if (cur !== "green") rec.set(dim, col.x, t.y, col.z, "golf:turf_fringe");
        }
        break;
      }
      case "bunker":
        for (const col of cols) {
          const t = topGround(dim, col.x, c.y, col.z);
          if (!t) continue;
          clearAbove(dim, rec, col.x, t.y, col.z);
          if (col.d < r - 0.6 && r >= 2) {
            rec.set(dim, col.x, t.y, col.z, "minecraft:air");
            rec.set(dim, col.x, t.y - 1, col.z, mode.a);
            if (col.d < r - 2 && r >= 4) {
              rec.set(dim, col.x, t.y - 1, col.z, "minecraft:air");
              rec.set(dim, col.x, t.y - 2, col.z, mode.a);
            }
          } else rec.set(dim, col.x, t.y, col.z, mode.a);
        }
        break;
      case "water": {
        // Fill at the clicked height; dam any edge that would let water escape.
        const wy = c.y;
        const inside = new Set(cols.map((q) => q.x + "," + q.z));
        for (const col of cols) {
          const t = topGround(dim, col.x, c.y, col.z, true);
          if (!t) continue;
          const deep = col.d < r - 1;
          const floor = deep ? wy - 2 : wy - 1;
          for (let y = Math.max(t.y, wy) + 2; y > wy; y--) rec.set(dim, col.x, y, col.z, "minecraft:air");
          for (let y = t.y + 1; y < floor; y++) rec.set(dim, col.x, y, col.z, "minecraft:dirt");
          rec.set(dim, col.x, floor, col.z, "minecraft:dirt");
          if (deep) rec.set(dim, col.x, wy - 1, col.z, "minecraft:water");
          rec.set(dim, col.x, wy, col.z, "minecraft:water");
        }
        for (const col of cols) {
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = col.x + dx, nz = col.z + dz;
            if (inside.has(nx + "," + nz)) continue;
            let nb;
            try { nb = dim.getBlock({ x: nx, y: wy, z: nz }); } catch { continue; }
            if (nb && (isPassThrough(nb.typeId) || nb.typeId === "minecraft:air")) rec.set(dim, nx, wy, nz, "golf:turf_rough");
          }
        }
        break;
      }
      case "raise":
        for (const col of cols) {
          const t = topGround(dim, col.x, c.y, col.z);
          if (!t) continue;
          const id = t.block.typeId;
          clearAbove(dim, rec, col.x, t.y, col.z);
          rec.set(dim, col.x, t.y + 1, col.z, id);
          rec.set(dim, col.x, t.y, col.z, "minecraft:dirt");
        }
        break;
      case "lower":
        for (const col of cols) {
          const t = topGround(dim, col.x, c.y, col.z);
          if (!t) continue;
          const id = t.block.typeId;
          clearAbove(dim, rec, col.x, t.y, col.z);
          rec.set(dim, col.x, t.y, col.z, "minecraft:air");
          rec.set(dim, col.x, t.y - 1, col.z, id);
        }
        break;
      case "smooth": {
        const tops = new Map();
        for (const col of columns(c.x, c.z, r + 1)) {
          const t = topGround(dim, col.x, c.y, col.z);
          if (t) tops.set(col.x + "," + col.z, t);
        }
        for (const col of cols) {
          const t = tops.get(col.x + "," + col.z);
          if (!t) continue;
          let sum = 0, n = 0;
          for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
            const q = tops.get(col.x + dx + "," + (col.z + dz));
            if (q) { sum += q.y; n++; }
          }
          const target = Math.round(sum / n);
          const id = t.block.typeId;
          if (target > t.y) { rec.set(dim, col.x, t.y + 1, col.z, id); rec.set(dim, col.x, t.y, col.z, "minecraft:dirt"); }
          else if (target < t.y) { clearAbove(dim, rec, col.x, t.y, col.z); rec.set(dim, col.x, t.y, col.z, "minecraft:air"); rec.set(dim, col.x, t.y - 1, col.z, id); }
        }
        break;
      }
      case "flatten": {
        const ty = c.y;
        for (const col of cols) {
          const t = topGround(dim, col.x, c.y, col.z);
          if (!t) continue;
          const id = t.block.typeId;
          if (t.y > ty) {
            for (let y = Math.min(t.y + 2, ty + 14); y > ty; y--) rec.set(dim, col.x, y, col.z, "minecraft:air");
            rec.set(dim, col.x, ty, col.z, id);
          } else if (t.y < ty) {
            for (let y = Math.max(t.y, ty - 14); y < ty; y++) rec.set(dim, col.x, y, col.z, "minecraft:dirt");
            rec.set(dim, col.x, ty, col.z, id);
            clearAbove(dim, rec, col.x, ty, col.z);
          }
        }
        break;
      }
      case "tree": {
        const n = Math.max(1, Math.round(r / 2));
        for (let i = 0; i < n; i++) {
          const a = Math.random() * Math.PI * 2, d = i === 0 ? 0 : Math.random() * r;
          const x = Math.round(c.x + Math.cos(a) * d), z = Math.round(c.z + Math.sin(a) * d);
          const t = topGround(dim, x, c.y, z);
          if (t) plantTree(dim, rec, x, t.y + 1, z);
        }
        break;
      }
      case "clear":
        for (const col of cols) {
          for (let y = c.y + 20; y >= c.y - 4; y--) {
            let b;
            try { b = dim.getBlock({ x: col.x, y, z: col.z }); } catch { break; }
            if (!b) break;
            const id = b.typeId;
            if (id === "minecraft:air") continue;
            if (isCanopy(id) || (isPassThrough(id) && !id.includes("torch") && !id.includes("rail")) || id.includes("_log") || id.endsWith("_wood")) {
              rec.set(dim, col.x, y, col.z, "minecraft:air");
            }
          }
        }
        break;
    }
  });

  if (rec.changes.length) {
    state.undo.push({ type: "blocks", dim, changes: rec.changes });
    if (state.undo.length > 15) state.undo.shift();
    sound(p, "dig.grass", 1.2, 0.5);
  }
  particle(dim, "golf:aim_dot", { x: c.x + 0.5, y: c.y + 1.2, z: c.z + 0.5 }, [1, 1, 1]);
}

function plantTree(dim, rec, x, y, z) {
  const kinds = [
    { log: "minecraft:oak_log", leaves: "minecraft:oak_leaves", h: 5, r: 2.5, shape: "ball" },
    { log: "minecraft:birch_log", leaves: "minecraft:birch_leaves", h: 6, r: 2.0, shape: "ball" },
    { log: "minecraft:spruce_log", leaves: "minecraft:spruce_leaves", h: 7, r: 2.6, shape: "cone" },
    { log: "minecraft:dark_oak_log", leaves: "minecraft:dark_oak_leaves", h: 5, r: 3.0, shape: "ball" },
  ];
  const k = kinds[Math.floor(Math.random() * kinds.length)];
  const h = k.h + Math.floor(Math.random() * 3);
  const empty = (bx, by, bz) => {
    try { const b = dim.getBlock({ x: bx, y: by, z: bz }); return b && (b.typeId === "minecraft:air" || isPassThrough(b.typeId)); } catch { return false; }
  };
  for (let i = 0; i < h; i++) if (empty(x, y + i, z)) rec.set(dim, x, y + i, z, k.log);
  const R = Math.ceil(k.r);
  for (let dy = -2; dy <= 3; dy++) for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) {
    const by = y + h - 1 + dy;
    let rad = k.r;
    if (k.shape === "cone") rad = Math.max(0.6, k.r * (1 - (dy + 2) / 6));
    if (Math.hypot(dx, dz, k.shape === "ball" ? dy * 0.9 : 0) > rad + Math.random() * 0.4) continue;
    if (empty(x + dx, by, z + dz)) rec.set(dim, x + dx, by, z + dz, k.leaves);
  }
}

function paintContour(p, state, mode, c) {
  const hole = state.holeId ? getHole(state.holeId) : null;
  if (!hole?.green) return msg(p, "§7Pick a hole with a green first (Course Wand → hole → Green → Detect).");
  const g = decode(hole.green);
  const before = hole.green;
  if (mode.delta) bump(g, c.x + 0.5, c.z + 0.5, Math.max(2, state.radius), mode.delta);
  else smoothGrid(g, c.x + 0.5, c.z + 0.5, Math.max(2, state.radius), 0.7);
  hole.green = encode(g);
  saveHole(hole);
  state.undo.push({ type: "green", holeId: hole.id, before });
  if (state.undo.length > 15) state.undo.shift();
  state.showSlope = true;
  sound(p, "random.click", mode.delta > 0 ? 1.6 : 1.2, 0.5);
}

export function undo(p) {
  const state = builderState(p);
  const u = state.undo.pop();
  if (!u) return msg(p, "§7Nothing to undo.");
  if (u.type === "green") {
    const h = getHole(u.holeId);
    if (h) { h.green = u.before; saveHole(h); }
    return msg(p, "§aUndid green contour change.");
  }
  const dim = u.dim ?? overworld();
  let n = 0;
  for (let i = u.changes.length - 1; i >= 0; i--) {
    const ch = u.changes[i];
    try { dim.getBlock(ch)?.setPermutation(ch.perm); n++; } catch { /* unloaded */ }
  }
  msg(p, `§aUndid ${n} blocks.`);
}
