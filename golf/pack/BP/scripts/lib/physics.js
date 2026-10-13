// Golf ball physics. Pure module: the world is reached only through a `terrain`
// object, so the same code runs in Minecraft and in Node tests.
//
// Units: positions are WORLD BLOCK coordinates (floats). Velocities, spin,
// gravity and drag are real SI units. `scale` = real meters per block
// (1 = championship/full size, 2 = fun size). Moving the ball converts
// meters -> blocks with v * dt / scale.
//
// terrain.block(x, y, z) -> { id: string, states?: object } | null (null = chunk not loaded)
// terrain.green          -> greens grid for this hole (optional)

import { scale as vscale, cross, len, lenXZ, norm, yawToDir, rotateLeft, leftOf, DEG, clamp, rng } from "./vec.js";
import { CLUBS, clubById } from "./clubs.js";
import { surfaceInfo, surfaceOf, isPassThrough, isCanopy, isLiquid, isTallPlant, blockTopFraction } from "./surfaces.js";
import { sampleCm, gradient, inGrid } from "./greens.js";

export const PHYS = {
  g: 9.81,
  rho: 1.225,
  r: 0.02135,       // ball radius, m
  m: 0.04593,       // ball mass, kg
  cd: 0.21,         // drag coefficient at zero spin
  cdPerS: 0.35,     // extra drag per unit spin factor (spinning balls drag more)
  clPerS: 2.0,      // lift coefficient per unit spin factor S = r*w/v
  clMax: 0.32,
  spinTau: 22,      // spin decay time constant, s
  dt: 0.01,         // integration step, s
  bounceMin: 1.1,   // vertical speed (m/s) below which the ball stops bouncing and rolls
  roll57: 5 / 7,    // rolling solid sphere: slope gravity factor
  restSpeed: 0.03,  // m/s
  maxTime: 120,     // s, safety stop
  skidTime: 0.7,    // s after landing during which spin adds braking
  skidPerKrpm: 0.5, // m/s^2 of extra braking per 1000 rpm of launch spin
  rampMax: 1.05,    // blocks: steps this tall are rolled over like a slope
  rampFactor: 0.7,  // 7/10: rolling ball, 5/7 of energy is translational
};
const K = (0.5 * PHYS.rho * Math.PI * PHYS.r * PHYS.r) / PHYS.m; // 1/m

const rpmToRad = (rpm) => (rpm * 2 * Math.PI) / 60;

// ---------------------------------------------------------------------------
// Air
// ---------------------------------------------------------------------------

/** Acceleration in flight. v and wind in m/s, w = spin vector in rad/s. */
export function airAccel(v, wind, w) {
  const vr = { x: v.x - wind.x, y: v.y, z: v.z - wind.z };
  const s = len(vr);
  const a = { x: 0, y: -PHYS.g, z: 0 };
  if (s < 1e-6) return a;
  const spin = len(w);
  const S = (PHYS.r * spin) / s;
  const drag = -K * (PHYS.cd + PHYS.cdPerS * Math.min(S, 0.5)) * s;
  a.x += drag * vr.x; a.y += drag * vr.y; a.z += drag * vr.z;
  if (spin > 1e-6) {
    const cl = Math.min(PHYS.clMax, PHYS.clPerS * S);
    const dir = norm(cross(vscale(w, 1 / spin), vscale(vr, 1 / s)));
    const lift = K * cl * s * s;
    a.x += lift * dir.x; a.y += lift * dir.y; a.z += lift * dir.z;
  }
  return a;
}

/** One RK2 (midpoint) step of free flight in meters. Returns new {p, v}. */
function airStepMeters(p, v, wind, w, dt) {
  const a1 = airAccel(v, wind, w);
  const vm = { x: v.x + a1.x * dt * 0.5, y: v.y + a1.y * dt * 0.5, z: v.z + a1.z * dt * 0.5 };
  const a2 = airAccel(vm, wind, w);
  return {
    p: { x: p.x + vm.x * dt, y: p.y + vm.y * dt, z: p.z + vm.z * dt },
    v: { x: v.x + a2.x * dt, y: v.y + a2.y * dt, z: v.z + a2.z * dt },
  };
}

