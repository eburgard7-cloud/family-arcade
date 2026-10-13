// Run: node --test golf/tests
import test from "node:test";
import assert from "node:assert/strict";

import { CLUBS } from "../pack/BP/scripts/lib/clubs.js";
import { GOLFERS } from "../pack/BP/scripts/lib/characters.js";
import * as P from "../pack/BP/scripts/lib/physics.js";
import * as G from "../pack/BP/scripts/lib/greens.js";
import * as M from "../pack/BP/scripts/lib/meter.js";
import * as R from "../pack/BP/scripts/lib/rules.js";
import { isPassThrough, isCanopy, surfaceOf, isLiquid } from "../pack/BP/scripts/lib/surfaces.js";

const Y = 64;
/** Flat world: `id` below Y, air above. `extra(x,y,z)` may override blocks. */
const world = (id, extra, green, scale = 1) => ({
  scale,
  green,
  block: (x, y, z) => extra?.(x, y, z) ?? { id: y < Y ? id : "minecraft:air" },
});
const FW = "golf:turf_fairway_a";
const GR = "golf:turf_green_a";
const start = { x: 0.5, y: Y, z: 0.5 };

function shot(o, terrain) {
  const s = P.createShot({ start, yaw: 0, power: 1, lie: o.club === "driver" ? "tee" : "fairway", ...o });
  const ev = P.simulate(s, terrain);
  const firstBounce = ev.find((e) => e.type === "bounce");
  return { s, ev, carry: firstBounce ? Math.hypot(firstBounce.p.x - 0.5, firstBounce.p.z - 0.5) : NaN, total: Math.hypot(s.p.x - 0.5, s.p.z - 0.5) };
}

test("surface matching does not confuse names (fAIRway is not air)", () => {
  assert.equal(isPassThrough("golf:turf_fairway_a"), false);
  assert.equal(isPassThrough("minecraft:air"), true);
  assert.equal(isPassThrough("minecraft:short_grass"), true);
  assert.equal(isPassThrough("minecraft:red_tulip"), true);
  assert.equal(isPassThrough("minecraft:grass_block"), false);
  assert.equal(isPassThrough("minecraft:oak_stairs"), false);
  assert.equal(isCanopy("minecraft:oak_leaves"), true);
  assert.equal(isCanopy("golf:turf_green_a"), false);
  assert.equal(surfaceOf("golf:turf_fairway_b"), "fairway");
  assert.equal(surfaceOf("minecraft:sand"), "bunker");
  assert.equal(isLiquid("minecraft:water"), true);
  assert.equal(isLiquid("minecraft:waterlily"), false);
});

test("every club's full-power carry is calibrated within 0.5 m", () => {
  for (const c of CLUBS) {
    if (c.putter) continue;
    const f = P.flyFlat(P.clubSpeed(c), c.launch, c.spinRpm);
    assert.ok(Math.abs(f.carry - c.carry) < 0.5, `${c.id} carry ${f.carry}`);
  }
});

test("flight shapes look like golf: apex and landing angle", () => {
  const drv = CLUBS.find((c) => c.id === "driver");
  const f = P.flyFlat(P.clubSpeed(drv), drv.launch, drv.spinRpm);
  assert.ok(f.apex > 25 && f.apex < 40, `driver apex ${f.apex}`);
  assert.ok(f.landAngle > 35 && f.landAngle < 50, `driver land ${f.landAngle}`);
  const sw = CLUBS.find((c) => c.id === "sw");
  const g = P.flyFlat(P.clubSpeed(sw), sw.launch, sw.spinRpm);
  assert.ok(g.landAngle > 40, `wedge land ${g.landAngle}`);
  assert.ok(g.time > 3 && g.time < 6);
});

test("half power is about half distance", () => {
  for (const c of CLUBS) {
    if (c.putter) continue;
    const f = P.flyFlat(P.clubSpeed(c) * P.powerToSpeed(0.5), c.launch, c.spinRpm);
    const r = f.carry / c.carry;
    assert.ok(r > 0.42 && r < 0.58, `${c.id} half ratio ${r}`);
  }
});

