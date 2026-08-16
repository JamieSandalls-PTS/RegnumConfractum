# Character Art Sourcing — Market Survey and Recommendation

**Companion to:** `DECISIONS.md` (D-302 setting, D-304 render pipeline), `ASSET_PIPELINE.md`
**Method:** three independent parallel surveys of itch.io, commercial marketplaces, and the 3D-source route
**Date of survey:** August 2026
**Caveat:** prices and availability were accurate at survey time and drift. Verify before purchase.

---

## Headline

Two independent sweeps of the finished-2D market converged on the same single answer:
**PVGames' RPGTools line is the only product that satisfies all requirements at once.**

But it ships without five core social emotes, and you buy rendered sprites rather than
3D source — so you cannot add them yourself. That caps D-202's expressiveness
permanently.

**Therefore the recommendation is a hybrid: buy PVGames for launch art, and build the
render pipeline anyway to fill the gaps.**

---

## Requirements used for screening

In priority order:

1. **8 directional facings** — 4-direction is disqualifying
2. **Layered modular equipment** compositing at runtime
3. **Large animation vocabulary, especially emotes** — drives D-202
4. **Gritty semi-realistic style** — the D-302 Neverwinter Nights register, not cute or chibi
5. **Licence permitting commercial live-service use with client-side asset delivery**
6. **Extensibility** — can matching assets be added later

---

## TIER 1 — PVGames "RPGTools" line

| | |
|---|---|
| Creator | PVGames (Kyle Chapman) |
| Store | https://pvgames.itch.io/ |
| Key kits | Other Worlds Character Creator Kit (~$11.99, 137 pieces, fantasy); Northfolk CCK (~$8.99, ~100 pieces, norse) |
| Bundle | **36-pack bundle ~$175** — cheaper than buying kits separately |
| Directions | **8**, on every animation, every piece — stated explicitly on every kit page |
| Animations | ~70 animations, ~2,500 frames **per piece** |
| Layering | **Yes** — base body, hair, clothing, armour, weapons, shields as separate graphics |
| Style | Pre-rendered 3D, painterly, muted, semi-realistic. Diablo II / Baldur's Gate register |
| Size | 700MB–1GB per kit |

**Why the style is right rather than merely acceptable:** PVGames is *already* pre-rendered
3D-to-isometric. It is the exact technique specified in D-304, executed by someone else.
The aesthetic is not a compromise against our target — it *is* our target.

### Animation coverage against D-202

Confirmed list: Walk, Run, Idle ×4, Idle Fidget ×3, Talking ×2, Interact, Use Item,
**Sit**, Climb, **Pray**, Jump, Sneak, Crouch, Cast, Falling Forward/Backward, Down/Dead
poses, Evasion Roll, Get Hit ×2, Critical Idle ×2, Block, **Drink**, Riding, plus
per-weapon combat sets.

| D-202 emote | PVGames |
|---|---|
| sit | ✅ |
| kneel | ✅ (Pray) |
| drink | ✅ |
| lean | ≈ (Idle Fidget) |
| talk / gesture | ✅ ×2 |
| sneak, crouch, climb, ride | ✅ (bonus, not requested) |
| **bow** | ❌ |
| **wave** | ❌ |
| **laugh** | ❌ |
| **point** | ❌ |
| **shrug** | ❌ |

**This is the critical finding.** Those five are core social emotes for a roleplay world,
and D-202 stated the constraint plainly: the keyword emote system is only as expressive
as the animation set. Buying PVGames alone means accepting that ceiling forever, because
the product is rendered sprites — the 3D source is not included.

### Risks to resolve before committing

- **No formal EULA is reachable.** `pvgames.net` does not resolve; `pvgames.com`
  redirect-loops. The licence exists only as informal prose in store listings: *"free to
  use the assets commercially... they just can't be re-sold or edited and re-sold."*
  An MMO client redistributes composed sprite sheets to every player. Almost certainly
  fine, but **obtain written confirmation from PVGames covering commercial live-service
  use with client-side delivery** before building a pipeline on it.
