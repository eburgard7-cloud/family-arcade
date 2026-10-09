"""Runs Arcade Extras against a fake `endstone` mirroring the 0.11 API it uses."""

import json
import sys
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def install_fake_endstone():
    endstone = types.ModuleType("endstone")
    endstone.ColorFormat = type("ColorFormat", (), {"AQUA": "§b", "GOLD": "§6", "YELLOW": "§e"})
    event = types.ModuleType("endstone.event")

    def event_handler(func=None, **kw):
        return func if func else (lambda f: f)

    class PlayerJoinEvent:
        def __init__(self, player):
            self.player = player

    event.event_handler, event.PlayerJoinEvent = event_handler, PlayerJoinEvent
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
            pass

    plugin.Plugin = Plugin
    sys.modules.update({"endstone": endstone, "endstone.event": event, "endstone.plugin": plugin})
    return event


class FakePlayer:
    def __init__(self, name, xuid):
        self.name, self.xuid = name, xuid
        self.messages, self.titles = [], []
        self.location = types.SimpleNamespace(x=10.5, y=70.0, z=-3.5)

    def send_message(self, m):
        self.messages.append(m)

    def send_title(self, t, s, *a):
        self.titles.append((t, s))


class FakeScheduler:
    def __init__(self):
        self.queue = []

    def run_task(self, plugin, task, delay=0, period=0):
        self.queue.append(task)

    def run_all(self):
        while self.queue:
            self.queue.pop(0)()


class FakeServer:
    def __init__(self, players):
        self.online_players = players
        self.scheduler = FakeScheduler()
        self.command_sender = "console"
        self.commands = []

    def dispatch_command(self, sender, line):
        self.commands.append(line)
        return True


@pytest.fixture
def env(tmp_path, monkeypatch):
    ev = install_fake_endstone()
    sys.path.insert(0, str(ROOT / "src"))
    for m in [m for m in sys.modules if m.startswith("endstone_arcade_extras")]:
        del sys.modules[m]
    from endstone_arcade_extras import ArcadeExtras

    monkeypatch.chdir(tmp_path)
    kid = FakePlayer("Cool Kid", "2535000000000001")
    plugin = ArcadeExtras()
    plugin.server = FakeServer([kid])
    plugin.on_enable()
    return types.SimpleNamespace(ev=ev, plugin=plugin, kid=kid, home=tmp_path / "arcade")


def join(env, player):
    env.plugin.on_join(env.ev.PlayerJoinEvent(player))
    env.plugin.server.scheduler.run_all()


def test_defaults_written(env):
    assert (env.home / "welcome.json").exists() and (env.home / "plots.json").exists()


def test_first_join_full_welcome(env):
    join(env, env.kid)
    cmds = env.plugin.server.commands
    assert any(c.startswith('give "Cool Kid" stone_sword 1') for c in cmds)
    assert any(c.startswith("summon fireworks_rocket") for c in cmds)
    assert env.kid.titles == [("Welcome to Cousin Town!", "Glad you're here, Cool Kid")]
    assert not any(c.startswith("tp ") for c in cmds)  # landing off and no plot by default


def test_second_join_is_a_short_greeting(env):
    join(env, env.kid)
    env.plugin.server.commands.clear()
    env.kid.messages.clear()
    join(env, env.kid)
    assert env.plugin.server.commands == []
    assert env.kid.messages == ["§bWelcome back to Cousin Town, Cool Kid!"]


def test_personal_plot_wins_over_landing(env):
    w = json.loads((env.home / "welcome.json").read_text())
    w["town_name"] = "Fishtown"
    w["first_join"]["landing"] = {"enabled": True, "x": 0, "y": 64, "z": 0}
    (env.home / "welcome.json").write_text(json.dumps(w))
    (env.home / "plots.json").write_text(json.dumps({"cool kid": {"x": 50, "y": 70, "z": 60}}))
    join(env, env.kid)
    cmds = env.plugin.server.commands
    assert 'tp "Cool Kid" 50 70 60' in cmds and 'spawnpoint "Cool Kid" 50 70 60' in cmds
    assert env.kid.titles[0][0] == "Welcome to Fishtown!"


def test_landing_used_without_plot(env):
    w = json.loads((env.home / "welcome.json").read_text())
    w["first_join"]["landing"] = {"enabled": True, "x": 5, "y": 66, "z": 7}
    (env.home / "welcome.json").write_text(json.dumps(w))
    join(env, env.kid)
    assert 'tp "Cool Kid" 5 66 7' in env.plugin.server.commands


def test_bad_kit_entries_ignored_and_bad_json_survives(env):
    w = json.loads((env.home / "welcome.json").read_text())
    w["first_join"]["starter_kit"] = [{"item": "bread; op @a", "count": 1}, {"item": "apple", "count": 999},
                                      {"item": "minecraft:apple", "count": 5}]
    (env.home / "welcome.json").write_text(json.dumps(w))
    join(env, env.kid)
    gives = [c for c in env.plugin.server.commands if c.startswith("give")]
    assert gives == ['give "Cool Kid" minecraft:apple 5']
    (env.home / "welcome.json").write_text("{broken")
    other = FakePlayer("Other", "2535000000000002")
    env.plugin.server.online_players.append(other)
    join(env, other)
    assert other.titles  # defaults used
