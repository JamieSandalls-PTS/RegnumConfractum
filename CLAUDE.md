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

⚠ **The simulation tests are wall-clock tests calibrated on Windows' 15.6 ms
timer clock, and `sim/test/setup-clock.ts` reproduces that clock on Linux so
CI runs the same simulation (D-633).** A test that passes here and fails in
CI is a timing test, not a platform bug, and the container recipe in D-633
is how to see it. Tick-driven waits are the durable fix and are not built.

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
- **Client:** Three.js, orthographic isometric camera, rendered at full
  resolution. ⚠ The palette quantiser and its low internal buffer were
  REMOVED at the stakeholder's request (D-586, superseding D-401/D-404)
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
- ⚠ *(Historical, D-586)* "Exposure and vignette must be applied BEFORE palette
  quantisation" — the quantiser is gone, and with it exposure, vignette and the
  ordering trap. Kept because it explains a shape the code no longer has.
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

**MR2 in progress.** Gathering and crafting are built and bot-verified
(nodes as entities, timed interruptible work, `harvest`/`craft`, a pack
and workbench UI) and **invariant 2 is now ENFORCED** — D-210's orphan
check runs in CI over the recipe graph. **Night roamers are built
(D-532):** they walk outdoor wilderness at dusk, never the settled town
(the refuge — unratified, one line to flip) and never the dungeon; their
blows interrupt work and sound exactly like a murder. ⚠ All roamer
numbers are unratified. **Hunger and thirst are built (D-533)** and pull
OPPOSITE ways — hunger pushes you out (bread comes from the farm), thirst
pulls you in (water is the well, never carried), so nobody can settle
anywhere and the well becomes the thing worth poisoning. They fail
differently (hunger slows work, thirst thins your health). **Starvation
KILLS (D-534)** — a full day of neglect to empty, then hours more before
it is fatal, announced at every step; **thirst never kills**, it just
makes something else kill you. **Stations are real placed objects**
(workshop/storehouse/infirmary/well), usable from two tiles.

**The dungeon is THREE FLOORS (D-535)** opening on successive round-days —
it deepens rather than reshapes, so nothing ever changes under anybody's
feet, and "the lower stair opens at dawn" is a scheduled meeting. **The
entrance seals dusk→dawn**: come up before dark or be shut in till
morning, which stops diving being a way to earn through the night without
night's risk. **The floors are stocked (D-537):** dungeon dwellers are night roamers with
`habitat: 'dungeon'` — one implementation, not two — arriving with the round
and never leaving, refilling on a 90s timer. The gradient runs on xp, loot
and damage together, and **gravebright** (floor 2+) is the material that
makes descending more than faster mining; its only recipe also needs timber
from the far side of the map. Loot goes straight to the killer, never to the
floor. ⚠ All dungeon numbers unratified.

**The dawn truce (D-536):** 60s at the round's opening and every dawn where
the round's clock genuinely STOPS — no attacking, no roamer damage, no need
progression, no leaving the area. It is the one scheduled scene: survivors
compare wounds and argue about the day, and the antagonist must lie to
everyone with no way to end the conversation by violence. Tests that are
not about it set `graceTicks: 0`. **The common stores are a real place, and they can be ruined (D-580).**
D-530 had been half-built since it was written: the ruling was that pooling
goods at a facility is more potent than carrying them and never required, and
what existed was a TIME bonus for eating beside the storehouse **out of your
own pack** — the flavour of the rule with none of its substance, since nothing
was ever pooled and so nothing could be hoarded, denied or spoiled. A store is
now the THIRD owner an item can have (beside a character and a corpse), which
keeps D-114's no-duplication invariant for free and is enforced by an extended
check constraint. **Anybody may take what anybody pooled** — the exposure half
of the trade, and a lock would delete the dilemma. **Emptied at reset**, or the
cast accumulates a permanent larder and D-529's hard constraint dies quietly.
⚠ **Spoiling rides on the ITEMS, not the station.** The well is a source and
is rightly a timed window (D-552); provisions are things, and things go off —
a flag on the station would let a victim carry the loaf clear of the sabotage.
Nothing announces it: a spoiled loaf looks like a loaf, and you find out by
eating it, which costs the meal AND deepens the hunger. Eating prefers an
unspoiled loaf where there is a choice, so sabotage bites once the good food
has run out. Its bite is exactly proportional to how much the cast pooled,
which is the property D-530 called the best thing in the design.
⚠ The UI says what is there and **never who put it there** — a
"contributed by" line would turn generosity into a scoreboard (D-303).
⚠ **Three things the tests caught and reading did not:** stations exist only
while a round RUNS (the first fixture had no round and produced four refusals
that looked like a broken feature); an objective needing a bigger cast than
`minCast` makes the lobby fill and never start (D-569's trap, hit for real —
and it presented as vitest reporting three tests SKIPPED rather than failed,
which reads as green); and `MemoryStore.grantItem` accepts a template content
does not have, so three tests pooled a `ration-bread` that does not exist.

⚠ **Still to build from D-530:** potency beyond meals — the infirmary is not
yet better than a field bandage, the workshop not yet better than improvising.
The 1.5x-2x band is **unratified** and is the number to watch in first play.

**The town starts with a larder, and it RUNS OUT (D-593).** D-529's hard
constraint — hiding in town beats the clock unless the storehouse runs out — is
met: the stores open stocked at **two meals a head**, scaled to the cast, and
nothing refills them. ⚠ The number is chosen against the clock (a belly empties
in a day, a round is two and a half) and is **unratified**; it is the first
thing to watch in play. ⚠ It was a SYSTEMS gap as well as a content one —
every route into a store went through somebody's pack, so nothing could stock
one at all. ⚠ It also gives the antagonist something to spoil from the first
minute, which the best sabotage in the game previously had to wait for.

**Ashfold has a keeper, and he can be silenced (D-593).** He stands at the
tavern DOOR, not behind a bar — measured: every tile of the tavern's footprint
fails `canStandAt`, so D-584's tavern is a facade with no interior. The
threshold is better anyway: D-549 put the square where every route crosses, so
a keeper on it is a target the cast can see being defended. ⚠ The round engine
matches a kill by **public descriptor, not by id**, so a reworded line of prose
in either the script or the objective makes it unwinnable again — now a test
and a build error rather than a hope. ⚠ CI checks this for **live** objectives
only: D-569 passed `null` because DM events also spawn NPCs and a build-time
scan is partial, which holds for a draft and does not hold for something the
engine deals at random with nobody watching.

**Characters LEVEL, and a level may not buy power (D-538).** Fifteen
skills, twenty-seven feats and a nine-step progression table per class
(levels 2–10). A level grants feats, class abilities and non-combat skill
points — never hit points, never damage, and **never a `creationOnly`
skill**, which is where `arms` lives. That fence is enforced by
`validate:content`, not merely described: a class that grants `arms` fails
the build, and so does a levelled feat no class ever grants (D-210's
principle applied to feats). Grants are **automatic and fixed** — no
level-up wizard — and **level is derived from banked xp**, never stored, so
the two cannot disagree. Feats declare their mechanics from a **closed
enum** the server implements in full; a feat with no `effect` is declaring
itself flavour rather than hiding that it is. Skills now bite: `craft` and
`survival` shorten work (capped at half), `endurance` stretches the need
clock, and **treatment mends as well as closes**, which finally makes
D-205's physician dependency social rather than procedural. ⚠ Every
magnitude and the xp curve are unratified.

**Appearance is authored at creation (D-539).** The wizard is
**calling → face → skills → feats → (spells) → name**, with a live 3D
preview beside explicit controls. What is stored is a sparse OVERRIDE on
top of the seed, so every pre-existing character, NPC and corpse renders
exactly as before. The override travels on the wire and every reader goes
through `resolveAppearance` — including stranger-descriptors (D-201/D-219)
and corpse burden — because a descriptor computed from the raw seed would
describe somebody else. The server bounds the body and the palette (D-102).
**Equipment is deliberately not authorable**: gear is stripped between
rounds and a helm chosen at creation would be a permanent disguise
recognition never agreed to.

**Bot AI plays the round (D-540).** `BotAgent` drives a `BotClient`
through the wire and nothing else: it learns the map by walking it (door
targets are server-side, so no test encodes the cross), works its role,
obeys hunger and thirst, returns blows, and — if the server dealt it the
antagonist — commits to its objective on a **random trigger on its own
stream** after a delay, having until then worked like everybody else.
**`npm run bots` fills a live round**, so one person can play the go/no-go
gate. Bot-verified in `sim/test/mr3-bots.test.ts`.

**Sound is sampled as well as synthesised (D-541).** The stakeholder's
drop (six area beds, a menu track, seventeen combat sounds) plays
alongside the procedural layer, which survives untouched — and the split
between them is an invariant, not a preference: **samples play for what
you can SEE; the synthesised cue plays for what you can only hear**, or a
death cry through a wall would hand back the identity D-531 deliberately
withheld. Cues are content (`content/audio/sounds.json`), areas name an
`ambience` cue, and **CI fails on a cue pointing at a missing file**.
Normalisation and take-splitting run at LOAD, in the browser, because
half the drop is ogg/mp3/flac and nothing on this machine decodes those —
the logic is pure and tested (`shared/src/audio.ts`), the browser finds
19 takes in `maledeath.wav` and 7 in the female hurt ogg, and the gains
match an independent Python probe to two decimals. Beds stream with a
slow auto-gain (the menu track would decode to ~500 MB); effects are
decoded once and normalised exactly.

**The world has objects, and walls have their height back (D-542).**
Thirty-one prop types — crates, barrels, stalls, carts, fences, braziers,
gravestones, stalagmites — placed as **area content** by the map generator
in clusters, never as entities (scenery costs one array, not a delta
stream each). Solid props block movement, so `isTileWalkable`, the
client's pathfinder and **CI's reachability flood all read them**: a
barrel in the only doorway fails the build. The prop list is a closed enum
and a test asserts every type builds geometry — a type the schema accepts
and the renderer ignores would be an invisible obstacle. **Stations are
now the objects they are** (the well was previously rendered through the
character pipeline: a man standing very still), and the wire carries
`variant` so the client stops guessing shapes from descriptor prose.
**Walls are full height**, answering the note in `terrain.ts` that asked
for a camera-side cutaway first: anything between the camera and the
player is discarded on a Bayer dither, which needs no per-wall object
(the terrain is instanced), introduces no off-palette colours, and reads
as "something is in front of you" rather than a hole. ⚠ Also fixed here:
`grass`, `dirt`, `tree` and `rock` had **no renderer at all** and fell
back to grey floor and knee-high stubs — nine tenths of every spoke.

**Targeting picks bodies, not pixels (D-542).** Hit-testing measures the
cursor against a vertical segment from feet to head, scales its grab
radius with how large the thing is drawn, and lets **people beat scenery**
on a tie; the old test used one chest-height point and a 30px tolerance,
so clicking someone's legs missed and a nearby node stole the click. The
target panel carries what it is and how far, **Tab cycles nearest-first**,
Escape and a click on open ground clear.

