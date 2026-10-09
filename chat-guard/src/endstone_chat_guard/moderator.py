"""Chat moderation rules. Pure Python, no Endstone imports, so it can be tested
on its own. The Endstone plugin (plugin.py) feeds messages in and acts on the
verdicts that come out.
"""

from __future__ import annotations

import re
import time
from collections import defaultdict, deque
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_SETTINGS = {
    "ops_bypass": True,             # operators (Eric) are not filtered or muted
    "strikes_to_mute": 3,           # strikes inside the window that trigger a mute
    "strike_window_minutes": 15,
    "mute_minutes": 10,
    "block_private_messages": True, # /tell, /msg, /w
    "block_signs": False,           # True stops non-operators placing signs (sign text can't be filtered)
    "log_retention_days": 30,
    "flood_messages": 4,            # more than this many messages...
    "flood_seconds": 6,             # ...inside this many seconds is blocked
    "repeat_limit": 3,              # same message this many times in 30 s is blocked
    "welcome_message": "Chat here is checked by a moderator bot. Be kind, and keep private things private.",
}

LEET = str.maketrans({"0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t",
                      "8": "b", "@": "a", "$": "s", "!": "i", "|": "i", "+": "t", "€": "e"})

# Suffixes that make a blocked word into another form of the same word
# (shit -> shitty, shithead) without matching unrelated words (cocktail, analysis).
SUFFIXES = {"", "s", "es", "ies", "ty", "er", "ers", "ed", "ing", "in", "ting",
            "head", "heads", "face", "faces", "hole", "holes", "bag", "bags", "wad", "wit", "ass"}

