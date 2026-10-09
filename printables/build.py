"""Rebuilds printables.html from printables.src.html (inlines fonts, pattern and QR).
Run from the arcade folder: python3 printables/build.py"""
import base64, re
from pathlib import Path

root = Path(__file__).resolve().parents[1]
src = (root / "printables" / "printables.src.html").read_text(encoding="utf-8")
fonts = root / "lobby" / "public" / "fonts"
css = (root / "lobby" / "public" / "app.css").read_text(encoding="utf-8")
carpet = re.search(r'--carpet-tile: url\("data:image/svg\+xml,(.*?)"\);', css).group(1)
qr = (root / "printables" / "qr-play-finsonly-net.svg").read_text(encoding="utf-8")
b64 = lambda p: base64.b64encode(p.read_bytes()).decode()
out = (src.replace("__BUNGEE__", b64(fonts / "bungee.woff2"))
          .replace("__BUNGEE_INLINE__", b64(fonts / "bungee-inline.woff2"))
          .replace("__LEXEND__", b64(fonts / "lexend.woff2"))
          .replace("__CARPET__", carpet)
          .replace("__QR__", qr))
(root / "printables" / "printables.html").write_text(out, encoding="utf-8")
print("wrote printables/printables.html", len(out) // 1024, "KB")
