// Mario Golf three-tap swing meter. Pure state machine driven by ticks and taps.
//
//   tap 1: start the swing. The cursor runs from the impact line up to the top.
//   tap 2: lock POWER. Stop in the top zone with stars left for a POWER SHOT.
//          The cursor turns around and runs back down.
//   tap 3: lock ACCURACY on the impact line. Early = pull/hook left, late = push/slice right.
//
// Easy Swing skips tap 3 (accuracy is a tiny random wobble).
// Spin is chosen with Jump (topspin) and Sneak (backspin) between tap 2 and tap 3;
// press twice for the super version.

export const IMPACT = 0.1; // cursor position of the impact line (0 = left end, 1 = top)
export const POWER_ZONE = 0.97; // power at or above this is a power shot
const SLOW_ZONE = 0.3;
const SLOW_FACTOR = 0.35;

/**
 * opts.control  golfer control x lie accuracy (bigger = slower meter + wider perfect window)
 * opts.putter   slower, no power shots
 * opts.easy     two-tap mode
 * opts.stars    power shots left
 * opts.rand     () => 0..1
 */
export function newMeter(opts = {}) {
  const control = opts.control ?? 1;
  const base = opts.putter ? 1.7 : 1.0; // seconds for a full upswing
  const upTicks = Math.round(20 * base * (0.75 + 0.25 * control));
  const m = {
    state: "ready", // ready -> up -> down -> done
    pos: IMPACT,
    upSpeed: (1 - IMPACT) / upTicks,
    downSpeed: (1 - IMPACT) / Math.round(upTicks * 0.8),
    perfect: 0, // half-width of the perfect window in cursor units, set below
    power: 0,
    err: 0,
    easy: !!opts.easy,
    putter: !!opts.putter,
    stars: opts.stars ?? 0,
    powerShot: false,
    spinTop: 0,
    spinBack: 0,
    rand: opts.rand ?? Math.random,
    ticks: 0,
  };
  m.perfect = Math.max(0.012 * control * (opts.putter ? 1.6 : 1), m.downSpeed * SLOW_FACTOR * 0.55);
  return m;
}

/** Advance one game tick. Returns "auto" when the meter auto-locked, else undefined. */
export function tickMeter(m) {
  m.ticks++;
  if (m.state === "up") {
    m.pos += m.upSpeed;
    if (m.pos >= 1) {
      m.pos = 1;
      lockPower(m);
      return "auto";
    }
  } else if (m.state === "down") {
    // Slow motion near the impact line: one 20 Hz tick early or late is a mild curve, not a shank.
    m.pos -= m.pos < SLOW_ZONE ? m.downSpeed * SLOW_FACTOR : m.downSpeed;
    if (m.pos <= 0) {
      m.pos = 0;
      m.err = -1.2; // never tapped: big slice
      m.state = "done";
      return "auto";
    }
  }
  return undefined;
}

function lockPower(m) {
  m.power = Math.max(0.02, (m.pos - IMPACT) / (1 - IMPACT));
  m.powerShot = !m.putter && m.power >= POWER_ZONE && m.stars > 0;
  if (m.easy) {
    m.err = (m.rand() - 0.5) * 0.15;
    m.state = "done";
  } else {
    m.state = "down";
  }
}

function lockAccuracy(m) {
  const off = m.pos - IMPACT; // + early (cursor still above the line), - late
  if (Math.abs(off) <= m.perfect) m.err = 0;
  else m.err = Math.max(-1.2, Math.min(1.2, (off - Math.sign(off) * m.perfect) / IMPACT));
  m.state = "done";
}

/** A tap of the swing button. */
export function tapMeter(m) {
  if (m.state === "ready") m.state = "up";
  else if (m.state === "up") lockPower(m);
  else if (m.state === "down") lockAccuracy(m);
  return m.state;
}

export function spinInput(m, which) {
  if (m.state !== "down" && !(m.easy && m.state === "up")) return;
  if (which === "top") { m.spinTop++; m.spinBack = 0; }
  if (which === "back") { m.spinBack++; m.spinTop = 0; }
}

export function spinMode(m) {
  if (m.spinTop) return m.spinTop >= 2 ? "supertop" : "top";
  if (m.spinBack) return m.spinBack >= 2 ? "superback" : "back";
  return "none";
}

export const isPerfect = (m) => m.state === "done" && m.err === 0;

/** Text bar for the action bar. 40 cells. */
export function renderMeter(m, width = 40) {
  const cell = (p) => Math.round(p * (width - 1));
  const cur = cell(m.pos);
  const imp = cell(IMPACT);
  const pz = cell(POWER_ZONE);
  const lockedPow = m.state === "down" || m.state === "done" ? cell(IMPACT + m.power * (1 - IMPACT)) : -1;
  let out = "";
  for (let i = 0; i < width; i++) {
    let ch;
    if (i === cur) ch = "§f█";
    else if (i === imp) ch = "§b|";
    else if (i === lockedPow) ch = m.powerShot ? "§d|" : "§6|";
    else if (m.state === "up" && i > imp && i < cur) ch = i >= pz ? "§c|" : "§e|";
    else if (m.state !== "up" && i > imp && i <= lockedPow) ch = "§e|";
    else if (i >= pz && !m.putter) ch = "§4|";
    else ch = "§8|";
    out += ch;
  }
  return out;
}
