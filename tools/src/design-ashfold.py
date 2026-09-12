"""Ashfold, laid out by hand.

This is a TRANSCRIPTION of a layout, not a generator: every building, gate and
piece of furniture below is named and placed deliberately. The only loops are
straight runs of identical wall, which is the same gesture the editor's
drag-to-lay-a-run makes.

The town is D-549's: a square at the centre where every round opens, the four
working buildings around it, the well in the open on the way to the south gate,
a wall with four gates aligned to the four spokes, and copses in the corners.
"""
import io, json, sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf8")

AREA = "content/areas/round-town.json"
K = "knights"          # the village pack: houses, walls, paths, trees
V = "vikings"          # a second village pack, for timber and market clutter

placed = []

# The ingested catalogue, so a placement can bake the asset's own mask.
CATALOGUE = {}
for _pack in (K, V):
    for _a in json.load(open(f"content/assets/{_pack}.environment.json", encoding="utf8"))["assets"]:
        CATALOGUE[f"{_pack}/{_a['id']}"] = _a


def default_mask(pack, asset):
    """`defaultMask` from shared/src/assets.ts, in Python.

    WARNING: the mask is BAKED AT PLACEMENT, exactly as the editor does it
    (D-567). Writing an empty array instead means NO COLLISION -- every wall
    and building in the town would be walk-through, which CI's drift check
    caught the first time this file was run. An empty array is a statement,
    not a default.
    """
    a = CATALOGUE.get(f"{pack}/{asset}")
    if a is None:
        raise SystemExit(f"no catalogue entry for {pack}/{asset}")
    if not a.get("solid", True):
        return []
    w, h = a.get("footprint", [1, 1])
    size = a.get("size")
    top = size[1] if size else 3
    return [{
        "shape": {"kind": "rect", "x": 0, "y": 0, "w": w, "h": h, "rotation": 0},
        "base": 0, "top": top, "walkable": False, "opaque": a.get("opaque", True),
    }]


def put(pack, asset, x, y, rot=0, z=0.0, scale=1.0, mask=None):
    """One asset. `mask` overrides the footprint box — see the gates."""
    a = {
        "asset": asset, "pack": pack,
        "x": float(x), "y": float(y), "z": float(z),
        "rotation": float(rot), "scale": float(scale),
        "collision": mask if mask is not None else default_mask(pack, asset),
        "overrideCollision": mask is not None,
    }
    placed.append(a)
    return a


def box(w, h, top=3.0, opaque=True):
    return [{
        "shape": {"kind": "rect", "x": 0, "y": 0, "w": w, "h": h, "rotation": 0},
        "base": 0, "top": top, "walkable": False, "opaque": opaque,
    }]


def gate_mask(span=5.0, depth=2.0, post=1.0):
    """Two posts with the doorway open between them.

    The reason gates need this: a mesh's default mask is one box the size of
    its footprint, so an archway blocks its own opening. Every gate in this
    town is hand-masked, and the walk test is what proves it.

    WARNING: the opening is sized against BODY_RADIUS (0.3), not by eye. The
    first version left posts 0.5 from the centre of the outer road tile, so a
    body could not stand on it -- the gate looked open, the map validated, and
    one of the two tiles carrying players to the farm was unusable. Posts of 1
    at +/-2 leave the two road tiles a clear metre each side.
    """
    off = span / 2 - post / 2
    return [
        {"shape": {"kind": "rect", "x": -off, "y": 0, "w": post, "h": depth, "rotation": 0},
         "base": 0, "top": 4.0, "walkable": False, "opaque": True},
        {"shape": {"kind": "rect", "x": off, "y": 0, "w": post, "h": depth, "rotation": 0},
         "base": 0, "top": 4.0, "walkable": False, "opaque": True},
    ]


