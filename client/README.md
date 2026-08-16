# client

The M1 renderer (D-401 – D-404): Three.js, orthographic isometric camera,
low internal resolution palette-quantised with ordered dithering. Characters
are generated from the `appearanceSeed` on the character record, constrained
by archetype ranges; capes and hair are verlet chains; equipment is geometry
parented to bones, swappable at runtime (keys 1–4 toggle it on your own
character until the inventory drives it).

```bash
npm run dev:server   # needs the db: npm run db:up
npm run dev:client   # http://localhost:5173
```

Structure:

- `src/game/` — **pure logic, headlessly tested**: appearance generation,
  movement interpolation (test/ runs in CI).
- `src/render/` — Three.js: scene shell, palette post-process, terrain from
  area data, procedural characters, verlet cloth.
- `src/net/` — schema-validating WebSocket wrapper around `@rc/shared`.
- `src/main.ts` — UI flow, entity mirror, input, render loop.

Rendering constants (light intensities, fog range, exposure-before-quantise
ordering) were tuned in `prototypes/procedural-characters.html` — see the
notes in `CLAUDE.md` before changing them.