/** Launch velocity + spin vector for a horizontal direction d. */
export function launchVectors(d, speed, launchDeg, spinRpm, tiltDeg) {
  const c = Math.cos(launchDeg * DEG), s = Math.sin(launchDeg * DEG);
  const v = { x: d.x * c * speed, y: s * speed, z: d.z * c * speed };
  // Backspin axis points to the golfer's right; tilting it toward +y curves the ball left (draw).
  const right = vscale(leftOf(d), -1);
  const t = tiltDeg * DEG;
  const axis = norm({ x: right.x * Math.cos(t), y: Math.sin(t), z: right.z * Math.cos(t) });
  return { v, w: vscale(axis, rpmToRad(spinRpm)) };
}

/** Flat-ground, no-wind flight in meters. Returns carry, apex, flight time, landing angle and points. */
export function flyFlat(speed, launchDeg, spinRpm, tiltDeg = 0, wind = { x: 0, z: 0 }, keepPoints = false) {
  const d = { x: 0, y: 0, z: 1 };
  let { v, w } = launchVectors(d, speed, launchDeg, spinRpm, tiltDeg);
  let p = { x: 0, y: 0, z: 0 };
  let t = 0, apex = 0;
  const pts = keepPoints ? [{ ...p }] : null;
  while (t < 30) {
    const prev = p;
    ({ p, v } = airStepMeters(p, v, wind, w, PHYS.dt));
    w = vscale(w, Math.exp(-PHYS.dt / PHYS.spinTau));
    t += PHYS.dt;
    apex = Math.max(apex, p.y);
    if (pts && Math.round(t / PHYS.dt) % 5 === 0) pts.push({ ...p });
    if (p.y <= 0 && v.y < 0) {
      const f = prev.y / (prev.y - p.y);
      const land = { x: prev.x + (p.x - prev.x) * f, z: prev.z + (p.z - prev.z) * f };
      return {
        carry: Math.hypot(land.x, land.z), side: land.x, apex, time: t,
        landAngle: Math.atan2(-v.y, lenXZ(v)) / DEG, landV: v, points: pts,
      };
    }
  }
  return { carry: Math.hypot(p.x, p.z), side: p.x, apex, time: t, landAngle: 90, landV: v, points: pts };
}

// ---------------------------------------------------------------------------
// Calibration: solve ball speed so each club's full-power carry is exact.
// ---------------------------------------------------------------------------

const calib = new Map();

export function clubSpeed(club) {
  if (club.putter) return 0;
  if (calib.has(club.id)) return calib.get(club.id);
  let lo = 5, hi = 140;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (flyFlat(mid, club.launch, club.spinRpm).carry < club.carry) lo = mid; else hi = mid;
  }
  const v = (lo + hi) / 2;
  calib.set(club.id, v);
  return v;
}

export function calibrateAll() {
  for (const c of CLUBS) clubSpeed(c);
}

/** Power fraction (0..1) -> speed multiplier. Exponent chosen so carry scales ~linearly with power. */
export const POWER_EXP = 0.58;
export const powerToSpeed = (p) => Math.pow(clamp(p, 0.02, 1.25), POWER_EXP);

// ---------------------------------------------------------------------------
// Shots
// ---------------------------------------------------------------------------

export const SPIN_MODES = {
  // spin/launch change the flight a little; bite/roll do the real work on landing.
  none:      { label: "",           spin: 1.0,  launch: 0,    bite: 0,    roll: 1.0 },
  back:      { label: "Backspin",   spin: 1.12, launch: 0.5,  bite: 0.45, roll: 1.0 },
  superback: { label: "Super Back", spin: 1.25, launch: 1.0,  bite: 0.9,  roll: 1.0 },
  top:       { label: "Topspin",    spin: 0.88, launch: -1.0, bite: -0.3, roll: 1.4 },
  supertop:  { label: "Super Top",  spin: 0.78, launch: -2.0, bite: -0.5, roll: 1.9 },
};

/**
 * Build a shot.
 * o.start   ball position (world blocks, y = surface top)
 * o.yaw     aim direction (Minecraft yaw degrees)
 * o.club    club id
 * o.power   0..1 meter power
 * o.err     -1..1 accuracy error from the meter (+ early = pull/hook left, - late = push/slice right)
 * o.spinMode key of SPIN_MODES
 * o.golfer  golfer stats
 * o.lie     surface key the ball sits on
 * o.wind    {x, z} m/s
 * o.scale   meters per block
 * o.powerShot  bool, Mario power shot (+12 % speed, extra roll)
 * o.puttRange  meters at 100 % for the putter
 * o.cup     {x, y, z} hole location (world blocks, cup center) and o.cupRadius meters
 */
