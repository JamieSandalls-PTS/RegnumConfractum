# CLAUDE.md

Place this at the repository root. Every Claude Code session reads it first.

---

## What this project is

**Regnum Confractum** — a persistent-world roleplaying MMO in the tradition of
**Arelith** (the Neverwinter Nights persistent world). A small, dense, long-lived world
where the point is character, politics and deception, not level grinding.

Isometric, browser-delivered, gritty low fantasy in a decayed empire. Target scale is
**300 concurrent players**, not 300,000.

---

## Read before doing anything

| Document | Contains |
|---|---|
| `docs/DECISIONS.md` | **The architecture decision record.** 48 decisions with rationale. |
| `docs/BUILD_PLAN.md` | Milestones, definitions of done, the first playable slice. |
| `docs/ASSET_PIPELINE.md` | *Superseded by D-401.* Historical only. |
| `docs/ART_SOURCING.md` | *Superseded by D-401.* Market survey, retained as record. |

### The rule about decisions

**Do not re-litigate what is in `DECISIONS.md`.** Every entry records not just the
conclusion but the reasoning and the constraints that were load-bearing. If you believe a
decision is wrong, say so explicitly to the stakeholder and propose a superseding entry —
do not quietly implement something different.

The ADR convention here is **supersession, not rewriting**. When a decision changes, the
old entry stays and a new one supersedes it. The record of how the thinking moved is
part of the value.

---

## The north star

> **A player can be good in this world, and doing so must be a costly choice made
> against the grain — never a mechanically optimal one.** (D-303)

No alignment meter. No karma stat. No mechanical reward for virtue, ever. Mercy must be
*possible* — sparing, ransoming, sheltering, concealing must all be supported actions —
but never *optimal*. Validation comes from other players, never from the game.

When a design question is genuinely ambiguous, resolve it against this principle.

---

## Invariants — violating these is a bug, not a trade-off

1. **The server is authoritative.** The client sends intent and renders what it is told.
   It never determines outcomes. (D-102)
2. **Every item has a consumer.** Base material, equipment, consumable, valuable, or
   recipe input. The CI validator fails the build on orphans. (D-210)
3. **Reputation requires a witness.** Crimes register only if seen or evidenced.
   Omniscient reputation makes disguise, alibis and silencing witnesses meaningless.
   (D-217)
4. **Ghosts see only ghosts.** Never relax this. If the dead could observe the living, a
   dead player becomes a free scout relaying enemy positions over Discord. (D-203)
5. **Insight is graded and fallible.** It reveals *that* something is off, never *what*
   the truth is, and is occasionally wrong at narrow margins. A reliable lie detector
   destroys deception roleplay. (D-218)
6. **The name-declaration flag is invisible to observers.** Players hear a name spoken;
   they do not see that a mechanic fired. (D-218)
7. **No coin drops from monsters.** Rewards are goods. Goods become money only when a
   player pays for them. (D-220)
8. **Legacy Points buy access and flavour, never raw power.** (D-207)
9. **No Wizards of the Coast product identity.** Original pantheon, original names for
   the subterranean cultures. Familiar archetypes are fine; proper nouns are not.
   (D-209)
10. **The event log is append-only and written from day one.** Moderation is an evidence
    problem before it is a policy problem. (D-106)

---

## Testing doctrine — read this twice

**The stakeholder is hands-off and does not review code.** (D-114) There is no human
reading diffs for correctness. The test suite is the only thing standing between a
subtle bug and a live economy exploit.

Therefore:

- Game logic must run **headlessly and deterministically**. No logic that can only be
  exercised through a browser.
- **Headless bot clients** play the game and assert invariants: no item duplication, no
  currency creation from nothing, no desync, no unreachable areas.
- Content files are **schema-validated in CI**.
- The **orphan-item validator** runs on every build.
- New systems ship with simulation tests, not just unit tests.

If a change cannot be verified automatically, say so out loud rather than shipping it
quietly.

