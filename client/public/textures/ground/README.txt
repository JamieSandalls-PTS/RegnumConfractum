Ground textures go here (D-585).

One image per ground material, named by the material's `texture` field in
content/ground/<id>.json -- for example content/ground/grass.json with
"texture": "grass-01.png" loads textures/ground/grass-01.png.

WARNING: a material naming a file that is not here FAILS THE BUILD, the same
rule a sound cue follows (D-541). The reason is the same too: a missing
texture renders as the material's flat tint and looks exactly like a material
nobody has finished, so the difference has to be made loud somewhere.

A material with NO `texture` at all is legal and means "just the tint". That
is what every one of these ships as until real art arrives, and it is why a map
painted now still reads correctly and gains its surface later without being
re-painted.

Tiling: `repeat` is per TILE, not per area, so a map that grows does not
stretch its grass. Square, seamless images at 256 or 512 suit this best.
