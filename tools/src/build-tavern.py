"""
Rebuilds the Hanged Ferryman as an INTERIOR (D-604, superseding D-544's plot).

    python tools/src/build-tavern.py
    npm run map:tavern

The stakeholder's original idea, restated: the Hanged Ferryman is the tavern in
the middle of the town, and a player reaches it by standing on a transition
beside the building. What existed instead was a 32x32 PLOT with a 20x15 taproom
sitting on it -- an approach, a yard, a treeline and a lantern-lit path, none of
which belongs inside a town that already has all of those.

Three things were wrong with it and all three are visible in play:

  * It looked like OUTSIDE, because most of it was. 29 tiles of treeline wall,
    86 grass and flower props scattered on the `floor` kind, and a ground paint
    recipe that named grass, mud and leaf mould as surfaces of a taproom.
  * It was outside the game loop. `round-town` did not link to it, so the
    tavern the round is themed around could not be entered during a round.
  * It still thought in PROCEDURAL props. This script built fifty of them --
    windows, torches, a door, barrels, ferns -- and never wrote one: the field
    was dropped from the schema by D-567 and the list was discarded silently
    inside the loop that made it, while the log line went on counting them.

So the plot is gone. This is a room, entered by a door, with a second door
still leading to `broken-yard` because the persistent world arrives that way.

WARNING: the doors are ONE-WAY in the data (D-544) -- the way back lives in the
other area. This script writes both halves of both pairs, which is the whole
reason it is a script and not an editor session.
"""

import io
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
AREAS = os.path.join(ROOT, "content", "areas")

# The room, plus its walls. A taproom you cross in a few steps (D-544's point,
# which the plot around it diluted): 22x16 of floor inside a 24x18 area.
W, H = 24, 18

# WARNING: the taproom is FLOOR and nothing else (D-618). Walls, tables and
# the hearth used to be tile KINDS that the terrain renderer drew as generated
# geometry -- grey slabs on the old lattice, the last of the procedural world
# left standing indoors. They are pack meshes now, so the grid carries one
# surface and the collision comes from the objects.
LEGEND = {
    "f": {"walkable": True, "kind": "wood"},
    # WARNING: unwalkable, and still WOOD (D-618). The wall line has to be
    # closed to the pathfinder or the reachability flood counts the tiles under
    # the wall panels as floor nobody can reach and fails the build -- which it
    # did, naming four corners. Giving it a `wall` kind would put the
    # procedural slab straight back; giving it the floor's own material draws a
    # plain board under the mesh and blocks the tile. A tile may be unwalkable
    # without being a wall.
    "x": {"walkable": False, "kind": "wood"},
}

# ---------------------------------------------------------------------------
# The kit, and why each piece is the piece (D-625).
#
# ⚠: every number below is MEASURED, off `content/assets/*.environment.json`,
# which carries the real extent of each mesh. The previous cut of this file
# guessed: it gave a 2.95m trestle table a 0.9m collision box and laid ten of
# them a metre apart to make a bar, which is ten three-metre slabs overlapping
# by two metres each. None of it was visible, because of the next note.
#
# ⚠: three of the four meshes this placed had NEVER BEEN BUILT.
# `npm run build:environment` ships only what the areas actually place, and it
# was not re-run after the meshes changed -- so the client warned once to the
# console and drew nothing at all. The taproom was bare boards with chairs
# standing in it. Re-run `npm run build:environment` after touching this file:
# a mesh that is not built is not a missing texture, it is a missing OBJECT.
#
# ⚠: one pack, one atlas, one look. Everything here is `dungeon-pack`,
# which despite the name is the fantasy interior set -- trestle tables, stools,
# barrels, a wall fireplace and a boarded wall, all sampling one atlas. What
# was here before mixed it with `generic`, and `generic` is POLYGON's MODERN
# kit: its textures ship tyre decals and dollar signs, and its "base wall" is a
# featureless grey panel that sampled the atlas's colour-swatch strip. A
# fantasy taproom with a concrete basement wall is exactly what it looked like.
PACK = "dungeon-pack"

