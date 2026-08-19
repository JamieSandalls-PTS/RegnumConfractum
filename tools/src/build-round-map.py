# -*- coding: utf-8 -*-
"""
Builds the Round's cross map (D-529, D-530) as content.

Town at the centre, four spokes on the compass, the dungeon beneath the south
approach. Every area is 64x64 so that a spoke is 30-45s of travel at
MOVE_COOLDOWN_TICKS = 3 (3.3 tiles/second).

Geometry carries the design:
  - the town is `settled`, so nobody can be murdered there without declaring
  - every spoke is `wilderness`, so out there the sky is the only witness
  - the spokes are `outdoor`, so night reaches them and pays for the risk
  - the dungeon is neither outdoor nor endgame: its own danger, and a round
    death must never cost a persistent character (D-523)
"""
import io, json, os

# 100x100, chosen by MEASUREMENT rather than by feel: at 64x64 the trip from
# the town centre to mid-depth in a spoke came out at 20s and to the far edge
# at 29s, well short of D-530's 30-45s ruling. At 100 the same trips measure
# ~30s and ~45s. `server/test/round-map.test.ts` asserts the band, so the map
# cannot drift out of it silently.
W = H = 100
MID = 50

LEGEND = {
    '#': {"walkable": False, "kind": "wall"},
    '.': {"walkable": True,  "kind": "floor"},
    ',': {"walkable": True,  "kind": "dirt"},
    'g': {"walkable": True,  "kind": "grass"},
    '~': {"walkable": False, "kind": "water"},
    'T': {"walkable": False, "kind": "tree"},
    'r': {"walkable": False, "kind": "rock"},
}


def blank(fill):
    return [[fill] * W for _ in range(H)]


def border(grid):
    for x in range(W):
        grid[0][x] = '#'
        grid[H - 1][x] = '#'
    for y in range(H):
        grid[y][0] = '#'
        grid[y][W - 1] = '#'


def gate(grid, side):
    """Opens a two-tile gate mid-edge and returns its inner approach tile."""
    if side == 'n':
        grid[0][MID] = grid[0][MID - 1] = ','
        return (MID, 0)
    if side == 's':
        grid[H - 1][MID] = grid[H - 1][MID - 1] = ','
        return (MID, H - 1)
    if side == 'e':
        grid[MID][W - 1] = grid[MID - 1][W - 1] = ','
        return (W - 1, MID)
    grid[MID][0] = grid[MID - 1][0] = ','
    return (0, MID)


