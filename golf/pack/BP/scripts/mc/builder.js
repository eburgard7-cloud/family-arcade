// Course Wand: build and edit courses from menus. Builders only.

import { menu, modal, confirm } from "./forms.js";
import {
  listCourses, getCourse, saveCourse, newCourse, deleteCourse, getHole, saveHole, addHole, deleteHole, moveHole,
  holeNumber, holePar, holeLengthM, validateHole, TEE_SETS, TEE_NAMES, TEE_COLORS, coursePar, playerPrefs, teeFor,
} from "./store.js";
import { builderState, BRUSH_MODES, modeById, undo } from "./brush.js";
import { suggestPar } from "../lib/rules.js";
import { surfaceOf } from "../lib/surfaces.js";
import { makeGrid, tilt, flatten, normalize, encode, decode, sampleCm, maxGradePct, MAX_GRID } from "../lib/greens.js";
import { M_TO_YD, yawToDir } from "../lib/vec.js";
import { ITEMS, ENTITIES, BUILDER_TAG, msg, sound, safe, ensureItem, overworld, isBuilder } from "./util.js";
export { placeTeeMarkers };
import { startRound, roundOf } from "./round.js";
import { legendsMenu } from "./presets.js";

const yds = (m) => `${Math.round(m * M_TO_YD)}y`;

export function giveTools(p) {
  safe("tag", () => p.addTag(BUILDER_TAG));
  ensureItem(p, ITEMS.wand, "Course Wand");
  ensureItem(p, ITEMS.brush, "Course Brush");
  msg(p, "§aCourse tools ready.§r Wand = menus (courses, holes, tees, pins). Brush = paint fairways, greens, bunkers, water. Sneak + Brush = brush settings.");
}

// ---------------------------------------------------------------------------
// Wand
// ---------------------------------------------------------------------------

export async function wandMenu(p) {
  if (!isBuilder(p)) return msg(p, "§cOnly course builders can use the Course Wand.");
  const st = builderState(p);
  const items = [];
  if (st.holeId && st.courseId) {
    const c = getCourse(st.courseId), h = getHole(st.holeId);
    if (c && h) items.push({ label: `§2Keep editing:§r ${c.name} #${holeNumber(c, h.id)}`, run: () => holeMenu(p, c.id, h.id) });
  }
  for (const c of listCourses()) {
    items.push({ label: `${c.name}\n§8${c.holes.length} holes · ${c.scale === 1 ? "Full size" : "Fun size"}`, run: () => courseMenu(p, c.id) });
  }
  items.push({ label: "§a+ New course", run: () => newCourseForm(p) });
  items.push({ label: "Place a Legends hole", run: () => legendsMenu(p) });
  items.push({ label: "Place a club rack here", run: () => placeRack(p) });
  items.push({ label: "Builder help", run: () => help(p) });
  await menu(p, "Course Tools", "Pick a course to edit, or make a new one.", items);
}

async function newCourseForm(p) {
  const v = await modal(p, "New Course", [
    { type: "text", label: "Course name", placeholder: "Cousin Creek Golf Club", default: "" },
    { type: "dropdown", label: "Size", options: ["Full size: 1 block = 1 meter (real distances)", "Fun size: 1 block = 2 meters (half the walking)"], default: 0 },
  ], "Create");
  if (!v) return;
  const name = String(v[0] || "").trim() || `Course ${listCourses().length + 1}`;
  const c = newCourse(name, v[1] === 1 ? 2 : 1);
  msg(p, `§aCreated ${c.name}.`);
  return courseMenu(p, c.id);
}

