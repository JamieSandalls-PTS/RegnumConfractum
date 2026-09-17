"""Paint the ground of every area (D-590, extended by D-592).

    python tools/src/paint-areas.py [area-id ...]

Writes the splat masks (D-588) for each area and points the area at them.
Supersedes `paint-round-town.py`: Ashfold's recipe is one entry in the table
below, because a script per map is a rule per map, and the rules are the same.

WARNING: THE TILE GRID IS A GUIDE, NOT A STENCIL. The stakeholder was explicit
that this must not be tile-based -- "I need a brush that paints where I choose,
with smoothing/blending" -- and a mask rasterised straight off the grid is a
tile-based floor wearing a splat shader: every boundary a perfect axis-aligned
staircase at one-metre intervals.

So each boundary is BLURRED into a soft edge and then DOMAIN WARPED, sampled
through low-frequency noise that carries the finished gradient off the grid.
That order is the way round it is because the other way was tried and looked at
(D-590): warping a hard edge and blurring after only survives while the warp is
wider than the blur, and at 0.38m under a metre of blur every boundary came
back perfectly straight.

WARNING: the masks carry WEIGHTS, not colours, and ALPHA CARRIES NOTHING
(D-588): 255 where anything is painted, 0 where nothing is, because those are
the only two values a premultiplied canvas round-trips without loss.

WARNING: SIX materials per area, three to a mask, and the channel ORDER IS THE
DATA. Mask 0's red is `materials[0]`; mask 1's red is `materials[3]`.
Reordering a recipe without repainting swaps surfaces across a whole map.
"""

import io
import json
import math
import os
import sys

import numpy as np
from PIL import Image

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf8")

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
AREAS = os.path.join(ROOT, "content", "areas")
OUT = os.path.join(ROOT, "client", "public", "textures", "painted")

# WARNING: must match `SPLAT_PIXELS_PER_METRE` in client/src/render/ground-splat.ts.
PPM = 16
WEIGHTS_PER_MASK = 3
MASKS = 2
LIMIT = WEIGHTS_PER_MASK * MASKS

rng = np.random.default_rng(1149)  # fixed: a re-run must not churn the art

