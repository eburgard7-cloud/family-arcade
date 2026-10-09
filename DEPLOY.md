# Deploy: the short version

Follow this top to bottom. Every command is **one line**: paste it into the Unraid terminal and press Enter. After each step there's a **Check**. Don't move on until it passes.

For the reasons behind each step, or when something breaks, see `ARCADE_SETUP.md` (the phase numbers are in brackets).

| When | What | Time |
|---|---|---|
| Tonight | Part 1: Minecraft server + lobby page live (just you) | ~90 min |
| This weekend | Part 2: safety tests + welcome town | 2 evenings |
| By Thu Oct 15 | Part 3: invite the family | 20 min |
| Before Fri Oct 23 | Part 4: game room for Kart night | one long evening |

---

## Status Oct 9: launching in chat-off mode

Endstone (the plugin layer that runs Chat Guard) crashes on startup on this server: segfault in `libendstone_runtime.so` on Unraid kernel 6.18 with an i7-8700, in versions 0.11.12 and 0.11.13. The plain Bedrock server runs fine. So the world launches on the **chat-off server**: same seed, guest list and world rules, but **nobody can chat**. The welcome plugin (title, fireworks, starter kit) doesn't run in this mode either; new players spawn at the world spawn.

**Use this instead of steps 4–7 below:**
```
bash /mnt/user/appdata/arcade/scripts/mc-fallback.sh on
```
```
docker logs -f mc-vanilla
```
Wait for `Server started.`, then press Ctrl+C. Then do step 6 (`mc-first-run.sh`, then `mc-allow.sh add`) and step 7 (join, then `op`). All of these scripts work in this mode. Steps 8 and 9 are unchanged.

**Step 10 changes:**
- Skip the moderator tests.
- Instead, type `hello` in chat. It should **not** appear.

**Welcome town:** make the town square the spawn point. Stand there, note your coordinates, then run:
```
bash /mnt/user/appdata/arcade/scripts/mc-cmd.sh "setworldspawn X Y Z"
```

**Updates and add-ons:**
- After the one-time GitHub setup in `README.md`, every update is one click: User Scripts → `arcade-update`.
- For add-ons, copy the `.mcpack`/`.mcaddon` files to `\\192.168.0.128\data\minecraft-packs`, then User Scripts → `mc-packs`.

**Once Endstone works here:** run `mc-fallback.sh off`. It moves the world back onto Endstone and turns on moderated chat. The bug report to send Endstone is in `endstone-bug-report.md`.

**Parents' message:** replace the chat bullet with: "Text chat is turned off. Kids can build and play together, but nobody can type messages."

---

## Part 1: Tonight

### 1. Check the seed (5 min, on your PC)
chunkbase.com → **Seed Map** → edition **Bedrock** → seed `-2746961253358476370`. Look at the spawn marker. Is the ground near spawn decent (not ocean or a cliff)?
- **Yes:** write down a town-square spot (x, z) near spawn, then continue.
- **No:** pick another seed now and change `level-seed` in `minecraft-seed/server.properties`. Once the world exists, the seed can't change.

### 2. Copy the bundle to Unraid [Phase 0]
Copy `arcade-bundle.tar.gz` to `\\192.168.0.128\data` from your PC. Then in the Unraid terminal (top-right `>_` icon):
```
mkdir -p /mnt/user/appdata/arcade && tar -xzf /mnt/user/data/arcade-bundle.tar.gz -C /mnt/user/appdata/arcade --strip-components=1
```
```
chmod +x /mnt/user/appdata/arcade/scripts/*.sh && cp /mnt/user/appdata/arcade/.env.example /mnt/user/appdata/arcade/.env
```
```
docker compose version
```
**Check:** the last command prints a version. If it says "not found": Apps → install **Docker Compose Manager**, then run it again. Also install **User Scripts** from Apps if you don't have it.

### 3. DNS + router [Phase 1]
**Cloudflare** → finsonly.net → DNS → add two records. Both are type A, content `73.25.188.186`, and **grey cloud (DNS only)**:
- `mc`
- `play`

**TP-Link router** → NAT Forwarding → Virtual Servers → Add: external port `19132`, internal IP `192.168.0.128`, internal port `19132`, protocol **UDP**.

**Check:**
```
nslookup mc.finsonly.net 1.1.1.1
```
It shows `73.25.188.186`.

