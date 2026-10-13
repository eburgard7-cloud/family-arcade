// End-to-end: load the real pack scripts against an in-memory Minecraft,
// build a hole through the Course Wand menus, then play it with scripted taps.
// Run: node --import ./golf/tests/harness/loader.mjs --test golf/tests/e2e.test.mjs

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";

// Generate the offline "synthetic" Legends hole into the pack, restore afterwards.
const DATA_JS = new URL("../pack/BP/scripts/mc/legends_data.js", import.meta.url);
const STRUCTS = new URL("../pack/BP/structures/golf/", import.meta.url);
const originalData = readFileSync(DATA_JS, "utf8");
execFileSync("python3", [new URL("../maker/holegen/holegen.py", import.meta.url).pathname, "--synthetic"]);
after(() => {
  writeFileSync(DATA_JS, originalData);
  for (const f of readdirSync(STRUCTS)) if (f.startsWith("synthetic1_")) rmSync(new URL(f, STRUCTS));
});
import * as MC from "./harness/mc-server.mjs";
import { __answers, __shown } from "./harness/mc-ui.mjs";

const Y = 64;
// A 300 m par 4: tee at z=0, fairway, a pond on the right, green centered at (0, 300).
MC.__setGround((x, y, z) => {
  if (y >= Y) return "minecraft:air";
  if (y < Y - 1) return "minecraft:dirt";
  if (Math.hypot(x, z - 300) <= 13) return "golf:turf_green_a";
  if (Math.hypot(x, z - 300) <= 15) return "golf:turf_fringe";
  if (z >= 140 && z <= 170 && x >= 18 && x <= 45) return "minecraft:water";
  if (z >= -3 && z <= 3 && Math.abs(x) <= 3) return "golf:turf_tee_a";
  if (z > 3 && z < 290 && Math.abs(x) <= 18) return "golf:turf_fairway_a";
  return "minecraft:grass_block";
});

const commands = {};
await import("../pack/BP/scripts/main.js");
MC.system.beforeEvents.startup.fire({
  customCommandRegistry: { registerCommand: (def, cb) => (commands[def.name] = { def, cb }) },
});
MC.world.afterEvents.worldLoad.fire({});
const R = await import("../pack/BP/scripts/mc/round.js");
const S = await import("../pack/BP/scripts/mc/store.js");

const eric = MC.__addPlayer("Eric", { x: 0.5, y: Y, z: 0.5 });
const kid = MC.__addPlayer("Lily", { x: 3.5, y: Y, z: 0.5 });

async function settle(ticks = 2) {
  for (let i = 0; i < ticks; i++) {
    MC.__tick(1);
    await MC.__flush();
  }
}
const use = (p, typeId = "golf:club") => MC.world.afterEvents.itemUse.fire({ source: p, itemStack: { typeId } });

test("all commands register with valid names", () => {
  for (const n of ["golf:menu", "golf:club", "golf:quit", "golf:tools", "golf:builder", "golf:reset"]) assert.ok(commands[n], n);
});

test("build a hole with the Course Wand", async () => {
  MC.__tick(1);
  commands["golf:tools"].cb({ sourceEntity: eric });
  await settle();
  assert.ok(eric.hasTag("golf_builder"));
  const invIds = eric.inv.items.filter(Boolean).map((i) => i.typeId);
  assert.ok(invIds.includes("golf:course_wand") && invIds.includes("golf:course_brush"));

  // New course
  __answers.push({ selection: "New course" }, { formValues: ["Cousin Creek", 0] }, "close");
  use(eric, "golf:course_wand");
  await settle(4);
  const c = S.listCourses().find((x) => x.name === "Cousin Creek");
  assert.ok(c, "course created");

  // Add a hole, set the back tee standing on the tee box
  eric.teleport({ x: 0.5, y: Y, z: 0.5 });
  __answers.push({ selection: "Cousin Creek" }, { selection: "Add a hole" }, { selection: "Set Tee" }, { selection: "Blue" }, "close");
  MC.__tick(3);
  use(eric, "golf:course_wand");
  await settle(8);
  let h = S.getHole(S.getCourse(c.id).holes[0]);
  assert.ok(h?.tees.back, "back tee set");

  // Set the pin looking at the green center
  eric.lookAt = { x: 0, y: Y - 1, z: 300 };
  __answers.push({ selection: "Keep editing" }, { selection: "Set Pin" }, "close");
  MC.__tick(3);
  use(eric, "golf:course_wand");
  await settle(8);
  h = S.getHole(h.id);
  assert.deepEqual(h.pin, { x: 0, y: Y, z: 300 });
  assert.ok(h.green, "green auto-detected");
  assert.equal(S.holePar(h, S.getCourse(c.id)), 4);
  assert.equal(S.validateHole(h, S.getCourse(c.id)).ok, true);

  // Tilt the green 2% back to front
  __answers.push({ selection: "Keep editing" }, { selection: "Green slope" }, { selection: "Tilt" }, { formValues: [0, 20, false] }, "close");
  MC.__tick(3);
  use(eric, "golf:course_wand");
  await settle(10);
  h = S.getHole(h.id);
  const { decode, maxGradePct } = await import("../pack/BP/scripts/lib/greens.js");
  assert.ok(Math.abs(maxGradePct(decode(h.green)) - 2) < 0.2);
});

