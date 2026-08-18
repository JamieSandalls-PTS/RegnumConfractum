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

**Amendment, 2026-08-18 (D-521).** A third principle now sits above both:
**ship a bounded thing first.** The persistent world is the destination, but
the first *product* is **MR — the Round**, a 20-30 minute scenario with a
hidden antagonist and no respawn. It is inserted after the interface work and
before M5. M5, M6 and M7 keep their content and their order; they now describe
the persistent world that the Round is a proving ground for. **Nothing below
is cancelled.**

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

## MU — Interface (in progress, inserted post-M4 by stakeholder ruling)

*Not in the original sequence. The stakeholder ruled after M4 that basic
interface work precedes M5.* Click-to-move, hotbar, context menus, character
creation, split pixelation and the Graphics panel, speech bubbles, combat
state with draw/sheathe/stance/attack variants, ragdoll death, carryable
bodies, and the tabbed viewer with its cloth workbench. (D-514 – D-520.)

**Remaining:** inventory and character-sheet UI — now a hard dependency of
MR, below, because you cannot craft or farm without somewhere to put things.

---

## MR — The Round *(the first shipped product, D-521)*

*Inserted 2026-08-18. The persistent world is resequenced behind this, not
cancelled. Nothing already built is discarded.*

A 20–30 minute scenario: a small cast, a compact map, a compressed day-night
cycle, a hidden antagonist with a secret objective, and **no respawn** —
dead is dead until revived or until the round ends. The round ends when the
antagonist dies, the objective completes, or the good cast is wiped.

**The cast (D-522, D-525).** Minimum **three** players to start, carried at
that size by objectives that never require the antagonist to win a fight
(D-526). **Characters persist and level across rounds; gear is stripped
between them.** Names and faces persist too — what wipes is the *recognition
system's* per-observer knowledge, so every round opens with an empty
knowledge table even among familiar faces. Knowing who someone is says
nothing about what they are this round, because the antagonist is assigned
at random. Creation happens at the roster screen, outside the round, so the
lobby is a join queue.

**The dungeon (D-523).** A per-round dungeon farmable for xp, loot and
materials is what pulls the cast apart voluntarily — without it, everyone
sits in the tavern, nobody can be killed unwitnessed, and the antagonist
cannot act. Attention is the scarce resource: dive and earn, or stay and
watch. It is structural, not side content.

### MR1 — The round spine

*Prove the loop with no economy in it at all.*

- Round lifecycle as a server-owned session: lobby → running →
  resolution → reset, built **on the DM event engine** (D-508), not beside it — a
  scenario is an event document that plays itself
- Antagonist assignment, secret and server-side; objective documents as
  content (`content/objectives/`): kill target, steal object, survive, escape
- Victory evaluation and round resolution, with the reveal at the end
- Round death rules: D-513's downed state and the `revive` window become the
  default; no respawn timer, no death debt
- Round-scoped clock — `TICKS_PER_GAME_HOUR` becomes a round parameter so one
  round is one day — and **area lighting driven by the hour**
- Character roster outside the round: create, select, and carry a persistent
  character in; **gear stripped on entry and on exit** (D-522)
- **Recognition is round-scoped state (D-524, D-525):** per-observer name
  knowledge is cleared at round reset and **never written to the character's
  persistent record**. Characters keep their name and face across rounds —
  it is the *feature* that wipes, not the person. The trap is the reverse:
  quietly persisting it because D-219 assumes it endures.
- Minimum cast of three enforced at start; **objective scaled to cast size**
  (D-522, D-526) — kill-a-named-NPC, starve-out, steal, escape and survive
  all work at three because none require the antagonist to win a fight;
  assassination is reserved for larger casts
- Round HUD: time remaining, objective card, the living and the fallen

**Done when:** headless bots play a full round end to end — one bot is
assigned the antagonist, kills its target, and the round resolves — and three
invariants are asserted with the round running: a ghost bot still sees only
ghosts (invariant 4), a character carries its level **out** of the round and
its gear **not at all**, and the event log is unbroken across the reset
(invariant 10).

### MR2 — The loop inside the round

*The M5 economy, cut down to what fits in 25 minutes.*