async function courseMenu(p, courseId) {
  const c = getCourse(courseId);
  if (!c) return;
  const st = builderState(p);
  st.courseId = c.id;
  const items = c.holes.map((hid, i) => {
    const h = getHole(hid) ?? { id: hid };
    const v = validateHole(h, c);
    const par = holePar(h, c);
    const len = holeLengthM(h, c, "back") || holeLengthM(h, c, "middle");
    const mark = v.ok ? (v.warns.length ? "§6!" : "§a✔") : "§c✖";
    return { label: `${mark}§r Hole ${i + 1}${h.name ? ` "${h.name}"` : ""}\n§8Par ${par} · ${len ? yds(len) : "not set"}`, run: () => holeMenu(p, c.id, hid) };
  });
  items.push({ label: "§a+ Add a hole", run: async () => { const h = addHole(c.id); msg(p, `§aAdded hole ${c.holes.length + 1}. Stand on the tee box and choose Set Tee.`); return holeMenu(p, c.id, h.id); } });
  items.push({ label: "Test-play this course (solo)", run: () => testPlay(p, c.id, c.holes) });
  items.push({ label: "Rename / change size", run: () => editCourse(p, c.id) });
  items.push({ label: "§cDelete course", run: async () => { if (await confirm(p, "Delete course?", `Delete ${c.name} and all ${c.holes.length} holes? The blocks stay; only the hole data goes.`, "Delete")) { deleteCourse(c.id); msg(p, "§cCourse deleted."); } } });
  items.push({ label: "« Back", run: () => wandMenu(p) });
  await menu(p, c.name, `${c.holes.length} holes · Par ${coursePar(c)} · ${c.scale === 1 ? "Full size" : "Fun size"}`, items);
}

async function editCourse(p, courseId) {
  const c = getCourse(courseId);
  const v = await modal(p, "Edit Course", [
    { type: "text", label: "Name", default: c.name },
    { type: "dropdown", label: "Size (changes yardages, not blocks)", options: ["Full size: 1 block = 1 meter", "Fun size: 1 block = 2 meters"], default: c.scale === 1 ? 0 : 1 },
  ], "Save");
  if (!v) return courseMenu(p, courseId);
  c.name = String(v[0] || c.name).trim();
  c.scale = v[1] === 1 ? 2 : 1;
  saveCourse(c);
  return courseMenu(p, courseId);
}

async function holeMenu(p, courseId, holeId) {
  const c = getCourse(courseId);
  const h = getHole(holeId);
  if (!c || !h) return;
  const st = builderState(p);
  st.courseId = c.id;
  st.holeId = h.id;
  const n = holeNumber(c, h.id);
  const v = validateHole(h, c);
  const tees = TEE_SETS.map((s) => (h.tees[s] ? `${TEE_COLORS[s]}●§r ${yds(holeLengthM(h, c, s))}` : `§8○`)).join("  ");
  const body = [
    `Par ${holePar(h, c)}${h.par ? "" : " (auto)"} · Tees: ${tees}`,
    h.pin ? `Pin at ${h.pin.x}, ${h.pin.y}, ${h.pin.z}` : "§cNo pin yet",
    h.green ? `Green: ${decode(h.green).w}×${decode(h.green).h}, steepest ${maxGradePct(decode(h.green), c.scale).toFixed(1)}%` : "Green contour: not set (flat)",
    ...v.errs.map((e) => "§c✖ " + e),
    ...v.warns.map((e) => "§6! " + e),
  ].join("\n");
  await menu(p, `${c.name} · Hole ${n}`, body, [
    { label: "Set Tee where I'm standing", run: () => setTeeMenu(p, c.id, h.id) },
    { label: "Set Pin where I'm looking", run: () => setPin(p, c.id, h.id) },
    { label: "Green slope & contours", run: () => greenMenu(p, c.id, h.id) },
    { label: `Par: ${holePar(h, c)}${h.par ? "" : " (auto)"}`, run: () => parMenu(p, c.id, h.id) },
    { label: "Name this hole", run: () => nameHole(p, c.id, h.id) },
    { label: "Test-play this hole", run: () => testPlay(p, c.id, [h.id]) },
    { label: "Go to tee", run: () => { const t = teeFor(h, "back"); if (t) p.teleport(t); } },
    { label: "Go to green", run: () => { if (h.pin) p.teleport({ x: h.pin.x + 0.5, y: h.pin.y, z: h.pin.z + 3.5 }, { facingLocation: { x: h.pin.x + 0.5, y: h.pin.y, z: h.pin.z + 0.5 } }); } },
    { label: "Move hole earlier", run: () => { moveHole(c.id, h.id, -1); return holeMenu(p, c.id, h.id); } },
    { label: "Move hole later", run: () => { moveHole(c.id, h.id, +1); return holeMenu(p, c.id, h.id); } },
    { label: "§cDelete this hole", run: async () => { if (await confirm(p, "Delete hole?", `Delete hole ${n}? Blocks stay.`, "Delete")) { removeMarkers(h.id); deleteHole(c.id, h.id); st.holeId = null; return courseMenu(p, c.id); } } },
    { label: "« Course", run: () => courseMenu(p, c.id) },
  ]);
}

