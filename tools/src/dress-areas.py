"""Dress the world with pack meshes (D-592).

    python tools/src/dress-areas.py [area-id ...]

WARNING: THIS REPLACES THE D-542 SCRIPT OF THE SAME NAME, which wrote the
`props` array. Props were the hand-written geometry the renderer used before
pack meshes (D-567); nothing reads that array now, and D-582 stripped the last
of it. What this writes is `assets`, the same field the map editor and
`design-ashfold.py` write.

Ashfold is NOT here: `dress-ashfold.py` is a transcription of a town somebody
laid out by hand, and these are wilderness and dungeon floors where scatter is
what the place actually is. The same distinction `design-ashfold.py` and
`build-round-map.py` already have.

WARNING: EVERY SOLID PLACEMENT IS TESTED BEFORE IT IS KEPT — against a
keep-clear set derived from the area's own data, against a minimum gap to
every other solid thing, and against a flood from the spawn. Refusals are
counted and printed. D-584's lesson, and D-591's: a prop that blocks a route
does not look wrong, it looks like a prop, and the only thing that notices is
a test run after the map was called finished.

WARNING: the MINIMUM GAP is the load-bearing rule and it is not decoration. A
body is 60cm across and a canopy is two to three metres, so two solid things a
metre apart are a wall with a gap nobody can use, and the tile behind them
becomes unreachable. Four different placement strategies were tried on
Ashfold's copses before spacing was accepted as the answer (D-591).

WARNING: a flower is not a wall. Almost everything in these packs is
`solid: true` — `sm-env-flower-01` included — so anything scattered purely for
looks carries an EXPLICIT empty mask, which is a statement that you may walk
through it rather than an oversight.
"""

import io
import json
import math
import os
import random
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf8")

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
AREAS = os.path.join(ROOT, "content", "areas")
K, V, D = "knights", "vikings", "dungeon-pack"
BODY_RADIUS = 0.3            # shared/src/collision.ts

CATALOGUE = {}
for _pack in (K, V, D):
    _f = os.path.join(ROOT, "content", "assets", f"{_pack}.environment.json")
    for _a in json.load(io.open(_f, encoding="utf8"))["assets"]:
        CATALOGUE[f"{_pack}/{_a['id']}"] = _a


def layer(pack, assets, count, kinds, gap=3.6, walkthrough=False, scale=(1.0, 1.0)):
    return {"pack": pack, "assets": assets, "count": count, "kinds": set(kinds),
            "gap": gap, "walkthrough": walkthrough, "scale": scale}


