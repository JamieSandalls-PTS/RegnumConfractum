# Session handoff — written 2026-08-17 (evening session)

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
- ⬜ M4b remainder, rough priority:
  1. **Endgame permadeath zones** — `zone: 'endgame'` parses but only
     `gateway.ts` line ~497 reads zones at all. Wire `die()` to auto-retire
     (involuntary — NO Legacy award) unless revived by another player within
     a time limit before ghosting (new `revive` action). Unmissable warning
     on transition into an endgame area (D-206). A task for this exists in
     the session task list.
  2. **Richer injuries (D-205)** — burn/frost/venom/rot/curse types with
     distinct treatment paths; the description matrix is bulk
     schema-validated content generation.
  3. **Vessel's Plane Shift** — the ability id `plane-shift` exists and is
     granted by `content/classes/vessel.json`, but no mechanic reads it yet.
     Design note: it likely reuses the séance's "sanctioned crossing"
     pattern, perception-only.
  4. **Class depth** — the scaffold gates abilities; actual skills/balance
     (D-208's real scope) remains.

## ⚠ After M4: UI FIRST, then M5

**Jamie's explicit roadmap call (2026-08-17): once M4 closes, build basic UI
and user functions BEFORE starting M5** (world content and economy). Scope of
"basic UI" to be clarified with Jamie — obvious candidates: clickable
inventory/equipment, character sheet, class selection at creation (the
protocol field exists), target selection instead of nearest-only slash
commands, séance/observe affordances, settings/account surfaces.

## Open items that need JAMIE, not code

- **Legacy-locked class pricing.** Creation of Bonespeaker/Vessel currently
  requires ≥1 Legacy Point on the account and deducts NOTHING — an explicit
  placeholder (flagged in D-512). Jamie must ratify real costs.
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
- **Tests are the review** (D-114). Suite: **152 tests**, all green at
  handoff, committed on main. Spirit mechanics: `sim/test/m4c-spirits.test.ts`.
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
session: `/loot`, `/speakdead`, `/animate`, `/observe [off]`. Admin UI
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
