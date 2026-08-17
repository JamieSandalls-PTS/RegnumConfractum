# Session handoff — written 2026-08-17

**For the next Claude Code session.** Read `CLAUDE.md` first as always; this
file is the working context that doesn't belong in the ADR: where things
stand mid-milestone, what to do next, and the traps already stepped in once.
Delete or rewrite this file at the end of the next session.

---

## Where the project stands

Milestones M0–M3 are **complete** (M0 harness, M1 renderer, M2 roleplay
core, M3 scripting + DM toolset — see D-501…D-508). M4 is **half done**:

- ✅ M4a (D-509): cooldown combat, D-206 hostility zones, the full death
  loop with the ghost-plane partition, injuries with the physician
  dependency, death triggers wired into the DM event engine.
- ✅ M4b part 1 (D-510): voluntary permadeath + Legacy Points (account-level,
  deeds-scaled, diminishing on repeat sacrifice).
- ⬜ M4b remainder — **this is the next work**, in rough priority order:
  1. **Spirit interactions (D-204/D-224)** — the biggest chunk. Needs:
     corpses as world objects (a dead player leaves one wearing their
     carried gear per D-224 — item ownership moves to the corpse), Speak
     With Dead (ghost pulled to corpse, five questions, free to lie),
     Animate Dead (corpse walks as NPC-like ally; owner may observe and
     speak in garbled undead register — the language scrambler is reusable
     for this), gear drops when the zombie is destroyed. Open sub-decisions
     flagged in DECISIONS.md "Open decisions": respawn-while-body-walks
     (recommend yes, needs Jamie), duration cap (suggest tying to a
     necromancer skill stat).
  2. **Endgame permadeath zones** — `zone: 'endgame'` already parses in the
     area schema; wire `die()` to auto-retire (no Legacy award — involuntary)
     unless revived within a time limit (revival mechanic needed: a `revive`
     action by another player within N ticks of the fall, before ghosting).
     Unmissable warning on transition into an endgame area (D-206).
  3. **Richer injuries** — burn/frost/venom/rot/curse types with distinct
     treatment paths (D-205's matrix is bulk content generation — a good
     schema-validated content job).
  4. **Classes/skills (D-208)** — ⚠️ BLOCKED on Jamie choosing the 8–10
     launch archetypes (asked twice, no answer yet — ask again, offer a
     shortlist). The Legacy spend side (RP-locked classes) hangs on this.

After M4: **M5 — world content and economy** (map editor, crafting/recipes,
the orphan-item CI validator activating in full graph mode per D-210,
economy telemetry dashboard per D-221, witness-based reputation D-217).

## Open items that need JAMIE, not code

- **Class roster (D-208)** — the one hard blocker in M4.
- **Art direction final ratification (D-406/D-504)** — partial: dark=interior
  ratified, overcast added; models/animations flagged as needing work. A
  spawn-task chip for a model/animation pass was offered
  (task_e4044b77) — may still be pending in their UI.
- **The M2 go/no-go test** — two writers, ninety minutes, the tavern. Never
  run with real humans. This is BUILD_PLAN's declared gate for the whole
  project and only Jamie can arrange it.
- **Staging VPS (D-111)** — not provisioned. Compose file + Dockerfile are
  ready; when Jamie supplies a VPS, staging is a short session (Caddy, TLS,
  nightly off-box backups).

## How to work in this repo (hard-won specifics)

- **Dev loop:** `npm run db:up` (Docker Desktop must be RUNNING — start it
  manually, it does not autostart), then `npm run dev:server` +
  `npm run dev:client`. Full verify: `npm run typecheck && npm run
  validate:content && npm test` with
  `DATABASE_URL=postgres://rc:rc@localhost:5433/regnum` (5433, not 5432!).
  Without DATABASE_URL the pg suites silently skip.
- **Tests are the review** (D-114). Every mechanic ships with a bot test in
  `sim/test/`. Current suite: 135 tests, all green at handoff, pushed as
  the `M4b` commit on main.
- **The tick is the only clock.** Server logic, Lua timers, event triggers,
  ghost minimums, bleed — all tick-counted. Tests shrink pacing via
  GameServerOptions (tickIntervalMs, ghostMinTicks, …). Never introduce
  Date.now() into game logic.
- **Plane partition discipline:** any NEW delivery path (new broadcast, new
  personalized send) must partition on `entity.ghost` in both directions.
  Grep `broadcastPlane` for the pattern. The bots in `m4-death.test.ts`
  will catch leaks — extend them when adding channels.
- **Names never ride the wire as facts.** Anything observer-facing goes
  through `descriptorsFor` (per-observer knowledge). Same discipline for
  any new entity-referencing message.
- **Bot-test flake traps (stepped in twice):** never `Promise.race` two
  `bot.expect(...)` calls — losing waiters linger and swallow later
  messages. Poll `bot.status` / mirror state instead, and `bot.drain(t)`
  stale snapshots before resync assertions. Walk loops must tolerate
  arrival drift from queued move intents.
- **Browser-pane verification:** the pane rarely composites → rAF and
  timers freeze. Use the client's `window.__rc` hook (step frames, read
  mirror, send intents directly) and capture canvases by POSTing a dataURL
  to a throwaway local HTTP receiver (see D-503; examples in git history).
  DM/admin flows are easier to verify with plain `Invoke-RestMethod`
  against `http://localhost:8081`.
- **Windows shell:** `Start-Process npx` fails (cmd shim) — background the
  server with `node node_modules/tsx/dist/cli.mjs server/src/index.ts`.
  Don't chain `$env:X = 'y'; cmd1 && cmd2` — PowerShell parse quirks; use
  `if ($LASTEXITCODE -eq 0)`.
- **Albedo lesson (learned 3×, now written):** mid-tone source colours or
  the palette quantiser starves. If a new area/prop renders near-black,
  brighten the ALBEDO, not just the lights.

## State of the running dev environment at handoff

- Dev Postgres container `regnumconfractum-db-1` (port 5433) holds test
  accounts `jamie_dev_one/two` (password `dev-only-passphrase`) with
  characters in the yard/tavern, plus bot-test residue. Safe to wipe:
  `docker compose down -v` and migrations rebuild everything.
- A dev game server and the Vite client may still be running from the last
  session (ports 8080/8081/5173) — kill stray `node` processes matching
  `server/src/index.ts` before starting fresh ones (EADDRINUSE otherwise).

## Suggested next-session opening move

Start with **corpses + Speak With Dead** (the two halves of D-204 that need
no stakeholder input), each as a slice with bot tests; ask Jamie for the
class shortlist in the first message; offer the endgame-zone revival design
for a quick yes/no while implementing.