NUMBER_WORDS = {"zero", "oh", "o", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"}

EMAIL_RE = re.compile(r"[\w.+-]+\s*(@|\(at\)|\[at\])\s*[\w-]+\s*(\.|\(dot\)|\[dot\])\s*[a-z]{2,}", re.I)
URL_RE = re.compile(
    r"(https?://|www\.|\b[\w-]+\s*(\.|\(dot\))\s*(com|net|org|gg|io|tv|me|co|us|ly|app|xyz|link|live|info|biz|gl)\b)",
    re.I)
PHONE_STRICT_RE = re.compile(r"(?<![\d-])(\+?1[\s.-]?)?(\(\d{3}\)\s*|\d{3}[.-])\d{3}[.-]\d{4}(?!\d)")
PHONE_SPACED_RE = re.compile(r"(?<![\d-])(\+?1\s)?\d{3}\s\d{3}\s\d{4}(?!\d)")
PHONE_SHORT_RE = re.compile(r"(?<![\d-])\d{3}[.-]\d{4}(?!\d)")
LONG_DIGITS_RE = re.compile(r"\d{10,}")
ADDRESS_RE = re.compile(
    r"\b\d{1,5}\s+(?:[a-z]+\.?\s+){1,3}(street|st|avenue|ave|road|rd|drive|lane|ln|court|boulevard|blvd|"
    r"circle|cir|terrace|parkway|pkwy|highway|hwy)\b\.?", re.I)
HANDLE_RE = re.compile(r"(?<![\w.])@[a-z0-9_.]{3,}", re.I)
COORD_HINT_RE = re.compile(r"\b(x|y|z|xyz|coords?|coordinates?)\b", re.I)

PII_QUESTIONS = [
    "where do you live", "where do u live", "where u live", "where you live", "wher do you live",
    "what school", "which school", "wat school",
    "your address", "ur address", "my address",
    "phone number", "your number", "ur number", "my number is",
    "last name", "your surname",
]
PLATFORMS = ["discord", "snapchat", "snap", "insta", "instagram", "tiktok", "whatsapp", "kik",
             "telegram", "facetime", "youtube", "twitch"]
PLATFORM_ACTIONS = ["add me", "follow me", "dm me", "message me", "msg me", "call me", "text me",
                    "my username", "my user", "my name on", "subscribe", "sub to", "join my", "friend me"]


@dataclass
class Verdict:
    allowed: bool
    category: str = "ok"            # ok, severe, profanity, personal_info, link, social, unkind, mild, flood, repeat, muted
    reply: str = ""                 # private note shown to the sender
    message: str | None = None      # replacement text when allowed (e.g. caps lowered)
    strike: bool = False
    mute_now: bool = False
    flag: bool = False              # tell Eric
    flag_detail: str = ""           # safe to send off-box (never contains personal info)


@dataclass
class PlayerState:
    recent: deque = field(default_factory=lambda: deque(maxlen=20))     # (time, normalized text)
    strikes: deque = field(default_factory=lambda: deque(maxlen=20))    # times


def load_list(path: Path) -> list[str]:
    if not path.exists():
        return []
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip().lower()
        if line and not line.startswith("#"):
            out.append(line)
    return out


class WordList:
    """Single words matched per token (with leet-speak, repeats, suffixes);
    phrases matched against the normalized sentence."""

    def __init__(self, entries: list[str], allowed: set[str]):
        self.words: set[str] = set()
        self.phrases: list[str] = []
        self.allowed = allowed
        for e in entries:
            e = " ".join(re.findall(r"[a-z]+", e.translate(LEET)))
            if not e:
                continue
            if " " in e:
                self.phrases.append(e)
            else:
                self.words.add(e)
        self.long_words = [w for w in self.words if len(w) >= 6]

    def _token_hit(self, tok: str) -> str | None:
        if tok in self.allowed or any(len(a) >= 6 and tok.endswith(a) for a in self.allowed):
            return None
        variants = {tok}
        if re.search(r"(.)\1{2,}", tok):  # stretched spelling like "fuuuck": also try squeezed forms
            variants |= {re.sub(r"(.)\1{2,}", r"\1\1", tok), re.sub(r"(.)\1+", r"\1", tok)}
        for variant in variants:
            if variant in self.allowed:
                continue
            if variant in self.words:
                return variant
            for i in range(min(len(variant), 12), 2, -1):
                stem, rest = variant[:i], variant[i:]
                if stem in self.words and rest in SUFFIXES:
                    return stem
            for w in self.long_words:  # compounds like "motherfucker": blocked word at the start or end
                if variant.startswith(w) or variant.endswith(w):
                    return w
        return None

    def find(self, tokens: list[str], sentence: str) -> str | None:
        for tok in tokens:
            hit = self._token_hit(tok)
            if hit:
                return hit
        # s p a c e d  o u t  or s.p.l.i.t letters: join runs of single letters
        run: list[str] = []
        for tok in tokens + [""]:
            if len(tok) == 1:
                run.append(tok)
                continue
            if len(run) >= 3:
                joined = "".join(run)
                for w in self.words:
                    if len(w) >= 3 and w in joined:
                        return w
            run = []
        padded = f" {sentence} "
        for p in self.phrases:
            if f" {p} " in padded:
                return p
        squashed = sentence.replace(" ", "")
        for p in self.phrases:
            if len(p) >= 8 and p.replace(" ", "") in squashed:
                return p
        return None


def normalize(message: str) -> tuple[list[str], str]:
    text = re.sub(r"§.", "", message).lower().translate(LEET)
    tokens = re.findall(r"[a-z]+", text)
    return tokens, " ".join(tokens)


class Moderator:
    def __init__(self, settings: dict | None = None, lists_dir: Path | None = None):
        self.settings = {**DEFAULT_SETTINGS, **(settings or {})}
        self.players: dict[str, PlayerState] = defaultdict(PlayerState)
        self.mutes: dict[str, float] = {}   # player key -> unmute time (epoch)
        self.lists_dir = lists_dir
        self.reload_lists()

    # ---------- lists ----------

    def reload_lists(self) -> None:
        d = self.lists_dir
        get = (lambda n: load_list(d / n)) if d else (lambda n: [])
        allowed = set(get("allowed.txt"))
        self.severe = WordList(get("severe.txt"), allowed)
        mild = get("mild.txt")
        unkind = get("unkind.txt")
        # A word listed as mild or unkind is handled at that level, even if the big list also has it.
        softer = set(mild) | set(unkind)
        profanity = [w for w in get("profanity.txt") + get("extra_blocked.txt") if w not in softer]
        self.profanity = WordList(profanity, allowed)
        self.unkind = WordList(unkind, allowed)
        self.mild = WordList(mild, allowed)

    # ---------- mutes ----------

    def mute(self, key: str, minutes: float, now: float | None = None) -> float:
        until = (now or time.time()) + minutes * 60
        self.mutes[key] = until
        return until

    def unmute(self, key: str) -> bool:
        self.players[key].strikes.clear()
        return self.mutes.pop(key, None) is not None

    def muted_minutes_left(self, key: str, now: float | None = None) -> int:
        until = self.mutes.get(key)
        now = now or time.time()
        if not until or until <= now:
            self.mutes.pop(key, None)
            return 0
        return max(1, round((until - now) / 60))

    # ---------- the check ----------

    def check(self, key: str, message: str, now: float | None = None) -> Verdict:
        now = now or time.time()
        s = self.settings
        state = self.players[key]

        left = self.muted_minutes_left(key, now)
        if left:
            return Verdict(False, "muted", f"Your chat is off for {left} more minute{'s' if left != 1 else ''}. You can still play.")

        tokens, sentence = normalize(message)
        raw = message.lower()

        hit = self.severe.find(tokens, sentence)
        if hit:
            return Verdict(False, "severe", "That message wasn't sent. That's never okay to say here.",
                           strike=True, mute_now=True, flag=True,
                           flag_detail=f"used a severe phrase ('{hit}')")

        hit = self.profanity.find(tokens, sentence)
        if hit:
            return Verdict(False, "profanity", "That message wasn't sent because it has a word that isn't allowed here.",
                           strike=True, flag=True, flag_detail=f"used a blocked word ('{hit}')")

        pii = self._personal_info(message, raw, tokens, sentence)
        if pii:
            kind, reply = pii
            return Verdict(False, "personal_info", reply, flag=True,
                           flag_detail=f"tried to share or ask for personal info ({kind}); message not stored in this alert")

        if URL_RE.search(message):
            return Verdict(False, "link", "That message wasn't sent. Links aren't allowed in chat.")

        if self._social(sentence):
            return Verdict(False, "social", "That message wasn't sent. Let's keep chatting here in the game.",
                           flag=True, flag_detail="tried to move the chat to another app")

        hit = self.unkind.find(tokens, sentence)
        if hit:
            return Verdict(False, "unkind", "That message wasn't sent. Let's keep it kind.", strike=True)

        hit = self.mild.find(tokens, sentence)
        if hit:
            return Verdict(False, "mild", "That message wasn't sent. Try saying it another way.")

        recent = [t for t, _ in state.recent if now - t <= s["flood_seconds"]]
        if len(recent) >= s["flood_messages"]:
            return Verdict(False, "flood", "Slow down a little, then try again.")
        same = [m for t, m in state.recent if now - t <= 30 and m == sentence]
        if sentence and len(same) >= s["repeat_limit"] - 1:
            return Verdict(False, "repeat", "You already said that.")
        state.recent.append((now, sentence))

        letters = [c for c in message if c.isalpha()]
        if len(letters) >= 12 and sum(c.isupper() for c in letters) / len(letters) >= 0.8:
            return Verdict(True, "ok", message=message.lower())
        return Verdict(True)

    def record_strike(self, key: str, now: float | None = None) -> tuple[int, bool]:
        """Returns (strikes in window, muted_now)."""
        now = now or time.time()
        s = self.settings
        st = self.players[key].strikes
        st.append(now)
        window = s["strike_window_minutes"] * 60
        count = sum(1 for t in st if now - t <= window)
        if count >= s["strikes_to_mute"]:
            st.clear()
            self.mute(key, s["mute_minutes"], now)
            return count, True
        return count, False

    # ---------- detectors ----------

    def _personal_info(self, message, raw, tokens, sentence):
        info = "Keep private things private: no addresses, phone numbers, emails or schools."
        if EMAIL_RE.search(message):
            return "email", f"That message wasn't sent. {info}"
        if PHONE_STRICT_RE.search(message) or LONG_DIGITS_RE.search(message) or PHONE_SHORT_RE.search(message):
            return "phone number", f"That message wasn't sent. {info}"
        if PHONE_SPACED_RE.search(message) and not COORD_HINT_RE.search(message):
            return "phone number", ("That message wasn't sent. It looked like a phone number. "
                                    "If those are coordinates, put x, y and z in front of them.")
        run = 0
        for tok in tokens:
            run = run + 1 if tok in NUMBER_WORDS else 0
            if run >= 7:
                return "phone number", f"That message wasn't sent. {info}"
        if ADDRESS_RE.search(message):
            return "address", f"That message wasn't sent. {info}"
        if HANDLE_RE.search(message):
            return "social handle", f"That message wasn't sent. {info}"
        padded = f" {sentence} "
        for q in PII_QUESTIONS:
            if f" {q}" in padded:
                return "personal question", f"That message wasn't sent. {info}"
        return None

    def _social(self, sentence: str) -> bool:
        padded = f" {sentence} "
        if not any(f" {p} " in padded for p in PLATFORMS):
            return False
        return any(f" {a} " in padded or f" {a}" in padded for a in PLATFORM_ACTIONS)
