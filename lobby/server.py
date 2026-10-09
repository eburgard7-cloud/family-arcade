#!/usr/bin/env python3
"""Family arcade lobby.

Serves the lobby page (public/) and one JSON endpoint, /api/status, that
combines three things:
  * a live ping of the Bedrock server (RakNet "unconnected ping", UDP)
  * the Arcade VM state, read from a small JSON file an Unraid user script
    rewrites every minute (the container never touches libvirt)
  * the page content from config.json (edit it, no restart needed)

Python standard library only. Nothing here exposes IP addresses or player
names: the status payload carries counts and on/off flags, nothing else.
"""

import json
import mimetypes
import os
import random
import socket
import struct
import sys
import threading
import time
from email.utils import formatdate, parsedate_to_datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

PUBLIC_DIR = Path(os.environ.get("PUBLIC_DIR", "/app/public")).resolve()
CONFIG_FILE = Path(os.environ.get("CONFIG_FILE", "/config/config.json"))
STATE_FILE = Path(os.environ.get("STATE_FILE", "/state/arcade.json"))
MC_STATE_FILE = Path(os.environ.get("MC_STATE_FILE", "/state/minecraft.json"))
MAINT_FILE = Path(os.environ.get("MAINT_FILE", "/state/maintenance.json"))
MAP_STATE_FILE = Path(os.environ.get("MAP_STATE_FILE", "/state/map.json"))
MAP_DIR = Path(os.environ.get("MAP_DIR", "/map")).resolve()
GALLERY_DIR = Path(os.environ.get("GALLERY_DIR", "/config/gallery")).resolve()
GALLERY_TYPES = {".jpg", ".jpeg", ".png", ".webp"}
MC_HOST = os.environ.get("MC_PING_HOST", "127.0.0.1")
MC_PORT = int(os.environ.get("MC_PING_PORT", "19132"))
PING_TIMEOUT = float(os.environ.get("MC_PING_TIMEOUT", "1.5"))
CACHE_SECONDS = float(os.environ.get("STATUS_CACHE_SECONDS", "10"))
STATE_STALE_SECONDS = float(os.environ.get("STATE_STALE_SECONDS", "180"))
LISTEN_PORT = int(os.environ.get("PORT", "8080"))

RAKNET_MAGIC = bytes.fromhex("00ffff00fefefefefdfdfdfd12345678")

SECURITY_HEADERS = {
    "Content-Security-Policy": (
        "default-src 'self'; img-src 'self' data:; style-src 'self'; "
        "script-src 'self'; font-src 'self'; connect-src 'self'; "
        "frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
    ),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
}

# The world map (uNmINeD's viewer) uses inline scripts and styles, so it gets its
# own, looser policy. It sits behind the family password in Caddy.
MAP_CSP = (
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; "
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'; font-src 'self' data:; connect-src 'self'; "
    "worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
)

mimetypes.add_type("font/woff2", ".woff2")
mimetypes.add_type("image/webp", ".webp")
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("text/javascript", ".js")


def log(msg):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), msg, file=sys.stderr, flush=True)


# --------------------------------------------------------------------------
# Bedrock ping
# --------------------------------------------------------------------------

def bedrock_ping(host, port, timeout=PING_TIMEOUT):
    """Send a RakNet unconnected ping and parse the server's MOTD string.

    Reply layout: 0x1c | time(8) | server guid(8) | magic(16) | len(2) | text
    text = MCPE;motd;protocol;version;players;max;server id;level;mode;...
    """
    addr = socket.getaddrinfo(host, port, socket.AF_INET, socket.SOCK_DGRAM)[0][4]
    packet = (
        b"\x01"
        + struct.pack(">q", int(time.time() * 1000))
        + RAKNET_MAGIC
        + struct.pack(">q", random.getrandbits(63))
    )
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.settimeout(timeout)
        started = time.monotonic()
        sock.sendto(packet, addr)
        data, _ = sock.recvfrom(4096)
        latency_ms = round((time.monotonic() - started) * 1000)
    if len(data) < 35 or data[0] != 0x1C or data[17:33] != RAKNET_MAGIC:
        raise ValueError("not a Bedrock pong")
    (length,) = struct.unpack(">H", data[33:35])
    fields = data[35:35 + length].decode("utf-8", "replace").split(";")

    def field(i, default=""):
        return fields[i] if len(fields) > i else default

    def number(i):
        try:
            return int(field(i, "0"))
        except ValueError:
            return 0

    return {
        "online": True,
        "players": number(4),
        "max_players": number(5),
        "version": field(3),
        "motd": field(1),
        "latency_ms": latency_ms,
    }


_status_lock = threading.Lock()
_status_cache = {"at": 0.0, "value": None}


def minecraft_status():
    """Ping at most once per CACHE_SECONDS, however many people load the page."""
    with _status_lock:
        now = time.monotonic()
        if _status_cache["value"] is not None and now - _status_cache["at"] < CACHE_SECONDS:
            return _status_cache["value"]
        try:
            value = bedrock_ping(MC_HOST, MC_PORT)
        except (OSError, ValueError) as exc:
            value = {"online": False, "players": 0, "max_players": 0,
                     "version": "", "motd": "", "error": type(exc).__name__}
        value["chat"] = minecraft_chat_state()
        _status_cache.update(at=now, value=value)
        return value


