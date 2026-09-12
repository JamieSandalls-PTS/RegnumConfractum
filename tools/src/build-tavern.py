"""
Rebuilds the Hanged Ferryman at half size (D-544).

    python tools/src/build-tavern.py

The tavern was 64x64 and the stakeholder was right that it is far too large:
a 62x62 room is a warehouse, and the first-slice scene (D-505) is meant to be
a taproom where a dozen people cannot avoid each other. This rebuilds it at
**32x32**.

Why a script rather than the editor's resize: the old room's CONTENT filled
its full 62x62, so there was nothing to crop — trimming would have thrown away
three quarters of the tavern rather than tightening it. Halving a room means
re-authoring it, and re-authoring is what a generator is for. The same reason
`build-round-map.py` exists.

⚠ It also rewrites the yard's door, because moving the tavern's entrance
orphans the transition pointing at it. The editor now refuses a save that
would do that; this script does the pair together.
"""

import io
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
AREAS = os.path.join(ROOT, "content", "areas")

W = H = 32

LEGEND = {
    "#": {"walkable": False, "kind": "wall"},
    "T": {"walkable": False, "kind": "wall-timber"},
    "F": {"walkable": False, "kind": "wall-forest"},
    ".": {"walkable": True, "kind": "floor"},
    "f": {"walkable": True, "kind": "wood"},
    "t": {"walkable": False, "kind": "table"},
    "c": {"walkable": True, "kind": "chair"},
    "H": {"walkable": False, "kind": "hearth"},
}

# The room: a boarded taproom, set inside the plot rather than filling it.
#
# The first pass at 32x32 kept the room the full size of the map, which missed
# half the stakeholder's point: a taproom should be a room you cross in a few
# steps, with an outside to arrive from. 20x15 of interior is about forty
# seats — a crowded night — and it leaves an approach, a yard and a treeline
# around it.
ROOM_X0, ROOM_Y0, ROOM_X1, ROOM_Y1 = 8, 8, 28, 23
DOOR_Y = 16


def blank():
    return [["." for _ in range(W)] for _ in range(H)]


