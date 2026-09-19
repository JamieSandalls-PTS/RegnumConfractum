"""Every blocking TILE becomes a placed pack mesh with the same collision (D-638).

`npm run map:convert [-- <area-id> ...]`   (every area when none is named)

The tile grid used to be drawn: walls as grey blocks, trees as cones, rocks as
lumps, water as a flat blue. The stakeholder's ruling is that nothing
procedural is drawn any more -- the ground is painted and everything standing
on it is a pack mesh. The grid stays as the walkability lattice the server and
CI already speak (D-567), and after this runs every tile in it is walkable:
what blocks a body, and what blocks a line of sight, is a collision volume on
a placed asset, exactly as the taproom's walls have been since D-618.

WARNING: the COLLISION IS COPIED, the art is chosen. A run of wall tiles from
x0 to x1 was a volume x0-0.5..x1+0.5, three metres high, opaque; it becomes
that same volume, on the first mesh of the run. A rock tile was a unit volume
that blocked the body and not the eye; so is its mesh. Nothing about where a
body may stand or what a witness can see changes -- the sim suites that walk
these maps prove it, because they walk the same volumes.

WARNING: the ground KINDS survive. `paint-areas.py` reads grass/dirt/floor off
the legend to decide what to paint, so a blocked tile becomes the area's most
common walkable kind rather than a bare ".". Nothing draws a kind any more; the
painter is the only reader left, and it needs them.

WARNING: `validate:content` refuses any unwalkable tile after this (D-638), so
a re-run of `build-round-map.py` -- which still lays its mazes and borders as
tiles -- fails the build until this has been run again. That is the trap
D-590 documents, made visible instead of silent.
"""
import io, json, os, sys, glob, random

HERE = os.path.dirname(os.path.abspath(__file__))
AREAS = os.path.normpath(os.path.join(HERE, '..', '..', 'content', 'areas'))

# ----------------------------------------------------------------- the art

# A run of wall tiles is tiled end to end from pieces that sum to it exactly
# (walls-to-assets.py, D-567: 5/3/2/1 reach every whole number of metres).
WALL_MESHES = [
    (5.0, 'sm-env-wall-01-alt'),
    (3.0, 'sm-env-wall-half-01'),
    (2.0, 'sm-env-wall-broken-edge-01'),
    (1.0, 'sm-env-wall-end-01'),
]
WALL_PACK = 'dungeon-pack'
WALL_THICKNESS = 0.5
WALL_HEIGHT = 3.0

# What a run of blocking tiles is BUILT from, per area. A stone wall inside a
# crypt is a stone wall; the ring round a farm is a treeline, and round a
# quarry a rockfall. The collision is the run either way.
#
#   'wall'  -> the wall set above, tiled exactly
#   'trees' -> one tree per ~1.6m along the run, alternating and jittered
#   'rocks' -> one rock pile per ~4m along the run
RUN_STYLE = {
    # The taproom's walls are authored meshes with their own masks (D-618,
    # D-625); its border tiles only ever duplicated them. Nothing is placed.
    'hanged-ferryman': 'none',
    'round-farm': 'trees',
    'round-wood': 'trees',
    'round-mine': 'rocks',
    'round-south': 'rocks',
}
TREES = [('knights', 'sm-env-tree-01'), ('knights', 'sm-env-tree-02'), ('knights', 'sm-env-tree-03')]
ROCKPILES = [('knights', 'sm-env-rockpile-01'), ('knights', 'sm-env-rockpile-02'), ('knights', 'sm-env-rockpile-03')]

# Single tiles that are obstacles rather than walls.
ROCKS = [('vikings', 'sm-env-rock-01'), ('vikings', 'sm-env-rock-02'),
         ('vikings', 'sm-env-rock-03'), ('vikings', 'sm-env-rock-04')]
TREE_TILES = [('knights', 'sm-env-tree-01'), ('knights', 'sm-env-tree-02'),
              ('knights', 'sm-env-tree-03'), ('vikings', 'sm-env-tree-pine-01')]
# The knights pack's water tile is a flat 3x3 plane; scaled to a metre it is
# one tile of water. Blocks the body (you cannot wade) and not the eye.
WATER = ('knights', 'sm-env-tile-water-01', 1.0 / 3.0)



