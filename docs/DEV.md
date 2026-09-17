# Development quick-start

Prerequisites: **Node 22+**, **Docker** (for Postgres), git.

```bash
npm install
npm run db:up            # Postgres 16 in Docker, host port 5433
npm run dev:server       # game ws://localhost:8080, admin http://localhost:8081
npm run dev:client       # the game client — http://localhost:5173
```

Open http://localhost:5173 in two browser windows to see two characters in the
same world. Move with WASD/arrows; keys 1–4 toggle equipment on your own
character (debug, until the inventory drives it). **Enter** opens the chat
composer: `/w` whispers (1 tile), plain text speaks (10 tiles, line of sight),
`/y` shouts across the area. Text in `*asterisks*` animates via the emote
lexicon. The small **declare as…** field speaks the line under a name — yours
or anyone's; listeners' Insight may or may not see through it.

Configuration comes from `.env` (copy `.env.example`) or real environment
variables. Migrations run automatically on server start; `npm run db:migrate`
runs them standalone.

## Just play a round

Double-click **`rc.cmd`** in the repository root, or:

```bash
npm run play
```

A menu with seven options: start everything, add bots, restart the round,
stop. It starts the database with Docker if it is not already up, and it reads
`.env` the same way the server does, so the launcher and the server can never
disagree about which port or database is in play.

It is deliberately a thin wrapper — every option shells out to the script the
rest of this document describes, so there is exactly one way each thing starts
and nothing in the launcher can drift away from what CI runs.

Restarting the round goes through the admin API (`POST /api/dm/round/restart`),
which **abandons** a running round rather than discarding it: the cast still
gets its `round_ended` and its banked xp, because cutting a round short from
outside must not be a way to rob everybody of what they earned (D-524).

## Seeing the imported cast in the game (D-559)

Settings (⚙, top right) → **character models** → *imported*. It swaps every
character in the world for a built model and back again, immediately, without
reconnecting. It is disabled with a note if `client/public/models/` has not
been built.

The default is **procedural**, deliberately: the imported cast is the thing
under evaluation. While it is on, a hooded figure is not hooded, equipping
plate does not change the model, emotes do not play, and only a character's
HEIGHT still comes from their appearance — the rest is what the model was
built as. Those gaps are the work that follows a yes, not defects to report.

`window.__rc.cast()` says what is actually being drawn, which is worth using:
at isometric distance through the palette filter the two casts are harder to
tell apart in a screenshot than you would expect.

## The authoring tool (D-560, one tool since D-629)

Everything the game reads is authored on ONE page, served by ONE server:

```bash
npm run dev:tools
```
```bash
npm run dev:client
```

Then open **http://localhost:5173/creation-tool.html**. (`dev:studio` and
`dev:editor` still work and start the same server.)

The top row is the production line, read left to right — **Art → Motion →
Bodies → Things → World → Rules → Scenario** — each stage using what the one
before it defined. The row under it is the editors inside the stage. A badge
on a stage counts what it has and flags what is **unbuilt** or missing: a
character with no `.glb`, a set naming a clip that was never built, an area
placing a mesh `build:environment` has not seen. Hover for the list.

⚠ `tsx` does not reload: after a change to a shared schema, restart the
server, or add `?api=8151` to the page and start a second one with
`STUDIO_PORT=8151 npm run dev:tools`. The embedded map builder follows the
same override.

### Publish — a save reaches the running game (D-630)

The **Publish** control at the right of the stage bar counts what has been
saved since the last publish and says, on hover, what it will do: which
builds (`build:characters`, `build:environment`) the saves invalidated, and
whether the running server can take the change **hot**, at the next round
reset (**warm** — areas, because the live world was built from them) or only
after a **restart** (scripts). Click it: the builds run with their output
streamed to a panel, then the game server re-reads its content
(`POST /api/dm/reload-content` on the admin port) and tells every connected
client, which drops its model caches. If the game is not running, Publish
says so and the reload stays pending; the files are read at the next start.

Which directory needs what is data — `shared/src/pipeline.ts` — and a test
fails if a directory under `content/` has no entry there.

