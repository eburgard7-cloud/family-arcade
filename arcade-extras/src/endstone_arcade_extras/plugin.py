"""Arcade Extras: the welcome-to-town moment for the family server.

Files live in <server folder>/arcade/ (container /data/arcade/), re-read on every
join, so edits apply without a restart:

    welcome.json   town name, titles, starter kit, landing spot, fireworks (created on first start)
    plots.json     PRIVATE: gamertag -> personal plot coordinates (optional)
    seen.json      who has already had their first-join welcome
"""

from __future__ import annotations

import json
import time
from pathlib import Path

from endstone import ColorFormat
from endstone.event import PlayerJoinEvent, event_handler
from endstone.plugin import Plugin

VERSION = "0.1.0"
TICKS_PER_SECOND = 20

DEFAULT_WELCOME = {
    "_help": "Edit and save; changes apply on the next join. Use {player} and {town} in any text.",
    "town_name": "Cousin Town",
    "first_join": {
        "title": "Welcome to {town}!",
        "subtitle": "Glad you're here, {player}",
        "chat": [
            "Welcome to {town}, {player}! Your starter kit is in your inventory.",
            "Read the welcome book at the town square, and check the rule book at play.finsonly.net.",
        ],
        "landing": {"enabled": False, "x": 0, "y": 80, "z": 0, "_note": "Town square. Off = land at the world spawn."},
        "use_personal_plots": True,
        "fireworks": True,
        "starter_kit": [
            {"item": "stone_sword", "count": 1},
            {"item": "stone_pickaxe", "count": 1},
            {"item": "stone_axe", "count": 1},
            {"item": "bread", "count": 16},
            {"item": "torch", "count": 32},
            {"item": "bed", "count": 1},
            {"item": "oak_log", "count": 16},
        ],
    },
    "returning": {
        "enabled": True,
        "chat": "Welcome back to {town}, {player}!",
    },
}

DEFAULT_PLOTS = {
    "_help": "PRIVATE, never published. Map each kid's exact gamertag to their plot. First join drops them there and sets their spawn point there.",
    "Example Gamertag": {"x": 120, "y": 72, "z": -40},
}


def _fmt(text: str, player: str, town: str) -> str:
    return str(text).replace("{player}", player).replace("{town}", town)


def _q(name: str) -> str:
    """Quote a gamertag for a console command (gamertags can contain spaces)."""
    return '"' + name.replace('"', "") + '"'


class ArcadeExtras(Plugin):
    api_version = "0.11"

    def on_enable(self) -> None:
        self.home = Path.cwd() / "arcade"
        self.home.mkdir(parents=True, exist_ok=True)
        for name, default in (("welcome.json", DEFAULT_WELCOME), ("plots.json", DEFAULT_PLOTS)):
            path = self.home / name
            if not path.exists():
                path.write_text(json.dumps(default, indent=2) + "\n", encoding="utf-8")
        self.register_events(self)
        self.logger.info(f"Arcade Extras {VERSION} enabled. Files in {self.home}")

    # ---------- files ----------

    def _read(self, name: str, default):
        try:
            return json.loads((self.home / name).read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            self.logger.error(f"{name}: {exc}; using defaults")
            return default

    def _seen(self) -> dict:
        data = self._read("seen.json", {})
        return data if isinstance(data, dict) else {}

    def _mark_seen(self, key: str, name: str) -> None:
        seen = self._seen()
        seen[key] = {"name": name, "first_join": int(time.time())}
        tmp = self.home / "seen.json.tmp"
        tmp.write_text(json.dumps(seen, indent=2), encoding="utf-8")
        tmp.replace(self.home / "seen.json")

    # ---------- events ----------

    @event_handler
    def on_join(self, event: PlayerJoinEvent) -> None:
        player = event.player
        key = f"xuid:{player.xuid}" if getattr(player, "xuid", "") else f"name:{player.name.lower()}"
        first = key not in self._seen()
        if first:
            self._mark_seen(key, player.name)
        # Wait a few seconds so the player has finished loading in.
        self.server.scheduler.run_task(self, lambda: self._greet(player.name, first), delay=4 * TICKS_PER_SECOND)

    def _online(self, name: str):
        for p in self.server.online_players:
            if p.name == name:
                return p
        return None

    def _console(self, line: str) -> None:
        self.server.dispatch_command(self.server.command_sender, line)

    def _greet(self, name: str, first: bool) -> None:
        player = self._online(name)
        if player is None:
            return
        cfg = self._read("welcome.json", DEFAULT_WELCOME)
        town = cfg.get("town_name", "Cousin Town")

        if not first:
            ret = cfg.get("returning", {})
            if ret.get("enabled", True) and ret.get("chat"):
                player.send_message(ColorFormat.AQUA + _fmt(ret["chat"], name, town))
            return

        fj = cfg.get("first_join", {})

        spot = None
        if fj.get("use_personal_plots", True):
            plots = self._read("plots.json", {})
            for tag, coords in plots.items():
                if not tag.startswith("_") and tag.lower() == name.lower() and isinstance(coords, dict):
                    spot = coords
        if spot is None and fj.get("landing", {}).get("enabled"):
            spot = fj["landing"]
        if spot is not None:
            x, y, z = int(spot.get("x", 0)), int(spot.get("y", 80)), int(spot.get("z", 0))
            self._console(f"tp {_q(name)} {x} {y} {z}")
            self._console(f"spawnpoint {_q(name)} {x} {y} {z}")

        for entry in fj.get("starter_kit", []):
            item = str(entry.get("item", "")).strip()
            count = int(entry.get("count", 1))
            if item and item.replace("_", "").replace(":", "").isalnum() and 0 < count <= 64:
                self._console(f"give {_q(name)} {item} {count}")

        player.send_title(_fmt(fj.get("title", ""), name, town), _fmt(fj.get("subtitle", ""), name, town), 10, 90, 30)
        for line in fj.get("chat", []):
            player.send_message(ColorFormat.GOLD + _fmt(line, name, town))

        self._console(f"playsound random.levelup {_q(name)}")
        if fj.get("fireworks", True):
            # Let the teleport land before the celebration.
            self.server.scheduler.run_task(self, lambda: self._fireworks(name), delay=2 * TICKS_PER_SECOND)

        self.logger.info(f"Arcade Extras: welcomed {name} to {town}")

    def _fireworks(self, name: str) -> None:
        player = self._online(name)
        if player is None:
            return
        loc = player.location
        for dx, dz in ((3, 0), (-3, 2), (0, -3)):
            self._console(f"summon fireworks_rocket {loc.x + dx:.1f} {loc.y + 1:.1f} {loc.z + dz:.1f}")