- **RPGTools assembly tool is Discord-distributed and undocumented.** Plan to bypass it
  and composite layers yourself.
- **Hair ships monochrome** and must be tinted — fine, since D-304 already specifies
  runtime tinting from region masks.
- **Older "2.5D Character Pieces" volumes are not 1:1 in scale** with Other Worlds.
  Mixing generations needs resizing.
- **Legacy "Medieval:" series is a different, incompatible line** — 4-direction RPG Maker
  format. Do not buy by mistake.
- Reports that some idles are repeated frames rather than true animation. Check preview
  GIFs.
- Single-person studio. Bus factor.

**Cheap validation:** buy one low-cost kit (~$4) first, confirm the layer PNGs are
cleanly registered and composite correctly, *then* buy the bundle.

---

## TIER 2 — the pipeline route (needed regardless)

### Daz Genesis 9 — recommended 3D source for gritty realism

| | |
|---|---|
| URL | https://www.daz3d.com/genesis-9-starter-essentials |
| Base cost | **Free** with Daz Studio |
| Rig | **One unified skeleton across masculine and feminine forms** — exactly D-304's requirement |
| Style | Realistic. Correct register for D-302 |
| Wardrobe | Bought per set; discounts of 70-90% are routine, so a credible dark-fantasy wardrobe is a few hundred pounds |

**Licence finding worth real money:** the Daz standard licence permits incorporating
*"two-dimensional images derived by User from the Content"* into distributed works. The
$50-per-asset **Interactive License is only required when shipping the actual 3D mesh**
in a real-time application. Because we pre-render to sprites, we never trigger it.
Across a large wardrobe this is a several-thousand-pound saving, and it is an
independent argument for the sprite approach over shipping 3D.

### Mixamo — recommended animation source

- https://www.mixamo.com/ — **free** with an Adobe ID
- Adobe's own FAQ grants royalty-free use for commercial video games, no attribution
- All animations retarget onto the common `mixamorig` skeleton
- **Covers every emote PVGames lacks**: bow, wave, laugh, point, shrug — plus sit,
  kneel, lean
- Weak on prop-dependent emotes (drink, hold torch) — those need prop attachment work

**Risk:** Adobe has killed Fuse, Face Plus and Mixamo's cloud storage. The service is
maintained, not developed. Blocked for Enterprise/Federated Adobe IDs and China country
codes.

**Action: download and archive locally every animation needed, now.** The licence grant
is perpetual; the service is not guaranteed.

### Quaternius — free pipeline validation

- https://quaternius.com/ — **CC0**
- Ultimate Modular Men/Women packs, Universal Base Characters, Universal Animation
  Library — all rigged and retargetable
- Stylised low-poly, so not shippable for D-302

**Use:** build and prove the entire render and compositing pipeline against these before
spending anything. If the pipeline works on Quaternius, swapping in Genesis 9 later is a
content swap, not a rewrite.

### Flare / Clint Bellanger — the reference architecture

- https://opengameart.org/content/isometric-hero-and-heroine — **CC-BY 3.0**, free
- 8 directions, layered (base armour / blade / ranged / magic / shield / head)
- **Ships the Blender source files, Python render scripts and montage tooling**

Art is small and dated by modern standards. Its value is that it is a working, open
implementation of exactly the pipeline in `ASSET_PIPELINE.md` — camera setup, layer
taxonomy, render automation. **Read it before writing our own render script.**

⚠️ The related *Flare avatar clothes spritesheet* by Metapixelatron and the wider Flare
game art are **CC-BY-SA 3.0 (copyleft)**. Keep quarantined from proprietary work.

---

## REJECTED — and why, so this is not re-litigated