test("course brush paints a bunker and undo restores it", async () => {
  eric.lookAt = { x: 30, y: Y - 1, z: 100 };
  eric.isSneaking = true;
  __answers.push({ selection: "Bunker" });
  MC.__tick(3);
  use(eric, "golf:course_brush");
  await settle(4);
  eric.isSneaking = false;
  MC.__tick(3);
  use(eric, "golf:course_brush");
  await settle(2);
  const blk = MC.world.getDimension("overworld").getBlock({ x: 30, y: Y - 2, z: 100 });
  assert.equal(blk.typeId, "golf:bunker_sand");
  eric.isSneaking = true;
  __answers.push({ selection: "Undo" });
  MC.__tick(3);
  use(eric, "golf:course_brush");
  await settle(4);
  eric.isSneaking = false;
  assert.equal(MC.world.getDimension("overworld").getBlock({ x: 30, y: Y - 1, z: 100 }).typeId, "minecraft:grass_block");
});

test("two players play the hole to the end", async () => {
  const c = S.listCourses().find((x) => x.name === "Cousin Creek");
  // Eric starts a round and invites Lily, who picks Lil' Sprout + Easy Swing.
  __answers.push(
    { selection: "Play golf" },
    { selection: "Cousin Creek" },
    { formValues: [0, 0, 1, 0, 6, true] }, // all holes, blue tees, fun cup, calm, 6 stars, invite
    { selection: "Yes" },
    { formValues: [4, 3, true] }, // Lil' Sprout, kids tees, easy swing
  );
  MC.__tick(3);
  use(eric);
  await settle(10);
  const r = [...R.rounds.values()][0];
  assert.ok(r, "round started");
  assert.equal(r.players.length, 2);
  assert.equal(r.players[1].easy, true);

  const pin = { x: 0.5, z: 300.5 };
  let guard = 0;
  let shots = 0;
  const lastPhase = [];
  while (R.rounds.size && guard++ < 20000) {
    const cur = [...R.rounds.values()][0];
    if (cur?.phase === "aim") {
      const p = MC.world.getPlayers().find((x) => x.id === cur.turnId);
      const gp = cur.players.find((x) => x.id === cur.turnId);
      const yaw = (Math.atan2(-(pin.x - gp.ball.x), pin.z - gp.ball.z) * 180) / Math.PI;
      p.setRotation({ x: 0, y: yaw });
      MC.__tick(6); // look at the preview a moment
      use(p);
      shots++;
    } else if (cur?.phase === "swing") {
      const m = cur.meter;
      const p = MC.world.getPlayers().find((x) => x.id === cur.turnId);
      const gp = cur.players.find((x) => x.id === cur.turnId);
      const dist = Math.hypot(gp.ball.x - pin.x, gp.ball.z - pin.z);
      const want = cur.club === "putter" ? Math.min(1, dist / cur.puttRange) * 0.9 + 0.1 : Math.min(1, dist / 180 + 0.1);
      if (m.state === "up" && m.pos >= want) use(p);
      else if (m.state === "down" && m.pos <= 0.115) use(p);
    }
    lastPhase.push(cur?.phase);
    await settle(1);
  }
  assert.equal(R.rounds.size, 0, `round should finish (stuck in ${lastPhase.slice(-3)})`);
  assert.ok(shots >= 4 && shots < 25, `shots ${shots}`);
  const finals = MC.__log.messages.filter((m) => m.includes("Final scores"));
  assert.ok(finals.length >= 1, "final scores announced");
  assert.equal(eric.getGameMode(), MC.GameMode.Survival, "game mode restored");
  assert.notEqual(eric.perms[MC.InputPermissionCategory.LateralMovement], false, "movement unlocked");
  assert.equal([...MC.__entities.values()].filter((e) => e.typeId === "golf:ball").length, 0, "balls cleaned up");
  const rec = S.getRecords(c.id);
  assert.equal(rec.rounds.length, 1);
  console.log("   scores:", finals[0].split("\n").slice(1).join(" / "));
  if (process.env.GOLF_DEBUG) {
    const strip = (x) => x.replace(/§./g, "");
    console.log(MC.__log.messages.filter((m) => /Your shot|Picked|Hole 1 done/.test(m)).map(strip).join("\n"));
    console.log(MC.__log.titles.filter((x) => /\|/.test(x)).map(strip).join("\n"));
  }
});

