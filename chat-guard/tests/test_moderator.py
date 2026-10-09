import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
import importlib.util  # noqa: E402

# Load moderator.py on its own: it has no Endstone imports.
_spec = importlib.util.spec_from_file_location("cg_moderator", ROOT / "src" / "endstone_chat_guard" / "moderator.py")
_mod = importlib.util.module_from_spec(_spec)
sys.modules["cg_moderator"] = _mod
_spec.loader.exec_module(_mod)
Moderator = _mod.Moderator

LISTS = ROOT / "src" / "endstone_chat_guard" / "wordlists"


def mod():
    return Moderator(lists_dir=LISTS)


SHOULD_PASS = [
    "hi everyone",
    "come to my base",
    "hello",
    "i found diamonds at x 120 y 12 z -340",
    "x300 y100 z1200",
    "coords 300 100 1200",
    "go 200 blocks that way",
    "lets build a shell house",
    "my therapist cat lol",
    "the peacock is cool",
    "classic minecraft",
    "assassin creeper",
    "i have 64 iron",
    "my roblox house is cool",
    "i watched a youtube video about redstone",
    "nice job!!",
    "pass me the bucket",
    "we need glass and grass",
    "that's a big hill",
    "good game",
]

SHOULD_BLOCK = {
    "this is shit": "profanity",
    "sh1t": "profanity",
    "shiiiiit": "profanity",
    "shitty base": "profanity",
    "f u c k": "profanity",
    "f.u.c.k": "profanity",
    "fuuuuck": "profanity",
    "what the hell": "mild",
    "this is crap": "mild",
    "you're stupid": "unkind",
    "shut up": "unkind",
    "kys": "severe",
    "go kill yourself": "severe",
    "call me 503-555-1234": "personal_info",
    "(503) 555-1234": "personal_info",
    "5035551234": "personal_info",
    "503 555 1234": "personal_info",
    "five oh three five five five one two three four": "personal_info",
    "my email is kid@example.com": "personal_info",
    "kid (at) example (dot) com": "personal_info",
    "i live at 123 maple street": "personal_info",
    "1234 NE Oak Ave": "personal_info",
    "where do you live": "personal_info",
    "what school do you go to": "personal_info",
    "follow @coolkid99": "personal_info",
    "check out www.example.com": "link",
    "https://example.com": "link",
    "join discord.gg/abc": "link",
    "add me on snapchat": "social",
    "whats your discord add me": "social",
}


def test_pass():
    m = mod()
    failures = []
    for i, msg in enumerate(SHOULD_PASS):
        v = m.check(f"p{i}", msg, now=1000 + i)
        if not v.allowed:
            failures.append((msg, v.category))
    assert not failures, failures


def test_block():
    m = mod()
    failures = []
    for i, (msg, cat) in enumerate(SHOULD_BLOCK.items()):
        v = m.check(f"b{i}", msg, now=1000 + i)
        if v.allowed or v.category != cat:
            failures.append((msg, cat, v.category))
    assert not failures, failures


def test_pii_alert_never_contains_message():
    m = mod()
    v = m.check("a", "i live at 123 maple street", now=1)
    assert v.flag and "maple" not in v.flag_detail and "123" not in v.flag_detail


def test_caps_lowered_not_blocked():
    m = mod()
    v = m.check("c", "LOOK AT MY HOUSE EVERYONE", now=1)
    assert v.allowed and v.message == "look at my house everyone"


def test_strikes_then_mute():
    m = mod()
    for i in range(2):
        v = m.check("s", "you're stupid", now=100 + i)
        assert v.strike
        count, muted = m.record_strike("s", now=100 + i)
        assert not muted
    count, muted = m.record_strike("s", now=103)
    assert muted and count == 3
    v = m.check("s", "hello", now=110)
    assert not v.allowed and v.category == "muted"
    v = m.check("s", "hello", now=103 + 10 * 60 + 1)
    assert v.allowed


def test_strikes_expire():
    m = mod()
    m.record_strike("e", now=0)
    m.record_strike("e", now=60)
    _, muted = m.record_strike("e", now=60 * 30)
    assert not muted


def test_flood_and_repeat():
    m = mod()
    for i in range(4):
        assert m.check("f", f"msg {chr(97 + i)}", now=10 + i * 0.5).allowed
    assert m.check("f", "another", now=12).category == "flood"
    m2 = mod()
    assert m2.check("r", "hi", now=1).allowed
    assert m2.check("r", "hi", now=10).allowed
    assert m2.check("r", "hi", now=20).category == "repeat"


def test_unmute():
    m = mod()
    m.mute("u", 10, now=0)
    assert m.check("u", "hi", now=5).category == "muted"
    assert m.unmute("u")
    assert m.check("u", "hi", now=6).allowed
