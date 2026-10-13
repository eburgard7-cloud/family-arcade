# Finsonly Golf

Mario Golf–style golf for the family Bedrock server: a 3-tap swing meter, spin, power shots, six golfers, a course builder that works with menus and a paint brush, and real famous holes built from lidar.

Plain behavior + resource pack using the **stable** Script API (`@minecraft/server` 2.6, Minecraft 1.26.10+). No experiments, nothing to toggle in the world, runs on vanilla BDS. Switch players download it automatically when they join.

| File | What |
|---|---|
| `DESIGN.md` | How it works, decisions, known risks, district sizing, Christmas plan |
| `pack/` | The add-on source (BP = behavior, RP = resources) |
| `maker/` | Builds the `.mcaddon`, draws textures, generates famous holes |
| `tests/` | Physics tests + a full end-to-end game run against a fake Minecraft |
| `../scripts/golf-pack.sh`, `golf-holes.sh` | Tower User Scripts |

---

## Install / update (Tower)

First time only, add two User Scripts (same as the others): **golf-pack** → `bash /mnt/user/appdata/arcade/scripts/golf-pack.sh` and **golf-holes** → `bash /mnt/user/appdata/arcade/scripts/golf-holes.sh`.

| To... | Run |
|---|---|
| Install or update the golf pack | **golf-pack** (after **arcade-update** pulls a new version) |
| Build the famous holes (first time, or after changing `presets.json`) | **golf-holes** (~5-10 min, downloads map + terrain data) |

Both back up the world, install through `mc-packs`, and restart the server, like any other add-on.

Without the scripts: drop `finsonly-golf-<version>.mcaddon` into `\\192.168.0.128\data\minecraft-packs` and run **mc-packs**.

**Make yourself a builder** (once, from Tower):
```
bash /mnt/user/appdata/arcade/scripts/mc-cmd.sh 'golf:builder "petpiratepete" true'
```
Your brother too, with his gamertag. Builders get the Course Wand and Course Brush and can use `/golf:tools` any time.

---

## Playing

Get a **Golf Club**: interact with a club rack at the clubhouse, or type `/golf:club`. Use the club to open the golf menu.

**Your turn:** you're placed at your ball facing the pin. Look where you want to hit.
- **Gold dots** = flight path of a full swing. **Red ring** = where it lands.
- **Sneak / Jump** = change clubs (the game picks one for you). On the green, Jump changes putter range.

**The swing** (Use button; ZL on Switch):
1. Tap: start.
2. Tap: **power**. Stop it in the red zone at the top for a **POWER SHOT** (uses a ★, ~12 % farther).
3. Tap on the **blue line**: accuracy. Early = hooks left, late = slices right. The meter slows down near the line.

**Spin** while the meter comes back down: **Jump** = topspin (runs out), **Sneak** = backspin (stops fast). Twice = SUPER spin (backspin pulls the ball back).

**Greens:** moving dots show the slope. Blue flat → green gentle → yellow → orange → red fast.

**Rules:** farthest from the hole plays next. Water = +1 and a drop behind it. Lost ball = +1 and replay. Kids' tees pick up at par + 4. Cup size: Kid (huge, 1.5 m gimmes), Fun (Mario-size), Real (4¼ in).

**Easy Swing** (Settings): two taps, power only. For the youngest.

| Command | |
|---|---|
| `/golf:menu` | golf menu |
| `/golf:club` | get a club |
| `/golf:quit` | leave the round / range |
| `/golf:tools` | builders: wand + brush |
| `/golf:reset` | ops: end every round, clean up balls |

---

## Building a course

1. **Paint the hole** with the **Course Brush**. Use = paint where you look (up to 200 blocks away). **Sneak + Use** = brush menu: mode, size (0-12), **Undo**.
   - Surfaces: Fairway, Rough, Deep Rough, Green (adds a fringe edge), Fringe, Tee Box, Bunker (digs + sand), Water (digs, fills, dams the edges), Cart Path.
   - Shaping: Raise, Lower, Smooth, Flatten To This Height, Plant Trees, Clear Trees & Plants.
   - Mow stripes on fairways/greens/tees follow the hole you're editing.
2. **Course Wand** → New course → name it, pick **Full size** (1 block = 1 m, real yardages) or **Fun size** (1 block = 2 m, half the walking).
3. **Add a hole** → stand on the tee box → **Set Tee** (Blue back, White, Red forward, Gold kids). Each set gets tee markers.
4. Look at the green → **Set Pin**. Places the cup and flag and detects the green.
5. **Green slope & contours** → **Tilt** (1-2 % is realistic, 3 % is fast, over 4 % is unputtable), then sculpt bumps with the brush's *Green Contour* modes. Slope dots show while you hold the wand or brush.
6. **Test-play this hole**. Par is automatic from length (override it in the hole menu).

**Natural blocks count too:** grass = rough, grass with tall grass on it = deep rough, sand = bunker, gravel = hard pan, dirt path = cart path, leaves slow the ball, logs and walls bounce it, water and lava are hazards. One-block steps play like slopes; anything taller is a wall.

Everything is saved in the world itself (backed up with it). Delete a hole or course from the wand; blocks stay, only the hole data goes.

---

## Famous holes ("Legends")

**golf-holes** builds these from OpenStreetMap course outlines + terrain (USGS 1 m lidar in the US, 30 m Copernicus elsewhere):

| id | Hole | Notes |
|---|---|---|
| `sawgrass17` | TPC Sawgrass 17, "Island Green" | par 3 |
| `augusta12` | Augusta National 12, "Golden Bell" | par 3, Rae's Creek |
| `pebble7` | Pebble Beach 7 | par 3, ocean below 0.8 m |
| `straits17` | Whistling Straits 17, "Pinched Nerve" | par 3, Lake Michigan below 177.2 m |
| `standrews18` | St Andrews Old Course 18, "Tom Morris" | par 4, 30 m terrain (flat anyway) |

Then in game: stand where the **back tee** should go → Course Wand → **Place a Legends hole**. It's built around you, north-up, replacing whatever is there, and added to the **Legends** course with tees, pin, par and the real green contours from lidar.

Add more in `maker/holegen/presets.json`: any hole whose course is mapped in OpenStreetMap with `golf=hole` lines. Tune `water_level`, `margin` and `trees` per hole.

Map data © OpenStreetMap contributors (ODbL). Elevation: USGS 3DEP; Copernicus DEM © DLR/Airbus.

---

## Development

```
python3 golf/maker/make_assets.py      # regenerate manifests, blocks, items, entities, textures
python3 golf/maker/build_pack.py       # -> golf/dist/finsonly-golf-<version>.mcaddon
node --test golf/tests/physics.test.mjs
node --import ./golf/tests/harness/loader.mjs --test golf/tests/e2e.test.mjs
```

- Bump `VERSION` in `make_assets.py` for every release, otherwise Switch players keep their cached resource pack.
- **Never change the pack UUIDs.** Courses live in world dynamic properties, which Minecraft keys by behavior-pack UUID.
- The e2e test loads the real scripts against an in-memory Minecraft (`tests/harness`): builds a hole through the wand menus, plays a 2-player round with scripted taps, runs the range, places a generated Legends hole and plays it.