test("driving range reports yardage and leaving cleans up", async () => {
  eric.teleport({ x: 0.5, y: Y, z: 0.5 });
  eric.setRotation({ x: 0, y: 0 });
  __answers.push({ selection: "Driving range" });
  MC.__tick(3);
  use(eric);
  await settle(20);
  const r = [...R.rounds.values()][0];
  assert.ok(r?.range);
  for (let i = 0; i < 3000 && r.phase !== "aim"; i++) await settle(1);
  r.club = "i7";
  use(eric);
  for (let i = 0; i < 400 && r.phase === "swing"; i++) {
    if (r.meter.state === "up" && r.meter.pos >= 0.999) use(eric);
    else if (r.meter.state === "down" && r.meter.pos <= 0.115) use(eric);
    await settle(1);
  }
  for (let i = 0; i < 2000 && r.phase === "flight"; i++) await settle(1);
  const yards = MC.__log.messages.filter((m) => m.includes("7 Iron: total")).pop();
  assert.ok(yards, "range result message");
  const total = Number(yards.match(/total §f(\d+)y/)[1]);
  assert.ok(total > 120 && total < 175, `7 iron total ${total}y`);
  commands["golf:quit"].cb({ sourceEntity: eric });
  await settle(3);
  assert.equal(R.rounds.size, 0);
  assert.equal(eric.getGameMode(), MC.GameMode.Survival);
});

test("place the Legends test hole and play it", async () => {
  // stand somewhere fresh: the back tee lands here
  eric.teleport({ x: 1000.5, y: Y, z: 1000.5 });
  __answers.push({ selection: "Place a Legends hole" }, { selection: "Test Island" }, { selection: "Build it here" });
  MC.__tick(3);
  use(eric, "golf:course_wand");
  await settle(30);
  assert.equal(MC.__placed.filter((x) => x.startsWith("golf:synthetic1_")).length, 8, "all tiles placed");
  const legends = S.listCourses().find((c) => c.name === "Legends");
  assert.ok(legends, "Legends course created");
  const h = S.getHole(legends.holes[0]);
  const dim = MC.world.getDimension("overworld");
  assert.equal(dim.getBlock({ x: h.pin.x, y: h.pin.y - 1, z: h.pin.z }).typeId, "golf:cup", "cup under the pin");
  const below = dim.getBlock({ x: Math.floor(h.tees.back.x), y: h.tees.back.y - 1, z: Math.floor(h.tees.back.z) }).typeId;
  assert.match(below, /golf:turf_tee_/, "back tee sits on a tee box");
  assert.equal(Math.floor(h.tees.back.x), 1000);
  assert.equal(h.tees.back.y, Y);
  assert.ok(S.validateHole(h, legends).ok);

  // play it solo through the wand's test-play
  const st = (await import("../pack/BP/scripts/mc/brush.js")).builderState(eric);
  st.courseId = legends.id; st.holeId = h.id;
  __answers.push({ selection: "Keep editing" }, { selection: "Test-play this hole" });
  MC.__tick(3);
  use(eric, "golf:course_wand");
  await settle(10);
  const r = [...R.rounds.values()][0];
  assert.ok(r, "test round started");
  const pin = { x: h.pin.x + 0.5, z: h.pin.z + 0.5 };
  let shots = 0, splashes = 0;
  for (let guard = 0; R.rounds.size && guard < 20000; guard++) {
    if (r.phase === "aim") {
      const gp = r.players[0];
      eric.setRotation({ x: 0, y: (Math.atan2(-(pin.x - gp.ball.x), pin.z - gp.ball.z) * 180) / Math.PI });
      MC.__tick(4);
      use(eric);
      shots++;
    } else if (r.phase === "swing") {
      const gp = r.players[0];
      const dist = Math.hypot(gp.ball.x - pin.x, gp.ball.z - pin.z);
      const want = r.club === "putter" ? Math.min(1, dist / r.puttRange) * 0.9 + 0.1 : Math.min(1, dist / 130 + 0.1);
      if (r.meter.state === "up" && r.meter.pos >= want) use(eric);
      else if (r.meter.state === "down" && r.meter.pos <= 0.115) use(eric);
    }
    await settle(1);
  }
  splashes = MC.__log.sounds.filter((x) => x === "random.splash").length;
  assert.equal(R.rounds.size, 0, "test round finished");
  assert.ok(shots >= 1 && shots < 15, `shots ${shots} (splashes ${splashes})`);
  console.log(`   island green test hole: ${shots} shots, ${splashes} in the water`);
});

test("no script errors were logged", () => {
  assert.equal(errors.length, 0, errors.join("\n"));
});

// capture console.warn from safe()
const errors = [];
const warn = console.warn;
console.warn = (...a) => {
  const s = a.join(" ");
  if (s.includes("[golf]") && !s.includes("loaded")) errors.push(s);
  else warn(...a);
};
void __shown;
