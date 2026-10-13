// Small 3D vector helpers. Pure: no Minecraft imports, so tests run in Node.

export const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
export const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a, b) => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
export const len = (a) => Math.hypot(a.x, a.y, a.z);
export const lenXZ = (a) => Math.hypot(a.x, a.z);
export const norm = (a) => {
  const l = len(a);
  return l > 1e-9 ? scale(a, 1 / l) : v3();
};
export const distXZ = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

export const DEG = Math.PI / 180;

/** Minecraft yaw (degrees, 0 = south/+z, 90 = west/-x) to a horizontal unit vector. */
export const yawToDir = (yawDeg) => ({ x: -Math.sin(yawDeg * DEG), y: 0, z: Math.cos(yawDeg * DEG) });

/** Horizontal vector to Minecraft yaw in degrees. */
export const dirToYaw = (d) => Math.atan2(-d.x, d.z) / DEG;

/** Unit vector pointing to the left of horizontal direction d (y-up). */
export const leftOf = (d) => norm({ x: d.z, y: 0, z: -d.x });

/** Rotate a horizontal vector by `deg` degrees; positive = to the left. */
export const rotateLeft = (d, deg) => {
  const c = Math.cos(deg * DEG);
  const s = Math.sin(deg * DEG);
  const l = leftOf(d);
  return norm({ x: d.x * c + l.x * s, y: 0, z: d.z * c + l.z * s });
};

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;

/** Deterministic PRNG (mulberry32) so tests and replays are reproducible. */
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const M_TO_YD = 1.0936;
