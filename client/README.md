# client

The Three.js renderer arrives in **M1** (see `docs/BUILD_PLAN.md`): orthographic
isometric camera, seed-generated procedural characters, verlet cloth, palette
quantisation (D-401 – D-404). Productionises `prototypes/procedural-characters.html`.

Until then the headless bot clients in `sim/` are the only consumers of the wire
protocol — deliberately, per M0's "nothing player-facing".
