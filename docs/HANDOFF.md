# Session handoff — written 2026-08-18 (combat & cloth session)

**For the next Claude Code session.** Read `CLAUDE.md` first as always; this
file is the working context that doesn't belong in the ADR: where things
stand mid-milestone, what to do next, and the traps already stepped in once.
Delete or rewrite this file at the end of the next session.

---

## Where the project stands

M0–M4 complete; the post-M4 **UI-before-M5 milestone** (stakeholder ruling)
is well underway. This session shipped D-515 through D-520:

- **D-515** — character creation screen (calling → skills → feats → spells
  → name), split pixelation reinstated with a depth-tested composite and a
  Graphics settings panel, speech bubbles over speakers. Creation
  catalogues are content (`content/skills|feats|spells/`);
  `validateBuild()` in `shared/` is the single rule set; migration
  `0008_character_build.sql`; tests `sim/test/m5a-creation.test.ts`.
- **D-516** — combat state (server-owned, enter on attack/hostility, leave
  after 10s quiet AND no hostile within 20 tiles), weapons sheathe to the
  back out of combat, four server-chosen attack variants + caster cast,
  projectile/particle effects (`client/src/render/effects.ts`), carryable
  corpses gated on Athletics vs the dead build's burden. Tests
  `sim/test/m5b-combat-state.test.ts`.
- **D-517** — the viewer is TABBED (Cast / Animation / Cloth / Render),
  one live scene; the Cloth tab is a full workbench (re-pin to any bone,
  resize, recollide, retune physics, export JSON). `cloth-lab.ts` /
  `cloth-ui.ts`.
- **D-518** — death is a verlet RAGDOLL (`client/src/render/ragdoll.ts`),
  driven by the killing blow's direction; bodies stay down; corpses seen
  fresh fast-forward to settled. Tests `client/test/ragdoll.test.ts`.
- **D-519** — garments are cut to the BODY: rig-derived `capeAnchorY`, cut
  from shoulder span, collar from head size. Tests
  `client/test/garment-scale.test.ts` (fails against the old formulas).
- **D-520** — the stakeholder's workbench exports for cape, skirt and
  sleeves are BAKED into `CharacterVisual`; hood flap physics removed
  entirely; workbench presets re-baselined so its zero = the game.

## ⚠ Scope change landed after this handoff was written

**2026-08-18, D-521:** the shipping target is now **MR — the Round**
(20-30 min scenario, hidden antagonist, no respawn). See CLAUDE.md's
current position and BUILD_PLAN's MR section. The priority list below is
superseded where it conflicts: **inventory UI is promoted** (MR2 cannot
exist without it), **richer injuries and Plane Shift are demoted**, and
the immediate next build is **MR1, the round spine**. Combat-feel
iteration with the stakeholder still stands and is independent.

**D-522 followed the same day:** characters are **persistent** across
rounds (xp/level kept, gear stripped), creation is at a roster screen
outside the round, minimum cast three. Two hard rules for whoever builds
MR2: **no xp for player kills** and **levels buy access, not power**.

**D-523/D-524 same day:** the **dungeon** is the round's separation engine
(per-round reset, `wilderness` tier — **never `endgame`**, which would
permadeath a persistent character); **recognition memory resets each
round**; **dying forfeits that round's xp**. Antagonist assignment must
stay **random** — D-524's recognition reset depends on it.

**D-525/D-526 same day:** characters **keep** their names and faces across
rounds; what wipes is the **recognition system's per-observer knowledge** —
round-scoped state, never written to the persistent character record.
(D-525 briefly recorded a per-round-anonymity mechanism; that was an
over-reading, withdrawn, and the entry now says so.) **Food and water** are in as the anti-camping mechanic and
farming's consumer — coarse events on the day-night cycle, never a
draining bar, no death spiral. Cast of three is carried by objectives that
never need the antagonist to win a fight.