# --------------------------------------------------------------- the recipes
# A layer is: what to place, how many, on which tile kinds, and how far apart.
# Counts are what a 100x100 wilderness can carry without becoming a maze —
# roughly one solid thing per forty square metres, and the walk-through layers
# on top of that.
RECIPES = {
    "round-farm": [
        layer(V, ["sm-env-flax-01", "sm-env-flax-02", "sm-env-flax-03"], 220, ["grass"],
              walkthrough=True),
        layer(V, ["sm-env-grass-01", "sm-env-grass-02", "sm-env-grasspatch-01"], 180,
              ["grass"], walkthrough=True),
        layer(K, ["sm-env-flower-01"], 70, ["grass"], walkthrough=True),
        layer(V, ["sm-prop-fence-wood-01", "sm-prop-fence-wood-02"], 34, ["grass"], gap=4.5),
        layer(K, ["sm-prop-carthay-01", "sm-prop-cart-01"], 8, ["grass"], gap=8.0),
        layer(V, ["sm-prop-wheel-barrow-01", "sm-prop-rack-01", "sm-prop-crate-open-01",
                  "sm-prop-barrel-half-01", "sm-prop-clay-pot-01"], 26, ["grass"], gap=5.0),
        layer(K, ["sm-bld-leanto-01"], 5, ["grass"], gap=12.0),
        layer(V, ["sm-prop-logs-01", "sm-prop-log-01"], 14, ["grass"], gap=6.0),
        layer(K, ["sm-env-tree-01", "sm-env-tree-02", "sm-env-tree-03"], 26, ["grass"],
              gap=5.0, scale=(0.9, 1.25)),
    ],
    "round-wood": [
        layer(V, ["sm-env-grass-01", "sm-env-grass-02", "sm-env-grasspatch-01"], 240,
              ["grass"], walkthrough=True),
        layer(D, ["sm-env-mushroom-small-01", "sm-env-mushroom-small-02",
                  "sm-env-flowers-01", "sm-env-flowers-02"], 90, ["grass"], walkthrough=True),
        layer(K, ["sm-env-tree-01", "sm-env-tree-02", "sm-env-tree-03",
                  "sm-env-tree-twisted-01"], 70, ["grass"], gap=5.2, scale=(0.9, 1.3)),
        layer(V, ["sm-prop-logs-01", "sm-prop-log-01"], 30, ["grass"], gap=5.0),
        layer(V, ["sm-env-rock-01", "sm-env-rock-02"], 22, ["grass"], gap=5.5),
        layer(D, ["sm-env-roots-01", "sm-env-roots-02"], 18, ["grass"], gap=5.0),
        layer(V, ["sm-prop-fence-stick-01", "sm-prop-wood-sharp-01"], 12, ["grass"], gap=6.0),
    ],
    "round-mine": [
        layer(D, ["sm-env-rubble-pebbles-01", "sm-env-rubble-pebbles-02",
                  "sm-env-rubble-pebbles-03"], 200, ["dirt"], walkthrough=True),
        layer(D, ["sm-env-rockpile-rounded-01", "sm-env-rockpile-rounded-02",
                  "sm-env-rockpile-square-01"], 46, ["dirt"], gap=5.0),
        layer(D, ["sm-env-minetrack-straight-01", "sm-env-minetrack-broken-01"], 22,
              ["dirt"], gap=6.0, walkthrough=True),
        layer(D, ["sm-prop-minecart-01", "sm-prop-minecart-wheel-01"], 10, ["dirt"], gap=8.0),
        layer(D, ["sm-prop-crate-wood-01", "sm-prop-barrel-01", "sm-prop-barrel-broken-01",
                  "sm-prop-bricks-01"], 34, ["dirt"], gap=4.5),
        layer(D, ["sm-env-wood-construction-01", "sm-prop-plank-01", "sm-prop-ladder-01"],
              18, ["dirt"], gap=6.0),
        layer(V, ["sm-env-grass-01", "sm-env-grasspatch-01"], 70, ["grass", "dirt"],
              walkthrough=True),
        layer(V, ["sm-env-rock-01", "sm-env-rock-02"], 26, ["dirt"], gap=5.5),
    ],
    "round-south": [
        layer(V, ["sm-env-grass-01", "sm-env-grass-02", "sm-env-grasspatch-01"], 200,
              ["dirt", "grass"], walkthrough=True),
        layer(K, ["sm-env-flower-01"], 50, ["dirt", "grass"], walkthrough=True),
        layer(V, ["sm-env-rock-01", "sm-env-rock-02", "sm-env-stone-01"], 44,
              ["dirt", "grass"], gap=5.0),
        layer(K, ["sm-env-tree-twisted-01"], 22, ["dirt", "grass"], gap=6.0,
              scale=(0.8, 1.15)),
        layer(V, ["sm-prop-cow-skull-01", "sm-prop-skull-01", "sm-prop-fence-stick-01"],
              24, ["dirt"], gap=5.0),
        layer(K, ["sm-prop-gravestone-01", "sm-prop-gravestone-02"], 14, ["dirt"], gap=5.0),
        layer(V, ["sm-prop-rock-circle-01", "sm-prop-rock-totem-01"], 8, ["dirt"], gap=10.0),
    ],
    "round-dungeon-1": [
        layer(D, ["sm-env-rubble-pebbles-01", "sm-env-rubble-pebbles-02",
                  "sm-env-moss-patch-01"], 180, ["dirt"], walkthrough=True),
        layer(D, ["sm-env-stalagmite-01", "sm-env-stalagmite-02", "sm-env-stalagmite-03"],
              54, ["dirt"], gap=4.5),
        layer(D, ["sm-env-rubble-01", "sm-env-rubble-02", "sm-env-brick-rubble-01"],
              44, ["dirt"], gap=4.5),
        layer(D, ["sm-prop-barrel-01", "sm-prop-crate-wood-01", "sm-prop-bricks-01"],
              26, ["dirt"], gap=5.0),
        layer(D, ["sm-env-pillar-broken-01", "sm-env-pillar-broken-02"], 16, ["dirt"],
              gap=7.0),
        layer(D, ["sm-prop-torchstick-01", "sm-prop-brazier-01"], 18, ["dirt"], gap=6.0),
    ],
    "round-dungeon-2": [
        layer(D, ["sm-env-rubble-pebbles-01", "sm-env-moss-patch-01",
                  "sm-env-mushroom-small-01"], 170, ["dirt"], walkthrough=True),
        layer(D, ["sm-env-stalagmite-03", "sm-env-stalagmite-04", "sm-env-stalagmite-05"],
              50, ["dirt"], gap=4.5),
        layer(D, ["sm-env-bonepile-small-01", "sm-env-bonepile-small-02",
                  "sm-env-bone-rib-01"], 34, ["dirt"], gap=4.5),
        layer(D, ["sm-env-rubble-01", "sm-env-rubble-03", "sm-env-brick-rubble-03"],
              38, ["dirt"], gap=4.5),
        layer(D, ["sm-prop-chain-01", "sm-prop-barrel-broken-01", "sm-prop-crate-wood-02"],
              22, ["dirt"], gap=5.0),
        layer(D, ["sm-prop-brazier-01", "sm-prop-candles-01"], 20, ["dirt"], gap=6.0),
        layer(D, ["sm-env-gem-spike-01", "sm-env-gem-spike-02"], 12, ["dirt"], gap=8.0),
    ],
    "round-dungeon-3": [
        layer(D, ["sm-env-rubble-pebbles-03", "sm-env-moss-patch-01"], 150, ["dirt"],
              walkthrough=True),
        layer(D, ["sm-env-stalagmite-05", "sm-env-stalagmite-06", "sm-env-stalagmite-07"],
              46, ["dirt"], gap=4.5),
        layer(D, ["sm-env-bonepile-01", "sm-env-bonepile-02", "sm-env-bone-ribcage-01"],
              30, ["dirt"], gap=5.0),
        layer(D, ["sm-prop-skeleton-01", "sm-prop-coffin-01"], 16, ["dirt"], gap=6.0),
        layer(D, ["sm-env-rune-pillar-01", "sm-env-rune-pillar-02",
                  "sm-env-obelisk-01"], 14, ["dirt"], gap=8.0),
        layer(D, ["sm-prop-brazier-01", "sm-prop-bonfire-01"], 16, ["dirt"], gap=6.0),
        layer(D, ["sm-env-gem-large-01", "sm-env-gem-large-02"], 10, ["dirt"], gap=9.0),
    ],
    "hanged-ferryman": [
        # ⚠ The taproom's tables, chairs and hearth are TILES, drawn by the
        # terrain renderer — this is what stands between and around them.
        layer(V, ["sm-prop-barrel-half-01", "sm-prop-barrel-half-02",
                  "sm-prop-crate-open-01", "sm-prop-clay-pot-01"], 14, ["wood"], gap=3.0),
        layer(V, ["sm-prop-fur-roll-01", "sm-prop-rope-01", "sm-prop-net-01"], 8,
              ["wood"], gap=3.0),
        layer(D, ["sm-prop-candle-01", "sm-prop-candles-01"], 10, ["wood"],
              walkthrough=True),
        # ⚠ The grass layer is GONE (D-604). It scattered 60 tufts on the
        # `floor` kind, which used to be the yard outside the door; the area is
        # now the room itself and there is no outdoors in it to dress.
        # ⚠ And the benches, logs and TREES that stood on the same `floor`
        # kind. A tavern with trees growing in it is what "it looks like it is
        # outside" meant.
        layer(V, ["sm-prop-bench-01"], 4, ["wood"], gap=4.0),
    ],
    "broken-yard": [
        layer(V, ["sm-env-grass-01", "sm-env-grass-02", "sm-env-grasspatch-01"], 90,
              ["floor"], walkthrough=True),
        layer(D, ["sm-env-rubble-pebbles-01", "sm-env-rubble-pebbles-02"], 50, ["floor"],
              walkthrough=True),
        layer(D, ["sm-env-rubble-01", "sm-env-brick-rubble-01", "sm-env-brick-rubble-02"],
              22, ["floor"], gap=4.0),
        layer(V, ["sm-prop-barrel-half-01", "sm-prop-crate-base-01", "sm-prop-boat-broken-01"],
              10, ["floor"], gap=5.0),
        layer(K, ["sm-env-tree-twisted-01"], 6, ["floor"], gap=6.0),
        layer(V, ["sm-env-reeds-01", "sm-env-reeds-02"], 18, ["floor"], walkthrough=True),
    ],
    "sunken-crypt": [
        # ⚠ Twelve by twelve, 89 floor tiles, and the one area in the game with
        # involuntary permadeath (D-513). It is dressed THIN on purpose: there
        # is nowhere here to lose a metre.
        layer(D, ["sm-env-rubble-pebbles-01", "sm-env-moss-patch-01"], 22, ["floor"],
              walkthrough=True),
        layer(D, ["sm-prop-candles-01", "sm-prop-candle-01"], 8, ["floor"],
              walkthrough=True),
        layer(D, ["sm-env-bonepile-small-01", "sm-env-bone-rib-01"], 6, ["floor"], gap=3.0),
        layer(D, ["sm-prop-coffin-01"], 3, ["floor"], gap=4.0),
    ],
    "proving-ground": [
        # A place to try things (D-581). A handful, so it is not bare, and no
        # more, so it stays a place to try things.
        layer(V, ["sm-env-grass-01", "sm-env-grasspatch-01"], 40, ["dirt"],
              walkthrough=True),
        layer(V, ["sm-prop-crate-base-01", "sm-prop-barrel-half-01"], 6, ["dirt"], gap=5.0),
    ],
}


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


