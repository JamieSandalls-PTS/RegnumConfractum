# System inventory — what exists, who it belongs to, whether it is wired

**Written 2026-09-17 against the code, not against memory.** Companion to D-627,
which rules that there is one engine and two products and that the **scenario** is
the boundary between them.

The stakeholder's report was *"the project is sprawling, because the tools to build
the game and the game runtime itself are not linked"*. This file is the fresh-eyes
pass that report asked for. It exists so that the next question about any system —
*is this for the Round? is it wired? do we keep it?* — is answered by reading rather
than by grepping again.

**Product column:** `R` the Round · `P` the persistent world · `both`.
**Wired column:** does the thing reach the running game.

---

## 1. Content types

24 directories under `content/`. ⚠ **Twenty-one of them are already editable in the
authoring tool** — the gap is not missing editors. It is that the tool has no order,
sits on two servers across four pages, and nothing carries a save into the game.

| Type | Product | Editor | Reaches runtime by | Verdict |
|---|---|---|---|---|
| `areas` | both | map editor (iframed) | server load | ⚠ carries no product marking — see §2 |
| `animations` | both | tool | server load → `render_content` on the wire (D-630) | wired |
| `assets` | both | tool | server (worn) + **client build-time import** (grips) | ⚠ two channels for one file |
| `audio` | both | tool | server (cues) + **client build-time import** | ⚠ two channels |
| `bots` | R | tool | server load | wired (D-624) |
| `characters` | both | tool **and** studio | baked `.glb` + manifest | ⚠ two editors for one type |
| `classes` | both | tool | server load | wired |
| `cloth` | both | tool (Bodies › Cloth workbench) | server load → `render_content` (D-631) | wired |
| `emotes` | both | tool | server load | wired |
| `feats` `skills` `spells` | both | tool | server load | ⚠ spells: `castsSpells` is hard-coded `false` |
| `garments` | both | tool | baked manifest | ⚠ server never loads it |
| `ground` | both | map editor | server load + painted masks | wired |
| `items` | both | tool | server load | wired |
| `languages` | both | tool | server load | wired |
| `nodes` | R | tool | server load | wired |
| `npcs` | both | tool | server load | wired |
| `objectives` | R | tool | server load | wired |
| `parts` | both | tool | server load + **client build-time import** (hood) | ⚠ two channels |
| `races` | both | tool | server load + baked parts | wired |
| `recipes` | R | tool | server load | wired |
| `roamers` | R | tool | server load | wired |
| `scripts` | both | **none** | server load | ⚠ Lua is hand-edited only |
| `stations` | R | tool | server load | wired |
| **`scenarios`** | R | — | — | ⚠ **does not exist** (D-627) |

### The delivery channels (revised for D-630)

A change reaches the game by one of these routes, and which one is now DATA —
`shared/src/pipeline.ts`, read by the tool's Publish and by a test that fails on
a content directory with no entry:

1. **Server load, reloadable** — most types. `POST /api/dm/reload-content` swaps
   them in place; Publish calls it. Presentation among them (animations, ground,
   grips, part names) is carried to the client on `render_content`.
2. **Baked artefacts** — `build:characters` (characters, races, garments, parts),
   `build:environment` (area assets). Publish runs only the ones a save
   invalidated, and the stage badges say what is unbuilt.
3. **Client build-time import** — `audio/sounds.json` alone, because the menu
   plays before a connection exists.
4. **Python scripts** — `build-round-map`, `paint-areas`, `dress-areas`,
   `build-tavern`, `build-audio`. Still manual and order-dependent.

Areas are **warm** (re-read, applied at the next round reset) and scripts need a
**restart**; the reload reply says which.

⚠ **Nothing invokes 3 or 4 from the tool, and the server cannot reload 1.** This is
the whole of the stakeholder's complaint. Three of the tavern's four meshes sat
unbuilt for an entire session: they validated, they flooded, and they drew nothing
but one `console.warn` each (D-625).

---

## 2. Areas — where the two products are tangled

