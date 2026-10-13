// Legends: famous real holes, generated on Tower from OpenStreetMap course
// outlines + USGS lidar terrain (see golf/maker/holegen). The generator writes
// structure tiles into the pack and the hole data into legends_data.js.
//
// Placing one: stand where you want the BACK TEE, face anywhere, pick the hole.
// Holes are placed north-up, like the real thing.

import { world } from "@minecraft/server";
import { LEGENDS, CATALOG } from "./legends_data.js";
import { menu, confirm } from "./forms.js";
import { listCourses, newCourse, addHole, saveHole, getCourse } from "./store.js";
import { msg, safe, sound, ENTITIES, isBuilder } from "./util.js";
import { decode, encode } from "../lib/greens.js";
import { placeTeeMarkers } from "./builder.js";
import { M_TO_YD } from "../lib/vec.js";

const LEGENDS_COURSE = "Legends";

export async function legendsMenu(p) {
  if (!isBuilder(p)) return;
  const ready = new Set(LEGENDS.map((l) => l.id));
  const items = LEGENDS.map((l) => ({
    label: `§2${l.name}\n§8${l.course} · Par ${l.par} · ${Math.round(l.lengthM * M_TO_YD)}y`,
    run: () => placeForm(p, l),
  }));
  const pending = CATALOG.filter((c) => !ready.has(c.id));
  for (const c of pending) items.push({ label: `§8${c.name}\n§8not generated yet`, run: () => notReady(p, c) });
  await menu(p, "Legends Holes", LEGENDS.length ? "Stand where the BACK TEE should go, then pick a hole. It is built around you, north-up." : "No famous holes have been generated yet. Run golf-holes on Tower (see golf/README.md), then reinstall the pack.", items);
}

async function notReady(p, c) {
  await menu(p, c.name, `This hole hasn't been generated yet.\n\nOn Tower, run the User Script §lgolf-holes§r, or:\n§7bash /mnt/user/appdata/arcade/scripts/golf-holes.sh ${c.id}\n\nThen run mc-packs to reinstall the golf pack.`, [{ label: "OK" }]);
}

async function placeForm(p, l) {
  const body = [
    `${l.course}, hole ${l.hole}. Par ${l.par}, ${Math.round(l.lengthM * M_TO_YD)} yards.`,
    `Footprint: ${l.size.x} × ${l.size.z} blocks, ${l.size.y} tall.`,
    "",
    "§cEverything in that area gets replaced.§r The back tee lands where you're standing.",
    l.credit ? `\n§8${l.credit}` : "",
  ].join("\n");
  if (!(await confirm(p, l.name, body, "Build it here"))) return;
  await place(p, l);
}

async function place(p, l) {
  const dim = p.dimension;
  const loc = p.location;
  const tee = l.tees.back ?? l.tees.middle;
  const O = { x: Math.floor(loc.x) - Math.floor(tee.x), y: Math.floor(loc.y) - Math.floor(tee.y), z: Math.floor(loc.z) - Math.floor(tee.z) };
  if (O.y < -60 || O.y + l.size.y > 318) return msg(p, "§cToo close to the top or bottom of the world here.");

  msg(p, `§7Building ${l.name}: ${l.tiles.length} pieces...`);
  const tam = world.tickingAreaManager;
  let i = 0;
  for (const t of l.tiles) {
    const at = { x: O.x + t.dx, y: O.y, z: O.z + t.dz };
    const id = `golf_place_${i}`;
    try {
      const opts = { dimension: dim, from: at, to: { x: at.x + t.w - 1, y: at.y + l.size.y - 1, z: at.z + t.d - 1 } };
      if (tam.hasCapacity(opts)) await tam.createTickingArea(id, opts);
      world.structureManager.place(t.id, dim, at);
    } catch (e) {
      msg(p, `§cPiece ${i + 1} failed: ${e}`);
    } finally {
      safe("rmTA", () => { if (tam.hasTickingArea(id)) tam.removeTickingArea(id); });
    }
    i++;
    if (i % 4 === 0) msg(p, `§7${i}/${l.tiles.length}`);
  }

  // Course data
  let course = listCourses().find((c) => c.name === LEGENDS_COURSE);
  if (!course) course = newCourse(LEGENDS_COURSE, 1);
  const off = (v) => (v ? { x: v.x + O.x, y: v.y + O.y, z: v.z + O.z } : null);
  const g = decode(l.green);
  if (g) { g.x0 += O.x; g.z0 += O.z; }
  const hole = addHole(course.id, {
    name: l.name,
    par: l.par,
    tees: { back: off(l.tees.back), middle: off(l.tees.middle), forward: off(l.tees.forward), kids: off(l.tees.kids) },
    pin: off(l.pin),
    green: g ? encode(g) : null,
    legend: l.id,
  });
  safe("cup", () => dim.getBlock({ x: hole.pin.x, y: hole.pin.y - 1, z: hole.pin.z })?.setType("golf:cup"));
  safe("flag", () => {
    const e = dim.spawnEntity(ENTITIES.pin, { x: hole.pin.x + 0.5, y: hole.pin.y, z: hole.pin.z + 0.5 });
    e.addTag(`golf_pin:${hole.id}`);
    e.nameTag = String((getCourse(course.id)?.holes.length ?? 1));
  });
  for (const s of ["back", "middle", "forward", "kids"]) if (hole.tees[s]) placeTeeMarkers(hole, s);
  saveHole(hole);
  sound(p, "random.levelup", 1, 0.8);
  msg(p, `§a${l.name} is ready.§r It's in the "${LEGENDS_COURSE}" course. Test it from the Course Wand.`);
}
