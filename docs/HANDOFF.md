# Session handover — written 2026-08-19 (MR1 complete, MR2 most of the way)

**For the next Claude Code session.** Read `CLAUDE.md` first as always; this
file is the working context that does not belong in the ADR — where things
stand, what to do next, and the traps already stepped in once so you do not
have to step in them again. Rewrite it at the end of your session.

---

## Where the project stands

**Branch `mr-round-spine`, 17 commits ahead of `main`. Main is untouched.**
The stakeholder has not asked for a merge; ask before fast-forwarding.

**317 tests green**, content validator green over 52 files.
`npm run typecheck && npm run validate:content && npx vitest run`.

The project pivoted this session-series to **MR — the Round** (D-521): a
20–30 minute scenario with a hidden antagonist and no respawn. The persistent
world (M5–M7) is resequenced behind it, not cancelled.

### MR1 — the round spine: COMPLETE

Round lifecycle on its own clock, secret antagonist assignment, objectives as
validated content, victory evaluation, no-respawn death, xp banking and
forfeit, round reset, day/night lighting, free-but-loud violence, the cross
map, the HUD, and the combat sound cue. Verified live in three browsers.

### MR2 — the loop inside the round: MOSTLY BUILT

| Piece | State |
|---|---|
| Gathering and crafting | built, bot-verified, playable in the client |
| Invariant 2 (no orphan items) | **ENFORCED in CI** — first time since Phase 2 |
| Night roamers (D-532) | built, bot-verified |
| Hunger and thirst (D-533, D-534) | built, bot-verified; starvation kills |
| Stations as real objects (D-534) | built |
| Three dungeon floors (D-535) | **geometry and gates built, CONTENTS EMPTY** |
| Dawn truce (D-536) | built, bot-verified |
| Storehouse depletion | **NOT BUILT — see below** |

---

## What to do next, in the order I would do it

### 1. The dungeon's contents ⚠ the biggest hole

Three floors of empty cavern. **No monsters, no loot, no reason to descend.**
D-523 calls the dungeon the round's separation engine — the thing that pulls
the cast apart voluntarily so the antagonist can act — and it cannot separate
anybody while it is empty. Everything else in MR2 is finished enough to play
around; this is not.

Needs: a per-floor monster table (the roamer system in `gateway.ts` is the
obvious thing to generalise — it already spawns, hunts, strikes and despawns),
loot on death, and a reward gradient that makes floor 2 worth the second day.

### 2. The storehouse must RUN OUT

D-529 identified this and it is still open. **Hiding in town beats the clock**
unless the town's food supply depletes. Bread needs grain, grain is on the
farm, so the pressure exists in principle — but nothing stocks the town with a
starting supply that then runs down. A cast that begins fed and never leaves
is only pressured after the first hunger step.

This is content and tuning, not systems. Probably: a storehouse stock counter
that starts at N meals and is drawn down by eating at the facility.

### 3. Per-round procedural dungeon layouts (D-535)

The floors are authored and identical every round. Generating their shape at
**round start** — before anyone is inside, so the eviction problem never
arises — gives variety across rounds to go with the deepening within one.
Self-contained; the round already spawns nodes, roamers and stations into an
empty world, and a layout is the same move.

### 4. Facility potency beyond meals (D-530)

Stations are real objects now, so the door is open. Eating at the storehouse
already holds you 1.5× longer. Healing at the infirmary should beat a field
bandage; crafting at the workshop should beat improvising. ⚠ Keep the band at
**1.5×–2×**: if facilities are much better, field goods become worthless,
everyone pools, and one act of sabotage decides every round.

---

## Blocked on the stakeholder

- **Night tuning** — roamer `perArea` and `aggroTiles` together decide whether
  night is a decision or a wall. Currently 8 dogs (aggro 20) and 3 walkers
  (aggro 26) per outdoor wilderness area, after measurement showed the first
  guess was far too sparse.
- **Whether roamers may enter settled areas.** I ruled NO to keep the town a
  refuge; it is one line in `roamerAreas()`.
- **Whether an objective may sit inside the dungeon.**
- **Multiple antagonists above a cast size**, and whether they know each other.
- **Minimum party size to enter the dungeon** at low cast counts.
- **What a revived player returns with.**
- Older, still open: creation budget (D-515), combat window and carry formula
  (D-516), Legacy class pricing (D-512), zero-award endgame death (D-513).