**The map editor exists (D-543).** `npm run dev:editor` + `/editor.html`:
ground and walls, all 31 props, stations, nodes and the spawn, rendered
through the game's own `Terrain` and `PropVisual` so what you place is
what you get (raw, not palette-quantised — the dither hides a misplaced
tile). It writes through `tools/src/editor-server.ts`, which **refuses any
save that would fail the build**: real `AreaSchema`, reachability flood
with solid props blocking, exits, and somewhere to stand at each
facility. GET returns the SCHEMA-PARSED area, not raw bytes, so the
editor and the game work on the same resolved document. ⚠ `round-*` areas
are generated by `build-round-map.py` and hand edits to them are lost on
the next run — the editor warns, and reconciling the two is the obvious
next piece of work.

**Walls are a family, roofs are painted (D-545).** Seven wall kinds —
stone, timber, plaster, brick, cave, palisade and a **treeline** for
closing open ground — all unwalkable, opaque and full height. ⚠ The
dangerous half of that change was `isTileOpaque`, which tested
`kind === 'wall'`: every new material would have been a wall you could SEE
THROUGH, and line of sight is what makes a witness (D-217). Opacity now
keys off the family and a test asserts it. **Roofs** are painted as a
footprint and shaped automatically: touching tiles flood into a region,
the ridge runs along its longer side, and the surface is a heightfield
sampled at shared tile corners (per-tile slabs were the first attempt and
looked like a woodpile). A roof LIFTS AWAY when you walk under it — the
whole region, not a dither hole, because a hole reads as damage and a
cutaway reads as a cutaway. Roofs are presentation only: no movement, no
sight, the server never reads them.

**The editor grew exits, map size, and more props (D-544).** Place and
repoint transitions (⚠ one-way — the way back lives in the other area);
resize or trim an area, which reports what it dropped; and **a save is
refused if shrinking would orphan a door another area points into**.
Props gained a `mount` (floor or wall) so **doors, windows, torches and
ivy** are expressible, plus foliage. Lit props declare their light in
content, and `LightRig` gives a **pool of eight real lights** to the
nearest sources — forty live point lights is a shader that loops forty
times per fragment, not "a bit slower".

**The tavern is 32×32 (D-544)**, re-authored by `tools/src/build-tavern.py`
rather than cropped: its content filled 62×62 of the old 64×64, so there
was nothing to crop. The taproom is now ~20×15 inside a plot with an
approach, a treeline and lanterns at the door.

**Characters have ATTRIBUTES, and a level-up screen (D-546).** Four —
strength, dexterity, vigor, will — **10 apiece with 10 to place**, the
same start for every calling, because a class is access and options
(D-208) and not a stat block. Each has exactly one job: strength is
damage and carry, dexterity turns blows aside, vigor *is* health, will
is the **mana reserve** — a real resource that the existing rites spend
and that regenerates **out of combat only**. ⚠ **Every derived number
returns the OLD value at the base of 10** (health 20 = `DEFAULT_MAX_HP`,
bonuses zero); that is why migration 0010 backfills nothing and why
everything reads through `resolveAttributes`. A **level-up screen** now
sits *on top of* D-538's automatic class grants: a cumulative budget of
skill points, occasional feats and spells, and **four attribute points
across nine levels**. ⚠ **That crosses D-538's fence** — strength is
damage, vigor is hit points — and the magnitude is held at four
precisely so D-529's buddy system survives. `arms` is still
`creationOnly` and a level still cannot buy it; CI and
`validateAdvances` both enforce it.

**Gear is real, and there is a paperdoll (D-547).** Items declare an
`equip` block (slot, armour, damage, mana, weight); eleven slots — head,
body, hands, legs, feet, cloak, two hands, amulet, two rings — in a
character panel that also holds the pack and the sheet. **`both-hands`
is not a slot a character has**, it is what an item declares, and
equipping one fills both hands; **damage takes the best weapon, never
the sum**; **armour reduces and can never erase** (`MIN_DAMAGE` 1, or a
round with no respawn acquires a stalemate). The slot lives on the ITEM
and **every move clears it** (transfer, corpse, loot, strip), with a
partial unique index enforcing it in Postgres because the gateway is not
the only writer. **Every calling starts a round with a kit** — granted
once per character per round, *tracked* rather than inferred from an
empty pack, because "holds nothing" is also true of somebody just
robbed. Kit items count as consumers in the D-210 orphan graph and CI
checks kit slots. ⚠ The paperdoll never feeds the descriptor pipeline:
equipping a hood must not silently become a presentation change (D-539).
**Gold is not shown in round mode** — it stays in the persistent world's
economy and there is nothing to spend it on in a round.

**The HUD reads at a glance (D-548).** Health and mana are bars with the
figures inside; urgency is **banded**, not a gradient. A **compass** that
counter-rotates with the camera — fed the *camera-space direction of
north* by the scene rather than an angle re-derived from the azimuth,
which is the version that is correct at one rotation and mirrored at
another. A **classic twelve-hour clock** on the round's compressed cycle,
where the **dial** (shading, sun/moon) resolves noon from midnight
because the hands cannot. ⚠ **Hunger gets a bar too** — a presentation of
D-526's coarse stage, moving in visible steps with the stage's *name*
beside it, and `starving` drawn nearly empty rather than empty.

**Ashfold is HALF the size, and built as a street plan (D-549).** The
town is **50x50**: a dirt ring road enclosing the **tavern at the middle
— where every round now starts** — with the four working buildings just
outside it in the four quadrants, and four approaches from the gates.
Every route between two buildings passes the square, so nothing important
happens out of sight. The **fourth building is a guardhouse**, so that
"the guards saw you" has a place on the map rather than being an
abstraction applied from nowhere. The well stays **in the open** between
the tavern door and the south gate (D-529): a poisoner has to do it where
everyone walks. Palisade, four wall materials, four roof materials, tree
copses at the corners, and the square's furniture placed **by hand** —
a market whose stalls land wherever the RNG puts them is not a market.
At this size the far corners are inside `COMBAT_NOISE_TILES`, which is
what finally makes D-531's noise model bite in a settled zone.
⚠ **This costs D-530's 30-45s travel band**: a quarter of every errand
used to be crossing Ashfold, and a mid-depth errand is now **22s** and a
deep one **37s**. The band in `server/test/round-map.test.ts` is
**re-measured, not re-derived**; the lever if the longer commitment
matters in play is spoke size, not town size. ⚠ Areas no longer all share
one size, so the generator rebinds `W`/`H` per area.

**Combat runs in ROUNDS (D-550).** Four seconds, on a global beat
(`floor(tick / COMBAT_ROUND_TICKS)`) so "I get one swing this round" is
something two people can agree about. A basic character gets **one
attack**; more comes from feats declaring `extra_attack`, gated behind
`minLevel` and granted by a class's progression. Two gates, both needed:
the **budget** caps the round and **`attackReadyAt` spaces the swings
inside it**, or two attacks could land on consecutive ticks across a
round boundary. ⚠ **This is a REBALANCE**: `ATTACK_COOLDOWN_TICKS` was
20, i.e. two swings every four seconds for everybody, so the baseline is
now HALF what every existing number was tuned against and a level-8
martial is back at par. A second attack is double output — a bigger
fence-crossing than D-546's four attribute points, and confined to the
feat enum so CI can see every source of it. **Reach comes from the
weapon** (`EquipStats.range`, default 1) and **anything past arm's length
needs line of sight**, or a bow would shoot through the tavern wall.
**Auto-attack** engages a selected target that is visibly `hostile` —
never a player, whatever they have done; a player becomes engageable
CLIENT-side by having swung at you first, because a wire field saying
"this player is hostile" would be the game making an accusation (D-217).
Guards and the tavern keeper are NPCs and deliberately not flagged, so
clicking the keeper cannot start a murder.

**Daylight undoes what walks at night (D-551).** Roamers no longer
vanish at dawn — an `entity_dissolved` event precedes the `entity_left`
and the client plays a slow sag of pale motes drifting DOWN, the opposite
motion to an impact burst. ⚠ The event goes out BEFORE the despawn: a
client that has already dropped the entity has nothing to play it on.

**Ashfold has a WATCH (D-552).** A guard is a roamer with
`habitat: 'guard'` — the same spawn, hunt, strike and wander code with
one filter added: who it is willing to hunt. They are on the map all
round, **day and night**; they **do not hunt on sight**; they are worth
**zero xp and carry nothing** (paying for a guard kill would make
murdering the watch a farming strategy). **Witnessing is line of sight**
(D-217): a crime behind the smithy is not seen, the same crime in the
square is. **Only the culprit is told** — the `wanted` memory is
server-side, decays, is never rendered, and clears at reset, because the
moment it is visible the cast reads the antagonist off the UI.
**The well can be spoiled**: bitterleaf and a moment at the water, and
the next drink deepens thirst instead of relieving it. Nothing announces
it. Cheap to do, impossible to do unseen — which is why D-549 put the
well in the open square. This finally implements what D-529 named and
`the-long-hunger` has been waiting on.

**The hotbar belongs to the character (D-553).** It was in localStorage —
one bar shared by every character on the machine. It now saves to the
character and comes back on the next login, sent whole and debounced.
Contents are deliberately **not validated**: a stale ability id renders
as an empty slot rather than losing the other eight. The character panel
gains an **Abilities tab** — drag onto the bar, drag a slot off to clear
it. ⚠ Spells appear **greyed, undraggable and labelled "no casting
yet"**, because a bar slot that silently does nothing is the lie D-538
refused for feats.

