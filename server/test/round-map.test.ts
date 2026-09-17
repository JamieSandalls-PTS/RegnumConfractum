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
// The dungeon is three floors now (D-535); the surface only ever reaches
// the first of them.
const DUNGEON = 'round-dungeon-1';
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
    // ⚠ The SPOKES, not every door. The town also opens on the tavern now
    // (D-604) — an interior reached from the square, which is not a spoke and
    // must not be counted as one. Comparing the whole exit set made the tavern
    // door look like a fifth road out of town.
    const out = new Set(
      town.transitions.map((t) => t.toArea).filter((id) => (SPOKES as readonly string[]).includes(id)),
    );
    expect([...out].sort()).toEqual([...SPOKES].sort());
    // And the tavern is reachable, which is the point of putting it there.
    expect(town.transitions.some((t) => t.toArea === 'hanged-ferryman')).toBe(true);
    for (const id of SPOKES) {
      expect(area(id).transitions.some((t) => t.toArea === TOWN)).toBe(true);
    }
    // Only the south approach descends, and the dungeon only comes back up.
    expect(area('round-south').transitions.some((t) => t.toArea === DUNGEON)).toBe(true);
    for (const id of ['round-farm', 'round-mine', 'round-wood'] as const) {
      expect(area(id).transitions.some((t) => t.toArea === DUNGEON)).toBe(false);
    }
    // Floor one goes back up to the approach and down to floor two.
    expect(new Set(area(DUNGEON).transitions.map((t) => t.toArea))).toEqual(
      new Set(['round-south', 'round-dungeon-2']),
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

  it('starts the round inside the tavern, in the middle of the town (D-549)', () => {
    // The cast wakes in one room together. That is the whole of D-536's
    // truce: the antagonist has to lie to everybody's face before anyone has
    // anywhere to be.
    const town = area(TOWN);
    const centre = { x: Math.floor(town.width / 2), y: Math.floor(town.height / 2) };
    expect(isTileWalkable(town, town.spawn)).toBe(true);
    expect(Math.abs(town.spawn.x - centre.x)).toBeLessThan(4);
    expect(Math.abs(town.spawn.y - centre.y)).toBeLessThan(4);
  });

  it('keeps the well in the open square, not behind a door (D-529)', () => {
    // The antagonist's one target in a settled zone. It has to be somewhere
    // everybody walks, or poisoning it costs nothing to do unseen — which
    // would make the town's one crime the easiest crime on the map.
    const town = area(TOWN);
    const well = town.stations.find((s) => s.type === 'well');
    expect(well).toBeDefined();
    const centre = { x: Math.floor(town.width / 2), y: Math.floor(town.height / 2) };
    // Within a dozen tiles of the middle, and standing on open ground rather
    // than inside any of the four working buildings.
    expect(Math.abs(well!.x - centre.x) + Math.abs(well!.y - centre.y)).toBeLessThan(14);
    expect(isTileWalkable(town, { x: well!.x, y: well!.y })).toBe(true);
  });

  it('gives the town four working buildings and a tavern (D-549)', () => {
    const town = area(TOWN);
    const types = new Set(town.stations.map((s) => s.type));
    expect(types).toEqual(new Set(['workshop', 'storehouse', 'infirmary', 'well']));
    // Halved from 100x100. The old town was a field with five sheds in it.
    expect(town.width).toBe(50);
    expect(town.height).toBe(50);
  });
});

/**
 * ⚠ The band here is NOT D-530's original 30-45s. Halving the town (D-549)
 * took roughly eight seconds off each leg of every errand, because a quarter
 * of the journey used to be crossing Ashfold. The stakeholder asked for the
 * smaller town and asked that the spokes be left alone, so the trip is
 * genuinely shorter now and the numbers below are MEASURED rather than
 * inherited.
 *
 * What survives unchanged is the part that was actually about design: depth
 * inside a spoke must still cost meaningfully more than its mouth, or "how
 * deep do I go" is not a decision.
 */
describe('pacing: a spoke is 20-40 seconds out (D-530, re-measured by D-549)', () => {
  const town = area(TOWN);
  const fromSpawn = distancesFrom(town, town.spawn);

  it('puts every gate a comparable distance from the centre — equal exposure', () => {
    // ⚠ The GATES, not every door. The tavern's door is a few steps from
    // the spawn because D-549 put the tavern in the middle of the square,
    // and counting it as a gate made the spread 20 tiles and this test a
    // complaint about the town having an inn in it.
    const legs = town.transitions
      .filter((t) => t.toArea.startsWith('round-'))
      .map((t) => fromSpawn.get(`${t.x},${t.y}`) ?? Infinity);
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
    expect(midSeconds).toBeGreaterThan(18);
    expect(midSeconds).toBeLessThan(28);
    expect(deepSeconds).toBeGreaterThan(31);
    expect(deepSeconds).toBeLessThan(42);
    // Depth inside a spoke is a risk gradient: the far end must cost
    // meaningfully more than the near end, or "how deep do I go" is not a
    // decision (D-530).
    expect(deepSeconds - midSeconds).toBeGreaterThan(8);
  });
});
