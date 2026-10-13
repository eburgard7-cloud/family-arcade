// Finsonly Golf: entry point. Wires events, commands and the tick loop.

import { world, system, ButtonState, CommandPermissionLevel, CustomCommandParamType, CustomCommandStatus } from "@minecraft/server";
import { calibrateAll } from "./lib/physics.js";
import { tickRounds, onSwingTap, onButton, leaveRound, roundOf, resetAll, activeBallIds, rounds } from "./mc/round.js";
import { mainMenu } from "./mc/ui.js";
import { wandMenu, brushMenu, giveTools } from "./mc/builder.js";
import { paint, allBuilders } from "./mc/brush.js";
import { showSlope } from "./mc/greensview.js";
import { getHole, getCourse } from "./mc/store.js";
import { decode } from "./lib/greens.js";
import { ITEMS, ENTITIES, BUILDER_TAG, overworld, safe, msg, ensureItem, restorePlayer, isBuilder, log } from "./mc/util.js";

const VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// Commands: /golf:menu, /golf:club, /golf:quit, /golf:tools, /golf:builder, /golf:reset
// ---------------------------------------------------------------------------

system.beforeEvents.startup.subscribe((ev) => {
  const reg = ev.customCommandRegistry;
  const ok = { status: CustomCommandStatus.Success };
  const asPlayer = (origin, fn) => {
    const p = origin.sourceEntity;
    if (!p || p.typeId !== "minecraft:player") return { status: CustomCommandStatus.Failure, message: "Run this as a player." };
    system.run(() => safe("cmd", () => fn(p)));
    return ok;
  };
  const cmd = (name, description, permissionLevel, cb, extra = {}) =>
    safe("register " + name, () => reg.registerCommand({ name, description, permissionLevel, cheatsRequired: false, ...extra }, cb));

  cmd("golf:menu", "Open the golf menu", CommandPermissionLevel.Any, (o) => asPlayer(o, (p) => mainMenu(p)));
  cmd("golf:club", "Get a golf club", CommandPermissionLevel.Any, (o) => asPlayer(o, (p) => {
    if (ensureItem(p, ITEMS.club, "Golf Club") < 0) msg(p, "§cYour inventory is full.");
  }));
  cmd("golf:quit", "Leave your round or the driving range", CommandPermissionLevel.Any, (o) => asPlayer(o, (p) => leaveRound(p.id)));
  cmd("golf:tools", "Get the Course Wand and Course Brush (builders)", CommandPermissionLevel.GameDirectors, (o) => asPlayer(o, (p) => giveTools(p)));
  cmd(
    "golf:builder",
    "Let a player build golf courses (or stop them)",
    CommandPermissionLevel.Admin,
    (_o, players, on) => {
      system.run(() => {
        for (const p of players ?? []) {
          if (on === false) { p.removeTag(BUILDER_TAG); msg(p, "§7You're no longer a course builder."); }
          else { giveTools(p); }
        }
      });
      return ok;
    },
    {
      mandatoryParameters: [{ name: "player", type: CustomCommandParamType.PlayerSelector }],
      optionalParameters: [{ name: "on", type: CustomCommandParamType.Boolean }],
    },
  );
  cmd("golf:reset", "Emergency: end every round and clean up golf balls", CommandPermissionLevel.GameDirectors, () => {
    system.run(() => { resetAll(); cleanupBalls(true); });
    return ok;
  });
});

// ---------------------------------------------------------------------------
// Items: Golf Club (swing / menu), Course Wand, Course Brush
// ---------------------------------------------------------------------------

const lastUse = new Map(); // player id -> tick
function onUse(p, item) {
  if (!item) return;
  const now = system.currentTick;
  const prev = lastUse.get(p.id) ?? -10;
  if (now - prev < 2) return; // itemUse and itemStartUse can both fire for one press
  lastUse.set(p.id, now);

  if (item.typeId === ITEMS.club) {
    if (!onSwingTap(p)) mainMenu(p);
  } else if (item.typeId === ITEMS.wand) {
    wandMenu(p);
  } else if (item.typeId === ITEMS.brush) {
    if (!isBuilder(p)) return msg(p, "§cOnly course builders can use the Course Brush.");
    if (p.isSneaking) brushMenu(p);
    else paint(p);
  }
}

world.afterEvents.itemUse.subscribe((ev) => safe("itemUse", () => onUse(ev.source, ev.itemStack)));
world.afterEvents.itemStartUse.subscribe((ev) => safe("itemStartUse", () => onUse(ev.source, ev.itemStack)));

world.afterEvents.playerButtonInput.subscribe((ev) => {
  if (ev.newButtonState !== ButtonState.Pressed) return;
  safe("button", () => onButton(ev.player, ev.button));
});

// Club rack: interact to get clubs and open the menu.
world.afterEvents.playerInteractWithEntity.subscribe((ev) => {
  if (ev.target?.typeId !== ENTITIES.rack) return;
  safe("rack", () => {
    if (ensureItem(ev.player, ITEMS.club, "Golf Club") < 0) return msg(ev.player, "§cMake room in your hotbar for a club.");
    if (!roundOf(ev.player)) mainMenu(ev.player);
  });
});

// ---------------------------------------------------------------------------
// Players coming and going
// ---------------------------------------------------------------------------

world.afterEvents.playerSpawn.subscribe((ev) => {
  if (!ev.initialSpawn) return;
  // If the server stopped mid-shot, put them back to normal.
  system.runTimeout(() => safe("spawnRestore", () => { if (!roundOf(ev.player)) restorePlayer(ev.player); }), 20);
});

world.afterEvents.playerLeave.subscribe((ev) => safe("leave", () => leaveRound(ev.playerId, "disconnected from")));

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

function cleanupBalls(all = false) {
  const keep = all ? new Set() : activeBallIds();
  safe("cleanup", () => {
    for (const e of overworld().getEntities({ type: ENTITIES.ball })) if (!keep.has(e.id)) e.remove();
  });
}

let t = 0;
system.runInterval(() => {
  t++;
  tickRounds();
  // builders with slope dots on
  if (t % 10 === 0) {
    for (const [id, st] of allBuilders()) {
      if (!st.showSlope || !st.holeId) continue;
      const p = world.getPlayers().find((x) => x.id === id);
      if (!p || !isBuilder(p)) continue;
      const h = getHole(st.holeId);
      if (!h?.pin || !h.green) continue;
      const c = getCourse(h.courseId);
      const held = safe("held", () => p.getComponent("minecraft:inventory")?.container?.getItem(p.selectedSlotIndex)?.typeId);
      if (held !== ITEMS.brush && held !== ITEMS.wand) continue;
      const hit = safe("ray", () => p.getBlockFromViewDirection({ maxDistance: 60 }));
      const cx = hit ? hit.block.x + 0.5 : h.pin.x + 0.5, cz = hit ? hit.block.z + 0.5 : h.pin.z + 0.5;
      showSlope(overworld(), decode(h.green), c?.scale ?? 1, h.pin.y, cx, cz, 9, 1);
    }
  }
  if (t % 200 === 0 && rounds.size === 0) cleanupBalls();
}, 1);

world.afterEvents.worldLoad.subscribe(() => {
  safe("calibrate", () => calibrateAll());
  cleanupBalls(true);
  log(`Finsonly Golf ${VERSION} loaded`);
});
