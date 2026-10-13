// Putting-green contours.
//
// Minecraft blocks are 1 m tall, real greens slope 1-4 %. So the visible green
// is flat (or stepped for big tiers) and the real contour lives in a small
// height grid: one value per block, in centimeters, read with bilinear
// interpolation. The ball rolls on the grid; players see it as Mario-Golf-style
// flowing slope dots. Builders sculpt it with the green tools; the famous-hole
// generator fills it from lidar.
//
// grid = { x0, z0, w, h, cm: number[] }   cm[i + j*w] at block (x0+i, z0+j) center

export const MAX_GRID = 64;

export function makeGrid(x0, z0, w, h) {
  w = Math.max(1, Math.min(MAX_GRID, Math.round(w)));
  h = Math.max(1, Math.min(MAX_GRID, Math.round(h)));
  return { x0, z0, w, h, cm: new Array(w * h).fill(0) };
}

const at = (g, i, j) => {
  i = i < 0 ? 0 : i >= g.w ? g.w - 1 : i;
  j = j < 0 ? 0 : j >= g.h ? g.h - 1 : j;
  return g.cm[i + j * g.w];
};

export function inGrid(g, x, z) {
  return !!g && x >= g.x0 && z >= g.z0 && x < g.x0 + g.w && z < g.z0 + g.h;
}

/** Height offset in centimeters at world block coords (x, z), bilinear between block centers. */
export function sampleCm(g, x, z) {
  if (!g) return 0;
  const fx = x - g.x0 - 0.5;
  const fz = z - g.z0 - 0.5;
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  const tx = fx - i;
  const tz = fz - j;
  const a = at(g, i, j), b = at(g, i + 1, j), c = at(g, i, j + 1), d = at(g, i + 1, j + 1);
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
}

/**
 * Slope at (x, z) as a gradient in meters of rise per meter of run:
 * { gx, gz } where uphill is +gradient. `scale` = real meters per block.
 */
export function gradient(g, x, z, scale = 1) {
  if (!g) return { gx: 0, gz: 0 };
  const e = 0.25;
  const hx = (sampleCm(g, x + e, z) - sampleCm(g, x - e, z)) / 100;
  const hz = (sampleCm(g, x, z + e) - sampleCm(g, x, z - e)) / 100;
  const run = 2 * e * scale;
  return { gx: hx / run, gz: hz / run };
}

/** Tilt the whole green: `pct` percent grade, falling toward horizontal direction (dx, dz). */
export function tilt(g, dx, dz, pct, scale = 1) {
  const l = Math.hypot(dx, dz) || 1;
  dx /= l; dz /= l;
  const cx = g.x0 + g.w / 2, cz = g.z0 + g.h / 2;
  for (let j = 0; j < g.h; j++) {
    for (let i = 0; i < g.w; i++) {
      const px = g.x0 + i + 0.5 - cx, pz = g.z0 + j + 0.5 - cz;
      const along = (px * dx + pz * dz) * scale; // meters downhill
      g.cm[i + j * g.w] += -along * pct; // pct % = pct cm per meter
    }
  }
  return g;
}

/** Raise (+) or lower (-) a smooth bump of radius r blocks by deltaCm at its center. */
export function bump(g, cx, cz, r, deltaCm) {
  for (let j = 0; j < g.h; j++) {
    for (let i = 0; i < g.w; i++) {
      const d = Math.hypot(g.x0 + i + 0.5 - cx, g.z0 + j + 0.5 - cz);
      if (d >= r) continue;
      const t = d / r;
      const w = 0.5 * (1 + Math.cos(Math.PI * t)); // smooth cosine falloff
      g.cm[i + j * g.w] += deltaCm * w;
    }
  }
  return g;
}

/** Blend toward the local average within radius r (one pass). */
export function smooth(g, cx, cz, r, strength = 0.6) {
  const src = g.cm.slice();
  for (let j = 0; j < g.h; j++) {
    for (let i = 0; i < g.w; i++) {
      if (Math.hypot(g.x0 + i + 0.5 - cx, g.z0 + j + 0.5 - cz) >= r) continue;
      let sum = 0, n = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { sum += at({ ...g, cm: src }, i + di, j + dj); n++; }
      g.cm[i + j * g.w] = src[i + j * g.w] * (1 - strength) + (sum / n) * strength;
    }
  }
  return g;
}

export function flatten(g) {
  g.cm.fill(0);
  return g;
}

/** Re-zero so the cup sits at 0 cm (keeps numbers small and readable). */
export function normalize(g, cupX, cupZ) {
  const c = sampleCm(g, cupX, cupZ);
  for (let k = 0; k < g.cm.length; k++) g.cm[k] = Math.round((g.cm[k] - c) * 10) / 10;
  return g;
}

/** Steepest grade on the green in percent, to warn builders about unputtable slopes. */
export function maxGradePct(g, scale = 1) {
  let m = 0;
  for (let j = 0; j < g.h; j++) for (let i = 0; i < g.w; i++) {
    const s = gradient(g, g.x0 + i + 0.5, g.z0 + j + 0.5, scale);
    m = Math.max(m, Math.hypot(s.gx, s.gz) * 100);
  }
  return m;
}

/** Compact storage: integers in mm, joined. */
export const encode = (g) => ({ x0: g.x0, z0: g.z0, w: g.w, h: g.h, mm: g.cm.map((v) => Math.round(v * 10)).join(",") });
export const decode = (o) => (o ? { x0: o.x0, z0: o.z0, w: o.w, h: o.h, cm: String(o.mm).split(",").map((v) => Number(v) / 10) } : undefined);
