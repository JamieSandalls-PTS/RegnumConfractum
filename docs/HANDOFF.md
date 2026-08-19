# Session handover — written 2026-08-19 (MR1 done, MR2 done bar one piece)

**For the next Claude Code session.** Read `CLAUDE.md` first as always; this
file is the working context that does not belong in the ADR — where things
stand, what to do next, and the traps already paid for once. Rewrite it at the
end of your session.

---

## Where the project stands

**On `main`, merged and clean.** The MR work was developed on
`mr-round-spine` and fast-forwarded into `main` at the stakeholder's request;
both refs point at `D-537`, and the branch can be deleted whenever. Nothing is
pushed — `main` sits well ahead of its upstream, which is normal for this repo.

**322 tests green**, content validator green over 58 files.

```bash
npm run typecheck && npm run validate:content && npx vitest run
```

The project pivoted to **MR — the Round** (D-521): a 20–30 minute scenario
with a hidden antagonist and no respawn. The persistent world (M5–M7) is
resequenced behind it, not cancelled. Decisions **D-521 through D-537** cover
the whole of it and are worth skimming in order — they read as one argument.

### MR1 — the round spine: COMPLETE

Round lifecycle on its own clock, secret antagonist assignment, objectives as
validated content, victory evaluation, no-respawn death, xp banking and
forfeit, round reset, day/night lighting, free-but-loud violence, the cross
map, the HUD, and a procedural combat sound cue. Verified live in three
browsers.

### MR2 — the loop inside the round: BUILT BAR ONE PIECE

| Piece | State |
|---|---|
| Gathering and crafting | built, bot-verified, playable in the client |
| Invariant 2 (no orphan items) | **ENFORCED in CI** — first time since Phase 2 |
| Night roamers (D-532) | built, bot-verified |
| Hunger and thirst (D-533) | built, bot-verified |
| Starvation kills (D-534) | built, bot-verified |
| Stations as real objects (D-534) | built |
| Three dungeon floors (D-535) | built — day-gating and the dusk seal |
| Dawn truce (D-536) | built, bot-verified |
| Dungeon contents (D-537) | built, bot-verified — dwellers, loot, gradient |
| **Storehouse depletion** | **NOT BUILT — the last gap** |

---

## What to do next

### 1. Play a round. Honestly, this first.

Everything MR2 needs to be playable exists — gather, craft, eat, drink, night,
dungeon, truce — and **nobody has played one end to end.** There are roughly
two dozen unratified numbers riding on it (listed below). Three people in one
25-minute round will tell you more about which of them are wrong than any
amount of further building, and several can only be judged by feel.

This is also the long-deferred **M2 go/no-go gate**, which D-521 absorbed into
the MR gate: if a round with a hidden traitor is not compelling, that is the
signal to stop and reconsider rather than to build more.

### 2. The storehouse must RUN OUT

D-529 identified this and it is the last real gap. **Hiding in town beats the
clock** unless the town's food supply depletes. Bread needs grain and grain is
on the farm, so the pressure exists in principle — but nothing stocks the town
with a starting supply that then runs down, so a cast that begins fed and
never leaves is only pressured after the first hunger step.

Content and tuning rather than systems. Probably a storehouse stock counter
that starts at N meals and is drawn down by eating at the facility.

### 3. Per-round procedural dungeon layouts (D-535)

The floors are authored and identical every round. Generating their shape at
**round start** — before anyone is inside, so the eviction problem that
motivated the floors never arises — gives variety across rounds to go with the
deepening within one. Self-contained: the round already spawns nodes, roamers,
stations and dwellers into an empty world, and a layout is the same move.

### 4. Facility potency beyond meals (D-530)

Stations are real objects now, so the door is open. Eating at the storehouse
already holds you 1.5× longer. Healing at the infirmary should beat a field
bandage; crafting at the workshop should beat improvising. ⚠ Keep the band at
**1.5×–2×**: if facilities are much better, field goods become worthless,
everyone pools, and one act of sabotage decides every round.

---

## Blocked on the stakeholder

Everything below is a number or a ruling I could not settle from the code.
The **tests assert shapes rather than values** throughout, so all of it can be
retuned without assertions going stale.

- **Night danger** — roamer `perArea` and `aggroTiles` together decide whether
  night is a decision or a wall. Currently 8 dogs (aggro 20) and 3 walkers
  (aggro 26) per outdoor wilderness area.
- **Dungeon tuning** — floor 3's warden (34 hp, 6–10 damage, 55 xp) is the
  number most likely to be wrong: it opens with five minutes left and has
  never been fought in a real round.
- **Whether roamers may enter settled areas.** I ruled NO to keep the town a
  refuge; one line in `roamerAreas()`.