# 5.00 x 2.00 x 0.61, a boarded timber wall -- the only warm interior wall in
# any ingested pack. The dungeon's own `sm-env-wall-*` are cut stone and FIVE
# METRES TALL, which is a crypt, not a room somebody drinks in.
WALL_MESH = "sm-env-basement-wallpanel-01"
WALL_SCALE = 1.25                      # -> 6.25 wide x 2.50 tall x 0.76 deep
WALL_LEN = 5.00 * WALL_SCALE
WALL_THICK = 0.61 * WALL_SCALE

# 2.95 x 0.96 x 1.40 -- a trestle table, long side along its own x.
TABLE_MESH = "sm-prop-table-01"
TABLE_LEN, TABLE_DEEP, TABLE_TOP = 2.95, 1.40, 0.96

# 0.63 across, and a SEAT. Stools rather than chairs, and the reason is not
# taste: a stool has no backrest, so the one thing a seat can get wrong -- the
# sitter facing into the back of it (D-609) -- cannot happen on one.
STOOL_MESH = "sm-prop-stool-01"

# 3.62 x 2.40 x 1.55. A hearth with a mantel. ⚠: NOT
# `sm-prop-fireplace-01`, which the name suggests and which is a cast-iron
# STOVE with a flue -- looked at before choosing.
HEARTH_MESH = "sm-env-wall-fireplace-01"
HEARTH_W, HEARTH_DEEP = 3.62, 1.55

BARREL_MESH = "sm-prop-barrel-01"
CANDLE_MESH = "sm-prop-candles-01"


def mask(w, h, top, x=0.0, y=0.0):
    """A collision box in the MESH'S OWN frame, centred on the object.

    ⚠ Not world metres, and not world axes. `transformVolume` multiplies every
    dimension by the placement's `scale` and ADDS its `rotation`, so a mask
    written the other way is wrong twice over on anything turned or resized.
    Both mistakes were made here and both were invisible in the file:

      * The wall panels are scaled 1.25, so masks cut in metres came out a
        quarter too large -- enough to push the south run's mask from x=11.0
        to 11.69 and drag the other half back to 12.375, narrowing the DOORWAY
        to 69cm against a body radius of 30cm. The room was sealed, and
        `map:why` reported the door tile as "penned in by (nothing within
        3.5m)" because the wall that sealed it had grown from two panels away.
      * The bar trestles are turned 90 degrees, so a mask pre-swapped by hand
        was rotated a second time and lay ACROSS the counter instead of along
        it -- which is why the keeper had nowhere to stand.
    """
    return {
        "shape": {"kind": "rect", "x": x, "y": y,
                  "w": round(w, 3), "h": round(h, 3), "rotation": 0},
        "base": 0,
        "top": top,
    }


def place(mesh, x, y, rotation=0, z=0, scale=1, collision=None, seat=False):
    out = {
        "asset": mesh, "pack": PACK,
        "x": round(float(x), 3), "y": round(float(y), 3), "z": z,
        "rotation": rotation, "scale": scale,
    }
    if seat:
        out["seat"] = True
    # ⚠: an EMPTY mask with `overrideCollision` says a person meant it
    # (D-567). It is right for a seat -- the sitter has to be able to stand on
    # the tile -- and it is how this file once left every WALL, which is why
    # you could walk out through the side of the building.
    out["collision"] = [] if collision is None else [collision]
    out["overrideCollision"] = True
    out["dressed"] = False
    return out