export function createShot(o) {
  const club = clubById(o.club);
  const golfer = o.golfer ?? { power: 1, control: 1, spin: 1, shape: 0, height: 0 };
  const lie = surfaceInfo(o.lie ?? "fairway");
  const mode = SPIN_MODES[o.spinMode ?? "none"] ?? SPIN_MODES.none;
  const scale = o.scale ?? 1;
  const aim = yawToDir(o.yaw ?? 0);
  const err = clamp(o.err ?? 0, -1.2, 1.2);

  const s = {
    phase: "air",
    club: club.id,
    scale,
    p: { ...o.start },
    v: { x: 0, y: 0, z: 0 },
    w: { x: 0, y: 0, z: 0 },
    wind: o.wind ? { x: o.wind.x, y: 0, z: o.wind.z } : { x: 0, y: 0, z: 0 },
    t: 0,
    impacts: 0,
    bite: mode.bite,
    rollBoost: mode.roll * (o.powerShot ? 1.15 : 1),
    spinRpm0: 0,
    start: { ...o.start },
    cup: o.cup,
    cupR: o.cupRadius ?? 0.054,
    green: o.green,
    lastDry: { ...o.start },
    hazardAt: null,
    rand: rng(o.seed ?? 7),
    maxHeight: o.start.y,
    events: [],
  };

  if (club.putter) {
    const range = o.puttRange ?? 15;
    const dist = clamp(o.power ?? 1, 0, 1.1) * range;
    const roll = surfaceInfo("green").roll;
    const speed = Math.sqrt(2 * roll * dist);
    const d = rotateLeft(aim, err * 2.5);
    s.v = { x: d.x * speed, y: 0, z: d.z * speed };
    s.phase = "roll";
    s.rollBoost = 1;
    s.bite = 0;
    return s;
  }

  let lieDist = lie.lieDist;
  if (club.id === "driver" && o.lie !== "tee") lieDist *= 0.93; // driver off the deck
  if (o.lie === "bunker" && (club.id === "sw" || club.id === "pw")) lieDist = Math.max(lieDist, 0.9);

  const speed = clubSpeed(club) * powerToSpeed(o.power ?? 1) * golfer.power * lieDist * (o.powerShot ? 1.12 : 1);
  const spinRpm = club.spinRpm * mode.spin * (golfer.spin ?? 1) ** 0.5 * lie.lieSpin;
  const launch = club.launch + (golfer.height ?? 0) + mode.launch + (o.lie === "deep" ? 3 : 0);
  const tilt = clamp(err * 16 + (golfer.shape ?? 0), -35, 35);
  const d = rotateLeft(aim, err * 6);
  const lv = launchVectors(d, speed, launch, spinRpm, tilt);
  s.v = lv.v;
  s.w = lv.w;
  s.spinRpm0 = spinRpm;
  return s;
}

// ---------------------------------------------------------------------------
// Terrain probing (block coordinates)
// ---------------------------------------------------------------------------

/**
 * Find the ground under (x, y, z), scanning down up to `depth` blocks.
 * Returns { top, kind, id } | { unloaded: true } | { liquid: true, top, kind } | null (nothing found).
 */
export function groundBelow(terrain, x, y, z, depth = 8) {
  const bx = Math.floor(x), bz = Math.floor(z);
  let above = null;
  for (let by = Math.floor(y); by >= Math.floor(y) - depth; by--) {
    const b = terrain.block(bx, by, bz);
    if (!b) return { unloaded: true };
    const id = b.id;
    if (isLiquid(id)) return { liquid: true, top: by + 0.875, kind: surfaceOf(id), id };
    if (isPassThrough(id) || isCanopy(id)) { above = id; continue; }
    const top = by + blockTopFraction(id, b.states);
    if (top > y + 0.001) { above = id; continue; } // inside a block above the probe; keep looking down
    let kind = surfaceOf(id);
    if (kind === "rough" && isTallPlant(above)) kind = "deep";
    let surfaceY = top;
    if (kind === "green" && terrain.green && inGrid(terrain.green, x, z)) {
      surfaceY += sampleCm(terrain.green, x, z) / 100 / (terrain.scale ?? 1);
    }
    return { top: surfaceY, blockTop: top, kind, id };
  }
  return null;
}

function cellOf(p) {
  return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
}