# ---------------------------------------------------------------- the recipes
#
# `kinds` maps a TILE KIND to a material. Everything else about a map's surface
# follows from that, which is why this is a table and not twelve scripts.
#
# `wear` is the half the grid cannot express: churned ground where people
# actually go. Generic wear (gates, doors, facilities, resource nodes, the
# spawn) is added for every area from the area's OWN data; `wear` here is for
# the few places somebody has to name.
#
# WARNING: at most SIX materials, and the first is the FALLBACK for any tile
# kind not named. A kind with no entry is not an error -- a wall's ground is
# never seen and painting it costs a channel.
RECIPES = {
    "round-town": {
        "materials": ["grass", "dirt", "cobble", "boards", "mud", "leafmould"],
        "kinds": {"grass": "grass", "dirt": "dirt", "water": "mud"},
        # The plaza and the four buildings are both `floor` and are not the same
        # surface: one is the square everybody crosses, the others are rooms.
        # Told apart by WHERE, since the legend cannot.
        "regions": [
            ("cobble", (16, 16, 34, 36)),          # the central square
            ("boards", (19, 12, 32, 18)),          # the tavern, across the road
        ],
        "region_default": "boards",                # the four working buildings
        "region_kinds": ["floor"],
        "wear": [(24.5, 34.5, 2.4), (25.0, 18.0, 1.7)],
        "under_trees": "leafmould",
        "patches": [("dirt", 0.10, 9.0)],
    },
    "round-farm": {
        "materials": ["grass", "dirt", "leafmould", "mud", "sand", "gravel"],
        "kinds": {"grass": "grass", "dirt": "dirt", "tree": "leafmould",
                  "rock": "gravel", "floor": "dirt", "water": "mud"},
        "under_trees": "leafmould",
        # Ploughed strips and the bare earth of a worked field.
        "patches": [("dirt", 0.22, 11.0), ("sand", 0.07, 7.0), ("mud", 0.05, 5.0)],
    },
    "round-wood": {
        # ⚠ GRASS is the base and `forest` is a patch, not the other way round.
        # The first cut put the ingested forest-floor photograph under the whole
        # map: its mean colour is (0.57, 0.53, 0.37), a dry olive-tan, so from
        # above the wood read as a sand flat with trees standing on it. A wood's
        # ground BETWEEN the trees is grass; bare needle floor is what you get
        # under a canopy, which is what a patch is for.
        "materials": ["grass", "forest", "leafmould", "dirt", "mud", "gravel"],
        "kinds": {"grass": "grass", "tree": "leafmould", "dirt": "dirt",
                  "rock": "gravel", "floor": "dirt", "water": "mud"},
        "under_trees": "leafmould",
        "patches": [("forest", 0.30, 9.0), ("leafmould", 0.22, 7.0),
                    ("mud", 0.05, 5.0)],
    },
    "round-mine": {
        "materials": ["dirt", "gravel", "stone", "mud", "sand", "grass"],
        "kinds": {"dirt": "dirt", "rock": "stone", "grass": "grass",
                  "floor": "gravel", "water": "mud"},
        # Spoil heaps and bare rock, over a worked-over floor.
        "patches": [("gravel", 0.30, 9.0), ("stone", 0.14, 6.0),
                    ("grass", 0.08, 12.0), ("mud", 0.06, 5.0)],
    },
    "round-south": {
        "materials": ["dirt", "grass", "gravel", "sand", "mud", "stone"],
        "kinds": {"dirt": "dirt", "grass": "grass", "rock": "stone",
                  "floor": "gravel", "water": "mud"},
        # Scrub: grass winning back a dry road in patches.
        "patches": [("grass", 0.30, 12.0), ("gravel", 0.14, 7.0),
                    ("sand", 0.10, 9.0), ("mud", 0.05, 5.0)],
    },
    "round-dungeon-1": {
        "materials": ["stone", "gravel", "mud", "sand", "dirt", "leafmould"],
        "kinds": {"dirt": "stone", "rock": "gravel", "floor": "stone",
                  "water": "mud"},
        # Rubble and the silt that collects where nothing drains.
        "patches": [("gravel", 0.26, 8.0), ("dirt", 0.14, 10.0),
                    ("mud", 0.08, 5.0), ("sand", 0.06, 6.0)],
    },
    "round-dungeon-2": {
        "materials": ["stone", "gravel", "mud", "dirt", "sand", "leafmould"],
        "kinds": {"dirt": "stone", "rock": "gravel", "floor": "stone",
                  "water": "mud"},
        # Deeper: wetter, and more of it fallen in.
        "patches": [("gravel", 0.30, 7.0), ("mud", 0.16, 6.0),
                    ("dirt", 0.10, 9.0)],
    },
    "round-dungeon-3": {
        "materials": ["stone", "gravel", "mud", "dirt", "sand", "leafmould"],
        "kinds": {"dirt": "stone", "rock": "gravel", "floor": "stone",
                  "water": "mud"},
        # The bottom floor: barely a floor at all.
        "patches": [("gravel", 0.34, 6.0), ("mud", 0.22, 5.0),
                    ("dirt", 0.12, 8.0)],
    },
    "hanged-ferryman": {
        # ⚠ An INTERIOR (D-604). This used to name grass, mud and leaf mould
        # as surfaces of a taproom, because the area used to be a plot with a
        # building on it -- and the result was a tavern with a lawn in it.
        # Boards underfoot, flags at the hearth, and nothing else.
        "materials": ["boards", "flag"],
        "kinds": {"wood": "boards", "table": "boards",
                  "chair": "boards", "hearth": "flag"},
        # A worn track through the middle of the room, which is the only
        # variation a board floor honestly has.
        "patches": [("flag", 0.10, 3.0)],
    },
    "broken-yard": {
        "materials": ["dirt", "gravel", "mud", "grass", "stone", "sand"],
        "kinds": {"floor": "dirt", "water": "mud", "grass": "grass"},
        # A yard gone to weeds and rubble — it is called the BROKEN yard.
        "patches": [("grass", 0.24, 7.0), ("gravel", 0.18, 5.0),
                    ("stone", 0.08, 4.0), ("mud", 0.07, 4.0)],
    },
    "sunken-crypt": {
        "materials": ["stone", "gravel", "mud", "dirt", "sand", "flag"],
        "kinds": {"floor": "stone", "water": "mud"},
        "patches": [("gravel", 0.24, 4.0), ("mud", 0.12, 3.0),
                    ("dirt", 0.10, 3.5)],
    },
    "proving-ground": {
        "materials": ["dirt", "gravel", "grass", "stone", "mud", "sand"],
        "kinds": {"dirt": "dirt", "floor": "gravel", "grass": "grass",
                  "rock": "stone", "water": "mud"},
        "patches": [("gravel", 0.20, 6.0), ("grass", 0.14, 5.0),
                    ("stone", 0.08, 4.0)],
    },
}


