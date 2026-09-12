"""Dress Ashfold: the clutter a lived-in town has (D-591).

    python tools/src/dress-ashfold.py

ADDS to `round-town`'s placed assets; it never rewrites what is there. The
street plan, the walls, the gates and the four buildings are D-549's and
`design-ashfold.py`'s, and this is the layer on top -- market stalls with goods
beside them, a woodpile at the smithy, benches at the well, grass and flowers
breaking up the open green.

WARNING: EVERY SOLID PLACEMENT IS TESTED AGAINST A KEEP-CLEAR SET BEFORE IT IS
KEPT, and refusals are printed. The lesson is D-584's, learned the expensive
way: a market stall was dropped into the square and the only thing that noticed
was a walk test, after the map had been declared finished. A prop that blocks a
route does not look wrong -- it looks like a prop.

WARNING: a flower is not a wall. Almost everything in these packs is
`solid: true` including `sm-env-flower-01`, so anything scattered for looks
carries an EXPLICIT empty mask (`overrideCollision`), which is a statement that
you may walk through it rather than an oversight. Grass tufts are the exception
and are genuinely non-solid in the catalogue.

WARNING: the collision mask is baked HERE, from the catalogue, exactly as the
editor bakes it (D-567). CI's drift check compares what is baked against what
the catalogue says, so a wrong copy of this rule fails the build rather than
shipping walk-through walls. It is nonetheless the THIRD copy of `defaultMask`
(shared/src/assets.ts, design-ashfold.py, here) and worth collapsing.
"""
import io
import json
import math
import random
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf8")

AREA = "content/areas/round-town.json"
K, V, D = "knights", "vikings", "dungeon-pack"

CATALOGUE = {}
for _pack in (K, V, D):
    for _a in json.load(open(f"content/assets/{_pack}.environment.json", encoding="utf8"))["assets"]:
        CATALOGUE[f"{_pack}/{_a['id']}"] = _a

rng = random.Random(5417)   # fixed: a re-run must not shuffle the town
added, refused = [], []


def default_mask(pack, asset):
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


# --------------------------------------------------------------- keep clear
# WARNING: these are the tiles the town cannot afford to lose, and they are
# derived from the map rather than typed: the road a body actually walks, the
# ring, the reach of every facility, and where the round opens. D-549's whole
# point is that every route between two buildings passes the square, so a prop
# in the wrong metre does not make the town prettier, it makes it a different
# town.
AREADOC = json.load(io.open(AREA, encoding="utf8"))
W, H = AREADOC["width"], AREADOC["height"]
TILES = AREADOC["tiles"]

KEEP = set()
for _y in range(H):
    for _x in range(W):
        on_road = TILES[_y][_x] == ","
        # The four approaches, a tile wider than the walkable pair either side.
        spoke = (23 <= _x <= 26) or (23 <= _y <= 26)
        if on_road or (spoke and (TILES[_y][_x] in ",.")):
            KEEP.add((_x, _y))
# Two tiles around every facility — that is the distance they are used from.
for st in AREADOC.get("stations", []):
    for dy in range(-2, 3):
        for dx in range(-2, 3):
            KEEP.add((st["x"] + dx, st["y"] + dy))
# Where the round opens, and room to stand around it.
for dy in range(-2, 3):
    for dx in range(-2, 3):
        KEEP.add((AREADOC["spawn"]["x"] + dx, AREADOC["spawn"]["y"] + dy))
# ⚠ THE FOUR CORNERS OF THE SQUARE, because `mr7-ashfold.test.ts` walks a body
# to each of them and that test IS the contract for this map. The first pass
# put a barrel on one, a crate on another and a market stall on the other two —
# every one of them reachable, so the flood was happy, and the walk test said
# "no route to (20,20)". A tile a test stands on is as load-bearing as a road.
for cx, cy in ((20, 20), (30, 20), (20, 30), (30, 30)):
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            KEEP.add((cx + dx, cy + dy))