| Option | Fatal flaw |
|---|---|
| **Spell of Mastery** (NancyGold, CC-BY 4.0, free) | **Two facings only** (north/south). 6 animations, zero emotes. Superb 112-layer/21-slot modularity and a live HTML composer — **worth downloading purely to study its layer and z-order design** as reference for our compositor. Unusable as art. |
| **Synty Sidekick** (~$805 for packs + animation bundle) | Best-engineered modular system surveyed, Unity Humanoid rig, **140-clip emote pack** — the best emote coverage anywhere. **Rejected on style:** stylised low-poly. Sprite resolution collapses *texture* detail but preserves *silhouette and proportion*, which is exactly where Synty is most cartoonish (oversized heads, mitten hands). No render setting fixes this. |
| **Reiner's Tilesets** (free) | 86 human packs, huge volume, genuinely interesting emote coverage (greeting, praying, reading, knitting, town/battlefield splits). **Not layered** — modularity is by whole-character variant. Style is circa-2000 chunky, reads Settlers not Diablo. Licence forbids uploading *"raw graphics"* to your page — a live risk for CDN delivery. Facing count unverified. **Use as an emote-design reference, not art.** |
| **Ultimate Protagonist** (GameDev Market, $16) | 8-direction and modular — but explicitly "charming"/stylised. Fails style. Only ~10 animations. |
| **CraftPix** | No isometric character category exists. Catalogue is pixel/anime/cartoon. Skip entirely. |
| **GameDev Market** (broadly) | Dominated by tiny pixel art and chibi. No gritty isometric characters at any price. |
| **Hormelz 8-Directional Knight**, SmallScaleInt, AxulArt, and other 8-direction packs | No modular layers; equipment baked. Mostly top-down not isometric. Zero emotes. |
| **Kenney** | Only humanoids are blocky Minecraft-style. Prototyping only. |
| **MakeHuman** | 1.2.0 alpha, long hiatus, no shippable fantasy wardrobe. |
| **Character Creator 5 / Reallusion** ($299+) | Headline features (facial HD, ARKit blendshapes, lip-sync) are entirely discarded at sprite resolution. Licence docs unreachable. Value is as a rig-normalising hub only. |
| **Human Generator** (Blender, $128) | Clothing library is contemporary, not fantasy armour. Wrong content domain. |

**Unassessed gap — stated honestly:** the Unity Asset Store is a client-rendered
JavaScript application that returns no content to fetchers, and its search endpoints
404. Given the pattern across every other marketplace, expectation is low, but this is
**unverified** and would need a human with a browser to close.

---

## Recommendation

**A hybrid. Buy the launch art; build the pipeline anyway.**

1. **Validate cheaply.** Buy one low-cost PVGames kit (~$4). Confirm layer PNGs are
   cleanly registered and composite correctly with depth sorting.
2. **Get the licence in writing** from PVGames covering commercial live-service use with
   client-side asset delivery, *before* the bundle purchase.
3. **Buy the PVGames 36-pack bundle (~$175).** This is the launch wardrobe and the
   visual identity. It gets a playable, good-looking world in front of players far
   sooner than any custom pipeline could.
4. **Build the render pipeline in parallel, free**, against Quaternius CC0 + Mixamo,
   using Flare's Blender scripts as the reference implementation.
5. **Fill the emote gap** — bow, wave, laugh, point, shrug — via Genesis 9 + Mixamo
   renders, or by commissioning PVGames directly. Their consistent rig across the whole
   RPGTools line makes commissioning a tractable ask and is the lower-risk path for
   style consistency.

### The one real risk in this plan

**Style drift between PVGames art and our own renders.** Mixing two art sources in one
scene looks worse than either source alone. Mitigations, in order of preference:

1. Commission the missing emotes from PVGames — perfect consistency, no drift.
2. Match the render rig precisely to PVGames' camera angle, lighting and palette when
   producing our own — achievable, since both are pre-rendered 3D, but needs careful
   calibration and honest side-by-side review.
3. Accept a wholesale swap later — treat PVGames as launch art with the pipeline as the
   long-term replacement, and never mix within a scene.

**Do not let this drift happen by accident.** Decide which mitigation applies before the
first custom-rendered emote enters the game.