async function setTeeMenu(p, courseId, holeId) {
  await menu(p, "Which tee?", "Stand on the tee box first. Back tees are the longest; Gold kids' tees are the shortest.", [
    ...TEE_SETS.map((s) => ({ label: `${TEE_COLORS[s]}${TEE_NAMES[s]}`, run: () => setTee(p, courseId, holeId, s) })),
    { label: "« Back", run: () => holeMenu(p, courseId, holeId) },
  ]);
}

function setTee(p, courseId, holeId, set) {
  const h = getHole(holeId);
  const c = getCourse(courseId);
  const loc = p.location;
  const bx = Math.floor(loc.x), by = Math.floor(loc.y + 0.01), bz = Math.floor(loc.z);
  const below = safe("blk", () => p.dimension.getBlock({ x: bx, y: by - 1, z: bz }));
  const kind = below ? surfaceOf(below.typeId) : "hard";
  h.tees[set] = { x: bx + 0.5, y: by, z: bz + 0.5 };
  saveHole(h);
  placeTeeMarkers(h, set);
  msg(p, `§aSet ${TEE_NAMES[set]} tee.` + (kind !== "tee" ? " §6(Tip: paint a Tee Box under it with the brush.)" : "") + (h.pin ? ` ${yds(holeLengthM(h, c, set))} to the pin.` : ""));
  sound(p, "random.orb", 1.2, 0.6);
  return holeMenu(p, courseId, holeId);
}

function placeTeeMarkers(h, set) {
  const dim = overworld();
  const tag = `golf_tee:${h.id}:${set}`;
  for (const e of dim.getEntities({ type: ENTITIES.tee, tags: [tag] })) safe("rm", () => e.remove());
  const t = h.tees[set];
  if (!t) return;
  let dir = { x: 0, z: 1 };
  if (h.pin) {
    const dx = h.pin.x + 0.5 - t.x, dz = h.pin.z + 0.5 - t.z;
    const l = Math.hypot(dx, dz) || 1;
    dir = { x: dx / l, z: dz / l };
  }
  const left = { x: dir.z, z: -dir.x };
  const color = TEE_SETS.indexOf(set);
  for (const s of [-1, 1]) {
    safe("tee", () => {
      const e = dim.spawnEntity(ENTITIES.tee, { x: t.x + left.x * 2.2 * s, y: t.y, z: t.z + left.z * 2.2 * s });
      e.addTag(tag);
      e.setProperty("golf:color", color);
    });
  }
}

function removeMarkers(holeId) {
  const dim = overworld();
  for (const type of [ENTITIES.tee, ENTITIES.pin]) {
    for (const e of dim.getEntities({ type })) {
      if (e.getTags().some((t) => t.includes(holeId))) safe("rm", () => e.remove());
    }
  }
}

