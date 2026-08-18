# Session handoff — updated 2026-08-18

## Most recent work (D-515): creation screen, split pixelation, bubbles

- **Character creation wizard** (`client/src/creation.ts`, markup in
  `client/index.html`): calling → skills → feats → spells → name. Rendered
  entirely from the server's `creation_content` message; the catalogues
  live in `content/skills|feats|spells/` and on the class files
  (`affinities`, `spellcasting`). `validateBuild()` in `shared/src/content.ts`
  is the ONE rule set — client for feedback, server for authority.
  Tests: `sim/test/m5a-creation.test.ts` (15).
  ⚠ Budget numbers (120 points / 40 cap / 2 feats / 3 spells) are
  placeholder balance awaiting stakeholder ratification.
- **Split pixelation is the default again**: characters on layer 1 through
  the quantiser, world crisp. Settings panel (⚙ top-right) tunes both
  scales independently and persists to localStorage. Two gotchas, each
  worth a cycle:
  1. `scene.enableAllLayers()` must run AFTER `new Terrain(...)` — the
     hearth adds its own point lights; miss it and the split pass is black.
  2. Two passes = two depth buffers. The composite MUST depth-test
     (`tCharDepth` vs `tEnvDepth` in palette.ts) or characters float over
     every chair and wall. `post.depthOcclusion = false` reproduces the
     old broken overlay for A/B verification.
- **Speech bubbles**: DOM elements above the speaker's head. Hearing range
  is NOT a client concern — the server already filters by channel and line
  of sight, so an arriving message is itself the permission to draw.
- **Brute bust fix**: bust volume tracks body width only to a cap
  (`bustDims()` in character.ts).

**Verification note for the next session:** the browser pane throttles
timers when hidden, so `busy()` spin-waits BLOCK the websocket callback —
send in one tool call, read in the next. Speech bubbles expire on a timer,
so a bubble sent in one call is usually gone by the third; send and
screenshot in adjacent calls.

---

# Previous handoff — written 2026-08-17 (evening session)

**For the next Claude Code session.** Read `CLAUDE.md` first as always; this
file is the working context that doesn't belong in the ADR: where things
stand mid-milestone, what to do next, and the traps already stepped in once.
Delete or rewrite this file at the end of the next session.

---

## Where the project stands

M0–M3 complete; M4 is nearly done:

- ✅ M4a (D-509): combat, death loop, injuries, physician dependency.
- ✅ M4b part 1 (D-510): voluntary permadeath + Legacy Points.
- ✅ M4b part 2 (D-511/D-512, this session): **spirit interactions + class
  scaffold.** Corpses as persistent world objects, zone-dependent gear rules,
  looting, Speak With Dead (séance bridge, beyond-reach), Animate Dead
  (cap/duration/gear-drop/ride-along in the undead register), decay → ground
  pile → logged cleanup, the nine D-511 classes as content with ability
  gating, DM grant-item/set-skills verbs, and six pre-existing ghost-plane
  broadcast leaks fixed. 152 tests green at handoff.
- ✅ M4b part 3 (D-513, this session): **endgame permadeath zones.**
  Two-step entry warning, the downed state, `revive`, involuntary
  permadeath (zero award — see stakeholder items), `sunken-crypt` authored
  off the yard's south end. `sim/test/m4d-endgame.test.ts`.
