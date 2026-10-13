// Adapter from a Minecraft dimension to the physics module's `terrain` interface.

const STATEFUL = ["slab", "snow_layer"];

/**
 * Build a terrain view with a per-shot block cache. Blocks rarely change while a
 * ball is in the air, and the same columns get probed many times per tick.
 */
export function makeTerrain(dim, green, scale) {
  const cache = new Map();
  return {
    green,
    scale,
    block(x, y, z) {
      const key = x + "," + y + "," + z;
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      let out = null;
      try {
        const b = dim.getBlock({ x, y, z });
        if (b) {
          const id = b.typeId;
          out = { id, states: undefined };
          if (STATEFUL.some((s) => id.includes(s))) out.states = b.permutation.getAllStates();
        }
      } catch {
        out = null; // unloaded chunk
      }
      if (out) cache.set(key, out); // never cache "unloaded": it may load next tick
      if (cache.size > 60000) cache.clear();
      return out;
    },
    clear() {
      cache.clear();
    },
  };
}