function horizSpeed(v) { return Math.hypot(v.x, v.z); }

function cupDistM(s) {
  if (!s.cup) return Infinity;
  return Math.hypot(s.p.x - s.cup.x, s.p.z - s.cup.z) * s.scale;
}

// ---------------------------------------------------------------------------
// Stepping
// ---------------------------------------------------------------------------

function emit(s, type, extra = {}) {
  s.events.push({ type, t: s.t, p: { ...s.p }, ...extra });
}

function stop(s, phase, extra = {}) {
  s.phase = phase;
  s.v = { x: 0, y: 0, z: 0 };
  emit(s, phase, extra);
}

/** Resolve a ground impact at the ball's current position. */
function impact(s, ground) {
  const surf = surfaceInfo(ground.kind);
  s.impacts++;
  s.p.y = ground.top + 0.001;
  if (surf.hazard) return stop(s, "water", { kind: ground.kind });

  const vh = horizSpeed(s.v);
  const vn = -s.v.y;

  // Slam dunk: dropping straight into the cup.
  if (s.cup && cupDistM(s) < s.cupR * 1.6 && vh < 6 && ground.kind === "green") {
    s.p = { x: s.cup.x, y: s.cup.y - 0.2, z: s.cup.z };
    return stop(s, "holed", { dunk: true });
  }

  // How much horizontal speed survives this impact. Spin bites on the first two.
  let retain = 1 - surf.mu;
  if (s.impacts <= 2) {
    const spinFactor = s.spinRpm0 / 7000;
    retain -= 0.18 * surf.spinBite * spinFactor;
    if (s.bite > 0) retain -= s.bite * surf.spinBite;
    if (s.bite < 0) retain = Math.min(1.02, retain - s.bite * 0.6);
  }
  retain = Math.max(-0.3, retain);
  s.v.x *= retain;
  s.v.z *= retain;
  s.w = vscale(s.w, 0.4);
  if (s.impacts >= 2) s.bite *= 0.3;

  emit(s, "bounce", { kind: ground.kind, speed: vn });
  if (vn * surf.e > PHYS.bounceMin) {
    s.v.y = vn * surf.e;
  } else {
    s.v.y = 0;
    s.phase = "roll";
    s.rollTime = 0;
  }
  s.lastDry = { ...s.p };
}

function stepAir(s, terrain, dt) {
  const prev = { ...s.p };
  const v0 = { ...s.v }, w0 = { ...s.w };
  const pm = { x: 0, y: 0, z: 0 };
  const r = airStepMeters(pm, s.v, s.wind, s.w, dt);
  s.v = r.v;
  s.w = vscale(s.w, Math.exp(-dt / PHYS.spinTau));
  s.p = { x: s.p.x + r.p.x / s.scale, y: s.p.y + r.p.y / s.scale, z: s.p.z + r.p.z / s.scale };
  s.maxHeight = Math.max(s.maxHeight, s.p.y);

  if (s.p.y < -70) return stop(s, "lost", { why: "void" });

  const c = cellOf(s.p);
  const b = terrain.block(c.x, c.y, c.z);
  if (!b) { s.p = prev; s.v = v0; s.w = w0; s.waiting = true; return; }

  if (isLiquid(b.id)) {
    s.hazardAt = { ...s.p };
    return stop(s, "water", { kind: surfaceOf(b.id), entry: { ...s.p }, lastDry: s.lastDry });
  }
  if (isCanopy(b.id)) {
    // Through the leaves: lose speed, rattle a little.
    const k = Math.pow(0.6, dt / 0.05);
    s.v = vscale(s.v, k);
    s.v.x += (s.rand() - 0.5) * 0.6;
    s.v.z += (s.rand() - 0.5) * 0.6;
    if (!s._inCanopy) emit(s, "canopy");
    s._inCanopy = true;
    return;
  }
  s._inCanopy = false;
  if (isPassThrough(b.id)) return;

  // Solid block: landed on top, or hit its side?
  const top = c.y + blockTopFraction(b.id, b.states);
  if (s.p.y >= top) return; // above a slab's top half: still in the air
  if (prev.y >= top - 0.05 && s.v.y <= 0) {
    s.p.y = top;
    const g = groundBelow(terrain, s.p.x, top + 0.01, s.p.z, 2);
    if (g && !g.unloaded) return impact(s, g);
    return impact(s, { top, kind: surfaceOf(b.id), id: b.id });
  }
  // Side or ceiling hit.
  const pc = cellOf(prev);
  if (pc.x !== c.x) s.v.x = -s.v.x * 0.35;
  if (pc.z !== c.z) s.v.z = -s.v.z * 0.35;
  if (pc.y !== c.y) s.v.y = -s.v.y * 0.35;
  s.v.y *= 0.7;
  s.p = prev;
  emit(s, "wall", { id: b.id });
}