function setPin(p, courseId, holeId) {
  const h = getHole(holeId);
  const c = getCourse(courseId);
  const hit = safe("ray", () => p.getBlockFromViewDirection({ maxDistance: 160 }));
  if (!hit) return msg(p, "§7Look at a green block (within 160 blocks).");
  const b = hit.block;
  if (surfaceOf(b.typeId) !== "green") return msg(p, "§cThe pin has to go on a green. Paint one with the Course Brush first.");
  const dim = p.dimension;
  // restore old cup
  if (h.pin) safe("old", () => {
    const old = dim.getBlock({ x: h.pin.x, y: h.pin.y - 1, z: h.pin.z });
    if (old?.typeId === "golf:cup") old.setType("golf:turf_green_a");
  });
  for (const e of dim.getEntities({ type: ENTITIES.pin, tags: [`golf_pin:${h.id}`] })) safe("rm", () => e.remove());
  h.pin = { x: b.x, y: b.y + 1, z: b.z };
  safe("cup", () => b.setType("golf:cup"));
  safe("flag", () => {
    const e = dim.spawnEntity(ENTITIES.pin, { x: b.x + 0.5, y: b.y + 1, z: b.z + 0.5 });
    e.addTag(`golf_pin:${h.id}`);
    e.nameTag = `${holeNumber(c, h.id)}`;
  });
  if (!h.green) detectGreenInto(h, dim);
  saveHole(h);
  for (const s of TEE_SETS) if (h.tees[s]) placeTeeMarkers(h, s);
  msg(p, `§aPin set.${h.par ? "" : ` Auto par ${suggestPar(holeLengthM(h, c, "back") || holeLengthM(h, c, "middle"))}.`}`);
  sound(p, "random.orb", 1.4, 0.6);
  return holeMenu(p, courseId, holeId);
}

/** Flood-fill the green around the pin and size the contour grid to it. */
function detectGreenInto(h, dim) {
  const start = { x: h.pin.x, y: h.pin.y - 1, z: h.pin.z };
  const seen = new Set();
  const q = [start];
  let minX = start.x, maxX = start.x, minZ = start.z, maxZ = start.z, n = 0;
  while (q.length && n < 4000) {
    const cur = q.pop();
    const k = cur.x + "," + cur.z;
    if (seen.has(k)) continue;
    seen.add(k);
    if (Math.abs(cur.x - start.x) > MAX_GRID / 2 - 1 || Math.abs(cur.z - start.z) > MAX_GRID / 2 - 1) continue;
    let found = null;
    for (let dy = 2; dy >= -2; dy--) {
      const b = safe("g", () => dim.getBlock({ x: cur.x, y: cur.y + dy, z: cur.z }));
      if (b && surfaceOf(b.typeId) === "green") { found = cur.y + dy; break; }
    }
    if (found === null) continue;
    n++;
    minX = Math.min(minX, cur.x); maxX = Math.max(maxX, cur.x);
    minZ = Math.min(minZ, cur.z); maxZ = Math.max(maxZ, cur.z);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) q.push({ x: cur.x + dx, y: found, z: cur.z + dz });
  }
  const old = decode(h.green);
  const g = makeGrid(minX - 1, minZ - 1, maxX - minX + 3, maxZ - minZ + 3);
  if (old) for (let j = 0; j < g.h; j++) for (let i = 0; i < g.w; i++) g.cm[i + j * g.w] = sampleCm(old, g.x0 + i + 0.5, g.z0 + j + 0.5);
  h.green = encode(g);
  return n;
}

