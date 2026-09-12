# Session handover — written 2026-09-11 (the world stopped being a grid)

**For the next Claude Code session.** Read `CLAUDE.md` first as always; this
file is the working context that does not belong in the ADR — where things
stand, what to do next, and the traps already paid for. Rewrite it at the end
of your session.

---

## Where the project stands

**On `main`, uncommitted.** A large working tree (239 changed paths); nothing
pushed. Last commit is still `d24802e`, from two sessions ago.

**733 tests green**, content validator green over **113 files**, both
typechecks clean.

```bash
npm run typecheck && npm run validate:content && npx vitest run
```

The shipping target is still **MR — the Round** (D-521). This session is
**D-567**, which is the largest structural change since M1: **the world is
measured in metres and the tile grid is gone from movement, collision, sight,
pathing and the map editor.** It supersedes the tile-movement half of D-104.

### What D-567 replaced

| Piece | State |
|---|---|
| Collision model — volumes, ramps, step/drop rules (`shared/src/collision.ts`) | built, 33 tests |
| Navigation — A* over a baked index, string-pulled (`shared/src/navigation.ts`) | built, 17 tests |
| Continuous server movement and server-owned routes (`move_to` / `move_stop`) | built, tested |
| Per-asset collision masks, overridable per placement | built, 18 tests |
| Map editor: free placement, select, drag-a-run, snap, duplicate, mask editor | built, verified live |
| Pack meshes drawn in the GAME (`npm run build:environment`) | built, drawn live |
| All eleven areas rebuilt from pack meshes; 1,916 procedural props deleted | built, validated |
| Ranges converted from chebyshev tiles to Euclidean metres | built, tested |

### What play has settled so far

**Walk speed is 2.9 m/s.** 3.33 (inherited from the grid) was "a bit fast",
2.6 was "a little slow". This is the first D-567 number fixed by playing
rather than by arithmetic. ⚠ `STEP_UP` 0.35m, `MAX_DROP` 1.2m, `BODY_RADIUS`
0.3m and the long ranges that lost about a third of their ground are all still
unjudged.

---

## The commands that matter now

```bash
npm run db:up && npm run db:migrate   # 0013 widened positions, 0014 added kit_granted
npm run dev:server                    # game on :8095, admin on :8096
npm run dev:client                    # / is the game, /editor.html is the map builder
npm run dev:editor                    # the editor's own API on :8140 — the builder is dead without it
npm run dev:studio                    # the authoring API on :8150 — the asset tools need it
                                      #   /creation-tool.html now also has "Round content"
                                      #   (recipes/roamers/objectives) and "Speech & sound"
                                      #   (cues/emotes/languages) — D-569
npm run build:environment             # pack FBX -> .glb the GAME can load. Re-run after placing a NEW asset id
npm run rebuild:walls -- <area-id>    # wall tiles -> tiled pack meshes (refuses an already-converted area)
npm run build:characters              # unchanged: character FBX -> .glb
npm run bots                          # fill a live round
```

⚠ **Restart the authoring servers after any schema change.** `tsx` does not
reload. The editor server spent this session running a pre-D-567 schema and
rejecting every area on disk (`assets.0.footprint: Required`), which reads as
the map builder being broken. Ten studio servers had also accreted on
8150–8159, and the editor was talking to the oldest.

---

## The five things most likely to be undone by accident

**0. The grid in `shared/src/navigation.ts` is an INDEX, not a return of
tiles.** Nothing in content, the wire, the rules or the editor sees it; no
distance is measured in it; it is rebuilt from the collision layer at load and
never authored. A path comes out as points in metres and the cells are thrown
away. Swapping it for a navmesh would touch nothing outside that file. It
looks exactly like the thing D-567 removed, which is why this is item zero.

**1. `Volume.walkable` defaults to FALSE.** It defaulted true once — "of
course you can stand on top of a thing" — and that made every 3m wall a
standable platform at 3m and every archway a floor at 4m. The navigation index
filled with floating open ground nothing could reach and routes detoured
around thin air. Standing on something is an authoring act and it is one tick
box.

