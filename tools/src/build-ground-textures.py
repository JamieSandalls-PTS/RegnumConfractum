"""Seamless ground textures, generated (D-585).

    python tools/src/build-ground-textures.py

WARNING: THESE ARE A STOPGAP, AND THEY SAY SO.

The eight ground materials shipped with no texture at all, which is honest --
a material paints as its tint until somebody draws it -- and looks exactly as
plain as it is. Waiting on downloaded art to find out whether the painter even
renders a texture is the wrong order: this gives every material a surface now,
proves the whole path end to end, and is replaced by better art the moment
better art exists. Nothing depends on these files except the materials that
name them.

Real art beats this. ambientCG and Poly Haven are both CC0 (verified against
their own licence pages: commercial use permitted, attribution not required).
Drop a colour map in `client/public/textures/ground/`, point the material's
`texture` at it, and this generator never needs to run again.

WARNING: every image is SEAMLESS, and that is not decoration. The painter
tiles a material across the world in world space, so a texture with edges
draws a grid of seams across the whole map -- the one flaw that reads as a
broken renderer rather than as plain art. Every generator below wraps: the
noise lattices wrap, the stone cells wrap, the plank joints wrap.
"""

import io
import json
import os
import sys

import numpy as np
from PIL import Image

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf8")

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "client", "public", "textures", "ground")
CONTENT = os.path.join(ROOT, "content", "ground")
SIZE = 512
rng = np.random.default_rng(7)  # fixed, so a re-run does not churn the art


def lattice(n: int) -> np.ndarray:
    """Value noise on an n x n lattice, upsampled to SIZE, wrapping at the edge."""
    grid = rng.random((n, n))
    # Coordinates in lattice space, wrapped -- this is what makes it seamless.
    t = np.linspace(0, n, SIZE, endpoint=False)
    i0 = np.floor(t).astype(int) % n
    i1 = (i0 + 1) % n
    f = (t - np.floor(t))[:, None]
    # Smoothstep, or the lattice shows as a diamond grid.
    f = f * f * (3 - 2 * f)
    rows = grid[i0] * (1 - f) + grid[i1] * f
    fx = f.T
    return rows[:, i0] * (1 - fx) + rows[:, i1] * fx


def fbm(octaves=(4, 8, 16, 32, 64, 128), gain=0.5) -> np.ndarray:
    """Fractal noise: a few lattices, each finer and fainter than the last."""
    out = np.zeros((SIZE, SIZE))
    amp, total = 1.0, 0.0
    for n in octaves:
        out += lattice(n) * amp
        total += amp
        amp *= gain
    out /= total
    return (out - out.min()) / max(1e-6, np.ptp(out))


def cells(count: int, jitter: float = 0.38):
    """Distance to the nearest of `count` x `count` jittered points, wrapping."""
    step = SIZE / count
    pts = []
    for cy in range(count):
        for cx in range(count):
            pts.append((
                (cx + 0.5 + rng.uniform(-jitter, jitter)) * step,
                (cy + 0.5 + rng.uniform(-jitter, jitter)) * step,
            ))
    ys, xs = np.mgrid[0:SIZE, 0:SIZE]
    nearest = np.full((SIZE, SIZE), 1e9)
    second = np.full((SIZE, SIZE), 1e9)
    for px, py in pts:
        # Wrapped distance: the shortest way round, so stones meet at the edge.
        dx = np.abs(xs - px)
        dy = np.abs(ys - py)
        dx = np.minimum(dx, SIZE - dx)
        dy = np.minimum(dy, SIZE - dy)
        d = np.hypot(dx, dy)
        second = np.minimum(second, np.maximum(nearest, d))
        nearest = np.minimum(nearest, d)
    return nearest, second


def punch(mono: np.ndarray, amount: float = 1.6) -> np.ndarray:
    """Push contrast away from the middle.

    WARNING: fractal noise averages towards grey, so a texture built straight
    out of it is mush -- detail that exists in the file and cannot be seen on
    the ground. This is the difference between "has variation" and "reads as
    a surface".
    """
    m = np.clip(mono, 0, 1)
    return np.clip(0.5 + (m - 0.5) * amount, 0, 1)