- ⬜ M4b remainder, rough priority:
  1. **Richer injuries (D-205)** — burn/frost/venom/rot/curse types with
     distinct treatment paths; the description matrix is bulk
     schema-validated content generation.
  2. **Vessel's Plane Shift** — the ability id `plane-shift` exists and is
     granted by `content/classes/vessel.json`, but no mechanic reads it yet.
     Design note: it likely reuses the séance's "sanctioned crossing"
     pattern, perception-only.
  3. **Class depth** — the scaffold gates abilities; actual skills/balance
     (D-208's real scope) remains.

## ⚠ After M4: UI FIRST, then M5

**Jamie's explicit roadmap call (2026-08-17): once M4 closes, build basic UI
and user functions BEFORE starting M5** (world content and economy).

**Partially begun early at Jamie's direction (D-514, same day):** click-to-move
with A*, hover highlights, target selection, right-click context menus, the
1–9 hotbar with drag-and-drop, wheel zoom + drag orbit, character model v3
(two review rounds applied: corrected joint conventions, lathe-turned blended
torso, deltoids/feet/hair sculpted, proportions calibrated from screenshots),
and the character viewer at `/viewer.html` for art feedback. **Jamie owes
round-3 feedback on the viewer** — quote seeds when judging. Still open for
the UI milestone: clickable inventory/equipment, character sheet, class
selection at creation (protocol field exists), séance/observe affordances,
settings.

**Stakeholder model editor:** the viewer has an "Open editor" panel — solo a
seed, pick parts by SEMANTIC NAME (pelvis…right foot, tagged via nm() in
character.ts), nudge with labelled slider+number pairs, hide parts, add
primitives, and export a JSON of deltas. When Jamie pastes an export, map
part names straight to the nm()-tagged construction lines and bake the
changes into the generator.

**The visual iteration loop (USE THIS for all model/animation work):**
1. `node <scratchpad>/shot-receiver.mjs <scratchpad>` in the background
   (writes POSTed dataURLs as PNGs; script is in the session scratchpad —
   recreate from D-514's description if gone).
2. Browser pane on `/viewer.html`, then drive `window.__viewer` via
   javascript: `solo(seed)`, `setAnim('walk')`, `setPixel(false)`,
   `view(azimuthRad, zoom, orbitHeight)` (π/2 = front since models face +Z;
   0 = side; orbitHeight ~1.4 for eye-level), `advance(seconds)`,
   `await shoot('name')` — then Read the PNG and LOOK at it.
   Works even when the pane isn't compositing (no rAF needed).
3. Judge front AND side, adjust, re-shoot. Also re-check at
   `setPixel(true, 4)` grid view — game distance hides some sins and
   creates others.

**Model conventions that cost a debugging cycle each — do not re-learn:**
- Models face +Z; for hanging children `rotation.x > 0` swings BACKWARD
  (knees positive, forward-pointing thighs negative, elbows negative).
- The ribcage lathe must stop BELOW the neck root or heads sit buried.
- Keep torso volumes' seam radii matching (seamHip/seamWaist consts).
- Width floors matter: slight seeds go stick-figure without them.

## Open items that need JAMIE, not code

- **Legacy-locked class pricing.** Creation of Bonespeaker/Vessel currently
  requires ≥1 Legacy Point on the account and deducts NOTHING — an explicit
  placeholder (flagged in D-512). Jamie must ratify real costs.
- **Zero Legacy award on involuntary endgame death (D-513).** Implemented
  per the recorded recommendation but never explicitly ratified. Also
  unratified tuning: the 60s revival window, quarter-hp revival, and the
  execution rule (a blow while downed ends it instantly).
- **Art direction ratification (D-406/D-504)** — still partial; corpse pose
  (rotated-flat placeholder) and pile visual (two boxes) are explicitly
  art-pass work.
- **The M2 go/no-go test** — two writers, ninety minutes, the tavern. Still
  never run; BUILD_PLAN's declared gate.
- **Staging VPS (D-111)** — not provisioned.

## How to work in this repo (hard-won specifics)

- **Dev loop:** `npm run db:up` (Docker Desktop must be RUNNING — start it
  manually), then `npm run dev:server` + `npm run dev:client`. Full verify:
  `npm run typecheck && npm run validate:content && npm test` with
  `DATABASE_URL=postgres://rc:rc@localhost:5433/regnum` (5433, not 5432!).
  Without DATABASE_URL the pg suites silently skip.
- **Tests are the review** (D-114). Suite: **158 tests**, all green at
  handoff, committed on main. Spirit mechanics: `sim/test/m4c-spirits.test.ts`;
  endgame zones: `sim/test/m4d-endgame.test.ts`.
- **The tick is the only clock.** Corpse decay, ground-loot cleanup, zombie
  duration are all tick-counted (`corpseDecayTicks`, `groundLootTicks`,
  `zombieDurationTicks` in GameServerOptions; corpse decay clamps to
  ≥ ghostMinTicks per D-511). `corpses.ticks_left` persists the REMAINDER at
  last state transition — restarts err long, never destroy items.
- **Plane partition discipline:** every delivery path partitions on
  `entity.ghost` both ways. The ONE sanctioned crossing is the séance +
  body-observer bridging in `deliverSpeech`/`seanceRelays` — speech-only,
  logged. Any new crossing needs the same treatment and a bot test.
- **Item ownership is now one-of** (character XOR corpse,
  `items_one_owner` check). Bulk moves (`moveItemsToCorpse` etc.) are single
  conditional UPDATEs — keep the atomicity argument when extending. The ONLY
  item sink is `deleteItemsByCorpse`, called exclusively by pile cleanup and
  always logged (`corpse_loot_cleanup`).
- **The undead register is a language** (`undead` in
  `content/languages/languages.json`) that no character learns; the
  scrambler does the garbling; the event log keeps originals. Don't grant it
  to characters casually — knowing it would let players READ zombie speech.
- **Corpse descriptors go through identity knowledge** (D-219): "the corpse
  of ⟨known-name-or-description⟩" via `describeDead` in gateway. Presentation
  (hooded) survives death deliberately.
- **Bot-test flake traps:** never `Promise.race` two `bot.expect(...)`
  calls — poll `bot.status`/mirror state instead; `bot.drain(t)` stale
  snapshots; walk loops tolerate drift. Séance tests: use
  `speeches.slice(before)` deltas, not absolute counts.
- **Windows shell:** `Start-Process npx` fails — background the server with
  `node node_modules/tsx/dist/cli.mjs server/src/index.ts`. Don't chain
  `$env:X='y'; cmd1 && cmd2` — use separate statements /
  `if ($LASTEXITCODE -eq 0)`.
- **Albedo lesson:** if a new prop renders near-black, brighten the ALBEDO,
  not the lights (PileVisual's 0xb5875a/0xcfc39a were chosen for this).

## Manual testing quick-reference (for Jamie)

Two browser windows on `http://localhost:5173`, accounts
`jamie_dev_one/two` (password `dev-only-passphrase`). Commands added this
session: `/loot`, `/speakdead`, `/animate`, `/observe [off]`, `/revive`.
The Sunken Crypt (endgame — real permadeath!) is through the marker at the
yard's south end; the warning ritual is step-on, step-off, step-on. Admin UI
(`http://localhost:8081`) now has **Grant item** (e.g. bandages for /treat
testing) and **Set skills** (necromancy raises the zombie cap: 0→1, 40→2,
80→3). To play a Bonespeaker: retire a throwaway character first (earns the
Legacy Point the placeholder gate needs), then create with the class — the
client has no class picker yet, so create via a bot/wscat or wait for the UI
pass.

## State of the running dev environment at handoff

- Dev Postgres container `regnumconfractum-db-1` (port 5433). Migration
  `0007_spirits.sql` applies on next server/test start (`PgStore.init()`
  runs migrations automatically). Safe to wipe: `docker compose down -v`.
- No dev servers were left running (killed at session start; none started).

## Round 15 (2026-08-17, late): clothing state, mid-iteration

- CAPE: attachment is a YOKE across the upper back rising over the deltoid
  tops (cloth.ts collar layout, `over` factor 0.75, ends +/-115deg). Review
  capes from TOP-ANGLE views (game camera h=8.5, plus h=30/60) - eye-level
  views hid every failure the stakeholder caught.
- ROBE skirt: elliptical waist rows (zk 0.68->1 by row 4) fix the belt gap;
  rigid rows = 2; floor collision keeps hems pooling when seated.
- HOOD (round 16, this session): rebuilt as a hand-lofted RIDGE TENT —
  centre ridge polyline (tip over the brow → near-horizontal over the
  crown → ONE straight diagonal to the nape) plus per-side mid and rim
  polylines laddered into flat triangles (character.ts refreshHood; the
  `ladder` helper preserves authored corners). The cone+dome assembly is
  gone — its apex read as a forward horn from the side. Verified vs both
  reference photos: front = pointed arch, face visible; side = horizontal
  top edge, one diagonal, face hidden by the side sheet. A worn hood now
  hides the hair ENTIRELY (stakeholder ruling, later same day — no fringe
  peeking; the bun used to bulge through the shell). Flaps shrunk to
  narrow jaw drapes.
  Reference images still only live in chat (2026-08-17) — worth asking
  the stakeholder to drop copies in docs/reference/.
- Stakeholder rulings this stretch (record in DECISIONS.md when the art is
  ratified): palette pixelation IS the character direction; reference-
  driven 8-direction review is the workflow; in-house verlet stays over
  Jolt/ammo (assessment given 2026-08-17); clothing/hair physics-based.

## Walk cycle (2026-08-17, late): grounded and reference-tuned

- Grounding: animWalk SOLVES pelvis height each frame from the actual leg
  angles (ankle drop + heel/toe contact by pitch) so the lower foot always
  touches y=0 — stakeholder invariant "at no point both feet off the
  floor". Regression: `client/test/walk-grounding.test.ts` (fails on the
  old code).
- Bob amplitude: the raw pendulum arc bobbed 9-10cm (~6% of height). Root
  cause was SWING TIMING — toe-off fired before the opposite heel struck
  (lift phase +2.17), leaving single support on a fully tilted leg. Now
  +1.2 → ~8% double support per step (Inman), plus stance-knee mid-flex
  (Saunders' 3rd determinant, 0.22 rad) and strong push-off heel rise
  (0.55 rad). Measured 3.0-3.9cm = 1.8-2.4% of height vs the ~1.8%
  reference; the test pins the band [0.8%, 3%].
- Robe shoulder caps recentred/enlarged to swallow deltoid + arm joint
  ball (bare arm showed above the sleeve rim — stakeholder).

## Character creator (2026-08-17, stakeholder-requested range-finder)

- `/creator.html` (client/src/creator.ts): standalone page, one character,
  EVERY appearance parameter on an explicit control with its numeric value
  shown — sex, bust (female-only slider), skin/hair/robe/tunic colours
  (palette swatches + free picker + hex readout), height, bulk, shoulder,
  limb, head scale, archetype presets, hair style/length, clothing
  toggles, weapon, hood-up, all animations, lighting profiles, raw vs
  pixelated, and an Export-values button. Purpose: the stakeholder pushes
  sliders till the model breaks, then ratifies creation ranges — slider
  bounds are deliberately wider than ARCHETYPES.
- To support it: `Appearance.bust` (0..1) added at the END of the seed
  draw order (existing seeds keep their look; seeded range 0.35–0.65,
  0.5 = the old fixed size exactly); CharacterVisual's constructor now
  accepts a full Appearance object as an alternative to a seed;
  bust drives breast/bodice geometry and the hair collider.
- Automation hook: `window.__creator` (set/get/view/advance/shoot), same
  screenshot-receiver workflow as the viewer.
- NOT yet in-game: creation flow/protocol unchanged (class picker and
  appearance creation UI remain for the UI milestone). Ranges chosen in
  the creator must be baked into ARCHETYPES / a creation schema once
  ratified.