⚠ Animation sets, ground materials, weapon grips and part names reach the
client **on the wire** now (`render_content`, sent when a socket opens and
after every reload). The one presentation file still imported at build time
is `audio/sounds.json`, because the menu plays music before a connection
exists.

### Art › Filing — what every mesh is for (D-631)

First tab on Art: every mesh a pack ships and what it is filed as — body
part, clothing, creature, weapon, environment, pickup, projectile. Rows
nobody has filed are highlighted; the **unfiled** chip lists them. Pick a
mesh to preview it and tick its uses: a mesh may have several (an arrow is a
pickup and a projectile). Ticking creates the entry the use's own tab edits;
unticking removes it and is refused by name while an area places it, an item
is drawn as it or a roamer looks like it. Body part and clothing are one
toggle (the `base` tag); a face is always a body part.

### Bodies › Cloth workbench — physics on a real part (D-631)

Pick a clothing part — the **back** chip lists the capes — and it is
assembled on a bare body that walks. The bones the part is weighted to are
offered as **what hangs free**: for a cape that is `back_02..back_05`, and the
collar on `Capes_01` stays with the spine. Below that, gravity, damping,
stiffness, fold resistance, passes, wind, thickness, floor, and the capsules
the cloth drapes over. Structural changes rebuild the solver; the rest is
live. **Save physics** writes `content/cloth/<pack>.json`; Publish carries
it to a running game, where anybody wearing the part gets the same solver.
⚠ A hood is weighted to the head and has nothing to swing — the banner says
"nothing hangs" rather than pretending.

### Art — parts and names

**Parts & names** is the prerequisite for everything else: nothing downstream
can show a player `SK_Chr_Head_Male_04`. Pick a slot, then look, type, press
**Enter** for the next one. Written to `content/parts/<pack>.json`.

**Mirror names to the other body** carries every name from one body to the
other by part number — measured at 0.89–0.97 island overlap against controls
of 0.13–0.36, so the pairing is real. It never overwrites, and swaps "male"
for "female" inside a name.

**Measure bare skin** prints, per part, how much of it samples the skin band
of the atlas. ⚠ Read the number rather than trusting a cutoff: the nude torso
still has a waistband and measures 71%, while a shirt measures under 10%.
Click the percentage to mark a part as a base body part — that is what
character creation offers, and everything else is a garment.

**Races** curates which of those parts each slot offers, the height range per
body, and the skin tones — which are **colours you pick**, not files. Skin is
only four flat colours in the atlas, so any RGB works and repaints the face in
front of you as you drag the swatch. The vendor's three are offered as
starting points. Chips preview on hover; a part you have not named
yet shows as its file stem in warning colour. Written to
`content/races/<id>.json`, and refused if it would leave nobody able to be
one.

Drag the stage to turn the head, wheel to zoom. The camera is at eye level
here rather than the game's overhead orbit — a face cannot be judged from
above.

```bash
npm run name:assets
```

drafts a name for every weapon and pickup from its filename, and guesses how
each is carried. It never overwrites, so run it again whenever a new pack is
ingested. Buildings and props are left alone deliberately.

**Worn items / Environment / Pickups** name everything that is not a
character part, sorted by the vendor's prefixes. Type a name to create the
asset; its properties appear beside it. Worn items take an attach bone, an
offset and a **stance**, which is what will select an animation set — a
handful of stances covers 163 weapons.

⚠ **Check the centimetre reading on a worn item.** The packs disagree about
units by a factor of a hundred: dungeon weapons are authored in metres,
knights and vikings in centimetres, and characters are centimetres. The panel
prints what the mesh measures once placed; if a sword says 2cm or 9000cm, fix
the scale rather than the mesh.

⚠ **Never preview against `PolygonFantasyHero_Texture_01`.** It has no
colourway suffix and looks like the neutral atlas; it is the markings-free
cut. Twenty-eight of the 46 heads carry war paint that exists only in the
lettered atlases, and against the plain one they render as ordinary faces.
Both tools default to `_01_A` for this reason. Marking colour is pickable per
race, independently of skin.

