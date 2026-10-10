# Family Arcade — Unraid Setup Runbook

**Builds:** the kids' private Bedrock world (Switch/Switch 2 first) with a chat moderator (Endstone + Chat Guard) + public lobby at `play.finsonly.net` + the adults' game room: an on-demand Windows "Arcade" VM (GTX 970 passthrough, ES-DE over RetroArch/Dolphin/PCSX2/DuckStation/Flycast, streamed with Parsec) with Discord voice.
**Host:** Unraid 7.3.2 @ 192.168.0.128 · public IP 73.25.188.186 · existing Caddy stack on the `proxy` network.
**Rule:** finish and verify each phase before starting the next. Phases 1–4 are independent of the VM and can go live on their own.

| Phase | What | Where to do it | Time |
|---|---|---|---|
| 0 | Copy bundle, prerequisites | Desktop + Unraid terminal | 15 min |
| 1 | DNS + port forward | Cloudflare + router | 10 min |
| 2 | Minecraft server + chat moderator | Unraid terminal | 45 min |
| 3 | Nightly backup/update + moderator watchdog | User Scripts | 15 min |
| 4 | Lobby page | Unraid terminal + Caddyfile | 20 min |
| 5 | Arcade VM (VFIO + Windows) | BIOS + Unraid GUI, **desktop** | 2–3 hr |
| 6 | Game room: Parsec + ES-DE + launch set (N64, GameCube, PS2) | VM over VNC/Parsec | 2 hr |
| 7 | Open/close + lobby status | User Scripts | 10 min |
| 8 | Discord for the adults (voice + alerts) | Discord + `.env` | 20 min |
| 9 | Family onboarding + go-live tests | Phone | — |
| 10 | More systems (PS1, Wii, SNES), one at a time; Wii U + Dreamcast deferred | VM | 30–60 min each |
| 11 | Welcome town, world map, printables, events, maintenance banner | In-game + Unraid + PC | 2 evenings + 30 min |

Design decisions: **Endstone** (the official Bedrock server plus a plugin layer) runs Minecraft, because it's the only stable way to moderate Bedrock chat; the plain itzg Bedrock image stays as a chat-off fallback. **Discord is adults-only** (the kids are under 13); kids get Minecraft with moderated text chat and no voice.

---

## Bundle layout → server paths

Everything lives in `/mnt/user/appdata/arcade/`:

```
arcade/
├── DEPLOY.md                short step-by-step deploy (start here)
├── ARCADE_SETUP.md          this file
├── docker-compose.yml       mc-bedrock (Endstone, host net) + mc-vanilla (fallback) + arcade-lobby (proxy net)
├── .env.example             → copy to .env (Discord webhooks, alert settings)
├── minecraft-seed/          server.properties (seed set) + plugins/ (Chat Guard + Arcade Extras wheels)
├── chat-guard/              the moderator's source code and tests
├── lobby/                   Dockerfile, server.py, public/ (page, css, js, fonts)
├── lobby-config/config.json page content: announcement, game nights, systems, games, rules
├── scripts/                 mc-cmd, mc-allow, mc-first-run, mc-nightly, mc-moderation, mc-fallback, arcade-*
├── arcade-extras/          the welcome plugin's source code and tests
├── printables/             printables.html (membership cards + champion certificate), build.py
├── WELCOME_TOWN.md          build guide for the welcome town
├── caddy/play.Caddyfile     block to paste into the existing Caddyfile (includes the map password)
├── minecraft/               (created) server, world, allowlist.json, plugins/, moderation/
├── map/                     (created) world map from scripts/mc-map.sh
└── state/                   (created) arcade.json, minecraft.json, maintenance.json, map.json for the lobby
```

Backups go to `/mnt/user/backups/minecraft/` (array, parity-protected).

---

## Phase 0 — Copy the bundle + prerequisites

1. On desktop, copy `arcade-bundle.tar.gz` into any SMB share you can reach, e.g. `\\192.168.0.128\data`.
2. Unraid terminal:
   ```
   mkdir -p /mnt/user/appdata/arcade && tar -xzf /mnt/user/data/arcade-bundle.tar.gz -C /mnt/user/appdata/arcade --strip-components=1
   ```
   ```
   ls -la /mnt/user/appdata/arcade
   ```
   **Verify:** you see `docker-compose.yml`, `minecraft-seed/`, `lobby/`, `lobby-config/`, `scripts/`, `caddy/`.
3. Compose CLI: the Compose Manager plugin didn't survive the 8/22 reboot. Reinstall it from **Apps → "Docker Compose Manager"**, then:
   ```
   docker compose version
   ```
4. Plugins needed: **User Scripts** (Apps). Already have: Tailscale, NUT, Unassigned Devices.
5. Make scripts executable:
   ```
   chmod +x /mnt/user/appdata/arcade/scripts/*.sh
   ```

> Terminal paste gotcha (stray trailing character): every command below is one line. Run the verify command after each step.

---

## Phase 1 — DNS + port forward

**Cloudflare DNS** (finsonly.net), same pattern as jellyfin/dash/auth:

| Type | Name | Content | Proxy |
|---|---|---|---|
| A | `mc` | 73.25.188.186 | **DNS only (grey)** — UDP can't go through the CF proxy |
| A | `play` | 73.25.188.186 | DNS only (grey) — Caddy + DNS-01 handles TLS |

Do **not** add AAAA records. Bedrock clients don't fall back from IPv6, and IPv6 is off on your router anyway. If something updates your existing A records when the Xfinity IP changes, add `mc` and `play` to it.

**TP-Link router** → NAT Forwarding → Virtual Servers → Add:

| Service | External port | Internal IP | Internal port | Protocol |
|---|---|---|---|---|
| Minecraft | 19132 | 192.168.0.128 | 19132 | **UDP** |

Nothing for the lobby — it rides the existing 443 → Caddy forward. Nothing for Parsec — it does its own NAT traversal.

**Optional, recommended:** Pi-hole → Local DNS → DNS Records: `mc.finsonly.net → 192.168.0.128` and `play.finsonly.net → 192.168.0.128`. Makes both names work inside your house even if the router has no NAT loopback.

**Verify:** `nslookup mc.finsonly.net 1.1.1.1` returns 73.25.188.186.

---

## Phase 2 — Minecraft server (Endstone + Chat Guard)

**Why Endstone:** plain Bedrock has no chat filter. Bedrock's own scripting hook for chat is still marked pre-release by Microsoft, so it can change or disappear in any update. That's not acceptable for a safety feature on a server that updates itself. **Endstone** runs the official Bedrock Dedicated Server with a plugin layer that has a stable, cancellable chat event. **Chat Guard** (in this bundle) is the plugin.

**Trade-off you're accepting:** each Endstone release supports one Bedrock version. A new Mojang update can reach the kids' consoles before Endstone supports it; Endstone has shipped updates every few weeks this year. If the kids' Switches update first, use the chat-off fallback described after the tests below. It never runs with unmoderated chat.