test("in-world carry matches calibration and rollout is sane", () => {
  const d = shot({ club: "driver" }, world(FW));
  assert.ok(Math.abs(d.carry - 210) < 2, `driver carry ${d.carry}`);
  assert.ok(d.total - d.carry > 6 && d.total - d.carry < 25, `driver roll ${d.total - d.carry}`);
  const i7 = shot({ club: "i7" }, world(FW));
  assert.ok(i7.total - i7.carry > 3 && i7.total - i7.carry < 12, `7i roll ${i7.total - i7.carry}`);
  const wedgeGreen = shot({ club: "sw" }, world(GR));
  assert.ok(wedgeGreen.total - wedgeGreen.carry < 5, "wedge stops on a green");
  const rough = shot({ club: "driver" }, world("minecraft:grass_block"));
  assert.ok(rough.total - rough.carry < 6, "rough kills roll");
  const sand = shot({ club: "i7" }, world("golf:bunker_sand"));
  assert.ok(sand.total - sand.carry < 1.5, "ball plugs in sand");
});

test("spin: backspin checks up, super backspin sucks back, topspin runs", () => {
  const plain = shot({ club: "i9" }, world(GR));
  const back = shot({ club: "i9", spinMode: "back" }, world(GR));
  const sback = shot({ club: "i9", spinMode: "superback" }, world(GR));
  const top = shot({ club: "i9", spinMode: "top" }, world(FW));
  const ptop = shot({ club: "i9" }, world(FW));
  assert.ok(back.total - back.carry < plain.total - plain.carry);
  assert.ok(sback.total - sback.carry < 0, "super backspin comes back");
  assert.ok(top.total - top.carry > ptop.total - ptop.carry + 3);
});

test("power shot goes about 12 % farther", () => {
  const a = shot({ club: "i7" }, world(FW));
  const b = shot({ club: "i7", powerShot: true }, world(FW));
  const r = b.carry / a.carry;
  assert.ok(r > 1.08 && r < 1.2, `ratio ${r}`);
});

test("early tap hooks left, late tap slices right (facing +z, left is +x)", () => {
  const hook = shot({ club: "i7", err: 0.6 }, world(FW));
  const slice = shot({ club: "i7", err: -0.6 }, world(FW));
  assert.ok(hook.s.p.x > 5, `hook x ${hook.s.p.x}`);
  assert.ok(slice.s.p.x < -4, `slice x ${slice.s.p.x}`);
});

test("golfer shapes: Big Moose fades, Pirate Pete draws", () => {
  const moose = GOLFERS.find((g) => g.id === "moose");
  const pete = GOLFERS.find((g) => g.id === "pete");
  assert.ok(shot({ club: "i5", golfer: moose }, world(FW)).s.p.x < -1);
  assert.ok(shot({ club: "i5", golfer: pete }, world(FW)).s.p.x > 1);
});

test("wind: helping adds distance, crosswind drifts", () => {
  const calm = shot({ club: "i7" }, world(FW));
  const help = shot({ club: "i7", wind: { x: 0, z: 6 } }, world(FW));
  const into = shot({ club: "i7", wind: { x: 0, z: -6 } }, world(FW));
  const cross = shot({ club: "i7", wind: { x: 6, z: 0 } }, world(FW));
  assert.ok(help.carry > calm.carry + 5);
  assert.ok(into.carry < calm.carry - 5);
  assert.ok(cross.s.p.x > 3);
});

test("water stops the ball and records the entry point", () => {
  const pond = (x, y, z) => (z >= 100 && z <= 160 && y === Y - 1 ? { id: "minecraft:water" } : undefined);
  const r = shot({ club: "i7" }, world(FW, pond));
  assert.equal(r.s.phase, "water");
  assert.ok(r.ev.some((e) => e.type === "water" && e.entry));
});

test("a tree canopy knocks the ball down", () => {
  const tree = (x, y, z) => (z >= 60 && z <= 66 && y >= Y && y < Y + 30 && Math.abs(x) < 6 ? { id: "minecraft:oak_leaves" } : undefined);
  const r = shot({ club: "i7" }, world(FW, tree));
  assert.ok(r.total < 90, `total ${r.total}`);
});

test("a wall bounces the ball back", () => {
  const wall = (x, y, z) => (z === 50 && y >= Y && y < Y + 60 ? { id: "minecraft:stone" } : undefined);
  const r = shot({ club: "i7" }, world(FW, wall));
  assert.ok(r.s.p.z < 50, `z ${r.s.p.z}`);
  assert.ok(r.ev.some((e) => e.type === "wall"));
});