def main():
    g = blank()
    # Outer wall.
    for x in range(W):
        g[0][x] = g[H - 1][x] = "#"
    for y in range(H):
        g[y][0] = g[y][W - 1] = "#"

    # The taproom itself: TIMBER walls (D-545), boards inside. A tavern is
    # not built of the same stone as a town gate, and now it does not have to
    # look as though it were.
    for y in range(ROOM_Y0, ROOM_Y1 + 1):
        for x in range(ROOM_X0, ROOM_X1 + 1):
            edge = x in (ROOM_X0, ROOM_X1) or y in (ROOM_Y0, ROOM_Y1)
            g[y][x] = "T" if edge else "f"

    # The door, west wall, opening onto the strip that leads to the yard.
    g[DOOR_Y][ROOM_X0] = "f"

    # A treeline closing the outside strip, so the approach reads as a place
    # rather than as the edge of the data (D-545).
    for y in range(1, H - 1):
        # ...with a gap where the door out sits, or the treeline would grow
        # across the only exit.
        if y != DOOR_Y:
            g[y][1] = "F"

    # The hearth, set into the north wall (the terrain renderer turns the
    # tiles beside a wall into a chimney breast and a fire).
    for x in (17, 18):
        g[ROOM_Y0 + 1][x] = "H"

    # The bar: a run of counter along the east wall, with a gap to get behind.
    for y in range(10, 22):
        if y == 16:
            continue
        g[y][ROOM_X1 - 1] = "t"

    # Tables with their chairs. Hand-placed rather than scattered: a taproom
    # reads as a room somebody arranged, and D-505's scene is people sitting
    # down together.
    tables = [
        (11, 11), (16, 11), (21, 11),
        (11, 16), (16, 16),
        (11, 21), (16, 21), (21, 20),
    ]
    for tx, ty in tables:
        g[ty][tx] = "t"
        for cx, cy in ((tx - 1, ty), (tx + 1, ty), (tx, ty - 1), (tx, ty + 1)):
            if ROOM_X0 < cx < ROOM_X1 and ROOM_Y0 < cy < ROOM_Y1 and g[cy][cx] == "f":
                g[cy][cx] = "c"

    # The roof: painted as a footprint over the room, shape derived (D-545).
    roofs = [
        {"x": x, "y": y, "style": "thatch"}
        for y in range(ROOM_Y0, ROOM_Y1 + 1)
        for x in range(ROOM_X0, ROOM_X1 + 1)
    ]

    rows = ["".join(r) for r in g]

    # Props: the clutter a working taproom has, plus the new door/window and
    # foliage families (D-544). Windows and torches mount IN the wall tiles.
    props = []
    for y in (11, 20):
        props.append({"x": ROOM_X1, "y": y, "type": "window-lit"})
    for y in (11, 21):
        props.append({"x": ROOM_X0, "y": y, "type": "window"})
    for x in (12, 18, 24):
        props.append({"x": x, "y": ROOM_Y1, "type": "window-lit"})
    for x in (12, 24):
        props.append({"x": x, "y": ROOM_Y0, "type": "window"})
    # Torches inside on the long walls, so the room is lit by something.
    for y in (10, 14, 19, 22):
        props.append({"x": ROOM_X0, "y": y, "type": "wall-torch"})
    for y in (13, 18, 22):
        props.append({"x": ROOM_X1, "y": y, "type": "wall-torch"})
    for x in (14, 21):
        props.append({"x": x, "y": ROOM_Y0, "type": "wall-torch"})
    for x in (15, 22):
        props.append({"x": x, "y": ROOM_Y1, "type": "wall-torch"})
    # The door itself, in the gap.
    props.append({"x": ROOM_X0, "y": DOOR_Y, "type": "door", "rot": 2})
    # Stores behind the bar and in the corners.
    for x, y, kind in [
        # ⚠ Nothing goes at (26,22): the bar ends at (27,21) and the south
        # wall is at y=23, so a solid prop there boxes (27,22) in. The
        # validator catches it, which is how this comment came to exist.
        (26, 10, "barrel-stack"), (24, 22, "barrel"), (22, 22, "crate-stack"),
        (10, 10, "crate"), (10, 22, "sack-pile"), (24, 9, "barrel"),
        (9, 20, "firewood"), (13, 22, "crate"), (11, 9, "basket"),
    ]:
        props.append({"x": x, "y": y, "type": kind})
    # Outside: a little life on the approach to the door.
    for x, y, kind in [
        (4, 12, "bush"), (5, 20, "fern"), (4, 25, "wildflowers"),
        (5, 6, "bush"), (3, 9, "wildflowers"), (4, 28, "reeds"),
        (3, 4, "sapling"), (16, 4, "bush"), (22, 5, "wildflowers"),
        (13, 27, "bush"), (20, 28, "fern"), (27, 5, "sapling"),
        (29, 14, "bramble"), (6, 16, "wildflowers"), (25, 27, "bush"),
    ]:
        props.append({"x": x, "y": y, "type": kind})
    props.append({"x": ROOM_X0, "y": DOOR_Y - 3, "type": "ivy"})
    props.append({"x": ROOM_X0, "y": DOOR_Y + 3, "type": "ivy"})
    # A lantern either side of the door, so the way in reads at night.
    for y in (DOOR_Y - 2, DOOR_Y + 2):
        props.append({"x": ROOM_X0 - 2, "y": y, "type": "lantern-post"})

    doc = {
        "id": "hanged-ferryman",
        "name": "The Hanged Ferryman",
        "width": W,
        "height": H,
        "legend": LEGEND,
        "tiles": rows,
        "spawn": {"x": 14, "y": 16},
        "lighting": "interior",
        "outdoor": False,
        "zone": "settled",
        "ambience": "ambience-interior",
        # D-567: no procedural scenery. See build-round-map.py.
        "roofs": roofs,
        "stations": [],
        "nodes": [],
        "transitions": [
            {"x": 1, "y": DOOR_Y, "toArea": "broken-yard", "toX": 29, "toY": 16},
        ],
        "scripts": ["ferryman-keeper"],
        # The first-slice tavern is a real place a player starts in (D-505), not
        # a map for trying things — so it says so (D-581).
        "live": True,
    }

    path = os.path.join(AREAS, "hanged-ferryman.json")

    # WARNING: what a re-run must NOT throw away. This script builds its
    # document from scratch, which is right for the SHAPE it owns and wrong for
    # everything a person or another tool put on top -- the same trap
    # `build-round-map.py` carries `PRESERVED` for (D-590).
    #
    # It has already cost something: running this to restore the tavern's walls
    # dropped the `live` flag it had been carrying, and had the map been dressed
    # or painted at the time it would have taken those too, silently, in a
    # script whose printed output says only how many roof tiles it wrote.
    PRESERVED = ("live", "assets", "groundPaint", "groundMaterials")
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
    print("wrote hanged-ferryman (%dx%d, %d props, %d roof tiles)%s"
          % (W, H, len(props), len(roofs),
             "" if not kept else "  [kept %s]" % ", ".join(sorted(kept))))

    # The yard's door must arrive somewhere that still exists.
    yard_path = os.path.join(AREAS, "broken-yard.json")
    yard = json.load(open(yard_path, encoding="utf-8"))
    fixed = 0
    for tr in yard["transitions"]:
        if tr["toArea"] == "hanged-ferryman":
            tr["toX"], tr["toY"] = 2, DOOR_Y
            fixed += 1
    with io.open(yard_path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(json.dumps(yard, indent=2, ensure_ascii=False) + "\n")
    print("repointed %d door(s) from the yard" % fixed)


if __name__ == "__main__":
    main()
