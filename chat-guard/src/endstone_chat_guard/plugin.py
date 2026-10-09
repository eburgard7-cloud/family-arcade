"""Chat Guard: a chat moderator for a family Bedrock server, running on Endstone.

Everything it needs lives in <server folder>/moderation/ (the container's
/data/moderation), so the Unraid scripts can reach it without knowing Endstone's
plugin naming:

    settings.json        rules (created with defaults on first start)
    wordlists/           editable copies of the word lists
    logs/chat-DATE.log   every message and what happened to it (kept 30 days)
    flags.jsonl          things Eric should know about (read by mc-moderation.sh)
    mutes.json           active mutes, kept across restarts
    heartbeat.json       rewritten every minute; the watchdog stops the server if it goes stale
    inbox/*.cmd          console commands dropped in by the Unraid scripts
"""

from __future__ import annotations

import datetime as dt
import json
import shutil
import time
from pathlib import Path

from endstone import ColorFormat
from endstone.event import (
    BlockPlaceEvent,
    EventPriority,
    PlayerChatEvent,
    PlayerCommandEvent,
    PlayerJoinEvent,
    event_handler,
)
from endstone.plugin import Plugin

from .moderator import DEFAULT_SETTINGS, Moderator

VERSION = "0.1.0"
TICKS_PER_SECOND = 20
PRIVATE_MESSAGE_COMMANDS = {"tell", "msg", "w", "whisper"}
TEXT_COMMANDS = {"me"}


