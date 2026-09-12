"""Rebuild an area's walls out of pack meshes (D-567).

`npm run rebuild:walls -- <area-id> [...]`

Every authored area is still a tile grid whose walls are drawn by the terrain
renderer -- grey blocks a metre thick, on the old lattice. This converts them:
each run of wall tiles becomes a row of pack wall meshes with ONE collision
volume covering the run exactly, and the tiles underneath become floor.

WARNING: the art and the collision are deliberately NOT the same shape. A wall
mesh is five metres long and a run is rarely a multiple of five, so the meshes
overlap each other and overhang the ends by up to two metres, while the mask
covers the run and nothing more. Sizing the mask to the art instead would
block open floor at every corner; stretching the art to the mask would smear
its texture. The overhang is visible and harmless, and a person tidying a map
by hand in the editor is the eventual answer.
"""
import io, json, sys, os

PACK = 'dungeon-pack'

# The pack's wall meshes by LENGTH in metres.
#
# WARNING: this is why the maps looked smeared. The first pass used one 5m mesh
# for every run and spaced `round(length / 5)` of them evenly, so a 12m wall
# became three meshes stretched to 4m apart -- overlapping each other and
# overhanging both ends by a metre. Nothing was wrong with the collision; the
# ART was approximate, and every wall in the world read as a blur.
#
# Tiling a run EXACTLY needs pieces that sum to it, and the pack ships 5, 3, 2
# and 1. Any whole number of metres is reachable from those, so no run needs an
# overlap or a gap ever again.
WALL_MESHES = [
    (5.0, 'sm-env-wall-01-alt'),
    (3.0, 'sm-env-wall-half-01'),
    (2.0, 'sm-env-wall-broken-edge-01'),
    (1.0, 'sm-env-wall-end-01'),
]
WALL_IDS = {mesh for _, mesh in WALL_MESHES}
THICKNESS = 0.5
HEIGHT = 3.0


def fit(length):
    """Segment lengths that sum EXACTLY to `length`, longest pieces first.

    Greedy is safe here only because the pack happens to ship a 1m piece --
    with 5/3/2 alone, a run of 4 would strand a remainder of 1 and the wall
    would come up short. Asserted rather than assumed.
    """
    out = []
    left = round(length)
    for size, _ in WALL_MESHES:
        while left >= size:
            out.append(size)
            left -= size
    assert left == 0, 'cannot tile a run of %s from %s' % (length, WALL_MESHES)
    return out


def wall_runs(area):
    """Maximal runs of unwalkable tiles: horizontal first, then what is left."""
    w, h = area['width'], area['height']
    legend, tiles = area['legend'], area['tiles']
    solid = [[not legend[tiles[y][x]]['walkable'] for x in range(w)] for y in range(h)]
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

    # Anything left is a single tile nothing claimed: a pillar.
    for y in range(h):
        for x in range(w):
            if solid[y][x] and not used[y][x]:
                runs.append(('h', x, x, y))
    return runs


def assets_for(run):
    """A run tiled end to end, plus ONE volume covering the whole of it.

    WARNING: the volume rides on the first segment and is offset in that
    segment's own local frame -- no mesh is moved to carry it. An earlier
    version dragged segment zero to the centre of the run and un-rotated it,
    which left a five-metre hole at one end of every wall and drew a stray
    east-west slab across the middle of every north-south corridor. The
    collision was right the whole time, so what a player saw was a wall they
    walked straight through.
    """
    axis, a, b, fixed = run
    length = (b - a) + 1.0
    start = a - 0.5                      # the run's near edge, not its first centre
    sizes = fit(length)
    by_size = dict((size, mesh) for size, mesh in WALL_MESHES)

    out = []
    along = start
    for size in sizes:
        centre = along + size / 2.0
        x, y = (centre, fixed) if axis == 'h' else (fixed, centre)
        out.append({
            'asset': by_size[size], 'pack': PACK,
            'x': round(x, 3), 'y': round(y, 3), 'z': 0,
            'rotation': 0 if axis == 'h' else 90,
            'scale': 1,
            'collision': [],
            'overrideCollision': True,
        })
        along += size

    # A mask is authored in the asset's own frame, and a rotated asset's local
    # +x runs along the wall either way -- so the volume is `length` by
    # `THICKNESS` in local axes for both orientations, offset along local x by
    # however far the first segment sits from the run's centre.
    first_centre = start + sizes[0] / 2.0
    run_centre = start + length / 2.0
    out[0]['collision'] = [{
        'shape': {'kind': 'rect', 'x': round(run_centre - first_centre, 3), 'y': 0,
                  'w': round(length, 3), 'h': THICKNESS, 'rotation': 0},
        'base': 0, 'top': HEIGHT, 'walkable': False, 'opaque': True,
    }]
    return out


def rebuild(path, source=None):
    """Convert `path`, optionally reading the wall grid from `source` instead.

    WARNING: running this twice on the same area used to ERASE it. The second
    run found no wall tiles (the first had flattened them), generated nothing,
    and then dropped every wall asset already there on the way to replacing
    them -- so a map went from walled to completely open and validated
    perfectly, because open ground is legal. It refuses now.

    `source` exists because that is exactly what happened: the only copy of a
    map's wall grid can end up somewhere else, and converting from it is better
    than re-drawing the map by hand.
    """
    area = json.load(io.open(path, encoding='utf-8'))
    grid = json.load(io.open(source, encoding='utf-8')) if source else area
    runs = wall_runs(grid)
    if not runs:
        already = [a for a in area.get('assets', [])
                   if a['pack'] == PACK and a['asset'] in WALL_IDS]
        if already:
            raise SystemExit(
                '%s is already converted (%d wall meshes, no wall tiles left). '
                'Re-running would delete them.' % (path, len(already)))
    placed = []
    for run in runs:
        placed.extend(assets_for(run))
    area['width'] = grid['width']
    area['height'] = grid['height']

    # The tiles become floor: the pack meshes carry the walls now, and leaving
    # both would draw a grey block inside every stone wall.
    floor = next((ch for ch, d in area['legend'].items() if d['walkable']), None)
    if floor is None:
        floor = '.'
        area['legend'][floor] = {'walkable': True, 'kind': 'dirt'}
    area['tiles'] = [floor * area['width'] for _ in range(area['height'])]
    area['legend'] = {floor: area['legend'][floor]}
    area['assets'] = placed + [a for a in area.get('assets', [])
                               if a['pack'] != PACK or a['asset'] not in WALL_IDS]
    io.open(path, 'w', encoding='utf-8', newline='').write(json.dumps(area, indent=2) + '\n')
    return len(runs), len(placed)


if __name__ == '__main__':
    args = sys.argv[1:]
    source = None
    if '--from' in args:
        i = args.index('--from')
        source = args[i + 1]
        args = args[:i] + args[i + 2:]
    if not args:
        raise SystemExit('usage: walls-to-assets.py [--from <file>] <area-id> [...]')
    for area_id in args:
        p = os.path.join('content', 'areas', area_id + '.json')
        runs, n = rebuild(p, source)
        print('  %-22s %3d wall runs -> %d meshes' % (area_id, runs, n))