⚠ **What a race can vary is bounded by the art.** In this pack a body and its
clothing are the same mesh: there is one bare arm, hand and leg per body and
no bare torso at all. So a race is a face, a stature and a set of skin tones,
and equipment has to swap limb meshes rather than layer over them.

### Bodies › Characters — the character studio (D-558)

Build a character out of the pack's parts, watch it walk, and save the
choice. It was `/studio.html`; it is a tab now.

Pick a **Body** first — male or female — because most parts are cut twice and
the lists are filtered by it; the parts cut once (hair, pauldrons, capes)
appear for both. Then one part per slot. Slots that cannot be used grey out
with the reason: a helmet hides the head, the hair, the beard, the brows, the
ears and a hood, and a helmet crest needs a helmet to sit on.

Drag the stage to turn the model, wheel to zoom, and use the **Speed** slider
— at zero it holds a frame, which is how you check a limb. A bad weight is
much easier to see stopped than moving, and much easier from a second angle
than from the default one.

**Save to content** writes `content/characters/<id>.json`: a small document
naming the parts, the pack and the colour atlas. The art stays out of git and
the decision goes in. Nothing invalid is written — the endpoint refuses
anything the build would choke on, so a character that saves is a character
that builds. Then run `npm run build:characters` to turn it into a `.glb`.

If the build prints a line beginning `! repaired`, a part had a weighting
fault in the source art that the pipeline corrected — worth reading, because
it means the vendor's mesh was wrong, not yours.

### Scenario — the round's edges (D-627)

A scenario names the areas a round is played in, where it opens, which
objectives may be dealt and the cast it needs. An endgame area cannot be
added (a round death there is permanent, D-523); a door leading out of the
set is reported, not refused, because the point is knowing where the edges
are. The last live scenario cannot be deleted — with none, the lobby fills
and never starts.

### World › Map builder — the map editor (D-543)

Place walls, ground and objects and see exactly what the game will draw. It
is embedded in the tool; `/editor.html` still opens on its own and talks to
the same server.

Drag to orbit, shift-drag to pan, wheel to zoom. Click places, right-click
erases, **R** rotates a prop, **[** and **]** size the brush, **ctrl+Z**
undoes a stroke, **ctrl+S** saves.

Tools: **ground/walls** (seven wall materials — stone, timber, plaster, brick,
cave, palisade, treeline), **props** (all types, grouped; a ■ marks scenery
that blocks movement, and windows/torches/ivy mount IN walls), **stations**,
**resource nodes**, **spawn**, **exit**, and **roof**.

**Exits** take a target area and an arrival tile; click to place, click an
existing one to repoint it. ⚠ Exits are ONE-WAY — the way back is a
transition in the other area, so place that one too.

**Roofs** are painted as a footprint and the shape is derived: touching tiles
become one building and the ridge runs along its longer side. In the game a
roof lifts away when somebody walks under it; the editor keeps them up so you
can see what you are painting.

**Map size** crops or grows the area from an offset and reports what it
dropped. "Trim to content" finds the tightest rectangle that still holds
everything. A save is refused if shrinking would orphan a door another area
points into.

**A save is validated before anything is written** — schema, reachability with
solid scenery blocking, exits, and somewhere to stand at every facility — and
refused with a reason if it would fail the build. A timestamped copy of the
previous file goes to `content/.editor-backups/` (gitignored) first.

⚠ **`round-*` areas are generated** by `tools/src/build-round-map.py`, and the
tavern by `tools/src/build-tavern.py`. The editor warns you on the generated
ones: running those scripts again rewrites the files and discards anything
placed by hand.

## Playing a round on your own (D-540)

A round needs a cast of three. `npm run bots` supplies the rest of it:

```bash
DATABASE_URL=postgres://rc:rc@localhost:5433/regnum ROUND_MODE=1 ROUND_MIN_CAST=3 DEFAULT_AREA_ID=round-town npm run dev:server
npm run bots -- --count 3
```

The companions register their own accounts and play through the wire like any
other client — they gather, craft, eat, drink, return blows, and talk through
the dawn truce. One of them may be the antagonist, dealt by the server, and if
it is, it will eventually come for you.

