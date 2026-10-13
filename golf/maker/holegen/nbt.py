"""Minimal little-endian NBT (Bedrock) writer/reader, enough for .mcstructure files."""
from __future__ import annotations

import struct
from typing import Any

END, BYTE, SHORT, INT, LONG, FLOAT, DOUBLE, BYTE_ARRAY, STRING, LIST, COMPOUND, INT_ARRAY = range(12)


class Tag:
    """Typed value wrapper for when the Python type is ambiguous."""

    def __init__(self, kind: int, value: Any, item_kind: int | None = None):
        self.kind = kind
        self.value = value
        self.item_kind = item_kind


def Byte(v): return Tag(BYTE, v)
def Int(v): return Tag(INT, v)
def String(v): return Tag(STRING, v)
def IntList(values): return Tag(LIST, values, INT)
def CompoundList(values): return Tag(LIST, values, COMPOUND)
def ListOf(kind, values): return Tag(LIST, values, kind)


def _kind(v) -> int:
    if isinstance(v, Tag):
        return v.kind
    if isinstance(v, bool):
        return BYTE
    if isinstance(v, int):
        return INT
    if isinstance(v, float):
        return FLOAT
    if isinstance(v, str):
        return STRING
    if isinstance(v, dict):
        return COMPOUND
    raise TypeError(f"can't infer NBT type of {type(v)}")


def _payload(out: bytearray, kind: int, v) -> None:
    if isinstance(v, Tag):
        item_kind = v.item_kind
        v = v.value
    else:
        item_kind = None
    if kind == BYTE:
        out += struct.pack("<b", int(v))
    elif kind == SHORT:
        out += struct.pack("<h", v)
    elif kind == INT:
        out += struct.pack("<i", v)
    elif kind == LONG:
        out += struct.pack("<q", v)
    elif kind == FLOAT:
        out += struct.pack("<f", v)
    elif kind == DOUBLE:
        out += struct.pack("<d", v)
    elif kind == STRING:
        b = v.encode("utf-8")
        out += struct.pack("<H", len(b)) + b
    elif kind == LIST:
        ik = item_kind if item_kind is not None else (_kind(v[0]) if v else END)
        out += struct.pack("<bi", ik, len(v))
        if ik == INT and not isinstance(v, list):
            out += v  # pre-packed bytes
            return
        if ik == INT:
            out += struct.pack(f"<{len(v)}i", *v)
            return
        for item in v:
            _payload(out, ik, item)
    elif kind == COMPOUND:
        for name, item in v.items():
            k = _kind(item)
            out += struct.pack("<b", k)
            _payload(out, STRING, name)
            _payload(out, k, item)
        out += struct.pack("<b", END)
    else:
        raise ValueError(kind)


def dumps(root: dict, name: str = "") -> bytes:
    out = bytearray()
    out += struct.pack("<b", COMPOUND)
    _payload(out, STRING, name)
    _payload(out, COMPOUND, root)
    return bytes(out)


# ---------- reader (for tests) ----------

def loads(data: bytes):
    pos = 0

    def rd(fmt):
        nonlocal pos
        r = struct.unpack_from(fmt, data, pos)
        pos += struct.calcsize(fmt)
        return r[0] if len(r) == 1 else r

    def payload(kind):
        nonlocal pos
        if kind == BYTE: return rd("<b")
        if kind == SHORT: return rd("<h")
        if kind == INT: return rd("<i")
        if kind == LONG: return rd("<q")
        if kind == FLOAT: return rd("<f")
        if kind == DOUBLE: return rd("<d")
        if kind == STRING:
            n = rd("<H")
            s = data[pos:pos + n].decode("utf-8")
            pos += n
            return s
        if kind == LIST:
            ik, n = rd("<bi")
            if ik == INT:
                vals = struct.unpack_from(f"<{n}i", data, pos)
                pos += 4 * n
                return list(vals)
            return [payload(ik) for _ in range(n)]
        if kind == COMPOUND:
            d = {}
            while True:
                k = rd("<b")
                if k == END:
                    return d
                name = payload(STRING)
                d[name] = payload(k)
        raise ValueError(kind)

    k = rd("<b")
    assert k == COMPOUND
    payload(STRING)
    return payload(COMPOUND)