test("rolling: one-block steps act like slopes, tall walls don't", () => {
  // terrace 1 block up at z=8
  const up = (x, y, z) => (z >= 8 && y === Y ? { id: GR } : undefined);
  const slow = P.createShot({ start, yaw: 0, club: "putter", power: 0.3, puttRange: 15 });
  P.simulate(slow, world(GR, up));
  assert.ok(slow.p.z < 8, "weak putt can't climb a 1 m step");
  const hard = P.createShot({ start, yaw: 0, club: "putter", power: 1, puttRange: 25 });
  P.simulate(hard, world(GR, up));
  assert.ok(hard.p.z > 9 && Math.abs(hard.p.y - (Y + 1)) < 0.01, `firm putt climbs (z=${hard.p.z.toFixed(1)})`);
  // step down: rolls on and speeds up rather than flying
  const down = (x, y, z) => (z >= 6 && y === Y - 1 ? { id: "minecraft:air" } : z >= 6 && y === Y - 2 ? { id: GR } : undefined);
  const d = P.createShot({ start, yaw: 0, club: "putter", power: 0.4, puttRange: 15 });
  P.simulate(d, world(GR, down));
  const flat = P.createShot({ start, yaw: 0, club: "putter", power: 0.4, puttRange: 15 });
  P.simulate(flat, world(GR));
  assert.ok(d.p.z > flat.p.z + 1, "downhill step adds distance");
});

test("unloaded chunks end the shot as lost instead of throwing", () => {
  const edge = (x, y, z) => (z > 80 ? null : undefined);
  const terrain = { block: (x, y, z) => { const e = edge(x, y, z); if (e === null) return null; return { id: y < Y ? FW : "minecraft:air" }; } };
  const r = shot({ club: "i7" }, terrain);
  assert.equal(r.s.phase, "lost");
});

test("putts: right speed drops, too fast lips out, slope breaks", () => {
  const cup = { x: 0.5, y: Y, z: 10.5 };
  const p = P.createShot({ start, yaw: 0, club: "putter", power: 10.3 / 15, puttRange: 15, cup, cupRadius: 0.054 });
  P.simulate(p, world(GR));
  assert.equal(p.phase, "holed");

  const fast = P.createShot({ start, yaw: 0, club: "putter", power: 1, puttRange: 40, cup, cupRadius: 0.054 });
  const ev = P.simulate(fast, world(GR));
  assert.notEqual(fast.phase, "holed");
  assert.ok(ev.some((e) => e.type === "lip"));

  const grid = G.tilt(G.makeGrid(-10, -5, 21, 25), 1, 0, 2); // falls toward +x
  const brk = P.createShot({ start, yaw: 0, club: "putter", power: 10 / 15, puttRange: 15 });
  P.simulate(brk, world(GR, undefined, grid));
  assert.ok(brk.p.x > 0.9, `breaks downhill x=${brk.p.x}`);
});

test("fun scale: same physics, half the blocks", () => {
  const a = shot({ club: "i7", scale: 1 }, world(FW));
  const b = shot({ club: "i7", scale: 2 }, world(FW, undefined, undefined, 2));
  assert.ok(Math.abs(a.carry / b.carry - 2) < 0.05, `${a.carry} vs ${b.carry}`);
});

test("greens grid: tilt sign, encode/decode round trip, max grade", () => {
  const g = G.tilt(G.makeGrid(0, 0, 10, 10), 1, 0, 2);
  const gr = G.gradient(g, 5, 5);
  assert.ok(gr.gx < 0 && Math.abs(gr.gx + 0.02) < 1e-3, `gx ${gr.gx}`);
  const back = G.decode(G.encode(g));
  assert.ok(Math.abs(G.sampleCm(back, 3.3, 7.1) - G.sampleCm(g, 3.3, 7.1)) < 0.11);
  assert.ok(Math.abs(G.maxGradePct(g) - 2) < 0.1);
  G.bump(g, 5, 5, 3, 20);
  assert.ok(G.sampleCm(g, 5, 5) > G.sampleCm(g, 1, 5) - 20);
});

