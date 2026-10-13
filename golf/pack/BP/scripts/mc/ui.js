// Player menus: play a round, invite nearby players, driving range, golfers, records, help.

import { world, system } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";
import { menu, modal, show } from "./forms.js";
import { listCourses, getCourse, getHole, validateHole, coursePar, holeLengthM, playerPrefs, savePlayerPrefs, getRecords, TEE_SETS, TEE_NAMES } from "./store.js";
import { GOLFERS, golferById, statStars } from "../lib/characters.js";
import { CUP_SIZES, WIND_LEVELS, toParText } from "../lib/rules.js";
import { startRound, roundOf, leaveRound, scorecardText, playerRound } from "./round.js";
import { wandMenu, giveTools } from "./builder.js";
import { msg, isBuilder, ITEMS, ensureItem, sound } from "./util.js";
import { M_TO_YD } from "../lib/vec.js";

const CUP_KEYS = Object.keys(CUP_SIZES);
const WIND_KEYS = Object.keys(WIND_LEVELS);

export async function mainMenu(p) {
  const r = roundOf(p);
  if (r) {
    return menu(p, r.range ? "Driving Range" : "Your Round", scorecardText(r), [
      { label: "Keep playing" },
      { label: "How to play", run: () => howTo(p) },
      { label: r.range ? "§cLeave the range" : "§cLeave the round", run: () => leaveRound(p.id) },
    ]);
  }
  const prefs = playerPrefs(p);
  const g = golferById(prefs.golfer);
  const items = [
    { label: "§2Play golf!\n§8pick a course, invite friends", run: () => playMenu(p) },
    { label: "Driving range\n§8hit balls from right here", run: () => startRange(p) },
    { label: `Choose golfer\n§8now: ${g.name}`, run: () => golferMenu(p) },
    { label: `Settings\n§8Easy Swing: ${prefs.easy ? "on" : "off"}`, run: () => settingsMenu(p) },
    { label: "Course records", run: () => recordsMenu(p) },
    { label: "How to play", run: () => howTo(p) },
  ];
  if (isBuilder(p)) items.push({ label: "§6Course tools", run: () => { giveTools(p); return wandMenu(p); } });
  return menu(p, "Golf", "", items);
}

function playableCourses() {
  return listCourses().filter((c) => c.holes.length && c.holes.every((id) => validateHole(getHole(id) ?? {}, c).ok));
}

async function playMenu(p) {
  const cs = playableCourses();
  if (!cs.length) return menu(p, "No courses yet", "Nobody has finished building a course yet. Check back soon!", [{ label: "OK" }]);
  await menu(p, "Pick a course", "", cs.map((c) => ({
    label: `${c.name}\n§8${c.holes.length} holes · Par ${coursePar(c)}`,
    run: () => roundSetup(p, c.id),
  })));
}

