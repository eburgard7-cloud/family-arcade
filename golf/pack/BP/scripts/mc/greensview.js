// Mario-Golf-style green reading: little dots that drift downhill, colored by
// how steep it is. Used when putting and by builders sculpting a green.

import { gradient, inGrid, sampleCm } from "../lib/greens.js";
import { particle } from "./util.js";

const COLORS = [
  [0.55, 0.85, 1.0], // under 0.75 %: nearly flat (light blue)
  [0.4, 1.0, 0.4],   // 0.75-1.5 %: gentle (green)
  [1.0, 0.95, 0.3],  // 1.5-2.5 %: medium (yellow)
  [1.0, 0.55, 0.15], // 2.5-3.5 %: fast (orange)
  [1.0, 0.2, 0.2],   // 3.5 % +: very fast (red)
];

export function gradeColor(pct) {
  if (pct < 0.75) return COLORS[0];
  if (pct < 1.5) return COLORS[1];
  if (pct < 2.5) return COLORS[2];
  if (pct < 3.5) return COLORS[3];
  return COLORS[4];
}

/**
 * Spawn one wave of slope dots around (cx, cz) within `radius` blocks.
 * baseY = green surface height at the cup (blocks). step = spacing in blocks.
 */
export function showSlope(dim, grid, scale, baseY, cx, cz, radius = 10, step = 2) {
  if (!grid) return;
  const x0 = Math.floor(cx - radius), x1 = Math.ceil(cx + radius);
  const z0 = Math.floor(cz - radius), z1 = Math.ceil(cz + radius);
  for (let x = x0; x <= x1; x += step) {
    for (let z = z0; z <= z1; z += step) {
      const px = x + 0.5, pz = z + 0.5;
      if (!inGrid(grid, px, pz)) continue;
      if ((px - cx) ** 2 + (pz - cz) ** 2 > radius * radius) continue;
      const g = gradient(grid, px, pz, scale);
      const pct = Math.hypot(g.gx, g.gz) * 100;
      const len = Math.hypot(g.gx, g.gz) || 1;
      // dots drift downhill; speed grows with grade
      const sp = Math.min(1.6, 0.25 + pct * 0.35);
      const dir = { x: (-g.gx / len) * sp, y: 0, z: (-g.gz / len) * sp };
      const y = baseY + 0.08 + sampleCm(grid, px, pz) / 100 / scale;
      particle(dim, "golf:slope_dot", { x: px, y, z: pz }, gradeColor(pct), pct < 0.2 ? { x: 0, y: 0, z: 0 } : dir);
    }
  }
}