The one thing the stakeholder *does* do is play the game and judge feel. Make that easy:
keep staging deployable, keep the admin UI current.

---

## Stack

- **Language:** TypeScript, server and client, with the wire protocol defined once in a
  shared package so a message-shape change breaks both builds instead of desyncing in
  production (D-105)
- **Runtime:** Bun or Node
- **Database:** Postgres. Dirty-flag entities, flush every 30-60s, immediate writes on
  item transfer, death, logout, currency change. **No Redis** until profiling demands it
  (D-106)
- **Transport:** WebSocket, JSON, snapshot-then-deltas (D-107)
- **Client:** Three.js, orthographic isometric camera, low internal resolution,
  palette-quantised with ordered dithering (D-401)
- **Scripting:** sandboxed Lua for world content and DM events (D-109)
- **Deployment:** single VPS, Docker Compose, Caddy, nightly off-box backups. **No
  Kubernetes** (D-111)

### Simulation shape

10Hz server tick. Tile-based movement with client-side interpolation. Cooldown-based,
non-twitch combat. This is baked into movement, combat and netcode — it is not a
tuneable. (D-104)

Areas are **discrete, joined by transitions** (D-103), with a **coarse overworld grid**
above them for wilderness travel and settlement coordinates (D-301).

---

## Rendering notes that cost real time to learn

- Three.js r155+ uses **physical light units**. Intensities from older examples are far
  too dim. Expect directional lights around 3-5, not around 1.
- **Fog range must exceed camera distance.** An orthographic camera orbiting at ~19
  units with fog set 9→22 renders a near-black scene. This wasted a debugging cycle.
- **Exposure and vignette must be applied BEFORE palette quantisation.** Applying them
  after pushes colours off the palette and undoes the effect entirely.
- Procedural generation must use **archetype-constrained parameter ranges**, never
  uniform random. Uniform random produces mush. (D-402)

---

## Repository layout

```
/server        authoritative simulation, persistence, scripting host
/client        Three.js renderer, procedural characters, UI
/shared        wire protocol, schemas, shared types — single source of truth
/content       areas, items, recipes, NPCs, dialogue, factions (versioned data)
/tools         map editor, DM console, admin UI, content validators
/sim           deterministic harness and headless bot clients
/docs          DECISIONS.md, BUILD_PLAN.md, and superseded records
/prototypes    spikes. procedural-characters.html proved D-401.
```

---

## Working style

- **Small vertical slices.** A change that touches server, protocol and client together,
  with tests, beats three disconnected layers.
- **Content is data.** Areas, items, NPCs, dialogue and factions live as
  schema-validated files in git — never hardcoded. This is the force multiplier that
  makes the world's scale achievable. (D-110)
- **Update `DECISIONS.md` when something is decided.** A decision not written down will
  be re-litigated, and probably differently.
- **Flag risk explicitly.** The stakeholder cannot see problems in code. If something is
  fragile, unverified, or a guess, say it in plain language.

---

## Current position

Design is complete through all phases. The renderer approach was validated by prototype
(`prototypes/procedural-characters.html`) rather than adopted on argument.

**M0 — foundation and harness: built.** Wire protocol in `shared/`, deterministic
10Hz sim + WS gateway + Postgres persistence (append-only event log, trigger-enforced)
in `server/`, headless bots and the determinism harness in `sim/`, content validator in
`tools/`, CI in `.github/workflows/ci.yml`. The M0 definition of done is covered by
`sim/test/persistence.pg.test.ts` and `sim/test/bots.invariants.test.ts`.
Dev workflow: `docs/DEV.md`. Implementation decisions: D-501, D-502.

**M1 — the renderer: built.** Three.js client in `client/`: orthographic isometric
camera, palette-quantised low-res post (D-404), terrain from area data, characters
generated from the wire `appearanceSeed` (D-402, D-503), verlet cloth/hair, walk/idle
procedural animation, interpolation of authoritative positions. Pure logic
(appearance, interpolation) is headlessly tested; `window.__rc` is the client's
verification hook. Verified live: two accounts in two browser tabs saw each other
move in real time. First light: `docs/media/m1-two-players.png`.