def fit(length):
    out = []
    left = round(length)
    for size, _ in WALL_MESHES:
        while left >= size:
            out.append(size)
            left -= size
    assert left == 0, 'cannot tile a run of %s' % length
    return out


# ------------------------------------------------------------- the lattice

def kinds(area):
    legend, tiles = area['legend'], area['tiles']
    return [[legend[tiles[y][x]] for x in range(area['width'])] for y in range(area['height'])]


def wall_runs(area, is_wall):
    """Maximal runs of wall tiles: horizontal first, then what is left."""
    w, h = area['width'], area['height']
    k = kinds(area)
    solid = [[is_wall(k[y][x]) for x in range(w)] for y in range(h)]
    used = [[False] * w for _ in range(h)]
    runs = []
    for y in range(h):
        x = 0
        while x < w:
            if not solid[y][x]:
                x += 1
                continue
            x0 = x
            while x < w and solid[y][x]:
                x += 1
            if x - x0 >= 2:
                for i in range(x0, x):
                    used[y][i] = True
                runs.append(('h', x0, x - 1, y))
    for x in range(w):
        y = 0
        while y < h:
            if not solid[y][x] or used[y][x]:
                y += 1
                continue
            y0 = y
            while y < h and solid[y][x] and not used[y][x]:
                y += 1
            for j in range(y0, y):
                used[j][x] = True
            runs.append(('v', y0, y - 1, x))
    for y in range(h):
        for x in range(w):
            if solid[y][x] and not used[y][x]:
                runs.append(('h', x, x, y))
    return runs


def placement(pack, asset, x, y, rotation=0, scale=1, collision=None):
    out = {
        'asset': asset, 'pack': pack,
        'x': round(x, 3), 'y': round(y, 3), 'z': 0,
        'rotation': rotation, 'scale': scale,
        'collision': collision or [],
        'overrideCollision': True,
        'fromTiles': True,
    }
    return out


def run_volume(length, first_offset, opaque):
    """ONE volume covering the whole run, in the first mesh's local frame."""
    return [{
        'shape': {'kind': 'rect', 'x': round(first_offset, 3), 'y': 0,
                  'w': round(length, 3), 'h': WALL_THICKNESS, 'rotation': 0},
        'base': 0, 'top': WALL_HEIGHT, 'walkable': False, 'opaque': opaque,
    }]


def run_assets(run, style, rng):
    axis, a, b, fixed = run
    length = (b - a) + 1.0
    start = a - 0.5
    run_centre = start + length / 2.0
    rot = 0 if axis == 'h' else 90
    at = lambda along: (along, fixed) if axis == 'h' else (fixed, along)
    out = []
    if style == 'wall':
        along = start
        for size in fit(length):
            centre = along + size / 2.0
            x, y = at(centre)
            out.append(placement(WALL_PACK, next(m for s, m in WALL_MESHES if s == size), x, y, rot))
            along += size
        first_centre = start + fit(length)[0] / 2.0
        out[0]['collision'] = run_volume(length, run_centre - first_centre, True)
        return out
    step = 1.6 if style == 'trees' else 4.0
    models = TREES if style == 'trees' else ROCKPILES
    n = max(1, int(round(length / step)))
    for i in range(n):
        centre = start + (i + 0.5) * (length / n)
        x, y = at(centre)
        pack, asset = models[(i + int(fixed)) % len(models)]
        jitter = (rng.random() - 0.5) * 0.6 if style == 'trees' else 0
        jx, jy = (0, jitter) if axis == 'h' else (jitter, 0)
        out.append(placement(pack, asset, x + jx, y + jy, rng.randrange(0, 360) if style == 'trees' else rot))
    # The volume rides on the first mesh. Its local frame is rotated by that
    # mesh's rotation, so the offset is expressed along the run in world
    # terms and the volume is un-rotated to world by its own `rotation`.
    first = out[0]
    first_rot = first['rotation']
    dx, dy = (run_centre - first['x'], 0) if axis == 'h' else (0, run_centre - first['y'])
    # In the mesh's local frame (world rotated by -first_rot about the mesh).
    import math
    r = math.radians(first_rot)
    lx = dx * math.cos(r) + dy * math.sin(r)
    ly = -dx * math.sin(r) + dy * math.cos(r)
    first['collision'] = [{
        'shape': {'kind': 'rect', 'x': round(lx, 3), 'y': round(ly, 3),
                  'w': round(length, 3), 'h': WALL_THICKNESS, 'rotation': (rot - first_rot) % 360},
        'base': 0, 'top': WALL_HEIGHT, 'walkable': False, 'opaque': True,
    }]
    return out