BODY_RADIUS = 0.3   # shared/src/collision.ts


def tiles_under(x, y, rot, footprint, grow=0.0):
    """The tiles a footprint actually covers.

    WARNING: a tile is covered when its CENTRE is inside the rectangle, which
    is how `canOccupy` thinks about it. The first version rounded both edges
    outwards, so a two-metre bench claimed THREE tiles and the guard refused it
    for standing on a road it did not reach. A guard that is wrong in the safe
    direction still costs you the town: six objects were dropped silently, and
    a missing bench looks exactly like a bench nobody placed.
    """
    w, h = footprint
    if round(rot / 90) % 2 == 1:
        w, h = h, w
    w, h = w + 2 * grow, h + 2 * grow
    out = set()
    for ty in range(math.ceil(y - h / 2), math.floor(y + h / 2) + 1):
        for tx in range(math.ceil(x - w / 2), math.floor(x + w / 2) + 1):
            out.add((tx, ty))
    return out


# Tiles already blocked by what the town was built with, plus what this script
# has placed so far.
WALKABLE = {(x, y) for y in range(H) for x in range(W)
            if AREADOC["legend"][TILES[y][x]]["walkable"]}
BLOCKED = set()
for _a in AREADOC["assets"]:
    for _v in _a.get("collision", []):
        if _v.get("walkable", False):
            continue
        _sh = _v["shape"]
        # ⚠ GROWN BY BODY_RADIUS. A body has width, so what closes a route is
        # not a prop covering a tile — it is two props leaving less than 60cm
        # between them. Testing bare coverage passed five pinched tiles that
        # the build then refused, and working backwards from "(7,14) is
        # unreachable" to which tree did it is exactly the loop this guard
        # exists to avoid.
        BLOCKED |= tiles_under(_a["x"] + _sh.get("x", 0), _a["y"] + _sh.get("y", 0),
                               _a["rotation"], [_sh["w"], _sh["h"]], grow=BODY_RADIUS)


def stranded(extra):
    """Walkable tiles the spawn can no longer reach, if `extra` were blocked.

    WARNING: this is the check the BUILD does (`validate:content` floods every
    area from its spawn), brought forward so the tool refuses what the build
    would refuse — the promise D-543 makes for the map editor. Without it the
    answer arrives as "26 walkable tiles unreachable, e.g. (3,3)" after the
    fact, and works backwards from a coordinate to a prop.

    WARNING: it is an APPROXIMATION and deliberately a looser one — tile
    centres against collision rectangles, where the real check sweeps a body of
    BODY_RADIUS. It catches a pocket, which is the failure that matters here;
    `validate:content` remains the authority and is run afterwards.
    """
    blocked = BLOCKED | extra
    start = (AREADOC["spawn"]["x"], AREADOC["spawn"]["y"])
    seen, stack = {start}, [start]
    while stack:
        x, y = stack.pop()
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if (nx, ny) in seen or (nx, ny) in blocked or (nx, ny) not in WALKABLE:
                continue
            seen.add((nx, ny))
            stack.append((nx, ny))
    return (WALKABLE - blocked) - seen


def put(pack, asset, x, y, rot=0, z=0.0, scale=1.0, walkthrough=False):
    """One asset, refused if it is solid and would stand in — or seal off — a route."""
    a = CATALOGUE.get(f"{pack}/{asset}")
    if a is None:
        raise SystemExit(f"no catalogue entry for {pack}/{asset}")
    mask = [] if walkthrough else default_mask(pack, asset)
    if mask:
        covered = tiles_under(x, y, rot, a.get("footprint", [1, 1]))
        clash = covered & KEEP
        if clash:
            refused.append(f"{asset} at {x:.1f},{y:.1f} — would stand on {sorted(clash)[:3]}")
            return None
        pinch = tiles_under(x, y, rot, a.get("footprint", [1, 1]), grow=BODY_RADIUS)
        cut = stranded(pinch)
        if cut:
            refused.append(
                f"{asset} at {x:.1f},{y:.1f} — would seal {len(cut)} tile(s) off, "
                f"e.g. {sorted(cut)[:3]}")
            return None
        BLOCKED.update(pinch)
    doc = {
        "asset": asset, "pack": pack,
        "x": float(x), "y": float(y), "z": float(z),
        "rotation": float(rot), "scale": float(scale),
        "collision": mask,
        "overrideCollision": bool(walkthrough),
    }
    added.append(doc)
    return doc