`--url ws://host:port` to point elsewhere, `--verbose` for decision-level
chatter, `--betray 0.02` for how eager an antagonist bot is, `--tag` to
distinguish runs (it becomes part of the world-unique character names).

⚠ If port 8080 is taken, run the server with `PORT=8090 ADMIN_PORT=8091` and
set the client's **server** field to `ws://localhost:8090`.

## Importing characters and animations (D-555)

There is no manual step and no 3D tool. Drop the art in `assets/incoming/`
and run one command.

1. Put a Synty Sidekick `.unitypackage` in `assets/incoming/`.
2. Put Mixamo animation `.fbx` files in the same folder. On mixamo.com,
   pick a clip, **Download → FBX Binary, Without Skin, 30fps** — the skin is
   not needed, only the motion. The filename becomes the clip name, so
   `Walking.fbx` becomes `walking`.
3. Run:

```bash
npm run build:characters
```

It writes `client/public/models/`: one `.glb` per character, one
`animations.glb` per rig holding every clip, a `.png` palette per character
and a `manifest.json` saying what was built.

Characters come from three places, and all three build the same way:

- `content/characters/*.json` — authored in the studio, the usual route
- the pack's own `.sk` files — whatever the vendor happened to dress
- `assets/incoming/characters/` — a folder of FBX per character, the escape
  hatch that keeps this from being tied to one vendor (D-556)

A definition naming a pack that is not ingested, or a part the pack does not
ship, stops the build and says which. So does two characters claiming one id
— the id is the output filename.

Look at the result — procedural and imported side by side, same light, same
camera, with the palette filter as a dropdown:

```bash
npm run dev:client
```

then open <http://localhost:5173/imported.html>.

### Art that is not a Synty pack (D-556)

Put any rigged humanoid `.fbx` in `assets/incoming/characters/` — one
character per file — and it builds through exactly the same path. The rig is
detected from its bone names; if it is one nothing has a bone map for, the
build stops and names it rather than exporting a folded character. Clips are
written one file per rig, and `manifest.json` says which one each character
uses.

`assets/incoming/` is gitignored: those are large binaries under somebody
else's licence. The BUILT `.glb` are committed, so CI and a fresh clone
never need the source drop. `npx vitest run tools/test/imported-rig.test.ts`
checks the output and skips itself if the models have not been built.

## Verification — the only review that counts (D-114)

```bash
npm run typecheck        # strict TS across all packages
npm run validate:content # schemas + reachability on /content, fails CI when red
npm test                 # unit + simulation + bot tests
```

`npm test` runs everything. The Postgres-backed tests (restart survival,
DB-level atomicity, append-only log) need `DATABASE_URL` set — with the dev
database up:

```bash
DATABASE_URL=postgres://rc:rc@localhost:5433/regnum npm test
```

Without `DATABASE_URL` those tests **skip** (useful for a quick loop, not a
full verification). CI always runs them against a Postgres service.

## Layout

Single npm package, multiple source roots joined by `@rc/*` path aliases in
`tsconfig.json` (see D-501 for why there is no build step and no workspaces):

| Path | Contents |
|---|---|
| `shared/src` | wire protocol, content schemas, constants, RNG — the single source of truth (D-105) |
| `server/src` | deterministic sim (`game/`), stores (`store/`), WS gateway (`net/`), admin UI (`admin/`), migrations (`db/`) |
| `sim/` | headless bot client + invariant/determinism/persistence suites |
| `tools/` | content validator CLI |
| `content/` | versioned world data — areas, item templates (D-110) |

## The admin UI and DM console

`http://localhost:8081` — live world state (tick, connections, entities per
area), the recent event log, and the **DM console**: spawn an NPC, speak and
move as it (possession), narrate to an area or the world, change an area's
lighting. Set `ADMIN_TOKEN` to require a token outside local dev.

Area scripts are Lua files in `content/scripts/`, attached via the area's
`scripts` list — see `ferryman-keeper.lua` for the API in use. Transitions
between areas are declared per-area in content and validated in CI.

## Deploying (single VPS, D-111)

`docker compose --profile server up -d --build` runs Postgres + server.
Caddy TLS and off-box nightly backups are part of the staging milestone —
not yet configured in this repo.
