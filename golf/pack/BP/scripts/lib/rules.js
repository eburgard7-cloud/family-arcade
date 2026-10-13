// Golf rules, scoring words and helper decisions. Pure.

import { CLUBS, clubById, pickPuttRange } from "./clubs.js";
import { surfaceInfo } from "./surfaces.js";

/** Suggested par from playing length in meters (USGA men's guideline, slightly generous). */
export function suggestPar(lengthM) {
  if (lengthM <= 230) return 3;
  if (lengthM <= 430) return 4;
  if (lengthM <= 620) return 5;
  return 6;
}

export const CUP_SIZES = {
  kid:  { name: "Kid Cup",   radius: 0.30, gimme: 1.5, desc: "Huge cup, short putts count automatically" },
  fun:  { name: "Fun Cup",   radius: 0.15, gimme: 0.5, desc: "Mario-size cup" },
  real: { name: "Real Cup",  radius: 0.054, gimme: 0, desc: "4.25 inch tournament cup, putt everything out" },
};

export const WIND_LEVELS = {
  calm:   { name: "Calm", max: 0 },
  breezy: { name: "Breezy", max: 5 },
  gusty:  { name: "Gusty", max: 10 },
};

/** Random wind {x, z, speed, yaw} in m/s for a hole. */
export function rollWind(level, rand = Math.random) {
  const max = (WIND_LEVELS[level] ?? WIND_LEVELS.breezy).max;
  if (!max) return { x: 0, z: 0, speed: 0, yaw: 0 };
  const speed = Math.round(rand() * max * 10) / 10;
  const yaw = Math.floor(rand() * 8) * 45;
  const a = (yaw * Math.PI) / 180;
  return { x: -Math.sin(a) * speed, z: Math.cos(a) * speed, speed, yaw };
}

const COMPASS = ["S", "SW", "W", "NW", "N", "NE", "E", "SE"];
/** Compass label for the direction the wind blows TOWARD, from a Minecraft yaw. */
export const windLabel = (yaw) => COMPASS[(((Math.round(yaw / 45) % 8) + 8) % 8)];

/**
 * Arrow describing the wind relative to the player's aim (both Minecraft yaws).
 * Helps: down wind, into wind, left-to-right, right-to-left.
 */
export function windRelative(windYaw, aimYaw) {
  let d = (((windYaw - aimYaw) % 360) + 540) % 360 - 180; // -180..180, + = wind blows to the player's right
  const a = Math.abs(d);
  if (a < 30) return "Helping";
  if (a > 150) return "Into you";
  return d > 0 ? "Left to right" : "Right to left";
}

export function scoreName(strokes, par) {
  if (strokes === 1) return "HOLE IN ONE!";
  const d = strokes - par;
  if (d <= -4) return "Condor!";
  if (d === -3) return "Albatross!";
  if (d === -2) return "Eagle!";
  if (d === -1) return "Birdie!";
  if (d === 0) return "Par";
  if (d === 1) return "Bogey";
  if (d === 2) return "Double Bogey";
  if (d === 3) return "Triple Bogey";
  return `+${d}`;
}

export function toParText(n) {
  if (n === 0) return "E";
  return n > 0 ? `+${n}` : `${n}`;
}

/** Pick-up rule so kids never get stuck on a hole. */
export const maxStrokes = (par, kid) => (kid ? par + 4 : par * 2 + 2);

/**
 * Best club for a shot of `distM` meters from this lie, Mario style (the game
 * picks, the player can change). Uses the golfer's power and lie distance.
 */
export function autoClub(distM, lie, golfer, onGreenOrFringeClose) {
  if (lie === "green") return "putter";
  if (onGreenOrFringeClose) return "putter";
  const mult = (golfer?.power ?? 1) * surfaceInfo(lie).lieDist;
  const full = CLUBS.filter((c) => !c.putter && (c.id !== "driver" || lie === "tee"));
  // shortest club that still gets there
  for (let i = full.length - 1; i >= 0; i--) {
    if (full[i].carry * mult >= distM * 0.97) return full[i].id;
  }
  return full[0].id;
}

/** Clubs available from this lie, in bag order. */
export function clubsFor(lie) {
  return CLUBS.filter((c) => c.id !== "driver" || lie === "tee").map((c) => c.id);
}

export function nextClub(current, lie, delta) {
  const list = clubsFor(lie);
  let i = list.indexOf(current);
  if (i < 0) i = 0;
  i = (i + delta + list.length) % list.length;
  return list[i];
}

/** Default meter power so a full meter is roughly "the right distance". Used for the HUD only. */
export function suggestedPower(clubId, distM, golfer, lie) {
  const c = clubById(clubId);
  if (c.putter) return Math.min(1, distM / pickPuttRange(distM));
  const full = c.carry * (golfer?.power ?? 1) * surfaceInfo(lie).lieDist;
  return Math.min(1, distM / full);
}

/** Order of play: farthest from the hole goes next (players still on the hole). */
export function nextPlayer(players) {
  const live = players.filter((p) => !p.holed && !p.pickedUp);
  if (!live.length) return undefined;
  live.sort((a, b) => b.distToPin - a.distToPin || a.order - b.order);
  return live[0];
}

/** Meters -> yards text. */
export const yd = (m) => `${Math.round(m * 1.0936)}y`;