def scatter(pack, assets, spots, walkthrough=False):
    for (x, y) in spots:
        put(pack, rng.choice(assets), x, y, rot=rng.choice([0, 90, 180, 270]),
            walkthrough=walkthrough)


# ------------------------------------------------------------ the market
# The square is where the round opens and where every errand crosses (D-549),
# so the stalls sit at its EDGES and the middle stays open. Two were already
# here; these are the rest of a market, plus what a market leaves lying about.
put(V, "sm-bld-stall-cover-01", 18.0, 30.0, rot=90)
put(V, "sm-bld-stall-cover-01", 32.0, 30.0, rot=90)
put(V, "sm-prop-table-01", 18.0, 32.5)
put(V, "sm-prop-table-01", 32.0, 32.5)
put(V, "sm-prop-crate-open-01", 17.5, 28.0)
put(V, "sm-prop-crate-base-01", 17.5, 32.0)
put(V, "sm-prop-barrel-half-01", 32.5, 28.0)
put(V, "sm-prop-barrel-half-02", 32.5, 32.0)
put(V, "sm-prop-clay-pot-01", 20.0, 32.5)
put(V, "sm-prop-clay-pot-02", 30.0, 32.5)
put(V, "sm-prop-fish-hanging-01", 18.0, 28.0)
put(V, "sm-prop-wagon-01", 31.0, 28.0, rot=90)
put(K, "sm-prop-cartwheel-01", 32.5, 29.5)
put(V, "sm-prop-fur-roll-01", 17.5, 28.0)

# Benches where people wait for the well — the one place the cast is forced to
# queue, and the only place a poisoner can be seen (D-529).
put(V, "sm-prop-bench-01", 20.5, 32.0)
put(V, "sm-prop-bench-01", 28.5, 32.0)
put(V, "sm-prop-seat-01", 19.0, 34.0)

# ------------------------------------------------------- the tavern front
# The door faces south into the square; everything here stands clear of it.
put(V, "sm-prop-bench-01", 22.0, 18.5)
put(V, "sm-prop-bench-01", 28.0, 18.5)
put(V, "sm-prop-barrel-half-01", 19.0, 22.0)
put(V, "sm-prop-barrel-half-02", 19.0, 21.0)
put(V, "sm-prop-crate-open-01", 31.0, 21.5)
put(K, "sm-prop-weathervane-01", 30.5, 12.0)
put(V, "sm-prop-torchstick-01", 22.0, 20.0)
put(V, "sm-prop-torchstick-01", 28.0, 20.0)

# ------------------------------------------------- the smithy, north-west
put(V, "sm-prop-logs-01", 13.5, 7.0)
put(V, "sm-prop-log-01", 13.0, 12.0, rot=90)
put(K, "sm-prop-cartwheel-01", 7.0, 12.0)
put(V, "sm-prop-rack-01", 8.0, 12.5)
put(V, "sm-prop-anvil-01", 8.0, 11.0)
put(V, "sm-prop-crate-base-01", 6.0, 12.5)
put(K, "sm-prop-carthay-01", 14.5, 8.0, rot=90)

