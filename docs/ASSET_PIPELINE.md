# Character Asset Pipeline — Production Specification

**Companion to:** `DECISIONS.md` (D-304 — characters are 3D-rendered to isometric sprite sheets)
**Audience:** whoever is authoring 3D source art, and whoever is building the render pipeline
**Status:** specification, unvalidated. The spike (final section) exists to test it.

---

## The governing principle

**Author layers. Never author combinations.**

Ten hairstyles, twenty chest pieces, fifteen leg pieces, ten helmets and twenty weapons
is 600,000 combinations — and 75 layers. The client composites at runtime.

Every decision below follows from this.

---

## 1. What must be authored in 3D

### 1.1 The shared humanoid rig — the single most important decision

**One skeleton for every humanoid in the game.** Humans, elf-like, dwarf-like, brutes,
and as many of the monstrous playable cultures as can be made to fit. Bodies differ by
**proportion and scale**, not by bone structure.

**Why this dominates everything:** the animation library is authored once against the
rig and then serves every character in the game, permanently. Introduce a second rig
and every animation must be re-authored against it.

**Rule:** a new body type that cannot use the shared rig is a major cost decision, not
an art decision. Genuinely non-humanoid creatures (quadrupeds, aberrations, things with
wrong numbers of limbs) will need their own rigs and their own reduced animation sets —
budget them explicitly and keep the list short.

### 1.2 Base bodies

Two to four meshes skinned to the shared rig. Suggested: slim frame, heavy frame,
short-broad frame.

These are **silhouettes, not characters**. Facial detail is close to invisible at
isometric zoom — do not over-invest there. Silhouette and hair shape carry recognition
at this camera distance, which is convenient given D-219 makes silhouette
mechanically meaningful.

**Cost warning:** equipment must fit every body type, so render cost is
`equipment × body types`. Each additional body type multiplies the whole wardrobe. Three
is a reasonable ceiling.

### 1.3 The animation library

30-40 clips, authored once against the shared rig.

**Core** (needed for the game to function):
idle, walk, run, attack (2-3 variants), block, stagger/hit-react, die, sneak, pick up,
cast.

**Emote** (drives the D-202 keyword system):
sit, kneel, lie down, lean, bow, salute, wave, laugh, weep, point, shrug, cross arms,
drink, eat, craft, sleep, cheer, threaten, cower.

**The emote list is the expressiveness ceiling of the entire roleplay system.** D-202's
keyword parser can only trigger animations that exist. Treat this list as a design
document, not a technical checklist — every clip here is a sentence players can speak
with their bodies.

### 1.4 Equipment meshes

Skinned to the shared rig, one mesh per item, by slot:

| Slot | Notes |
|---|---|
| Head | Helmets, hoods, masks |
| Hair | Suppressed by most head items |
| Chest | |
| Legs | |
| Feet | |
| Hands | Gloves, gauntlets |
| Back | Cloaks — the hardest depth-sorting case |
| Main hand | Asymmetric; blocks facing-mirror optimisation |
| Off hand | Shields, torches, second weapons |

### 1.5 Region masks

Greyscale masks marking tintable regions: skin, hair, fabric, leather, metal.

**Do not author colour variants.** One leather cuirass plus a region mask yields dozens
of visual variants tinted at runtime, for free. This is the cheapest multiplier in the
pipeline and it feeds dyeable equipment as a crafting feature.

### 1.6 Locked render rig

Fixed camera angle, fixed lighting setup, fixed output resolution, fixed material
response — committed to version control as a scene file.

**Rationale:** every layer must be lit identically or armour will read as lit from a
different angle than the body wearing it. This is the most common way layered sprite
systems look broken, and it is entirely preventable by discipline.

---

## 2. What the render pipeline does (automated)

A headless Blender script, run unattended and re-runnable per asset:

1. For each mesh × each animation × each of 8 directions:
   - Render **RGBA colour**
   - Render **depth pass** (see §4.1 — not optional)
2. Trim transparent margins per frame, recording the offset
3. Pack into texture atlases
4. Emit JSON manifests: frame rectangles, anchor points, trim offsets, depth references,
   animation timing
5. Validate completeness — every declared animation present for every direction

**Incremental:** editing one armour piece re-renders that piece only.

**CI gate:** a manifest referencing a missing frame fails the build.

---

## 3. What the client does (runtime)

- Composites layers in z-order with per-pixel depth testing
- Applies runtime tinting from region masks
- Shows and hides layers from equipment state and disguise state
- Streams layers on demand, caches aggressively

**Note the elegant coincidence:** a hood is *hair and head layers hidden*. That is
simultaneously the visual change and the trigger for the identity-thread split in D-219.
The rendering operation and the game mechanic are the same operation.

---

## 4. The two problems that will bite

### 4.1 Z-order flips with facing — solve with depth, not tables

A cloak sits behind the body facing south and in front facing north. A weapon in the
right hand changes sides as the character turns. A large pauldron must occlude the arm
behind it.

**Rejected approach:** static per-facing z-order tables. Mostly works; breaks visibly on
cloaks, two-handed weapons and bulky shoulders, producing bleed-through.

**Chosen approach:** export a depth pass alongside colour — free, since the source is
3D — and depth-test per pixel during composition. Occlusion then resolves correctly in
all cases, including self-occlusion within a layer.

**Build this from the start.** Retrofitting depth means re-rendering the entire library.

### 4.2 Payload — the real constraint is bandwidth, not disk

Rough shape: 8 directions × 40 animations × 10 frames ≈ **3,200 frames per layer**.
Multiply by wardrobe size and body types. Trivial on a server; unacceptable as an eager
browser download.

**Primary answer:** on-demand layer loading with aggressive caching. A tavern scene needs
the ~20 layers currently visible, not the library.

**Levers, in order of preference:**

1. **Trim transparent margins per frame** — typically halves payload. Do this always.
2. **Emote animations at 4 directions**, combat and movement at 8. Emotes are usually
   viewed stationary and the loss is barely perceptible.
3. **Frame counts at 8-12** per clip. Reads as period-appropriate rather than cheap.
4. **Modern compression** — WebP or Basis/KTX2 atlases.

**Lever deliberately NOT taken:** mirroring east-west facings would halve render cost,
but flips weapons into the wrong hand — every character becomes left-handed half the
time. Avoid unless payload forces it, and if forced, accept it only for unarmed
civilians.

**Unknown:** actual per-scene byte cost. The spike must measure this, not estimate it.

---

## 5. The spike — minimum set to validate the whole pipeline

The goal is to answer one question: *does this look like the world we want, and does it
fit down a wire?*

**Author:**

- 1 rig
- 1 base body
- 6 animations — idle, walk, sit, bow, attack, die
- 3 equipment pieces — one chest, one head, one main-hand weapon
- 1 region mask set
- 8 directions

**Build:**

- The Blender render script, with depth pass
- Atlas packer and manifest emitter
- A minimal PixiJS compositor with depth testing and runtime tint
- A tile grid with two composited characters on it

**Measure — the spike fails if these are not recorded:**

- Bytes per layer after trim and compression
- Bytes for a realistic 8-character scene
- Composite frame time at 20 visible characters
- Whether depth compositing resolves a cloak and a pauldron correctly

**Judge:** does it read as gritty, grounded and coherent — the Neverwinter Nights
register of D-302 — or does it read as muddy? This judgement is the stakeholder's and
cannot be automated. It is the reason the spike exists.
