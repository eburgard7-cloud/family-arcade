// Rounds: groups of players playing holes in turn, Mario Golf style.
//
// Flow per turn:  aim -> swing (3-tap meter) -> flight (camera follows) -> result -> next turn
// Order of play:  farthest from the hole goes next. Honors on the tee by last hole's score.
//
// While the ball flies, the shooter is switched to spectator and carried along behind
// it. That keeps the chunks under the ball loaded (the server only simulates near
// players) and gives a smooth follow camera. Their game mode is restored after, and
// also on rejoin if the server stopped mid-shot.

import { world, GameMode, EasingType } from "@minecraft/server";
import { clubById, pickPuttRange, PUTT_RANGES } from "../lib/clubs.js";
import { golferById } from "../lib/characters.js";
import { createShot, stepShot, isDone, previewCarry, groundBelow, SPIN_MODES } from "../lib/physics.js";
import { newMeter, tickMeter, tapMeter, spinInput, spinMode, renderMeter } from "../lib/meter.js";
import { rollWind, windRelative, scoreName, toParText, maxStrokes, autoClub, nextClub, nextPlayer, CUP_SIZES } from "../lib/rules.js";
import { decode } from "../lib/greens.js";
import { surfaceInfo, isLiquid, isPassThrough, isCanopy } from "../lib/surfaces.js";
import { distXZ, M_TO_YD } from "../lib/vec.js";
import { getCourse, getHole, holePar, teeFor, addRoundRecord, addHoleInOne, holeNumber } from "./store.js";
import { makeTerrain } from "./terrain.js";
import { showSlope } from "./greensview.js";
import {
  ITEMS, ENTITIES, overworld, safe, later, msg, actionbar, title, sound, worldSound, particle,
  ensureItem, renameItem, lockMovement, saveRestore, restorePlayer, newId,
} from "./util.js";

export const TIME_SCALE = 1.6; // game seconds of ball flight per real second
const TICK = 0.05;

/** @type {Map<string, any>} */
export const rounds = new Map();
/** @type {Map<string, string>} player id -> round id */
export const playerRound = new Map();

const getPlayer = (id) => world.getPlayers().find((p) => p.id === id);
export const roundOf = (p) => rounds.get(playerRound.get(p.id) ?? "");

function group(r, fn) {
  for (const gp of r.players) {
    const p = getPlayer(gp.id);
    if (p) safe("group", () => fn(p, gp));
  }
}
const groupMsg = (r, text) => group(r, (p) => msg(p, text));

// ---------------------------------------------------------------------------
// Starting
// ---------------------------------------------------------------------------

/**
 * opts:     courseId, holeIds, practice, range {at, yaw}, settings {cup, wind, stars}
 * entrants: [{ player, golfer, tees, easy }]
 */
export function startRound(opts, entrants) {
  const r = {
    id: newId(),
    courseId: opts.courseId ?? null,
    course: opts.courseId ? getCourse(opts.courseId) : null,
    holeIds: opts.holeIds ?? [],
    holeIdx: -1,
    practice: !!opts.practice,
    range: opts.range ?? null, // { at: {x,y,z}, yaw }
    settings: { cup: "fun", wind: "breezy", stars: 6, ...(opts.settings ?? {}) },
    players: [],
    phase: "loading",
    turnId: null,
    timer: 0,
    wind: { x: 0, z: 0, speed: 0, yaw: 0 },
    tick: 0,
  };
  entrants.forEach((e, i) => {
    r.players.push({
      id: e.player.id,
      name: e.player.name,
      golfer: e.golfer ?? "bea",
      tees: e.tees ?? "middle",
      easy: !!e.easy,
      order: i,
      scores: [],
      strokes: 0,
      ball: null,
      prevBall: null,
      lie: "tee",
      holed: false,
      pickedUp: false,
      stars: r.settings.stars,
      distToPin: 0,
      ballEntity: null,
    });
    playerRound.set(e.player.id, r.id);
    ensureItem(e.player, ITEMS.club, "Golf Club");
  });
  rounds.set(r.id, r);
  if (r.range) beginRange(r);
  else beginHole(r, 0);
  return r;
}

function beginRange(r) {
  r.hole = null;
  r.pin = null;
  r.scale = 1;
  r.wind = rollWind(r.settings.wind);
  const gp = r.players[0];
  gp.ball = { ...r.range.at };
  gp.lie = "tee";
  r.phase = "between";
  r.timer = 10;
  groupMsg(r, "§aDriving range!§r Tap the club to swing. Sneak / Jump change clubs. §7/golf:quit or the menu to leave.");
}