**D-527:** day-night cycle is **10 real minutes** (5 day / 5 night), on the
round's own clock; a round **opens at dawn** so 25 min = exactly two
nights. **Night NPCs roam outdoors** — the third movement force. Needs an
`outdoor` flag on areas (do NOT overload `lighting`).

## Next work (rough priority — pre-D-521, retained for context)

1. **Combat-feel iteration with the stakeholder** — they now have the full
   loop (stance, draw/sheathe, four swings, cast bolts, ragdoll death,
   body carrying) plus the viewer to inspect it. Expect tuning requests:
   swing timing, bolt speed, combat-leave window (all flagged unratified).
2. **Inventory / character-sheet UI** — the stakeholder said "we will get
   into the inventory system later"; body-carrying already touches it.
3. **M4b remainder** — richer injuries (D-205 matrix), Vessel's
   Plane Shift, class skills/balance beyond the scaffold.
4. **Tavern zone dressing round 2** — chairs/hearth/ambience shipped;
   likely next: more prop variety, hearth in the main hall wall,
   sound-level tuning.

## Open items that need JAMIE, not code

- **Creation budget (D-515):** 120 pts / 40 cap / 2 feats / 3 spells —
  placeholder balance in `shared/src/content.ts`.
- **Combat tuning (D-516):** 10s/20-tile combat window, 4-swing roster,
  `CARRY_BASE_CAPACITY + athletics` carry formula — first-pass numbers.
- **Legacy-locked class pricing (D-512)** and **zero Legacy award on
  involuntary endgame death (D-513)** — still unratified.
- **The M2 go/no-go test** — two writers, ninety minutes, the tavern.
  Still never run; BUILD_PLAN's declared gate, and the oldest unpaid debt.
- **Hood reference photos** still only exist in chat (2026-08-17/18);
  worth asking for copies in docs/reference/.

## MR1 state (this session)

Branch `mr-round-spine`. The round spine is **built and bot-verified**:
`shared/src/round.ts` (objectives, phases, D-527 clock),
`server/src/game/round.ts` (pure engine), gateway wiring, wire v4
(`round_state` / `round_role` / `round_ended`), `content/objectives/`
(3 live, 2 planned), `sim/test/mr1-round.test.ts` + `server/test/round.test.ts`.
**232 tests green.**

⚠ **Two traps found the hard way, both now covered by tests:**
- **`gainXp(conn, 25)` on a PLAYER kill violated D-522** — the persistent
  world pays 25 xp + 5 deeds for killing a player, which in a round is
  literally payment for lynching. Now gated on `!this.roundRunning`.
  **Do not remove that guard.**
- A round **opens at dawn**, not midnight. `roundHour()` carries a
  `ROUND_DAWN_HOUR` offset; without it a 25-min round gets three nights
  starting in the dark.

**Test pacing:** the server runs **~60 ticks/s under test load**, not the
nominal 200 — a `lengthTicks` budget sized as if 200 will blow the 30s
vitest timeout. Prefer ending a test round by the DEED (spawn an NPC next
to the antagonist via `server.spawnNpc`) rather than waiting on the clock.

**The cross map is built** (D-529/D-530): `round-town` (settled, the
well/tavern/workshop/storehouse/infirmary) with `round-farm` N,
`round-mine` E, `round-wood` W, `round-south` S (all wilderness +
outdoor), and `round-dungeon` beneath the south approach (wilderness,
NOT outdoor, NOT endgame). **100×100 by measurement, not by feel** — at
64×64 a mid-depth errand measured 20s against D-530's 30-45s ruling;
at 100 it measures ~30s and a deep one ~45s. Regenerate with
`python tools/src/build-round-map.py`; `server/test/round-map.test.ts`
asserts zones, outdoor flags, the transition graph and the travel band,
so none of it can drift silently.

**Not yet built in MR1:** the round HUD (client-side). **MR2:** night
roamers, hunger, gathering/crafting, facility potency (D-530), and the
dungeon's contents — the areas exist but are empty.

