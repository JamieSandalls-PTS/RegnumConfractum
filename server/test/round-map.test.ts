import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isTileWalkable, type AreaDef } from '@rc/shared';
import { loadContent } from '@rc/server/content';

/**
 * The cross map (D-529, D-530), asserted as design rather than as data.
 *
 * Everything checked here is load-bearing and none of it is visible in a
 * screenshot. If the town stops being `settled` the antagonist can murder in
 * public; if a spoke stops being `outdoor` night stops reaching it and its
 * reward bonus silently dies; if the dungeon becomes `endgame` a bad pull
 * costs someone a character levelled across fifty rounds. The travel band is
 * the round's pacing knob and was arrived at by measurement, so it is the
 * thing most likely to drift when someone redraws a map.
 */

const content = loadContent(fileURLToPath(new URL('../../content', import.meta.url)));
const area = (id: string): AreaDef => {
  const a = content.areas.get(id);
  if (!a) throw new Error(`missing area ${id}`);
  return a;
};

const TOWN = 'round-town';
const SPOKES = ['round-farm', 'round-mine', 'round-wood', 'round-south'] as const;
const DUNGEON = 'round-dungeon';
/** Tiles per second: one step per MOVE_COOLDOWN_TICKS (3) at 10Hz. */
const SECONDS_PER_TILE = 3 / 10;

/** Eight-way flood (diagonals cost the same, they just cannot cut corners). */
function distancesFrom(a: AreaDef, start: { x: number; y: number }): Map<string, number> {
  const dist = new Map<string, number>([[`${start.x},${start.y}`, 0]]);
  const queue: { x: number; y: number }[] = [start];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const d = dist.get(`${cur.x},${cur.y}`)!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const n = { x: cur.x + dx!, y: cur.y + dy! };
      const key = `${n.x},${n.y}`;
      if (n.x < 0 || n.y < 0 || n.x >= a.width || n.y >= a.height) continue;
      if (dist.has(key) || !isTileWalkable(a, n)) continue;
      dist.set(key, d + 1);
      queue.push(n);
    }
  }
  return dist;
}

describe('the cross (D-529)', () => {
  it('is a hub with four spokes and a dungeon beneath the south', () => {
    const town = area(TOWN);
    const out = new Set(town.transitions.map((t) => t.toArea));
    expect([...out].sort()).toEqual([...SPOKES].sort());
    for (const id of SPOKES) {
      expect(area(id).transitions.some((t) => t.toArea === TOWN)).toBe(true);
    }
    // Only the south approach descends, and the dungeon only comes back up.
    expect(area('round-south').transitions.some((t) => t.toArea === DUNGEON)).toBe(true);
    for (const id of ['round-farm', 'round-mine', 'round-wood'] as const) {
      expect(area(id).transitions.some((t) => t.toArea === DUNGEON)).toBe(false);
    }
    expect(new Set(area(DUNGEON).transitions.map((t) => t.toArea))).toEqual(
      new Set(['round-south']),
    );
  });

  it('makes the town the only place you cannot be killed without declaring', () => {
    expect(area(TOWN).zone).toBe('settled');
    for (const id of SPOKES) expect(area(id).zone).toBe('wilderness');
  });

  it('never makes the round dungeon an endgame zone (D-523)', () => {
    // Endgame carries involuntary permadeath. A round death must not cost a
    // character levelled across fifty rounds — this is the trap D-523 was
    // written to stop someone walking into by reusing the crypt.
    expect(area(DUNGEON).zone).toBe('wilderness');
    expect(area(DUNGEON).zone).not.toBe('endgame');
  });

  it('lets night reach every spoke and no part of the dungeon (D-527, D-528)', () => {
    for (const id of SPOKES) expect(area(id).outdoor).toBe(true);
    // No sky below ground: no roamers, and no 1.5x bonus. Otherwise diving at
    // dusk would be the way to earn night money without taking night's risk.
    expect(area(DUNGEON).outdoor).toBe(false);
  });

  it('puts the well at the heart of the town', () => {
    // The antagonist's one target in a settled zone (D-529). Water is not
    // walkable, so its presence at the centre is checkable.
    const town = area(TOWN);
    const mid = { x: Math.floor(town.width / 2), y: Math.floor(town.height / 2) };
    expect(isTileWalkable(town, mid)).toBe(false);
  });
});

describe('pacing: a spoke is 30-45 seconds out (D-530)', () => {
  const town = area(TOWN);
  const fromSpawn = distancesFrom(town, town.spawn);

  it('puts every gate a comparable distance from the centre — equal exposure', () => {
    const legs = town.transitions.map((t) => fromSpawn.get(`${t.x},${t.y}`) ?? Infinity);
    expect(Math.min(...legs)).toBeGreaterThan(0);
    expect(Math.max(...legs)).toBeLessThan(Infinity);
    // No spoke may be meaningfully nearer than another, or the map collapses
    // onto the cheap axis and choosing a direction stops being about need.
    expect(Math.max(...legs) - Math.min(...legs)).toBeLessThan(12);
  });

  it('lands a mid-depth errand near 30s and a deep one near 45s', () => {
    const gate = town.transitions.find((t) => t.toArea === 'round-farm')!;
    const townLeg = fromSpawn.get(`${gate.x},${gate.y}`)!;
    const farm = area('round-farm');
    const inFarm = [...distancesFrom(farm, { x: gate.toX, y: gate.toY }).values()];
    inFarm.sort((a, b) => a - b);
    const mid = inFarm[Math.floor(inFarm.length / 2)]!;
    const deep = inFarm[inFarm.length - 1]!;

    const midSeconds = (townLeg + mid) * SECONDS_PER_TILE;
    const deepSeconds = (townLeg + deep) * SECONDS_PER_TILE;
    expect(midSeconds).toBeGreaterThan(25);
    expect(midSeconds).toBeLessThan(38);
    expect(deepSeconds).toBeGreaterThan(38);
    expect(deepSeconds).toBeLessThan(50);
    // Depth inside a spoke is a risk gradient: the far end must cost
    // meaningfully more than the near end, or "how deep do I go" is not a
    // decision (D-530).
    expect(deepSeconds - midSeconds).toBeGreaterThan(8);
  });
});