async function roundSetup(p, courseId) {
  const c = getCourse(courseId);
  const n = c.holes.length;
  const holeOpts = [`All ${n} holes`];
  const holeSets = [c.holes];
  if (n > 9) {
    holeOpts.push("Front 9", "Back 9");
    holeSets.push(c.holes.slice(0, 9), c.holes.slice(9, 18));
  }
  c.holes.forEach((id, i) => {
    holeOpts.push(`Just hole ${i + 1} (${Math.round(holeLengthM(getHole(id) ?? {}, c, "middle") * M_TO_YD)}y)`);
    holeSets.push([id]);
  });
  const prefs = playerPrefs(p);
  const v = await modal(p, c.name, [
    { type: "dropdown", label: "Holes", options: holeOpts, default: 0 },
    { type: "dropdown", label: "Your tees", options: TEE_SETS.map((s) => TEE_NAMES[s]), default: Math.max(0, TEE_SETS.indexOf(prefs.tees ?? "middle")) },
    { type: "dropdown", label: "Cup size", options: CUP_KEYS.map((k) => `${CUP_SIZES[k].name}: ${CUP_SIZES[k].desc}`), default: 1 },
    { type: "dropdown", label: "Wind", options: WIND_KEYS.map((k) => WIND_LEVELS[k].name), default: 1 },
    { type: "slider", label: "Power shots per player", min: 0, max: 10, step: 1, default: 6 },
    { type: "toggle", label: "Invite players near me", default: true },
  ], "Tee it up!");
  if (!v) return;
  const settings = { cup: CUP_KEYS[v[2]], wind: WIND_KEYS[v[3]], stars: v[4] };
  const holeIds = holeSets[v[0]];
  const host = { player: p, golfer: prefs.golfer, tees: TEE_SETS[v[1]], easy: prefs.easy };
  if (!v[5]) return startRound({ courseId, holeIds, settings }, [host]);

  const nearby = world.getPlayers().filter((o) => o.id !== p.id && !playerRound.has(o.id) && o.dimension.id === p.dimension.id && dist(o, p) < 40);
  if (!nearby.length) {
    msg(p, "§7Nobody nearby, starting solo.");
    return startRound({ courseId, holeIds, settings }, [host]);
  }
  const entrants = [host];
  msg(p, `§7Invited ${nearby.map((o) => o.name).join(", ")}. Starting in 20 seconds or when everyone answers.`);
  const answers = nearby.map((o) => invite(o, p.name, c.name).then((e) => { if (e) { entrants.push(e); msg(p, `§a${o.name} joined!`); } }));
  await Promise.race([Promise.all(answers), new Promise((ok) => system.runTimeout(() => ok(undefined), 400))]);
  if (roundOf(p)) return; // host started something else meanwhile
  const valid = entrants.filter((e) => e.player.isValid && !playerRound.has(e.player.id)).slice(0, 4);
  startRound({ courseId, holeIds, settings }, valid);
}

const dist = (a, b) => Math.hypot(a.location.x - b.location.x, a.location.z - b.location.z);

async function invite(o, hostName, courseName) {
  sound(o, "random.orb", 1.2, 0.8);
  const ok = await menu(o, "Golf!", `${hostName} is starting a round at ${courseName}. Want to play?`, [{ label: "§2Yes, let's play!", value: true }, { label: "No thanks", value: false }]);
  if (!ok?.value) return undefined;
  const prefs = playerPrefs(o);
  const v = await modal(o, "Your game", [
    { type: "dropdown", label: "Golfer", options: GOLFERS.map((g) => g.name), default: Math.max(0, GOLFERS.findIndex((g) => g.id === prefs.golfer)) },
    { type: "dropdown", label: "Tees", options: TEE_SETS.map((s) => TEE_NAMES[s]), default: Math.max(0, TEE_SETS.indexOf(prefs.tees ?? "middle")) },
    { type: "toggle", label: "Easy Swing (2 taps instead of 3)", default: prefs.easy },
  ], "Ready!");
  if (!v) return undefined;
  const golfer = GOLFERS[v[0]].id;
  savePlayerPrefs(o, { ...prefs, golfer, tees: TEE_SETS[v[1]], easy: !!v[2] });
  ensureItem(o, ITEMS.club, "Golf Club");
  return { player: o, golfer, tees: TEE_SETS[v[1]], easy: !!v[2] };
}

function startRange(p) {
  const prefs = playerPrefs(p);
  const loc = p.location;
  startRound({ range: { at: { x: Math.floor(loc.x) + 0.5, y: Math.floor(loc.y + 0.01), z: Math.floor(loc.z) + 0.5 }, yaw: p.getRotation().y }, settings: { wind: "calm", stars: 99 } }, [{ player: p, golfer: prefs.golfer, tees: "back", easy: prefs.easy }]);
}

