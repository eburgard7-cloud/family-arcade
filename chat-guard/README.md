# endstone-chat-guard

Chat moderator plugin for the family Bedrock server (Endstone). The built wheel ships in `../minecraft-seed/plugins/`.

- Rules: `src/endstone_chat_guard/moderator.py` (pure Python, tested in `tests/`)
- Endstone glue: `src/endstone_chat_guard/plugin.py`
- Default word lists: `src/endstone_chat_guard/wordlists/` (copied to `/data/moderation/wordlists/` on first start; edit those copies, then send `reload-moderation`)

Rebuild after changes: `pipx run build --wheel` (or `python3 -m build --wheel`), copy `dist/*.whl` to the server's `plugins/` folder, restart.

The profanity list is the LDNOOBW English list (CC BY 4.0), see `wordlists/LICENSE-LDNOOBW.txt`.