function stepRoll(s, terrain, dt) {
  s.rollTime = (s.rollTime ?? 0) + dt;
  const g0 = groundBelow(terrain, s.p.x, s.p.y + 1.2, s.p.z, 4);
  if (g0?.unloaded) { s.rollTime -= dt; s.waiting = true; return; }
  if (!g0) { s.phase = "air"; return; } // nothing under the ball: fall
  if (g0.liquid) { s.hazardAt = { ...s.p }; return stop(s, "water", { kind: g0.kind, entry: { ...s.p }, lastDry: s.lastDry }); }
  const surf = surfaceInfo(g0.kind);

  // Accelerations: rolling resistance and (on greens) slope.
  let ax = 0, az = 0;
  const vh = horizSpeed(s.v);
  const boost = s.rollTime < 1.5 ? s.rollBoost : 1;
  // Skid: right after landing, backspin keeps grabbing the turf before true rolling starts.
  const skid = s.rollTime < PHYS.skidTime ? surf.spinBite * (s.spinRpm0 / 1000) * PHYS.skidPerKrpm * Math.max(0, 1 + s.bite) : 0;
  const decel = (surf.roll + skid) / boost;
  let sx = 0, sz = 0;
  if (g0.kind === "green" && terrain.green && inGrid(terrain.green, s.p.x, s.p.z)) {
    const gr = gradient(terrain.green, s.p.x, s.p.z, s.scale);
    sx = -PHYS.g * PHYS.roll57 * gr.gx;
    sz = -PHYS.g * PHYS.roll57 * gr.gz;
  }
  if (vh > 1e-6) {
    ax += (-decel * s.v.x) / vh;
    az += (-decel * s.v.z) / vh;
  }
  ax += sx; az += sz;

  const nvx = s.v.x + ax * dt;
  const nvz = s.v.z + az * dt;
  const slopeA = Math.hypot(sx, sz);
  if (vh > 1e-6 && nvx * s.v.x + nvz * s.v.z <= 0 && slopeA < decel * 0.9) {
    s.v.x = 0; s.v.z = 0;
  } else if (vh <= 1e-6 && slopeA < decel * 0.9) {
    s.v.x = 0; s.v.z = 0;
  } else {
    s.v.x = nvx; s.v.z = nvz;
  }

  const prev = { ...s.p };
  const vPrev = { x: s.v.x - ax * dt, y: 0, z: s.v.z - az * dt };
  s.p.x += (s.v.x * dt) / s.scale;
  s.p.z += (s.v.z * dt) / s.scale;

  // Cup.
  if (s.cup) {
    const dm = cupDistM(s);
    const speed = horizSpeed(s.v);
    if (dm < s.cupR) {
      if (speed < 1.6) { s.p = { x: s.cup.x, y: s.cup.y - 0.2, z: s.cup.z }; return stop(s, "holed", {}); }
      if (!s._lipped && dm < s.cupR * 0.85) {
        s._lipped = true;
        const turn = (s.rand() < 0.5 ? -1 : 1) * (25 + s.rand() * 35);
        const d = rotateLeft({ x: s.v.x / speed, y: 0, z: s.v.z / speed }, turn);
        s.v = { x: d.x * speed * 0.55, y: 0, z: d.z * speed * 0.55 };
        emit(s, "lip");
      }
    } else if (dm > s.cupR * 2) {
      s._lipped = false;
    }
  }

  const g1 = groundBelow(terrain, s.p.x, s.p.y + 1.2, s.p.z, 4);
  if (g1?.unloaded) { s.p = prev; s.v = vPrev; s.rollTime -= dt; s.waiting = true; return; }
  if (!g1) { s.phase = "air"; s.v.y = 0; return; }
  if (g1.liquid) { s.hazardAt = { ...s.p }; return stop(s, "water", { kind: g1.kind, entry: { ...s.p }, lastDry: s.lastDry }); }
  const dh = g1.top - s.p.y; // blocks
  if (dh > 0.55) {
    // Blocky terrain is a staircase. Treat one-block steps as a ramp the ball can roll
    // up if it has the energy (like a real slope); anything taller is a wall.
    const need = 2 * PHYS.g * dh * s.scale * PHYS.rampFactor;
    const v2 = s.v.x * s.v.x + s.v.z * s.v.z;
    if (dh <= PHYS.rampMax && v2 > need) {
      const k = Math.sqrt((v2 - need) / v2);
      s.v.x *= k; s.v.z *= k;
    } else {
      const pc = cellOf(prev), c = cellOf(s.p);
      if (pc.x !== c.x) s.v.x = -s.v.x * (dh <= PHYS.rampMax ? 0.6 : 0.3);
      if (pc.z !== c.z) s.v.z = -s.v.z * (dh <= PHYS.rampMax ? 0.6 : 0.3);
      s.p = prev;
      if (dh > PHYS.rampMax) emit(s, "wall", { id: g1.id });
      return;
    }
  } else if (dh < -0.3) {
    if (-dh <= PHYS.rampMax) {
      // Roll down a one-block step: pick up speed instead of flying off.
      const v2 = s.v.x * s.v.x + s.v.z * s.v.z;
      const gain = 2 * PHYS.g * -dh * s.scale * PHYS.rampFactor;
      const k = v2 > 1e-9 ? Math.sqrt((v2 + gain) / v2) : 1;
      s.v.x *= k; s.v.z *= k;
    } else {
      // Rolled off a ledge.
      s.phase = "air";
      s.v.y = 0;
      return;
    }
  }
  s.p.y = g1.top;
  if (g1.kind !== "bunker" && !surfaceInfo(g1.kind).hazard) s.lastDry = { ...s.p };

  if (horizSpeed(s.v) < PHYS.restSpeed && slopeA < decel * 0.9) {
    return stop(s, "rest", { kind: g1.kind });
  }
}