def tiles_under(x, y, rot, footprint, grow=0.0):
    """The tiles a footprint covers: a tile is covered when its CENTRE is in it.

    WARNING: rounding both edges outwards makes a two-metre bench claim three
    tiles, and the guard then refuses it for standing on a road it does not
    reach. A guard wrong in the safe direction still costs you the map.
    """
    w, h = footprint
    if round(rot / 90) % 2 == 1:
        w, h = h, w
    w, h = w + 2 * grow, h + 2 * grow
    return {(tx, ty)
            for ty in range(math.ceil(y - h / 2), math.floor(y + h / 2) + 1)
            for tx in range(math.ceil(x - w / 2), math.floor(x + w / 2) + 1)}


def dress(area, layers, seed):
    rng = random.Random(seed)
    W, H = area["width"], area["height"]
    tiles, legend = area["tiles"], area["legend"]
    kind_at = [[legend[c]["kind"] for c in row] for row in tiles]
    walkable = {(x, y) for y in range(H) for x in range(W)
                if legend[tiles[y][x]]["walkable"]}

    # ------------------------------------------------------------ keep clear
    # Derived from the area's OWN data: the doors, the facilities, the things
    # worth harvesting, and where a round opens.
    keep = set()
    for t in area.get("transitions", []):
        for dy in range(-2, 3):
            for dx in range(-2, 3):
                keep.add((t["x"] + dx, t["y"] + dy))
    for s in (area.get("stations") or []):
        for dy in range(-2, 3):
            for dx in range(-2, 3):
                keep.add((s["x"] + dx, s["y"] + dy))
    for n in (area.get("nodes") or []):
        for dy in range(-1, 2):
            for dx in range(-1, 2):
                keep.add((n["x"] + dx, n["y"] + dy))
    for dy in range(-2, 3):
        for dx in range(-2, 3):
            keep.add((area["spawn"]["x"] + dx, area["spawn"]["y"] + dy))

    blocked = set()
    for a in area.get("assets", []):
        for v in a.get("collision", []):
            if v.get("walkable", False):
                continue
            sh = v["shape"]
            blocked |= tiles_under(a["x"] + sh.get("x", 0), a["y"] + sh.get("y", 0),
                                   a["rotation"], [sh["w"], sh["h"]], grow=BODY_RADIUS)
    solids = [(a["x"], a["y"]) for a in area.get("assets", []) if a.get("collision")]

    def strands(extra):
        """Would blocking `extra` cut anything off from the spawn?

        WARNING: an APPROXIMATION of the build's own flood, and deliberately a
        looser one — tile centres against grown rectangles, where the real
        check sweeps a body through a finer index. It catches pockets, which is
        the failure that matters. `validate:content` remains the authority and
        `tools/src/why-unreachable.ts` names what a pocket is made of.
        """
        gone = blocked | extra
        start = (area["spawn"]["x"], area["spawn"]["y"])
        if start in gone:
            return {start}
        seen, stack = {start}, [start]
        while stack:
            x, y = stack.pop()
            for n in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                if n in seen or n in gone or n not in walkable:
                    continue
                seen.add(n)
                stack.append(n)
        return (walkable - gone) - seen

    added = []
    refused = {"in the way": 0, "too close": 0, "would seal": 0, "nowhere to go": 0}

    for spec in layers:
        want = spec["count"]
        placed = 0
        for _ in range(want * 40):
            if placed >= want:
                break
            x = rng.uniform(1.5, W - 2.5)
            y = rng.uniform(1.5, H - 2.5)
            tx, ty = int(round(x)), int(round(y))
            if not (0 <= tx < W and 0 <= ty < H) or kind_at[ty][tx] not in spec["kinds"]:
                continue
            asset = rng.choice(spec["assets"])
            entry = CATALOGUE.get(f"{spec['pack']}/{asset}")
            if entry is None:
                raise SystemExit(f"no catalogue entry for {spec['pack']}/{asset}")
            # ⚠ QUARTER TURNS for anything solid. A collision rect rotates with
            # its asset, and a 2x2 box at 45 degrees sweeps a 2.8m diagonal into
            # a shape the navigation index struggles to leave a way past — lone
            # trees were penning lone tiles with nothing else near them (D-591).
            rot = rng.uniform(0, 360) if spec["walkthrough"] else rng.choice([0, 90, 180, 270])
            mask = [] if spec["walkthrough"] else default_mask(spec["pack"], asset)
            if mask:
                gap = spec["gap"]
                if any((x - px) ** 2 + (y - py) ** 2 < gap * gap for px, py in solids):
                    refused["too close"] += 1
                    continue
                covered = tiles_under(x, y, rot, entry.get("footprint", [1, 1]))
                if covered & keep:
                    refused["in the way"] += 1
                    continue
                grown = tiles_under(x, y, rot, entry.get("footprint", [1, 1]),
                                    grow=BODY_RADIUS)
                if strands(grown):
                    refused["would seal"] += 1
                    continue
                blocked |= grown
                solids.append((x, y))
            added.append({
                "asset": asset, "pack": spec["pack"],
                "x": round(x, 2), "y": round(y, 2), "z": 0.0,
                "rotation": float(rot),
                "scale": round(rng.uniform(*spec["scale"]), 3),
                "collision": mask,
                "overrideCollision": bool(spec["walkthrough"]),
            })
            placed += 1
        if placed < want:
            refused["nowhere to go"] += want - placed
    return added, refused