**Everything that dies leaves a body, and you can use what you carry
(D-554).** Five things the stakeholder found by playing. **Skill sliders
were 22 pixels wide** — `.sdesc` declares `flex-basis: 100%` and the row
never wrapped, so the description ate the width; nothing threw and the
binding was correct, which is why only measuring the element found it.
**Roamers leave a corpse holding what they carried**, superseding D-537's
"loot goes straight to the killer": a body you loot where it dropped does
not evaporate, and killing now leaves evidence like every other death.
`corpses.character_id` is **nullable** — one shape for a roamer's body,
its loot and a dropped heap — and `NULL` is what the rites refuse on
(there is no spirit behind a dead dog). **A lootable body draws a pack**,
and a settled-zone corpse honestly says it holds nothing. **A body you
watched fall keeps its ragdoll**: the corpse entity ADOPTS the one still
falling, matched by tile, instead of appearing pre-settled on top of it;
anything unwitnessed still arrives settled. **Equipping changes the
model** — a compact `worn` silhouette on the wire entity, read off the
slot and stats rather than item ids. ⚠ It never reaches the descriptor
pipeline, or a helm becomes the permanent disguise D-539 refused.
**`use_item` and `drop_item`**: use dispatches on the TEMPLATE so a new
consumable is a content change; a bandage mends and closes one MINOR
wound only (major ones stay the physician's, D-205) and refuses before
consuming; dropping MOVES the item row to a heap, never deletes it, so
D-114's no-duplication invariant survives a verb that looks like a
delete.

**Imported characters are a build script, not a Blender session
(D-555).** `npm run build:characters` reads a Synty Sidekick
`.unitypackage` and a folder of Mixamo FBX out of `assets/incoming/` and
writes `.glb` into `client/public/models/` — **no manual step, no engine,
no 3D tool**, which was the stakeholder's stated condition for the whole
approach. Everything it needs already shipped inside `three`, and
**FBXLoader runs under Node** on three inert stubs (`tools/src/node-dom.ts`).
The Sidekick skeleton is the **Unreal humanoid**, so the Mixamo map is a
dictionary written once (`shared/src/rig.ts`), deliberately partial —
twists, IK and attach sockets get NO entry, because a mapped twist bone
rotates twice. ⚠ The correction that made it work is arithmetic, not taste:
`retargetClip` copies WORLD rotations, and Mixamo and Unreal disagree about
where a bone points at rest, so the first build folded a 1.78m figure into
a 1.0m concertina. `localOffsets` = `sourceRest⁻¹ · targetRest` fixes it for
any clip, not just the five tried. Clips live in ONE file (they address
bones by name), fingers are dropped, characters come from the pack's own
`.sk` files, and the palette is a **32×32 PNG carried alongside** — which is
why recolouring is cheap and why it suits D-404. ⚠ Two defects here were
invisible in the log and silent in the browser (meshes bound to joints not
in the file; world matrices refreshed from the mesh instead of the rig
root), so `tools/test/imported-rig.test.ts` measures the SHAPE of a walking
figure. Compare the two at `/imported.html`. **The art verdict is the
stakeholder's and D-555 does not pre-empt it**; reconciling imported meshes
with D-539's appearance system and D-547's paperdoll is the work that
follows a yes.

**The importer is not tied to one vendor (D-556).** Art has to come
from outside — generating geometry from code is exactly what D-402 does
and it produces the mannequin already judged subpar; the missing thing is
somebody looking at the result, which D-114 says is not me. So the
pipeline takes **any humanoid FBX**: `assets/incoming/characters/*.fbx`
sits alongside the Synty pack and goes through the same path, and
`detectRig` reads the skeleton to pick the bone map — an unknown rig
**stops the build with its name** rather than being retargeted through the
wrong dictionary. Clips are written **one file per RIG**, and each
character names its own. Proven, not claimed: `mixamo-beta` is built from
a plain Mixamo FBX with no Synty content and it walks, with a test to stop
that rotting. Practical upshot: Mixamo animations are free and carry no
subscription, Synty sells packs outright as well as by subscription
(⚠ verify current terms), CC0 sources build with no new code, and the
committed `.glb` mean a lapsed subscription cannot reach into the repo.
⚠ Finding this out exposed a real bug: **a Mixamo FBX exported with skin
holds TWO identically-named rigs nested inside each other**, so the
union-by-name assembly built the inner one twice — 129 bones for a
65-bone skeleton. Claim the name BEFORE recursing on the parent. The first
attempted fix (dropping `Skeleton.pose()`) fixed Mixamo and silently
shortened every Synty character by 40cm; only measuring both at once
caught it.

**A third rig went in without argument, and one vendor's colour did
not (D-557).** Polytope Studio's free pack proved D-556: `detectRig`
returned NULL and **stopped the build** rather than guessing — the first
time that guard has fired for real. Their skeleton is Mixamo's RENAMED
(`mixamorigX` → `PT_X`), so the map is a transformation with four spelled-out
exceptions (Spine numbering is off by one; toes are `PT_LeftToe`). Their
cape and cloth bones are left unmapped ON PURPOSE — D-519's cloth system is
what should drive those. **A character can now be a FOLDER**:
`assets/incoming/characters/<name>/` assembles every FBX inside it and takes
a `.png` there as its texture, so choosing an outfit is choosing files
(D-110). ⚠ **The shape tests now run PER RIG** (`it.each(RIGS)`) — a wrong
dictionary does not fail, it folds a character in half, so testing one rig
would have shipped the second one broken. ⚠ **The decisive finding is
measured, not argued: Polytope's colour lives in their SHADER, not their
texture.** `PT_Armors_Base_Texture.png` is 256×256 with six distinct
colours, all grey; colour comes from an Amplify (Unity-only) material
tinting regions picked out by seven mask textures. So an imported Polytope
character renders as a WHITE STATUE until somebody writes a Three.js
equivalent — about a day, and it must then survive D-404's quantisation.
Synty costs zero of that because its colour is IN the 32×32 palette.
⚠ **The verdict is: keep the machinery, drop the characters.** The draft
recommendation to keep Polytope as the modular layer was WRONG and the
stakeholder caught it — its weight advantage was measured against the
Sidekick knight, a pack nobody is buying, not against the legacy POLYGON
line that is actually recommended; "free" is free plus a shader day; and
mixing two character lines fails the one-look requirement that was stated
first. The Synty basket already ships **26 characters**. The real loss is
MODULARITY — fixed meshes mean a character is chosen per class rather than
dressed — which is bounded by gear being stripped between rounds (D-522).
Rig detection, folder-as-character, the per-rig tests and the PT dictionary
all STAY; only the built `polytope-knight` is removed.

**A character is content, and there is a studio to build one in (D-558).**
`npm run dev:studio` + `/studio.html`: pick a part per slot, watch it walk,
save. What is written is `content/characters/<id>.json` naming parts, a pack
and a colour atlas — the art stays out of git, the decision goes in (D-110) —
and the save endpoint refuses anything that would not build, the same
guarantee D-543 gives the map editor. 720 of 720 parts file correctly. ONE
assembler (`client/src/render/assembly.ts`) serves both the Node build and
the browser, because a preview that assembles differently from the build is a
preview that lies; extracting it exposed four bugs that had been working by
luck (order-dependence, mutating the caller's geometry, world matrices read
off a detached mesh, and refusing the multiple roots a cape legitimately has).

⚠ **Five defects here loaded cleanly, logged nothing and played — three were
found by the stakeholder looking, none by reading code.** (1) The bone list
was in DISCOVERY order, leaf-first, and `SkeletonUtils.retarget` walks
`skeleton.bones` in array order deriving each local from
`bone.parent.matrixWorld` — a child before its parent is solved against a
stale parent. Damage was not uniform, which is what hid it: legs within 2
degrees, **right forearm 82 degrees out**. (2) Mixamo bakes **155cm of root
motion** into the walk; the server owns position (invariant 1), so it slid
and snapped every loop. Net travel is now stripped from any clip ENDING AT
THE HEIGHT IT STARTED — as a ramp, so the hips keep their sway. ⚠ `death`
and `stand-to-sit` legitimately still travel, and where that leaves a corpse
relative to its tile is OPEN. (3) `Neutral Idle.fbx` ships a SHADOW RIG — 64
zero-offset leaf stubs beside the real 65-bone skeleton — and taking the
first skinned mesh took the stubs, retargeting the idle to a figure with its
arms folded over its head and its hips at 172cm instead of 85cm while the
other four clips were perfect. The real rig is the one that is not duplicates
hanging off another rig's bones. (4) A bone's NODE transform is not where the
bone goes; its **BIND matrix** is. They agree to the decimal for every body
part and disagree completely for a cape (`back_05` binds at y=53.6, its node
sits at y=-80.1, below the floor). (5) A cape is **not a second root** — 13
parts are a chain with no body bone, and parented to nothing it never moved.
An orphan chain now hangs off the body bone nearest where its top weighted
bone BINDS (a cape resolves to `spine_03`), rigid for now; flowing is D-519's
job.

⚠ **Two of the pack's categories are not what their filenames say.**
`SK_Chr_Head_No_Elements_*` are **helmets** — 2-4x the vertices of a bare
head, half again as deep, and no `eyes` bone because the face is inside them
— so a helmed head fills the HEAD slot and a bare one under it pokes through.
`SK_Chr_HelmetAttachment_*` are **crests**, not helmets. Parts now declare
what they CONCEAL and REQUIRE, and the studio greys a slot out with the
reason rather than refusing to save: a crest with no helm, or hair under a
closed helm, builds fine and is simply never seen. Concealment lives on the
PART, not the slot — three cuts of head covering share one slot and disagree
about whether hair shows.

**The studio feeds the build (D-558).** `build:characters` reads
`content/characters/*.json` as a third source beside the pack's `.sk` files
and `assets/incoming/characters/`; pack resolution is shared with the studio
server (`tools/src/packs.ts`) for the same reason `assemble` is shared. A
definition naming an un-ingested pack or a part the pack does not ship
**stops the build by name**, and two characters claiming one id is an error —
the id IS the output filename, so the second would overwrite the first and
load as somebody else. `validate:content` schema-checks the definitions in
CI (a definition can be hand-edited or arrive in a merge) but cannot check
that parts exist, since `assets/source/` is gitignored: it checks what is a
DECISION — unique ids, id matching filename, a complete body, and
combinations nobody could see. `ashfold-guard` and `ashfold-townsfolk` are
drafts, not a ratified roster.

**A definition carries a required `sex`, and the studio filters by it.** Not
a roleplaying statement and never shown to players — it selects which MESHES
fit: the pack cuts most parts twice and a female forearm on a male upper arm
meets it at the wrong diameter. Unisex parts (hair, pauldrons, capes) belong
to both and survive a switch. Required rather than defaulted, or a character
is one mismatched limb from being neither. **A helmet also rules out a head
covering** — a hood is cut for a skull, not over a helm.

⚠ **The pipeline repairs one class of art fault, and says so.** The
stakeholder saw the guard's RIGHT helmet wing tear off on every arm swing:
`SK_Chr_HelmetAttachment_03` is 98% weighted to the head with **26 vertices
fully weighted to `clavicle_r`/`UpperArm_R`**. The first detection rule
("bound to a bone unrelated to the dominant one") flagged 13 of 720 parts and
**most were correct art** — a skirt spans both calves legitimately — so
scanning before implementing is what stopped a repair that would have
deformed good meshes. The surviving rule is narrow: **a part anchored on the
centre line must not touch exactly one side of the body.** Six parts here are
lopsided ON PURPOSE (a sash, a one-hip drape) and all bind both sides; only
one binds one side and not the other. The fix repoints an influence rather
than removing it, so per-vertex weights still sum to what they did, and it is
printed by the build and shown in the studio — a silent fix is a silent claim
that the art was fine.

**The imported cast is IN the game, behind a toggle (D-559).**
`ImportedVisual` is a drop-in for `CharacterVisual` — the same eighteen
members `main.ts` drives, held in one union, so the world code does not know
which cast it has, and **the compiler enforces the interface** (a missing
member is a build failure, which beats any assertion). A Settings control
picks between them, **defaulting to `procedural`**: the imported cast is what
is under evaluation, not what ships. Models load once and are shared —
`dispose()` deliberately does NOT free geometry or textures, or the first
guard to die would blank every other guard in the room. Verified live in the
tavern, both directions, by `window.__rc.cast()` rather than by eye: two
figures at isometric distance are genuinely hard to tell apart in a
screenshot.

⚠ **What a yes to this art would cost, stated on the members that fall
short:** `setPresentation` does NOTHING, so D-219's hood — the thing
recognition depends on being visible — is invisible; `setEquipment` does
nothing, so D-554's `worn` silhouette is gone; there are no emotes; kneeling
borrows the sit; and **only HEIGHT survives from D-539's appearance** (scaled
per instance, or D-201's "towering" descriptors would all be lies). ⚠ **Which
character an entity is drawn as is UNRESOLVED** — picked from the seed, which
is deterministic and agreed across clients but arbitrary: nothing connects
the guard model to a guard. That needs a wire field and a decision about how
a roster relates to classes.

⚠ **Three bugs here threw nothing.** A Map iterator visits entries inserted
DURING iteration, so rebuilding the cast by delete-then-re-add under the same
key looped forever and the tab just stopped painting. `preload()` resolves
AFTER `addEntity` has already run in the same function, so the first snapshot
built everyone procedural whatever the setting said — the manifest is now
fetched at module load. And the palette came out black and yellow from
`flipY = false`: right for textures glTF's own loader brings in, wrong for one
loaded separately onto FBX-exported UVs — it does not look like a bug, it
looks like the artist chose black and yellow.

⚠ **The procedural `CharacterVisual` is DELETED (D-617, stakeholder's
ruling).** There is one cast: the imported models. The two things only the
procedural rig could do were built on the imported cast first — the hood is a
head-covering part swap chosen by a `hood` tag in `content/parts/`, and the
five emotes play the clips the library already shipped — and the Settings
toggle went with it, because a switch that silently changed which renderer
somebody was judging is a way to report a bug about the wrong one.

⚠ **What went with it:** `/imported.html` (an A/B page with nothing left to
compare), `/creator.html` (a preview of the deleted rig), the viewer's cast
grid, seed filters, gear toggles and per-part colour editor, and two tests that
measured generated geometry (`garment-scale`, `walk-grounding`). The **cloth
workbench survives on a placeholder** — `WorkbenchBody`, a jointed stand-in at
roughly human proportions — so a garment tuned there is tuned against an
approximation until something rigged replaces it.

**Creation rules are content, and the art bounds them (D-560).**
⚠ **Course correction from the stakeholder, recorded because it is the reason
this exists:** the imported art must reach the world THROUGH character
creation, not by replacing the system that reads a player's choices. D-559's
toggle is a way to LOOK at the models in situ, not the direction.

⚠ **Two measured facts bound everything.** **Skin is FOUR flat colours** in
the whole 1024² atlas (`#ffccae` 235k px, `#edaf97`, `#cdb3a1`, `#433622`),
which the vendor's `_A/_B/_C` variants merely remap — so a skin tone is an
**RGB a person picks**, not one of three files, and the recolour is four exact
substitutions that compose with any clothing colourway. Shades are derived by
ratios measured across the vendor's own tones. NEAREST filtering is what makes
it safe: each UV island sits inside one flat region.
But **there is essentially NO BARE BODY**: of 720 parts, arms/hands/legs have
**one** bare option per body and torso/hips have **none**. A body and its
clothes are the same mesh. So (a) a race here is a FACE, a stature and a set
of skin tones — not a body; (b) equipment must SWAP torso and limb meshes,
never layer over them.

**Built:** `content/parts/<pack>.json` maps a part to what a PLAYER is told
it is called (`SK_Chr_Head_Male_04` is the right name for a file and the
wrong one for a person, and nothing downstream can show a filename); only the
DECISION is stored, since slot/body/bareness are derived. `content/races/*.json`
curates which parts each slot offers, height per body, and tones —
curated, because 46 heads is a catalogue not a choice, and a race that offers
the same faces as every other race is not a race. `/creation-tool.html` on
the same authoring server as the studio; naming is built for VOLUME (look,
type, Enter), race curation is chips that preview on hover, and an unnamed
part shows as its file stem in warning colour. The preview looks a character
in the EYE (`setOrbitHeight`), not down at the top of their head.

⚠ **This found a third assembler bug that a whole character could not show.**
`Skeleton.pose()` derives each skinned bone's local from its PARENT'S WORLD
matrix and only sets world matrices for bones IN the skeleton — so an
unweighted ancestor reads as identity and its skinned children land at their
bind position measured from the ORIGIN. A head assembled alone sat **1.6m
behind the character**, exactly its own eye height. Fix:
`group.updateMatrixWorld(true)` BEFORE `pose()`. Sharing one assembler
between build, studio and tool is what keeps finding these.

⚠ **The unlettered atlas HIDES face markings.** `PolygonFantasyHero_Texture_01`
looks like the neutral default — no colourway suffix — and is the
markings-free cut. 28 of 46 heads carry war paint on colour `#4566a9`, which
exists ONLY in the lettered atlases, so against `_01` those heads sample plain
skin and look identical to the unmarked ones. The stakeholder found this by
naming the nine unmarked male heads and stopping. Use `preferredAtlas()`,
never the unlettered one. Markings are their own channel (no other part in the
pack touches that colour), so a race carries `markings` beside `skinTones` and
either recolours without disturbing the other.

⚠ **Diagnosing it needed four measurements, and the eye was wrong.** Unique
vertex POSITIONS proved the 23 heads are 23 shapes (vertex counts alone prove
nothing — seams split vertices); hashing canvas pixels proved the tool
rendered each differently, contradicting my own reading of three screenshots
as identical; sampling UVs against the atlas found the missing colour; and
mapping those vertices to mesh positions put them on the front of the upper
face. Reading a render is not measuring one.

**Everything else in the packs is nameable too (D-561).** Every character
slot, not only the face (a torso needs a name — the creation screen is one
reader of these, not the only one), previewed ON a bare-`_00` mannequin
because a pauldron floating in space cannot be judged. Plus three tabs over
one implementation — **worn items, environment, pickups** — sorted by the
vendor's own prefixes (`Wep_`/`Bld_`/`Env_`/`Prop_`/`Item_`), with
`kindOfMesh` returning NULL rather than guessing. Environment carries `solid`
and `opaque` SEPARATELY: a fence stops a body and not an eye (D-217, D-545).

⚠ **Packs disagree about UNITS by 100×.** Measured: dungeon-pack weapons are
0.75–2.38 units (METRES), knights 68–203 and vikings 56–169 (centimetres).
Characters are centimetres. Nothing in a file listing shows this, so a worn
item stores its own `scale`, the tool guesses from the mesh's extent, and the
panel prints **what it measures in cm once placed**.

**Animation does NOT hang under race (D-561)** — the stakeholder asked, and
the weapons are why. Clips bind to bones by name so a set belongs to a RIG;
what really changes movement is what is HELD (163 weapons here); race and body
are flavour. So sets LAYER: `rig ← race+body ← stance`, resolved by layer not
argument order, anything unspecified falling through — which is what makes 163
weapons a handful of stances. The **action vocabulary is closed** (62 actions,
5 groups); only `idle` and `walk` are required, because a character with
neither is a statue that slides. ⚠ **No clip is bound to any action yet** —
this is the foundation, not the wiring.

**Names mirror male↔female, and it is measured (D-562).** `Torso_Female_12`
shares **0.96** of its atlas islands with `Torso_Male_12` and 0.36 with any
other female torso — same garment, different cut. Across every twice-cut slot:
hips 0.97, legs 0.94, arms 0.89, hands 0.94, controls 0.13–0.36. One button
carries ~300 names; it NEVER overwrites, and swaps the body word inside a name
(whole-word, so "Malevolent" survives).

⚠ **A number does NOT group slots into an outfit.** Tested twice: UV overlap
across slots is void as a metric (an arm and torso sample different atlas
regions regardless), and garment-COLOUR overlap — which is not void — gives
**0.34 within a number vs 0.33 across**. No signal; the pack dresses
everything from one palette. So no cross-slot auto-naming: a wrong name looks
finished.

**A "set" is a WARDROBE, not a costume (D-562).** Per the stakeholder: gloves
from one set mix with a torso from another, and some armours leave the arms
bare. So the equippable thing is a **garment** — a list of slot→mesh swaps
covering one slot or five, mixing freely — which is exactly what D-560's
"equipment swaps meshes, never layers" implies. ⚠ Not built; it belongs beside
the rigid props in Worn items and must be authored by LOOKING, since the
numbering means nothing across slots.

⚠ **Bare parts are REPORTED, not thresholded.** Skin is the bottom 0.31 of the
atlas, so bareness is a UV measurement. But no torso is fully bare — the nude
one has a waistband and measures **71%**, next is "Straps" at 29%, the rest
under 10%. A cutoff strict enough to exclude a shirt excludes the nude torso,
in the slot where it matters most. The tool prints the percentage per part,
auto-marks only >95%, and leaves the rest to a person. Stored as a `base` tag
so it survives renaming.

**A worn item hangs off a real bone, previewed on a body (D-563).** The
attach field is a list of the rig's 47 bones, not a text box, and the item is
shown ON an assembled body at the chosen bone so the offsets are worth
setting. ⚠ Four silent bugs to get there: the preview ran on FOCUS before
naming created the asset (so the body never appeared); the body wore the
ITEM pack's atlas and came out bleached; the bone's world scale was ASSUMED
to be 0.01 when a bind matrix carries scale of its own (sword became a dot);
and the cached body accumulated every weapon ever previewed. Framing is
measured from the assembled bounds — a T-pose is wider than it is tall and
the weapon sits past the hand.

**`npm run name:assets` drafts names from filenames (D-563)** — 199 weapons
and pickups across four packs, with stance and attach guessed from the name.
NEVER overwrites. Trailing modifiers move to the front (`Axe_Nature` →
"Nature axe"). ⚠ **The first version HUNG the build**: it rotated one word at
a time while the last was a modifier, so `Bone_Spikes` → `Spikes_Bone` →
`Bone_Spikes` forever — no throw, no log, just no return. Buildings and props
are deliberately not drafted (1,459 `Wall_01`-shaped names is noise).

**Races may have a body, not just a face (D-563).** The race tab lists every
slot; below the neck it offers `base`-marked parts with a "show all N
(garments)" escape, because 29 torsos as ancestry options is a wardrobe, but
a race whose body IS a garment (a skeleton) needs the full list.

**Combat and peaceful are a LAYER, not a doubled vocabulary (D-565).** The
stakeholder asked for holstering animations and a combat variation of every
action that has one. That is a fourth layer — `rig ← race ← stance ←
readiness` — where a set applies to `<stance>/combat`, not 62 more enum
entries most of which would never differ. ⚠ **The two values are not
symmetrical:** `peaceful` is the ABSENCE of an override (a man with a sheathed
sword walks like a man, so the renderer just does not pass a combat set), and
`combat` is where the guard idle, the sidestep and every attack live.
⚠ **Draw and sheathe belong to the STANCE layer**, not either readiness — they
are the transition BETWEEN the two, and putting them in the combat set would
leave a sheathed character with no way to draw (asserted by a test).
⚠ **`carrying` is the one stance with no combat half** — a man with a barrel in
his arms has no guard. ⚠ **It is `Readiness`, not `Posture`**: `Posture`
already means sitting/standing/kneeling (D-506) and the two collided in eight
files. ⚠ **`combat-idle` was REMOVED from the vocabulary**, superseding that
part of D-561: with a readiness layer it is just `idle` through
`<stance>/combat`, and two spellings of one thing eventually disagree.

**A number field you can scroll (D-565).** Fitting a weapon is a dozen small
corrections judged by looking, and typing breaks the loop every time. The
offset, rotation and scale fields take the wheel, with a step chosen per group
(metres, degrees and scale never want the same granularity), shift ×10 and alt
÷10. ⚠ The wheel handler must `stopPropagation` as well as `preventDefault`, or
the stage's own handler flies the camera backwards mid-nudge; and a nudge
writes straight onto the object already parented to the bone, because
`showAsset` re-parses the FBX and that is hopeless per wheel notch.

**There is an animation library, and sets that bind it (D-564, extended by
D-565).** 126 clips across eleven stances, fetched from Mixamo by script, retargeted by
`build:characters`, and bound to D-561's closed action vocabulary by fifteen
authored sets in `content/animations/`. ⚠ **The unarmed clips are the RIG
layer, not a stance called `unarmed`** — that one choice is the whole design:
as the base everything falls through to, `two-handed` names seven clips and is
a complete character; as a stance set it would look identical in the tool and
mean the opposite. So the tool tab shows INHERITANCE, printing what an empty
row will actually play, or an author fills all 62 rows in every set and undoes
the layering by hand. CI resolves every set together and fails if the result
has no idle or walk — a pile of stance sets with no rig beneath them is legal
data that renders a statue that slides.

⚠ **Three clips are SUBSTITUTES and say so where they are declared** (no
woodcutting, smithing or bandaging motion exists in the library), and **`eat`
has no clip at all** — left visible in the wishlist rather than filled.
⚠ **A search that falls back to "first result" ships a crouch as an idle**: the
polearm idle and the crafting clip both arrived as squats, invisible in the
filename, the log and the browser, and were caught only by measuring every
clip's opening hip height against the character's own.

**163 weapons are in hands, placed by measurement rather than by eye (D-564).**
A grip is three things and only one varies per mesh: the pack's UNITS
(measured — 100× apart, D-561), a wrist-to-palm offset that belongs to the HAND
and is constant per family, and which family it is (decided by NAME, since a
round shield and a war hammer measure alike and a wrong guess puts one in the
wrong hand). ⚠ The load-bearing measurement is that **the mesh origin IS the
grip** in both families, so a 2.1m spear and a 48cm knife take the same offset.
⚠ **A shield needs NO rotation** — the left hand's bone frame is the world's at
rest. Re-running is safe because the fitter tags what it owns and the tool
strips that tag on any hand edit. ⚠ **A weapon can be wrong in a way no
geometric test sees** — an un-rotated blade stands upright out of the fist,
hits nothing and measures right — so the test that catches it is CONSISTENCY
against its family, added after corrupting a rotation and watching every other
assertion pass.

⚠ **Nothing in the game reads a set yet.** `resolveAnimations` is called by the
tool and by CI and by no renderer; `ImportedVisual` still picks clips by name.
Binding a character to rig + race + the stance its weapon declares is the next
piece.

**There is a bow, and the stance it was waiting for (D-568).** The
bow/crossbow pack is ingested: two rigged bows, a crossbow and three
projectiles, in CENTIMETRES like the characters. `hunting-bow` had
deliberately carried **no art** since D-566 — giving it a sword's asset to
satisfy the hunter's gate would have been a lie the animation system then
acted on — and now points at a real mesh, connecting the **ten authored clips**
in `stance-bow`/`combat-bow` to something to hold. ⚠ The bows are SKINNED with
an eight-bone draw rig nothing reads yet, and **there is no `crossbow`
animation set**: the stance is a legal value with no clips behind it.
⚠ Two dead branches surfaced, both found by running rather than reading:
`carry()`'s `/bow/` could **never match**, because `_` is a word character —
the `bow` stance was unreachable by the drafter for as long as it existed, and
a bow was simply drafted as a one-handed weapon in the right fist.
⚠ **An ammunition rule was tried and REVERTED**: matching Arrow/Bolt/Quiver
fixed three meshes and broke three others (a "bolt" is a fastener, an "arrow"
modifies a "slit"). **English is not a classifier** — the oddities are filed by
hand, and `name:assets` now skips a mesh catalogued anywhere in the pack so a
person's correction survives a re-run.
⚠ The first archive delivered under that name was the **Generic pack renamed**
— byte-identical, zero bow meshes. Inspect an archive before extracting it.

**Recipes, roamers, objectives, cues, emotes and languages have editors
(D-569).** Two new sections on the creation tool close the last content with a
schema, a validator and no way to author it. The per-entity rules moved OUT of
`validate-content.ts` into pure functions in `shared/`, which CI now calls —
D-543's promise that the editor refuses what the build would refuse is only
true while both read one implementation.
⚠ **The reason recipes needed a tool is the orphan GRAPH.** Repointing the only
recipe that consumed a material leaves that document perfectly valid and fails
the build somewhere else about a different item. Saves run `findOrphans` over
the graph as it would stand afterwards, and a delete is refused by name.
⚠ `validateContent` is NOT what runs on save — it floods every area and takes
3.6–6 seconds. Objectives carry the same trap one level up: shelving the last
one playable at the minimum cast makes the lobby fill and never start.
⚠ **The tool refuses to pretend it can check `kill_npc`.** NPCs are spawned by
Lua, not declared, so descriptors are read from the scripts, offered as
SUGGESTIONS, warned about — and passed as `null` to the validator, because
treating a partial scan as complete would reject every DM-spawned target.
⚠ **That warning found a real bug immediately:** `silence-the-keeper` was
`live` and targeted `"the keeper"`, but the only scripted NPC was
`"a heavyset keeper with scarred knuckles"` in `hanged-ferryman` — and
`round-town` ran no scripts and did not link there, so **there was no keeper in
the round map at all.** D-526 calls it the low-cast workhorse; an antagonist
dealt it could not win. The tests missed it because their fixtures spawn an NPC
with the fixture's own descriptor: they prove the mechanism, not the content.
**Fixed in D-593.**

**A garment is a list of SWAPS, authored by looking (D-570).** D-562's finding,
recorded and unbuilt until now: a "set" is a WARDROBE, not a costume — gloves
from one set mix with a torso from another, and some armours leave the arms
bare. So `content/garments/` holds slot→mesh swaps covering one slot or five.
⚠ Swaps rather than layers because there is essentially **no bare body** in
this pack (D-560): torso and hips have no bare option at all, so a breastplate
layered over a torso would sit over a shirt nobody can remove.
⚠ **Both bodies or the save is refused** — a garment dressed on one body is
wearable by half the cast, and nothing downstream would say so; the other half
would render in whatever was underneath, which reads as an art glitch. The
opposite body is one button, pairing BY NUMBER, which is safe because it was
measured: 0.96 shared atlas islands for a torso, 0.89–0.97 across every
twice-cut slot, against controls of 0.13–0.36.
⚠ **Material is DERIVED from the parts**, finally honouring D-566's admitted
compromise ("should not outlive the garment editor"). The HEAVIEST part
decides — a hauberk with leather gloves is plate, or a suit is gateable by its
least protected inch — `base` never votes, and an untagged garment is
**ungated rather than cloth**. `ItemTemplate` gains `garment`, and CI refuses
an item whose declared material disagrees with it: that disagreement is
otherwise silent, as a class gate letting a magus wear plate.
⚠ Face, hair, brows, beard and ears are **excluded** — a garment is stripped
between rounds, and gear must never reach the descriptor pipeline (D-539,
D-547). `helmet` is included and is not an exception: in this pack a closed
helm IS the head mesh, and it conceals rather than rewrites.
⚠ **Three UI defects, all found by driving the tool, none by reading it.**
`textField` hard-coded `renderRoundList()`, so renaming a garment redrew the
list pane as the RECIPE list beside a garment form — two editors at once, no
error. The list row carried a slot count it never refreshed, reading "0 slots"
beside a body wearing three. And **selecting a garment did not show it** — the
stage kept a bare head from boot, in the one editor whose whole premise is
looking.
**A garment reaches the world, by RE-ASSEMBLY (D-571).** `setEquipment` was a
no-op with a comment saying so; it now rebuilds the character from part files
with the garment's slots swapped, and the plate a player equips is the plate
that renders.
⚠ **Grafting onto the built `.glb` was ruled out by measurement.** A
character's skeleton is the union of ITS parts' weighted bones, so the three
built characters carry 53/47/47 bones in three different orders — and the guard
has cape bones (`Capes_01`, `back_02`…`back_05`) the townsfolk lacks entirely.
Grafting a caped garment onto the townsfolk would remap every cape vertex
through a bone that is not there and pool it at the pelvis, silently.
⚠ `build:characters` writes a `.glb` per PART any definition or garment names
(29 files, 1.7 MB — only what content references). **A part file is NOT scaled
to metres**: the browser feeds it back through the same `assemble()`, and
baking the conversion in would apply it twice and make a 1.8-CENTIMETRE knight
that renders perfectly at the wrong size.
⚠ **The load-bearing measurement**: a re-assembly matches the build's own
monolith to three decimal places on the bounding box, carries the same bone
set, and its **skinned vertices land 90 NANOMETRES apart** under an identical
name-based pose. The box alone only proves the bind pose; posing both by bone
name as a clip does, and comparing `applyBoneTransform` vertex by vertex, is
what proves the skinIndex remap — and a wrong remap is a limb following the
wrong joint, which reads as bad art.
⚠ **Bone ORDER differs between build and browser and it does not matter** —
part files carry only the ancestors they need, so sibling order at a branch
point differs. Chasing that down rather than weakening the test is what
produced the 90nm assertion. What DOES matter is that parts arrive in
`CHARACTER_SLOTS` order: JSON key order gives the same 53 bones in a completely
different arrangement, and two correct-but-different assemblies make any
build-vs-browser comparison meaningless.
⚠ `WornLook` gains `garments`, as public as the silhouette flags beside it and
still never reaching the descriptor pipeline. **Order is a rule** — two
garments can claim one slot, so `lookOf` sorts by the equip-slot vocabulary or
two clients draw the same person in two different coats. **Sex is NOT on the
wire**: a garment is cut for a BODY, not chosen by a player, so it rides on the
manifest.
⚠ The common case costs nothing (`loadDressed` falls through to `load`);
assemblies are cached per combination so a crowd in one kit shares one; the old
model is **removed, never disposed** (shared geometry); the animation is
**carried across, not restarted**; and a token guards the constructor's own
load, or `setEquipment` landing first would be undone by the bare model
arriving second.
⚠ The **procedural cast ignores `garments` deliberately** — it generates armour
from the five flags, and reading both would draw the same pauldrons twice.
⚠ **Three defects the headless pass found, none of which threw.**
`publishWorn` compared five fields and not the sixth — helm/pauldrons/cape/
robe/weapon is a SILHOUETTE, not an identity, so changing from one suit of
plate to another read as "no visible change" and was never broadcast: the
wearer saw it and nobody else did. `main.ts` handled `entity_worn` with
`instanceof CharacterVisual`, so the **imported cast never heard about a change
of kit** and a garment appeared only on the next full snapshot. And
`BotClient` never handled `entity_worn` at all, so every headless assertion
about equipment was silently testing the starting kit.
⚠ An unknown-entity `entity_worn` is deliberately NOT a bot violation: entering
the world publishes the silhouette before the entity is broadcast, the
following `entity_entered` carries the authoritative value, and the real client
drops it on the same `if`.
⚠ Still missing on the imported cast: `setPresentation` (D-219's hood) and
emotes. Equipment is no longer on that list.

**A character has a RACE, and the race bounds it (D-572).** ⚠ Until now a
character had none at all: `content/races/` was authored (D-560), curated in
the tool, and every calling had carried a `races` list since D-566 — with
nowhere to record what a character actually IS. The gate could not fire, the
authored height ranges bounded nothing, and the server did not even load
`content/races/`. Added: `raceId` on creation, on the record (migration 0015),
on the summary and `status`; races in server content; and one pure rule the
gateway enforces.
⚠ **Optional, exactly as `classId` is** — every existing character, every bot
and every older client sends none and is unchanged, and a calling naming no
races admits all (all nine name none today). Authoring NARROWS; nothing is
silently locked. The column is nullable for the same reason: giving existing
characters a race would invent a fact about somebody else's character.
⚠ But a race that IS sent must resolve — an id nothing can look up makes a
character whose race is a string rather than a thing, and it survives into the
renderer before anybody notices. An unknown race reports ONE problem and stops.
⚠ **The height bound takes the UNION of the race's per-body ranges**, because a
character has no body sex to match against: `sex` selects which MESHES fit
(D-558) and nobody has ever asked a player for one. Narrowing per body would
enforce a fact nobody stated.
⚠ Verified against the **REAL Postgres store**, not only `MemoryStore` — a
column added to the type but not to the INSERT passes every in-memory test, and
the fake being more permissive than the real one has cost a login before.
⚠ **The class editor already had "Races it admits"** since D-566; only the
enforcement was missing, and the note there now says the gate refuses a
character at creation.

**The creation screen ASKS what you are (D-573).** D-572 gave a character a race
and the server the rules to judge it; nothing asked, and `content/races/`
reached no player. The wizard is now **calling → race → face → …**, and the
order is the design: a calling may admit only some races (D-566) so the choice
must be narrowed by one already made, and a race curates which faces and
statures exist (D-560) so it must precede the face.
⚠ **The step exists only when there is something to choose** — a server with no
races skips it, the same rule the spell step follows for a non-caster. Verified
both ways: six steps without, seven with. `creation_content` carries races
WHOLE, not as ids, because the screen needs what each curates.
⚠ **The face step is bounded by the race**, or a player builds a 2.05m elf and
is refused at the last step *after naming it*. Measured in the browser: an
elf's slider reads 1.60–1.85, a human's 1.60–1.90. Changing race **rebuilds**
the panel rather than clamping — silently moving a slider somebody set is the
game editing their choice. A fresh ROLL is clamped, which is not the same edit:
nobody has chosen that number yet (seed 12345 rolls 1.703m, starts at 1.64 in a
1.62–1.64 race).
⚠ **Changing the calling drops a race it does not admit**, like the feats and
spells already were. And a calling that admits only unauthored races names the
calling and sends the player back rather than showing an empty grid.
⚠ `racesForClass` lives in `shared`, not the screen: the doctrine forbids logic
only exercisable through a browser, and getting this backwards offers exactly
the races a calling refuses with no symptom until the refusal.
⚠ **The review summary names the race** — chosen five steps earlier and
otherwise never mentioned again. It reads "Elven Man-at-arms".

**A race is a FACE, and the face a player chose is what the world draws
(D-574).** The creation step offers exactly what the race curates, the server
refuses anything else, and `ImportedVisual` assembles it.
⚠ **This answers what D-559 left open** — "which character an entity is drawn
as is UNRESOLVED... nothing connects the guard model to a guard". Nothing needs
to: **the player said.** The seed still answers for every NPC, roamer, corpse
and pre-face character, which is almost everything, and that is a fallback
rather than a failure.
⚠ `CharacterLook` is SEPARATE from `AppearanceOverride`, because the latter is
what the descriptor pipeline reads to call a stranger "a towering,
heavy-built figure" (D-201/D-539) — those numbers must outlive whatever art
renders them. A look is an additional layer; a character with none renders
exactly as before. Skin is stored as an **RGB, not a tone id**, so a race can
rename its tones without changing somebody's face. One JSONB column, because
the slot vocabulary grows with the art and a migration per hat is nobody's job.
⚠ **Curation is a rule, not a menu**: every part must be one the race offers
FOR THAT SLOT, or a hand-rolled client makes the curation decorative. A look
with no race is refused outright — there is nothing to check it against.
⚠ **The preview swaps to `ImportedVisual`** once a look names parts: a creation
screen that previews a different cast from the world is the exact lie it exists
to avoid. The procedural sliders still matter — they are what the descriptors
read.
⚠ Two things the player is NOT asked: the **body** (a race curates one bare
option per slot, so it is filled from the face's own cut) and their **sex**
(the chosen head already carries it in its filename; storing it too would be a
second source that can disagree).
⚠ **The skin recolour is pixel-counted, not claimed.** On a real character,
235,306 skin pixels become the chosen colour while `#49667e` (449,857) and
`#2d3237` (77,958) — the garment colours — do not move at all. Tinted palettes
cache per COLOUR, and the colour is part of the model cache key or two
characters in one outfit share one face. An undecoded palette returns
**untinted** rather than caching a blank under that key.
⚠ `build:characters` now exports every part a RACE curates — **183 files,
8.6 MB** — or a chosen face is a 404. A client still downloads only what it
looks at.

**⚠ The head cannot be filtered by the cut it decides (D-575).** Asked to add
female heads and brows, and they were ALREADY THERE — both races curate all 23
male and 23 female heads, 10 male and 7 female brows. The "male-only" claim came
from reading the first four entries of a list, which happen to be male; the file
said otherwise.
⚠ **The symptom was real and the cause was code.** `renderFace` filtered every
slot by the chosen face's cut, `head` included — so all 46 showed until you
picked one, and then the other 23 vanished **for good**. A one-way door that
errored nothing and logged nothing, whose only symptom is "I cannot make a
woman". Every OTHER slot must be filtered (a female brow on a male head meets it
at the wrong diameter, D-558); the head must never be. `partsForSlot` lives in
`shared` and is tested.
⚠ **And the labels hid the only distinction on screen** — six faces read
"Head 00"…"Head 08", and "Eyebrow 01" appeared in both lists meaning two
different meshes. A fallback label exists to be legible until somebody names the
part; one that hides the distinction is worse than the filename. Now
"Head Female 05".

**⚠ The names were authored and only the TOOLS could read them (D-576).**
Reported as "I already named the heads/faces — how did you lose it?" Nothing was
lost: `content/parts/` holds **720 names**, valid and CI-checked throughout. It
was read by the naming tool, the studio server and the validator — all three
authoring tools — and **the game server never loaded it**, so the creation
screen derived a label from the file stem and offered a face called "Scarred
mouth" as `Head Female 05`. Now loaded beside the races and carried on
`creation_content`, trimmed to the 142 parts the races curate (5.2 KB of 720).
⚠ **Naming them CREATED a collision the stems had hidden**: 20 of 23 head names
are shared across the two cuts — "Burnt" is a male face AND a female face — and
D-575 requires all 46 on screen at once, so names alone give twenty pairs of
identical chips. A row showing BOTH cuts is now grouped under `male`/`female`
headings, keyed on what the row CONTAINS rather than on `head` (before a face is
picked nothing is filtered, and the brows row was offering five names twice).
⚠ **The same mistake one layer down:** `.chip`/`.chip.on` are styled in
`creation-tool.html` and `editor.html` and have **never existed in
`client/index.html`** — so 46 faces rendered as unstyled text and the CHOSEN
face carried no mark at all. Both halves are one thing: the tool had it and the
game never asked. ⚠ Worth checking wherever else the two share a vocabulary.

**⚠ A garment-dressed body rendered 100× too large, everywhere (D-577).**
`ImportedVisual.attach` did `scale.setScalar(appearanceHeight / outfit.height)`.
That SET the scale, wiping the centimetre-to-metre conversion the re-assembly
loaders apply — part files are exported unscaled by design (D-571) so the
conversion happens once, in the loader — so **every garment and every
player-chosen face was drawn one hundred times too big**, in the world as well
as the preview. It also divided by the MONOLITH's manifest height (1.667m)
while drawing a different assembly (1.90m). Loaders now report the height of
the model actually built and `attach` MULTIPLIES.
⚠ **The measurement had to match the build, and the tidier one was wrong.**
`build:characters` measures stature from BONE extent; mesh bounds include
helmet crests and hair, so the authored guard is 1.92m by geometry and 1.70m by
skeleton. Using bounds would have silently resized the existing cast by up to
13% with every test still green. The browser now reproduces the build's number
to 0cm on all three outfits.
⚠ Also here: the overlay's three forms (login / characters / creation) had no
owner — `open()` relied on whoever called it having hidden the login fields.
`open()` now owns the panel, and `close()` no longer decides what replaces it
(right for cancel, wrong for a dropped connection, which was correct only by
statement order).

**What a character HOLDS now decides how they move (D-578).** D-564 built the
library — 126 clips, fifteen sets, a closed vocabulary, CI resolving them all —
and recorded that **nothing in the game read a set**. The renderer picked clips
by hard-coded NAME, so eleven stances animated identically and a man with a bow
swung it like a sword. The stance now travels with the item (beside `garment`,
for the reason written there: `lookOf` is keyed off slot and stats, and a stance
is the other fact numbers cannot give you), is resolved SERVER-side against
content (D-102), rides on `worn`, and the renderer flattens
`rig ← race ← stance ← readiness`.
⚠ **The same broadcast bug as D-571, one field later, found by a test rather
than by reading the comment directly above it:** `publishWorn` compared the
silhouette and `stance` was in the payload but not the comparison — a bow and a
sword give identical flags and identical garments, so **drawing a bow was
judged "no visible change" and never broadcast**.
⚠ **Resolved up front, not on first change of kit** — lazily passed every test
and left the defect for the common case, since roamers, the watch and every
corpse never equip anything.
**Turns on things already paid for:** kneeling is its own motion (D-559's "there
is no kneel" was wrong — `unarmed-kneel` shipped and nothing read it); the
attack VARIANT D-516 has always sent is finally used; a bow resolves
`attack-1 ?? shoot`, because you do not swing a bow.
⚠ **Gaps exposed, not fixed:** the RACE layer is unreachable (`raceId` is on the
character record, not the wire entity — no race set is authored, so nothing is
lost yet); `crossbow` and `one-handed-shield` have no set; `dagger` and `thrown`
have no combat idle, which is a gap in the CLIP LIBRARY rather than the content.

**The ground is PAINTED, and the paint reaches a player (D-585 → D-589).**
A brush, not a tile grid — the stakeholder was explicit: "I do not want the
painting to be tilebased, I need a brush that paints where I choose, with
smoothing/blending". What is painted is a MASK carrying weights; the shader
composites each material's own texture at full resolution. **Six materials per
map** across two masks of three weights each, with a remove control that
COMPACTS the channels — clearing one alone would leave a hole nothing could
use, which is the bug that made the editor's old "rub one out to free its
channel" false advice for as long as it was on screen.
⚠ **Alpha carries nothing, and that is measured rather than argued.** D-587
made alpha the coverage; a premultiplied canvas loses precision in proportion
to how small alpha is, so that destroyed the weights exactly at the soft rim of
every stroke — 784 of 12,825 texels on one stroke gone outright, 6,292 drifted,
compounding on every read, save and reload. It did not look like a bug; it
looked like a slightly harder edge. Alpha is now 0 or 255 (the two values that
round-trip exactly) and coverage comes from the weight total in the shader.
⚠ **A ground material carries `walkable` and the server does not read it** —
where a body may stand is the tile grid and the collision volumes (D-542,
D-584), or painting a map would silently re-cut it. Asserted.
⚠ **Not verified: the three lines in `main.ts`** that build the plane on a
snapshot — that needs a logged-in player.

**Ashfold is painted (D-590).** `tools/src/paint-round-town.py`: grass, dirt,
cobble, boards, mud and leaf mould over the whole 50x50.
⚠ **The tile grid is a GUIDE, not a stencil.** Each boundary is blurred into a
soft edge and then DOMAIN WARPED off the grid — in that order, because the
other order was tried and looked at: warping a hard edge and blurring after it
only survives while the warp is wider than the blur, and at 0.38m under a blur
with a metre of support every boundary came back perfectly straight. One shared
displacement field for all six, or they move independently and open seams.
⚠ **A building is where its BUILDING is**, not where the grid changes
character — the tavern stands across the ring road, so the tiles under it say
`dirt` and the first pass painted the road through the taproom.
⚠ **`tint` and `wash` are two fields now**, superseding D-585. One number was
doing both the no-art fallback and a multiply over the art, and a material's
tint is roughly its own texture's average colour — so every surface was being
squared. Mud rendered at an albedo of 0.107/0.080/0.051, about as dark as coal,
and the town read as bad lighting.
⚠ **`build-round-map.py` put Ashfold's wall TILES back, for the second time** —
an invisible second palisade inside the real one, which parses, validates and
floods as reachable. A warning that has been read and not acted on is not a
control: the generator now carries `SHAPE_IS_AUTHORED = {'round-town'}` and is
idempotent, proven by running it twice and diffing.

**Ashfold is dressed, and three art faults are fixed (D-591).** 172 objects —
market stalls with goods, benches at the well, a woodpile at the smithy, a
weapon rack at the guardhouse, torches at the gates, grass and flowers over the
green.
⚠ **Every solid placement is refused if it would stand in a route**, and
refusals are PRINTED. The keep-clear set is derived from the map — the road, the
ring, two tiles around every facility, the spawn — **plus the four corners of
the square, because `mr7-ashfold.test.ts` walks a body to each of them**. The
first pass put a barrel on one and a stall on two more; all were reachable, so
the flood passed, and the walk test said "no route to (20,20)". A tile a test
stands on is as load-bearing as a road.
⚠ **A flower is not a wall**: nearly everything in these packs is `solid`, so
anything scattered for looks carries an explicit empty mask.
⚠ **`flipY = false` inverted the V axis for every piece of world scenery.** The
line cited D-559 — which is about characters, and whose own code says "NOT
flipY = false". Cobble paths rendered BLUE and trees grey-and-pink; most of the
pack looked fine because the atlas is roughly symmetric in tone. The editor
never set it, so tool and game disagreed — the failure D-543 exists to prevent.
⚠ **Two meshes have a CORNER origin** (`SM_Env_Path_Cobble_01/_02`), so every
paved way was drawn 1.5m off the road it was laid on. `originCorrection` is in
`shared/` and read by both the build and the editor; it is narrow on purpose —
centring every mesh on its bounding box would walk every tree off its trunk.
⚠ **A statue cannot always be re-textured**: `SM_Prop_Statue_01` gives all
11,598 vertices ONE uv in the vendor's file, so it can only ever be a flat
colour, and all ten of the pack's atlases give a brown there. Replaced, not
repaired.
⚠ `tools/src/why-unreachable.ts` names what seals a tile off. Its first cut
wrote its own flood and reported every tile reachable while the build refused
the same map — it now imports `unreachableTiles`.

**Every area is painted and dressed (D-592).** `paint-areas.py` (a table, not a
script per map) and `dress-areas.py` (layers of scatter) cover all twelve:
24 masks, 8.9 MB; ~2,800 placed objects.
⚠ **Three areas had been FLATTENED to empty rooms and it was found by
surveying, not by looking.** `walls-to-assets.py` turns wall TILES into pack
meshes, then `strip-procedural.py` (D-582) deleted every asset in eleven
areas — including the walls that had just become assets. The **first-slice
tavern, the persistent world's default start, was an empty 32×32 hall**, and
so were the yard and the crypt. Recovered: the yard's and crypt's grids lifted
out of the last commit, the tavern rebuilt by `build-tavern.py`. Their walls
stay TILES — D-545 renders those at full height, and re-running the converter
is half of what caused this.
⚠ **A legend is not a surface.** The crypt is 89 tiles of one kind, the mine
9,388 — so a recipe driven only by the legend paints a single flat colour.
`patches` throws a second material across in blobs, thresholded at a QUANTILE
of the noise, because fbm is not uniform and a guessed cutoff was 8% cover on
one map and 41% on another.
⚠ **The guard and the authority cannot be the same code.** The placer is Python
and `unreachableTiles` is TypeScript, so the placer only approximates — it
passed eight areas the build then refused. `prune-unreachable.ts` runs the real
check and deletes scatter until the map is whole (196 objects), touching only
placements marked `dressed` — a flag that is in the SCHEMA because zod strips
what it does not know.
⚠ `round-wood` was repainted after looking at it: the ingested forest-floor
photo averages a dry olive-tan, so the wood read as a sand flat with trees on
it. Grass is the base; bare needle floor is a patch.

⚠ **Still to build:** the keyword gating that ties equipment/spells/actions to
class and race — `tags` exists on every asset and nothing reads it yet.

**M4b remaining:** richer injury/treatment types (D-205 matrix), Vessel's
Plane Shift, class balance beyond the first pass. **Other gaps:**
inventory/character-sheet UI (the effective sheet is now on `status` and
unrendered), invisible DM observation, staging VPS not provisioned.
**Everyone who arrives in a round is told what they are (D-579).** The note
here used to say a late joiner never receives `round_role`. True, and the
smaller half: `secretRole` is keyed on the CHARACTER, so **the antagonist who
dropped and reconnected lost their objective** while the round carried on —
a round is one player having a secret task, and a dropped connection silently
disarmed it. ⚠ `round_state` still arrived, so the HUD showed a running round
with a live clock: the player could see the round and had no idea what they
were in it. One `sendRoundRole` now serves both the start and every arrival,
sent to EVERYONE (a message that arrives for some and not others is itself the
tell) and carrying the SAME objective, never a fresh draw.
⚠ **Exposed, not fixed — a design question for the stakeholder:** a latecomer
can never BE the antagonist, so everyone can deduce that anyone who arrived
after the start is innocent. At a cast of three to five that is a free
elimination. The obvious fixes are worse (reassigning changes the win condition
mid-round; barring late joiners shrinks an already small cast). ⚠ **Blocked on the stakeholder, MR-specific:** night DANGER tuning (roamer
strength vs a mid-round character, whether roamers may enter settled areas —
the reward side is settled at 1.5× by D-528, but the two must be tuned
against each other); hunger tuning (need events
per round, what the first stage costs, whether starvation can kill inside a
round or only incapacitate); multiple antagonists above a cast size, and
whether they know each other; minimum party size to enter the dungeon at low
cast counts; whether an objective may ever sit *inside* the dungeon; what a revived
player returns with.

**Ten notes from playing, answered (D-618 -> D-624).** The tavern's walls,
tables and hearth were TILE KINDS drawn as generated geometry -- the last
procedural world indoors -- and are pack meshes now; ⚠ the rest of the world
is **17,000+ wall tiles across eleven areas**, flagged rather than quietly
narrowed. Corpses survived the reset and replayed their deaths forever;
`sweepTheDead()` clears bodies AND their item rows, or the rows are owned by
nothing and still counted by D-114. A bot showed up as a goblin because the
appearance lottery drew from all twelve built characters and **ten are
monsters**; a definition DECLARES `kind: 'person' | 'creature'` now, defaulting
to `creature` so an unclassified one stays out of the pool.

**Combat has a pace (D-619, every magnitude unratified).** A weapon up is a
**run** -- `RUN_SPEED` 4.2 against a walk of 2.9, off the server's own combat
flag, so one fact drives the server's movement, the client's glide and the
clip. ⚠ 1.45x rather than 2x: at double speed a body crosses the whole gap
between two swings and back, which turns a non-twitch game (D-104) into
kiting. The watch was **capped below a walking player** -- a roamer lays one
metre of route every `moveCooldownTicks`, so 4 held a guard to 2.5 m/s and it
could never catch anybody who simply left. And a named objective had **ten hit
points**: not a content decision but the world's `spawn` default, which no
content file could reach. `NpcDefSchema` has `hp` now, defaulting to ten so
nothing unauthored moves, and both keepers are 40.

**Weapons are put away (D-620), the dead see a pale world (D-621), and what
you can use lights up (D-622).** A hover outline is an inverted hull pushed
along the vertex normal BEFORE skinning -- scaling the object leaves the
outline welded to the bind pose while the body walks out of it. ⚠ The veil's
look is unratified, and its colour space was wrong in a way that looked like a
taste problem: every veiled pixel a third too dark until the pass encoded its
output.

**Two things nobody could edit became content.** Which mesh the hood is
(D-623) is a picker in the creation tool rather than a tag typed into JSON, and
the **cast that fills a lobby** (D-624) is `content/bots/` rather than eleven
names hardcoded in the server. ⚠ Draw order is an authored field, not the
file listing: alphabetically the first three companions are a woodsman, a
delver and a gatherer, with nobody on the farm -- and an unworked arm makes
hunger look broken when it is merely unattended.

**The taproom is furnished, and it was invisible (D-625).** D-618 turned the
tavern's walls, tables and hearth into pack meshes and stopped one step short:
⚠ **three of the four had never been BUILT.** `build:environment` ships only
what the world places and was not re-run, so they validated, flooded and drew
nothing -- one `console.warn` each and bare boards with chairs on them. A test
now asserts every mesh every AREA places is built, naming the map. ⚠ The wall
was also from POLYGON's **modern** kit (its atlas ships tyre decals and dollar
signs); the room is one pack now -- boarded timber walls, trestle tables,
stools, barrels, candles and a stone hearth. ⚠ **A collision mask is authored
in the MESH'S frame:** `transformVolume` multiplies it by the placement's scale
and adds its rotation, so masks written in world metres came out a quarter too
big and narrowed the doorway to 69cm against a body radius of 30 -- the room
was sealed, and `map:why` blamed a wall two panels away that had grown.

⚠ **A pack mesh may have no BACK (D-626).** The taproom's wall panel is an
open shell -- measured: 94 of its 208 triangles face +z and **none** face -z --
and glTF culls backfaces by default, so from outside you looked straight
through the wall. It is placed TWICE now, a half turn apart, because a
double-sided material would draw the same face lit by a normal pointing the
wrong way. ⚠ The twin is 0.998 scale: back to back the tops and end caps are
coplanar and z-fight, and no offset fixes that -- a shift along the normal
leaves the horizontal tops where they were. ⚠ Only that one mesh is
one-sided; every other thing in the room is a closed solid. The general case
is open: "one-sided" belongs in the asset catalogue beside the measured size,
and the other eleven areas' walls have not been checked.

**The Round has EDGES, and they are data (D-627, D-628).** The scope changed in
D-521 and nothing in the repo recorded which game an area, a verb or a
definition belonged to — so the two products ran as one world. ⚠ The proof:
`RoundEngine` had **no concept of an area at all**, while the live graph ran
`round-town -> hanged-ferryman -> broken-yard -> sunken-crypt`, which is
`zone: endgame` and carries involuntary permadeath — the one thing D-523 says a
round must never contain. Nothing gated it. A **scenario**
(`content/scenarios/`) now declares the areas a round is played in; a
transition out of the set is refused, and CI refuses a scenario containing an
endgame area. ⚠ The map was the smallest of three holes: the cast was only
gathered at a RESET (so every server's first round began wherever people logged
in, which is out of bounds), and a latecomer arrived at `defaultAreaId`. Three
sites each answered "where is the round?" with a global default — that is what
no boundary looks like from the inside. ⚠ `retire` and `pay` were ungated
inside a round; `speak_dead` deliberately stays open, because the MR gate names
"question a corpse" as something a good round contains.
⚠ **Read `docs/SYSTEM_INVENTORY.md`** for what belongs to which product, what
is wired, and what is authored and read by nothing.

**There is ONE tavern, and a latecomer is always good (D-634, ratified).**
The "two taverns" D-627 left open were one building: `round-town` holds a
facade no body can stand in (D-593) and `hanged-ferryman` is the taproom
behind its door. The taproom is inside the round now, and the round's edge is
its door to the yard. ⚠ Two keepers stand as a result — the taproom's own and
Ashfold's at the door — and which one stays is the stakeholder's call. A
latecomer joins on the good side; the deduction cost D-579 named is accepted.

**Seven notes from playing, answered (D-636).** The "pixelation" was
`setPixelRatio(1)` and no antialiasing left over from the quantiser; the
world draws at device density now. **The round opens in the taproom**, each
arrival on the nearest free non-door tile to the spawn, and **the watch walks
outdoor settled areas only**. A swept corpse's row is closed (they were
restored on every boot) and the round's START sweeps and stands ghosts up.
The death clip was played by a name that did not exist and then looped
through `update`; it is a one-shot whoever asks. **Double-click runs** at
`SPRINT_SPEED` (2x walk, above the combat run -- unratified). **Attacking
ENGAGES**: the client walks within reach and keeps swinging until any other
action; bots are unchanged, and the loop is client-side on purpose.
⚠ A bot agent standing on a barred door now learns it goes nowhere;
positions are metres, so "on the tile" is a distance, never `===`.

**Vertex colours are not art (D-637).** Pack FBX carry a colour attribute
on some meshes -- black on the goblin staff, unneeded on this pack's heads
-- and both FBXLoader and GLTFLoader turn vertex colours ON for such a
mesh, multiplying the atlas by it. The assembler and the environment build
drop the attribute; every loader strips it from older files; a test refuses
a built file carrying `COLOR_0`. **The stage can be photographed:**
`window.__stage.snapshot()` plus `POST /api/snapshot` write the tool's
stage to a PNG for an image reader, which is how 240 parts were looked at.
**192 garments** cover the pack the way the stakeholder authored the Gothic
set: one per torso with arms chosen by looking, one per other wearable
part. ⚠ The arm pairings are a first pass; every part is exported now
(700 files, 40 MB).

**Nothing procedural is drawn (D-638, the stakeholder's ruling).** The tile
renderer is DELETED. The tile grid is the walkability lattice and nothing
else: every tile in every map is walkable, the ground is a painted mask, and
anything that blocks a body or an eye is a placed mesh with a collision
volume. `validate:content` and the editor's save refuse an unwalkable tile;
`npm run map:convert` (`tiles-to-assets.py`) turns a map's wall, rock, tree
and water tiles into meshes carrying the tiles' exact collision -- run it
after `build-round-map.py`, which still lays tiles. The editor has no tile
tool. `WorldAssets` instances a mesh placed four or more times; seats stay
objects. ⚠ The converter's unit volumes are counter-rotated on purpose.

**Effects are content, made on one page and applied anywhere (D-639).**
`content/vfx/` holds particles + light + glow definitions; the authoring
tool's **Art → Effects** tab previews them live through the game's own
`VfxSystem`. They are placed on maps (`AreaSchema.vfx`, the editor's `vfx`
tool), named on items (`held`, `attack`, `projectile` -- an asset, a VFX or
both -- and `impact`), and a blow carries `show` resolved SERVER-side off the
weapon, as stance and art are. ⚠ Lights go through the eight-light pool
(D-544); motes are simulated in world space whatever bone they ride on.
Every magnitude is unratified; the built-in bolt and spray remain the
fallback for a weapon with no effect.

**A cue is heard in the tool through the game's own player (D-635).** The
cue editor's preview is `SoundBank` handed the form's copy of the cue, so
trim, split and normalisation are heard as the game applies them, and the
line under the button reports what the decoder found. ⚠ Not headless: the
`window.__sound` hook is the only automatic probe.

**There is ONE authoring tool, on ONE server (D-629).** `npm run dev:tools` +
`/creation-tool.html`: seven stages read left to right — **Art → Motion →
Bodies → Things → World → Rules → Scenario** — each using what the one before
it defined. The character studio (`/studio.html`) and the cloth workbench
(`/viewer.html`) are tabs of Bodies now; the map editor's server (8140) is
merged into the authoring server (8150) and the builder is embedded under
World; the **Scenario** stage is new and edits D-627's boundary with the same
function CI refuses on. A badge per stage reports what is **unbuilt** —
the finding nothing else made, and the one D-625 cost a session to.
⚠ The stages are a REGISTRY in `creation-tool.ts`, not HTML: a tab is one
line there. ⚠ Tab modules live in `client/src/tool/` and take a `ToolContext`
rather than the page's globals — the pattern to extract the rest into.

**A save reaches the running game (D-630).** `shared/src/pipeline.ts` is the
dependency map — content directory → the builds it invalidates and whether
the server takes it **hot**, **warm** (areas, at the next reset) or after a
**restart** (scripts) — and a test fails on a directory with no entry.
**Publish** in the tool runs only the invalidated builds, streams them, and
calls `POST /api/dm/reload-content`; `GameServer.reloadContent` swaps the
lookups, tells every client (`content_reloaded`, which drops model caches)
and reports what it could NOT apply rather than claiming it did. **Animation
sets, ground, grips and part names ride the wire** (`render_content`, sent
when a socket opens and after a reload) instead of being Vite imports —
`content/animations` is loaded by the game server for the first time.
⚠ `audio/sounds.json` stays a build-time import: the menu plays before a
connection exists. ⚠ The login form's default port now comes from `.env`
through Vite, the drift D-628 fixed for the bot runner.

**Every mesh is filed from one place, and cloth is tuned on the real thing
(D-631).** The **Filing** tab is first on Art: every mesh a pack ships, what
it is used as (body part, clothing, creature, weapon, environment, pickup,
**projectile** — a fourth asset kind), several uses per mesh, and the
unfiled highlighted. ⚠ Filing is READ off and WRITTEN back into the files
the game already reads (`content/assets/`, the `base` tag in
`content/parts/`, `content/characters/`) — never a document of its own.
Unfiling is refused by name while anything references the asset. The
**cloth workbench** runs the game's own solver (`render/mesh-cloth.ts`) on
the pack's own skinned part: free vertices are read off the artist's bone
weights (the cape chain `back_02..05` under a `Capes_01` collar), settings
live in `content/cloth/<pack>.json` keyed by part stem, ride
`render_content`, and `ImportedVisual` simulates them on anybody wearing
the part through a world-space proxy mesh. ⚠ `applyBoneTransform` takes the
vertex IN the vector it is handed; the pack's FBX parts are non-indexed
triangle soup and are welded. ⚠ The old grid cloth (`render/cloth.ts`,
`cloth-lab.ts`, `cloth-ui.ts`, `workbench-body.ts`) is deleted. Every cloth
number is unratified.

**The dead are drawn as their race's ghost (D-632).** A race names a
`content/characters/` id as its `ghost`, picked on Bodies › Races. On death
the server puts it on the entity's `model` before the ghosts present are
told, and sends the dying player an `entity_model` delta so they draw
themselves the same way; the living hear nothing (D-203). The look crosses
doors with the entity. Refused by CI, the editor and the server load when it
names no definition. Both races default to `character-ghost-02`, unratified.

⚠ **Unratified balance awaiting the stakeholder:** the run multiplier, the
watch's damage and cadence and the keepers' 40 hit points (D-619); the veil's
palette (D-621); creation
budget (D-515), combat window / attack roster / carry formula (D-516),
Legacy class pricing (D-512), zero-award endgame death (D-513),
**every magnitude in the attribute chain (D-546)** — the four level-up
points, ten skill points a level, which levels carry a feat, the mana
costs, the glance cap — and **every item weight, armour and damage
value (D-547)**.