# --------------------------------------------- the storehouse, north-east
put(V, "sm-prop-crate-open-01", 36.0, 12.5)
put(V, "sm-prop-crate-base-01", 37.0, 12.5)
put(V, "sm-prop-barrel-half-01", 38.0, 12.5)
put(V, "sm-prop-barrel-half-02", 42.5, 12.5)
put(V, "sm-prop-wheel-barrow-01", 44.0, 9.0)
put(V, "sm-prop-net-01", 35.0, 9.0)
put(V, "sm-prop-chest-01", 43.5, 12.5)

# ---------------------------------------------- the infirmary, south-west
put(V, "sm-prop-clay-pot-01", 7.0, 39.0)
put(V, "sm-prop-clay-pot-02", 8.0, 39.0)
put(V, "sm-prop-rack-01", 12.0, 39.0)
put(V, "sm-prop-bench-01", 6.5, 46.5)
put(V, "sm-prop-table-01", 13.0, 46.5)

# --------------------------------------------- the guardhouse, south-east
# "The guards saw you" needs a place on the map (D-549), and it should look
# like one.
put(V, "sm-prop-rack-01", 36.0, 39.0)
put(V, "sm-prop-shield-decor-01", 38.0, 39.0)
put(V, "sm-prop-spikes-01", 44.0, 39.0, rot=90)
put(K, "sm-prop-banner-02", 36.5, 46.5)
put(V, "sm-prop-flag-01", 43.5, 39.0)
put(V, "sm-prop-torchstick-01", 37.0, 46.5)
put(V, "sm-prop-torchstick-01", 43.0, 46.5)

# ---------------------------------------------------- gates and the wall
# A torch at each gate, and banners where the wall meets it, so a gate reads as
# a gate from a distance rather than as a gap.
for gx, gy, rot in ((24.5, 3.0, 0), (24.5, 46.0, 0), (3.0, 24.5, 90), (46.0, 24.5, 90)):
    off = (2.0, 0.0) if rot == 0 else (0.0, 2.0)
    put(V, "sm-prop-torchstick-01", gx - off[0], gy - off[1])
    put(V, "sm-prop-torchstick-01", gx + off[0], gy + off[1])
put(K, "sm-prop-banner-03", 21.0, 1.6)
put(K, "sm-prop-banner-03", 28.0, 1.6)
put(K, "sm-prop-banner-03", 21.0, 47.4)
put(K, "sm-prop-banner-03", 28.0, 47.4)

# ------------------------------------------------------------- roadside fence
# ⚠ RUNS, never plots. The first cut fenced four small paddocks on the green;
# together with the copses they penned six tiles nobody could reach, and each
# fix moved the pocket rather than closing it — a fence with a return at both
# ends IS a pen, and on open ground a pen is a hole in the map. These are
# single straight runs with open ground on both sides, on the two quadrants
# with no trees in them.
for x0, y0, n in ((17.0, 8.0, 4), (30.0, 41.0, 4)):
    for i in range(n):
        put(V, "sm-prop-fence-wood-01", x0 + i * 2.0, y0)

# ------------------------------------------------------ the copses, thicker
# Four corners of trees already; these fill them out so a copse reads as cover
# rather than as three trees.
# ⚠ A refused tree is a thinner copse and nothing says so on screen, so the
# spread is kept off the ring road rather than trusting the guard to catch it:
# the corners are the only part of the green far enough from a route for a
# three-metre canopy.
# ⚠ FOUR TREES, and the number is what six attempts cost. Every wider copse —
# random scatter, spacing rules, quarter-turns, hand-transcribed positions —
# left tiles nobody could reach, and each fix moved the pocket rather than
# closing it. A canopy is two to three metres, a body is sixty centimetres, and
# the open green is narrow enough between the ring road and the palisade that a
# single tree in the wrong metre makes a dead end along the wall.
#
# So: one tree per copse, on its INNER edge, where the green is widest and
# nothing can be trapped against anything. The copses stay thin. Making them
# thick needs the trees moved, not more of them, and that is a map decision
# rather than a dressing one.
for x, y, kind in ((12.0, 19.0, "sm-env-tree-01"), (37.5, 19.0, "sm-env-tree-02"),
                   (12.0, 30.5, "sm-env-tree-03"), (37.5, 30.5, "sm-env-tree-01")):
    put(K, kind, x, y, rot=rng.choice([0, 90, 180, 270]), scale=1.05)

