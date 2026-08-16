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

**M3b remaining:** visual form-based event editor, rehearsal mode, templates,
rollback, death/item triggers (blocked on M4). **Other gaps:** active
disguise-piercing (M4 skills); staging VPS not provisioned.