def lattice(n, h, w):
    """Value noise on an n x n lattice, smoothly upsampled to h by w."""
    grid = rng.random((n + 1, n + 1))
    ty = np.linspace(0, n, h, endpoint=False)
    tx = np.linspace(0, n, w, endpoint=False)
    iy, ix = np.floor(ty).astype(int), np.floor(tx).astype(int)
    fy, fx = ty - iy, tx - ix
    fy = (fy * fy * (3 - 2 * fy))[:, None]
    fx = (fx * fx * (3 - 2 * fx))[None, :]
    top = grid[iy][:, ix] * (1 - fx) + grid[iy][:, ix + 1] * fx
    bot = grid[iy + 1][:, ix] * (1 - fx) + grid[iy + 1][:, ix + 1] * fx
    return top * (1 - fy) + bot * fy


def fbm(h, w, octaves=(4, 8, 16, 32, 64), gain=0.55):
    out = np.zeros((h, w))
    amp, total = 1.0, 0.0
    for n in octaves:
        out += lattice(n, h, w) * amp
        total += amp
        amp *= gain
    out /= total
    return (out - out.min()) / max(1e-6, np.ptp(out))


def blur(a, sigma_px):
    """Separable box-blur approximation of a gaussian (three passes).

    WARNING: the cumulative sums are prepended with a ZERO row and column. A
    running sum of n values gives n partial sums and a box filter needs n+1 --
    without it the result comes back one pixel SHORTER on each pass, and three
    passes silently shrank an 800px mask to 797.
    """
    r = max(1, int(round(sigma_px)))
    k = 2 * r + 1
    out = a.astype(float)
    for _ in range(3):
        pad = np.pad(out, ((r, r), (0, 0)), mode="edge")
        c = np.concatenate([np.zeros((1, pad.shape[1])), np.cumsum(pad, axis=0)], axis=0)
        out = (c[k:] - c[:-k]) / k
        pad = np.pad(out, ((0, 0), (r, r)), mode="edge")
        c = np.concatenate([np.zeros((pad.shape[0], 1)), np.cumsum(pad, axis=1)], axis=1)
        out = (c[:, k:] - c[:, :-k]) / k
    return out


def make_warp(h, w):
    """ONE displacement field per area, shared by every material.

    WARNING: warping each material through its own noise moves neighbours
    independently and opens gaps along every boundary, which the normalisation
    then fills with whatever is nearby -- a thin wrong-coloured seam down the
    side of every road. They have to move together.
    """
    return (fbm(h, w, (4, 9, 19)) - 0.5, fbm(h, w, (4, 9, 19)) - 0.5)


def warp(field, warpfield, amplitude_m):
    h, w = field.shape
    amp = amplitude_m * PPM * 2
    ys, xs = np.mgrid[0:h, 0:w]
    sy = np.clip((ys + warpfield[0] * amp).round().astype(int), 0, h - 1)
    sx = np.clip((xs + warpfield[1] * amp).round().astype(int), 0, w - 1)
    return field[sy, sx]


def disc(h, w, cx, cy, radius_m, soft=0.55):
    """A soft round stamp in WORLD metres, centred on a tile centre.

    WARNING: the +0.5 is the tile-grid offset the painted plane is built with
    (`paintedPlane` centres the plane on the grid, not on the corner). Without
    it every stamp lands half a metre north-west of what it is marking.
    """
    y0 = max(0, int((cy + 0.5 - radius_m) * PPM))
    y1 = min(h, int(math.ceil((cy + 0.5 + radius_m) * PPM)))
    x0 = max(0, int((cx + 0.5 - radius_m) * PPM))
    x1 = min(w, int(math.ceil((cx + 0.5 + radius_m) * PPM)))
    out = np.zeros((h, w))
    if y1 <= y0 or x1 <= x0:
        return out
    ys, xs = np.mgrid[y0:y1, x0:x1]
    d = np.hypot(xs - (cx + 0.5) * PPM, ys - (cy + 0.5) * PPM)
    r = radius_m * PPM
    inner = r * (1 - soft)
    out[y0:y1, x0:x1] = np.where(d <= inner, 1.0,
                                 np.clip(1 - (d - inner) / max(1e-6, r - inner), 0, 1))
    return out