**M2 — the roleplay core: mechanically complete (D-505, D-506).** Names are
per-observer knowledge, never wire facts. Proximity channels with line of sight;
declarations contested by graded, fallible Insight; emotes from a content lexicon;
languages scrambled server-side per listener; letters written on parchment and
handed over (authorless by design — forgery is native); hooded presentation
threads that merge when the hood drops in view; third-party introductions.
The first-slice tavern (`hanged-ferryman`) is authored and is the default
starting area. All of it is exercised by headless bots (96 tests).

**The M2 go/no-go gate is now a human question:** put two writers in the tavern
for ninety minutes (BUILD_PLAN). That judgement — and art ratification
(D-406/D-504) — belongs to the stakeholder.

**M3a — scripting spine built (D-507).** Area transitions link the world (yard ↔
tavern, validated in CI). NPCs are connectionless entities with fixed public
descriptors. Sandboxed Lua (wasmoon) runs per-area scripts through a controlled
API — spawn/say/narrate/lighting, on_enter/on_player_count/on_hour/delay/every —
all tick-driven and deterministic; errors contained. DM verbs live on the admin
server (spawn, possess, narrate, lighting), logged. The tavern has a scripted
keeper (`content/scripts/ferryman-keeper.lua`).

**M3b — the DM event system built (D-508).** A form-based editor in the admin UI
produces schema-validated event documents: chained stages (immediate / at_hour /
after_seconds / player_count / entity_death triggers) firing actions (narrate,
spawn NPC, possessed speech, lighting, spawn a temporary linked area, despawn).
Runs track everything they spawn; rollback evacuates and erases. Rehearsal = run
now with [rehearsal] prefixes + one-click rollback. Events persist in `dm_events`
and duplicate in place (the template library). The canonical M3 done-when chain
is bot-verified end-to-end except the death stage, which arms and waits on
`EventEngine.entityDied` (wired in M4).

**M4a — combat, death, injuries built (D-509).** Cooldown combat under the D-206
zone tiers: settled areas demand a spoken, logged hostility declaration and a
10-second window; the yard is open wilderness. Death: the living see you fall,
you continue as a ghost in a strictly partitioned plane (every delivery path
partitions both ways — bot-verified anti-scouting), 100 death debt banks
immediately, XP pays debt before advancing, respawn at town after the minimum.
Major wounds bleed and cannot be self-treated — the physician dependency is
mechanical. The M3 event chain's death stage now fires.

**M4b part 1 — voluntary permadeath + Legacy Points built (D-510):** retire ends
a character forever; the account earns points scaled by xp and deeds (meaningful
actions, never wall-clock), diminishing on repeat sacrifice. Access and flavour,
never power — the spend side waits on the class system.

**M4b part 2 — spirit interactions + class scaffold built (D-511 ratified,
D-512 implemented).** Corpses are persistent world objects with zone-dependent
gear rules (settled: cosmetic, unlootable; wilderness: wears everything, the
hunt-your-own-corpse loop); Speak With Dead (five questions, lying free,
distinct beyond-reach result); Animate Dead (3h cap, skill-scaled concurrency
max 3, gear drops on destruction, owner may ride the body speaking the undead
register); decay → ground loot → logged cleanup. Classes are content
(`content/classes/`, nine authored per D-511), abilities gate the rites;
**Legacy-locked class pricing is a placeholder awaiting ratification.** The
séance is the one sanctioned plane crossing — speech-only, logged. Wire is
protocol v2. All bot-verified (`sim/test/m4c-spirits.test.ts`, 152 tests total).

**➡ Session handoff notes: `docs/HANDOFF.md`** — mid-milestone state, next work,
items blocked on the stakeholder, and the repo's hard-won working specifics.
Read it after this file.

