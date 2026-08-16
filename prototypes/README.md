# Prototypes

Spikes that exist to answer a question, not to become the game.

---

## `procedural-characters.html`

**Question it answered:** can characters be built from rules rather than assets, and does
the result look like the world we want?

**Verdict: yes.** This prototype is why D-401 supersedes the entire sprite pipeline.

Open the file in any browser — it is fully self-contained, including a bundled copy of
Three.js. No server, no build step, no network.

### What it demonstrates

- **Characters generated from an integer seed.** Proportions, bulk, limb ratios,
  colours, helmet, pauldrons, weapon, cape and hair all derive from it, constrained by
  hand-authored archetype ranges (D-402). Press **Regenerate** — that is the argument.
- **Nine procedural animations**, including all five social emotes no purchasable pack
  ships: bow, wave, laugh, point, shrug. Each is roughly eight lines.
- **Verlet cloth and hair** solved per frame against gravity, wind and a body collider
  (D-403). Drag the wind slider.
- **Palette quantisation** to 24 colours with 4×4 ordered dithering at ~320×200 internal
  resolution (D-404). Toggle **Palette** off to see the raw render.

### Measured

| | |
|---|---|
| Triangles, 6 characters + terrain | ~6,600 |
| Frame rate | 30fps — on a **software** rasteriser, no GPU, in a headless container |
| Total size including Three.js | **540KB** |

That last figure is the one that mattered. Under the superseded sprite plan, a single
equipment layer ran to ~3,200 frames and the wardrobe to gigabytes.

### What it does NOT prove

Stated so it is not overclaimed (D-406):

- Geometry is deliberately crude boxes. Production needs better primitive composition,
  chamfered forms, more parts per limb.
- Performance was never tested at 20–40 visible characters on real hardware.
- Lighting and palette were tuned against screenshots, not by the stakeholder's eye.
  **Art direction remains unratified.**
- No terrain streaming, no runtime equipment swapping, no LOD, no mobile testing.

---

## Source and rebuilding

`procgen.src.html` is the readable source — it loads Three.js from a CDN via importmap
and is the file to edit.

`build.mjs` inlines Three.js into a single self-contained file:

```bash
npm install three esbuild
node build.mjs        # → procedural-characters.html
```

The bundled output is committed because the whole point is that it opens with a
double-click.

---

## Notes that cost real debugging time

Recorded here and in `CLAUDE.md` because they are not obvious:

- **Three.js r155+ uses physical light units.** Intensities from older examples are far
  too dim. Expect directional lights around 3–5, not around 1.
- **Fog range must exceed camera distance.** An orthographic camera orbiting at ~19
  units with fog set 9→22 renders a near-black scene.
- **Exposure and vignette must be applied BEFORE palette quantisation.** Applying them
  afterwards pushes colours off the palette and undoes the effect entirely.
- **Constrain procedural parameters by archetype.** Uniform random produces mush.