**2. `overrideCollision` is what stops CI shouting at hand-authored masks.**
The rule is per-asset, overridable per placement (the stakeholder's choice), so
a copy normally tracks the catalogue and sometimes deliberately does not — and
the drift check cannot tell those apart by looking. The editor sets the flag
the moment a mask is touched. Without it the check fires on every authored
doorway, which trains people to ignore it.

**3. `build:environment` ships only what the AREAS ACTUALLY PLACE.** The
alternative is a few hundred megabytes of vendor pack per player. The cost is
that placing a new asset id means re-running the build; the client says so
loudly (`no built mesh for <id> — run npm run build:environment`) rather than
drawing nothing, because an invisible wall reads as broken collision.

**4. The four facility meshes in `client/src/render/station-visual.ts` are the
LAST procedural geometry in the game.** All 44 prop types and all 1,916 placed
props are gone. A station survives because the server spawns it as an entity
and the well must be visible across the square for thirst to work (D-529). It
should become a pack asset too, and the file says so at the top.

---

## What to do next

**The stakeholder's call, 2026-09-11: back to the asset-pipeline goal.** The
long-standing aim is *"all assets created, tagged, and ready for use in game
without much tinkering"*. The world now runs on pack art; the authoring side
is where the gaps are.

### 0. ⚠ `silence-the-keeper` is LIVE and cannot be won

Found by the new objective editor, on the first document opened. The objective
targets the descriptor `"the keeper"`; `kill_npc` matches with an exact
`Set.has` against the descriptor of whatever died. **No NPC anywhere wears that
string** — the only one any script spawns is
`"a heavyset keeper with scarred knuckles"`, in `hanged-ferryman`.

⚠ **It is two problems, not a typo.** `round-town` runs no scripts and does not
link to `hanged-ferryman`, so **there is no keeper in the round map at all.**
D-526 calls this the low-cast workhorse — the objective that turns a
three-player round from "who is the traitor" into "the keeper must live". As
authored, an antagonist dealt it can never win.

**Deliberately not fixed.** Repointing the descriptor would make it *look*
fixed while still being unwinnable, which is worse than a known gap. The real
fix is a decision: put a keeper in `round-town`'s tavern (D-549 says the round
starts there) and point the objective at that descriptor, or mark the objective
`planned` — which costs one of only two objectives playable at a cast of three.

⚠ **The tests never caught it and never would have.** Every fixture spawns an
NPC with the fixture's own descriptor, so they prove the mechanism and say
nothing about the content. Any objective naming a target no script spawns has
the same hole; the editor now warns on that, but cannot refuse (NPCs come from
Lua, so the descriptor list is partial by construction).

### 1. Author the races, and look at them

The machinery is done (D-574): the face step offers what a race curates, the
server refuses anything else, and the world draws it. What is thin is the
CONTENT — two races, both offering the same 46 male heads, one with two skin
tones and neither with markings. A race that offers the same faces as every
other race is not a race (D-560), and today they very nearly do.

⚠ **CORRECTION.** An earlier note here said both races were male-only in the
face slots. That was wrong: `elven` and `human` each curate all 23 male AND all
23 female heads, and 10 male and 7 female brows. The claim came from reading
the first four entries of a list, which happen to be male.

The SYMPTOM was real and the cause was code (fixed, D-575): the head row was
filtered by the cut the head itself decides, so all 46 faces showed until you
picked one and then the other 23 vanished for good. `partsForSlot` in `shared`
now never filters the head, and is tested.

⚠ **CORRECTION, second one.** A note here said "every one of these is unnamed"
and that faces are shown by file stem. Wrong the same way as the first: the
stems were on screen, but the NAMES existed — all 720 of them, written through
the creation tool. The game server simply never loaded `content/parts/`, which
only the authoring tools read (fixed, D-576). The 142 parts the races curate are
all named today, and a server test fails if a curated part ever arrives unnamed.

⚠ What IS thin is still the curation: two races offering the same 46 faces.

⚠ **Empty means UNRESTRICTED, one rule for every gate** (D-566). All nine
callings name no races and admit all of them; the classes authored before those
fields existed parse to `[]` and behave exactly as before. Keep that property.
⚠ **No class restricts races today**, so the calling→race gate is enforced and
exercised only by tests. Narrowing one in the class editor is what would put it
in front of a player.

### 1a. ⚠ Check what else the tools have and the game does not ask for