async function greenMenu(p, courseId, holeId) {
  const h = getHole(holeId);
  const c = getCourse(courseId);
  const st = builderState(p);
  st.holeId = holeId;
  if (!h.pin) return msg(p, "§7Set the pin first.");
  const g = decode(h.green);
  await menu(p, "Green", g ? `Contour grid ${g.w}×${g.h} · steepest ${maxGradePct(g, c.scale).toFixed(1)}%\nReal greens: 1-3%. Over 4% is very hard to putt.\nSculpt bumps with the Course Brush (Green Contour modes).` : "No contour grid yet.", [
    { label: "Detect green size from blocks", run: () => { const n = detectGreenInto(h, p.dimension); saveHole(h); msg(p, `§aGreen detected: ${n} blocks.`); return greenMenu(p, courseId, holeId); } },
    { label: "Tilt the green", run: () => tiltForm(p, courseId, holeId) },
    { label: st.showSlope ? "Hide slope dots" : "Show slope dots", run: () => { st.showSlope = !st.showSlope; return greenMenu(p, courseId, holeId); } },
    { label: "Sculpt with the brush", run: () => { st.mode = "g_raise"; st.showSlope = true; msg(p, "§aBrush set to Green Contour: Raise. Sneak + Brush to switch to Lower or Smooth."); } },
    { label: "§cFlatten contours", run: () => { if (g) { flatten(g); h.green = encode(g); saveHole(h); } return greenMenu(p, courseId, holeId); } },
    { label: "« Hole", run: () => holeMenu(p, courseId, holeId) },
  ]);
}

async function tiltForm(p, courseId, holeId) {
  const h = getHole(holeId);
  const c = getCourse(courseId);
  const dirs = ["Back to front (toward the tee)", "Front to back (away from the tee)", "Left to right", "Right to left", "Toward north", "Toward south", "Toward east", "Toward west"];
  const v = await modal(p, "Tilt Green", [
    { type: "dropdown", label: "Which way does it fall?", options: dirs, default: 0 },
    { type: "slider", label: "Slope (percent ×10, e.g. 15 = 1.5%)", min: 0, max: 40, step: 5, default: 15 },
    { type: "toggle", label: "Add to existing contours (off = start flat)", default: false },
  ], "Apply");
  if (!v) return greenMenu(p, courseId, holeId);
  let g = decode(h.green);
  if (!g) { detectGreenInto(h, p.dimension); g = decode(h.green); }
  if (!v[2]) flatten(g);
  const tee = teeFor(h, "middle");
  let toTee = { x: 0, z: 1 };
  if (tee) { const dx = tee.x - (h.pin.x + 0.5), dz = tee.z - (h.pin.z + 0.5); const l = Math.hypot(dx, dz) || 1; toTee = { x: dx / l, z: dz / l }; }
  const right = { x: toTee.z, z: -toTee.x }; // right-hand side when looking from the tee toward the green
  const vecs = [toTee, { x: -toTee.x, z: -toTee.z }, right, { x: -right.x, z: -right.z }, { x: 0, z: -1 }, { x: 0, z: 1 }, { x: 1, z: 0 }, { x: -1, z: 0 }];
  const d = vecs[v[0]];
  tilt(g, d.x, d.z, v[1] / 10, c.scale);
  normalize(g, h.pin.x + 0.5, h.pin.z + 0.5);
  h.green = encode(g);
  saveHole(h);
  builderState(p).showSlope = true;
  msg(p, `§aGreen tilted ${(v[1] / 10).toFixed(1)}%. Slope dots are on.`);
  return greenMenu(p, courseId, holeId);
}

async function parMenu(p, courseId, holeId) {
  const h = getHole(holeId);
  const c = getCourse(courseId);
  const auto = suggestPar(holeLengthM(h, c, "back") || holeLengthM(h, c, "middle"));
  await menu(p, "Par", `Auto par from length: ${auto}`, [
    { label: `Auto (${auto})`, run: () => { h.par = null; saveHole(h); } },
    ...[3, 4, 5, 6].map((n) => ({ label: `Par ${n}`, run: () => { h.par = n; saveHole(h); } })),
  ]);
  return holeMenu(p, courseId, holeId);
}