---

## How to run it

```bash
npm run db:up   # Docker Desktop must already be RUNNING — start it by hand
```

Then, for round mode (it is **OFF by default** — an unconfigured server is
still the persistent world):

```bash
DATABASE_URL=postgres://rc:rc@localhost:5433/regnum ROUND_MODE=1 ROUND_MIN_CAST=3 DEFAULT_AREA_ID=round-town npm run dev:server
```

Optional: `ROUND_LENGTH_TICKS`, `ROUND_SEED`. Note **5433, not 5432**; without
`DATABASE_URL` the pg suites silently skip.

Client: `npm run dev:client`, two or three browser windows on
`http://localhost:5173`. Accounts `jamie_dev_one/two`, password
`dev-only-passphrase`. In game: **I** for the pack, **C** for the workbench,
right-click a node to "Work it".

⚠ **`DEFAULT_AREA_ID` only applies to NEW characters.** Existing ones load at
their saved position, so a dev character stays wherever it last stood. This
wasted a walk across two areas before I noticed.

Regenerate the map with `python tools/src/build-round-map.py`.

---

## Traps, all paid for once already

**Test traps**

- **A death ends the round, and a round reset clears everything.** Any suite
  with a bot that dies — starving, or alone in the wilderness at dusk — is
  measuring the reset rather than the thing it meant to measure. Starvation
  has its own file and its own server for exactly this reason.
- **One blow interrupts work.** Do not loop attacks in a test: the first swing
  does the job and the rest kill the subject, breaking every later test.
- **`ATTACK_RANGE` is 1.** Spawn a target at `x + 1`, not `x + 2`.
- **An unwalkable spawn is silently RELOCATED to the area spawn.** A bot placed
  on the tavern's wall corner ended up two tiles from the well and spent a
  whole suite quietly drinking while an assertion waited for "no water here".
  A position in a wall does not error — it teleports.
- **The server runs ~60 ticks/s under test load, not the nominal 200.** Budget
  `lengthTicks` accordingly, or better, end a test round by the DEED (spawn an
  NPC next to the antagonist via `server.spawnNpc`) rather than by the clock.
- **`round.dayTicks` and `round.graceTicks` are server options** so tests can
  reach dusk or skip the truce. Every suite not about the truce sets
  `graceTicks: 0`.
- **The mine is dense with rock and a greedy walker wedges on the first
  outcrop.** `mr2-gathering.test.ts` reuses the CLIENT's A*
  (`client/src/game/path.ts`).

**Code traps**

- **`enterCombat(self)/(target)` appears in BOTH `handleHostile` and
  `handleAttack`.** A naive find-and-replace patches the wrong one; combat
  noise silently fired on declarations instead of blows for a while.
- **`sendWork` must be passed the job explicitly.** Completion clears
  `conn.work` first, so reading it there reported every finished craft as a
  harvest.
- **Spawning into the world does not tell anybody.** `spawnNodes` wrote
  entities with no broadcast and they were invisible to every client that
  snapshotted before the round began — which is all of them, since the round
  is what spawns them.
- **The xp guard on player kills must not be removed.** `gateway.ts`
  `handleAttack` grants 25 xp + 5 deeds for killing a player in the persistent
  world; in a round that is payment for lynching, so it is gated on
  `!this.roundRunning`. `sim/test/mr1-round.test.ts` asserts it.
- **Never make the round dungeon `endgame` tier.** That carries involuntary
  permadeath, and a round death must not cost a character levelled across
  fifty rounds. `server/test/round-map.test.ts` asserts it.
- **Do not infer `outdoor` from `lighting`.** Lighting is a render profile; a
  bright cavern or a gloomy field breaks the coupling immediately.

**Older, still true** — Windows shell: `Start-Process npx` fails; background
the server with `node node_modules/tsx/dist/cli.mjs server/src/index.ts` and
redirect to a file (piping to `head` closes the stream and kills it). Do not
chain `$env:X='y'; cmd1 && cmd2`.

---

## The one thing I would tell you if you only read a sentence

MR2's systems are largely done and the round is playable, but **the dungeon is
empty**, and the dungeon is the mechanism that makes a hidden antagonist
possible at all. Fill it before tuning anything else.
