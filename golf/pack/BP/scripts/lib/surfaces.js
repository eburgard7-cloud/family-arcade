// What every block does to a golf ball. Builders shape holes just by placing
// blocks: the golf turf blocks are the "real" palette, and natural vanilla
// blocks map to sensible golf surfaces so the course blends into the world.
//
// e        restitution on impact (vertical bounce kept)
// mu       fraction of horizontal speed lost on impact
// roll     rolling deceleration, m/s^2 (stimp 10 green ~ 0.55)
// spinBite how much backspin can grab on impact (0..1)
// lieDist  distance multiplier for the next full shot from here
// lieSpin  spin multiplier for the next shot (flyers out of rough)
// lieAcc   perfect-window multiplier for the next shot

export const SURFACES = {
  tee:      { name: "Tee",       color: "§a", e: 0.30, mu: 0.50, roll: 1.70, spinBite: 0.8, lieDist: 1.00, lieSpin: 1.0, lieAcc: 1.1 },
  fairway:  { name: "Fairway",   color: "§a", e: 0.30, mu: 0.47, roll: 1.60, spinBite: 0.8, lieDist: 1.00, lieSpin: 1.0, lieAcc: 1.0 },
  fringe:   { name: "Fringe",    color: "§2", e: 0.25, mu: 0.60, roll: 1.40, spinBite: 0.7, lieDist: 0.97, lieSpin: 0.9, lieAcc: 1.0 },
  green:    { name: "Green",     color: "§a", e: 0.22, mu: 0.45, roll: 0.55, spinBite: 1.0, lieDist: 0.95, lieSpin: 1.0, lieAcc: 1.0 },
  rough:    { name: "Rough",     color: "§2", e: 0.16, mu: 0.70, roll: 3.50, spinBite: 0.35, lieDist: 0.88, lieSpin: 0.55, lieAcc: 0.85 },
  deep:     { name: "Deep Rough",color: "§2", e: 0.08, mu: 0.85, roll: 7.00, spinBite: 0.2, lieDist: 0.74, lieSpin: 0.40, lieAcc: 0.65 },
  bunker:   { name: "Bunker",    color: "§e", e: 0.03, mu: 0.85, roll: 9.00, spinBite: 0.1, lieDist: 0.80, lieSpin: 0.60, lieAcc: 0.75 },
  path:     { name: "Cart Path", color: "§7", e: 0.55, mu: 0.15, roll: 0.60, spinBite: 0.2, lieDist: 0.96, lieSpin: 0.9, lieAcc: 0.9 },
  hard:     { name: "Hard Ground",color:"§7", e: 0.42, mu: 0.30, roll: 1.50, spinBite: 0.3, lieDist: 0.92, lieSpin: 0.8, lieAcc: 0.85 },
  wood:     { name: "Wood",      color: "§6", e: 0.40, mu: 0.25, roll: 1.00, spinBite: 0.3, lieDist: 0.90, lieSpin: 0.8, lieAcc: 0.85 },
  snow:     { name: "Snow",      color: "§f", e: 0.05, mu: 0.70, roll: 6.00, spinBite: 0.1, lieDist: 0.75, lieSpin: 0.5, lieAcc: 0.7 },
  water:    { name: "Water",     color: "§9", hazard: "water" },
  lava:     { name: "Lava",      color: "§c", hazard: "water" },
};

// Golf palette blocks shipped in this pack.
const GOLF = {
  "golf:turf_tee_a": "tee", "golf:turf_tee_b": "tee",
  "golf:turf_fairway_a": "fairway", "golf:turf_fairway_b": "fairway",
  "golf:turf_fringe": "fringe",
  "golf:turf_green_a": "green", "golf:turf_green_b": "green", "golf:cup": "green",
  "golf:turf_rough": "rough",
  "golf:turf_deep_rough": "deep",
  "golf:bunker_sand": "bunker",
  "golf:cart_path": "path",
};