def tint(mono: np.ndarray, low: str, high: str) -> np.ndarray:
    """Map 0..1 to a colour ramp between two hex colours."""
    def rgb(h):
        h = h.lstrip("#")
        return np.array([int(h[i:i + 2], 16) for i in (0, 2, 4)], dtype=float)
    a, b = rgb(low), rgb(high)
    m = np.clip(mono, 0, 1)[..., None]
    return (a * (1 - m) + b * m).astype(np.uint8)


def save(name: str, arr: np.ndarray) -> None:
    Image.fromarray(arr, "RGB").save(os.path.join(OUT, name), optimize=True)
    print("  wrote", name)


def grass() -> np.ndarray:
    base = fbm((8, 16, 32, 64, 128, 256), 0.55)
    # Fine directional streaks read as blades at the scale a tile is drawn.
    streak = lattice(256)
    mono = np.clip(base * 0.72 + streak * 0.28, 0, 1)
    mono = mono ** 1.15
    mono = punch(mono, 1.7)
    return tint(mono, "#3f4a2c", "#8a9a5f")


def dirt() -> np.ndarray:
    base = fbm((4, 8, 16, 32, 64), 0.5)
    grit = lattice(256)
    mono = np.clip(base * 0.75 + grit * 0.25, 0, 1)
    mono = punch(mono, 1.6)
    return tint(mono, "#4a3d2c", "#9a8465")


def mud() -> np.ndarray:
    base = fbm((3, 6, 12, 24, 48), 0.55)
    # Smeared: stretch the noise so it reads as churned rather than as soil.
    smear = np.roll(base, 7, axis=1) * 0.5 + base * 0.5
    mono = np.clip(smear ** 1.4, 0, 1)
    mono = punch(mono, 1.6)
    return tint(mono, "#2f2820", "#6b5a45")


def sand() -> np.ndarray:
    base = fbm((8, 16, 32, 64, 128), 0.5)
    ripple = 0.5 + 0.5 * np.sin(np.linspace(0, 18 * np.pi, SIZE))[None, :]
    mono = np.clip(base * 0.78 + ripple * 0.22, 0, 1)
    mono = punch(mono, 1.55)
    return tint(mono, "#8f8055", "#d8c79a")


def cobble() -> np.ndarray:
    near, second = cells(11)
    edge = np.clip((second - near) / 9.0, 0, 1)      # mortar in the gaps
    stone = fbm((32, 64, 128), 0.5) * 0.35 + 0.65
    mono = np.clip(edge * stone, 0, 1)
    mono = punch(mono, 1.4)
    return tint(mono, "#413e3a", "#a29c92")


def flag() -> np.ndarray:
    """Cut slabs: offset rows with a joint between them."""
    mono = np.zeros((SIZE, SIZE))
    rows, cols = 6, 4
    rh = SIZE / rows
    for r in range(rows):
        offset = (r % 2) * (SIZE / cols / 2)
        for c in range(cols + 1):
            x0 = (c * SIZE / cols + offset) % SIZE
            y0 = r * rh
            ys, xs = np.mgrid[0:SIZE, 0:SIZE]
            dx = np.minimum(np.abs(xs - x0), SIZE - np.abs(xs - x0))
            inside = (dx < SIZE / cols / 2 - 3) & (np.abs(ys - (y0 + rh / 2)) < rh / 2 - 3)
            mono[inside] = 0.55 + rng.uniform(-0.12, 0.12)
    grain = fbm((32, 64, 128), 0.5)
    mono = np.clip(mono * 0.8 + grain * 0.3, 0, 1)
    mono = punch(mono, 1.5)
    return tint(mono, "#3a3833", "#9b958c")