1. Seed the server folder (settings + plugin) **before** the first start:
   ```
   mkdir -p /mnt/user/appdata/arcade/minecraft/plugins /mnt/user/appdata/arcade/state
   ```
   ```
   cp /mnt/user/appdata/arcade/minecraft-seed/server.properties /mnt/user/appdata/arcade/minecraft/ && cp /mnt/user/appdata/arcade/minecraft-seed/plugins/*.whl /mnt/user/appdata/arcade/minecraft/plugins/
   ```
   Review `server.properties` now: survival, easy, 10 players, allow-list on, cheats off, members can build but can't op. **`level-name` and `level-seed` (set to `-2746961253358476370`) are permanent once the world generates.** Check the seed's spawn on chunkbase.com (Bedrock) first; see `WELCOME_TOWN.md` step 1.
2. Alert settings:
   ```
   cp /mnt/user/appdata/arcade/.env.example /mnt/user/appdata/arcade/.env && nano /mnt/user/appdata/arcade/.env
   ```
   Leave the Discord lines empty until Phase 8; Unraid notifications work right away.
3. Start the server:
   ```
   cd /mnt/user/appdata/arcade && docker compose up -d mc-bedrock
   ```
   ```
   docker logs -f mc-bedrock
   ```
   First start downloads Bedrock (a minute or two). **Verify all three** before going on, then Ctrl+C:
   - a line ending `Chat Guard 0.1.0 enabled. Files in /data/moderation`
   - `Server started.`
   - no Python traceback mentioning `endstone_chat_guard`
   If the plugin line is missing, stop here. The server must not be opened to kids without it.
4. **Clean-shutdown test** (protects the world from corruption on reboots and UPS events):
   ```
   docker stop mc-bedrock && docker logs --tail 15 mc-bedrock
   ```
   The last lines should show the server stopping and saving (e.g. `Stopping server...` / `Quit correctly`), not just ending abruptly. Then `docker compose up -d mc-bedrock`. If it ends abruptly, tell me what the log shows; the nightly script still stops it the safe way through Chat Guard, but Unraid's array stop wouldn't.
5. World rules (keep-inventory, no creeper/TNT/fire damage to builds, no PvP, coordinates on). Edit to drop any you don't want, then run:
   ```
   nano /mnt/user/appdata/arcade/scripts/mc-first-run.sh
   ```
   ```
   bash /mnt/user/appdata/arcade/scripts/mc-first-run.sh
   ```
   **Verify:** each gamerule reports as updated in the output. If it says cheats are off: set `allow-cheats=true` in `server.properties`, restart, rerun, set it back to `false`, restart. Gamerules stay in the world.
