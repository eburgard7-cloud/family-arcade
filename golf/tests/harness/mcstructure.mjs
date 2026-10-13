// Tiny little-endian NBT reader for .mcstructure files (test harness only).
import { readFileSync } from "node:fs";

export function readNbt(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = 0;
  const str = () => { const n = dv.getUint16(pos, true); pos += 2; const s = buf.subarray(pos, pos + n).toString("utf8"); pos += n; return s; };
  const payload = (k) => {
    switch (k) {
      case 1: { const v = dv.getInt8(pos); pos += 1; return v; }
      case 2: { const v = dv.getInt16(pos, true); pos += 2; return v; }
      case 3: { const v = dv.getInt32(pos, true); pos += 4; return v; }
      case 4: { const v = dv.getBigInt64(pos, true); pos += 8; return v; }
      case 5: { const v = dv.getFloat32(pos, true); pos += 4; return v; }
      case 6: { const v = dv.getFloat64(pos, true); pos += 8; return v; }
      case 8: return str();
      case 9: {
        const ik = dv.getInt8(pos); const n = dv.getInt32(pos + 1, true); pos += 5;
        if (ik === 3) { const a = new Int32Array(n); for (let i = 0; i < n; i++) a[i] = dv.getInt32(pos + 4 * i, true); pos += 4 * n; return a; }
        const out = []; for (let i = 0; i < n; i++) out.push(payload(ik)); return out;
      }
      case 10: { const o = {}; for (;;) { const t = dv.getInt8(pos); pos += 1; if (t === 0) return o; const name = str(); o[name] = payload(t); } }
      default: throw new Error("nbt tag " + k);
    }
  };
  if (dv.getInt8(pos) !== 10) throw new Error("not nbt");
  pos += 1; str();
  return payload(10);
}

/** Place a structure file: calls setBlock(x, y, z, id) for every block (air included). */
export function placeFile(path, at, setBlock) {
  const d = readNbt(readFileSync(path));
  const [sx, sy, sz] = d.size;
  const idx = d.structure.block_indices[0];
  const pal = d.structure.palette.default.block_palette.map((p) => p.name);
  let i = 0;
  for (let x = 0; x < sx; x++) for (let y = 0; y < sy; y++) for (let z = 0; z < sz; z++) {
    const v = idx[i++];
    if (v >= 0) setBlock(at.x + x, at.y + y, at.z + z, pal[v]);
  }
  return { sx, sy, sz };
}