## How to work in this repo (hard-won specifics)

- **Dev loop:** `npm run db:up` (Docker Desktop must be RUNNING — start it
  manually), then `npm run dev:server` + `npm run dev:client`. Full verify:
  `npm run typecheck && npm run validate:content && npm test` with
  `DATABASE_URL=postgres://rc:rc@localhost:5433/regnum` (5433, not 5432!).
  Without DATABASE_URL the pg suites silently skip.
- **Tests are the review** (D-114). Suite: **198 tests**, all green at
  handoff, committed on main.
- **Windows shell:** `Start-Process npx` fails — background the server with
  `node node_modules/tsx/dist/cli.mjs server/src/index.ts`. Don't chain
  `$env:X='y'; cmd1 && cmd2` — use separate statements.
- **The visual iteration loop** (use for ALL model/anim/cloth work):
  shot-receiver script in the scratchpad + browser pane on `/viewer.html`,
  drive `window.__viewer` (`solo`, `setAnim`, `setPixel`, `view`,
  `advance`, `await shoot(name)`, `sheet(name)` for the 8-direction
  Muybridge grid, `visuals()` for state inspection). The pane throttles
  timers when hidden: `setTimeout` stalls and busy-waits block the
  websocket callbacks — send in one `javascript` call, read in the next;
  1s `setInterval` still fires for slow marches.
- **Review standard (stakeholder):** garment/model changes are judged on
  ALL FOUR archetypes from EIGHT directions — `sheet()` after soloing one
  extreme seed per archetype. The sheet frames from the character's own
  height (used to decapitate brutes).
- **Garment sizing (D-519/D-520):** `appearance.height` is NOT rig height.
  Hanging garments size off `measurements.capeAnchorY`; cuts off shoulder
  span; collars off `headH`. Tune in the viewer's Cloth tab, export, and
  bake the export into `CharacterVisual` — presets must be re-baselined to
  match afterwards so the workbench zero stays truthful.
- **Ragdoll traps** (all covered by tests, don't re-learn): verlet impulse
  needs ×dt on the first step; settle checks need an age guard; the floor
  is where the character STOOD, not root height; `setDead(false)` must
  clear `deathStart` or the guard blocks every later fall.
- **Split-render traps:** lights AND camera need `layers.enableAll()`
  AFTER terrain builds (the hearth adds lights); the composite must
  depth-test both passes (`palette.ts`) or characters float over walls.
- **Bot-test flake traps:** never `Promise.race` two `bot.expect(...)`
  calls; character names are LETTERS ONLY (no digits); tests shrink combat
  pacing via `combatLeaveTicks`/`combatProximityTiles` server options.
- **Albedo lesson:** if a new prop renders near-black, brighten the
  ALBEDO, not the lights.

## Manual testing quick-reference (for Jamie)

Two browser windows on `http://localhost:5173`, accounts
`jamie_dev_one/two` (password `dev-only-passphrase`). The creation wizard
runs on "Begin someone new". Combat: right-click → Attack (wilderness
yard; declare hostility first in the settled tavern), watch the draw →
stance → swing → ragdoll loop; corpses offer "Carry the body". ⚙ Settings
(top right in-game) tunes pixelation live. The viewer at `/viewer.html`
has tabs: Cast (seeds/editor), Animation (all clips incl. combat + both
deaths), Cloth (the workbench — export JSON and paste it to Claude to
bake), Render (lighting/pixelation).

## State of the running dev environment at handoff

- Dev Postgres container `regnumconfractum-db-1` (port 5433) was running.
  Migrations through `0008_character_build.sql` applied.
- A game server may be running on :8080 from this session (background
  task); kill the listener before starting a new one
  (`Get-NetTCPConnection -LocalPort 8080`). The vite client on :5173 may
  belong to ANOTHER session — it serves the same files; just reuse it.