- Inventory and character-sheet UI (carried from MU)
- **The dungeon (D-523)** — the round's separation engine, not side content:
  a `wilderness` area (never `endgame`; a round death must not cost the
  persistent character), repopulated **per round** — one round is one day, so
  “daily” and “per round” are the same statement. It is where NPC combat xp
  lives, which is what D-522's no-xp-for-player-kills rule requires. Built in
  from the start: **diminishing returns per clear**, **dangerous enough to
  need company** so the split is visible to the cast, and an objective clock
  that punishes over-diving.
- Gathering: resource nodes, a harvest verb, respawn within the round
- A round kit of items with a closed loop — every item consumed by a recipe,
  a use, or a win condition, green under the orphan validator (D-210)
- Crafting: recipes as content, a workbench, timed under interruption
- **Food and water needs (D-526)** — the anti-camping mechanic, and the
  reason farming exists. **Coarse, not continuous:** two or three need events
  pinned to the day-night cycle, never a draining bar. The first stage forces
  a *decision* (leave the room), not damage. **No death spiral** —
  consequences plateau; a round decided by a hunger bar is a failed round.
  Water and food must fail differently or one is decoration.
- Farming: plant, grow against the round clock, harvest — now consumed by
  the cast rather than orphaned content
- **The antagonist's non-violent attack surface:** poison the well, spoil the
  stores, burn the crop. Unwitnessed, deniable, no combat required — at a
  cast of three a poisoner is a better antagonist than a duellist (D-526).
- **Persistent progression (D-522):** xp banked to the character and kept
  between rounds, earned from crafting, farming, healing, surviving and
  winning — and from **NPC** combat only. **No xp for killing another
  player**, ever: at these cast sizes that pays the good team to lynch
  suspects, which is the D-303 violation MR must not commit. Extend D-510's
  *deeds* list rather than building a second vocabulary.
- A level curve that buys **access and options, never raw power** — D-207's
  rule applied to levels. A veteran must not be unkillable by three novices;
  if the curve drifts toward stat-scaling, the mode needs level-banded
  queues, which the player-count target cannot afford.
- **The cost of dying: the round's xp is forfeit** (ratified, D-524) — bank
  nothing from a round you died in. Dungeon hauls are therefore a gamble:
  farm late, die on the way home, and the whole haul is lost — xp to nobody,
  loot to your killer under wilderness corpse rules.

**Done when:** a bot round runs the whole chain — dive, gather, craft, arm,
fight — the orphan validator is green across the round kit, and two
assertions hold: a bot that dies banks **no** xp for that round, and a bot
that survives banks its dungeon xp and **loses its gear** at the reset. Plus:
a cast that never leaves one room **starves**, and a bot that learned another
character's name in round one **does not know it** in round two (D-525).

### MR3 — The scenario library and the map

- Five or so linked areas sized for a 25-minute round (tavern, yard, farm,
  wood, mine or chapel)
- Multiple scenarios as data, chosen or rotated per round
- Lobby, cast assembly, round rotation, results
- NPC crowd and hostile spawns per area — the low-cast fix: somewhere to hide
  at a cast of three, and something to earn xp from without inflating it
- Round statistics and the account-level meta (Legacy between rounds only —
  never power inside a round, D-207)
- Multiple dungeon layouts, rotated per round (D-523)
- **Recognition memory is round-scoped** (ratified, D-524) — the cast meets as
  strangers every round, so false names and hoods keep working indefinitely.
  This holds only while **antagonist assignment stays random**: random
  assignment is what makes “X was the traitor last round” worthless. Any
  future weighting or opt-in would break it and is a design change, not a
  tuning knob.

**Done when:** the stakeholder can run back-to-back rounds with different
scenarios without a restart or an admin action.

### The MR gate — which is also the M2 gate

**This absorbs the go/no-go test below.** Put a cast in a round with a hidden
antagonist. If they lie to each other, read each other, hide a body, question
a corpse, or wrongly execute an innocent — the roleplay core is real, and it
was proven by people playing rather than by two writers volunteering to
improvise. If a round is dull with a traitor in it, the problem is deeper
than content.

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

> **Superseded as the shipping target by D-521.** M0 + M1 + M2 are built, and
> this section is retained as the record of what the first slice was scoped to
> be. The shipping target is now **MR — the Round**, and the ninety-minute
> two-writer test below is absorbed into the MR gate. The slice's *contents*
> all survive inside MR; what changed is that they are now framed by a round.

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
