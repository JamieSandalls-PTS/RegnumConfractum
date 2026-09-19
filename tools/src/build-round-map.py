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

# The TOWN is half the size of a spoke (D-549, stakeholder 2026-08-20). Every
# helper below reads the module globals, so `dims()` rebinds them before each
# area is built rather than threading a size through twenty signatures.
TOWN_W = TOWN_H = 50
TOWN_MID = 25


def dims(w, h):
    global W, H, MID
    W, H = w, h
    MID = w // 2

LEGEND = {
    '#': {"walkable": False, "kind": "wall"},
    # The wall FAMILY (D-545). A taproom, a smithy and a town palisade are not
    # made of the same stuff, and they all behave identically underneath:
    # unwalkable, opaque, full height.
    'W': {"walkable": False, "kind": "wall-timber"},
    'P': {"walkable": False, "kind": "wall-plaster"},
    'B': {"walkable": False, "kind": "wall-brick"},
    'p': {"walkable": False, "kind": "palisade"},
    'F': {"walkable": False, "kind": "wall-forest"},
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


def building(grid, x0, y0, w, h, door, wall='#', floor='.'):
    """A walled structure with one door. `door` is 'n'|'s'|'e'|'w'."""
    for y in range(y0, y0 + h):
        for x in range(x0, x0 + w):
            edge = x in (x0, x0 + w - 1) or y in (y0, y0 + h - 1)
            grid[y][x] = wall if edge else floor
    dx, dy = {
        'n': (x0 + w // 2, y0),
        's': (x0 + w // 2, y0 + h - 1),
        'e': (x0 + w - 1, y0 + h // 2),
        'w': (x0, y0 + h // 2),
    }[door]
    grid[dy][dx] = floor
    return (dx, dy)


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
# Every wall material, for the "is there a wall beside me" tests. Keyed off
# the FAMILY rather than the single '#' that used to stand for all of them —
# the same trap D-545 flagged in `isTileOpaque`.
WALL_CHARS = set('#WPBpF')


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


# --- PROPS (D-542) ----------------------------------------------------------
# Scenery is placed HERE rather than by hand because the map is generated: a
# hundred crates authored into a 100x100 JSON would have to be re-authored
# every time the map moved a wall.
#
# Solid props change walkability, so every one is tested before it is kept:
# block the tile, flood from spawn, and only accept the prop if exactly the
# same tiles are still reachable. That is what stops a barrel sealing a spoke
# — the failure the CI reachability check would otherwise find for us, much
# later and much more confusingly.

SOLID_PROPS = {
    'crate', 'crate-stack', 'barrel', 'barrel-stack', 'anvil', 'workbench',
    'grindstone', 'market-stall', 'cart', 'trough', 'well', 'fence',
    'gate-post', 'shrine', 'hay-bale', 'log-pile', 'gravestone', 'stalagmite',
    'storehouse-rack', 'infirmary-table',
}


def reachable_from(grid, props, spawn):
    """Flood fill, with solid props blocking as they do in play."""
    blocked = {(p['x'], p['y']) for p in props if p['type'] in SOLID_PROPS}
    sx, sy = spawn
    seen = {(sx, sy)}
    stack = [(sx, sy)]
    while stack:
        x, y = stack.pop()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if not (0 <= nx < W and 0 <= ny < H):
                continue
            if (nx, ny) in seen or (nx, ny) in blocked:
                continue
            if grid[ny][nx] in WALKABLE:
                seen.add((nx, ny))
                stack.append((nx, ny))
    return seen


class PropPlacer:
    """
    Places props without ever making a walkable tile unreachable.

    Cost matters here: a flood fill per candidate prop is O(area x props) and
    took minutes across nine 100x100 maps. Instead solid props are refused
    locally — a tile with fewer than five walkable neighbours is a corridor or
    a doorway and never gets one — and a single flood at the end repairs
    anything the local test let through. Same guarantee, one flood per pass.
    """

    def __init__(self, grid, spawn, reserved):
        self.grid = grid
        self.spawn = spawn
        self.props = []
        self.occupied = set()
        self.reserved = set(reserved)
        self.base = len(reachable_from(grid, [], spawn))

    def walkable(self, x, y):
        return 0 <= x < W and 0 <= y < H and self.grid[y][x] in WALKABLE

    def free(self, x, y):
        if not self.walkable(x, y):
            return False
        return (x, y) not in self.reserved and (x, y) not in self.occupied

    def open_enough(self, x, y):
        """Open ground, not a corridor. Cheap stand-in for an articulation test."""
        n = 0
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                if (dx or dy) and self.walkable(x + dx, y + dy):
                    n += 1
        return n >= 5

    def place(self, x, y, kind, rot=None):
        if not self.free(x, y):
            return False
        solid = kind in SOLID_PROPS
        if solid and not self.open_enough(x, y):
            return False
        prop = {"x": x, "y": y, "type": kind}
        if rot is not None:
            prop["rot"] = rot
        self.props.append(prop)
        self.occupied.add((x, y))
        return True

    def repair(self):
        """
        Drops solid props until everything walkable is reachable again.

        The local test is a heuristic, so this is the guarantee. In practice
        it removes nothing or a handful; either way CI would catch a miss, and
        catching it here is cheaper than catching it there.
        """
        removed = 0
        for _ in range(12):
            seen = reachable_from(self.grid, self.props, self.spawn)
            if len(seen) == self.base:
                return removed
            lost = {
                (x, y)
                for y in range(H)
                for x in range(W)
                if self.grid[y][x] in WALKABLE and (x, y) not in seen
                and (x, y) not in self.occupied
            }
            if not lost:
                return removed
            # Anything solid touching a stranded tile is a suspect.
            keep = []
            for p in self.props:
                near_lost = any(
                    (p['x'] + dx, p['y'] + dy) in lost
                    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))
                )
                if p['type'] in SOLID_PROPS and near_lost:
                    self.occupied.discard((p['x'], p['y']))
                    removed += 1
                else:
                    keep.append(p)
            if len(keep) == len(self.props):
                return removed  # cannot improve; CI will report it
            self.props = keep
        return removed

    def near_wall(self, x, y):
        """True if the tile has a wall beside it — where clutter belongs."""
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < W and 0 <= ny < H and self.grid[ny][nx] in WALL_CHARS:
                return True
        return False

    def cluster(self, seed, kinds, groups, per_group=3, spread=2):
        """
        Places small GROUPS of related props.

        Uniform scatter reads as noise; three barrels and a crate together
        read as somebody's stores. Almost all the dressing goes through here
        for that reason.
        """
        a = seed
        made = 0
        guard = 0
        while made < groups and guard < groups * 90:
            guard += 1
            a = (a * 1103515245 + 12345) & 0x7FFFFFFF
            cx = 3 + (a >> 7) % (W - 6)
            a = (a * 1103515245 + 12345) & 0x7FFFFFFF
            cy = 3 + (a >> 7) % (H - 6)
            if not self.free(cx, cy):
                continue
            placed_here = 0
            for _ in range(per_group * 3):
                a = (a * 1103515245 + 12345) & 0x7FFFFFFF
                ox = ((a >> 6) % (spread * 2 + 1)) - spread
                a = (a * 1103515245 + 12345) & 0x7FFFFFFF
                oy = ((a >> 6) % (spread * 2 + 1)) - spread
                a = (a * 1103515245 + 12345) & 0x7FFFFFFF
                kind = kinds[(a >> 5) % len(kinds)]
                if self.place(cx + ox, cy + oy, kind, rot=(a >> 3) % 8):
                    placed_here += 1
                if placed_here >= per_group:
                    break
            if placed_here:
                made += 1
        return made

    def scatter(self, seed, kinds, count, wall_hugging=False, band=None):
        """Deterministic scatter of one prop family."""
        a = seed
        placed = 0
        guard = 0
        while placed < count and guard < count * 120:
            guard += 1
            a = (a * 1103515245 + 12345) & 0x7FFFFFFF
            x = 2 + (a >> 7) % (W - 4)
            a = (a * 1103515245 + 12345) & 0x7FFFFFFF
            y = 2 + (a >> 7) % (H - 4)
            a = (a * 1103515245 + 12345) & 0x7FFFFFFF
            kind = kinds[(a >> 5) % len(kinds)]
            if band is not None and (abs(x - MID) > band and abs(y - MID) > band):
                continue
            if wall_hugging and not self.near_wall(x, y):
                continue
            if self.place(x, y, kind, rot=(a >> 3) % 8):
                placed += 1
        return placed

def reserved_tiles(doc):
    """Tiles that must stay clear: spawn, transitions, nodes, stations."""
    out = {(doc["spawn"]["x"], doc["spawn"]["y"])}
    for tr in doc.get("transitions", []):
        out.add((tr["x"], tr["y"]))
        # And the tile you arrive on, plus its neighbours, so an arrival is
        # never boxed in by scenery.
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                out.add((tr["x"] + dx, tr["y"] + dy))
    for n in doc.get("nodes", []):
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                out.add((n["x"] + dx, n["y"] + dy))
    for st in doc.get("stations", []):
        for dx in (-2, -1, 0, 1, 2):
            for dy in (-2, -1, 0, 1, 2):
                out.add((st["x"] + dx, st["y"] + dy))
    return out


areas = {}

# --- TOWN: the settled hub -------------------------------------------------
# HALVED to 50x50 (D-549, stakeholder 2026-08-20). The old 100x100 town was a
# field with five sheds in it: nine tenths of the walking a player did in
# Ashfold was crossing empty ground between buildings that had no reason to be
# that far apart. At half the size the four utility buildings are inside a
# shout of each other and of the tavern, which is what a town square is for.
#
# The shape is a RING: a dirt road enclosing the tavern and the well-square,
# with the four working buildings set just outside it in the four quadrants.
# That reads as a town rather than as a scatter because a town is a street
# plan first and buildings second — and it means every route between two
# buildings passes the square, so nothing important happens out of sight.
dims(TOWN_W, TOWN_H)
t = blank('g')
# A palisade, not an anonymous wall (D-545). Ashfold is a place that expects
# trouble; the fence is the first thing that says so.
for x in range(W):
    t[0][x] = t[H - 1][x] = 'p'
for y in range(H):
    t[y][0] = t[y][W - 1] = 'p'
for side in 'nsew':
    gate(t, side)

# --- the street plan -------------------------------------------------------
RING_X0, RING_X1 = 15, 34
RING_Y0, RING_Y1 = 14, 37


def road_rect(grid, x0, y0, x1, y1, width=2):
    """The ring road: a rectangle of dirt `width` tiles thick."""
    for w in range(width):
        for x in range(x0, x1 + 1):
            grid[y0 + w][x] = ','
            grid[y1 - w][x] = ','
        for y in range(y0, y1 + 1):
            grid[y][x0 + w] = ','
            grid[y][x1 - w] = ','


road_rect(t, RING_X0, RING_Y0, RING_X1, RING_Y1)
# Four approaches from the gates to the ring. Two tiles wide, like the gates,
# so two people can pass without one of them stepping into the mud.
for x in (MID - 1, MID):
    for y in range(0, RING_Y0 + 2):
        t[y][x] = ','
    for y in range(RING_Y1 - 1, H):
        t[y][x] = ','
for y in (MID - 1, MID):
    for x in range(0, RING_X0 + 2):
        t[y][x] = ','
    for x in range(RING_X1 - 1, W):
        t[y][x] = ','

# --- the tavern, at the middle of everything -------------------------------
# The starting point for every round (D-549). Putting the cast in a room
# together at dawn is the whole of D-536's truce: the antagonist has to lie to
# everybody's face before anyone has anywhere to be.
TAV_X0, TAV_Y0, TAV_W, TAV_H = 19, 17, 13, 11
tavern_door = building(t, TAV_X0, TAV_Y0, TAV_W, TAV_H, 's', wall='W')
# A second door, north, so the taproom is not a bottle with one neck. A single
# exit would make the tavern the easiest room in the game to trap people in.
t[TAV_Y0][TAV_X0 + TAV_W // 2] = '.'

# --- the square, and the well ----------------------------------------------
# The well sits in the open between the tavern door and the south gate: the
# most overlooked tile in Ashfold, which is exactly what D-529 needs it to be.
# A poisoner has to do it where everyone walks.
for y in range(TAV_Y0 + TAV_H, RING_Y1 - 1):
    for x in range(RING_X0 + 2, RING_X1 - 1):
        t[y][x] = '.'
WELL_X, WELL_Y = MID - 1, 32
for y in (WELL_Y, WELL_Y + 1):
    for x in (WELL_X, WELL_X + 1):
        t[y][x] = '~'

# --- the four working buildings, one per quadrant --------------------------
# Close enough that a shout carries between them (COMBAT_NOISE_TILES is 30,
# and the far corners are inside that), which is what makes D-531's noise
# model bite in a settled zone: a scuffle behind the smithy is heard in the
# infirmary.
#
# The guardhouse is the fourth (D-550). It is where the town's guards muster,
# and it exists so that "the guards saw you" has a place on the map rather
# than being an abstraction the server applies from nowhere.
smithy_door = building(t, 5, 5, 10, 8, 's', wall='B')       # workshop
store_door = building(t, 35, 5, 10, 8, 's', wall='W')       # storehouse
infirm_door = building(t, 5, 39, 10, 8, 'n', wall='P')      # infirmary
guard_door = building(t, 35, 39, 10, 8, 'n', wall='#')      # guardhouse

# Paths from each building's door to the ring, so nobody walks through a
# hedge to get to the anvil.
for (dx, dy), (rx, ry) in [
    (smithy_door, (10, RING_Y0)),
    (store_door, (39, RING_Y0)),
    (infirm_door, (10, RING_Y1)),
    (guard_door, (39, RING_Y1)),
]:
    # Start one tile OUTSIDE the door: running the path from the doorway
    # itself carved two extra tiles out of the building's own wall, which
    # left the guardhouse with a hole in its front instead of a door.
    outside = dy + (1 if dy < ry else -1)
    step = 1 if ry > outside else -1
    for y in range(outside, ry + step, step):
        t[y][dx] = ','
    lo, hi = sorted((dx, rx))
    for x in range(lo, hi + 1):
        t[ry][x] = ','
# And a short path from the tavern's north door out to the ring.
for y in range(TAV_Y0 - 1, RING_Y0 + 1, -1):
    t[y][TAV_X0 + TAV_W // 2] = ','

# --- gardens, pens and the corners -----------------------------------------
# Fenced plots in the gaps between the road and the palisade. They are what
# stops the four quadrants reading as lawn: a town has back yards.
def plot(grid, x0, y0, x1, y1):
    for x in range(x0, x1 + 1):
        grid[y0][x] = grid[y1][x] = 'g'
    for y in range(y0, y1 + 1):
        grid[y][x0] = grid[y][x1] = 'g'


# A stand of trees inside the palisade at each corner: cover, and the only
# place in a settled zone where line of sight is genuinely broken (D-217).
#
# A SOLID clump, not a checkerboard. The first version alternated tiles and
# left one-tile pockets behind, which `seal_unreachable` then turned to rock —
# so all four corners came out as rubble heaps rather than copses.
for cx, cy in ((4, 4), (W - 5, 4), (4, H - 5), (W - 5, H - 5)):
    for dx in range(-1, 2):
        for dy in range(-1, 2):
            x, y = cx + dx, cy + dy
            if 1 <= x < W - 1 and 1 <= y < H - 1 and t[y][x] == 'g':
                t[y][x] = 'F'

seal_unreachable(t, (MID, TAV_Y0 + TAV_H + 1),
                 [(MID, 0), (MID - 1, 0), (MID, H - 1), (MID - 1, H - 1),
                  (0, MID), (0, MID - 1), (W - 1, MID), (W - 1, MID - 1)])

# Facilities are REAL PLACED OBJECTS (D-530): one inside each working
# building, and the well in the open square.
town_stations = [
    {"x": 10, "y": 8, "type": "workshop"},
    {"x": 40, "y": 8, "type": "storehouse"},
    {"x": 10, "y": 43, "type": "infirmary"},
    {"x": WELL_X, "y": WELL_Y + 2, "type": "well"},
]

# Roofs (D-545): painted as footprints, shaped automatically. Every building
# gets one, in a material that matches its walls — the roof is most of what
# reads as a building from an isometric camera.
town_roofs = []


def roof_over(x0, y0, w, h, style):
    for y in range(y0, y0 + h):
        for x in range(x0, x0 + w):
            town_roofs.append({"x": x, "y": y, "style": style})


roof_over(TAV_X0, TAV_Y0, TAV_W, TAV_H, 'thatch')
roof_over(5, 5, 10, 8, 'plank')      # smithy
roof_over(35, 5, 10, 8, 'thatch')    # storehouse
roof_over(5, 39, 10, 8, 'tile')      # infirmary
roof_over(35, 39, 10, 8, 'slate')    # guardhouse

areas['round-town'] = {
    "id": "round-town",
    "name": "Ashfold",
    "width": W, "height": H,
    "legend": LEGEND,
    "tiles": rows(t),
    # Inside the taproom, a step from the south door. Every round opens here.
    "spawn": {"x": MID, "y": TAV_Y0 + TAV_H - 3},
    "lighting": "overcast",
    "zone": "settled",
    "outdoor": True,
    "stations": town_stations,
    "roofs": town_roofs,
    "transitions": [],
}
dims(100, 100)

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
        ("The Flooded Steps", 54, 300, 7700),
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
    """
    (town-side tiles, spoke-side tiles) for a given compass direction.

    The two sides no longer share a size (D-549): the town is 50x50 and a
    spoke is 100x100, so each edge is computed against its OWN dimensions.
    Reading the module globals for both — which is what this did before the
    town shrank — put the town's gates at x=50 on a map 50 wide.
    """
    tw, th, tm = TOWN_W, TOWN_H, TOWN_MID
    sw, sh, sm = 100, 100, 50
    if side == 'n':
        return [(tm, 0), (tm - 1, 0)], [(sm, sh - 1), (sm - 1, sh - 1)]
    if side == 's':
        return [(tm, th - 1), (tm - 1, th - 1)], [(sm, 0), (sm - 1, 0)]
    if side == 'e':
        return [(tw - 1, tm), (tw - 1, tm - 1)], [(0, sm), (0, sm - 1)]
    return [(0, tm), (0, tm - 1)], [(sw - 1, sm), (sw - 1, sm - 1)]


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

# --- DRESS THE MAP (D-542) -------------------------------------------------
# Each area gets the clutter its purpose implies: a town square that looks
# lived in, a farm with bales and a scarecrow, a mine with carts and spoil, a
# wood of stumps and log piles, a dungeon of bones and stalagmites.
#
# Every placement is checked against reachability, so the map cannot be
# decorated into a maze.

DRESSING = {
    # (seed, kinds, count, wall_hugging, band)
    # A quarter of the area, so roughly a quarter of the clutter (D-549). The
    # square's own furniture — stalls, lanterns, the shrine — is placed by
    # hand below rather than scattered, because a market that lands wherever
    # the RNG puts it is not a market.
    'round-town': [
        (0xA101, ['crate', 'crate-stack', 'barrel', 'barrel-stack'], 24, False, None),
        (0xA102, ['sack-pile', 'basket', 'firewood'], 18, False, None),
        (0xA104, ['cart', 'trough', 'grindstone'], 8, False, None),
        (0xA107, ['fence'], 22, False, None),
        (0xA109, ['bush', 'fern'], 20, False, None),
    ],
    'round-farm': [
        (0xB101, ['hay-bale'], 60, False, None),
        (0xB102, ['scarecrow'], 14, False, None),
        (0xB103, ['fence'], 80, False, None),
        (0xB104, ['cart', 'trough'], 16, False, None),
        (0xB105, ['basket', 'sack-pile'], 44, False, None),
        (0xB106, ['stump'], 24, False, None),
    ],
    'round-wood': [
        (0xC101, ['log-pile'], 44, False, None),
        (0xC102, ['stump'], 70, False, None),
        (0xC103, ['firewood'], 40, False, None),
        (0xC104, ['shrine', 'signpost'], 12, False, None),
        (0xC105, ['crate', 'barrel'], 24, False, None),
        (0xC106, ['mushroom-cluster'], 40, False, None),
    ],
    'round-mine': [
        (0xD101, ['cart'], 26, False, None),
        (0xD102, ['rubble'], 80, False, None),
        (0xD103, ['crate', 'crate-stack', 'barrel'], 46, False, None),
        (0xD104, ['brazier', 'lantern-post'], 26, False, None),
        (0xD105, ['grindstone', 'workbench'], 12, False, None),
        (0xD106, ['firewood', 'sack-pile'], 34, False, None),
    ],
    'round-south': [
        (0xE101, ['rubble'], 70, False, None),
        (0xE102, ['gravestone'], 44, False, None),
        (0xE103, ['bone-pile'], 34, False, None),
        (0xE104, ['shrine'], 10, False, None),
        (0xE105, ['stump', 'firewood'], 30, False, None),
        (0xE106, ['brazier'], 16, False, None),
    ],
}
for floor in (1, 2, 3):
    DRESSING['round-dungeon-%d' % floor] = [
        (0xF100 + floor, ['stalagmite'], 50 + floor * 12, False, None),
        (0xF200 + floor, ['bone-pile'], 34 + floor * 10, False, None),
        (0xF300 + floor, ['rubble'], 60, False, None),
        (0xF400 + floor, ['mushroom-cluster'], 34, False, None),
        (0xF500 + floor, ['gravestone'], 14 + floor * 6, False, None),
        (0xF600 + floor, ['crate', 'barrel', 'sack-pile'], 20, False, None),
    ]

for aid, plan in DRESSING.items():
    doc = areas[aid]
    # Areas are no longer all one size (D-549): set the globals the placer
    # reads before dressing each one, or the town is flooded as if it were
    # twice as tall as it is.
    dims(doc["width"], doc["height"])
    grid = [list(r) for r in doc["tiles"]]
    placer = PropPlacer(grid, (doc["spawn"]["x"], doc["spawn"]["y"]), reserved_tiles(doc))
    for seed, kinds, count, hugging, band in plan:
        if band is not None or hugging:
            placer.scatter(seed, kinds, count, wall_hugging=hugging, band=band)
        else:
            # Groups of three, so the map reads as used rather than sprinkled.
            placer.cluster(seed, kinds, max(1, count // 3), per_group=3, spread=2)
    # The town's own furniture, placed BY HAND (D-549). A market square whose
    # stalls land wherever the RNG puts them is not a square, and lanterns
    # scattered at random light the back of the smithy instead of the road.
    # These go in last so the scattered clutter cannot have taken their tiles.
    if aid == 'round-town':
        for x in range(RING_X0 + 3, RING_X1 - 2, 3):
            placer.place(x, RING_Y1 - 3, 'market-stall', rot=0)
        for x in range(RING_X0 + 4, RING_X1 - 2, 4):
            placer.place(x, TAV_Y0 + TAV_H + 1, 'market-stall', rot=4)
        # Lanterns down both approaches and at the ring's corners: the road
        # is the one part of Ashfold that must still read at night (D-527).
        for y in range(RING_Y0 + 3, RING_Y1 - 2, 5):
            placer.place(RING_X0 - 1, y, 'lantern-post')
            placer.place(RING_X1 + 1, y, 'lantern-post')
        for x in range(RING_X0 + 3, RING_X1 - 2, 5):
            placer.place(x, RING_Y0 - 1, 'lantern-post')
            placer.place(x, RING_Y1 + 1, 'lantern-post')
        # A brazier either side of the tavern door, a shrine by the well, a
        # signpost at each gate, and the guardhouse's banner.
        placer.place(MID - 2, TAV_Y0 + TAV_H, 'brazier')
        placer.place(MID + 2, TAV_Y0 + TAV_H, 'brazier')
        placer.place(WELL_X + 3, WELL_Y + 1, 'shrine')
        placer.place(MID + 1, RING_Y0 - 2, 'signpost')
        placer.place(MID + 1, RING_Y1 + 2, 'signpost')
        placer.place(RING_X0 - 2, MID + 1, 'signpost')
        placer.place(RING_X1 + 2, MID + 1, 'signpost')
        placer.place(39, 38, 'banner-pole')
        placer.place(38, 38, 'brazier')
        # The trades' tools, inside the buildings they belong to.
        placer.place(12, 8, 'anvil')
        placer.place(8, 9, 'grindstone')
        placer.place(38, 9, 'sack-pile')
        placer.place(42, 9, 'crate-stack')
        placer.place(12, 43, 'workbench')
    dropped = placer.repair()
    # D-567: the 44 procedural prop types are gone. A map is dressed with pack
    # meshes in the editor now, so nothing here writes scenery -- leaving this
    # in would re-add 1,916 props every time the generator ran, which is how
    # they came back the first time.
    print('dressed %-16s %3d props%s'
          % (aid, len(placer.props), '' if not dropped else ' (%d dropped to keep it walkable)' % dropped))

# The bed each area plays (D-541). Set HERE rather than by hand on the JSON:
# this generator rewrites those files, so a hand-added field is silently lost
# the next time the map is rebuilt — which is exactly what happened once.
AMBIENCE = {
    'round-town': 'ambience-town',
    'round-farm': 'ambience-farm',
    'round-wood': 'ambience-forest',
    'round-mine': 'ambience-mine',
    'round-south': 'ambience-forest',
    'round-dungeon-1': 'ambience-cave',
    'round-dungeon-2': 'ambience-cave',
    'round-dungeon-3': 'ambience-cave',
}
for aid, cue in AMBIENCE.items():
    areas[aid]["ambience"] = cue

out = 'content/areas'

# WARNING: THIS SCRIPT REWRITES WHOLE FILES, AND PEOPLE NOW EDIT THEM.
#
# It generates the cross -- sizes, tiles, spawns, doors, stations, nodes -- and
# used to write each area out complete, dropping anything it did not know
# about. That was safe while the maps were nothing but generated geometry. It
# stopped being safe the moment a person opened the editor: `assets` and
# `roofs` are placed BY HAND now (D-582), and one run of this script would have
# erased an afternoon of design without a word.
#
# So these keys are carried across from whatever is already on disk. The rule
# is the same one the editor's own warning implies, made true instead of
# hoped for: this script owns the SKELETON of a round area, and a person owns
# what stands on it.
#
# `live` is here for the same reason (D-581) -- it is a statement somebody made
# about the map, not something the generator can work out.
# WARNING: what a re-run must NOT throw away. Everything here is authored by
# hand or by another tool and cannot be regenerated from this script's inputs.
# `groundPaint`/`groundMaterials` were added after the town was painted
# (D-590): without them the next run of this generator would have silently
# unpainted Ashfold, leaving two orphan mask files on disk and a map that
# looked exactly like one nobody had got round to painting yet.
PRESERVED = ('assets', 'roofs', 'live', 'groundPaint', 'groundMaterials')

# WARNING: AREAS WHOSE SHAPE IS HAND-AUTHORED, WHICH THIS SCRIPT MUST NOT
# REGENERATE.
#
# Ashfold is a street plan somebody drew (D-549, D-584), and its walls stopped
# being tiles when they became placed assets with collision volumes. This
# script still knows how to lay a palisade in the tile grid, so a re-run
# rewrote 386 wall tiles straight back into the map -- a town with an invisible
# second palisade standing inside the real one, which parses, validates, floods
# as reachable and is wrong. That has now happened TWICE, the second time to
# somebody who had just read the note about the first.
#
# The editor already warns that hand edits to a round-* area are lost on the
# next run. This is the half that makes the warning unnecessary for the maps
# that are finished: the shape is carried across, and only the fields above --
# what stands on the map -- are the person's to keep everywhere else.
SHAPE_IS_AUTHORED = {'round-town'}
SHAPE = ('width', 'height', 'tiles', 'legend', 'spawn', 'transitions',
         'stations', 'nodes', 'collision')

for aid, doc in areas.items():
    path = os.path.join(out, aid + '.json')
    kept = {}
    if os.path.exists(path):
        with io.open(path, encoding='utf-8') as f:
            existing = json.load(f)
        keys = PRESERVED + (SHAPE if aid in SHAPE_IS_AUTHORED else ())
        for key in keys:
            if key in existing:
                kept[key] = existing[key]
    doc.update(kept)
    with io.open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(json.dumps(doc, indent=2, ensure_ascii=False) + '\n')
    n = len(kept.get('assets', []))
    note = ('(kept %d placed asset(s))' % n) if n else ''
    if aid in SHAPE_IS_AUTHORED:
        note += ' [shape is hand-authored — left alone]'
    print('wrote', aid, note)

# WARNING (D-638): the maps above are TILE grids -- mazes, borders, rocks and
# trees as legend kinds -- and nothing draws a tile any more. The build refuses
# an unwalkable tile, so a generated map is not finished until it has been
# painted and CONVERTED:
#
#     npm run map:paint && npm run map:dress && npm run map:prune && npm run map:convert
#
# in that order: the painter and the placer read the tile kinds, and the
# converter is what takes the blocking ones away.
print('\nNext: npm run map:paint && npm run map:dress && npm run map:prune && npm run map:convert  (D-638)')