async function golferMenu(p) {
  const prefs = playerPrefs(p);
  const f = new ActionFormData().title("Choose your golfer");
  for (const g of GOLFERS) {
    const s = statStars(g);
    f.button(`${g.id === prefs.golfer ? "§2▶ " : ""}${g.name}\n§8PWR ${"★".repeat(s.power)} CTL ${"★".repeat(s.control)} SPN ${"★".repeat(s.spin)}`);
  }
  const res = await show(p, f);
  if (res.canceled || res.selection === undefined) return;
  const g = GOLFERS[res.selection];
  await menu(p, g.name, `${g.blurb}\n\nShot shape: ${g.shape > 0 ? "draw (curves left)" : g.shape < 0 ? "fade (curves right)" : "straight"}\nBall flight: ${g.height > 1 ? "high" : g.height < 0 ? "low" : "normal"}`, [
    { label: `§2Play as ${g.name}`, run: () => { savePlayerPrefs(p, { ...prefs, golfer: g.id }); msg(p, `§aYou're ${g.name}!`); } },
    { label: "« Back", run: () => golferMenu(p) },
  ]);
}

async function settingsMenu(p) {
  const prefs = playerPrefs(p);
  const v = await modal(p, "Settings", [
    { type: "toggle", label: "Easy Swing: 2 taps (power only), great for younger players", default: prefs.easy },
    { type: "dropdown", label: "Usual tees", options: TEE_SETS.map((s) => TEE_NAMES[s]), default: Math.max(0, TEE_SETS.indexOf(prefs.tees ?? "middle")) },
  ], "Save");
  if (!v) return;
  savePlayerPrefs(p, { ...prefs, easy: !!v[0], tees: TEE_SETS[v[1]] });
  msg(p, "§aSaved.");
}

async function recordsMenu(p) {
  const cs = listCourses().filter((c) => c.holes.length);
  if (!cs.length) return menu(p, "Records", "No courses yet.", [{ label: "OK" }]);
  await menu(p, "Course records", "", cs.map((c) => ({
    label: c.name,
    run: () => {
      const r = getRecords(c.id);
      const best = Object.entries(r.best).sort((a, b) => a[1].toPar - b[1].toPar).slice(0, 10)
        .map(([name, b], i) => `${i + 1}. §e${name}§r ${b.total} (${toParText(b.toPar)})`);
      const aces = r.holeInOnes.slice(0, 5).map((h) => `§6★§r ${h.name}, hole ${h.hole}`);
      const recent = r.rounds.slice(0, 5).map((rd) => rd.players.map((x) => `${x.name} ${x.total}`).join(", "));
      return menu(p, c.name, [
        `§lBest rounds§r (Par ${coursePar(c)})`, ...(best.length ? best : ["none yet"]), "",
        "§lHoles in one§r", ...(aces.length ? aces : ["none yet"]), "",
        "§lRecent rounds§r", ...(recent.length ? recent : ["none yet"]),
      ].join("\n"), [{ label: "OK" }]);
    },
  })));
}

export async function howTo(p) {
  await menu(p, "How to play", [
    "§lYour turn§r: you're placed at your ball. Look where you want to hit. The §6gold dots§r show where a full swing lands, the §cred ring§r is the landing spot.",
    "",
    "§lSwing§r (Use the Golf Club):",
    " 1st tap: start",
    " 2nd tap: POWER. Stop at the top for a §dPOWER SHOT§r (uses a ★).",
    " 3rd tap: on the §bblue line§r for a straight shot. Early = hooks left, late = slices right.",
    "",
    "§lSpin§r: while the meter comes back down, press §lJump§r for topspin (rolls more) or §lSneak§r for backspin (stops fast). Press twice for SUPER spin.",
    "",
    "§lClubs§r: the game picks one for you. Sneak / Jump switch clubs before you swing. On the green, Jump changes putter range.",
    "",
    "§lGreens§r: the moving dots show the slope. Blue = flat, green = gentle, yellow = medium, orange/red = fast.",
    "",
    "Farthest from the hole goes next. Water = +1 and a drop. Lost ball = +1 and replay.",
  ].join("\n"), [{ label: "Got it!" }]);
}