def paint(area):
    aid = area["id"]
    recipe = RECIPES.get(aid)
    if recipe is None:
        return None
    mats = recipe["materials"][:LIMIT]
    index = {m: i for i, m in enumerate(mats)}
    W, H = area["width"], area["height"]
    w, h = W * PPM, H * PPM
    tiles = area["tiles"]
    legend = area["legend"]

    kind = np.empty((H, W), dtype=object)
    for y in range(H):
        kind[y] = [legend[c]["kind"] for c in tiles[y]]

    fields = [np.zeros((h, w)) for _ in mats]

    def big(small):
        return np.repeat(np.repeat(small.astype(float), PPM, axis=0), PPM, axis=1)

    # ------------------------------------------------- surface from tile kind
    claimed = np.zeros((H, W), dtype=bool)
    for tile_kind, mat in recipe["kinds"].items():
        if mat not in index:
            raise SystemExit(f"{aid}: '{mat}' is not one of its six materials")
        sel = kind == tile_kind
        fields[index[mat]] += big(sel)
        claimed |= sel
    # Anything unnamed falls to the first material rather than to bare ground:
    # an unpainted patch in the middle of a map reads as a hole, not as honesty.
    fields[0] += big(~claimed)

    # ------------------------------------------------------- named regions
    for mat, (x0, y0, x1, y1) in recipe.get("regions", []):
        sel = np.zeros((H, W), dtype=bool)
        sel[y0:y1, x0:x1] = True
        sel &= np.isin(kind, recipe.get("region_kinds", []))
        for f in fields:
            f *= (1 - big(sel))
        fields[index[mat]] += big(sel)
    if recipe.get("region_default"):
        sel = np.isin(kind, recipe.get("region_kinds", []))
        for mat, (x0, y0, x1, y1) in recipe.get("regions", []):
            sel[y0:y1, x0:x1] = False
        for f in fields:
            f *= (1 - big(sel))
        fields[index[recipe["region_default"]]] += big(sel)

    warpfield = make_warp(h, w)
    for i in range(len(mats)):
        if fields[i].any():
            fields[i] = warp(blur(fields[i], 0.17 * PPM), warpfield, 0.75)

    # ---------------------------------------------------------- patches
    # ⚠ Several of these maps have ONE tile kind over their whole floor — the
    # crypt is 89 tiles of `floor`, the yard 744, the mine 9,388 of `dirt` —
    # so a recipe driven only by the legend paints them a single flat surface
    # and the painter has bought nothing. A patch is a second material thrown
    # across the first in blobs: not where the grid says, where nothing says.
    #
    # ⚠ The threshold is CHOSEN FROM THE NOISE, not guessed at. fbm is
    # normalised to 0..1 but is nowhere near uniform, so "> 0.7" is not 30%
    # cover — it was 8% on one map and 41% on another, and both looked like a
    # mistake rather than a choice. Taking the quantile makes the number on
    # the recipe mean what it says.
    for mat, cover, metres in recipe.get("patches", []):
        if mat not in index:
            raise SystemExit(f"{aid}: patch '{mat}' is not one of its six materials")
        n = max(2, int(round(max(W, H) / max(1.0, metres))))
        field = fbm(h, w, (n, n * 2, n * 4))
        cut = float(np.quantile(field, 1 - cover))
        sel = np.clip((field - cut) / max(1e-6, field.max() - cut), 0, 1)
        sel = warp(blur(sel, 0.25 * PPM), warpfield, 0.6)
        for f in fields:
            f *= (1 - sel)
        fields[index[mat]] += sel

    # ------------------------------------------------ leaf mould under trees
    if recipe.get("under_trees") and recipe["under_trees"] in index:
        near = big(kind == "tree")
        if near.any():
            near = blur(near, 0.9 * PPM) * 2.2
            near = np.clip(near, 0, 1) * np.clip(1.5 * fbm(h, w, (5, 11, 22)) - 0.18, 0, 1)
            fields[index[recipe["under_trees"]]] += warp(
                blur(np.clip(near * 1.5, 0, 1), 0.2 * PPM), warpfield, 0.5)

    # ------------------------------------------------------ where people go
    # ⚠ Derived from the area's OWN data, not typed per map: a door, a facility,
    # a node and the spawn are the places a cast actually stands, and they are
    # the half a tile grid cannot express. `mud` is the wear material when the
    # recipe has one.
    wear_mat = "mud" if "mud" in index else None
    if wear_mat:
        spots = [(t["x"], t["y"], 2.2) for t in area.get("transitions", [])]
        spots += [(s["x"], s["y"], 2.0) for s in (area.get("stations") or [])]
        spots += [(n["x"], n["y"], 1.4) for n in (area.get("nodes") or [])]
        spots.append((area["spawn"]["x"], area["spawn"]["y"], 2.0))
        spots += [(x, y, r) for x, y, r in recipe.get("wear", [])]
        wear = np.zeros((h, w))
        for cx, cy, r in spots:
            wear += disc(h, w, cx, cy, r)
        # ⚠ Broken HARD, not shaded. Noise that only varies the strength leaves
        # every stamp a complete disc, and a dozen identical circles read as a
        # dozen identical circles. Taking it down THROUGH zero cuts patches.
        wear = np.clip(wear, 0, 1) * np.clip(1.55 * fbm(h, w, (7, 14, 28)) - 0.28, 0, 1)
        fields[index[wear_mat]] += warp(
            blur(np.clip(wear * 1.6, 0, 1), 0.15 * PPM), warpfield, 0.4)

    # ------------------------------------------------------------- the weave
    # Only does anything at a BOUNDARY: where one material is alone the
    # normalisation puts it straight back to 1.
    grain = 0.75 + 0.4 * fbm(h, w, (3, 6, 12, 24))
    for i in range(len(mats)):
        fields[i] = fields[i] * grain

    stack = np.stack(fields)
    total = stack.sum(axis=0)
    painted = total > 1e-4
    stack = np.where(painted, stack / np.maximum(total, 1e-6), 0.0)

    saved = []
    # ⚠ As many masks as the MATERIALS need, not always two. Three weights
    # fit in a mask, so six materials want two and two want one -- and a map
    # that ships an empty second mask is refused by the build, which checks the
    # count against the material list. It only surfaced when an area was
    # repainted with a shorter recipe (D-604): every map until then used all
    # six, so `range(MASKS)` was right by coincidence.
    needed = max(1, -(-len(mats) // WEIGHTS_PER_MASK))
    for m in range(needed):
        img = np.zeros((h, w, 4), dtype=np.uint8)
        for c in range(WEIGHTS_PER_MASK):
            i = m * WEIGHTS_PER_MASK + c
            if i < len(stack):
                img[:, :, c] = np.clip(stack[i] * 255, 0, 255).astype(np.uint8)
        any_weight = img[:, :, 0].astype(int) + img[:, :, 1] + img[:, :, 2] > 0
        # ⚠ 0 or 255 and nothing between (D-588).
        img[:, :, 3] = np.where(any_weight, 255, 0)
        name = f"{aid}-{m}.png"
        Image.fromarray(img, "RGBA").save(os.path.join(OUT, name), optimize=True)
        saved.append(name)

    area["groundPaint"] = saved
    area["groundMaterials"] = mats
    kb = sum(os.path.getsize(os.path.join(OUT, n)) for n in saved) // 1024
    shares = "  ".join(f"{m} {stack[i].mean() * 100:.0f}%" for i, m in enumerate(mats)
                       if stack[i].mean() > 0.005)
    return f"{aid:<17} {W}x{H}  {kb:>5} KB   {shares}"


def main(argv):
    os.makedirs(OUT, exist_ok=True)
    want = set(argv) or set(RECIPES)
    for aid in sorted(want):
        path = os.path.join(AREAS, aid + ".json")
        if not os.path.exists(path):
            print(f"  ? {aid}: no such area")
            continue
        area = json.load(io.open(path, encoding="utf8"))
        line = paint(area)
        if line is None:
            print(f"  - {aid}: no recipe, left unpainted")
            continue
        with io.open(path, "w", encoding="utf8", newline="\n") as f:
            f.write(json.dumps(area, indent=2, ensure_ascii=False) + "\n")
        print("  " + line)
    print("\nRun `npm run validate:content`.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
