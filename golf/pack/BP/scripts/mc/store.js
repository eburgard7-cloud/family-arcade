// Course storage in world dynamic properties. Everything a builder makes is
// saved inside the world itself (backed up with the world, no files to edit).
//
// golf:courses        [{ id, name, scale, holes: [holeId], created }]
// golf:hole:<id>      { id, courseId, name, par, tees: {back,middle,forward,kids}, pin, pinAlts, green, legend }
// golf:records:<cid>  { rounds: [...], holeInOnes: [...], best: {...} }

import { world } from "@minecraft/server";
import { newId, log } from "./util.js";
import { suggestPar } from "../lib/rules.js";
import { distXZ } from "../lib/vec.js";

const K_COURSES = "golf:courses";
export const TEE_SETS = ["back", "middle", "forward", "kids"];
export const TEE_NAMES = { back: "Blue (back)", middle: "White (middle)", forward: "Red (forward)", kids: "Gold (kids)" };
export const TEE_COLORS = { back: "§9", middle: "§f", forward: "§c", kids: "§6" };

function readJson(key, fallback) {
  try {
    const raw = world.getDynamicProperty(key);
    return raw ? JSON.parse(String(raw)) : fallback;
  } catch (e) {
    log("bad json in", key, e);
    return fallback;
  }
}

function writeJson(key, value) {
  const s = value === undefined ? undefined : JSON.stringify(value);
  if (s && s.length > 32000) throw new Error(`Too much data for ${key} (${s.length} chars). Make the green smaller.`);
  world.setDynamicProperty(key, s);
}

// ---------- courses ----------

export const listCourses = () => readJson(K_COURSES, []);
const saveCourses = (cs) => writeJson(K_COURSES, cs);

export const getCourse = (id) => listCourses().find((c) => c.id === id);

export function saveCourse(course) {
  const cs = listCourses();
  const i = cs.findIndex((c) => c.id === course.id);
  if (i >= 0) cs[i] = course; else cs.push(course);
  saveCourses(cs);
  return course;
}

export function newCourse(name, scale = 1) {
  return saveCourse({ id: newId(), name, scale, holes: [], created: Date.now() });
}

export function deleteCourse(id) {
  const c = getCourse(id);
  if (!c) return;
  for (const h of c.holes) world.setDynamicProperty("golf:hole:" + h, undefined);
  world.setDynamicProperty("golf:records:" + id, undefined);
  saveCourses(listCourses().filter((x) => x.id !== id));
}

// ---------- holes ----------

export const getHole = (id) => readJson("golf:hole:" + id, undefined);
export const saveHole = (h) => (writeJson("golf:hole:" + h.id, h), h);

export function addHole(courseId, data = {}) {
  const c = getCourse(courseId);
  if (!c) throw new Error("No such course");
  const h = {
    id: newId(),
    courseId,
    name: "",
    par: null,
    tees: { back: null, middle: null, forward: null, kids: null },
    pin: null,
    pinAlts: [],
    green: null,
    ...data,
  };
  saveHole(h);
  c.holes.push(h.id);
  saveCourse(c);
  return h;
}

export function deleteHole(courseId, holeId) {
  const c = getCourse(courseId);
  if (!c) return;
  c.holes = c.holes.filter((x) => x !== holeId);
  saveCourse(c);
  world.setDynamicProperty("golf:hole:" + holeId, undefined);
}

export function moveHole(courseId, holeId, delta) {
  const c = getCourse(courseId);
  const i = c.holes.indexOf(holeId);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= c.holes.length) return;
  [c.holes[i], c.holes[j]] = [c.holes[j], c.holes[i]];
  saveCourse(c);
}

export const holeNumber = (course, holeId) => course.holes.indexOf(holeId) + 1;

/** Tee for a tee set, falling back to the nearest set that exists. */
export function teeFor(hole, set) {
  const order = { back: ["back", "middle", "forward", "kids"], middle: ["middle", "back", "forward", "kids"], forward: ["forward", "middle", "kids", "back"], kids: ["kids", "forward", "middle", "back"] }[set] ?? TEE_SETS;
  for (const s of order) if (hole.tees?.[s]) return hole.tees[s];
  return null;
}

/** Playing length in real meters from a tee set to the pin. */
export function holeLengthM(hole, course, set = "middle") {
  const t = teeFor(hole, set);
  if (!t || !hole.pin) return 0;
  return distXZ(t, hole.pin) * (course?.scale ?? 1);
}

export function holePar(hole, course) {
  return hole.par ?? suggestPar(holeLengthM(hole, course, "back") || holeLengthM(hole, course, "middle"));
}

export function coursePar(course) {
  return course.holes.reduce((s, id) => s + holePar(getHole(id) ?? {}, course), 0);
}

/** Problems that would stop a hole from being played. */
export function validateHole(hole, course) {
  const errs = [];
  const warns = [];
  if (!teeFor(hole, "middle")) errs.push("No tee yet. Stand on the tee box and use Set Tee.");
  if (!hole.pin) errs.push("No pin yet. Look at the green and use Set Pin.");
  if (hole.pin && !hole.green) warns.push("Green contour not set: putts will be dead flat. Use Green → Detect.");
  const len = holeLengthM(hole, course, "middle");
  if (len && len < 40) warns.push(`Only ${Math.round(len)} m long.`);
  if (len > 700) warns.push(`${Math.round(len)} m is longer than any real hole.`);
  return { errs, warns, ok: errs.length === 0 };
}

// ---------- records ----------

export const getRecords = (courseId) => readJson("golf:records:" + courseId, { rounds: [], holeInOnes: [], best: {} });

export function addRoundRecord(courseId, entry) {
  const r = getRecords(courseId);
  r.rounds.unshift(entry);
  r.rounds = r.rounds.slice(0, 15);
  for (const p of entry.players) {
    if (!p.complete) continue;
    const prev = r.best[p.name];
    if (!prev || p.total < prev.total) r.best[p.name] = { total: p.total, toPar: p.toPar, date: entry.date };
  }
  writeJson("golf:records:" + courseId, r);
  return r;
}

export function addHoleInOne(courseId, entry) {
  const r = getRecords(courseId);
  r.holeInOnes.unshift(entry);
  r.holeInOnes = r.holeInOnes.slice(0, 20);
  writeJson("golf:records:" + courseId, r);
}

// ---------- per-player settings ----------

export function playerPrefs(p) {
  const d = { golfer: "bea", easy: false, tees: "middle" };
  try {
    const raw = p.getDynamicProperty("golf:prefs");
    return raw ? { ...d, ...JSON.parse(String(raw)) } : d;
  } catch {
    return d;
  }
}

export function savePlayerPrefs(p, prefs) {
  p.setDynamicProperty("golf:prefs", JSON.stringify(prefs));
}
