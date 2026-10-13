// Small Minecraft helpers shared by the golf scripts.

import { world, system, ItemStack, MolangVariableMap, GameMode, InputPermissionCategory, EntityComponentTypes } from "@minecraft/server";

export const NS = "golf";
export const ITEMS = {
  club: "golf:club",
  wand: "golf:course_wand",
  brush: "golf:course_brush",
};
export const ENTITIES = {
  ball: "golf:ball",
  pin: "golf:pin",
  tee: "golf:tee_marker",
  rack: "golf:club_rack",
};
export const BUILDER_TAG = "golf_builder";

export const overworld = () => world.getDimension("overworld");

export function log(...a) {
  console.warn("[golf]", ...a);
}

/** Run fn, log instead of crashing the tick loop. */
export function safe(label, fn) {
  try {
    return fn();
  } catch (e) {
    log(label, e?.stack ?? e);
    return undefined;
  }
}

export const later = (ticks, fn) => system.runTimeout(() => safe("later", fn), ticks);

export function msg(p, text) {
  safe("msg", () => p.sendMessage(text));
}

export function actionbar(p, text) {
  safe("actionbar", () => p.onScreenDisplay.setActionBar(text));
}

export function title(p, big, small = "", stay = 40) {
  safe("title", () =>
    p.onScreenDisplay.setTitle(big, { subtitle: small, fadeInDuration: 4, stayDuration: stay, fadeOutDuration: 10 }),
  );
}

export function sound(p, id, pitch = 1, volume = 1) {
  safe("sound", () => p.playSound(id, { pitch, volume }));
}

export function worldSound(dim, id, at, pitch = 1, volume = 1) {
  safe("wsound", () => dim.playSound(id, at, { pitch, volume }));
}

export function particle(dim, id, at, rgb, dir) {
  try {
    let vars;
    if (rgb || dir) {
      vars = new MolangVariableMap();
      if (rgb) vars.setColorRGBA("variable.color", { red: rgb[0], green: rgb[1], blue: rgb[2], alpha: rgb[3] ?? 1 });
      if (dir) vars.setVector3("variable.direction", dir);
    }
    dim.spawnParticle(id, at, vars);
  } catch {
    /* unloaded chunk or bad particle: ignore */
  }
}

export function isBuilder(p) {
  try {
    return p.hasTag(BUILDER_TAG) || p.playerPermissionLevel >= 2;
  } catch {
    return false;
  }
}

export function inventory(p) {
  return p.getComponent(EntityComponentTypes.Inventory)?.container;
}

/** Find a hotbar slot holding `typeId`, or -1. */
export function hotbarSlotOf(p, typeId) {
  const inv = inventory(p);
  if (!inv) return -1;
  for (let i = 0; i < 9; i++) if (inv.getItem(i)?.typeId === typeId) return i;
  return -1;
}

/** Give one of an item if the player doesn't have it. Returns the slot or -1 when full. */
export function ensureItem(p, typeId, name, lore) {
  const inv = inventory(p);
  if (!inv) return -1;
  for (let i = 0; i < inv.size; i++) {
    if (inv.getItem(i)?.typeId === typeId) {
      if (i < 9) return i;
      // pull it into the hotbar if there is room
      for (let h = 0; h < 9; h++) if (!inv.getItem(h)) { inv.swapItems(i, h, inv); return h; }
      return i;
    }
  }
  const stack = new ItemStack(typeId, 1);
  if (name) stack.nameTag = name;
  if (lore) stack.setLore(lore);
  for (let h = 0; h < 9; h++) if (!inv.getItem(h)) { inv.setItem(h, stack); return h; }
  const left = inv.addItem(stack);
  if (left) return -1;
  return hotbarSlotOf(p, typeId);
}

export function removeItem(p, typeId) {
  const inv = inventory(p);
  if (!inv) return;
  for (let i = 0; i < inv.size; i++) if (inv.getItem(i)?.typeId === typeId) inv.setItem(i, undefined);
}

/** Rename the held copy of an item so the hotbar pop-up shows it (e.g. the current club). */
export function renameItem(p, typeId, name) {
  const inv = inventory(p);
  if (!inv) return;
  const slot = hotbarSlotOf(p, typeId);
  if (slot < 0) return;
  const it = inv.getItem(slot);
  if (!it || it.nameTag === name) return;
  it.nameTag = name;
  inv.setItem(slot, it);
}

export function lockMovement(p, locked) {
  safe("perm", () => {
    p.inputPermissions.setPermissionCategory(InputPermissionCategory.LateralMovement, !locked);
  });
}

/** Remember how to restore a player if the server stops mid-shot. */
export function saveRestore(p) {
  safe("saveRestore", () => {
    if (p.getDynamicProperty("golf:restore")) return;
    p.setDynamicProperty("golf:restore", JSON.stringify({ gm: p.getGameMode() }));
  });
}

export function restorePlayer(p) {
  safe("restore", () => {
    const raw = p.getDynamicProperty("golf:restore");
    if (raw) {
      const r = JSON.parse(String(raw));
      if (p.getGameMode() === GameMode.Spectator && r.gm) p.setGameMode(r.gm);
      p.setDynamicProperty("golf:restore", undefined);
    }
    p.inputPermissions.setPermissionCategory(InputPermissionCategory.LateralMovement, true);
    p.camera.clear();
  });
}

export const fmt1 = (n) => (Math.round(n * 10) / 10).toFixed(1);
export const blockCenter = (b) => ({ x: b.x + 0.5, y: b.y, z: b.z + 0.5 });
export const floorV = (v) => ({ x: Math.floor(v.x), y: Math.floor(v.y), z: Math.floor(v.z) });
export const newId = () => Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