def maintenance_status():
    """Written by mc-nightly.sh while the server is down for its update."""
    try:
        raw = json.loads(MAINT_FILE.read_text())
    except (OSError, ValueError):
        return {"active": False}
    started = float(raw.get("started", 0))
    # Never let a crashed script leave the banner up for more than 30 minutes.
    if not raw.get("active") or time.time() - started > 1800:
        return {"active": False}
    return {"active": True, "message": str(raw.get("message", ""))[:200]}


def map_status():
    try:
        raw = json.loads(MAP_STATE_FILE.read_text())
        return {"available": (MAP_DIR / "unmined.index.html").exists(), "updated": int(raw.get("updated", 0))}
    except (OSError, ValueError):
        return {"available": (MAP_DIR / "unmined.index.html").exists(), "updated": 0}


def minecraft_chat_state():
    """'moderated', 'off' (fallback mode) or 'unknown', from mc-moderation.sh."""
    try:
        raw = json.loads(MC_STATE_FILE.read_text())
    except (OSError, ValueError):
        return "unknown"
    if time.time() - float(raw.get("updated", 0)) > STATE_STALE_SECONDS:
        return "unknown"
    return raw.get("chat") if raw.get("chat") in ("moderated", "off") else "unknown"


# --------------------------------------------------------------------------
# Arcade VM state (written by the arcade-state user script)
# --------------------------------------------------------------------------

def arcade_status():
    try:
        raw = json.loads(STATE_FILE.read_text())
    except (OSError, ValueError):
        return {"open": False, "state": "unknown", "stale": True}
    updated = float(raw.get("updated", 0))
    stale = (time.time() - updated) > STATE_STALE_SECONDS
    running = bool(raw.get("running")) and not stale
    return {"open": running, "state": raw.get("vm_state", "unknown"), "stale": stale}


# --------------------------------------------------------------------------
# Page content (config.json), reloaded when the file changes
# --------------------------------------------------------------------------

_config_lock = threading.Lock()
_config_cache = {"mtime": None, "value": {}}


def page_config():
    with _config_lock:
        try:
            mtime = CONFIG_FILE.stat().st_mtime
        except OSError:
            log(f"config not found at {CONFIG_FILE}; serving empty config")
            return _config_cache["value"]
        if mtime != _config_cache["mtime"]:
            try:
                _config_cache["value"] = json.loads(CONFIG_FILE.read_text())
                log("config loaded")
            except ValueError as exc:
                # Keep serving the last good copy so a typo never blanks the page.
                log(f"config.json has a JSON error, keeping previous copy: {exc}")
            _config_cache["mtime"] = mtime
        return _config_cache["value"]


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = "arcade-lobby"
    sys_version = ""

    def log_message(self, fmt, *args):
        pass  # Caddy already logs requests; keep container logs for real events.

    def _send(self, code, body=b"", content_type="text/plain; charset=utf-8",
              cache="no-cache", extra=None, override=None):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        for key, value in {**SECURITY_HEADERS, **(override or {})}.items():
            self.send_header(key, value)
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        path = urlsplit(self.path).path

        if path == "/healthz":
            return self._send(200, b"ok\n", cache="no-store")

        if path == "/api/status":
            payload = {
                "generated": int(time.time()),
                "minecraft": minecraft_status(),
                "arcade": arcade_status(),
                "maintenance": maintenance_status(),
                "map": map_status(),
                "config": page_config(),
            }
            body = json.dumps(payload, separators=(",", ":")).encode()
            return self._send(200, body, "application/json", cache="no-store")

        if path == "/map":
            return self._send(301, b"", extra={"Location": "/map/"})
        if path.startswith("/map/"):
            rel = path[len("/map/"):] or "unmined.index.html"
            return self._static(rel, MAP_DIR, {"Content-Security-Policy": MAP_CSP})
        if path.startswith("/gallery/"):
            rel = path[len("/gallery/"):]
            if Path(rel).suffix.lower() not in GALLERY_TYPES:
                return self._send(404, b"Not found\n")
            return self._static(rel, GALLERY_DIR)

        if path in ("", "/"):
            path = "/index.html"
        return self._static(path.lstrip("/"), PUBLIC_DIR)

    def _static(self, rel, root, override=None):
        target = (root / rel).resolve()
        if root not in target.parents or not target.is_file():
            return self._send(404, b"Not found\n")
        path = "/" + rel

        stat = target.stat()
        last_modified = formatdate(stat.st_mtime, usegmt=True)
        since = self.headers.get("If-Modified-Since")
        if since:
            try:
                if int(stat.st_mtime) <= parsedate_to_datetime(since).timestamp():
                    self.send_response(304)
                    self.send_header("Last-Modified", last_modified)
                    self.end_headers()
                    return
            except (TypeError, ValueError):
                pass

        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("image/svg+xml",):
            ctype += "; charset=utf-8"
        cache = "public, max-age=31536000, immutable" if path.startswith("/fonts/") else "no-cache"
        return self._send(200, target.read_bytes(), ctype, cache,
                          {"Last-Modified": last_modified}, override)

    def do_POST(self):
        self._send(405, b"Method not allowed\n", extra={"Allow": "GET, HEAD"})

    do_PUT = do_DELETE = do_PATCH = do_POST


def main():
    page_config()
    log(f"lobby listening on :{LISTEN_PORT}; pinging Bedrock at {MC_HOST}:{MC_PORT}")
    server = ThreadingHTTPServer(("0.0.0.0", LISTEN_PORT), Handler)
    server.daemon_threads = True
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
