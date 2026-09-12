"""Turn downloaded texture bundles into ground materials (D-585).

    python tools/src/ingest-ground-textures.py

Takes Poly Haven / ambientCG style archives, pulls the COLOUR map out of each,
sizes it for the game, and writes a ground material pointing at it.

WARNING: THE ARCHIVES MUST NOT LIVE UNDER `client/public/`. Everything in that
folder is served by the dev server and shipped by the build, so eight 4K
`.blend.zip` bundles there is 700 MB of Blender scene files handed to every
player who opens the game. They are MOVED, never deleted -- into
`assets/incoming/ground/`, which is gitignored like every other art source.

WARNING: only the `_diff_` (albedo) map is taken. The bundles also carry
roughness, normal and displacement; this renderer lights the ground with a flat
`MeshStandardMaterial` and reads none of them, so importing them would ship
tens of megabytes nothing samples.

WARNING: 4K is downsized to 1024. The ground is painted into an image at 32
pixels per metre (see `PAINT_PIXELS_PER_METRE`) and a material tiles every two
or three metres, so a 4096px source is resampled down by a factor of forty
before anybody sees it -- the detail is thrown away either way, and a 4K JPEG
is 8 MB against 300 KB.
"""

import io
import json
import os
import shutil
import sys
import zipfile

from PIL import Image

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf8")

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SERVED = os.path.join(ROOT, "client", "public", "textures", "ground")
KEEP = os.path.join(ROOT, "assets", "incoming", "ground")
CONTENT = os.path.join(ROOT, "content", "ground")
TARGET_PX = 1024

# What each download IS, and how big its features are in the world.
#
# WARNING: `repeat` is how many times the image fits across ONE METRE, and it
# is the difference between gravel and noise. A 4K photograph of gravel covers
# perhaps two metres of real ground, so 0.5 -- not 1, which would shrink every
# stone to a speck.
KNOWN = {
    "brown_mud_02": ("mud", "Mud", "#5a4c3c", 0.45,
                     "Churned and wet. Where a lot of feet have been."),
    "brown_mud_leaves_01": ("leafmould", "Leaf mould", "#6a5a42", 0.45,
                            "Wet ground under trees, half made of last year's leaves."),
    "dense_sand": ("sand", "Sand", "#b3a375", 0.5,
                   "Loose ground: a riverbank, a cellar spill."),
    "forrest_ground_01": ("forest", "Forest floor", "#6b7a55", 0.4,
                          "Needles, roots and moss. The wood's own ground."),
    "gravel_stones": ("gravel", "Gravel", "#8a8880", 0.5,
                      "Loose stones. A yard, a track, the edge of a road."),
    "rocks_ground_01": ("stone", "Bare stone", "#6e6a66", 0.35,
                        "Rock floor, cut or natural. The dungeon's ground."),
    "snow_01": ("snow", "Snow", "#c9d0d6", 0.5, "Fresh snow, unbroken."),
    "snow_02": ("snow-trodden", "Trodden snow", "#aab3bb", 0.5,
                "Snow somebody has already walked through."),
}


def seam(img: Image.Image) -> tuple[float, float, float]:
    """Mean edge difference across the wrap, and an interior control."""
    import numpy as np
    a = np.asarray(img.convert("RGB"), dtype=float)
    h = float(abs(a[:, -1] - a[:, 0]).mean())
    v = float(abs(a[-1, :] - a[0, :]).mean())
    mid = a.shape[1] // 2
    control = float(abs(a[:, mid] - a[:, mid // 2]).mean())
    return h, v, control


def main() -> int:
    os.makedirs(KEEP, exist_ok=True)
    zips = sorted(f for f in os.listdir(SERVED) if f.endswith(".zip"))
    if not zips:
        print("no archives in", SERVED)
        return 0

    for name in zips:
        src = os.path.join(SERVED, name)
        stem = name.split("_4k")[0].split(".blend")[0]
        known = KNOWN.get(stem)
        if not known:
            print(f"  ? {name}: not in the KNOWN table — moved aside, nothing written")
            shutil.move(src, os.path.join(KEEP, name))
            continue
        mat_id, label, tint, repeat, notes = known

        with zipfile.ZipFile(src) as z:
            diff = next((n for n in z.namelist() if "_diff_" in n), None)
            if not diff:
                print(f"  ! {name}: no colour map inside — moved aside")
                shutil.move(src, os.path.join(KEEP, name))
                continue
            with z.open(diff) as f:
                img = Image.open(io.BytesIO(f.read())).convert("RGB")

        if img.width > TARGET_PX:
            img = img.resize((TARGET_PX, TARGET_PX), Image.LANCZOS)
        out_name = f"{mat_id}.jpg"
        img.save(os.path.join(SERVED, out_name), quality=88, optimize=True)

        h, v, control = seam(img)
        verdict = "seamless" if h < control * 0.75 and v < control * 0.75 else "⚠ SEAM"
        kb = os.path.getsize(os.path.join(SERVED, out_name)) // 1024

        doc = {
            "id": mat_id, "name": label, "texture": out_name,
            "repeat": repeat, "tint": tint, "walkable": True, "notes": notes,
        }
        with io.open(os.path.join(CONTENT, f"{mat_id}.json"), "w",
                     encoding="utf8", newline="\n") as f:
            f.write(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")

        shutil.move(src, os.path.join(KEEP, name))
        print(f"  {mat_id:<14} {out_name:<18} {kb:>5} KB  1 image per "
              f"{1 / repeat:.1f}m  {verdict}")

    print(f"\nArchives moved to assets/incoming/ground/ — out of the served folder.")
    print("Run `npm run validate:content`.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