test("meter: taps set power and accuracy; perfect window; auto-lock; easy mode", () => {
  const m = M.newMeter({ control: 1, stars: 2 });
  M.tapMeter(m);
  while (m.pos < 0.6) M.tickMeter(m);
  M.tapMeter(m);
  assert.ok(Math.abs(m.power - (m.pos - M.IMPACT) / (1 - M.IMPACT)) < 1e-9);
  // tap on the tick closest to the impact line
  let best = Infinity;
  while (m.state === "down") {
    const before = m.pos;
    M.tickMeter(m);
    if (Math.abs(m.pos - M.IMPACT) > Math.abs(before - M.IMPACT) && Math.abs(before - M.IMPACT) < 0.05) { m.pos = before; break; }
    best = Math.min(best, Math.abs(m.pos - M.IMPACT));
  }
  M.tapMeter(m);
  assert.equal(m.state, "done");
  assert.equal(m.err, 0, "best-timed tap is perfect");
  // one tick off near impact is only a mild curve
  const m2 = M.newMeter({ control: 1 });
  M.tapMeter(m2); while (m2.pos < 0.8) M.tickMeter(m2); M.tapMeter(m2);
  while (m2.pos > M.IMPACT + 0.03) M.tickMeter(m2);
  M.tapMeter(m2);
  assert.ok(m2.err > 0 && m2.err < 0.45, `one-tick-early err ${m2.err}`);

  const auto = M.newMeter({ control: 1, stars: 1 });
  M.tapMeter(auto);
  let guard = 0;
  while (auto.state === "up" && guard++ < 200) M.tickMeter(auto);
  assert.equal(auto.power, 1);
  assert.equal(auto.powerShot, true);

  const nostars = M.newMeter({ stars: 0 });
  M.tapMeter(nostars);
  while (nostars.state === "up") M.tickMeter(nostars);
  assert.equal(nostars.powerShot, false);

  const easy = M.newMeter({ easy: true });
  M.tapMeter(easy);
  M.tickMeter(easy);
  M.tickMeter(easy);
  M.tapMeter(easy);
  assert.equal(easy.state, "done");
  assert.ok(Math.abs(easy.err) <= 0.08);

  const late = M.newMeter({});
  M.tapMeter(late);
  M.tapMeter(late);
  while (late.state === "down") M.tickMeter(late);
  assert.ok(late.err <= -1.2, "never tapping = big slice");
  const bar = M.renderMeter(late);
  assert.equal((bar.match(/[|█]/g) || []).length, 40);
});

test("rules: par, auto club, order of play, wind text", () => {
  assert.equal(R.suggestPar(140), 3);
  assert.equal(R.suggestPar(380), 4);
  assert.equal(R.suggestPar(500), 5);
  assert.equal(R.autoClub(400, "tee", GOLFERS[0]), "driver");
  assert.equal(R.autoClub(125, "fairway", GOLFERS[0]), "i7");
  assert.equal(R.autoClub(400, "fairway", GOLFERS[0]), "w3");
  assert.equal(R.autoClub(30, "green", GOLFERS[0]), "putter");
  assert.equal(R.nextPlayer([{ distToPin: 10, order: 0 }, { distToPin: 50, order: 1 }, { distToPin: 90, holed: true, order: 2 }]).order, 1);
  assert.equal(R.windRelative(0, 0), "Helping");
  assert.equal(R.windRelative(180, 0), "Into you");
  assert.equal(R.windRelative(90, 0), "Left to right");
  assert.equal(R.scoreName(3, 4), "Birdie!");
  assert.equal(R.scoreName(1, 3), "HOLE IN ONE!");
});

test("landing preview stops at first contact and agrees with the real shot", () => {
  const o = { start, yaw: 0, club: "i7", power: 1, lie: "fairway" };
  const pv = P.previewCarry(o, world(FW));
  const real = shot({ club: "i7" }, world(FW));
  assert.ok(Math.abs(pv.land.z - 0.5 - real.carry) < 1, `${pv.land.z} vs ${real.carry}`);
  assert.ok(pv.path.length > 5);
});

test("performance: a driver shot simulates in well under a tick budget", () => {
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) shot({ club: "driver" }, world(FW));
  const per = (performance.now() - t0) / 20;
  assert.ok(per < 15, `${per.toFixed(2)} ms per full shot`);
});
