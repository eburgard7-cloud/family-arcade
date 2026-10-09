# Finsonly Family Arcade

A private Minecraft Bedrock world for the kids (Switch first), the public lobby at **play.finsonly.net**, and the adults' retro game room. Everything runs on Tower (Unraid) from `/mnt/user/appdata/arcade`.

| File | What it's for |
|---|---|
| `DEPLOY.md` | Short step-by-step setup. Start here. |
| `ARCADE_SETUP.md` | Full runbook: every phase, troubleshooting, day-to-day commands |
| `WELCOME_TOWN.md` | Building the spawn town |
| `lobby-config/config.json` | Everything the lobby page says: announcement, game nights, events, rules |
| `scripts/` | Every server task (guests, backups, updates, add-ons). Usage is at the top of each file. |

**Status:** Minecraft is running on plain Bedrock with **chat off** (`mc-vanilla`), because Endstone crashes on this server. See `endstone-bug-report.md`. Once Endstone is fixed, `scripts/mc-fallback.sh off` switches back to moderated chat.

---

## Getting updates

User Scripts → **arcade-update** → Run Script. Or:
```
bash /mnt/user/appdata/arcade/scripts/arcade-update.sh
```
It does four things:
1. Saves any edits you made on Tower (for example to `config.json`) and sends them to GitHub.
2. Pulls the latest version.
3. Rebuilds the lobby if its code changed.
4. Tells you if anything else needs a restart.

It never touches the world, backups, chat logs or `.env`; git ignores all of those.

See what's pending without changing anything:
```
bash /mnt/user/appdata/arcade/scripts/arcade-update.sh status
```

---

## Add-ons (mods)

Bedrock "mods" are add-ons: **behavior packs** (new mobs, items, rules) and **resource packs** (textures, sounds). Players on Switch download them automatically when they join, so they don't install anything themselves.

1. Download the add-on to your PC. You'll get a `.mcaddon` or `.mcpack` file; a `.zip` of a pack works too.
2. Copy it to **`\\192.168.0.128\data\minecraft-packs`**.
3. User Scripts → **mc-packs** → Run Script. Or:
   ```
   bash /mnt/user/appdata/arcade/scripts/mc-packs.sh
   ```
   The script then:
   - warns players
   - backs up the world (to `/mnt/user/backups/minecraft/…_before-packs`)
   - installs every pack in the folder; a newer version of the same pack replaces the old one
   - restarts the server

   Installed files move to `minecraft-packs/installed/`. Files that couldn't be installed move to `minecraft-packs/failed/`, and the output says why.

Other commands:
```
bash /mnt/user/appdata/arcade/scripts/mc-packs.sh list
```
```
bash /mnt/user/appdata/arcade/scripts/mc-packs.sh remove "Pack Name"
```

**What works and what doesn't:**
- **Works:** add-ons from mcpedl.com, CurseForge (Bedrock) and similar sites, as long as they're behavior or resource packs.
- **Doesn't work:** Marketplace content you bought (it's locked to your account), skin packs and world templates.
- **Beta add-ons:** packs that need the **Beta APIs** experiment get a warning and may do nothing. Turning experiments on is permanent for a world, so it isn't done here.
- **Test first:** try one add-on at a time on a quiet evening. If one breaks something, `remove` it, or restore the `before-packs` backup. Restoring is covered in ARCADE_SETUP.md, Phase 3 → Restore drill.
- **Family-friendly:** check a pack yourself before the kids get it. Add-ons can add anything.

---

## One-time GitHub setup (on Tower)

Do this once. After that, `arcade-update` handles everything.

**1. Make a key that lets Tower read and write this one repo**
```
mkdir -p /mnt/user/appdata/arcade-secrets && ssh-keygen -t ed25519 -N "" -C tower-arcade -f /mnt/user/appdata/arcade-secrets/deploy_key && cat /mnt/user/appdata/arcade-secrets/deploy_key.pub
```
It's kept outside the repo folder and survives reboots.

**2. Add the key on GitHub.** In the repo, go to **Settings → Deploy keys → Add deploy key**:
- Title: `Tower`
- Key: paste the line that starts with `ssh-ed25519`
- Tick **Allow write access**
- Click **Add key**

**3. Connect the existing folder to the repo.** This doesn't touch the world, `.env` or anything git ignores.
```
cd /mnt/user/appdata/arcade && git init -q -b main && git config core.sshCommand "ssh -i /mnt/user/appdata/arcade-secrets/deploy_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/mnt/user/appdata/arcade-secrets/known_hosts" && git config user.name "Tower" && git config user.email "tower@finsonly.net" && git remote add origin git@github.com:eburgard7-cloud/family-arcade.git && git fetch -q origin && git reset -q --hard origin/main && git branch -q -u origin/main && chmod +x scripts/*.sh && git log --oneline -1
```
**Check:** it prints the latest commit message.

If it says "dubious ownership", run this, then step 3 again:
```
git config --global --add safe.directory /mnt/user/appdata/arcade
```

**4. Add two User Scripts** (Settings → User Scripts → Add New Script). Both are run by hand, with schedule **Schedule Disabled**.

| Name | Body |
|---|---|
| `arcade-update` | `bash /mnt/user/appdata/arcade/scripts/arcade-update.sh` |
| `mc-packs` | `bash /mnt/user/appdata/arcade/scripts/mc-packs.sh` |