# ---------------------------------------------------------------- the wall
# WARNING: the wall sits ON the town's edge, not inset from it, and the first
# attempt got this wrong. Set back by three, it left a ring of open ground
# between the wall and the map border that no gate reached -- 45 walkable tiles
# cut off from the spawn, which CI's reachability flood refused. Ground a
# player can see and never stand on is a map lying about its own size.
#
# On the edge, the wall IS the boundary: the only way out is a gate, and a gate
# opens straight onto the tile that carries you to the next area, which is what
# makes leaving town a visible departure through a named road (D-529).
WALL, GATE = "sm-bld-castle-wall-01", "sm-bld-castle-wall-gate-01"
TOWER = "sm-bld-castle-tower-01"
N, S, W_, E = 1.0, 48.0, 1.0, 48.0
GATE_X, GATE_Y = 24.5, 24.5           # where the four roads leave town

# WARNING: the runs are placed so a segment EDGE lands either side of the
# gateway, rather than skipping whatever segment a blind grid happened to put
# near it. The first version skipped one 5-wide segment covering 20..25 and
# then centred a 5-wide gate at 24.5 (covering 22..27): the two did not line
# up, so the wall had a hole at x=20..22 that nothing filled and the gate
# blocked one of the two road tiles it was supposed to open.
#
# Segments overlap slightly. That is the pack's own habit -- a wall mesh is 5m
# long and a run is rarely a multiple of 5 -- and the mask is what decides
# where a body may walk.
WALL_RUN = [2.5, 7.5, 12.5, 17.5, 19.5, 29.5, 32.5, 37.5, 42.5, 47.5]
for c in WALL_RUN:
    put(K, WALL, c, N)
    put(K, WALL, c, S)
    put(K, WALL, W_, c, rot=90)
    put(K, WALL, E, c, rot=90)

put(K, GATE, GATE_X, N, mask=gate_mask())                 # to the farm
put(K, GATE, GATE_X, S, mask=gate_mask())                 # to the dungeon road
put(K, GATE, W_, GATE_Y, rot=90, mask=gate_mask())        # to the wood
put(K, GATE, E, GATE_Y, rot=90, mask=gate_mask())         # to the mine

for cx, cy in ((N, W_), (S, W_), (N, E), (S, E)):
    put(K, TOWER, cx, cy)

# ------------------------------------------------------------- the square
# Cobbled, and walkable: path pieces are not solid, so they dress the ground
# without narrowing it. The square is where the dawn truce happens, so it is
# deliberately the largest open thing on the map.
# WARNING: EVERYTHING COBBLED SHARES ONE GRID, CENTRED ON 24.5.
#
# 24.5 is the midpoint of the two road tiles (24 and 25) that carry a player
# out of town, and it is where the four gates are centred. The first version
# ran the roads down x=25 and tiled the square from 19 in steps of three, which
# was wrong twice: the road sat half a metre off the gateway it led to, and the
# road grid (..15, 18) and the square grid (19, 22..) were out of phase, so a
# 3m cobble piece had to jam into a 1m gap where they met.
#
# A road that does not line up with its own gate is the thing a player reads
# first and trusts least: it says the town was assembled rather than built.
CENTRE = 24.5
COBBLE = 3.0
GRID = [CENTRE + COBBLE * k for k in range(-7, 8)]       # 3.5 .. 45.5
SQUARE = [c for c in GRID if abs(c - CENTRE) <= COBBLE * 2]   # 18.5 .. 30.5

for x in SQUARE:
    for y in SQUARE:
        alt = (round((x - CENTRE) / COBBLE) + round((y - CENTRE) / COBBLE)) % 2
        put(K, "sm-env-path-cobble-01" if alt else "sm-env-path-cobble-02", x, y)

# The four roads out, on the same grid, so each one runs from the square to the
# middle of its own gateway.
for c in GRID:
    if abs(c - CENTRE) <= COBBLE * 2:
        continue                                  # already laid as the square
    put(K, "sm-env-path-cobble-02", CENTRE, c)    # the north and south roads
    put(K, "sm-env-path-cobble-02", c, CENTRE)    # the east and west roads