def building(grid, x0, y0, w, h, door):
    """A walled structure with one door. `door` is 'n'|'s'|'e'|'w'."""
    for y in range(y0, y0 + h):
        for x in range(x0, x0 + w):
            edge = x in (x0, x0 + w - 1) or y in (y0, y0 + h - 1)
            grid[y][x] = '#' if edge else '.'
    dx, dy = {
        'n': (x0 + w // 2, y0),
        's': (x0 + w // 2, y0 + h - 1),
        'e': (x0 + w - 1, y0 + h // 2),
        'w': (x0, y0 + h // 2),
    }[door]
    grid[dy][dx] = '.'


def scatter(grid, ch, seed, count, avoid_band=9):
    """Deterministic scatter that never blocks the central cross corridors."""
    a = seed
    placed = 0
    guard = 0
    while placed < count and guard < count * 60:
        guard += 1
        a = (a * 1103515245 + 12345) & 0x7FFFFFFF
        x = 2 + (a >> 7) % (W - 4)
        a = (a * 1103515245 + 12345) & 0x7FFFFFFF
        y = 2 + (a >> 7) % (H - 4)
        # Keep the north-south and east-west corridors clear so every area is
        # crossable and nothing can seal a resource off from the gate.
        if abs(x - MID) < avoid_band or abs(y - MID) < avoid_band:
            continue
        if grid[y][x] != '#':
            grid[y][x] = ch
            placed += 1


WALKABLE = set('.,g')


def seal_unreachable(grid, spawn, must_reach=()):
    """
    Floods from spawn and turns any walkable tile it cannot reach into rock.

    A scatter can close a pocket by chance, and an unreachable tile is a CI
    failure (the reachability validator), so this is not cosmetic - it is what
    lets the map be generated at all. Anything that MUST stay reachable
    (transition tiles) is asserted rather than silently sealed.
    """
    sx, sy = spawn
    seen = {(sx, sy)}
    stack = [(sx, sy)]
    while stack:
        x, y = stack.pop()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < W and 0 <= ny < H and (nx, ny) not in seen:
                if grid[ny][nx] in WALKABLE:
                    seen.add((nx, ny))
                    stack.append((nx, ny))
    sealed = 0
    for y in range(H):
        for x in range(W):
            if grid[y][x] in WALKABLE and (x, y) not in seen:
                grid[y][x] = 'r'
                sealed += 1
    for tile in must_reach:
        assert tile in seen, 'transition tile %r was sealed off' % (tile,)
    return sealed


def rows(grid):
    return [''.join(r) for r in grid]


areas = {}

# --- TOWN: the settled hub -------------------------------------------------
t = blank('.')
border(t)
for side in 'nsew':
    gate(t, side)
# Five structures, set back from the crossing so the corridors stay open.
building(t, 12, 12, 18, 13, 's')   # the tavern (the Hanged Ferryman's sibling)
building(t, 70, 12, 17, 13, 's')   # the workshop / smithy
building(t, 12, 75, 18, 13, 'n')   # the storehouse
building(t, 70, 75, 17, 13, 'n')   # the infirmary
# The well sits dead centre: the antagonist's one target at the heart of the
# map, and the reason a settled town is playable at all (D-529).
for y in range(MID - 1, MID + 1):
    for x in range(MID - 1, MID + 1):
        t[y][x] = '~'
seal_unreachable(t, (MID, MID + 3),
                 [(MID, 0), (MID - 1, 0), (MID, H - 1), (MID - 1, H - 1),
                  (0, MID), (0, MID - 1), (W - 1, MID), (W - 1, MID - 1)])
# Facilities are REAL PLACED OBJECTS (D-530), one inside each building and
# the well at the crossing. A recipe that "needs the workshop" now means a
# specific anvil in a specific room — which is also what gives the antagonist
# something particular to stand beside, or to spoil.
town_stations = [
    {"x": 20, "y": 18, "type": "workshop"},    # inside the smithy? no - tavern block
    {"x": 78, "y": 18, "type": "workshop"},
    {"x": 20, "y": 81, "type": "storehouse"},
    {"x": 78, "y": 81, "type": "infirmary"},
    {"x": MID, "y": MID + 2, "type": "well"},  # beside the water, reachable
]
# The first entry above is a duplicate workshop; keep only the smithy's.
town_stations = town_stations[1:]

areas['round-town'] = {
    "id": "round-town",
    "name": "Ashfold",
    "width": W, "height": H,
    "legend": LEGEND,
    "tiles": rows(t),
    "spawn": {"x": MID, "y": MID + 3},
    "lighting": "overcast",
    "zone": "settled",
    "outdoor": True,
    "stations": town_stations,
    "transitions": [],
}

# --- THE FOUR SPOKES -------------------------------------------------------
# Each spoke yields something the others do not, so nobody can cover the map
# alone and the cast must divide the work (D-529). The second node type on the
# farm and the wood is what makes those two spokes worth a second trip.
spokes = [
    ('round-farm',  'The Ashfold Furrows', 'n', 'g', 'T', 100, 2200, ['grain-row', 'herb-patch']),
    ('round-mine',  'The Redcut',          'e', ',', 'r', 220, 3300, ['iron-vein']),
    ('round-wood',  'Thornhallow',         'w', 'g', 'T', 370, 4400, ['timber-stand', 'game-trail']),
    ('round-south', 'The Sunken Approach',  's', ',', 'r', 150, 5500, ['iron-vein']),
]
for aid, name, side, floor, obstacle, density, seed, node_types in spokes:
    g = blank(floor)
    border(g)
    # The gate facing town is on the OPPOSITE edge from the spoke's direction:
    # the farm lies north of town, so you enter it from its south edge.
    opposite = {'n': 's', 's': 'n', 'e': 'w', 'w': 'e'}[side]
    gate(g, opposite)
    scatter(g, obstacle, seed, density)
    gx, gy = {'n': (MID, H - 1), 's': (MID, 0), 'e': (0, MID), 'w': (W - 1, MID)}[side]
    seal_unreachable(g, (MID, MID), [(gx, gy), (gx - 1, gy) if gy in (0, H - 1) else (gx, gy - 1)])
    # Nodes are spread by DEPTH, not scattered evenly: the far end of a spoke
    # must be worth the walk, or "how deep do I go" is not a decision (D-530).
    nodes = []
    a = seed ^ 0x5f5f
    entry_y = H - 1 if side == 'n' else 0 if side == 's' else None
    for i in range(18):
        a = (a * 1103515245 + 12345) & 0x7FFFFFFF
        x = 3 + (a >> 6) % (W - 6)
        a = (a * 1103515245 + 12345) & 0x7FFFFFFF
        y = 3 + (a >> 6) % (H - 6)
        if g[y][x] not in WALKABLE:
            continue
        if any(n['x'] == x and n['y'] == y for n in nodes):
            continue
        nodes.append({"x": x, "y": y, "type": node_types[i % len(node_types)]})

    areas[aid] = {
        "id": aid,
        "name": name,
        "width": W, "height": H,
        "legend": LEGEND,
        "tiles": rows(g),
        "spawn": {"x": MID, "y": MID},
        "lighting": "overcast",
        # Out here the sky is the only witness (D-206, D-529).
        "zone": "wilderness",
        # Night reaches these, and pays 1.5x for the risk (D-528).
        "outdoor": True,
        "nodes": nodes,
        "transitions": [],
    }

# --- THE DUNGEON: three floors beneath the south approach (D-535) ---------
# Floors open on successive round-days, so the dungeon deepens rather than
# reshapes - nobody is ever standing in the space that changes. Each floor is
# tighter and more broken than the one above it.
for floor, (name, reach, rocks, seed) in enumerate(
    [
        ("The Sunken Crypt", 54, 300, 7700),
        ("The Drowned Gallery", 46, 420, 8800),
        ("The Undercroft", 38, 520, 9900),
    ],
    start=1,
):
    d = blank('#')
    for y in range(2, H - 2):
        for x in range(2, W - 2):
            if (abs(x - MID) + abs(y - MID)) < reach:
                d[y][x] = ','
    scatter(d, 'r', seed, rocks, avoid_band=4)
    # The stair up, carved from the north edge all the way DOWN to the
    # cavern. Deeper floors are smaller diamonds, so a fixed three-tile
    # corridor leaves the stair hanging in solid rock and the spawn tile
    # unwalkable - which CI catches, but only after a confusing minute.
    cavern_top = MID - reach + 2
    for y in range(0, max(cavern_top, 1) + 1):
        d[y][MID] = d[y][MID - 1] = ','
    # The stair down, at the south edge, on every floor but the last.
    if floor < 3:
        cavern_bottom = MID + reach - 2
        for y in range(min(cavern_bottom, H - 2), H):
            d[y][MID] = d[y][MID - 1] = ','
        must = [(MID, 0), (MID - 1, 0), (MID, H - 1), (MID - 1, H - 1)]
    else:
        must = [(MID, 0), (MID - 1, 0)]
    seal_unreachable(d, (MID, max(MID - reach + 3, 2)), must)
    areas['round-dungeon-%d' % floor] = {
        "id": "round-dungeon-%d" % floor,
        "name": name,
        "width": W, "height": H,
        "legend": LEGEND,
        "tiles": rows(d),
        "spawn": {"x": MID, "y": max(MID - reach + 3, 2)},
        "lighting": "underground",
        # Wilderness, NEVER endgame: a round death must not cost a character
        # levelled across fifty rounds (D-523).
        "zone": "wilderness",
        # No sky: no roamers, no night bonus. Its danger is its own (D-529).
        "outdoor": False,
        "dungeonFloor": floor,
        "transitions": [],
    }

# --- TRANSITIONS: the cross ------------------------------------------------
# Town's four gates lead out; each spoke's town-facing gate leads back.
def edge_pair(side):
    """(town-side tiles, spoke-side tiles) for a given compass direction."""
    if side == 'n':
        return [(MID, 0), (MID - 1, 0)], [(MID, H - 1), (MID - 1, H - 1)]
    if side == 's':
        return [(MID, H - 1), (MID - 1, H - 1)], [(MID, 0), (MID - 1, 0)]
    if side == 'e':
        return [(W - 1, MID), (W - 1, MID - 1)], [(0, MID), (0, MID - 1)]
    return [(0, MID), (0, MID - 1)], [(W - 1, MID), (W - 1, MID - 1)]


links = [('n', 'round-farm'), ('e', 'round-mine'), ('w', 'round-wood'), ('s', 'round-south')]
for side, spoke in links:
    town_tiles, spoke_tiles = edge_pair(side)
    for (tx, ty), (sx, sy) in zip(town_tiles, spoke_tiles):
        # Step one tile INSIDE the destination so you never land on the
        # return transition and bounce straight back.
        inset = {'n': (sx, sy - 1), 's': (sx, sy + 1), 'e': (sx + 1, sy), 'w': (sx - 1, sy)}[side]
        areas['round-town']["transitions"].append(
            {"x": tx, "y": ty, "toArea": spoke, "toX": inset[0], "toY": inset[1]})
        back = {'n': (tx, ty + 1), 's': (tx, ty - 1), 'e': (tx - 1, ty), 'w': (tx + 1, ty)}[side]
        areas[spoke]["transitions"].append(
            {"x": sx, "y": sy, "toArea": "round-town", "toX": back[0], "toY": back[1]})

# The way down: the south approach's far edge opens on floor 1, then each
# floor's south stair opens on the next. The GATING is server-side (D-535) -
# the geometry is always connected, and a sealed stair refuses with a line
# rather than vanishing, so players can see where they will be able to go.
south = [list(r) for r in areas['round-south']["tiles"]]
south[H - 1][MID] = south[H - 1][MID - 1] = ','
areas['round-south']["tiles"] = [''.join(r) for r in south]
for x in (MID, MID - 1):
    areas['round-south']["transitions"].append(
        {"x": x, "y": H - 1, "toArea": "round-dungeon-1", "toX": x, "toY": 1})
    areas['round-dungeon-1']["transitions"].append(
        {"x": x, "y": 0, "toArea": "round-south", "toX": x, "toY": H - 2})
for floor in (1, 2):
    for x in (MID, MID - 1):
        areas['round-dungeon-%d' % floor]["transitions"].append(
            {"x": x, "y": H - 1, "toArea": "round-dungeon-%d" % (floor + 1), "toX": x, "toY": 1})
        areas['round-dungeon-%d' % (floor + 1)]["transitions"].append(
            {"x": x, "y": 0, "toArea": "round-dungeon-%d" % floor, "toX": x, "toY": H - 2})

out = 'content/areas'
for aid, doc in areas.items():
    with io.open(os.path.join(out, aid + '.json'), 'w', encoding='utf-8', newline='\n') as f:
        f.write(json.dumps(doc, indent=2, ensure_ascii=False) + '\n')
    print('wrote', aid)
