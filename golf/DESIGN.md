# Finsonly Golf: design

Status: v0.1.0, 2026-10-13. Playable end to end in the Node harness; **not yet run on the real server or a Switch** (see Risks).

## 1. Decisions

| # | Decision | Why |
|---|---|---|
| 1 | Behavior pack on the stable Script API, not an Endstone plugin | Server runs vanilla BDS (Endstone crashes). Stable APIs need no world experiments, which are permanent. |
| 2 | Pinned to `@minecraft/server` **2.6.0** / `server-ui` **2.0.0** (Minecraft 1.26.10) | Oldest stable versions with everything used: ticking areas, `playerButtonInput`, custom `/golf:` commands, camera follow. Newer servers still run older stable versions. |
| 3 | Ball physics simulated in script, ball entity just teleported | Deterministic, testable in Node, real ballistics (drag, Magnus lift, spin decay, wind) instead of vanilla projectile physics. |
| 4 | Shooter goes **spectator and rides behind the ball** during flight | The server only ticks chunks near players (`tick-distance=4`, 64 blocks). Riding along keeps the ball's chunks loaded at any distance and doubles as a smooth follow cam (`camera.setCamera("minecraft:free")`). Game mode is saved in a player dynamic property and restored after the shot, on leave, and on rejoin. |
| 5 | Positions in blocks, physics in meters, course **scale** 1 or 2 m/block | Full size for adults (real yardages), fun size for kids; same physics. Famous holes are 1 m/block. |
| 6 | Greens are flat blocks + a **contour grid** (cm per block) | 1 m blocks can't show a 2 % slope. The grid is bilinear-interpolated; the ball rolls on it and players read it as Mario-style flowing dots. Famous holes fill it from lidar. |
| 7 | Surfaces come from the block under the ball | Building = placing blocks. Golf turf blocks are the palette; vanilla blocks map to rough/deep/bunker/hard/hazard so courses blend into the world. |
| 8 | One-block steps roll like slopes (energy-based climb / speed-up), taller steps are walls | Natural terrain is a staircase; without this every hill stops putts and chips dead. |
| 9 | One Golf Club item, clubs cycled with Sneak/Jump, item renamed to the current club | No inventory swapping (kids' survival items are never touched), and the hotbar pop-up shows the club. |
| 10 | Items use a 3600-tick `use_duration` | One press = one `itemStartUse`; holding the button doesn't machine-gun taps. `itemUse` is also listened to and de-duplicated. |
| 11 | Courses in **world dynamic properties** | Saved and backed up with the world; no files on Tower to keep in sync. Keyed by BP UUID: never change it. |
| 12 | Famous holes generated offline on Tower into `.mcstructure` tiles shipped in the BP | Needs internet + numpy; BDS scripts can't download. Tiles are 64 × H × 64 and placed with a temporary ticking area each. BP files never reach clients, so tile size costs nothing on Switch. |

## 2. Gameplay model

**Clubs** (full power, 1.00-power golfer, flat fairway, no wind; carries are calibrated exactly at load):

| Club | Carry m (yd) | Launch | Spin rpm |
|---|---|---|---|
| Driver | 210 (230) | 13° | 2800 |
| 3W / 5W | 188 / 172 | 12 / 13.5° | 3700 / 4300 |
| 4I–9I | 160 → 106 | 13.5 → 23° | 4800 → 8400 |
| PW / SW | 95 / 75 | 26 / 32° | 9200 / 10000 |
| Putter | ranges 4 / 8 / 15 / 25 / 40 m | rolls | |

Measured in tests: driver apex ~33 m, lands at 42°, rolls ~13 m on fairway; 7-iron rolls ~7 m on fairway, ~5 m on a green; wedges stop within ~3 m; super backspin pulls back 3 m; topspin adds 10-25 m; power shot +12 %.

**Golfers**: Birdie Bea (balanced), Big Moose (power, fades), Ace Marlow (control), Pirate Pete (spin, draws), Lil' Sprout (big sweet spot, short), Captain Fins (high and soft). Control widens the perfect window and slows the meter.

**Swing meter**: 20 Hz ticks are the timing limit, so the downswing runs at 35 % speed in the last 30 % of the bar. One tick early/late ≈ 0.2 error (a gentle curve), the perfect window is ~1 tick wide at control 1.0. Easy Swing removes tap 3.

**Lies**: rough 88 % distance and flyers (55 % spin), deep rough 74 %, bunker 80 % (wedges 90 %), driver off the deck 93 %.

**Rules**: farthest away plays; honors by last hole; water = +1 and a drop walking back along the line of flight; lost/unloaded = +1 replay; pick up at par×2+2 (kids' tees par+4); gimmes by cup size.

## 3. Data

```
golf:courses           [{ id, name, scale, holes: [holeId], created }]
golf:hole:<id>         { name, par|null, tees: {back, middle, forward, kids}, pin {x,y,z}, green {x0,z0,w,h,mm}, legend? }
golf:records:<course>  { rounds[15], holeInOnes[20], best{name: {total, toPar}} }
player golf:prefs      { golfer, easy, tees }
player golf:restore    { gm }   while mid-shot
```
Green grid max 64 × 64 (one dynamic property must stay under 32 k characters).

## 4. Risks and limits (ranked)

1. **Never run on real BDS / Switch.** Verified: 22 physics/rules tests and a 7-scenario end-to-end run of the real scripts against an in-memory Minecraft, plus a type-check against the 2.6.0 API. Not verified: actual rendering, camera smoothness on Switch, spectator riding every tick, particle looks, and whether Switch fires `itemStartUse` for the club exactly once per press. **First session should run the checklist in §6 before anyone else plays.**
2. **Famous-hole generator never hit the live data.** This sandbox can't reach OpenStreetMap or USGS, so it was tested only on a synthetic island-green hole (generation → structure tiles → placement → played to the cup). Likely first-run problems: a course without `golf=hole` lines in OSM, a wrong `near` point, or the water level needing a nudge. The script prints what it found; fix `presets.json` and rerun.
3. **Timing over the internet.** Tap 3 at 20 Hz plus ~50-100 ms to Tower: one tick of jitter is built into the slow zone and perfect window. If kids still find it too hard, raise `SLOW_FACTOR`/control in `lib/meter.js` or use Easy Swing.
4. **Blocky terrain.** Fairways on rolling natural ground bounce oddly on 2-block ledges. Builders should smooth fairways (Smooth / Flatten brush). Legends holes are smoothed already.
5. **Spectator during flight.** If the server dies mid-shot the shooter rejoins in spectator for ~1 s until the restore runs. Harmless, but don't be surprised.
6. **Simultaneous groups** work (rounds are independent), but each extra flying ball is another player riding through chunks. Fine for 10 players.
7. **Structures are placed north-up only.** Rotation is a v0.2 item.

## 5. District sizing (for the next map scan)

Real 18-hole courses are ~6,000-7,000 yd on 120-200 acres. In blocks:

| Piece | Scale | Footprint (blocks) | Notes |
|---|---|---|---|
| Championship 18 (par 72, ~6,400 yd) | 1 m | **~1,000 × 700** | Two returning nines, 60-80 wide corridors, clubhouse in the middle |
| Fun 18 (same design) | 2 m | ~500 × 350 | What most family rounds will be |
| Kids' par-3 9 | 2 m | ~200 × 150 | 60-120 m holes |
| Legends park (5 holes) | 1 m | ~600 × 400 | Each hole is its own island of terrain: Pebble 7 ~190 × 150, St Andrews 18 ~420 × 160 |
| Driving range + putting green | 1 m | 300 × 70 | |
| Clubhouse, rail station, cart barn | | 100 × 100 | |

**Minimum useful site:** ~1,100 × 800 of gentle land (fun 18 + kids 9 + range + clubhouse, with room to add the Legends park beside it).
**Everything at full size:** ~1,700 × 1,100 including a full-size championship 18.
Prefer: low relief (under ~25 blocks across the site), some water, trees on the edges, near the rail line. Coast is a bonus (ocean holes). Avoid: heavy forest (hours of clearing), mountains (ledges), the lighthouse/hotel/home pad.

Brush effort: radius 12 covers ~450 blocks per click, so painting one 18 is roughly 600-900 clicks plus shaping. Two evenings for you and your brother per 9.

## 6. First-session checklist (on the real server)

1. `golf-pack`, join on PC first. Content log (Settings → Creator) shows `[golf] Finsonly Golf 0.1.0 loaded`, no red errors.
2. `/golf:club` → menu opens. Driving range: swing a 7-iron. Expect ~140 yd, trail particles, camera rides the ball, you return to the mat in your normal game mode.
3. Same on the **Switch**: one tap = one meter step (no double steps), ZL works, Sneak/Jump change club. If Sneak only works every other press, the controller is on toggle-sneak; switch it to hold, or tell me and I'll handle releases too.
4. Brush: paint a fairway + green + bunker + water; Undo; Smooth.
5. Wand: course → hole → tee → pin → tilt 2 % → slope dots visible → test-play to the cup.
6. Two players: invite, take turns, water drop, round summary, records.
7. Quit mid-flight (`/golf:quit`), and disconnect mid-flight: game mode back to normal both times.

Anything off: tell me what happened and paste the content-log lines.

## 7. To Christmas

| When | What |
|---|---|
| This week | Install, run §6 with a kid if possible, tune swing feel |
| After map scan | Pick the district (sizes in §5), rail station, clubhouse |
| By Nov 15 | Fun 18 + kids 9 painted, Legends generated and placed |
| v0.2 (Nov) | Ring shot challenge, pin of the day, practice green, spectator follow cam for the group, rotated Legends placement, records board at the clubhouse |
| Dec 1 | Feature freeze; only fixes after |
| Christmas | Reveal |