**M4b part 3 — endgame permadeath zones built (D-513).** Two-step unmissable
entry warning; the downed state (speech only, no retirement escape); `revive`
by another player within the window; involuntary permadeath with **zero
Legacy award (unratified ruling — flag for the stakeholder)**; the
`sunken-crypt` is the first endgame area. Bot-verified
(`sim/test/m4d-endgame.test.ts`; 158 tests total).

**UI milestone in progress (D-514 – D-520).** Click-to-move, hotbar, context
menus, the **character creation screen** (calling → skills → feats →
spells → name), **split pixelation** with a depth-tested composite and a
Graphics settings panel, **speech bubbles**, a server-owned **combat
state** driving sheathe/draw/stance/attack-variant animations with
projectiles and particles (D-516), **ragdoll death** and carryable bodies
(D-518), and a **tabbed viewer** whose cloth workbench round-trips garment
settings — the stakeholder's first tuned exports are baked (D-520).
Creation catalogues are content (`content/skills|feats|spells/`);
`validateBuild()` in `shared/` is the single rule set and the server is
the authority (D-102). Garments are cut to the RIG, never to nominal
height (D-519).

**➡ SCOPE CHANGE, 2026-08-18 (D-521) — the shipping target is now
MR — the Round.** The first shipped iteration is a **20-30 minute
scenario mode** in the spirit of Space Station 13 / Werewolf: a small
cast starts in the tavern, survives, levels, crafts and farms through a
compressed day-night cycle; **one player is the antagonist**, with a
secret objective (kill a target, steal an object). **There is no
respawn** — dead is dead until revived or until the round ends. The
round ends when the antagonist dies, the good cast is wiped, or the
objective completes. The persistent world (M5-M7) is **resequenced
behind this, not cancelled**; every system already built is retained and
most of them are exactly what the mode needs. Milestones **MR1 (round
spine) → MR2 (gather/craft/farm/level) → MR3 (map and scenario
library)** are specified in BUILD_PLAN. **The M2 go/no-go gate is
absorbed into the MR gate.**

**The cast, ratified (D-522):** minimum **three** players (a floor, not a
target — deduction needs five-plus). **Characters are persistent and
level across rounds** — xp for crafting, farming, healing, surviving,
winning, and NPC combat; **gear is stripped between rounds**. Creation
happens at the roster screen, outside the round. Two rules follow and are
load-bearing: **no xp for killing another player** (at these cast sizes
that pays the good team to lynch, violating D-303), and **levels buy
access and options, never raw power** (D-207's rule applied to levels, or
veterans dominate). Round death is **not** permadeath — retirement
(D-510) stays the only route to Legacy.

**The dungeon (D-523)** is structural, not side content: a per-round
`wilderness` dungeon farmable for xp, loot and materials is what pulls the
cast apart voluntarily. Without it everyone sits in the tavern, nobody can
be killed unwitnessed, and the antagonist cannot act. It is also where
D-522's NPC-only combat xp lives. ⚠ **Never `endgame` tier** — that
carries involuntary permadeath, and a round death must not cost a
character levelled across fifty rounds.

**What resets between rounds (D-524, D-525):** the **recognition system's
per-observer knowledge** — who was introduced to whom, which threads
merged, which false name was swallowed — is round-scoped state, cleared at
reset and **never written to the character's persistent record**.
Characters keep their names and faces; it is the *feature* that wipes, not
the person. Safe because the antagonist is assigned **at random**, so
knowing *who* someone is says nothing about *what* they are this round.
⚠ The implementation trap is the reverse — quietly persisting it because
D-219 assumes it endures.

**Survival needs (D-526):** food and water are the anti-camping mechanic
(the dungeon pulls players out, hunger pushes them out) and the reason
farming exists. **Coarse, not continuous** — two or three need events on
the day-night cycle, never a draining bar; the first stage forces a
decision, not damage; consequences plateau, no death spiral. They hand the
antagonist a **non-violent attack surface** (poison the well, spoil the
stores, burn the crop), which at a cast of three is a better antagonist
than a duellist. A cast of three is carried by objectives that never
require the antagonist to win a fight — kill-a-named-NPC (the tavern
keeper already exists), starve-out, steal, escape, survive.