def unit_volume(opaque, rotation, top=3.0):
    """The tile's own unit square, whatever way the mesh on it faces.

    WARNING: counter-rotated. A volume is authored in the mesh's frame and
    turned by the placement's rotation (D-625), so a unit square on a tree
    turned 18 degrees leaned a fifth of a metre into the four cells around it
    -- and the flood found two hundred tiles a body could stand on and never
    reach. The tile was an axis-aligned square; so is this.
    """
    return [{'shape': {'kind': 'rect', 'x': 0, 'y': 0, 'w': 1, 'h': 1, 'rotation': (-rotation) % 360},
             'base': 0, 'top': top, 'walkable': False, 'opaque': opaque}]


def convert(path):
    area = json.load(io.open(path, encoding='utf-8'))
    aid = area['id']
    rng = random.Random(aid)
    k = kinds(area)
    w, h = area['width'], area['height']
    placed = []

    def is_wall(d):
        return (not d['walkable']) and d['kind'] not in ('rock', 'tree', 'water')

    style = RUN_STYLE.get(aid, 'wall')
    runs = wall_runs(area, is_wall)
    if style != 'none':
        for run in runs:
            placed.extend(run_assets(run, style, rng))

    for y in range(h):
        for x in range(w):
            d = k[y][x]
            if d['walkable']:
                continue
            if d['kind'] == 'rock':
                pack, asset = ROCKS[rng.randrange(len(ROCKS))]
                rot = rng.randrange(0, 360)
                placed.append(placement(pack, asset, x, y, rot, 1, unit_volume(False, rot)))
            elif d['kind'] == 'tree':
                pack, asset = TREE_TILES[rng.randrange(len(TREE_TILES))]
                rot = rng.randrange(0, 360)
                placed.append(placement(pack, asset, x, y, rot, 1, unit_volume(True, rot)))
            elif d['kind'] == 'water':
                pack, asset, scale = WATER
                # The volume is authored in the mesh's frame, which is scaled
                # by the placement (D-625): a metre in the world is three in it.
                vol = [{'shape': {'kind': 'rect', 'x': 0, 'y': 0, 'w': 3, 'h': 3, 'rotation': 0},
                        'base': 0, 'top': 3.0, 'walkable': False, 'opaque': False}]
                placed.append(placement(pack, asset, x, y, 0, scale, vol))

    # Every tile becomes the area's commonest walkable kind. The ground kinds
    # are the painter's; nothing else reads them now.
    counts = {}
    for row in k:
        for d in row:
            if d['walkable']:
                counts[d['kind']] = counts.get(d['kind'], 0) + 1
    ground_kind = max(counts, key=counts.get) if counts else 'floor'
    ground_ch = next((ch for ch, d in area['legend'].items() if d['walkable'] and d['kind'] == ground_kind), None)
    if ground_ch is None:
        ground_ch = '.'
        area['legend'][ground_ch] = {'walkable': True, 'kind': ground_kind}
    rows = []
    for y in range(h):
        row = ''
        for x in range(w):
            ch = area['tiles'][y][x]
            row += ch if area['legend'][ch]['walkable'] else ground_ch
        rows.append(row)
    area['tiles'] = rows
    area['legend'] = {ch: d for ch, d in area['legend'].items() if d['walkable']}

    # Anything this script placed before is replaced; a person's own placements
    # are kept.
    kept = [a for a in area.get('assets', []) if not a.get('fromTiles')]
    area['assets'] = placed + kept
    io.open(path, 'w', encoding='utf-8', newline='\n').write(json.dumps(area, indent=2, ensure_ascii=False) + '\n')
    return len(runs), len(placed)


if __name__ == '__main__':
    ids = sys.argv[1:]
    paths = [os.path.join(AREAS, i + '.json') for i in ids] if ids else sorted(glob.glob(os.path.join(AREAS, '*.json')))
    for p in paths:
        runs, n = convert(p)
        print('%-18s %4d run(s) -> %5d placed mesh(es)' % (os.path.basename(p)[:-5], runs, n))