class ChatGuard(Plugin):
    api_version = "0.11"

    # ---------- lifecycle ----------

    def on_enable(self) -> None:
        self.home = Path.cwd() / "moderation"
        self.lists_dir = self.home / "wordlists"
        self.log_dir = self.home / "logs"
        self.inbox = self.home / "inbox"
        for d in (self.home, self.lists_dir, self.log_dir, self.inbox):
            d.mkdir(parents=True, exist_ok=True)

        self._install_default_lists()
        self.settings = self._load_settings()
        self.mod = Moderator(self.settings, self.lists_dir)
        self._load_mutes()

        self.register_events(self)
        scheduler = self.server.scheduler
        scheduler.run_task(self, self._heartbeat, delay=0, period=60 * TICKS_PER_SECOND)
        scheduler.run_task(self, self._poll_inbox, delay=TICKS_PER_SECOND, period=TICKS_PER_SECOND)
        scheduler.run_task(self, self._prune_logs, delay=5 * TICKS_PER_SECOND, period=6 * 3600 * TICKS_PER_SECOND)

        self.logger.info(f"Chat Guard {VERSION} enabled. Files in {self.home}")
        self._heartbeat()

    def on_disable(self) -> None:
        self._save_mutes()
        try:
            (self.home / "heartbeat.json").unlink()
        except OSError:
            pass

    # ---------- files ----------

    def _install_default_lists(self) -> None:
        packaged = Path(__file__).parent / "wordlists"
        for src in packaged.iterdir():
            dst = self.lists_dir / src.name
            if src.is_file() and not dst.exists():
                shutil.copyfile(src, dst)
        extra = self.lists_dir / "extra_blocked.txt"
        if not extra.exists():
            extra.write_text("# Add your own blocked words or phrases here, one per line.\n", encoding="utf-8")

    def _load_settings(self) -> dict:
        path = self.home / "settings.json"
        current = {}
        if path.exists():
            try:
                current = json.loads(path.read_text(encoding="utf-8"))
            except ValueError as exc:
                self.logger.error(f"settings.json has a JSON error, using defaults: {exc}")
        merged = {**DEFAULT_SETTINGS, **current}
        if merged != current:
            path.write_text(json.dumps(merged, indent=2) + "\n", encoding="utf-8")
        return merged

    def _load_mutes(self) -> None:
        path = self.home / "mutes.json"
        if path.exists():
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                now = time.time()
                self.mod.mutes = {k: float(v) for k, v in data.items() if float(v) > now}
            except (ValueError, TypeError):
                self.logger.error("mutes.json unreadable; starting with no mutes")

    def _save_mutes(self) -> None:
        path = self.home / "mutes.json"
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.mod.mutes), encoding="utf-8")
        tmp.replace(path)

    def _log(self, player: str, outcome: str, text: str) -> None:
        now = dt.datetime.now()
        line = f"{now:%H:%M:%S}\t{player}\t{outcome}\t{text.replace(chr(10), ' ')}\n"
        with (self.log_dir / f"chat-{now:%Y-%m-%d}.log").open("a", encoding="utf-8") as fh:
            fh.write(line)

    def _flag(self, player: str, category: str, detail: str, action: str) -> None:
        rec = {"time": dt.datetime.now().isoformat(timespec="seconds"), "player": player,
               "category": category, "action": action, "detail": detail}
        with (self.home / "flags.jsonl").open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec) + "\n")

    def _prune_logs(self) -> None:
        keep = int(self.settings.get("log_retention_days", 30))
        cutoff = time.time() - keep * 86400
        for f in self.log_dir.glob("chat-*.log"):
            if f.stat().st_mtime < cutoff:
                f.unlink(missing_ok=True)

    def _heartbeat(self) -> None:
        rec = {"time": int(time.time()), "version": VERSION, "players": len(self.server.online_players)}
        path = self.home / "heartbeat.json"
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(rec), encoding="utf-8")
        tmp.replace(path)

    # ---------- the inbox (commands from the Unraid scripts) ----------

    def _poll_inbox(self) -> None:
        for f in sorted(self.inbox.glob("*.cmd")):
            try:
                lines = f.read_text(encoding="utf-8").splitlines()
            finally:
                f.unlink(missing_ok=True)
            for line in lines:
                line = line.strip()
                if line:
                    self._run_inbox_line(line)

    def _run_inbox_line(self, line: str) -> None:
        self.logger.info(f"inbox: {line}")
        parts = line.split()
        verb = parts[0].lower()
        if verb == "stop":
            self._save_mutes()
            self.server.shutdown()
        elif verb == "reload-moderation":
            self.settings = self._load_settings()
            self.mod.settings = {**DEFAULT_SETTINGS, **self.settings}
            self.mod.reload_lists()
            self.logger.info("Chat Guard: settings and word lists reloaded")
        elif verb == "mute" and len(parts) >= 2:
            name = " ".join(p for p in parts[1:] if not p.isdigit()).strip('"')
            minutes = next((int(p) for p in parts[1:] if p.isdigit()), self.settings["mute_minutes"])
            self.mod.mute(self._key_for_name(name), minutes)
            self._save_mutes()
            self._tell(name, f"An adult turned your chat off for {minutes} minutes. You can still play.")
            self.logger.info(f"Chat Guard: muted {name} for {minutes} min")
        elif verb == "unmute" and len(parts) >= 2:
            name = " ".join(parts[1:]).strip('"')
            self.mod.unmute(self._key_for_name(name))
            self._save_mutes()
            self._tell(name, "Your chat is back on.")
            self.logger.info(f"Chat Guard: unmuted {name}")
        else:
            self.server.dispatch_command(self.server.command_sender, line)

    def _key_for_name(self, name: str) -> str:
        for p in self.server.online_players:
            if p.name.lower() == name.lower():
                return self._key(p)
        return f"name:{name.lower()}"

    def _tell(self, name: str, message: str) -> None:
        for p in self.server.online_players:
            if p.name.lower() == name.lower():
                p.send_message(ColorFormat.YELLOW + message)

    # ---------- events ----------

    @staticmethod
    def _key(player) -> str:
        # Mutes follow the Xbox account, so leaving and rejoining doesn't clear them.
        return f"xuid:{player.xuid}" if getattr(player, "xuid", "") else f"name:{player.name.lower()}"

    def _bypass(self, player) -> bool:
        return bool(self.settings.get("ops_bypass", True)) and player.is_op

    def _keys(self, player) -> str:
        key = self._key(player)
        # Mutes set by name before the player joined still apply.
        name_key = f"name:{player.name.lower()}"
        if name_key in self.mod.mutes and key != name_key:
            self.mod.mutes[key] = self.mod.mutes.pop(name_key)
        return key

    @event_handler
    def on_join(self, event: PlayerJoinEvent) -> None:
        msg = self.settings.get("welcome_message")
        if msg:
            event.player.send_message(ColorFormat.AQUA + msg)

    @event_handler(priority=EventPriority.HIGHEST)
    def on_chat(self, event: PlayerChatEvent) -> None:
        player = event.player
        text = event.message
        if self._bypass(player):
            self._log(player.name, "SENT(op)", text)
            return
        self._apply(event, player, text, kind="chat")

    @event_handler(priority=EventPriority.HIGHEST)
    def on_command(self, event: PlayerCommandEvent) -> None:
        player = event.player
        line = event.command.strip().lstrip("/")
        if not line:
            return
        name, _, rest = line.partition(" ")
        name = name.lower()
        if self._bypass(player):
            return
        if name in PRIVATE_MESSAGE_COMMANDS and self.settings.get("block_private_messages", True):
            event.cancel()
            player.send_message(ColorFormat.YELLOW + "Private messages are off here. Chat in the open so everyone can see.")
            self._log(player.name, "BLOCKED:private_message", line)
            return
        if name in TEXT_COMMANDS:
            self._apply(event, player, rest, kind="/me")

    @event_handler
    def on_place(self, event: BlockPlaceEvent) -> None:
        if not self.settings.get("block_signs", False):
            return
        if self._bypass(event.player):
            return
        if "sign" in event.block_placed_state.type:
            event.cancel()
            event.player.send_message(ColorFormat.YELLOW + "Signs are turned off on this server.")

    # ---------- shared handling ----------

    def _apply(self, event, player, text: str, kind: str) -> None:
        key = self._keys(player)
        verdict = self.mod.check(key, text)

        if verdict.allowed:
            if verdict.message is not None and kind == "chat":
                event.message = verdict.message
            self._log(player.name, "SENT" if kind == "chat" else f"SENT{kind}", text)
            return

        event.cancel()
        player.send_message(ColorFormat.YELLOW + verdict.reply)
        self._log(player.name, f"BLOCKED:{verdict.category}", text)

        muted = False
        if verdict.mute_now:
            self.mod.mute(key, self.settings["mute_minutes"])
            muted = True
        elif verdict.strike:
            count, muted = self.mod.record_strike(key)
            if not muted and count == self.settings["strikes_to_mute"] - 1:
                player.send_message(ColorFormat.YELLOW + "One more and your chat turns off for a while.")

        if muted:
            minutes = self.settings["mute_minutes"]
            player.send_message(ColorFormat.YELLOW + f"Your chat is off for {minutes} minutes. You can still play.")
            self._save_mutes()
            self._flag(player.name, verdict.category, verdict.flag_detail or "reached the strike limit",
                       f"muted {minutes} min")
        elif verdict.flag:
            self._flag(player.name, verdict.category, verdict.flag_detail, "blocked")