**The day-night cycle (D-527):** a full cycle is **ten real minutes** —
five day, five night — on the round's own clock (a game hour every 25s, so
authored `on_hour`/`at_hour` triggers still work). A round **opens at
dawn**, giving 25 minutes exactly **two nights** and closing in daylight.
**At night NPCs roam outdoors**, so open ground is perilous and paid for.
This completes the three forces — the dungeon pulls players *out*, hunger
pushes them *out*, night drives them *in* — and no position beats all
three, which is what defeats the barricade. Night also manufactures the
antagonist's alibi on a timer. **Night pays 1.5× (D-528) — OUTDOORS ONLY.** The bonus is compensation
for peril, so it is paid only where the peril is. A blanket time-based
bonus would pay best for hiding indoors and for diving underground, where
roamers cannot reach — inverting the point of night. Areas carry an
**`outdoor` flag**: never inferred from `lighting` (a render profile), and
defaulting to `false` so an area opts IN to night — the failure that is
visible in play rather than the one that silently pays cellars. Set it
explicitly on every authored area. Applied in `gainXp` so every future
reward path inherits it.

**Ratified in D-524:** **recognition memory is round-scoped** — the cast
meets as strangers every round, so false names and hoods never decay. This
holds *only while antagonist assignment stays random*; random assignment is
what makes “X was the traitor last round” worthless. **Dying forfeits the
round's xp** (earnings from that round, not banked totals).

⚠ **Implementation rule that is easy to undo by accident:** the
persistent world grants **25 xp + 5 deeds for killing a player**
(`gateway.ts`, `handleAttack`). In a round that is payment for lynching,
so it is gated on `!this.roundRunning`. **Do not remove that guard** —
`sim/test/mr1-round.test.ts` asserts it.

**Violence is free in a round, and LOUD (D-531).** D-206's declared
hostility is disabled while a round runs (the persistent world keeps it):
a 10s spoken warning does not make murder risky in a 25-minute scenario,
it makes it impossible. Instead every blow emits a `sound` to everyone
within `COMBAT_NOISE_TILES` (30) — audio cue plus text. It ignores line
of sight (you hear through walls, or indoor killing would be silent),
**names nobody** (bearing + near/far only — a lead, not evidence, so
D-217 holds), and **never crosses the plane** (ghosts hear nothing, or
the dead become scouts). NPC fights sound the same as murders, so night
supplies the antagonist's deniability for free. `zone` still drives
corpse looting, so town kills are possible but unprofitable.

Round mode does not relax a single invariant. In particular: **ghosts
still see only ghosts** (a dead player with vision is a perfect
informant, and the antagonist's position is the whole game); **Insight
stays fallible** (no detect-traitor); and **D-303 still forbids
rewarding virtue** — the round must never score correct accusation or
execution, or it teaches the opposite of the north star.

**M4b remaining:** richer injury/treatment types (D-205 matrix), Vessel's
Plane Shift, class skills/balance beyond the scaffold. **Other gaps:**
inventory/character-sheet UI, invisible DM observation, staging VPS not
provisioned. ⚠ **Blocked on the stakeholder, MR-specific:** night DANGER tuning (roamer
strength vs a mid-round character, whether roamers may enter settled areas —
the reward side is settled at 1.5× by D-528, but the two must be tuned
against each other); hunger tuning (need events
per round, what the first stage costs, whether starvation can kill inside a
round or only incapacitate); multiple antagonists above a cast size, and
whether they know each other; minimum party size to enter the dungeon at low
cast counts; whether an objective may ever sit *inside* the dungeon; what a revived
player returns with.

⚠ **Unratified balance awaiting the stakeholder:** creation
budget (D-515), combat window / attack roster / carry formula (D-516),
Legacy class pricing (D-512), zero-award endgame death (D-513).