async function nameHole(p, courseId, holeId) {
  const h = getHole(holeId);
  const v = await modal(p, "Hole name", [{ type: "text", label: "Name (optional)", placeholder: "The Lighthouse", default: h.name ?? "" }], "Save");
  if (v) { h.name = String(v[0] ?? "").trim().slice(0, 32); saveHole(h); }
  return holeMenu(p, courseId, holeId);
}

function testPlay(p, courseId, holeIds) {
  if (roundOf(p)) return msg(p, "§7Finish or leave your current round first.");
  const c = getCourse(courseId);
  const playable = holeIds.filter((id) => validateHole(getHole(id) ?? {}, c).ok);
  if (!playable.length) return msg(p, "§cNo playable holes yet (each needs a tee and a pin).");
  const prefs = playerPrefs(p);
  startRound({ courseId, holeIds: playable, practice: true, settings: { cup: "fun", wind: "breezy", stars: 6 } }, [{ player: p, golfer: prefs.golfer, tees: "back", easy: prefs.easy }]);
}

function placeRack(p) {
  safe("rack", () => {
    const yaw = p.getRotation().y;
    const d = yawToDir(yaw);
    const e = p.dimension.spawnEntity(ENTITIES.rack, { x: Math.floor(p.location.x + d.x * 2) + 0.5, y: Math.floor(p.location.y), z: Math.floor(p.location.z + d.z * 2) + 0.5 });
    e.setRotation({ x: 0, y: yaw + 180 });
    e.nameTag = "Golf Clubs";
    msg(p, "§aClub rack placed. Anyone can use it to grab clubs and start a round.");
  });
}

async function help(p) {
  await menu(p, "Builder Help", [
    "§lMaking a hole§r",
    "1. Paint it with the Course Brush: Tee Box, Fairway, Green, Bunkers, Water. Rough is any grass.",
    "2. Wand → course → Add a hole.",
    "3. Stand on the tee box → Set Tee (Blue back / White / Red / Gold kids).",
    "4. Look at the green → Set Pin. The green is detected automatically.",
    "5. Green slope → Tilt (1-2% is realistic), sculpt bumps with the brush.",
    "6. Test-play it. Done!",
    "",
    "§lBrush§r: Use = paint where you look. Sneak + Use = mode, size, undo.",
    "Fairway and tee stripes follow the direction of the hole you're editing.",
    "",
    "§lSurfaces§r: grass = rough, grass with tall plants = deep rough, sand = bunker, gravel = hard, dirt path = cart path, leaves slow the ball, water and lava are hazards.",
  ].join("\n"), [{ label: "OK" }]);
}

// ---------------------------------------------------------------------------
// Brush settings
// ---------------------------------------------------------------------------

export async function brushMenu(p) {
  if (!isBuilder(p)) return msg(p, "§cOnly course builders can use the Course Brush.");
  const st = builderState(p);
  const cur = modeById(st.mode);
  const c = st.courseId ? getCourse(st.courseId) : null;
  const h = st.holeId ? getHole(st.holeId) : null;
  await menu(p, "Course Brush", `Mode: §l${cur.label}§r · Size ${st.radius}${h && c ? `\nEditing ${c.name} hole ${holeNumber(c, h.id)} (stripes follow this hole)` : ""}`, [
    { label: "Undo last stroke", run: () => undo(p) },
    { label: `Size: ${st.radius} (change)`, run: () => sizeForm(p) },
    ...BRUSH_MODES.map((m) => ({ label: (m.id === st.mode ? "§2▶ " : "") + m.label, run: () => { st.mode = m.id; if (m.kind === "contour") st.showSlope = true; msg(p, `§aBrush: ${m.label}`); } })),
  ]);
}

async function sizeForm(p) {
  const st = builderState(p);
  const v = await modal(p, "Brush size", [{ type: "slider", label: "Radius in blocks", min: 0, max: 12, step: 1, default: st.radius }], "Set");
  if (v) st.radius = v[0];
}