### 4. Start Minecraft [Phase 2.1–2.3]
```
mkdir -p /mnt/user/appdata/arcade/minecraft/plugins /mnt/user/appdata/arcade/state
```
```
cp /mnt/user/appdata/arcade/minecraft-seed/server.properties /mnt/user/appdata/arcade/minecraft/ && cp /mnt/user/appdata/arcade/minecraft-seed/plugins/*.whl /mnt/user/appdata/arcade/minecraft/plugins/
```
```
cd /mnt/user/appdata/arcade && docker compose up -d mc-bedrock && docker logs -f mc-bedrock
```
Wait 1–3 minutes while it downloads. **Check:** you see all three lines below. Then press **Ctrl+C**, which closes the log; the server keeps running.
- `Chat Guard 0.1.0 enabled`
- `Arcade Extras 0.1.0 enabled`
- `Server started.`

**If Chat Guard is missing or there's a red Python error, stop here and send me the log.** This is the first time these plugins run on a real server.

### 5. Clean-shutdown test [Phase 2.4]
```
docker stop mc-bedrock && docker logs --tail 15 mc-bedrock
```
**Check:** the last lines show it stopping or saving (`Stopping server...`, `Quit correctly`), not just ending. Then start it again:
```
cd /mnt/user/appdata/arcade && docker compose up -d mc-bedrock
```

### 6. World rules + add yourself [Phase 2.5–2.6]
Replace `YourGamertag` with your Xbox gamertag. Keep the quotes.
```
bash /mnt/user/appdata/arcade/scripts/mc-first-run.sh
```
```
bash /mnt/user/appdata/arcade/scripts/mc-allow.sh add "YourGamertag"
```
**Check:** the first command reports each gamerule as updated. If it says cheats are off, see Phase 2.5 in the full guide.

### 7. Join from your Switch 2 at home [Phase 2.7]
Minecraft → Play → **Friends** tab → *Finsonly Family Server* under LAN Games → join.

**Check:** you're in, and you see the moderator welcome message. While you're still in the world, make yourself the operator:
```
bash /mnt/user/appdata/arcade/scripts/mc-cmd.sh 'op "YourGamertag"'
```

### 8. Lobby page [Phase 4]
```
cd /mnt/user/appdata/arcade && docker compose up -d --build lobby
```
**Check** (wait 30 s): the command below shows `(healthy)`.
```
docker ps --filter name=arcade-lobby --format '{{.Names}} {{.Status}}'
```

Now make the map password hash. Pick a family password; this prints a long string starting with `$2a$`:
```
docker exec caddy caddy hash-password --plaintext 'pick-a-family-password'
```
Open your Caddyfile:
```
nano /mnt/user/appdata/stack/caddy/Caddyfile
```
1. Go to the bottom and paste everything from `caddy/play.Caddyfile`, starting at `play.finsonly.net {`.
2. Replace `PASTE_HASH_HERE` with the hash. **Caddy won't reload while the placeholder is still there.**
3. Copy the geoblock and crowdsec lines from your jellyfin block into the marked spot.
4. Save and exit: Ctrl+O, Enter, Ctrl+X.

Then reload Caddy:
```
docker exec caddy caddy reload --config /etc/caddy/Caddyfile
```
**Check:** on your phone with **Wi-Fi off**, open `https://play.finsonly.net`. The lights sweep on, Minecraft shows Open, and the Game room shows Closed with Kart night on Oct 23.

If the reload complains about `basic_auth`, change it to `basicauth`. If the page won't load, run this, then reload again:
```
docker network connect proxy caddy && docker restart caddy
```

### 9. Nightly backups + moderator watchdog [Phase 3]
In Unraid, go to **Settings → User Scripts → Add New Script**. Make two scripts; each body is one line.

| Name | Body | Schedule (Custom) |
|---|---|---|
| `mc-nightly` | `bash /mnt/user/appdata/arcade/scripts/mc-nightly.sh` | `0 4 * * *` |
| `mc-moderation` | `bash /mnt/user/appdata/arcade/scripts/mc-moderation.sh` | `* * * * *` |

Click **Run Script** on `mc-nightly` once. The server restarts, which takes about 2 minutes. Then:
```
ls -lh /mnt/user/backups/minecraft/ && cat /mnt/user/appdata/arcade/state/minecraft.json
```
**Check:** there's a `world_….tar.gz` backup, and the status file says `"chat":"moderated"`.

