// In-memory stand-in for @minecraft/server, just enough to run the golf
// scripts end to end in Node: blocks, entities, players, events, timers.

export const GameMode = { Adventure: "Adventure", Creative: "Creative", Spectator: "Spectator", Survival: "Survival" };
export const InputPermissionCategory = { Camera: 1, Movement: 2, LateralMovement: 4, Sneak: 5, Jump: 6 };
export const EasingType = { Linear: "Linear" };
export const ButtonState = { Pressed: "Pressed", Released: "Released" };
export const CommandPermissionLevel = { Any: 0, GameDirectors: 1, Admin: 2, Host: 3, Owner: 4 };
export const CustomCommandParamType = { Boolean: "Boolean", PlayerSelector: "PlayerSelector", String: "String" };
export const CustomCommandStatus = { Success: 0, Failure: 1 };
export const EntityComponentTypes = { Inventory: "minecraft:inventory" };

const signal = () => {
  const subs = [];
  return { subscribe: (f) => (subs.push(f), f), unsubscribe: (f) => subs.splice(subs.indexOf(f), 1), fire: (ev) => subs.forEach((f) => f(ev)) };
};

import { placeFile } from "./mcstructure.mjs";
export const __placed = [];

// ---------- timers ----------
const timers = [];
let currentTick = 0;
export const system = {
  get currentTick() { return currentTick; },
  run: (fn) => (timers.push({ at: currentTick, fn }), timers.length),
  runTimeout: (fn, t = 1) => (timers.push({ at: currentTick + t, fn }), timers.length),
  runInterval: (fn, t = 1) => (timers.push({ at: currentTick + t, fn, every: t }), timers.length),
  clearRun: () => {},
  beforeEvents: { startup: signal() },
};
export function __tick(n = 1) {
  for (let k = 0; k < n; k++) {
    currentTick++;
    const due = timers.filter((t) => t.at <= currentTick);
    for (const t of due) {
      t.fn();
      if (t.every) t.at = currentTick + t.every; else timers.splice(timers.indexOf(t), 1);
    }
  }
}
export const __flush = () => new Promise((r) => setImmediate(r));

// ---------- blocks ----------
export class BlockPermutation {
  constructor(id, states = {}) { this.type = { id }; this.states = states; }
  static resolve(id, states) { return new BlockPermutation(id, states); }
  getAllStates() { return this.states; }
}
const blocks = new Map(); // "x,y,z" -> id
let ground = (x, y, z) => (y < 64 ? "minecraft:grass_block" : "minecraft:air");
export const __setGround = (f) => { ground = f; blocks.clear(); };
export const __setBlock = (x, y, z, id) => blocks.set(`${x},${y},${z}`, id);
const idAt = (x, y, z) => blocks.get(`${x},${y},${z}`) ?? ground(x, y, z);
export const __loadedRadius = { r: 100000 };

class Block {
  constructor(dim, x, y, z) { this.dimension = dim; this.x = x; this.y = y; this.z = z; this.location = { x, y, z }; }
  get typeId() { return idAt(this.x, this.y, this.z); }
  get permutation() { return new BlockPermutation(this.typeId); }
  setType(id) { blocks.set(`${this.x},${this.y},${this.z}`, typeof id === "string" ? id : id.id); }
  setPermutation(p) { blocks.set(`${this.x},${this.y},${this.z}`, p.type.id); }
}

// ---------- entities ----------
let nextId = 1;
const entities = new Map();
class Entity {
  constructor(typeId, loc, dim) {
    this.id = String(nextId++); this.typeId = typeId; this.location = { ...loc }; this.dimension = dim;
    this.tags = new Set(); this.nameTag = ""; this.isValid = true; this.props = {}; this.rot = { x: 0, y: 0 }; this.dyn = {};
    entities.set(this.id, this);
  }
  teleport(loc, o = {}) { this.location = { ...loc }; if (o.rotation) this.rot = o.rotation; }
  remove() { this.isValid = false; entities.delete(this.id); }
  addTag(t) { this.tags.add(t); return true; }
  removeTag(t) { return this.tags.delete(t); }
  hasTag(t) { return this.tags.has(t); }
  getTags() { return [...this.tags]; }
  setProperty(k, v) { this.props[k] = v; }
  setRotation(r) { this.rot = r; }
  getRotation() { return this.rot; }
  getDynamicProperty(k) { return this.dyn[k]; }
  setDynamicProperty(k, v) { if (v === undefined) delete this.dyn[k]; else this.dyn[k] = v; }
}

