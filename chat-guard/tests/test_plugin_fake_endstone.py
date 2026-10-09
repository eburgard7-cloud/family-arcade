"""Runs the plugin against a fake `endstone` package that mirrors the real
0.11 API surface the plugin uses (taken from endstone's .pyi stubs). It proves
the glue code runs; it is not a substitute for a test on a real server."""

import json
import os
import sys
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def install_fake_endstone():
    endstone = types.ModuleType("endstone")

    class ColorFormat:
        YELLOW = "§e"
        AQUA = "§b"

    endstone.ColorFormat = ColorFormat

    event = types.ModuleType("endstone.event")

    class EventPriority:
        LOWEST, LOW, NORMAL, HIGH, HIGHEST, MONITOR = range(6)

    def event_handler(func=None, *, priority=EventPriority.NORMAL, ignore_cancelled=False):
        def wrap(f):
            f._is_handler = True
            return f
        return wrap(func) if func else wrap

    class Cancellable:
        is_cancelled = False

        def cancel(self):
            self.is_cancelled = True

    class PlayerChatEvent(Cancellable):
        def __init__(self, player, message):
            self.player, self.message = player, message

    class PlayerCommandEvent(Cancellable):
        def __init__(self, player, command):
            self.player, self.command = player, command

    class PlayerJoinEvent:
        def __init__(self, player):
            self.player = player

    class BlockPlaceEvent(Cancellable):
        def __init__(self, player, type_):
            self.player = player
            self.block_placed_state = types.SimpleNamespace(type=type_)

    for n, v in dict(EventPriority=EventPriority, event_handler=event_handler, PlayerChatEvent=PlayerChatEvent,
                     PlayerCommandEvent=PlayerCommandEvent, PlayerJoinEvent=PlayerJoinEvent,
                     BlockPlaceEvent=BlockPlaceEvent).items():
        setattr(event, n, v)

    plugin = types.ModuleType("endstone.plugin")

    class Logger:
        def __init__(self):
            self.lines = []

        def info(self, m):
            self.lines.append(m)

        error = info

    class Plugin:
        def __init__(self):
            self.logger = Logger()

        def register_events(self, listener):
            self.registered = listener

    plugin.Plugin = Plugin
    sys.modules.update({"endstone": endstone, "endstone.event": event, "endstone.plugin": plugin})
    return event


class FakePlayer:
    def __init__(self, name, xuid="", op=False):
        self.name, self.xuid, self.is_op = name, xuid, op
        self.inbox = []

    def send_message(self, m):
        self.inbox.append(m)


class FakeScheduler:
    def __init__(self):
        self.tasks = []

    def run_task(self, plugin, task, delay=0, period=0):
        self.tasks.append(task)


class FakeServer:
    def __init__(self, players):
        self.online_players = players
        self.scheduler = FakeScheduler()
        self.command_sender = "console"
        self.dispatched = []
        self.was_shutdown = False

    def dispatch_command(self, sender, line):
        self.dispatched.append((sender, line))
        return True

    def shutdown(self):
        self.was_shutdown = True


@pytest.fixture
def env(tmp_path, monkeypatch):
    ev = install_fake_endstone()
    sys.path.insert(0, str(ROOT / "src"))
    for m in [m for m in sys.modules if m.startswith("endstone_chat_guard")]:
        del sys.modules[m]
    from endstone_chat_guard import ChatGuard

    monkeypatch.chdir(tmp_path)
    kid = FakePlayer("CoolKid", xuid="2535000000000001")
    eric = FakePlayer("Eric", xuid="2535000000000002", op=True)
    plugin = ChatGuard()
    plugin.server = FakeServer([kid, eric])
    plugin.on_enable()
    return types.SimpleNamespace(ev=ev, plugin=plugin, kid=kid, eric=eric, home=tmp_path / "moderation")


def chat(env, player, text):
    e = env.ev.PlayerChatEvent(player, text)
    env.plugin.on_chat(e)
    return e