def main(argv):
    want = [a for a in argv if not a.startswith("-")] or sorted(RECIPES)
    for aid in want:
        layers = RECIPES.get(aid)
        if layers is None:
            print(f"  - {aid}: no recipe")
            continue
        path = os.path.join(AREAS, aid + ".json")
        area = json.load(io.open(path, encoding="utf8"))
        # ⚠ REPLACES what a previous run of this script put down, and keeps
        # everything else. An area dressed twice is an area with two of
        # everything, and the second run's guards would happily allow it.
        area["assets"] = [a for a in area.get("assets", []) if not a.get("dressed")]
        added, refused = dress(area, layers, seed=hash(aid) & 0xFFFF)
        for a in added:
            a["dressed"] = True
        area["assets"] = area["assets"] + added
        with io.open(path, "w", encoding="utf8", newline="\n") as f:
            f.write(json.dumps(area, indent=2, ensure_ascii=False) + "\n")
        solid = sum(1 for a in added if a["collision"])
        note = ", ".join(f"{v} {k}" for k, v in refused.items() if v)
        print(f"  {aid:<17} +{len(added):>4} ({solid} solid)"
              + (f"   refused: {note}" if note else ""))
    print("\nRun `npm run build:environment`, `npm run validate:content`, "
          "and `npx tsx tools/src/why-unreachable.ts <area>`.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