| Area | Zone | Product | Note |
|---|---|---|---|
| `round-town` | settled | R | the Round's town (D-549) |
| `round-farm` `round-wood` `round-mine` `round-south` | wilderness | R | the spokes |
| `round-dungeon-1..3` | wilderness | R | D-535's three floors |
| `hanged-ferryman` | settled | ⚠ **both** | P's first-slice tavern *and* the Round's opening room (D-608) |
| `broken-yard` | wilderness | P | links to the tavern, so reachable from a round |
| `sunken-crypt` | **endgame** | P | ⚠ **involuntary permadeath, reachable from a round** |
| `proving-ground` | wilderness | P | `live: false` — dead content |

⚠ **The walk `round-town → hanged-ferryman → broken-yard → sunken-crypt` is open
during a round.** `RoundEngine` has no concept of an area; `dungeonGateAllows` only
enforces the dungeon's day/night and floor rules. D-523 forbids exactly this. The fix
is the scenario's area set (D-627), not another guard.

⚠ **Two taverns.** `hanged-ferryman` is the Round's opening room while `round-town`
contains a second tavern with its own keeper (D-593). One of them should belong to
each product. This is a content decision with a visible result and is for the
stakeholder.

---

## 3. Verbs — which belong to a round

`handleRespawn` is correctly gated on `roundRunning`. These are not:

| Verb | Product | State |
|---|---|---|
| `retire` | P | ⚠ **ungated** — ends the character forever and pays Legacy *inside* a round, which D-207 and MR3 both forbid |
| `pay` | P | ⚠ **ungated** — gold, which round mode does not even display |
| `speak_dead` | both | ungated **and that is correct** — the MR gate text names "question a corpse" as a thing a good round contains |
| `seance` `animate_dead` | ? | ⚠ ungated and **unconsidered**: built for D-511's persistent world, never weighed against the Round's design. A question, not yet a bug |

---

## 4. Authored and read by nothing

| Definition | Readers | Note |
|---|---|---|
| `EnvironmentAsset.operable` | **0** | a door defined as operable does nothing |
| `EnvironmentAsset.clips` (open/close) | **0** | the animations for that door |
| asset `tags` | tool only | the keyword gating of D-566 |
| race animation layer | unreachable | `raceId` is on the character record, never on the wire entity |
| `crossbow`, `one-handed-shield` | no set | legal stances with no clips |
| `dagger`, `thrown` | no combat idle | a gap in the clip library, not the content |
| `eat` | no clip | left visible in the wishlist |
| spell casting | `castsSpells` → `false` | spells are authored, reach creation, and cannot be cast |

**Does not exist at all:** a **death-model swap** (a character becoming a different
mesh on death) and **effects as content**. Both were named by the stakeholder as
things they expect to define.

---

## 5. Tooling

| Surface | Port | Owns | Verdict |
|---|---|---|---|
| `creation-tool.html` | 8150 | 21 content types across 9 sections | the shell to keep |
| `studio.html` | 8150 | modular characters | ⚠ merge into the tool's **Bodies** stage |
| `viewer.html` | — | cloth workbench on a placeholder body | ⚠ merge into **Bodies** |
| `editor.html` | **8140** | areas, ground paint | already iframed; ⚠ merge the *server* into 8150 |

⚠ **Two ports is a real cost, not tidiness.** A session was lost to a stale server
answering with a schema it had never heard of, which presents as a broken route.

**27 TypeScript tools and 12 Python scripts** sit in `tools/src/`. Most are one-shot
ingest or measurement utilities that have already done their job (`measure-hand`,
`probe-env-uv`, `claim-downloads`, `strip-procedural`). They are not the sprawl and do
not need deleting; they need to stop being confusable with the pipeline, which is what
the dependency map in MR4 is for.

---

## 6. Plan versus reality

Recorded in `BUILD_PLAN.md` (revised 2026-09-17) and D-627. In short:

- **MR1** met, but built *beside* the DM event engine rather than on it — which is
  why no scenario document exists and therefore why the round has no edges.
- **MR2** met except **farming**, which does not exist (no `plant` verb), costing the
  antagonist the third of D-526's three sabotages.
- **MR3** not started. The scenario type is its foundation, not its last feature.
- **MR4** new: the production line.