- **Whether an objective may sit inside the dungeon.**
- **Multiple antagonists above a cast size**, and whether they know each other.
- **Minimum party size to enter the dungeon** at low cast counts.
- **What a revived player returns with.**
- **Hunger/thirst step rates** (8 and 6 game hours) and the starvation rate
  (2 hp per game hour).
- Older, still open: creation budget (D-515), combat window and carry formula
  (D-516), Legacy class pricing (D-512), zero-award endgame death (D-513).

---

## How to run it

```bash
npm run db:up   # Docker Desktop must already be RUNNING — start it by hand
```

Round mode is **OFF by default** — an unconfigured server is still the
persistent world:

```bash
DATABASE_URL=postgres://rc:rc@localhost:5433/regnum ROUND_MODE=1 ROUND_MIN_CAST=3 DEFAULT_AREA_ID=round-town npm run dev:server
```

Optional: `ROUND_LENGTH_TICKS`, `ROUND_SEED`. Note **5433, not 5432**; without
`DATABASE_URL` the pg suites silently skip.

Client: `npm run dev:client`, three browser windows on `http://localhost:5173`.
Accounts `jamie_dev_one/two`, password `dev-only-passphrase`. In game: **I**
for the pack, **C** for the workbench, right-click a node to "Work it",
right-click a person to attack.

⚠ **`DEFAULT_AREA_ID` only applies to NEW characters.** Existing ones load at
their saved position, so a dev character stays wherever it last stood.

Regenerate the map with `python tools/src/build-round-map.py`.

---

## Traps, all paid for once already

**Test traps**

- **A death ends the round, and a round reset clears everything.** Any suite
  with a bot that dies — starving, or alone in the wilderness at dusk — is
  measuring the reset rather than the thing it meant to measure. Starvation
  has its own file and its own server for exactly this reason.
- **`status.xp` does not move mid-round.** Round earnings go to a pot banked
  only on survival (D-524), so a kill shows up in the pack and the log, never
  on the character. Asserting against `status.xp` asserts the wrong invariant.
- **Do not wait for AI to reach you.** A test that stands still until a monster
  arrives passes alone and times out under full-suite load — it is measuring
  the machine. Close on the target instead.
- **Anything probabilistic needs its OWN `Rng`.** Loot rolls once shared the
  roamer stream, which wander consumes every tick, so a drop depended on run
  timing rather than on the seed.
- **One blow interrupts work.** Do not loop attacks in a test: the first swing
  does the job and the rest kill the subject, breaking every later test.
- **`ATTACK_RANGE` is 1.** Spawn a target at `x + 1`, not `x + 2`.
- **An unwalkable spawn is silently RELOCATED to the area spawn.** A bot placed
  on the tavern's wall corner ended up two tiles from the well and spent a
  whole suite quietly drinking while an assertion waited for "no water here".
  A position in a wall does not error — it teleports.
- **The server runs ~60 ticks/s under test load, not the nominal 200.** Budget
  `lengthTicks` accordingly, or end a test round by the DEED (spawn an NPC
  next to the antagonist via `server.spawnNpc`) rather than by the clock.
- **`round.dayTicks` and `round.graceTicks` are server options** so tests can
  reach dusk or skip the truce. Every suite not about the truce sets
  `graceTicks: 0`.
- **The mine is dense with rock and a greedy walker wedges on the first
  outcrop.** `mr2-gathering.test.ts` reuses the CLIENT's A*
  (`client/src/game/path.ts`).

**Code traps**

- **The xp guard on player kills must not be removed.** `gateway.ts`
  `handleAttack` grants 25 xp + 5 deeds for killing a player in the persistent
  world; in a round that is payment for lynching, so it is gated on
  `!this.roundRunning`. `sim/test/mr1-round.test.ts` asserts it.
- **Never make the round dungeon `endgame` tier.** That carries involuntary
  permadeath, and a round death must not cost a character levelled across
  fifty rounds. `server/test/round-map.test.ts` asserts it.
- **Do not infer `outdoor` from `lighting`.** Lighting is a render profile; a
  bright cavern or a gloomy field breaks the coupling immediately.
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
- **`findOrphans` must know every way an item enters the world.** It counted
  only nodes as producers, so monster loot failed the build as unreachable.

**Older, still true** — Windows shell: `Start-Process npx` fails; background
the server with `node node_modules/tsx/dist/cli.mjs server/src/index.ts` and
redirect to a FILE (piping to `head` closes the stream and kills it). Do not
chain `$env:X='y'; cmd1 && cmd2`.

---

## The one thing to read if you read nothing else

MR2 is built. The remaining code is small; the remaining **risk is entirely in
numbers nobody has felt yet**. Get three people into a round before building
anything else — it is both the cheapest way to find the wrong ones and the
project's own declared go/no-go gate.