Phone alerts: **Settings → Notification Settings**. Pick an agent (Pushover, ntfy, Telegram, …) so the watchdog can reach you.

**Part 1 is done.** The server and lobby are live, but only you are on the guest list.

---

## Part 2: This weekend

### 10. Safety tests [Phase 2.8–2.10]
Don't invite kids until all of these pass.

**Remote join.**
1. Turn on your phone's hotspot and connect the Switch to it.
2. On the Switch, open that connection's settings → DNS → **Manual**: primary `104.238.130.180`, secondary `8.8.8.8`.
3. In Minecraft → Servers → any featured server → **Connect to a Server**: `mc.finsonly.net`, port `19132`.

**Child account.** Use a kid's Switch, or a child Nintendo account with parental controls on. It has to be able to join. If it can't: in the Parental Controls app, allow **Communication with Others** for Minecraft.

**Stranger refused.** An account that isn't on the guest list gets "You are not invited".

**Moderator tests.** These need a non-operator account. Either borrow one, or remove yourself as operator:
```
bash /mnt/user/appdata/arcade/scripts/mc-cmd.sh 'deop "YourGamertag"'
```
Then type each of these in chat:

| Type in chat | Expected |
|---|---|
| `hello` | shows up |
| a swear word | blocked: "That message wasn't sent…" |
| `call me 503-555-0100` | blocked as personal info |
| `/tell Eric hi` | "Private messages are off here…" |
| three mean messages in a row | "Your chat is off for 10 minutes" |

Undo the mute and make yourself operator again:
```
bash /mnt/user/appdata/arcade/scripts/mc-cmd.sh "unmute YourGamertag"
```
```
bash /mnt/user/appdata/arcade/scripts/mc-cmd.sh 'op "YourGamertag"'
```

**Restore drill.** Practice once while the world is empty. See Phase 3 → "Restore drill" in the full guide; it's 4 commands.

### 11. Welcome town [WELCOME_TOWN.md]
Build it in creative mode (one or two evenings). Then edit the welcome settings:
```
nano /mnt/user/appdata/arcade/minecraft/arcade/welcome.json
```
**Check:** a fresh account gets the title, fireworks and starter kit, and lands in the square (WELCOME_TOWN.md step 4).

### 12. Membership cards
Open `printables/printables.html` on your PC. Type one line per kid, then print at 100% on card stock with background graphics on.

---

## Part 3: Invite the family (by Thu Oct 15)
1. Send parents the message in `ARCADE_SETUP.md` → Phase 9 → "Message to send parents".
2. For each gamertag you get back:
   ```
   bash /mnt/user/appdata/arcade/scripts/mc-allow.sh add "Their Gamertag"
   ```
3. If a kid still gets "not invited", see Phase 9 → "Adding a kid".

---

## Part 4: Game room (before Kart night, Fri Oct 23)
This part is longer and partly at the server itself (BIOS). Follow `ARCADE_SETUP.md` in this order:
1. **Phase 5:** Windows VM with the GTX 970. Set aside 2–3 hours; this is where problems are most likely.
2. **Phase 6:** Parsec + ES-DE, then test N64 and GameCube with 2 controllers.
3. **Phase 7:** the open/close scripts.
4. **Phase 8:** the Discord server + webhooks.

Do a test night with one friend by Wed Oct 21. If the VM fights you, Kart night can still happen on Minecraft. Just change the title in `lobby-config/config.json`.

---

## If something goes wrong

| Problem | Do this |
|---|---|
| Kids see "Outdated server" (their Switch updated first; likely around the Oct 27 Switch 2 release) | `bash /mnt/user/appdata/arcade/scripts/mc-fallback.sh on`: same world, chat off. Run it with `off` when Endstone catches up. |
| Alert: "Minecraft stopped: chat moderator down" | `docker logs --tail 50 mc-bedrock` → send me the output |
| Lobby shows old info after you edit `config.json` | `docker exec arcade-lobby python3 -m json.tool /config/config.json >/dev/null && echo valid`. If it isn't valid, there's a typo (usually a missing comma). |
| Want to see the chat log | `ls /mnt/user/appdata/arcade/minecraft/moderation/logs/` |
| Anything else | Copy the last 30 log lines and the command you ran, and send them to me |