D-576 was one mistake with two symptoms — the part NAMES and the `.chip` CSS
were both present in the authoring tools and absent from the game, and neither
threw anything. `content/parts/` was loaded by three tools and no server;
`.chip`/`.chip.on` are styled in `creation-tool.html` and `editor.html` and
have never existed in `client/index.html`. Anywhere the game and a tool share a
vocabulary — a class name, a content directory, a derived label — is worth the
same check, because the failure mode is a screen that looks finished.

### 1a-bis. The animation library is WIRED — and what it exposed

D-578 connected `content/animations/` to the renderer (the third "authored, and
only the tools read it" find this session). Three gaps it surfaced and did NOT
close, all cheap and all needing a decision or a fetch rather than code:

- **`crossbow` and `one-handed-shield` have no set.** Both fall through to the
  rig, so a character holding only a shield stands as though empty-handed.
- **`dagger` and `thrown` have no combat IDLE.** The library holds two clips
  each (their attacks). Their fighters stand like unarmed men and strike like
  knife-fighters — the fall-through working, and a gap in the CLIP LIBRARY, not
  the content. Fetching two clips fixes it.
- **The race layer is unreachable**: a race set applies to `race/sex`, and
  `raceId` is on the character record (D-572) but not on the wire ENTITY. No
  race set is authored, so nothing is lost yet.

### 1a-ter. A round decision that is now the stakeholder's

D-579 closed the `round_role` hole (and found the worse half of it: a
reconnecting antagonist lost their objective). What it could not close is a
design question:

**A latecomer can never be the antagonist.** The role is assigned once from the
cast present at the start, so anyone arriving later is truthfully told they are
not — and the rest of the cast can deduce it. At three to five players that is
a free elimination in a mode whose whole engine is deduction. Reassigning
mid-round changes the win condition under everyone; barring late joiners
shrinks an already small cast. Needs a call, not code.

### 1a-quater. The stores exist now — what is left of D-530

D-580 built the common stores (pool, take, spoil, emptied at reset) and closed
D-529's "the stores must RUN OUT". What D-530 ruled and is still NOT built:

- **Potency beyond meals.** Being treated at the infirmary is not yet better
  than bandaging in the field, and the workshop is not yet better than
  improvising. Eating at the storehouse is the only facility bonus that exists.
- **The multiplier band (1.5x-2x) is unratified**, and D-530 names it as the
  number to watch in first play: too potent and nobody carries anything,
  everyone pools, and one act of sabotage decides every round.

### 1a-quinquies. ⚠ A REAL intermittent in the test suite

`sim/test/mr2-gathering.test.ts` → "CANCELS when the worker is struck" has
failed **twice under full-suite load** in one session and passes every time in
isolation. The failure shows the work completing normally and then being
interrupted by `"you moved"` rather than by the blow, with `attacks=1` and a
gap of 0.22m — so the swing lands, and the assertion races the work finishing.

This matters more here than a flake usually would: D-114 makes the suite the
only thing standing between a subtle bug and a live economy exploit, and a test
that cries wolf is one people learn to re-run instead of read. It is not caused
by anything in this session's work (it failed before any of it landed). Worth
someone making it deterministic — probably by starting the work and the blow on
known ticks rather than by wall-clock waits.

### 1a-sexies. Map authoring: what is ready and what is not (D-581)

Measured against the three things the stakeholder asked for:

- **Place assets with collision — READY.** 1,402 meshes, free metres, any
  angle, collision baked at placement and enforced by the server, the
  pathfinder, line of sight and CI's reachability flood.
  ⚠ **but every asset uses a PLACEHOLDER mask**: 0 of 1,402 has a drawn shape,
  so all fall back to a box of the measured footprint × a default 3m height
  (`size` is missing on all of them too). A gatehouse blocks a solid rectangle
  rather than leaving its arch open, and nothing can be walked under. Per
  placement it can be overridden; per asset it wants somebody drawing masks.
- **Place stations and choose their art — HALF.** Placement works and a
  station type is a content id rather than an enum. ⚠ `StationDefSchema.art`
  exists and **nothing reads it**: the gateway spawns stations from a hardcoded
  `STATION_DESCRIPTORS` table of four and the client draws built-in geometry
  from `station-visual.ts`, so `content/stations/*.json` is read by CI only.
  A fifth station type would appear with its raw id as its descriptor. This is
  the one gap that blocks dressing a town.
- **Transitions — READY.** Place, repoint, cross-checked by CI, and a save is
  refused if it would orphan a door another area points into. ⚠ One-way by
  design, and still integer TILES while assets are free metres.

### 1a-septies. ⚠ THE MAPS ARE BARE, AND TWO TESTS ARE SKIPPED UNTIL THEY ARE NOT

D-582 cleared 6,130 machine-placed assets and 799 roof tiles from eleven areas.
They were all `dungeon-pack`, all from `walls-to-assets.py`, none placed by a
person. What is left is walkable ground with doors, spawns, stations and nodes.
`proving-ground` is untouched — it is the actor-walking collision fixture.

**One test is SKIPPED and must be un-skipped as the maps are designed:**

- `client/test/walls-roofs.test.ts` → "gives every map walls you can bump into"

⚠ The dungeon's "gets tighter as it goes down" is RESTORED (D-584). Skipping
it was based on a wrong reading: a floor's shape is carved in the TILE GRID by
`build-round-map.py` and only its dressing had been converted to meshes, so the
layout was never lost.

⚠ **Designing an area means flattening its generated tile walls**, as Ashfold
did — otherwise the generator's boxes stand invisibly inside the buildings you
place. The dungeons are the exception: their tile grid IS the level.

⚠ `build-round-map.py` now PRESERVES `assets`, `roofs` and `live`. Before
D-582 it wrote `round-*` wholesale and would have erased hand-placed design
silently. The division: the generator owns the skeleton, a person owns what
stands on it.

### 1a-octies. Interactive objects have a tab, and stations have art (D-583)

`content/stations/` was read by CI alone — the gateway used a hardcoded table
of four descriptors — and neither stations nor nodes could name a mesh. Both
now can, resolved server-side and drawn through the same loader placed assets
use. The creation tool has an **Interactive objects** tab covering facilities
and resource nodes together.

⚠ `grain-row` and `game-trail` have NO art on purpose: the packs ship no crop
row and no game trail, and a hay cart or a fence would be a lie about what the
object is. They draw the built-in shape until something fitting is ingested.

⚠ `build:environment` must be RE-RUN whenever a station, node or area names a
new mesh — it ships only what the world uses, and the failure is quiet (the
client falls back to built-in geometry and logs a line).

### 1b. Asset `tags` still read by nothing

`tags` exists on **every** asset — weapons, parts, environment — and nothing
selects on it. The armour/weapon/item/race gates are now all enforced
(D-566, D-572); free keywords are the part that is still only written down.

### 2. Author the wardrobe, and see it in a round

The garment editor is built (D-570), garments RENDER (D-571), and
`gothic-plate` is worn by `mail-hauberk` end to end. **Every content type now
has an editor, and equipment is no longer on the imported cast's missing list.**

What remains is authoring, and it is the part that cannot be automated:
deciding which torso goes with which gloves means LOOKING. D-562 measured that
twice — colour overlap within a number is 0.34 against 0.33 across, which is no
signal — so the tool previews and a person decides. `gothic-plate` is one
example to copy, not a roster.

⚠ **Re-run `npm run build:characters` after adding a garment.** The parts a
garment names are exported as `.glb` by that build; a garment saved and not
built is a garment the client asks for and does not get. The editor does not
run the build, and that is worth a look if it becomes annoying.

⚠ The one thing not yet seen by a person is a garment **in a live round**.
Everything either side of that is proven: the assembly matches the build to
90nm of skinned-vertex displacement, the browser path renders it
(`/imported.html`, `window.__imported.wear('ashfold-townsfolk',
['gothic-plate'])`), and a second player sees `worn.garments` change and change
back through the wire (`sim/test/mr4-gear.test.ts`). What is left is somebody
logging in.

**To look at it:** `npm run db:up && npm run dev:server && npm run dev:client`,
then play a `man-at-arms` — the calling walks in wearing `mail-hauberk`, which
names `gothic-plate`. ⚠ Switch the cast to `imported` in the Settings panel;
`procedural` is still the default (D-559) and the procedural cast ignores
garments by design.

### 3. The in-game creation screen

Still drives the **procedural** rig through `appearance`. D-560 recorded the
course correction that matters here: the imported art must reach the world
THROUGH character creation, not by replacing the system that reads a player's
choices. D-559's cast toggle is a way to LOOK at the models in situ, not the
direction.

⚠ **Do not delete the procedural `CharacterVisual`.** On `ImportedVisual`,
`setPresentation` and `setEquipment` still do nothing, so D-219's hood and
D-554's worn silhouette are invisible on the imported cast.

### Still open from D-567, deliberately not chosen

- **Areas are still authored as tile grids.** `areaCollision` derives a layer
  from the grid for any area without one, so every wall is a metre thick and on
  the old lattice. The editor can now DRAW the derived layer (select tool →
  "collision: shown") so it can be judged before anybody re-cuts a map.
- **The dungeon floors are 1,264 / 1,618 / 1,873 separate meshes** and there is
  **no perf number against them**. Measure before optimising; the small maps
  are what testing happens on.
- **`grantStartingKit` is fixed but the accumulated gear is not cleaned up.**
  Four characters in the dev database carry several kits each from restarts
  before the fix (`Dorn xxa` 27 items, `Jayyyyy` 17, `fadssd` 14,
  `Merrow qqb` 9). Nothing was deleted — that is the stakeholder's data.

---

## Traps paid for this session

### The theme: integer arithmetic fed continuous coordinates

Five of these, all silent, all the same shape. **Anywhere that survived the
tile era is a candidate.**

**Line of sight HUNG.** `hasLineOfSight` ran Bresenham with
`while (x !== to.x || y !== to.y)`, stepping by whole numbers — from 45.05
towards 39 it stepped 44.05, 43.05, 42.05 and never once hit. A pinned server
thread, and every test that reached it reported a timeout somewhere else
entirely. It is a segment against opaque volumes at eye height now.

**Every door in the world stopped working.** A transition fired on
`t.x === event.x`, an equality that was true on a grid and is essentially never
true again. Matched by nearness now (`TRANSITION_REACH`), with the radius
larger than one tick of walking — or a fast walker steps clean over a doorway
between two ticks.

**The endgame confirmation could not be given.** It keyed the pending confirm
on the position at the moment of crossing, so "step off the marker and step on
again" compared two different floats and warned forever. Keyed on the
transition's authored point now.

**Work cancelled itself.** `workTick` compared `pos.x !== work.at.x`, so a
player who stopped walking and started harvesting had it cancelled by the last
centimetres of their own glide — reported as "you moved" when they had not.
`WORK_ANCHOR_METRES` (0.4) now.

**The bots reported eighty-eight protocol violations, all false.** Their
invariant check indexed `tiles[59.6]`, got `undefined`, and read it as "the
server put me inside a wall".

### One word: `.int()`

`StatusSchema.reach` was `z.number().int()`. Raising bare-handed reach to 1.5m
— the honest conversion of "adjacent, diagonals included" — made the **entire
status message fail schema validation**, so it was dropped on the floor: no
error, no status, and six tests reporting a timeout waiting for a message that
was being sent correctly every tick. **Any `.int()` left on a distance is a
trapdoor of exactly this shape.** `CharacterSummary.x/y` went the same way, and
migration 0013 widened the stored columns to `double precision`.

### A fake store more permissive than the real one

A login crashed on `duplicate key value violates unique constraint
items_one_per_slot`. `setItemEquipped` was a plain `UPDATE` into a partial
unique index, so equipping over an occupied slot threw instead of replacing.
⚠ **No test caught it because the suite runs on `MemoryStore`, which had no
one-per-slot rule** — 730 tests agreeing with a fake. Both stores enforce it
now.

### Tests that pass by luck

**The watch test struck ONCE**, and witnessing happens at the moment of the
blow (D-552) while the guard walks its round. A coin toss the suite had been
winning, which started losing when the map rebuild changed guard geometry. It
strikes repeatedly now — which is what D-552 actually promises. ⚠ While
chasing it I moved the killer to (25,33) to be "in the square"; that tile is
not standable in the rebuilt town, so the server relocated the character eight
metres away and every blow fell short. **Two independent faults wearing the
same symptom, one of them mine.**

**`m4-death` read `killer.status.xp` once** instead of waiting for it — status
is pushed only when the number changes, so the assertion raced the award.

Both now carry diagnostics on failure (guard positions, distance and LOS; the
death records). A bare timeout told me nothing for an hour.

### The art and the collision can disagree, and only the art is visible

The wall generator moved one mesh per run to the centre of the run and
un-rotated it to carry the mask. That left a five-metre hole at one end of
every wall and drew a stray east-west slab across the middle of every
north-south corridor. **The collision was right the whole time**, so what a
player saw was a wall they walked straight through — and the obvious
conclusion was that collision did not work. The mask rides on the first
segment offset in that segment's own local frame now, and **no mesh is moved**.

A second pass fixed the look: the generator used one 5m mesh for every run,
spacing `round(length / 5)` of them evenly, so a 12m wall became three meshes
4m apart. The pack ships 5m, 3m, 2m and 1m walls, so a run of any whole number
of metres tiles exactly. ⚠ Greedy tiling is safe **only because the pack
happens to ship a 1m piece** — with 5/3/2 alone a 4m run would come up short.
That is asserted in the generator.

### Generators put back what you delete

`build-round-map.py`, `build-tavern.py` and `dress-areas.py` all still wrote
the 44 prop types, so every regeneration re-added 1,916 props. That is why
they kept coming back. All three write none now.

### The converter was not idempotent

Running `rebuild:walls` twice on the same area found no wall tiles (the first
run had flattened them), generated nothing, and then **deleted every wall
asset already there** on the way to replacing them. A map went from walled to
completely open and validated perfectly, because open ground is legal. It
refuses now, and `client/test/walls-roofs.test.ts` asserts every map has walls.

### ⚠ `git checkout -- content/areas/` destroyed uncommitted work

Run reflexively to undo a bad generation. The areas reverted to a state
predating **D-549** (Ashfold 50×50) and **D-544** (tavern 32×32). Recovered by
re-running the generators, and `broken-yard`/`sunken-crypt` — hand-authored,
no generator, wall grids already flattened — were rebuilt from
`git show HEAD:` copies. **The working tree is the only copy of most of this
repo's content. Treat a checkout of `content/` as deletion.**

### Small ones worth ten minutes each

- **`import.meta.url === \`file://${process.argv[1]}\`` is wrong on Windows.**
  The URL carries three slashes and a drive letter, so the guard was never
  true: `build:environment` ran nothing, printed nothing and exited 0. Every
  other tool here matches on the script name; do that.
- **The FBX's own materials must be REPLACED before export, not merely left
  unembedded.** They carry texture references into `GLTFExporter`, which tries
  to rasterise them and dies with "No valid image data found" —
  `embedImages: false` governs what is written, not what is walked.
- **A diagnostic that lies is worse than none.** A probe loaded `broken-yard`
  and measured a bot standing in the tavern against it, then reported the
  server letting people through walls.
- **A body has WIDTH.** "Anything within arm's reach above my feet blocks me"
  blocks the last 30cm of every ramp, kerb and doorstep in the world — you
  could not stand next to a kerb. Clearance is a STEP, not any amount at all.

---

## The overlay legend must not lie

`client/src/render/volume-view.ts` draws collision masks in colours that say
what a volume DOES. Every colour is asserted against what `stepTo` and
`sightBlocked` actually do across 36 volumes, because a mask is invisible in
play, decisive in it, and authored by a person looking at coloured cages. A
cage drawn red that the simulation walks through means a whole map authored
confidently against the wrong picture.

⚠ Three of the five colours were wrong when first written, and only the sweep
found it: a 10cm lip you cannot stand on does not stop you (`walkable` decides
where your feet END UP, not whether you may pass); a 4m arch is not somewhere
you stand just because it has a top; and "you walk under it" needed a colour of
its own.

---

## One loose end

**The walk animation resetting** — reported from play, and the stakeholder
reports it looks fixed after the change in `client/src/game/interpolation.ts`:
`isMoving` now decides from when the server last moved you (`MOVE_GRACE_MS`,
260ms) rather than from whether the render position has caught up with the
target.

⚠ **The mechanism was never reproduced in a test.** Simulated at fixed and at
jittered frame rates, and measured against the live server's movement stream
(17 updates, ~110ms apart, no stalls), the flicker did not appear. The change
is right on its own terms — inferring movement from catch-up is the wrong
question under D-567 — but if the symptom returns, that is the first place to
look, and `await __rc.walk()` reports `serverUpdates`, `movingFlips`,
`postureChanges` and `facingChanges` for exactly that purpose.

`sim/probe/live-walls.ts` and `sim/probe/walk-cadence.ts` are left in place.
They drive a bot against **whatever is actually running on :8095**, which is a
different claim from "a fresh `World` behaves" and the only one that matters
when a player says something is broken.
