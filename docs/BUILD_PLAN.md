# Build Plan — Milestones and the First Playable Slice

**Companion to:** `DECISIONS.md`
**Audience:** whoever is implementing, including future Claude Code sessions
**Status:** proposed sequencing. Milestone *contents* follow from ratified decisions;
milestone *order* is a judgement call and is open to challenge.

---

## Sequencing principle

**Prove the soul before building the body.**

The first three milestones exist to answer one question: *is it compelling to meet a
stranger in this world, talk to them, and be deceived by them?* If that is not
compelling, no amount of crafting, territory or economy will rescue it — and if it is,
everything downstream is worth building.

This is why combat, economy and progression come **after** the roleplay core, despite
being what most MMO projects build first. Most MMO projects are also not this.

**Second principle: the harness comes before the game.** D-114 established that the
stakeholder is hands-off and correctness therefore cannot depend on human code review.
The test harness is not overhead to be added later; it is the thing that makes the
project possible at all. It is M0.

---

## M0 — Foundation and harness

*Nothing player-facing. This milestone exists to make every later milestone safe.*

- Monorepo: `server/`, `client/`, `shared/` (wire protocol, per D-105)
- Postgres schema and migrations; append-only event log table from the start (D-106)
- WebSocket transport, JSON encoding, snapshot-then-deltas (D-107)
- Accounts, authentication, session lifecycle
- Tile-grid area representation and server-authoritative movement (D-102, D-103, D-104)
- **Deterministic simulation harness** — game logic runs headless and reproducibly
- **Headless bot clients** asserting invariants: no item duplication, no currency
  creation, no desync, no unreachable tiles
- CI: content schema validation, unit and simulation tests
- Admin UI skeleton for inspecting world state without database access
- Staging deployment the stakeholder can log into

**Done when:** two headless bots connect, move around a tile grid, and their positions
and inventories survive a server restart — with the whole thing verified by tests rather
than by someone watching.

---

## M1 — The renderer

*Productionise the prototype.*

- Three.js client, orthographic isometric camera (D-401)
- Character generation from seed and archetype ranges (D-402)
- Verlet cloth and hair (D-403)
- Palette quantisation post-process (D-404)
- Terrain built from area data files
- Client-side interpolation of server-authoritative positions
- Equipment as geometry parented to bones, swappable at runtime

**Done when:** two people in two browsers see each other move in real time, with
appearance generated from their character records — and the stakeholder has ratified the
art direction (D-406).

---

## M2 — The roleplay core

*This is the milestone that decides whether the project is worth continuing.*

- Emote system: lexicon-backed state machine, states vs transients, negation (D-202)
- Recognition: identity threads, presentation states, thread merge on disguise pierce
  (D-219)
- Name declaration flag, contested by Bluff against Insight, graded and fallible (D-218)
- Proximity channels — whisper, speech, shout — with line of sight
- Languages, scrambled when unknown
- In-world writing: books, notes and letters as physical items

**Done when:** two players can meet as strangers, converse, one can give a false name,
and the other can either be taken in or see through it — and it feels good.

**⚠️ This is the project's real go/no-go gate.** If M2 is not compelling, stop and
reconsider rather than proceeding to M3.

---

## M3 — Scripting and the DM toolset

*Early by design. D-109 and D-216 both argued for this; retrofitting it later means
reworking every system built in between.*

- Sandboxed Lua with a controlled API for area events, triggers, dialogue
- DM console: possess any NPC, invisible observation, spawn and despawn, narrate to
  individual / area / global, control weather and lighting
- Trigger and scheduling engine: time-of-day, elapsed, player-count-in-area,
  entity-death, item-acquired, area-entered, plus chained consequences
- Visual form-based editor generating scripts underneath — DMs must not write code
- Rehearsal mode against staging
- Event template library; rollback for spawned content

**Done when:** a DM can build and run this chain end to end, from the UI, without
assistance:

> 19:00 — global message, spawn a new location
> Trigger: 5+ players in the area — spawn 7 undead and a warlord
> Trigger: warlord killed — global message, spawn a gold chest

---

## M4 — Character systems

- Classes and skills; 8-10 deep archetypes at launch (D-208)
- Legacy Points on voluntary permadeath, scaled on active playtime and renown (D-222)
- Death: ghost phase, death debt, respawn (D-203)
- Spirit interactions: Speak With Dead, Animate Dead, Plane Shift ritual (D-204)
- Injury: location, type, severity, sickness, curses, per-type treatment paths (D-205)
- Combat: cooldown-based, non-twitch (D-104)

**Done when:** the full death loop works — die, ghost, be raised or walk out with debt —
and a major wound genuinely requires finding another player to treat it.

---

## M5 — World content and economy

- Area content pipeline; browser-based map editor (D-110)
- Items, recipes, crafting
- **No-orphan-items CI validator** — build fails on any item with no consumer (D-210)
- Economy telemetry dashboard: money supply, faucets, sinks, price indices, wealth
  distribution (D-221)
- Rewards paid in goods rather than coin (D-220)
- Factions and charters; witness-based reputation with guard response ladder (D-217)

**Done when:** the orphan validator is green across the whole item database, and the
telemetry dashboard is live and readable at a glance.

---

## M6 — Territory and politics

- Overworld grid; travel between cells with interception (D-301)
- Claims, housing, player-built structures
- Hidden settlements; **coordinates as a physical, stealable, forgeable item** (D-213)
- Land upkeep; hireable NPC guards at tiered strength
- Valuables placeable as decoration — the voluntary money sink (D-225)

**Done when:** a faction founds a hidden town, and a second faction finds it using a
stolen map.

---

## M7 — Alpha

- Onboarding area teaching expectations through play (D-215)
- Moderation tooling: searchable logs, report handling, sanction ladder
- Separate DM and admin roles
- Closed alpha, ~15 roleplayers

---

## The first playable slice — specified precisely

**Scope: M0 + M1 + M2.** Nothing else. Resist every temptation to add combat.

Concretely:

- **One area**, hand-authored, roughly 64×64 tiles. A tavern and the street outside.
- Account creation; character creation with a generated appearance seed plus written
  description fields
- Movement on the tile grid, server-authoritative
- Proximity speech and whisper, with line of sight
- Emotes with procedural animation, driven by asterisk-wrapped text
- The recognition system, complete — strangers, introductions, false names, Insight
- Persistence across restart
- Two people, in two browsers, at the same time

**The test:** put two writers in that tavern with no instructions beyond "you are
strangers." If ninety minutes later they are still there, the project is real.

---

## Estimating

Deliberately omitted. Milestone *content* is well-specified; milestone *duration*
depends on session cadence and how much rework the art direction needs, and a fabricated
timeline would be worse than none. Sequence and definition-of-done are the useful
commitments here.

The one calibration worth stating: **M0 is larger than it looks and M2 is smaller than
it looks.** The harness is real engineering. The roleplay core is mostly text handling,
data modelling, and taste.
