"""Take the machine-placed scenery back out of the maps (D-582).

    python tools/src/strip-procedural.py [--dry-run]

Every authored area was dressed by `walls-to-assets.py`, which converted runs
of wall TILES into rows of pack meshes. That was a mechanical conversion, not a
design: it used one pack for everything, so the farm, the wood and the tavern
are all built out of dungeon masonry, and the tool's own docstring says "a
person tidying a map by hand in the editor is the eventual answer".

This is the other half of that sentence. It clears what the machine placed so a
person can design on clean ground.

WARNING What it clears, and why each one:

  * `assets`  -- every placement. All 6,142 came from the conversion; not one
                 was put there by a person.
  * `roofs`   -- painted footprints, generated alongside the walls. A roof is
                 presentation that lifts when you walk under it (D-545), so a
                 roof left standing over removed walls is a lid hanging in the
                 air above bare ground.

WARNING What it does NOT touch, and why:

  * `proving-ground` -- ENTIRELY. It is the one map built by hand as a
                 collision fixture, and `mr6-proving-ground.test.ts` walks an
                 actor through it: the only test that covers the joins between
                 the model, the index, the server, the wire and the client.
                 Clearing it would delete the test that catches exactly the
                 class of bug map-building produces.
  * tiles, legend, spawn, stations, nodes, transitions, zone, outdoor, live --
                 the map's SKELETON. Where the doors are and what the area IS
                 were decisions; only the scenery was machine-placed.

Re-runnable, and it only rewrites a file it actually changes.
"""

import io
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
AREAS = os.path.join(ROOT, "content", "areas")

# WARNING Named rather than detected. "Which maps are hand-built fixtures" is a
# decision, and a rule that inferred it (say, from `live`) would quietly strip
# the next fixture somebody adds.
KEEP_WHOLE = {"proving-ground"}


def main() -> int:
    dry = "--dry-run" in sys.argv
    total_assets = 0
    total_roofs = 0
    touched = 0

    for name in sorted(os.listdir(AREAS)):
        if not name.endswith(".json"):
            continue
        path = os.path.join(AREAS, name)
        with io.open(path, encoding="utf-8") as f:
            raw = f.read()
        doc = json.loads(raw)

        if doc["id"] in KEEP_WHOLE:
            print("  kept whole   %-18s (hand-built fixture)" % doc["id"])
            continue

        n_assets = len(doc.get("assets", []))
        n_roofs = len(doc.get("roofs", []))
        if n_assets == 0 and n_roofs == 0:
            print("  already bare %-18s" % doc["id"])
            continue

        doc["assets"] = []
        doc["roofs"] = []
        total_assets += n_assets
        total_roofs += n_roofs
        touched += 1
        print(
            "  stripped     %-18s %5d asset(s), %4d roof tile(s)"
            % (doc["id"], n_assets, n_roofs)
        )
        if not dry:
            with io.open(path, "w", encoding="utf-8", newline="\n") as f:
                f.write(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")

    verb = "would clear" if dry else "cleared"
    print(
        "\n%s %d asset(s) and %d roof tile(s) from %d area(s)."
        % (verb, total_assets, total_roofs, touched)
    )
    if not dry:
        print("Run `npm run validate:content` -- an empty map still has to be walkable.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