# --------------------------------------------------------------- buildings
# The tavern, on the north side of the square with its door onto it. Placed
# clear of the spawn (25,25) on purpose: a solid box over the spawn is a round
# that opens inside a wall.
put(K, "sm-bld-house-room-03", 25, 15)
put(K, "sm-bld-house-roomtall-02", 21, 15)
put(K, "sm-bld-house-chimney-01", 28, 14)
put(K, "sm-prop-shopsign-01", 25, 18)
put(K, "sm-prop-lampost-01", 22.5, 18.5)
put(K, "sm-prop-lampost-01", 27.5, 18.5)

# The four working buildings, each set BEHIND its station so the station
# itself stays in the open and can be walked up to (D-530: using a facility is
# never required, so it must never be awkward).
put(K, "sm-bld-house-room-01", 10, 4)          # workshop, north-west
put(V, "sm-prop-anvil-stump-01", 11.5, 9)
put(K, "sm-bld-house-room-05", 40, 4)          # storehouse, north-east
put(K, "sm-prop-cart-01", 38, 9.5)
put(K, "sm-bld-house-room-02", 10, 39)         # infirmary, south-west
put(K, "sm-bld-house-room-06", 40, 43)         # the guardhouse, south-east
put(K, "sm-prop-banner-01", 37.5, 41)
put(K, "sm-prop-brazier-01", 42.5, 41)

# ------------------------------------------------------------ the market
# Placed one at a time. A market whose stalls land where the RNG puts them is
# not a market (D-549), and this is the one part of the map a player stands in
# every single round.
# WARNING: the stalls FLANK the south road rather than standing in the square.
# They were in it, and a walk test could not cross it corner to corner: a stall
# is 3x2 of solid goods and the square is where the whole cast stands during
# the dawn truce (D-536). Out here they are passed by everyone walking to the
# water, which is what a market wants anyway.
put(V, "sm-bld-stall-cover-01", 19, 33, rot=180)
put(V, "sm-bld-stall-cover-01", 31, 33, rot=180)
put(V, "sm-prop-crate-base-01", 18, 34.5)
put(K, "sm-prop-crate-01", 31, 34.5)
put(V, "sm-prop-barrel-half-01", 32.5, 34.5)
put(K, "sm-prop-statue-01", 25, 21)
put(K, "sm-prop-brazier-01", 21.5, 21.5)
put(K, "sm-prop-brazier-01", 28.5, 21.5)

# The well stands alone in the open on the way to the south gate, so poisoning
# it cannot be done unseen (D-529). Nothing is placed within two tiles of it.
put(K, "sm-prop-lampost-01", 21, 34)
put(K, "sm-prop-lampost-01", 28, 34)

# --------------------------------------------------------------- the corners
# Copses, inside the wall, breaking the four dead corners without reaching the
# roads. Chosen individually so they read as trees rather than as a texture.
for x, y, which in (
    (8, 13, "01"), (11, 16, "02"), (7, 18, "03"),
    (42, 13, "02"), (39, 16, "01"), (43, 18, "03"),
    (8, 31, "03"), (12, 34, "01"), (7, 37, "02"),
    (42, 31, "01"), (38, 34, "03"), (43, 37, "02"),
):
    put(K, f"sm-env-tree-{which}", x, y)

# --------------------------------------------------------------------- write
doc = json.load(open(AREA, encoding="utf8"))

# WARNING: the GROUND is flattened, because the structure is these meshes now.
#
# `build-round-map.py` still carves this town out of wall TILES -- palisade,
# timber, brick, plaster, treeline -- which is how the map was built before
# D-567 said a map is made of pack meshes and the ground's job is to be ground.
# Leaving them would put two towns in one map: the generator's boxes standing
# invisibly inside the buildings placed here, which is exactly what the first
# run of this file produced (386 unwalkable tiles nobody had placed).
#
# Water is left alone: it is a feature rather than a wall.
GROUND = "g"
leg = doc["legend"]
solid = {c for c, v in leg.items() if not v["walkable"] and v["kind"] != "water"}
doc["tiles"] = ["".join(GROUND if ch in solid else ch for ch in row) for row in doc["tiles"]]

doc["assets"] = placed
with io.open(AREA, "w", encoding="utf8", newline="\n") as f:
    f.write(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")
print(f"placed {len(placed)} assets in Ashfold")