def test_files_created(env):
    h = env.home
    assert (h / "settings.json").exists()
    assert (h / "wordlists" / "profanity.txt").exists()
    assert (h / "wordlists" / "extra_blocked.txt").exists()
    hb = json.loads((h / "heartbeat.json").read_text())
    assert hb["players"] == 2


def test_clean_message_passes_and_is_logged(env):
    e = chat(env, env.kid, "hi everyone")
    assert not e.is_cancelled
    log = next((env.home / "logs").glob("chat-*.log")).read_text()
    assert "CoolKid\tSENT\thi everyone" in log


def test_swear_blocked_and_flagged(env):
    e = chat(env, env.kid, "this is shit")
    assert e.is_cancelled
    assert any("isn't allowed" in m for m in env.kid.inbox)
    flags = [json.loads(l) for l in (env.home / "flags.jsonl").read_text().splitlines()]
    assert flags[-1]["category"] == "profanity"


def test_three_strikes_mutes_and_persists(env):
    for t in ["you're stupid", "you are dumb", "shut up"]:
        chat(env, env.kid, t)
    e = chat(env, env.kid, "hello")
    assert e.is_cancelled and "chat is off" in env.kid.inbox[-1]
    mutes = json.loads((env.home / "mutes.json").read_text())
    assert "xuid:2535000000000001" in mutes


def test_personal_info_flag_has_no_message_text(env):
    chat(env, env.kid, "i live at 123 maple street")
    flag = json.loads((env.home / "flags.jsonl").read_text().splitlines()[-1])
    assert "maple" not in json.dumps(flag)


def test_op_bypass(env):
    e = chat(env, env.eric, "this is shit")
    assert not e.is_cancelled


def test_whisper_blocked_and_me_filtered(env):
    e = env.ev.PlayerCommandEvent(env.kid, "/tell Eric hi")
    env.plugin.on_command(e)
    assert e.is_cancelled
    e = env.ev.PlayerCommandEvent(env.kid, "/me says shit")
    env.plugin.on_command(e)
    assert e.is_cancelled
    e = env.ev.PlayerCommandEvent(env.kid, "/me waves")
    env.plugin.on_command(e)
    assert not e.is_cancelled


def test_caps_lowered(env):
    e = chat(env, env.kid, "LOOK AT MY HOUSE EVERYONE")
    assert not e.is_cancelled and e.message == "look at my house everyone"


def test_inbox_commands(env):
    inbox = env.home / "inbox"
    (inbox / "a.cmd").write_text('allowlist add "New Kid"\nmute CoolKid 5\n')
    env.plugin._poll_inbox()
    assert ("console", 'allowlist add "New Kid"') in env.plugin.server.dispatched
    assert chat(env, env.kid, "hi").is_cancelled
    (inbox / "b.cmd").write_text("unmute CoolKid\nstop\n")
    env.plugin._poll_inbox()
    assert not chat(env, env.kid, "hi again").is_cancelled
    assert env.plugin.server.was_shutdown
    assert not list(inbox.glob("*.cmd"))


def test_mute_by_name_before_join_carries_over(env):
    (env.home / "inbox" / "c.cmd").write_text("mute Latecomer 10\n")
    env.plugin._poll_inbox()
    late = FakePlayer("Latecomer", xuid="2535000000000009")
    env.plugin.server.online_players.append(late)
    assert chat(env, late, "hi").is_cancelled


def test_signs_toggle(env):
    e = env.ev.BlockPlaceEvent(env.kid, "minecraft:oak_sign")
    env.plugin.on_place(e)
    assert not e.is_cancelled
    env.plugin.settings["block_signs"] = True
    e = env.ev.BlockPlaceEvent(env.kid, "minecraft:oak_sign")
    env.plugin.on_place(e)
    assert e.is_cancelled


def test_old_logs_pruned(env):
    old = env.home / "logs" / "chat-2020-01-01.log"
    old.write_text("x")
    os.utime(old, (0, 0))
    env.plugin._prune_logs()
    assert not old.exists()