function beginHole(r, idx) {
  r.holeIdx = idx;
  const hole = getHole(r.holeIds[idx]);
  if (!hole?.pin) {
    groupMsg(r, "§cThat hole isn't finished yet (no pin). Skipping.");
    if (idx + 1 < r.holeIds.length) return beginHole(r, idx + 1);
    return endRound(r, false);
  }
  r.hole = hole;
  r.scale = r.course?.scale ?? 1;
  r.par = holePar(hole, r.course);
  r.grid = decode(hole.green);
  r.pin = { x: hole.pin.x + 0.5, y: hole.pin.y, z: hole.pin.z + 0.5 };
  r.wind = rollWind(r.settings.wind);
  const num = holeNumber(r.course, hole.id);

  for (const gp of r.players) {
    const tee = teeFor(hole, gp.tees);
    gp.ball = tee ? { ...tee } : null;
    gp.prevBall = gp.ball ? { ...gp.ball } : null;
    gp.lie = "tee";
    gp.strokes = 0;
    gp.holed = false;
    gp.pickedUp = !tee;
    gp.distToPin = tee ? distXZ(tee, r.pin) * r.scale : 0;
    placeBallEntity(r, gp);
  }
  // Honors: best score on the last hole tees off first.
  if (idx > 0) {
    const last = (gp) => gp.scores[gp.scores.length - 1] ?? 99;
    [...r.players].sort((a, b) => last(a) - last(b) || a.order - b.order).forEach((gp, i) => (gp.order = i));
  }

  const lenY = Math.round((r.players[0].distToPin || 0) * M_TO_YD);
  const name = hole.name ? ` §7"${hole.name}"` : "";
  group(r, (p, gp) => {
    const tee = teeFor(hole, gp.tees);
    if (tee) safe("tp", () => p.teleport({ x: tee.x, y: tee.y, z: tee.z }, { facingLocation: { ...r.pin, y: r.pin.y + 1 } }));
    title(p, `§lHole ${num}`, `§fPar ${r.par} · ${lenY} yards${name}`, 60);
    sound(p, "note.pling", 1.2);
  });
  groupMsg(r, `§6⛳ Hole ${num}§r · Par ${r.par} · ${lenY}y · Wind: ${windText(r)}`);
  r.phase = "between";
  r.timer = 50;
}

function windText(r) {
  if (!r.wind.speed) return "§7calm";
  const mph = Math.round(r.wind.speed * 2.237);
  return `§b${mph} mph`;
}

// ---------------------------------------------------------------------------
// Ball entities
// ---------------------------------------------------------------------------

function placeBallEntity(r, gp) {
  removeBallEntity(gp);
  if (!gp.ball) return;
  safe("spawnBall", () => {
    const e = overworld().spawnEntity(ENTITIES.ball, gp.ball);
    e.nameTag = gp.name;
    e.addTag("golf_round:" + r.id);
    gp.ballEntity = e.id;
  });
}

function ballEntity(gp) {
  if (!gp.ballEntity) return undefined;
  const e = world.getEntity(gp.ballEntity);
  return e?.isValid ? e : undefined;
}

function removeBallEntity(gp) {
  const e = ballEntity(gp);
  if (e) safe("rmBall", () => e.remove());
  gp.ballEntity = null;
}

export const activeBallIds = () => {
  const s = new Set();
  for (const r of rounds.values()) for (const gp of r.players) if (gp.ballEntity) s.add(gp.ballEntity);
  return s;
};

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