def boards() -> np.ndarray:
    """Planks running one way, with grain along them and a gap between.

    WARNING: the plank widths are SCALED TO SUM TO THE IMAGE. The first version
    laid random widths until it ran off the edge, so the last plank was cut in
    half and the left and right edges did not match -- a seam measured at 28
    against an interior control of 8, which tiles into a stripe down the whole
    map. Every other generator here wraps by construction; this one has to be
    made to.
    """
    widths = []
    while sum(widths) < SIZE * 0.95:
        widths.append(rng.uniform(42, 70))
    scale = SIZE / sum(widths)
    widths = [w * scale for w in widths]

    mono = np.zeros((SIZE, SIZE))
    edges = []
    x = 0.0
    for w in widths:
        x0, x1 = int(round(x)), int(round(x + w))
        mono[:, x0:x1] = rng.uniform(0.42, 0.72)
        edges.append(x0)
        x += w
    # WARNING: every FILL is laid before any JOINT, and the joints straddle
    # their plank's left edge using modular columns. Two bugs live here and
    # both produce the same stripe down the map. Drawn inside its own plank, a
    # joint at x=0 has no counterpart at x=SIZE-1; drawn in the same pass as
    # the fills, the LAST plank's fill runs to SIZE and paints over the joint
    # the first one put at SIZE-1.
    for x0 in edges:
        for k in (-1, 0):
            mono[:, (x0 + k) % SIZE] = 0.12
    grain = lattice(256) * 0.22 + fbm((8, 16, 32), 0.5) * 0.18
    mono = np.clip(mono + grain - 0.12, 0, 1)
    mono = punch(mono, 1.6)
    return tint(mono, "#3a2c1e", "#9c7a52")


def stone() -> np.ndarray:
    near, second = cells(5, 0.45)
    crack = np.clip((second - near) / 16.0, 0, 1)
    rough = fbm((8, 16, 32, 64, 128), 0.55)
    mono = np.clip(crack * 0.55 + rough * 0.55, 0, 1)
    mono = punch(mono, 1.5)
    return tint(mono, "#3d3a37", "#918b84")


MAKERS = {
    "grass": grass, "dirt": dirt, "mud": mud, "sand": sand,
    "cobble": cobble, "flag": flag, "boards": boards, "stone": stone,
}

# WARNING: `repeat` is how many times the image fits across ONE METRE, and it
# decides the PHYSICAL SIZE of what is in it. At 1 the cobble image's eleven
# stones are nine centimetres across, which is not a cobble -- it is noise.
# These put each pattern at the size the thing actually is: a cobble about
# 25cm, a flagstone about half a metre, a floorboard about 20cm wide.
REPEAT = {
    "grass": 0.5, "dirt": 0.5, "mud": 0.4, "sand": 0.6,
    "cobble": 0.36, "flag": 0.22, "boards": 0.3, "stone": 0.28,
}


def main() -> int:
    os.makedirs(OUT, exist_ok=True)
    for mat_id, make in MAKERS.items():
        name = f"{mat_id}-01.png"
        path = os.path.join(CONTENT, f"{mat_id}.json")
        doc = json.load(io.open(path, encoding="utf8")) if os.path.exists(path) else None
        # WARNING: REAL ART WINS, and it is checked BEFORE the image is made.
        # This generator owns `<id>-01.png` and nothing else; a material
        # pointing at something else is one somebody ingested or drew.
        # Clobbering it would silently replace downloaded art with procedural
        # noise on a re-run -- still there, still valid, and worse. Checking
        # first also stops an unused image being written beside the real one.
        if doc is not None and doc.get("texture") and doc["texture"] != name:
            print(f"  kept   {mat_id}: already uses {doc['texture']}")
            continue
        save(name, make())
        if doc is None:
            print("   (no content/ground file for", mat_id, "— image written anyway)")
            continue
        doc["texture"] = name
        doc["repeat"] = REPEAT.get(mat_id, 1)
        # WARNING: the TINT stays. It multiplies the texture in both the brush
        # and the renderer, so it is what keeps eight generated greys reading
        # as grass, mud and stone rather than as eight shades of noise -- and
        # it is still the fallback if the image ever goes missing.
        with io.open(path, "w", encoding="utf8", newline="\n") as f:
            f.write(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")
    print("\nDone. `npm run validate:content` checks every material's file is on disk.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