def wall_run(x0, y0, x1, y1):
    """Whole panels along a run, evenly spaced, ends exact.

    ⚠: CEIL, not round. `round` picks the nearest count, so a run of
    10.5m with 2.5m panels came out as four panels at 2.625m centres -- 12cm
    of GAP at every joint, four holes in a wall that reads as solid until
    somebody looks along it. Ceiling the count can only ever overlap.

    ⚠: overlapping panels are staggered by a centimetre in depth. Two
    coplanar faces at the same depth z-fight, which is the shimmer that looks
    like a driver bug rather than like a map.
    """
    horizontal = y0 == y1
    length = (x1 - x0) if horizontal else (y1 - y0)
    out = []

    # ⚠ The panels are ANCHORED to the run's ends, not spread across its
    # middle. Spreading them put each panel's CENTRE on an even division and
    # let its 6.25m of mesh hang 1.4m past both ends of the run -- which is
    # harmless where a wall runs past a corner and is not harmless at a door:
    # the west run stopped its collision a metre short of the doorway and then
    # drew straight over it. The tavern had a door you could walk through and
    # could not see.
    #
    # ⚠ A uniform SCALE is not negotiable, which is why the panels overlap
    # rather than tiling exactly. Exact tiling means a scale chosen per run,
    # and this mesh's height scales with its length -- so the walls would meet
    # at the corners at four different heights.
    if length <= WALL_LEN:
        # One panel, shrunk to fit. Never wider than the run, or it overhangs.
        count, scale, step = 1, length / 5.0, 0.0
    else:
        count = int(-(-length // WALL_LEN))          # ceil
        scale = WALL_SCALE
        step = (length - WALL_LEN) / (count - 1)

    for i in range(count):
        # ⚠ `WALL_LEN` is ALREADY the scaled length (5.00 * WALL_SCALE).
        # Multiplying by the scale again here pushed every run 78cm off its
        # own corner and opened a gap at all four of them.
        along = (WALL_LEN / 2 if count > 1 else length / 2) + i * step
        # ⚠ A stagger on alternate panels, because they OVERLAP and two
        # coplanar faces z-fight -- which reads as a driver fault rather than
        # as a map.
        #
        # ⚠ THREE MILLIMETRES, not the centimetre it started at. The stagger
        # is a step in the face of the wall wherever two panels meet, and at a
        # centimetre it is a visible notch along the top edge at every joint.
        # The depth buffer needs the two faces merely to differ: this camera is
        # orthographic, so depth is LINEAR over near..far and a 24-bit buffer
        # resolves about a hundredth of a millimetre over the whole 200m range.
        # Three millimetres is a thousand times the resolution and a tenth of a
        # pixel.
        nudge = 0.003 if i % 2 else 0.0
        px = (x0 + along) if horizontal else (x0 + nudge)
        py = (y0 + nudge) if horizontal else (y0 + along)
        # The mesh runs along its own x, so a north/south wall turns 90.
        facing = 0 if horizontal else 90
        out.append(place(
            WALL_MESH, x=px, y=py, rotation=facing, scale=round(scale, 4),
            # ⚠ The panel's OWN length in MESH units. The placement's scale
            # multiplies it back up, so the masks tile exactly as the meshes
            # do and their union covers the run with nothing left over. No axis
            # swap for a vertical run -- the rotation does that.
            collision=mask(5.0, 0.61, 2.0),
        ))
        # ⚠ And the SAME PANEL TURNED ROUND, because this mesh has no back.
        #
        # Measured off the built `.glb` rather than guessed: of its 208
        # triangles, 94 face +z and **none** face -z. It is an open shell -- a
        # plank face with two end caps and a top and bottom, and nothing behind
        # it. glTF materials default to `doubleSided: false`, so the renderer
        # culls what is not there and you look straight through the wall from
        # outside. Reported as "the walls only have textures on one side".
        #
        # ⚠ A second placement rather than a double-sided material. Turning off
        # backface culling would draw the SAME face from behind, lit by a
        # normal pointing the other way -- a wall lit as though the sun were
        # inside the room. Two shells back to back have their own normals and
        # light correctly from both sides, which is what the mesh would have
        # done if the vendor had modelled a back.
        #
        # ⚠ The twin carries NO collision. The mask belongs to the wall, not to
        # each face of it, and duplicating it doubles the volumes the
        # pathfinder sweeps for nothing.
        out.append(place(
            WALL_MESH, x=px, y=py, rotation=(facing + 180) % 360,
            # ⚠ A HAIR smaller, and this is not superstition. Back to back, a
            # twin's top face, end caps and bottom are exactly coplanar with
            # its partner's, and coplanar faces z-fight -- along the top of
            # every wall in the room, where it is plainly visible. Shrinking
            # one of the pair separates every parallel pair at once, which no
            # offset can do: a shift along the wall's normal leaves the
            # HORIZONTAL tops exactly where they were.
            #
            # ⚠ 0.998, so the twin's top sits 5mm lower and its end caps 5mm
            # inside. That is the price of the technique and it is paid in the
            # right currency: a step far below a pixel, instead of a shimmer
            # that moves with the camera.
            scale=round(scale * 0.998, 4),
        ))
    return out


# Where the doors are. The south door is the one that opens onto Ashfold's
# square, beside the keeper who stands at it (D-593); the west door is the old
# way in from the yard.
SOUTH_DOOR_X = 12
WEST_DOOR_Y = 8

# Where each door puts you down on the other side. Both land BESIDE the
# transition rather than on it: a return that lands on the outgoing tile
# bounces the player straight back through, which reads as the door being
# broken rather than as a loop.
TOWN_DOOR = (26, 19)      # the tavern's doorway on the square
TOWN_RETURN = (26, 20)    # a step further out, clear of the doorway


def main():
    # ⚠: every tile is floor (D-618). What used to be a wall tile is a
    # placed mesh with its own collision, so the grid says only "this is a
    # wooden floor" and the objects say what you cannot walk through.
    g = [["f" for _ in range(W)] for _ in range(H)]

    # The wall line: closed to the pathfinder, drawn as floor, with the panels
    # standing on it. The doorways stay walkable.
    for x in range(W):
        g[0][x] = g[H - 1][x] = "x"
    for y in range(H):
        g[y][0] = g[y][W - 1] = "x"
    g[H - 1][SOUTH_DOOR_X] = "f"
    g[WEST_DOOR_Y][0] = "f"

    # The wall lines run down the middle of the unwalkable RING TILE, not along
    # the boundary between the ring and the first floor tile.
    #
    # ⚠ This is about `BODY_RADIUS`, which is 0.3, and it is the difference
    # between a room and a sealed box. A body may stand at a point only if
    # every collision shape is at least its radius away, so a wall centred on
    # the boundary at 0.5 with a 0.76m-thick mask reaches 0.88 -- which leaves
    # the first floor tile's centre 0.12m of air and makes the entire perimeter
    # row unstandable. Centred on the ring tile the mask reaches 0.38 and that
    # row has 0.62m, which is room to walk.
    NORTH, SOUTH, WEST, EAST = 0.0, float(H - 1), 0.0, float(W - 1)

    # ⚠ Clearance every mask is cut to. A tile centre needs BODY_RADIUS (0.3)
    # of air to stand in and more than that to be walked INTO: the first cut of
    # this room left exactly 0.3 at four table edges, which is a coin flip on
    # the last decimal place, and `validate:content` refused it with twenty
    # tiles a body could stand on and could not reach. Masks are cut a little
    # inside the art instead -- a tabletop that overhangs its own legs by 20cm
    # is what a tabletop does, and nobody can see the difference.
    TABLE_MASK_LEN, TABLE_MASK_DEEP = 2.8, 1.0

    walls = []
    # Four runs, broken where the doors are. The doorway gap is left EMPTY
    # rather than filled with a door mesh: the transition is on the tile
    # inside, and a solid door across it would seal the room CI floods.
    walls += wall_run(WEST, NORTH, EAST, NORTH)
    walls += wall_run(WEST, SOUTH, SOUTH_DOOR_X - 1.0, SOUTH)
    walls += wall_run(SOUTH_DOOR_X + 1.0, SOUTH, EAST, SOUTH)
    walls += wall_run(WEST, NORTH, WEST, WEST_DOOR_Y - 1.0)
    walls += wall_run(WEST, WEST_DOOR_Y + 1.0, WEST, SOUTH)
    walls += wall_run(EAST, NORTH, EAST, SOUTH)

    # The hearth, set INTO the north wall at the west end so the middle of the
    # room stays open. Its 1.55m of depth carries it past the wall panels and a
    # tile into the room, which is what a chimney breast does.
    hearth = [place(
        HEARTH_MESH, x=6.0, y=0.9, rotation=0,
        collision=mask(HEARTH_W + 0.1, 1.0, 2.5),
    )]

    # The bar: three trestles down the east side, turned so their long axis
    # runs north-south, with a metre of service floor behind them.
    #
    # ⚠ The GAP between the second and third is the lift-up flap, and it is
    # load-bearing rather than decorative: a continuous nine-metre counter
    # seals the strip behind it, and the keeper the whole tavern is built
    # around then stands somewhere nothing can reach. `validate:content`
    # caught exactly that -- "npc 'ferryman-keeper' at (22,8) has nowhere to
    # stand" -- on the first cut of this room.
    BAR_X = 21.0
    BAR_YS = (5.0, 8.0, 12.0)
    bar = [
        place(TABLE_MESH, x=BAR_X, y=by, rotation=90,
              # ⚠ The SAME mask a table in the room gets. The placement's
              # rotation turns it; swapping the axes here as well turned it
              # twice and laid the counter across the room.
              collision=mask(TABLE_MASK_LEN, TABLE_MASK_DEEP, TABLE_TOP))
        for by in BAR_YS
    ]
    # Stools along the customer side, looking east at the counter. None at
    # y=10: that is the flap, and a stool there would seat somebody facing a
    # gap -- which is also what `mr9-sitting` refuses.
    #
    # ⚠ `rotation` is the MESH yaw and a sitter looks the OTHER way (D-609) --
    # `sitterFacingFor` adds half a turn. Looking east is yaw 270.
    bar += [place(STOOL_MESH, x=BAR_X - 1.0, y=float(y), rotation=270, seat=True)
            for y in (4, 5, 6, 7, 8, 9, 11, 12, 13)]

    # ⚠ The keeper stands BEHIND the counter, between it and the wall. He was
    # at (21, 9), which is now the middle trestle -- a man standing in the bar
    # rather than behind it.
    KEEPER = (22, 8)

    # Tables, hand-placed in two rows with an aisle between them. A taproom
    # reads as a room somebody arranged, and D-505's scene is people sitting
    # down together.
    TABLES = [(5, 6), (10, 6), (16, 6), (5, 12), (10, 12), (16, 12)]
    tables, stools, candles = [], [], []
    for tx, ty in TABLES:
        tables.append(place(
            TABLE_MESH, x=tx, y=ty, rotation=0,
            collision=mask(TABLE_MASK_LEN, TABLE_MASK_DEEP, TABLE_TOP),
        ))
        # A light on the table, standing ON it rather than through it.
        candles.append(place(CANDLE_MESH, x=tx, y=ty, z=TABLE_TOP))
        # Two stools a side, at the ends rather than the middle, so nobody is
        # sitting inside three metres of table.
        for dx in (-1, 1):
            stools.append(place(STOOL_MESH, x=tx + dx, y=ty - 1, rotation=0, seat=True))
            stools.append(place(STOOL_MESH, x=tx + dx, y=ty + 1, rotation=180, seat=True))

    # Barrels in the corners, and NEVER in the strip behind the bar: that lane
    # is one tile wide and a barrel standing in it walls the keeper off as
    # surely as a second counter would.
    barrels = [
        place(BARREL_MESH, x=2.0, y=2.0, collision=mask(0.8, 0.8, 1.1)),
        place(BARREL_MESH, x=2.0, y=15.0, collision=mask(0.8, 0.8, 1.1)),
        place(BARREL_MESH, x=20.0, y=2.0, collision=mask(0.8, 0.8, 1.1)),
        place(BARREL_MESH, x=20.0, y=15.0, collision=mask(0.8, 0.8, 1.1)),
    ]

    rows = ["".join(r) for r in g]
    roofs = [{"x": x, "y": y, "style": "thatch"} for y in range(H) for x in range(W)]

    # ⚠: the room's structure goes in FIRST so a reader of the file sees
    # the building before its contents.
    assets = walls + hearth + bar + tables + stools + candles + barrels

    doc = {
        "id": "hanged-ferryman",
        "name": "The Hanged Ferryman",
        "width": W,
        "height": H,
        "legend": LEGEND,
        "tiles": rows,
        "spawn": {"x": SOUTH_DOOR_X, "y": H - 3},
        "lighting": "interior",
        "outdoor": False,
        "zone": "settled",
        "ambience": "ambience-interior",
        "roofs": roofs,
        "assets": assets,
        "stations": [],
        "nodes": [],
        # WARNING: the tile just INSIDE each door, not the door tile. A
        # transition on the threshold tile itself is stepped on again the
        # instant you arrive from the other side.
        "transitions": [
            {"x": SOUTH_DOOR_X, "y": H - 2, "toArea": "round-town",
             "toX": TOWN_RETURN[0], "toY": TOWN_RETURN[1]},
            {"x": 1, "y": WEST_DOOR_Y, "toArea": "broken-yard", "toX": 29, "toY": 16},
        ],
        "npcs": [{"x": KEEPER[0], "y": KEEPER[1], "type": "ferryman-keeper", "facing": "w"}],
        "scripts": ["ferryman-keeper"],
        "live": True,
    }

    path = os.path.join(AREAS, "hanged-ferryman.json")

    # WARNING: what a re-run must NOT throw away. This builds its document from
    # scratch, which is right for the SHAPE it owns and wrong for anything a
    # person or another tool put on top -- the trap `build-round-map.py` carries
    # `PRESERVED` for (D-590).
    #
    # WARNING: `assets`, `groundPaint` and `groundMaterials` are deliberately
    # NOT preserved this time. The map has changed shape and size; keeping the
    # old ones would leave a 32x32 painting on a 24x18 room and 86 tufts of
    # grass indoors, which is the state this rebuild exists to end. Re-run
    # `npm run map:paint` and `npm run map:dress` after this.
    # WARNING: `assets` is NOT preserved -- this script owns the chairs now, and
    # keeping the previous list would stack a second set on top on every run.
    # `map:dress` adds its clutter afterwards and marks it `dressed`, which is
    # what `map:prune` and a re-dress key off.
    PRESERVED = ("live",)
    kept = {}
    if os.path.exists(path):
        with io.open(path, encoding="utf-8") as fh:
            existing = json.load(fh)
        for key in PRESERVED:
            if key in existing:
                kept[key] = existing[key]
    doc.update(kept)

    with io.open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")
    barstools = [a for a in bar if a.get("seat")]
    counter = [a for a in bar if not a.get("seat")]
    print("wrote hanged-ferryman: %dx%d, %d wall panels, %d tables (%d of them bar),"
          " %d seats, %d objects"
          % (W, H, len(walls), len(tables) + len(counter), len(counter),
             len(stools) + len(barstools), len(assets)))
    print("  NOTE run `npm run build:environment` after this. A mesh nothing has"
          " built draws NOTHING, silently -- that is what emptied this room.")

    # --- the other half of each pair -------------------------------------
    # A door is one-way in the data, so the way IN lives in the other area and
    # this script writes it. Doing them apart is how an area ends up with a
    # door nobody can reach.
    town_path = os.path.join(AREAS, "round-town.json")
    town = json.load(open(town_path, encoding="utf-8"))
    town["transitions"] = [t for t in town["transitions"] if t["toArea"] != "hanged-ferryman"]
    town["transitions"].append({
        "x": TOWN_DOOR[0], "y": TOWN_DOOR[1],
        "toArea": "hanged-ferryman", "toX": SOUTH_DOOR_X, "toY": H - 3,
    })
    with io.open(town_path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(json.dumps(town, indent=2, ensure_ascii=False) + "\n")
    print("round-town now opens on the tavern at %d,%d" % TOWN_DOOR)

    yard_path = os.path.join(AREAS, "broken-yard.json")
    yard = json.load(open(yard_path, encoding="utf-8"))
    fixed = 0
    for tr in yard["transitions"]:
        if tr["toArea"] == "hanged-ferryman":
            tr["toX"], tr["toY"] = 1, WEST_DOOR_Y
            fixed += 1
    with io.open(yard_path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(json.dumps(yard, indent=2, ensure_ascii=False) + "\n")
    print("repointed %d door(s) from the yard" % fixed)


if __name__ == "__main__":
    main()