function startTurn(r) {
  let gp;
  if (r.range) gp = r.players[0];
  else {
    // pick-ups
    for (const x of r.players) {
      if (!x.holed && !x.pickedUp && x.strokes >= maxStrokes(r.par, x.tees === "kids")) {
        x.pickedUp = true;
        const p = getPlayer(x.id);
        if (p) msg(p, `§7Picked up at ${x.strokes}. On to the next one!`);
        removeBallEntity(x);
      }
    }
    gp = nextPlayer(r.players);
  }
  if (!gp) return endHole(r);
  const p = getPlayer(gp.id);
  if (!p) {
    gp.pickedUp = true;
    return startTurn(r);
  }
  r.turnId = gp.id;
  r.phase = "aim";
  r.meter = null;
  r.shot = null;
  const golfer = golferById(gp.golfer);
  const dist = r.pin ? distXZ(gp.ball, r.pin) * r.scale : 200;
  const fringeClose = gp.lie === "fringe" && dist < 12;
  r.club = autoClub(dist, gp.lie, golfer, fringeClose);
  r.puttRange = pickPuttRange(dist);
  r.aimTick = 0;

  safe("turn", () => {
    if (p.getGameMode() === GameMode.Spectator) restorePlayer(p);
    const face = r.pin ? { x: r.pin.x, y: r.pin.y + 1, z: r.pin.z } : undefined;
    const yaw = r.range?.yaw;
    p.teleport({ x: gp.ball.x, y: gp.ball.y, z: gp.ball.z }, face ? { facingLocation: face } : yaw !== undefined ? { rotation: { x: 10, y: yaw } } : {});
    lockMovement(p, true);
    const slot = ensureItem(p, ITEMS.club, clubById(r.club).name);
    if (slot >= 0 && slot < 9) p.selectedSlotIndex = slot;
    else msg(p, "§cMake room in your hotbar for the Golf Club, then type /golf:club.");
    renameItem(p, ITEMS.club, clubById(r.club).name);
    safe("cam", () => p.camera.setCamera("minecraft:third_person"));
  });
  if (!r.range) {
    const stroke = gp.strokes + 1;
    group(r, (o) => {
      if (o.id !== gp.id) actionbar(o, `§e${gp.name}§r is up · stroke ${stroke}`);
    });
    sound(p, "random.orb", 1.4, 0.6);
    msg(p, `§eYour shot!§r ${surfaceInfo(gp.lie).color}${surfaceInfo(gp.lie).name}§r · ${Math.round(dist * M_TO_YD)}y to the pin`);
  }
}

function cycleClub(r, gp, p, delta) {
  r.club = nextClub(r.club, gp.lie, delta);
  if (r.club === "putter" && r.pin) r.puttRange = pickPuttRange(distXZ(gp.ball, r.pin) * r.scale);
  renameItem(p, ITEMS.club, clubById(r.club).name);
  sound(p, "random.click", 1.5, 0.5);
}