/**
 * Advance the shot by `seconds` of game time. Returns the events since the last call.
 * Phases: air -> roll -> rest | holed | water | lost
 */
export function stepShot(s, terrain, seconds) {
  s.events = [];
  s.waiting = false;
  let left = seconds;
  while (left > 1e-9 && (s.phase === "air" || s.phase === "roll")) {
    const dt = Math.min(PHYS.dt, left);
    if (s.phase === "air") stepAir(s, terrain, dt); else stepRoll(s, terrain, dt);
    if (s.waiting) { emit(s, "waiting"); break; } // terrain ahead not loaded yet: try again next tick
    s.t += dt;
    left -= dt;
    if (s.t > PHYS.maxTime) {
      const g = groundBelow(terrain, s.p.x, s.p.y + 0.6, s.p.z, 6);
      stop(s, "rest", { kind: g?.kind ?? "hard", timeout: true });
    }
  }
  return s.events;
}

export const isDone = (s) => s.phase !== "air" && s.phase !== "roll";

/** Run a shot to completion (tests, previews). */
export function simulate(s, terrain, maxSeconds = PHYS.maxTime) {
  const all = [];
  while (!isDone(s) && s.t < maxSeconds) {
    all.push(...stepShot(s, terrain, 0.5));
    if (s.waiting) { stop(s, "lost", { why: "unloaded" }); all.push(...s.events); break; }
  }
  return all;
}

/**
 * Landing-spot preview: perfect strike, no wind, stops at the first ground contact.
 * Returns { land: {x,y,z} | null, path: [{x,y,z}] } in world blocks.
 */
export function previewCarry(o, terrain, sampleEvery = 6) {
  const s = createShot({ ...o, err: 0, wind: { x: 0, z: 0 }, cup: undefined });
  const path = [];
  if (s.phase === "roll") {
    // Putts: walk the roll path.
    let n = 0;
    while (!isDone(s) && s.t < 30) {
      stepShot(s, terrain, PHYS.dt * 4);
      if (s.waiting) break;
      if (n++ % 2 === 0) path.push({ ...s.p });
    }
    return { land: { ...s.p }, path, putt: true };
  }
  let n = 0;
  while (s.phase === "air" && s.impacts === 0 && s.t < 20) {
    stepShot(s, terrain, PHYS.dt);
    if (s.waiting) return { land: null, path };
    if (n++ % sampleEvery === 0) path.push({ ...s.p });
  }
  return { land: s.phase === "lost" ? null : { ...s.p }, path };
}
