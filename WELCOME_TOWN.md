# Welcome Town: Build Guide

**Goal:** a kid's first login lands them in a finished little town, with fireworks, a title with their name, a starter kit, and their own plot with their name on the sign. Build it before launch day; nobody else is on the server yet.

World seed: `-2746961253358476370` (set in `server.properties` before the first start).

---

## 1. Scout the site (before first start, 10 min)

1. Open **chunkbase.com → Seed Map**, edition **Bedrock**, newest version, seed `-2746961253358476370`.
2. Note the **spawn** marker and look within ~300 blocks for: flat-ish ground (plains, meadow, savanna), water nearby (river or coast), a village (optional, bonus), and a couple of different biomes to explore.
3. Pick the **town square** coordinates (x, z). Spawn itself is fine if the terrain is good there.

If the spawn area is ugly (ocean, jungle, mountains), either pick a better square nearby (the welcome plugin teleports new players there) or choose a different seed now. It's free until the world exists.

## 2. Build in creative mode (one or two evenings)

Temporarily switch yourself to creative (you're an operator):
```
bash /mnt/user/appdata/arcade/scripts/mc-cmd.sh 'gamemode creative "YourGamertag"'
```
Back to survival when done:
```
bash /mnt/user/appdata/arcade/scripts/mc-cmd.sh 'gamemode survival "YourGamertag"'
```

### Suggested layout (adapt freely)

```
                N
        [plot] [plot] [plot]
          |      |      |
  [farm]--=== MAIN STREET ===--[portal]
          |      |      |
        [plot] [SQUARE] [plot]
                 |
            [welcome hall]
                 |
              (river / dock)
```

| Piece | What | Why kids care |
|---|---|---|
| **Town square** | Open plaza, a fountain or tree, the landing spot | First thing they see: make it look finished |
| **Welcome hall** | Small building with a lectern (welcome book), a map wall, a bed area | Explains everything without you being online |
| **Plots** | One fenced 15×15 plot per kid, a sign with their nickname, a chest with a gift | "This is MINE" is the whole hook |
| **Community farm** | Wheat, carrots, a few animals in pens, a composter | Food without grinding; teaches sharing |
| **Nether portal** | Framed but **unlit** | A goal to work toward together (light it on a game night) |
| **Dock / boats** | A few boats by the water | Exploring the seed's coast or river |

Tips:
- **Use nicknames, not gamertags, on signs.** Signs aren't chat-filtered, but you're writing these ones.
- **Gift chests:** one diamond each, a name-tagged pet (tame a cat or dog and name it with a name tag), some colored wool/concrete in their favorite color.
- **Light everything:** mobs spawning in the square on night one kills the moment. Torches/lanterns every ~8 blocks, or slabs on dark floors.
- **Welcome book:** write it in a Book & Quill, then copy it for every lectern by crafting the written book with blank Book & Quills. Starter text below.

### Welcome book text (paste and edit)

> **Page 1:** Welcome to Cousin Town! This world belongs to all of us. Your plot has your name on it, and the chest inside is a gift from Uncle Eric.
>
> **Page 2:** The rules: be kind, build your own stuff, ask before going into someone's house, keep private things private. The full rule book is at play.finsonly.net.
>
> **Page 3:** The farm is for everyone. Take food, replant what you pick. The portal isn't lit yet. We'll light it together on a game night.
>
> **Page 4:** Tips: you keep your stuff when you die. Creepers and TNT can't blow up builds here. Coordinates are on, so tell people where you are with x, y and z.

## 3. Wire up the welcome (5 min)

After the first start, the welcome plugin creates two files:

**`/mnt/user/appdata/arcade/minecraft/arcade/welcome.json`** (edit freely; applies on the next join, no restart):
- `town_name`: shows in titles and messages (`{town}`)
- `first_join.title` / `subtitle` / `chat`: what new players see (`{player}` = their gamertag)
- `first_join.landing`: set `"enabled": true` and the town-square x, y, z so new players land in the square instead of the raw world spawn
- `first_join.starter_kit`: item IDs and counts (max 64 each), e.g. `{"item": "cooked_beef", "count": 16}`
- `first_join.fireworks`: true/false
- `returning.chat`: the short greeting on later logins

**`/mnt/user/appdata/arcade/minecraft/arcade/plots.json`** (private, never published):
```json
{
  "Exact Gamertag One": {"x": 140, "y": 72, "z": -32},
  "Exact Gamertag Two": {"x": 160, "y": 72, "z": -32}
}
```
A kid in this list lands **in their own plot** on first join, and their respawn point is set there. Use a block just inside their gate. Delete the `"Example Gamertag"` line.

Also set the world spawn to the square, so anyone not covered above (and every respawn without a bed) starts there:
```
bash /mnt/user/appdata/arcade/scripts/mc-cmd.sh "setworldspawn <x> <y> <z>"
```

## 4. Test it with a fresh account

Use a second Microsoft account (or a kid's, with permission) that has never joined:
- lands in the square or their plot, sees "Welcome to Cousin Town!", hears the level-up chime, fireworks go off
- starter kit is in the inventory
- leave and rejoin: only "Welcome back to Cousin Town" this time

To re-run the first-join welcome for an account (e.g. after testing), remove its entry from `arcade/seen.json`.

## 5. Launch day ideas

- Schedule a **"Grand Opening"** game night on the lobby: everyone logs in at the same time, you're in the square to give the tour.
- Light the nether portal together at the end.
- Take screenshots of each kid at their plot for the lobby's showcase.