function cyclePuttRange(r, p, delta) {
  const i = PUTT_RANGES.indexOf(r.puttRange);
  r.puttRange = PUTT_RANGES[Math.max(0, Math.min(PUTT_RANGES.length - 1, (i < 0 ? 2 : i) + delta))];
  sound(p, "random.click", 1.8, 0.5);
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** Swing button (using the Golf Club). Returns true if the round consumed it. */
export function onSwingTap(p) {
  const r = roundOf(p);
  if (!r || r.turnId !== p.id) return false; // not your turn: the club opens the round menu
  if (r.phase !== "aim" && r.phase !== "swing") return true; // ball in the air: ignore
  const gp = r.players.find((x) => x.id === p.id);
  if (r.phase === "aim") {
    r.meter = newMeter({
      control: golferById(gp.golfer).control * surfaceInfo(gp.lie).lieAcc,
      putter: r.club === "putter",
      easy: gp.easy,
      stars: r.range ? 99 : gp.stars,
    });
    tapMeter(r.meter);
    r.phase = "swing";
    sound(p, "note.hat", 1.6, 0.5);
    return true;
  }
  if (r.phase === "swing") {
    tapMeter(r.meter);
    sound(p, "note.hat", r.meter.state === "done" ? 2 : 1.8, 0.6);
    if (r.meter.state === "done") launch(r, gp, p);
    return true;
  }
  return true;
}

/** Jump / Sneak presses. */
export function onButton(p, button) {
  const r = roundOf(p);
  if (!r || r.turnId !== p.id) return;
  const gp = r.players.find((x) => x.id === p.id);
  if (r.phase === "aim") {
    if (button === "Sneak") cycleClub(r, gp, p, +1);
    else if (button === "Jump") {
      if (r.club === "putter") cyclePuttRange(r, p, +1);
      else cycleClub(r, gp, p, -1);
    }
  } else if (r.phase === "swing" && r.meter) {
    spinInput(r.meter, button === "Jump" ? "top" : "back");
    const mode = spinMode(r.meter);
    if (mode !== "none") sound(p, "note.bell", mode.startsWith("super") ? 2 : 1.5, 0.5);
  }
}

// ---------------------------------------------------------------------------
// Shots
// ---------------------------------------------------------------------------

function launch(r, gp, p) {
  const m = r.meter;
  const golfer = golferById(gp.golfer);
  const club = clubById(r.club);
  const mode = club.putter ? "none" : spinMode(m);
  const yaw = p.getRotation().y;
  if (m.powerShot && !r.range) gp.stars--;
  gp.prevBall = { ...gp.ball };
  if (!r.range) gp.strokes++;

  r.shot = createShot({
    start: { ...gp.ball },
    yaw,
    club: r.club,
    power: m.power,
    err: m.err,
    spinMode: mode,
    golfer,
    lie: gp.lie,
    wind: r.wind,
    scale: r.scale,
    powerShot: m.powerShot,
    puttRange: r.puttRange,
    cup: r.pin ?? undefined,
    cupRadius: (CUP_SIZES[r.settings.cup] ?? CUP_SIZES.fun).radius,
    green: r.grid,
    seed: (Date.now() & 0xffff) ^ gp.strokes,
  });
  r.terrain = makeTerrain(overworld(), r.grid, r.scale);
  r.phase = "flight";
  r.flightTicks = 0;
  r.waitTicks = 0;
  r.firstBounce = null;
  r.startYaw = yaw;
  r.cam = p.getHeadLocation();
  r.lastDir = { x: -Math.sin((yaw * Math.PI) / 180), z: Math.cos((yaw * Math.PI) / 180) };

  // feedback
  const perfect = m.err === 0;
  const spinLabel = SPIN_MODES[mode]?.label;
  if (m.powerShot) title(p, "§d§lPOWER SHOT!", spinLabel ? `§b${spinLabel}` : "", 25);
  else if (perfect && !club.putter) title(p, "§e§lNice Shot!", spinLabel ? `§b${spinLabel}` : "", 20);
  else if (m.err > 0.6) title(p, "", "§6Hooked it!", 20);
  else if (m.err < -0.6) title(p, "", "§6Sliced it!", 20);
  else if (spinLabel) title(p, "", `§b${spinLabel}`, 15);
  safe("anim", () => p.playAnimation(club.putter ? "animation.golf.putt" : "animation.golf.swing", { blendOutTime: 0.2 }));
  worldSound(p.dimension, club.putter ? "random.click" : "random.bow", gp.ball, club.putter ? 0.6 : 1.4, 1);
  if (m.powerShot) worldSound(p.dimension, "firework.launch", gp.ball, 1.2, 1);

  // follow mode
  safe("follow", () => {
    saveRestore(p);
    lockMovement(p, false);
    if (!club.putter) p.setGameMode(GameMode.Spectator);
  });
  if (!ballEntity(gp)) placeBallEntity(r, gp);
}

function tickFlight(r) {
  const gp = r.players.find((x) => x.id === r.turnId);
  const p = getPlayer(r.turnId);
  const s = r.shot;
  if (!gp || !s) return;
  r.flightTicks++;
  const before = { ...s.p };
  const events = stepShot(s, r.terrain, TICK * TIME_SCALE);
  if (s.waiting) {
    r.waitTicks++;
    if (r.waitTicks > 120) finishShot(r, gp, p, { type: "lost" });
  } else r.waitTicks = 0;

  const dim = overworld();
  const e = ballEntity(gp);
  if (e) safe("mvBall", () => e.teleport(s.p));
  if (s.phase === "air") particle(dim, "golf:trail", s.p, r.meter?.powerShot ? [1, 0.4, 1] : [1, 1, 1]);

  for (const ev of events) {
    if (ev.type === "bounce" && !r.firstBounce) r.firstBounce = { ...ev.p };
    if (ev.type === "bounce") worldSound(dim, ev.kind === "bunker" ? "dig.sand" : ev.kind === "green" ? "dig.grass" : "step.grass", ev.p, 1.2, 0.8);
    else if (ev.type === "wall") worldSound(dim, "dig.wood", ev.p, 1, 0.8);
    else if (ev.type === "canopy") worldSound(dim, "dig.grass", ev.p, 0.8, 1);
    else if (ev.type === "lip") { worldSound(dim, "random.click", ev.p, 0.5, 1); if (p) title(p, "", "§7Lipped out!", 20); }
  }

  // camera + carry the shooter along so the chunks stay loaded
  if (p) {
    const hv = { x: s.p.x - before.x, z: s.p.z - before.z };
    const hl = Math.hypot(hv.x, hv.z);
    if (hl > 0.02) r.lastDir = { x: hv.x / hl, z: hv.z / hl };
    const putt = clubById(r.club).putter;
    const back = putt ? 3 : 8, up = putt ? 1.8 : 3.5;
    const want = { x: s.p.x - r.lastDir.x * back, y: s.p.y + up, z: s.p.z - r.lastDir.z * back };
    const k = r.flightTicks < 6 ? 0.35 : 0.2;
    r.cam = { x: r.cam.x + (want.x - r.cam.x) * k, y: r.cam.y + (want.y - r.cam.y) * k, z: r.cam.z + (want.z - r.cam.z) * k };
    safe("cam", () => {
      p.camera.setCamera("minecraft:free", {
        location: r.cam,
        facingLocation: s.p,
        easeOptions: { easeTime: 0.1, easeType: EasingType.Linear },
      });
      if (!putt) p.teleport(r.cam, { facingLocation: s.p });
    });
  }

  if (isDone(s)) {
    const last = events[events.length - 1] ?? { type: s.phase };
    finishShot(r, gp, p, last);
  }
}

function finishShot(r, gp, p, ev) {
  const s = r.shot;
  const dim = overworld();
  r.phase = "result";
  r.timer = 34;
  let note = "";

  if (r.range) {
    const total = distXZ(s.p, s.start) * r.scale;
    const carry = r.firstBounce ? distXZ(r.firstBounce, s.start) * r.scale : total;
    const side = Math.round(sideOffset(s.start, s.p, r.startYaw) * r.scale * M_TO_YD);
    const sideTxt = side === 0 ? "dead straight" : side > 0 ? `${side}y left` : `${-side}y right`;
    gp.ball = { ...r.range.at };
    const what = s.phase === "water" ? "§9in the water" : `§7carry ${Math.round(carry * M_TO_YD)}y · ${sideTxt}`;
    if (p) title(p, `§f${Math.round(total * M_TO_YD)} yards`, what, 50);
    if (p) msg(p, `§7${clubById(r.club).name}: total §f${Math.round(total * M_TO_YD)}y§7, carry ${Math.round(carry * M_TO_YD)}y, ${sideTxt}`);
    r.timer = 50;
    return;
  }

  const type = ev.type === "waiting" ? "lost" : s.phase === "air" || s.phase === "roll" ? "lost" : s.phase;
  if (type === "holed") {
    gp.holed = true;
    gp.ball = { ...r.pin };
    removeBallEntity(gp);
    const name = scoreName(gp.strokes, r.par);
    const good = gp.strokes - r.par < 0 || gp.strokes === 1;
    worldSound(dim, "random.orb", r.pin, 0.7, 1);
    if (good) {
      worldSound(dim, "random.levelup", r.pin, 1, 1);
      for (let i = 0; i < 6; i++) later(i * 4, () => particle(dim, "minecraft:totem_particle", { x: r.pin.x, y: r.pin.y + 1, z: r.pin.z }));
    }
    group(r, (o) => title(o, good ? `§6§l${name}` : `§f§l${name}`, `§7${gp.name} · ${gp.strokes} stroke${gp.strokes > 1 ? "s" : ""}${s.events?.some?.((e) => e.dunk) ? " · Slam dunk!" : ""}`, 50));
    if (gp.strokes === 1 && r.courseId && !r.practice) {
      addHoleInOne(r.courseId, { name: gp.name, hole: holeNumber(r.course, r.hole.id), date: Date.now() });
      groupMsg(r, `§6§l★ HOLE IN ONE ★§r ${gp.name} aced hole ${holeNumber(r.course, r.hole.id)}!`);
    }
    r.timer = 60;
  } else if (type === "water") {
    gp.strokes++;
    const drop = findDrop(dim, ev.entry ?? s.hazardAt ?? s.p, gp.prevBall);
    gp.ball = drop ?? { ...gp.prevBall };
    gp.lie = surfaceAt(dim, gp.ball) ?? "rough";
    worldSound(dim, "random.splash", ev.entry ?? s.p, 1, 1);
    note = "§9Splash!§r +1 penalty, dropped nearby";
  } else if (type === "lost") {
    gp.strokes++;
    gp.ball = { ...gp.prevBall };
    note = "§cLost ball!§r +1, replay from the last spot";
  } else {
    gp.ball = { ...s.p };
    gp.lie = ev.kind ?? surfaceAt(dim, gp.ball) ?? "rough";
    // gimme
    const cup = CUP_SIZES[r.settings.cup] ?? CUP_SIZES.fun;
    const dm = distXZ(gp.ball, r.pin) * r.scale;
    if (cup.gimme > 0 && gp.lie === "green" && dm <= cup.gimme) {
      gp.strokes++;
      gp.holed = true;
      removeBallEntity(gp);
      const name = scoreName(gp.strokes, r.par);
      group(r, (o) => title(o, `§f${name}`, `§7${gp.name} · gimme!`, 40));
      worldSound(dim, "random.orb", r.pin, 0.9, 1);
      r.timer = 50;
    } else {
      const lie = surfaceInfo(gp.lie);
      note = `${lie.color}${lie.name}§r · ${Math.round(dm * M_TO_YD)}y to go`;
    }
  }
  if (gp.ball && !gp.holed) {
    gp.distToPin = distXZ(gp.ball, r.pin) * r.scale;
    placeBallEntity(r, gp);
  }
  if (p && note) title(p, "", note, 35);
}

/** Water: walk back from where the ball went in toward where it was hit until we're on dry ground. */
function findDrop(dim, entry, from) {
  if (!entry || !from) return null;
  const dx = from.x - entry.x, dz = from.z - entry.z;
  const n = Math.max(1, Math.ceil(Math.hypot(dx, dz)));
  for (let i = 1; i <= n; i++) {
    const x = entry.x + (dx * i) / n, z = entry.z + (dz * i) / n;
    const top = topSurface(dim, x, entry.y + 6, z);
    if (top && !top.liquid) {
      // two more blocks back so it's not on the bank edge
      const k = Math.min(n, i + 2);
      const x2 = entry.x + (dx * k) / n, z2 = entry.z + (dz * k) / n;
      const t2 = topSurface(dim, x2, entry.y + 6, z2);
      if (t2 && !t2.liquid) return { x: x2, y: t2.y, z: z2 };
      return { x, y: top.y, z };
    }
  }
  return null;
}

function topSurface(dim, x, yStart, z) {
  const bx = Math.floor(x), bz = Math.floor(z);
  for (let y = Math.floor(yStart); y > yStart - 24; y--) {
    let b;
    try { b = dim.getBlock({ x: bx, y, z: bz }); } catch { return null; }
    if (!b) return null;
    const id = b.typeId;
    if (isLiquid(id)) return { y: y + 1, liquid: true };
    if (isPassThrough(id) || isCanopy(id)) continue;
    return { y: y + 1, liquid: false, id };
  }
  return null;
}

function surfaceAt(dim, at) {
  const g = groundBelow(makeTerrain(dim, undefined, 1), at.x, at.y + 0.6, at.z, 4);
  return g && !g.unloaded && !g.liquid ? g.kind : null;
}

/** Signed sideways distance (blocks) of `to` from the line starting at `from` along yaw; + = left. */
function sideOffset(from, to, yaw) {
  const d = { x: -Math.sin((yaw * Math.PI) / 180), z: Math.cos((yaw * Math.PI) / 180) };
  const left = { x: d.z, z: -d.x };
  return (to.x - from.x) * left.x + (to.z - from.z) * left.z;
}

// ---------------------------------------------------------------------------
// Aim HUD + landing preview
// ---------------------------------------------------------------------------

function tickAim(r) {
  const p = getPlayer(r.turnId);
  const gp = r.players.find((x) => x.id === r.turnId);
  if (!p || !gp) return;
  r.aimTick++;
  const club = clubById(r.club);
  const yaw = p.getRotation().y;
  const dist = r.pin ? distXZ(gp.ball, r.pin) * r.scale : 0;
  const lie = surfaceInfo(gp.lie);

  // keep them on the ball (in case they got nudged)
  if (r.aimTick % 20 === 0) {
    const loc = p.location;
    if (Math.hypot(loc.x - gp.ball.x, loc.z - gp.ball.z) > 0.8) safe("tp", () => p.teleport(gp.ball, { rotation: p.getRotation() }));
  }

  const windTxt = r.wind.speed ? `§bWind ${Math.round(r.wind.speed * 2.237)}mph ${windRelative(r.wind.yaw, yaw)}` : "§7No wind";
  const stars = r.range ? "" : ` §d${"★".repeat(Math.max(0, gp.stars))}`;
  const clubTxt = club.putter ? `§lPutter§r §7(${Math.round(r.puttRange * M_TO_YD)}y range)` : `§l${club.name}§r §7${Math.round(club.carry * golferById(gp.golfer).power * lie.lieDist * M_TO_YD)}y`;
  const pinTxt = r.pin ? `§f${Math.round(dist * M_TO_YD)}y to pin` : "";
  const stroke = r.range ? "" : ` §7· Stroke ${gp.strokes + 1}`;
  actionbar(p, `${clubTxt} §8| ${pinTxt} §8| ${lie.color}${lie.name}${stroke}\n${windTxt}${stars}  §8[Use] swing  [Sneak/Jump] ${club.putter ? "range" : "club"}`);

  // landing preview every 4 ticks
  if (r.aimTick % 4 === 0) {
    const dim = overworld();
    const terrain = makeTerrain(dim, r.grid, r.scale);
    const pv = safe("preview", () =>
      previewCarry(
        { start: { ...gp.ball }, yaw, club: r.club, power: 1, golfer: golferById(gp.golfer), lie: gp.lie, scale: r.scale, puttRange: r.puttRange, green: r.grid },
        terrain,
        club.putter ? 1 : 5,
      ),
    );
    if (pv) {
      const step = club.putter ? 2 : 1;
      for (let i = 0; i < pv.path.length; i += step) particle(dim, "golf:aim_dot", { ...pv.path[i], y: pv.path[i].y + (club.putter ? 0.08 : 0) }, club.putter ? [1, 1, 1] : [1, 0.85, 0.2]);
      if (pv.land && !club.putter) {
        for (let a = 0; a < 12; a++) {
          const t = (a / 12) * Math.PI * 2;
          const rad = 1.6 / Math.sqrt(r.scale);
          particle(dim, "golf:aim_dot", { x: pv.land.x + Math.cos(t) * rad, y: pv.land.y + 0.15, z: pv.land.z + Math.sin(t) * rad }, [1, 0.3, 0.2]);
        }
      }
    }
  }
  // green reading while putting or chipping close
  if (r.grid && dist < 40 && r.aimTick % 10 === 0) {
    showSlope(overworld(), r.grid, r.scale, r.pin.y, (gp.ball.x + r.pin.x) / 2, (gp.ball.z + r.pin.z) / 2, Math.min(14, dist / r.scale / 2 + 4), 2);
  }
}

function tickSwing(r) {
  const p = getPlayer(r.turnId);
  const gp = r.players.find((x) => x.id === r.turnId);
  if (!p || !gp || !r.meter) return;
  const auto = tickMeter(r.meter);
  const mode = spinMode(r.meter);
  const label = SPIN_MODES[mode]?.label;
  const hint = r.meter.state === "up" ? "§7tap at the top for POWER" : r.meter.state === "down" ? `§7tap on the §bblue line§7${r.meter.putter ? "" : " · Jump=top Sneak=back"}` : "";
  actionbar(p, `${renderMeter(r.meter)}\n${label ? "§b" + label + " " : ""}${hint}`);
  if (auto && r.meter.state === "done") launch(r, gp, p);
}

// ---------------------------------------------------------------------------
// Holes and rounds
// ---------------------------------------------------------------------------

function endHole(r) {
  r.phase = "holeEnd";
  r.timer = 90;
  const num = holeNumber(r.course, r.hole.id);
  const parts = [];
  for (const gp of r.players) {
    const score = gp.holed ? gp.strokes : maxStrokes(r.par, gp.tees === "kids");
    gp.scores.push(score);
    removeBallEntity(gp);
    const tot = gp.scores.reduce((a, b) => a + b, 0);
    const parSoFar = parTotal(r, gp.scores.length);
    parts.push(`§e${gp.name}§r ${score} §7(${scoreName(score, r.par)}, ${toParText(tot - parSoFar)} total)`);
  }
  groupMsg(r, `§6Hole ${num} done§r · Par ${r.par}\n` + parts.join("\n"));
  group(r, (p) => {
    restorePlayer(p);
    lockMovement(p, false);
  });
}

function parTotal(r, n) {
  let s = 0;
  for (let i = 0; i < n; i++) s += holePar(getHole(r.holeIds[i]) ?? {}, r.course);
  return s;
}

export function endRound(r, complete = true) {
  if (!rounds.has(r.id)) return;
  rounds.delete(r.id);
  const lines = [];
  const entry = { date: Date.now(), holes: r.holeIds.length, players: [] };
  for (const gp of r.players) {
    removeBallEntity(gp);
    playerRound.delete(gp.id);
    const tot = gp.scores.reduce((a, b) => a + b, 0);
    const toPar = tot - parTotal(r, gp.scores.length);
    entry.players.push({ name: gp.name, total: tot, toPar, complete: complete && gp.scores.length === r.holeIds.length });
    if (gp.scores.length) lines.push({ name: gp.name, tot, toPar, n: gp.scores.length });
    const p = getPlayer(gp.id);
    if (p) {
      restorePlayer(p);
      lockMovement(p, false);
      renameItem(p, ITEMS.club, "Golf Club");
    }
  }
  lines.sort((a, b) => a.toPar - b.toPar);
  if (lines.length && !r.range) {
    const text = lines.map((l, i) => `${i === 0 ? "§6🏆" : "  "} §e${l.name}§r ${l.tot} (${toParText(l.toPar)}) over ${l.n} hole${l.n > 1 ? "s" : ""}`).join("\n");
    groupMsgList(r, `§6§lFinal scores§r · ${r.course?.name ?? ""}\n${text}`);
    if (r.courseId && !r.practice && complete) safe("records", () => addRoundRecord(r.courseId, entry));
    group2(r, (p) => title(p, lines[0].name === p.name ? "§6§lYou win!" : "§fRound over", `§7${lines[0].name} wins at ${toParText(lines[0].toPar)}`, 80));
  }
}

// endRound has already removed players from the map, so message them directly.
function groupMsgList(r, text) {
  for (const gp of r.players) { const p = getPlayer(gp.id); if (p) msg(p, text); }
}
function group2(r, fn) {
  for (const gp of r.players) { const p = getPlayer(gp.id); if (p) safe("g2", () => fn(p)); }
}

/** A player quits (menu, command, or disconnect). */
export function leaveRound(playerId, why = "left") {
  const r = rounds.get(playerRound.get(playerId) ?? "");
  if (!r) return;
  const gp = r.players.find((x) => x.id === playerId);
  if (!gp) return;
  removeBallEntity(gp);
  playerRound.delete(playerId);
  r.players = r.players.filter((x) => x.id !== playerId);
  const p = getPlayer(playerId);
  if (p) {
    restorePlayer(p);
    renameItem(p, ITEMS.club, "Golf Club");
    msg(p, "§7You left the round.");
  }
  if (!r.players.length) {
    rounds.delete(r.id);
    return;
  }
  groupMsg(r, `§7${gp.name} ${why} the round.`);
  if (r.turnId === playerId) {
    r.phase = "between";
    r.timer = 10;
  }
}

/** Remove everything (admin reset or script reload). */
export function resetAll() {
  for (const r of [...rounds.values()]) {
    for (const gp of r.players) {
      removeBallEntity(gp);
      const p = getPlayer(gp.id);
      if (p) restorePlayer(p);
    }
  }
  rounds.clear();
  playerRound.clear();
}

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

export function tickRounds() {
  for (const r of [...rounds.values()]) {
    r.tick++;
    safe("round " + r.id, () => {
      switch (r.phase) {
        case "aim": return tickAim(r);
        case "swing": return tickSwing(r);
        case "flight": return tickFlight(r);
        case "result":
          if (--r.timer <= 0) {
            const p = getPlayer(r.turnId);
            if (p) {
              restorePlayer(p);
              lockMovement(p, false);
              const gp = r.players.find((x) => x.id === r.turnId);
              if (gp?.ball && !gp.holed) safe("tp", () => p.teleport(gp.ball, { facingLocation: r.pin ? { ...r.pin, y: r.pin.y + 1 } : undefined }));
            }
            r.phase = "between";
            r.timer = 6;
          }
          return;
        case "between":
          if (--r.timer <= 0) startTurn(r);
          return;
        case "holeEnd":
          if (--r.timer <= 0) {
            if (r.holeIdx + 1 < r.holeIds.length) beginHole(r, r.holeIdx + 1);
            else endRound(r, true);
          }
          return;
      }
    });
  }
}

export function scorecardText(r) {
  if (!r.course) return "Driving range";
  const rows = [];
  for (const gp of r.players) {
    const tot = gp.scores.reduce((a, b) => a + b, 0);
    const toPar = tot - parTotal(r, gp.scores.length);
    rows.push(`§e${gp.name}§r  ${gp.scores.join(" ") || "-"}  §7=§r ${tot} (${toParText(toPar)})${gp.stars >= 0 ? `  §d${gp.stars}★` : ""}`);
  }
  const pars = r.holeIds.slice(0, Math.max(1, r.holeIdx + 1)).map((id) => holePar(getHole(id) ?? {}, r.course));
  return `§6${r.course.name}§r · hole ${r.holeIdx + 1} of ${r.holeIds.length}\n§7Par: ${pars.join(" ")}\n\n${rows.join("\n")}`;
}