6. Guest list and your operator status:
   ```
   bash /mnt/user/appdata/arcade/scripts/mc-allow.sh add "YourGamertag"
   ```
   Join the world once, then (while you're online):
   ```
   bash /mnt/user/appdata/arcade/scripts/mc-cmd.sh 'op "YourGamertag"'
   ```
   Operators skip the chat filter (setting `ops_bypass`), so only op adults.
7. **LAN test (Switch 2 at your house):** Minecraft → Play → **Friends** → *Finsonly Family Server* under LAN Games → join. You should see the welcome line: "Chat here is checked by a moderator bot…"
8. **Remote test:** Switch on your phone's hotspot (phone Wi-Fi off). On the Switch, configure **that hotspot connection**: DNS Manual, primary `104.238.130.180`, secondary `8.8.8.8`, restart. Minecraft → Servers → any featured server → Connect to a Server → `mc.finsonly.net` / `19132`. DNS is per network on the Switch; your home Wi-Fi stays on Automatic.
9. **Child-account test (the one that bites on Switch):** borrow a kid's Switch, or set up a child Nintendo Account on yours, with Nintendo parental controls on. With **Communication with Others** restricted for Minecraft, Minecraft on Switch blocks *all* online play, including your world. Allowing it for Minecraft only (a per-game toggle in the Parental Controls app) fixes it.
10. **Moderator test** from a non-op account (borrow a kid's, or de-op yourself with `mc-cmd.sh 'deop "YourGamertag"'`):
    - `hello` → appears in chat
    - a swear word → "That message wasn't sent…", a flag lands in `moderation/flags.jsonl`
    - `call me 503-555-0100` → blocked as personal info
    - `/tell Eric hi` → "Private messages are off here…"
    - three unkind messages in a row → "Your chat is off for 10 minutes"
    - then `mc-cmd.sh "unmute YourGamertag"` → chat works again

**Done when:** LAN join, remote join and child-account join work, a non-listed account gets "You are not invited to this server", and every moderator test behaves as listed.

**Chat-off fallback, for when the kids' Switch updated before Endstone:** symptoms are "Outdated server" for everyone who updated, and `docker pull endstone/endstone:latest` brings nothing new.
```
bash /mnt/user/appdata/arcade/scripts/mc-fallback.sh on
```
It stops Endstone cleanly, snapshots the world, copies it to a plain Bedrock server on the newest version with **chat disabled for everyone**, and alerts you. Kids can build; nobody can chat. When Endstone catches up (the nightly log says "new Endstone image pulled", or check pypi.org/project/endstone):
```
bash /mnt/user/appdata/arcade/scripts/mc-fallback.sh off
```
That copies the world back and returns to Endstone + Chat Guard. Snapshots from both directions land in `/mnt/user/backups/minecraft/`. Don't add guests while fallback is on.

**What Chat Guard does** (rules in `minecraft/moderation/settings.json`; word lists in `minecraft/moderation/wordlists/`; after editing either, run `mc-cmd.sh reload-moderation`):

| Message contains | Result | Strike | You're alerted |
|---|---|---|---|
| Severe phrase (e.g. telling someone to kill themselves) | Blocked, chat off 10 min immediately | — | Yes |
| Swear word or slur (open LDNOOBW list + your `extra_blocked.txt`) | Blocked | Yes | Yes |
| Phone number, email, street address, @handle, spelled-out number, "where do you live" / "what school" / "last name" | Blocked with a "keep private things private" note | No | Yes, **without** the detail |
| Link or "add me on Snapchat/Discord…" | Blocked | No | App-move attempts only |
| Unkind words ("stupid", "shut up"…) | Blocked, "let's keep it kind" | Yes | No |
| Mild words ("crap", "hell"…) | Blocked, "say it another way" | No | No |
| Spam (5 messages in 6 s, same message 3×) | Blocked | No | No |
| ALL CAPS | Sent in lowercase | No | No |
| `/tell`, `/msg`, `/w` | Blocked: private messages off | No | No |

3 strikes in 15 minutes = chat off for 10 minutes (the player can keep building). Mutes follow the Xbox account across rejoins and restarts. Every message, sent or blocked, is logged to `moderation/logs/chat-DATE.log` and deleted after 30 days.

**Known gaps, ranked:**
1. **Sign text isn't filtered.** Endstone doesn't expose sign text yet. Set `"block_signs": true` in settings.json to stop non-ops placing signs, if you'd rather.
2. **Book & quill text isn't filtered.** Books have to be handed over in-game, so the reach is small.
3. **Creative spelling gets through sometimes.** The filter handles leetspeak, stretched letters and spaced letters, but kids are inventive. Skim the daily log for the first couple of weeks and add misses to `extra_blocked.txt`.
4. **False positives happen** (it errs strict). Add the word to `allowed.txt` and reload.

**Rollback:** `docker compose down mc-bedrock`; delete the router rule. World data stays in `minecraft/`.

**Security reality:** UDP 19132 is outside Caddy, so CrowdSec and the geoblock don't cover it. The protection is `online-mode` (Xbox Live sign-in) + `allow-list`. Never turn the allow-list off to debug a join problem.

---

## Phase 3 — Nightly backup/update + moderator watchdog

User Scripts → **Add New Script** for each (body is one line):

| Script | Body | Schedule |
|---|---|---|
| `mc-nightly` | `bash /mnt/user/appdata/arcade/scripts/mc-nightly.sh` | Custom `0 4 * * *` |
| `mc-moderation` | `bash /mnt/user/appdata/arcade/scripts/mc-moderation.sh` | Custom `* * * * *` |

**mc-nightly at 4 AM:** 20-second in-game warning → Chat Guard stops the server cleanly → world, guest list, permissions, server.properties and moderation settings to `/mnt/user/backups/minecraft/world_YYYY-MM-DD_HHMM.tar.gz` → pulls the newest Endstone image → starts the server (Bedrock updates itself on start if the image is new) → keeps the newest 14. The server restarts even if the backup fails, and a failed backup alerts you. In fallback mode it backs up and restarts the fallback server instead.

**mc-moderation every minute:**
- **Watchdog:** if Minecraft has been up 10+ minutes and Chat Guard hasn't checked in for 3 minutes, it stops Minecraft and alerts you. No moderator, no chat.
- **Alerts:** new flags go to Discord `#mod-alerts` (Phase 8) and Unraid notifications. They say who and what kind of thing ("tried to share personal info (address)"), never the detail itself.
- **Lobby status:** writes `state/minecraft.json` so the lobby can tell parents chat is moderated (or off, in fallback).

Unraid notifications reach your phone once an agent is set: **Settings → Notification Settings** (Pushover, Telegram, Discord, ntfy, email…).

**Verify now:** run `mc-nightly` once with **Run Script** (the server restarts), then:
```
ls -lh /mnt/user/backups/minecraft/ && docker logs --tail 5 mc-bedrock && cat /mnt/user/appdata/arcade/state/minecraft.json
```
`minecraft.json` should say `"chat":"moderated"` within a minute of the server being back.

**Restore drill (do it once now, while the world is empty):**
```
docker update --restart=no mc-bedrock && bash /mnt/user/appdata/arcade/scripts/mc-cmd.sh stop
```
```
mv "/mnt/user/appdata/arcade/minecraft/worlds/Cousins World" "/mnt/user/appdata/arcade/minecraft/worlds/Cousins World.broken"
```
```
tar -xzf /mnt/user/backups/minecraft/world_<STAMP>.tar.gz -C /mnt/user/appdata/arcade/minecraft worlds
```
```
docker update --restart=unless-stopped mc-bedrock && cd /mnt/user/appdata/arcade && docker compose up -d mc-bedrock
```

**Reviewing chat:** `ls /mnt/user/appdata/arcade/minecraft/moderation/logs/`, then `less` a day's file. Tab-separated: time, player, `SENT` or `BLOCKED:<reason>`, message.

---

## Phase 4 — Lobby page (`play.finsonly.net`)

1. **Edit the content** — this file is public. No kids' names, gamertags, phone numbers or addresses:
   ```
   nano /mnt/user/appdata/arcade/lobby-config/config.json
   ```
   - `game_nights`: the two entries are **examples** — replace or delete them. ISO times with offset (`-07:00` PDT, `-08:00` PST after Nov 1).
   - `arcade.systems`: one entry per console. `status`: `ready` shows it with its games, `soon` shows a greyed "Coming soon" cabinet, `hidden` leaves it off the page. Flip a system to `ready` only after it passes its Phase 6/10 test.
   - `arcade.games`: title, `system` (must match a system `id`), player count (`"1"` shows a **Take turns** tag), one-line note. List only games you've dumped and tested. The game room is for adults, but the page is public and the kids read it, so keep the list tame.
   - `arcade.discord_voice_channel`: the voice channel name shown on the page. Never put an invite link in this file.
   - `rules` (the short list on the sign) and `rulebook` (chapters, the "what happens if a rule is broken" ladder, and the it-was-a-mistake note). The ladder quotes the moderator's numbers: if you change `strikes_to_mute`, `strike_window_minutes` or `mute_minutes` in `minecraft/moderation/settings.json`, change the matching text here too.
   - `contact_note`: how parents reach you, without publishing a number ("Text Eric").
   - After step 2 the container is up; from then on, validate after every edit (Unraid itself has no python):
     ```
     docker exec arcade-lobby python3 -m json.tool /config/config.json >/dev/null && echo valid
     ```
     A broken file never blanks the page — the lobby keeps serving the last good copy and logs the error.
2. Build and start:
   ```
   cd /mnt/user/appdata/arcade && docker compose up -d --build lobby
   ```
   ```
   docker ps --filter name=arcade-lobby --format '{{.Names}} {{.Status}}'
   ```
   **Verify:** status shows `(healthy)` after ~30s.
3. **Caddy:** append `caddy/play.Caddyfile` to `/mnt/user/appdata/stack/caddy/Caddyfile` (the file the caddy container mounts) and put the map password hash in place of `PASTE_HASH_HERE`; the block already carries the same geoblock + CrowdSec as jellyfin. Reload:
   ```
   docker exec caddy caddy reload --config /etc/caddy/Caddyfile
   ```
   If caddy isn't attached to `proxy` (the 8/22 failure mode): `docker network connect proxy caddy && docker restart caddy`.
4. **Verify from outside** (phone on cellular): `https://play.finsonly.net` loads with a valid cert, the marquee lights sweep on, the Minecraft token is gold with the right player count, and the Game room token is grey with the next game night.
   ```
   curl -s https://play.finsonly.net/api/status
   ```
   Should show `"online":true` — no IPs, no player names, by design.

How it works: the lobby pings Bedrock at 192.168.0.128:19132 (not localhost — Bedrock is on host networking) at most once per 10 seconds however many people load the page, and reads `state/arcade.json` for the VM. No cookies, analytics, or third-party requests; fonts are self-hosted; `noindex` keeps it out of search engines.

**Rollback:** remove the Caddy block, reload, `docker compose stop lobby`.

---

## Phase 5 — Arcade VM: GTX 970 passthrough + Windows

**Do this on desktop, in one sitting, with nobody streaming from Jellyfin.** It includes reboots of the box serving your public sites.

### 5.1 BIOS (ASUS Prime Z390-A)
- Advanced → CPU Configuration → **Intel Virtualization Technology: Enabled**
- Advanced → System Agent Configuration → **VT-d: Enabled**
- Advanced → System Agent Configuration → Graphics Configuration → **Primary Display: IGFX**, **iGPU Multi-Monitor: Enabled** (already on for Jellyfin QSV)

**Verify after boot:** Tools → System Devices shows IOMMU groups. Find the GTX 970 at `01:00.0` and its HDMI audio at `01:00.1`; ideally they're alone in their IOMMU group. A PCIe root port listed with them is fine.

### 5.2 Hand the 970 from the host to VFIO
1. **Plugins → remove "Nvidia Driver" (ich777).** Trade-off: no more host-side `nvidia-smi` / GPU temp exporter. Jellyfin is unaffected (it uses the iGPU).
2. Tools → System Devices → tick `01:00.0` **and** `01:00.1` → **Bind selected to VFIO at Boot** → reboot.
3. **Verify:** System Devices shows both bound to `vfio-pci`. Then confirm the rest of the stack came back: `docker ps`, `https://jellyfin.finsonly.net`, caddy on `proxy`.

### 5.3 VM Manager + shares
- Settings → VM Manager → Enable VMs: **Yes**. Default VirtIO ISO → **Download** the latest stable.
- Settings → Disk Settings → **Shutdown time-out: 180** (or more). A Windows VM mid-update must not turn a UPS/graceful shutdown into an unclean one — you've already had 9 of those.
- Put a Windows 11 ISO in `isos`.
- Create share **`arcade`**: Primary storage **Array**, SMB export **Yes (Private)**, read/write for your SMB user. This is the master copy of the game library, BIOS files and save backups (layout in 6.2). The VM plays from a local copy; this share is what's protected by parity.
- Buy an **HDMI dummy plug** (~$8) and put it in the 970. Without a display attached, Windows/Parsec can't render a proper desktop to stream.

### 5.4 Create the VM
VMs → Add VM → **Windows 11**:

| Field | Value |
|---|---|
| Name | `Arcade` (scripts depend on this exact name) |
| Autostart | **Off** |
| CPUs | Pin **2/8, 3/9, 4/10, 5/11** (4 cores / 8 threads). Leaves 0/6 + 1/7 for Unraid, Docker, Minecraft |
| Initial memory | 8192 MB |
| Machine | Q35 (latest) |
| BIOS | OVMF TPM |
| Hyper-V | Yes |
| Primary vDisk | 160G, VirtIO, in `domains` (cache). Holds Windows, the emulators, the local game copy and shader caches |
| OS install ISO | Windows 11 ISO · VirtIO ISO = the one downloaded above |
| Graphics | **VNC** for now |
| Network model | virtio-net |

Install Windows over the VNC console:
- At "Where do you want to install Windows?" → **Load driver** → VirtIO CD → `viostor\w11\amd64`.
- If setup can't find a network, load `NetKVM\w11\amd64` the same way.
- Finish setup with any Microsoft account, then create a local one: Settings → Accounts → Other users → Add account → *I don't have this person's sign-in information* → *Add a user without a Microsoft account* → user `arcade`, set a password, make it Administrator. Use this account from here on.
- Run `virtio-win-guest-tools.exe` from the VirtIO CD.
- Activation needs a Windows license key you own.

### 5.5 Switch the VM to the GTX 970
VM → Edit → **Graphics Card: NVIDIA GeForce GTX 970**, **Sound Card: NVIDIA HDMI audio (01:00.1)** → Update → start.
- In Windows, install NVIDIA's newest driver for the GTX 970 (R580 branch — later branches dropped Maxwell, same as the host side).
- Display: 1920×1080 @ 60 Hz on the dummy plug.

**Verify:** Device Manager shows the GTX 970 with no warning icon.

### 5.6 Windows hygiene for an appliance VM
- **Auto sign-in:** Sysinternals **Autologon** (Microsoft) → account `arcade`. Needed so the game menu starts without anyone at a keyboard.
- Power: **Sleep: Never**, screen off: Never. Power button action: **Shut down** (that's what `virsh shutdown` presses).
- Windows Update: set active hours to cover game nights; pause updates the week of a planned night.
- Game Bar/notifications: off (Focus/Do not disturb on), so nothing pops over the game.

---

## Phase 6 — Game room: Parsec + ES-DE + launch set

How it fits together: Windows signs in → **ES-DE** (a free, controller-driven game menu with box art) opens full screen → a guest picks a game with their controller → ES-DE starts the right emulator → closing the game drops everyone back in the menu. Parsec streams the whole thing. Guests only ever see ES-DE and games.

Launch set: **Nintendo 64** (RetroArch), **GameCube** (Dolphin), **PlayStation 2** (PCSX2). All three are light work for this VM. Get these solid before Phase 10 (PS1 and Dreamcast are next).

### 6.1 Parsec (host)
1. Install from parsec.app, choose **Shared** install (runs as a service — required for virtual gamepads and the sign-in screen).
2. Sign in with **your** Parsec account.
3. Settings → **Host**:
   - Hosting Enabled: On · Name: `Finsonly Arcade` (must match `parsec_computer_name` in config.json)
   - Resolution: keep host resolution (1080p)
   - Bandwidth Limit: start at **8 Mbps**. Rule: (your upload Mbps × 0.7) ÷ max guests. Run a speedtest on Xfinity first — upload, not download, is your real ceiling.
   - Virtual Gamepad Type: **Xbox 360** · Parsec Virtual USB Gamepads: **On**
   - Codec: leave H.264 for Android tablet compatibility
4. Settings → **Approved Apps**: enable, then add **every** program guests will see. If one is missing, the stream freezes for guests the moment it takes focus. Launch set:
   - `ES-DE.exe`
   - `retroarch.exe`
   - `Dolphin.exe`
   - `pcsx2-qt.exe`
   Add each Phase 10 emulator here when you install it.
5. Friends → add each family Parsec account. New friends get **Gamepad only** by default — keep it that way. Turn on "connect without approval" only for accounts you trust; otherwise approve each join (Ctrl+F1).

### 6.2 Library layout
On the `arcade` share (master copy, parity-protected):
```
arcade/
├── roms/          one folder per ES-DE system name
│   ├── n64/       .z64
│   ├── gc/        .rvz (Dolphin's compressed format)
│   ├── ps2/       .chd
│   ├── psx/       .chd          (Phase 10)
│   ├── dreamcast/ .chd or .gdi  (Phase 10)
│   ├── wii/       .rvz          (Phase 10)
│   ├── wiiu/      game folders  (Phase 10)
│   └── snes/      .sfc          (Phase 10)
├── bios/          ps2/, psx/, dreamcast/ — dumped from your own consoles
└── saves-backup/  written by the daily backup task (6.6)
```
Folder names must be ES-DE's system names exactly (`gc`, not `gamecube`), or the games won't show up.

**Source rule:** dump every BIOS and game from hardware and discs/cartridges you own. Discs: a PC drive for PS1/PS2; GameCube and Wii discs need a Wii running Dolphin's documented disc-dumping homebrew. Cartridges need a cart dumper (e.g. a Retrode or a Sanni-style cart reader). Never download BIOS files or games.

Inside the VM, a scheduled task copies the library to local disk at sign-in, so games load from the NVMe vDisk, not a sleeping array drive:
- Task Scheduler → Create Task → "Sync library" → Trigger: **At log on** (user `arcade`) → Action: `robocopy`, arguments:
  ```
  \\192.168.0.128\arcade\roms C:\Arcade\roms /MIR /R:2 /W:10 /NP /LOG:C:\Arcade\sync.log
  ```
  Store the share credentials once first: `cmdkey /add:192.168.0.128 /user:<smb-user> /pass:<password>` in a Command Prompt as `arcade`.
- New games go onto the share; they appear in the VM the next time it starts.

### 6.3 Install ES-DE + emulators
1. Download the **ES-DE portable** Windows release from es-de.org and extract to `C:\Arcade\ES-DE\`.
2. Put each emulator in `C:\Arcade\ES-DE\Emulators\`, using the folder and file names in ES-DE's **Windows portable README** (in the download). ES-DE finds them there automatically:
   - **RetroArch** (retroarch.com) → then Online Updater → Core Downloader → **Mupen64Plus-Next** (N64)
   - **Dolphin** (dolphin-emu.org, stable release) → GameCube
   - **PCSX2** (pcsx2.net, stable) → PS2. If you already set it up, move it here and keep its BIOS and memory cards.
3. Start ES-DE once → set the ROM directory to `C:\Arcade\roms` → let it create the system folders → quit.
4. Scraper (box art): Main menu → **Scraper** → ScreenScraper (free account) → scrape all. Without this, the menu is a plain list.
5. Main menu → UI settings → **UI mode: Kiosk**. Guests can browse and start games but can't change settings or delete anything. Note the unlock button sequence it shows you.

### 6.4 Controllers: same 4 pads everywhere
Parsec hands guests virtual Xbox 360 pads, so every emulator sees **XInput 0–3**, in the order players first pressed a button. Map each emulator once:

| Emulator | Where | Mapping |
|---|---|---|
| RetroArch (N64) | Settings → Input → Port 1–4 Controls | Port N → device "Xbox 360 Controller" #N. Usually automatic. |
| RetroArch | Settings → User Interface → **Kiosk Mode: On** (set a password) | Stops guests opening RetroArch's settings |
| Dolphin (GC) | Controllers → GameCube Port 1–4 → **Standard Controller** → Configure | Device `XInput/0/Gamepad` … `XInput/3/Gamepad`, Default mapping, save as profile `pad-1`…`pad-4` |
| PCSX2 (PS2) | Settings → Controllers | Disable the **SDL** source if pads show up twice. Global: Port 1 = XInput 0, Port 2 = XInput 1. Input profile **4-player**: Multitap on Port 1, 1A–1D = XInput 0–3; assign it per game (right-click → Properties). |

### 6.5 Start ES-DE at sign-in
`Win+R` → `shell:startup` → new shortcut:
```
C:\Arcade\ES-DE\ES-DE.exe
```
If you set up PCSX2's Big Picture autostart earlier, delete that shortcut. ES-DE launches PCSX2 itself.

### 6.6 Running a game night
- **You drive with your keyboard.** Connect to the Arcade from your own PC through Parsec. As the owner you have keyboard and mouse; guests have gamepads only.
- **To end a game:** have everyone save in-game, then press **Alt+F4**. The emulator closes and ES-DE comes back. Works the same in every emulator.
- **Player order:** Player 1 presses a button first, then Player 2, and so on. Say it out loud at the start of each game.
- **Taking turns (one-player games):** at the end of a life, level or race, right-click Parsec in the VM's tray → **Reset gamepad**; whoever's up next presses a button first. Details in Phase 10.
- **Save backup** (the only irreplaceable files on the vDisk): Task Scheduler → daily → a `.cmd` with these lines:
  ```
  robocopy "%USERPROFILE%\Documents\PCSX2\memcards" "\\192.168.0.128\arcade\saves-backup\ps2" /MIR /R:1 /W:5
  robocopy "%USERPROFILE%\Documents\Dolphin Emulator\GC" "\\192.168.0.128\arcade\saves-backup\gc" /MIR /R:1 /W:5
  robocopy "C:\Arcade\ES-DE\Emulators\RetroArch-Win64\saves" "\\192.168.0.128\arcade\saves-backup\retroarch" /MIR /R:1 /W:5
  ```
  These are the default save folders for an installed PCSX2, a non-portable Dolphin and the portable RetroArch zip. A portable PCSX2 or Dolphin keeps saves next to its exe instead, so open each folder before trusting the task.

**Verify (the real test):** from your PC or tablet, connect as a guest (a second Parsec account, or a family member's) with two controllers. In ES-DE, start Mario Kart 64, then Double Dash!!, then Crash Nitro Kart. Each time: two pads register as separate players, audio streams, Alt+F4 returns to ES-DE, and the guest stream never freezes (if it does, an exe is missing from Approved Apps).

Then set `n64`, `gc` and `ps2` to `"status": "ready"` in config.json.

---

## Phase 7 — Open/close + lobby status

User Scripts → three scripts, each body is one line:

| Script | Body | Schedule |
|---|---|---|
| `arcade-state` | `bash /mnt/user/appdata/arcade/scripts/arcade-state.sh` | Custom `* * * * *` |
| `arcade-open` | `bash /mnt/user/appdata/arcade/scripts/arcade-open.sh` | Manual, or e.g. `45 17 * * 5` (Fri 5:45 PM) |
| `arcade-close` | `bash /mnt/user/appdata/arcade/scripts/arcade-close.sh` | Manual, or e.g. `30 20 * * 5` |

`arcade-close` asks Windows to shut down and waits 4 minutes; it never force-kills (Windows may be updating). If it reports still running, check the VM's console.

**Verify:** run `arcade-open` → within a minute `https://play.finsonly.net` shows the Game room token gold → run `arcade-close` → token grey within a minute. If the state script stops running, the lobby shows the game room as Closed after 3 minutes (fail-closed).

Resources: with the VM running, Unraid + Docker + Minecraft share 2 cores. If games stutter while others are on Minecraft, isolate the VM cores (Settings → CPU Pinning → CPU Isolation → 2/8–5/11, reboot). Don't run a Rust/CS2 server during game nights.

---

## Phase 8 — Discord for the adults

Discord is for **adults only**: the game-room voice chat and your alerts. The kids (all under 13) aren't on it. Discord's minimum age is 13, and the kids' side is Minecraft with moderated text chat and no voice.

### 8.1 Server layout
Create a new Discord server, "Finsonly Arcade":

| Channel | Type | Who sees it | Used for |
|---|---|---|---|
| `#announcements` | Text | Everyone | Automatic "game room open / closed" posts, game-night plans |
| `#game-night` | **Voice** | Everyone | Talking while you play |
| `#chat` | Text | Everyone | Banter, scheduling |
| `#mod-alerts` | Text, **private** (only you) | You | Chat Guard flags, "Minecraft stopped" and backup-failure alerts |

Server Settings → Safety Setup: verification level **Medium** or higher, and turn on **explicit media content filter** for all members. Invite links: **Invite People → Edit invite link → Expire after 1 day, Max uses 1**, one per person, sent by text. Never post an invite on the public lobby page.

Voice for streaming games: in `#game-night` → Edit Channel → **Bitrate 64 kbps** is plenty, and ask everyone to turn on **Noise Suppression** (User Settings → Voice & Video) so game audio from their own speakers doesn't echo into the call. Headphones fix echo completely.

### 8.2 Webhooks (how the scripts post)
For `#mod-alerts` and `#announcements`: Edit Channel → **Integrations → Webhooks → New Webhook → Copy Webhook URL**. Paste into `.env`:
```
nano /mnt/user/appdata/arcade/.env
```
- `DISCORD_WEBHOOK_MOD=` the `#mod-alerts` URL
- `DISCORD_WEBHOOK_GAMENIGHT=` the `#announcements` URL
- `DISCORD_VOICE_CHANNEL=game-night`

A webhook URL is a password: anyone with it can post as the webhook. If one leaks, delete it in Discord and make a new one.

**Verify:**
```
. /mnt/user/appdata/arcade/scripts/lib.sh && discord_post "$DISCORD_WEBHOOK_MOD" "Test from the arcade server"
```
The message appears in `#mod-alerts`. Then run `arcade-open` and `arcade-close` once: `#announcements` gets "The game room is open. Hop in the #game-night voice channel…" about 90 seconds after the VM starts (once Parsec is up), and "closed" after shutdown.

What lands in `#mod-alerts`: player gamertag + kind of problem ("used a blocked word ('…')", "tried to share or ask for personal info (address)"). Personal details are never sent to Discord. They stay in the chat log on your server.

### 8.3 Game night with Discord
1. `arcade-open` (manual or scheduled) → announcement posts itself.
2. Everyone joins `#game-night` voice, then connects in Parsec.
3. You drive the menus from your keyboard; guests use controllers.
4. `arcade-close` → "closed" post.

When the oldest cousins turn 13, a kids' voice channel can be added with Discord's **Family Center** linked to each parent. Revisit then.

---

## Phase 9 — Family onboarding

### Message to send parents (copy-paste)

> Hi! I've set up a private Minecraft world for the kids. Everything's explained at **play.finsonly.net** (there's a "For grown-ups" section at the bottom).
>
> - It's invite-only: I add each kid's Minecraft gamertag to a guest list, and nobody else can get in.
> - There's no voice chat. Text chat is checked by a moderator bot that blocks swearing, mean words, links and personal info (addresses, phone numbers, schools), and private messages are off. I get an alert if anything serious comes up.
>
> To get your kid in, I need:
> 1. **Their Minecraft gamertag.**
> 2. If their Microsoft account is a child account: from **your** parent account at account.xbox.com/settings (or the Xbox Family Settings app), set *"You can join multiplayer games"* and *"You can join cross-network play"* to **Allow**. It can take a few hours to kick in.
> 3. On a Switch: a Nintendo Switch Online membership and a one-time DNS change (steps are on the site). If you use Nintendo's parental controls, allow **Communication with Others** for Minecraft only. With it restricted, Minecraft blocks all online play.

### Message to send adults for game nights (copy-paste)

> Retro game nights are on: N64, GameCube, PS2 and more, streamed from my computer, and we talk on Discord. Setup takes 10 minutes, details at **play.finsonly.net** under "The game room":
> 1. Install **Parsec** (PC, Mac or Android tablet), make a free account, send me your username.
> 2. Join the Discord: [one-time invite link]
> 3. Have a controller handy (Xbox or PlayStation).
> Discord will ping `#announcements` when the room opens.

### Adding a kid
```
/mnt/user/appdata/arcade/scripts/mc-allow.sh add "Their Gamertag"
```
If they still get "not invited" after you've added them: look up their XUID at mcprofile.io, then edit `minecraft/allowlist.json` to include `{"name":"Their Gamertag","xuid":"<xuid>","ignoresPlayerLimit":false}` and run `mc-allow.sh reload`.

### Go-live checklist
- [ ] Remote Switch join via BedrockConnect works (Phase 2.8)
- [ ] Non-listed account is refused
- [ ] Nightly script ran once by hand; restore drill done
- [ ] `play.finsonly.net` loads from cellular, tokens correct, example game nights replaced
- [ ] Child-account Switch with parental controls joins (Phase 2.9)
- [ ] Parsec guest test with 2 controllers on N64, GameCube and PS2 through ES-DE (Phase 6 verify)
- [ ] Android tablet tested once with Parsec before the first real night
- [ ] Welcome town built; a fresh account gets the title, fireworks, kit and lands in the square or its plot (WELCOME_TOWN.md step 4)
- [ ] Membership cards printed and posted
- [ ] Game room token follows `arcade-open` / `arcade-close`, and Discord `#announcements` gets both posts
- [ ] Every Chat Guard test in Phase 2.10 behaves as listed; a flag shows up in `#mod-alerts`
- [ ] Watchdog test: temporarily move the wheel out of `minecraft/plugins/`, restart, wait 11 minutes, confirm Minecraft stops itself and alerts you, then put the wheel back and start it

---

## Phase 10 — More systems

Add one system per session: install → map 4 pads → add its exe to Parsec Approved Apps → test with two guest controllers → add games to config.json → flip the system to `"ready"`.

**Deferred for now:** Wii U (too heavy for the GTX 970; revisit after the GPU upgrade, and raise the VM to 12 GB RAM then) and Dreamcast (GD-ROM dumping needs extra hardware). Both are `"hidden"` in config.json, and their rows below are kept for later. Ranked:

| Rank | System | Emulator | Load on this VM | Notes |
|---|---|---|---|---|
| 1 | **PlayStation** | DuckStation | Light | Crash Team Racing 4-player through the multitap; Spyro and Crash for taking turns. Needs a PS1 BIOS dumped from your own console (DuckStation won't run without one). Discs rip on any PC drive; convert to `.chd`. |
| 2 | **Dreamcast** | Flycast | Light | ChuChu Rocket! and Sonic Shuffle 4-player; Crazy Taxi and Sega Bass Fishing for taking turns. Flycast's built-in BIOS replacement runs most games; for the rest, put `dc_boot.bin` and `dc_flash.bin` dumped from your own Dreamcast in Flycast's `data` folder. Dumping GD-ROM discs needs a Dreamcast plus an SD-card or broadband adapter and a homebrew dumper. |
| 3 | **Wii** | Dolphin (already installed) | Light | Pick games that accept a GameCube or Classic Controller (Mario Kart Wii), or that play with a sideways Wii Remote (New Super Mario Bros. Wii). Skip motion-only games like Wii Sports. Remote-pointer games don't work over a gamepad. |
| 4 | **Wii U** | Cemu | **Heavy — test per game** | Mario Kart 8 and Super Mario 3D World, 4-player. Raise the VM to 12 GB RAM first. Needs games and keys dumped from your own Wii U. The first race on each track stutters while Cemu builds its shader cache; play every track once before a game night. If 4-player split-screen drops frames, lower Cemu's internal resolution: the stream is 1080p anyway. |
| 5 | **Super Nintendo** | RetroArch + Snes9x core | Trivial | 2-player (Super Mario Kart, Kirby). |
| — | Genesis, NES | RetroArch | Trivial | Only if there's a specific game people want. |

Per-system setup:
- **PlayStation (DuckStation):** BIOS into DuckStation's `bios` folder. Settings → Controllers → Multitap **Port 1 only**, 1A–1D = XInput 0–3 (two-player games just use 1A–1B). In ES-DE: select the PlayStation system → Other settings → **Alternative emulators** → DuckStation. Add DuckStation's exe to Approved Apps. Add a save-backup line for DuckStation's `memcards` folder to the 6.6 task.
- **Dreamcast (Flycast):** Settings → Controls → Port A–D = XInput 0–3, each with a **Standard Controller** and a **VMU** in slot 1 (saves live in the VMU files). Video → renderer **Vulkan** or **OpenGL**, internal resolution **2×**. Add `flycast.exe` to Approved Apps; ES-DE system is `dreamcast`. Add Flycast's `data` folder (VMU saves) to the save-backup task.
- **Wii (Dolphin):** Controllers → Wii Remote 1–4 → **Emulated Wii Remote** → Device `XInput/N/Gamepad`. For New Super Mario Bros. Wii, tick **Sideways Wii Remote** and map 2 → A, 1 → X; save as profile `wii-sideways-N`. For Mario Kart Wii, plug Standard Controllers into the GameCube ports (the `pad-1`…`pad-4` profiles) and pick "GameCube controller" in the game.
- **Wii U (Cemu):** Options → Input settings → Controller 1 = **Wii U GamePad**, Controllers 2–4 = **Wii U Pro Controller**, API **XInput**, controllers 0–3. Add `Cemu.exe` to Approved Apps. In ES-DE, the system is `wiiu`.
- **SNES (RetroArch):** Core Downloader → **Snes9x**. Nothing else to map.

**Taking turns in one-player games** works on every system with no emulator setup: when it's the next person's turn, right-click the Parsec icon in the VM's system tray → **Reset gamepad**. Every guest controller disconnects; whoever's up presses a button first and becomes Player 1, then the others reconnect in any order. Do it between lives, levels or races so nobody loses progress. Games with `"players": "1"` in config.json show a **Take turns** tag on the lobby.

**Not planned, and why:**
- **Switch emulation:** Nintendo's legal action shut down the main Switch emulators in 2024, and everyone already owns a Switch.
- **PS3 (RPCS3):** most games need far more CPU than 4 pinned Coffee Lake cores.
- **DS / 3DS:** two screens per player, and their multiplayer needs one console per player. That doesn't fit one shared stream.
- **Xbox / Xbox 360:** heavy, with few party games that aren't on the systems above.

**Nintendo-native alternative for N64 games:** the **Nintendo 64 – Nintendo Classics** app (Nintendo Switch Online + Expansion Pack) has Mario Kart 64 and Mario Party 1–3 with online play for up to 4. Adults who already pay for it can play those Switch-to-Switch; the game room covers everything Nintendo doesn't sell.

**When the GPU upgrade happens** (the 4060-class card the PSU was sized for): swap it into the VM in place of the 970 (same VFIO steps, new device IDs), install current NVIDIA drivers, and Wii U moves from "test per game" to comfortable. Parsec can then use H.265 for guests whose devices support it.

## Phase 11 — Welcome town, world map, printables, events

Do 11.1 and 11.3 **before** launch day; 11.2 and 11.4 any time after.

### 11.1 Welcome town
Full guide: **`WELCOME_TOWN.md`** (scouting the seed, layout, welcome book text, testing). The welcome plugin (Arcade Extras) is already in `minecraft/plugins/` from Phase 2. Confirm it loaded:
```
docker logs mc-bedrock 2>&1 | grep "Arcade Extras"
```
Expect `Arcade Extras 0.1.0 enabled. Files in /data/arcade`. Edit `minecraft/arcade/welcome.json` and `plots.json`; changes apply on the next join.

### 11.2 World map (play.finsonly.net/map, family password)
1. Download the **uNmINeD CLI for Linux x64 (glibc)** from unmined.net/downloads (free for personal use) and unpack it:
   ```
   mkdir -p /mnt/user/appdata/arcade/tools/unmined-cli /mnt/user/appdata/arcade/map && tar -xzf /mnt/user/data/unmined-cli_*_linux-x64.tar.gz -C /mnt/user/appdata/arcade/tools/unmined-cli --strip-components=1
   ```
   ```
   ls /mnt/user/appdata/arcade/tools/unmined-cli/unmined-cli && chmod +x /mnt/user/appdata/arcade/tools/unmined-cli/unmined-cli
   ```
   (Adjust the tarball name; if it unpacks without a top folder, drop `--strip-components=1`.)
2. User Scripts → `mc-map` → body `bash /mnt/user/appdata/arcade/scripts/mc-map.sh` → Custom `30 4 * * *`. **Run Script** once now. The first render takes a while; later ones only redraw what changed.
3. **Verify:** `ls /mnt/user/appdata/arcade/map/unmined.index.html`. If the log in `state/map-render.log` complains about libraries, tell me the error.
4. Family password in Caddy: make a hash, paste it into the `play.finsonly.net` block (from `caddy/play.Caddyfile`, which now includes the `basic_auth @map` section), reload:
   ```
   docker exec caddy caddy hash-password --plaintext 'pick-a-family-password'
   ```
   ```
   docker exec caddy caddy reload --config /etc/caddy/Caddyfile
   ```
   If Caddy rejects `basic_auth`, your Caddy is older than 2.8: spell it `basicauth`.
5. Restart the lobby so it mounts the map: `cd /mnt/user/appdata/arcade && docker compose up -d --build lobby`. The "World map" link appears on the Minecraft card once a render exists. Username `family`, your password. Send it to parents and grandparents privately.

The map is drawn from the newest nightly backup, never the live world, so it can't affect the server. It shows terrain and builds; it doesn't show sign text or player positions. It's behind the password anyway, because builds near kids' plots are personal.

### 11.3 Membership cards and the champion certificate
Open **`printables/printables.html`** on your PC (double-click; it works offline). Type one line per kid (`Nickname, switch|pc|tablet`), check the preview, **Print cards** at 100% scale, no margins, background graphics on. Card stock (65–110 lb); cut on the outer dashed line, fold on the middle, glue or laminate. The QR code opens play.finsonly.net (tested). Names you type stay on your computer.

The certificate panel prints a landscape **Champion** page for tournament winners.

To change the design, edit `printables/printables.src.html` and run `python3 printables/build.py`.

### 11.4 Seasons, events, tournament, showcase (all in `lobby-config/config.json`)
- **`season`:** `auto` decorates the lobby for Halloween (October) and winter (Dec 1 to Jan 6), with a garland and warmer marquee lights. Or force `halloween`, `winter`, `none`.
- **`events`:** title, start, end, details. Upcoming and current events show in "Game nights and events"; a running event also gets a banner at the top.
- **`tournament`:** the Mario Kart 64 Cup. Before the night: `status: "upcoming"`, list `players`. During: `status: "live"`, add each race as `{"track": "Luigi Raceway", "results": ["1st", "2nd", "3rd", "4th"]}`. Points 9/6/3/1 per place; the lobby totals them. After: `status: "done"`, add the winner to `hall_of_champions`, print their certificate. Use nicknames; the page is public.
- **`showcase`:** contest winners and great builds. Screenshot in-game, copy to `lobby-config/gallery/` (jpg/png/webp), add `{"image": "castle.png", "title": "Cliffside castle", "by": "nickname", "event": "Spooky Build Contest"}`.

Validate after editing: `docker exec arcade-lobby python3 -m json.tool /config/config.json >/dev/null && echo valid`.

### 11.5 Maintenance banner
Automatic. `mc-nightly` turns it on before the 4 AM stop and off once Chat Guard checks in again. During that window the lobby shows "The Minecraft world is doing its nightly backup and update…" and the Minecraft token reads **Updating** instead of Offline. A stuck banner clears itself after 30 minutes.

---

## Day-to-day reference

| Task | Command / place |
|---|---|
| Fix the geoblock on the other sites (one time) | `scripts/caddy-fix-geoblock.sh` |
| Get updates from GitHub | User Scripts → `arcade-update` (or `scripts/arcade-update.sh`) |
| Install add-ons (mods) | copy `.mcpack`/`.mcaddon` to `\\192.168.0.128\data\minecraft-packs` → User Scripts → `mc-packs` |
| List / remove add-ons | `scripts/mc-packs.sh list` / `scripts/mc-packs.sh remove "Name"` |
| Add / remove / list guests | `scripts/mc-allow.sh add\|remove\|list "Tag"` |
| Run a console command | `scripts/mc-cmd.sh "say Dinner time in 10 minutes"` |
| See who's on | `scripts/mc-cmd.sh list` |
| Kick someone | `scripts/mc-cmd.sh 'kick "Tag"'` |
| Turn a kid's chat off / on | `scripts/mc-cmd.sh "mute Tag 30"` / `scripts/mc-cmd.sh "unmute Tag"` |
| Read today's chat | `less /mnt/user/appdata/arcade/minecraft/moderation/logs/chat-$(date +%F).log` |
| Block / allow a word | edit `moderation/wordlists/extra_blocked.txt` or `allowed.txt` → `scripts/mc-cmd.sh reload-moderation` |
| Kids updated before Endstone | `scripts/mc-fallback.sh on` (chat off), later `off` |
| Turn chat off for everyone | compose: `CHAT_RESTRICTION: "Disabled"` → `docker compose up -d mc-bedrock` |
| Force a Bedrock update now | `docker restart mc-bedrock` |
| Change announcement / game nights | edit `lobby-config/config.json` — live on next page load |
| Open / close the game room | User Scripts → arcade-open / arcade-close |
| Add a game | Dump it → `\\192.168.0.128\arcade\roms\<system>\` → restart the VM (sync at sign-in) → scrape it in ES-DE → add it to `arcade.games` in config.json |
| Add a system | Phase 10 checklist; flip its `status` to `ready` last |
| Backups | Minecraft: `/mnt/user/backups/minecraft/` (14 nightly) · game saves: `\\…\arcade\saves-backup` |

## Troubleshooting

| Symptom | Cause → fix |
|---|---|
| "You are not invited to this server" | Not on allow-list, or gamertag mismatch → add again; XUID method above |
| "Outdated server" | Console updated today → `docker restart mc-bedrock` |
| "Outdated server" for kids who updated, no new Endstone image | Mojang shipped an update Endstone doesn't support yet → `mc-fallback.sh on` (chat off) until it does |
| "Outdated client" on Switch | The server is newer than the Switch's Minecraft → update Minecraft on the Switch; Switch patches can lag a day |
| Minecraft stopped, alert says the moderator stopped responding | `docker logs --tail 80 mc-bedrock`, look for a Python error from `endstone_chat_guard`; restart with `docker compose up -d mc-bedrock`. If the plugin fails after an Endstone update, run `mc-fallback.sh on` and send me the error |
| Kid says a normal word gets blocked | Add it to `moderation/wordlists/allowed.txt` → `mc-cmd.sh reload-moderation` |
| `mc-cmd.sh` says Chat Guard hasn't checked in | Plugin not loaded: check `minecraft/plugins/` has the `.whl` and the startup log line from Phase 2.3 |
| No alerts in Discord | Webhook URL missing/wrong in `.env`; test with the Phase 8.2 command |

| Switch: Minecraft says it can't play online | No Nintendo Switch Online, or parental controls restrict Communication with Others for Minecraft → allow it for Minecraft only |
| Switch featured server opens normally (no BedrockConnect menu) | DNS not applied to *that* Wi-Fi connection, or Switch DNS cache → recheck numbers, restart Switch |
| Child sees "multiplayer disabled" | Microsoft Family settings → parent changes them from the parent account; wait a few hours, sign out/in |
| World missing from LAN Games at your house | Container not on host network, or Switch on a different VLAN/guest Wi-Fi |
| Lobby says Minecraft offline but people are playing | Lobby can't reach Bedrock → `docker exec arcade-lobby python3 -c "import sys;sys.path.insert(0,'/app');import server;print(server.bedrock_ping('192.168.0.128',19132))"` should print the server info; if it times out, check `MC_PING_HOST` |
| Lobby 502 | `arcade-lobby` down or caddy off the `proxy` network → `docker network connect proxy caddy` |
| Game room token never lights | `arcade-state` not scheduled, or VM not named exactly `Arcade` → `virsh list --all` |
| VM black screen / Code 43 after adding the 970 | Dummy plug missing; try dumping the 970's vBIOS (SpaceinvaderOne's vbios dump script) and set it as the Graphics ROM BIOS |
| Guests' controllers don't work | Parsec not a Shared install, or Virtual USB Gamepads off, or Approved Apps blocking → check Parsec host settings |
| Guests' stream freezes when a game starts or ends | That emulator's exe isn't in Parsec Approved Apps → add it |
| A system or game is missing in ES-DE | Folder name isn't ES-DE's system name (`gc`, `wiiu`, `psx`…), or the sync task didn't run → check `C:\Arcade\sync.log` |
| Kids changed settings in the menu | ES-DE not in Kiosk mode, or RetroArch Kiosk Mode off → re-enable both |
| Wii U race stutters first lap | Cemu building shaders → play each track once before game night |
| Pads appear twice / wrong player numbers | Disable the SDL source in PCSX2; check Dolphin ports are XInput/0–3; players press buttons in order |
| Stream stutters for everyone | Upload saturated → lower Parsec Bandwidth Limit; check the speedtest |
| Stream fine, game stutters | CPU contention → CPU isolation (Phase 7) |

## Legal / safety notes
- BIOS files, keys and games for every system: dump them from consoles, discs and cartridges you own. Don't download any of them. Nintendo in particular enforces this.
- Kids' chat logs stay on your server for 30 days and are deleted automatically; alerts that leave the server (Discord, Unraid agents) never include the personal detail that was blocked. Tell parents this, as the lobby's grown-ups section does.
- Discord is adults-only: its minimum age is 13 and the kids are younger.
- Footer disclaimer on the lobby ("Not an official Minecraft product…") follows Mojang's usage guidelines for community servers — keep it.
- The lobby is public by design. Keep kids' names, gamertags and schedules tied to specific kids off it; the allow-list file stays local.