# -------------------------------------------------------- rocks and rubble
# ⚠ The knights ROCKPILES are set pieces, not scatter: 6x5 and 5x6 metres. One
# at the north-west corner filled the whole gap between the palisade and the
# smithy and SEALED 26 tiles off from the rest of the town — caught by the
# reachability flood, which is the only thing that could have. Nothing about a
# rock pile looks like a wall. The small rocks are 2x2 and cannot do it.
put(V, "sm-env-rock-01", 16.0, 8.0)
put(V, "sm-env-rock-02", 33.5, 41.0)
put(V, "sm-env-rock-01", 33.5, 8.0)
put(V, "sm-env-rock-02", 16.0, 41.0)
put(V, "sm-env-rock-01", 19.5, 44.0)
put(V, "sm-env-rock-02", 30.0, 5.5)

# ------------------------------------------------------- grass and flowers
# WARNING: the only genuinely walk-through things here are the grass tufts.
# Everything else that is scattered for looks is given an EXPLICIT empty mask —
# a flower you cannot walk past is worse than no flower.
tufts, flowers = [], []
for _ in range(150):
    x, y = rng.uniform(1.5, 47.5), rng.uniform(1.5, 47.5)
    tx, ty = int(round(x)), int(round(y))
    if not (0 <= tx < W and 0 <= ty < H) or TILES[ty][tx] != "g":
        continue
    (flowers if rng.random() < 0.28 else tufts).append((x, y))
scatter(V, ["sm-env-grass-01", "sm-env-grass-02", "sm-env-grasspatch-01"], tufts)
scatter(K, ["sm-env-flower-01"], flowers, walkthrough=True)

# ------------------------------------------------------------- the statue
# WARNING: the knights statue is REPLACED, not re-textured. Its source FBX
# gives all 11,598 of its vertices ONE uv, so it samples a single texel and can
# only ever be a flat terracotta blob — measured, not guessed. The dungeon
# pack's statues carry 17-19 distinct uvs on weathered stone greys.
# ⚠ The exception is EXACTLY the tiles a statue already stands on. The square
# has had one at its centre since D-549 and every route through Ashfold is
# already walked around it; refusing the replacement would leave the square
# empty and call that an improvement. Anything wider than the old footprint is
# still refused.
OLD = next(a for a in AREADOC["assets"] if a["asset"] == "sm-prop-statue-01")
KEEP -= tiles_under(OLD["x"], OLD["y"], OLD["rotation"],
                    CATALOGUE[f"{K}/sm-prop-statue-01"]["footprint"])
# ⚠ TURNED 90°, so its 2x1 footprint is the 1x2 the old statue had — the same
# three tiles, not one more. The wider `statue-base` prop is deliberately left
# out for the same reason: it is 2x2, and a plinth is not worth two tiles of
# the one square the whole cast crosses.
put(D, "sm-env-statue-03", 25.0, 21.0, rot=90)

# ------------------------------------------------------------------ write
doc = json.load(io.open(AREA, encoding="utf8"))
doc["assets"] = [a for a in doc["assets"] if a["asset"] != "sm-prop-statue-01"] + added
with io.open(AREA, "w", encoding="utf8", newline="\n") as f:
    f.write(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")

solid = sum(1 for a in added if a["collision"])
print(f"  added {len(added)} objects ({solid} solid, {len(added) - solid} walk-through)")
print(f"  round-town now has {len(doc['assets'])} placed assets")
if refused:
    print(f"\n  REFUSED {len(refused)} — they would have stood in a route:")
    for r in refused:
        print("   ", r)
print("\nRun `npm run build:environment`, `npm run validate:content`, "
      "and the Ashfold walk test.")