class Container {
  constructor(size) { this.size = size; this.items = new Array(size).fill(undefined); }
  getItem(i) { return this.items[i]; }
  setItem(i, it) { this.items[i] = it; }
  addItem(it) { const i = this.items.findIndex((x) => !x); if (i < 0) return it; this.items[i] = it; return undefined; }
  swapItems(a, b) { [this.items[a], this.items[b]] = [this.items[b], this.items[a]]; }
}
export class ItemStack {
  constructor(typeId, amount = 1) { this.typeId = typeId; this.amount = amount; this.nameTag = undefined; this.lore = []; }
  setLore(l) { this.lore = l; }
}
export class MolangVariableMap {
  setColorRGBA() {} setColorRGB() {} setVector3() {} setFloat() {}
}

export const __log = { titles: [], actionbars: [], messages: [], sounds: [], particles: 0, cameras: [] };

class Player extends Entity {
  constructor(name, loc, dim) {
    super("minecraft:player", loc, dim);
    this.name = name; this.gm = GameMode.Survival; this.selectedSlotIndex = 0; this.isSneaking = false;
    this.playerPermissionLevel = 2; this.inv = new Container(36); this.perms = {};
    const self = this;
    this.camera = { setCamera: (preset, o) => __log.cameras.push({ who: name, preset, o }), clear: () => __log.cameras.push({ who: name, preset: "clear" }) };
    this.inputPermissions = { setPermissionCategory: (c, on) => (self.perms[c] = on) };
    this.onScreenDisplay = {
      setActionBar: (t) => __log.actionbars.push(`${name}: ${t}`),
      setTitle: (t, o) => __log.titles.push(`${name}: ${t} | ${o?.subtitle ?? ""}`),
    };
  }
  getComponent(id) { return id === "minecraft:inventory" ? { container: this.inv } : undefined; }
  getGameMode() { return this.gm; }
  setGameMode(g) { this.gm = g; }
  sendMessage(m) { __log.messages.push(`${this.name}: ${m}`); }
  playSound(id) { __log.sounds.push(id); }
  playAnimation() {}
  getHeadLocation() { return { ...this.location, y: this.location.y + 1.6 }; }
  getBlockFromViewDirection() { return this.lookAt ? { block: new Block(this.dimension, this.lookAt.x, this.lookAt.y, this.lookAt.z) } : undefined; }
}

class Dimension {
  constructor(id) { this.id = id; }
  getBlock(l) {
    const x = Math.floor(l.x), y = Math.floor(l.y), z = Math.floor(l.z);
    if (Math.abs(x) > __loadedRadius.r || Math.abs(z) > __loadedRadius.r) throw new Error("LocationInUnloadedChunkError");
    return new Block(this, x, y, z);
  }
  spawnEntity(type, loc) { return new Entity(type, loc, this); }
  getEntities(q = {}) { return [...entities.values()].filter((e) => e.typeId !== "minecraft:player" && (!q.type || e.typeId === q.type) && (!q.tags || q.tags.every((t) => e.tags.has(t)))); }
  spawnParticle() { __log.particles++; }
  playSound(id) { __log.sounds.push(id); }
  isChunkLoaded() { return true; }
}
const overworld = new Dimension("minecraft:overworld");

const dyn = new Map();
const players = [];
export const world = {
  getDimension: () => overworld,
  getPlayers: () => players.filter((p) => p.isValid),
  getEntity: (id) => entities.get(id),
  getDynamicProperty: (k) => dyn.get(k),
  setDynamicProperty: (k, v) => (v === undefined ? dyn.delete(k) : dyn.set(k, v)),
  structureManager: {
    place: (id, _dim, at) => {
      const name = String(id).split(":")[1];
      const file = new URL(`../../pack/BP/structures/golf/${name}.mcstructure`, import.meta.url);
      __placed.push(id);
      return placeFile(file, at, (x, y, z, b) => blocks.set(`${x},${y},${z}`, b));
    },
  },
  tickingAreaManager: { hasCapacity: () => true, createTickingArea: async () => {}, hasTickingArea: () => false, removeTickingArea: () => {} },
  afterEvents: {
    itemUse: signal(), itemStartUse: signal(), playerButtonInput: signal(), playerInteractWithEntity: signal(),
    playerSpawn: signal(), playerLeave: signal(), worldLoad: signal(),
  },
};
export function __addPlayer(name, loc) {
  const p = new Player(name, loc, overworld);
  players.push(p);
  return p;
}
export const __entities = entities;
