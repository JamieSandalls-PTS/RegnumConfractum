# Session handover — written 2026-09-17 (the production line)

**For the next Claude Code session.** Read `CLAUDE.md` first as always; this
file is the working context that does not belong in the ADR — where things
stand, what to do next, and the traps already paid for. Rewrite it at the end
of your session.

---

## Where the project stands

**On `main`.** The previous session crashed after finishing D-627/D-628 with
the whole tree uncommitted since D-595; this session committed that as
`b2ba50c`, then D-629 (`5f58c66`), D-630 (`2a43066`) and D-631. All pushed
to `origin/main` through Git Credential Manager; `gh` is installed but not
logged in (`gh auth login --web` is the stakeholder's to run).

```bash
npm run typecheck && npm run validate:content && npx vitest run
```

The shipping target is still **MR — the Round** (D-521). The scope of this
session was the stakeholder's brief of 2026-09-17: *"the tools to build the
game, and the game runtime itself, are not linked"*. The plan that answered it
is `~/.claude/plans/crispy-napping-micali.md`, and every step of it is done:

| Step | Decision | State |
|---|---|---|
| Revise the plan documents | D-627, BUILD_PLAN "where MR stands", MR4 | done (previous session) |
| The fresh-eyes inventory | `docs/SYSTEM_INVENTORY.md` | done (previous session) |
| The scenario as the round's boundary | D-627, D-628 | done (previous session) |
| One tool, left to right, one server | **D-629** | done |
| Publish + reload, four channels to two | **D-630** | done |
| Reset and runtime tests | D-628's reset suite, D-630's reload test | done |

### The commands that matter now

```bash
npm run db:up && npm run db:migrate
npm run dev:server        # game on :8095, admin on :8096 (from .env)
npm run dev:client        # / is the game, /creation-tool.html is THE tool
npm run dev:tools         # the ONE authoring api on :8150 (dev:studio / dev:editor alias it)
npm run bots              # fill a live round; reads PORT from .env
```

⚠ `tsx` does not reload. After a schema change, restart `dev:tools` — or
start a second one with `STUDIO_PORT=8151 npm run dev:tools` and open the
tool with `?api=8151`; the embedded map builder follows the override.

---

## What was built this session, in the order it matters

**D-629 — one tool.** `/creation-tool.html` is seven stages read left to
right: Art → Motion → Bodies → Things → World → Rules → Scenario. The stages
are a registry in `creation-tool.ts` (`STAGES`), not HTML; the nine editors
that existed are untouched under it. `/studio.html` and `/viewer.html` are
gone — they are the **Characters** and **Cloth workbench** tabs of Bodies,
written as modules in `client/src/tool/` that take a `ToolContext`. The map
editor's server (8140) is merged into the authoring server as
`tools/src/editor-routes.ts`. A **Scenario** stage edits D-627's boundary
with the same function CI refuses on. `GET /api/overview` puts a badge on
each stage naming what is **unbuilt**.

**D-630 — the save reaches the game.** `shared/src/pipeline.ts` is the
dependency map (directory → builds invalidated, reload tier), with a test
that fails on a directory with no entry. The authoring server notes every
write; **Publish** in the stage bar runs only the invalidated builds
(streamed to a panel) and calls `POST /api/dm/reload-content`.
`GameServer.reloadContent` swaps the lookups, tells every client
(`content_reloaded` → the client drops its model caches), and reports what
it could NOT apply (areas wait for a reset; scripts need a restart).
Animation sets, ground, grips and part names now ride the wire as
`render_content` (sent when a socket opens, before auth, and after every
reload) instead of being Vite imports.

---

### After the plan: filing and cloth (D-631)

Two more asks, both done and committed. The **Filing** tab is first on Art
(`client/src/tool/filing.ts`, `tools/src/filing.ts`): every mesh, several
uses per mesh, a fourth asset kind `projectile`, unfiled highlighted, unfiling
refused by name. The **cloth workbench** is rebuilt on the pack's own parts
(`client/src/tool/cloth.ts`) over a new mesh solver
(`client/src/render/mesh-cloth.ts`); settings are `content/cloth/<pack>.json`,
ride `render_content`, and `ImportedVisual` runs them on anybody wearing the
part. The old grid cloth files are deleted. ⚠ Every cloth number is a default
the workbench exists to replace; the stakeholder has not tuned one yet.

## The things most likely to be undone by accident

**1. `render_content` goes out BEFORE auth, on socket open.** A client builds
its first visual from it. Moving the send to after `auth_ok` or `enter_world`
would draw the first snapshot with no grips and no animation sets, and it
would look like the art regressed.

**2. `audio/sounds.json` is deliberately still a build-time import.** The
menu plays music before a connection exists. Do not "finish the job" by
moving it onto the wire without solving that.

**3. The stage bar and tab bar are RENDERED from `STAGES`.** The HTML has
two empty containers. A test (`tools/test/enemy-tab.test.ts`) asserts the
Enemies tab in the registry, not the markup.

**4. `reloadContent` must keep saying what it deferred.** `mr12-content-reload`
asserts an area change and a script change come back as `deferred` with
their reasons. Applying areas live is real work (the world is entities), not
a flag flip.

**5. The Publisher keeps two pending sets.** Builds clear when built; the
reload clears only when the game answered. Merging them makes "built, game
not running" read as "nothing to do".

**6a. Bone names are matched WITHOUT case.** The rig spells `Pelvis`,
`UpperArm_L`, `Hand_L`, `Thigh_R`, `Foot_R` beside `spine_02`, `calf_l`. A
collider that matched nothing used to be skipped silently; it is reported in
the workbench banner now. Do not "tidy" the lowercase defaults to match one
spelling — both exist on one skeleton.

**6. `MeshCloth` welds and indexes what it is given.** The pack's FBX parts
are non-indexed triangle soup; the sequential index plus the weld is what
turns them into a connected cloth. And `applyBoneTransform` needs the vertex
in the vector — pass an empty one and every pin lands on its bone's pivot.

**7. `.env` is the one source of ports**, read by the server, the bot runner
(D-628), the Publisher, and now the login form through Vite's `envDir: '..'`
and `envPrefix: ['VITE_', 'PORT']`. A second default anywhere is the drift
that cost D-628 its afternoon.

---

## What to do next

### The stakeholder's decisions, still open

- **Which tavern belongs to which product.** `hanged-ferryman` is the
  persistent world's first-slice tavern that D-608 borrowed as the round's
  opening room; `round-town` has its own with the keeper `silence-the-keeper`
  names. The round opens in the town and the borrowed door stays shut until
  this is decided (D-628).
- **A latecomer can never be the antagonist** (D-579): at a cast of three to
  five that is a free elimination. Needs a call, not code.
- **Every unratified number** listed at the end of `CLAUDE.md`.

### From MR4, still to build

- **`garments`** reach the client only through the baked manifest; the server
  does not load them. `EnvironmentAsset.operable` (doors) and asset `tags`
  (the keyword gating) have **no reader**.
- **Effects as content**: named by the stakeholder, does not exist. The
  death-model swap exists for GHOSTS (D-632: a race's `ghost` look, picked on
  Bodies › Races); a corpse still keeps the living mesh.
- **Areas live**: `reloadContent` defers them to a reset. Making a placed
  asset appear in a running world needs a world delta the protocol does not
  have.
- The RACE animation layer is unreachable (`raceId` is on the record, not
  the wire entity); `crossbow` and `one-handed-shield` have no set; `dagger`
  and `thrown` have no combat idle.

### From MR2/MR3

- **Farming does not exist** (no `plant` verb), and with it the antagonist's
  third sabotage, "burn the crop".
- D-530's potency band beyond meals is unbuilt and unratified.
- Scenario rotation falls out of the scenario type; nothing chooses between
  two scenarios yet (`RoundEngine` takes the first live one).

### Extraction, when convenient

`creation-tool.ts` is 7,300 lines. The three tab modules under
`client/src/tool/` show the shape: a module exports `enter(ctx)` and takes the
page as a `ToolContext`. Moving the older sections into that shape is safe,
mechanical work — but do it one section at a time with the browser open,
because D-570 found three UI defects there that no test saw.

---

## Traps paid for this session

**A test that reads the tool's HTML for a tab.** It broke the moment the bars
became a registry. Assert where a thing is DECLARED.

**A fixture area of 4×4 does not parse** — `AreaSchema` wants 8 or more, and
`safeParse` inside a report just skips it. The overview test's first version
"passed" its world check by checking nothing. Use real documents in fixtures
where the schema is not trivial (`overview.test.ts` now copies a shipped
character and gives it a new id).

**The motion check needs a manifest to fire.** With no build at all, the
report says "no clips built" once rather than accusing every set. A fixture
that wants the per-set check has to ship a manifest with one built clip.

**Eating a reloaded loaf is refused for a different reason.** A fresh
character is sated, so `use_item` on the new template answers `not_hungry`,
not a narration — and that is the proof: two gates past `no_such_item`.

**Screenshots of the browser pane time out** when the pane is not fronted.
`javascript_tool` reads state fine; `find` and `get_page_text` too. Do not
fight the screenshot.

**`hasLineOfSight` and the like still hold** — nothing in D-567's list of
integer-arithmetic traps was touched. The intermittent
`mr2-gathering › CANCELS when the worker is struck` failed once more under
full-suite load and passed in isolation, exactly as the earlier note says.
Still worth making deterministic.

**The client's login form said 8080.** Everything else had already been
fixed to read `.env`; the form was the last copy of the old default and it
cost ten minutes of "registration fails" that was a connection to nothing.