// Natural / vanilla blocks.
const VANILLA = {
  "minecraft:grass_block": "rough",
  "minecraft:dirt": "rough", "minecraft:coarse_dirt": "rough", "minecraft:rooted_dirt": "rough",
  "minecraft:podzol": "deep", "minecraft:mycelium": "deep", "minecraft:moss_block": "deep",
  "minecraft:mud": "deep", "minecraft:pale_moss_block": "deep",
  "minecraft:sand": "bunker", "minecraft:red_sand": "bunker", "minecraft:suspicious_sand": "bunker",
  "minecraft:soul_sand": "bunker",
  "minecraft:gravel": "hard", "minecraft:dirt_path": "path", "minecraft:grass_path": "path",
  "minecraft:snow": "snow", "minecraft:snow_layer": "snow", "minecraft:powder_snow": "snow",
  "minecraft:water": "water", "minecraft:flowing_water": "water",
  "minecraft:lava": "lava", "minecraft:flowing_lava": "lava",
};

// Things a ball flies through but which slow it (tree canopy, hedges).
const CANOPY_HINTS = ["leaves", "vine", "azalea", "mangrove_roots", "cobweb", "bamboo", "hay"];

// Things a rolling or flying ball ignores entirely (decorations and plants).
// Matched on the block name without namespace: exact, or as a "_suffix" / "prefix_".
const PASS_HINTS = [
  "air", "short_grass", "tall_grass", "fern", "flower", "tulip", "daisy", "poppy", "dandelion",
  "orchid", "allium", "bluet", "lily_of_the_valley", "sapling", "dead_bush", "sweet_berry_bush",
  "seagrass", "kelp", "torch", "lantern", "button", "rail", "carpet", "lever", "sign", "banner",
  "pressure_plate", "tripwire", "redstone_wire", "snow_layer", "wildflowers", "leaf_litter", "bush",
  "firefly_bush", "cactus_flower", "pink_petals", "light_block", "structure_void", "flag",
  "sunflower", "lilac", "rose_bush", "peony", "pitcher_plant", "dry_grass", "short_dry_grass", "tall_dry_grass",
];
const nameOf = (id) => (id.includes(":") ? id.slice(id.indexOf(":") + 1) : id);
const hintMatch = (id, hints) => {
  const n = nameOf(id);
  return hints.some((h) => n === h || n.endsWith("_" + h) || n.startsWith(h + "_"));
};

// Plants that, when they sit on top of a grass block, turn rough into deep rough.
const TALL_PLANTS = ["short_grass", "tall_grass", "fern", "large_fern", "short_dry_grass", "tall_dry_grass"];

export function isPassThrough(id) {
  if (!id) return true;
  if (id === "minecraft:air" || id === "minecraft:cave_air" || id === "minecraft:void_air") return true;
  if (id.startsWith("golf:") && id !== "golf:flag") return false;
  return hintMatch(id, PASS_HINTS);
}

export function isCanopy(id) {
  return !!id && !id.startsWith("golf:") && CANOPY_HINTS.some((h) => nameOf(id).includes(h));
}

export function isTallPlant(id) {
  return !!id && TALL_PLANTS.some((h) => nameOf(id) === h);
}

export function isLiquid(id) {
  if (!id) return false;
  const n = nameOf(id);
  return n === "water" || n === "flowing_water" || n === "lava" || n === "flowing_lava";
}

/** Surface key for a solid ground block id. */
export function surfaceOf(id) {
  if (!id) return "hard";
  if (GOLF[id]) return GOLF[id];
  if (VANILLA[id]) return VANILLA[id];
  if (id.includes("log") || id.includes("wood") || id.includes("planks") || id.includes("stem")) return "wood";
  if (id.includes("concrete_powder") || id.includes("sandstone")) return "hard";
  return "hard";
}

/** Height of the top face inside a block, for blocks that aren't full cubes. */
export function blockTopFraction(id, states = {}) {
  if (!id) return 1;
  if (id.includes("_slab") && !id.includes("double")) {
    const half = states["minecraft:vertical_half"];
    return half === "top" ? 1 : 0.5;
  }
  if (id.endsWith("snow_layer")) return ((states["height"] ?? 0) + 1) / 8;
  if (id.includes("carpet")) return 1 / 16;
  if (id === "minecraft:dirt_path" || id === "minecraft:grass_path" || id === "minecraft:farmland") return 15 / 16;
  if (id === "minecraft:soul_sand" || id === "minecraft:mud") return 14 / 16;
  return 1;
}

export const surfaceInfo = (key) => SURFACES[key] ?? SURFACES.hard;

/** Every golf palette block, for the brush menu and docs. */
export const GOLF_BLOCKS = Object.keys(GOLF);
