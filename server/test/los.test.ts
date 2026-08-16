import { describe, expect, it } from 'vitest';
import { AreaSchema } from '@rc/shared';
import { hasLineOfSight } from '@rc/server/game/los';

const area = AreaSchema.parse({
  id: 'los-test',
  name: 'LoS Test',
  width: 10,
  height: 8,
  legend: {
    '#': { walkable: false, kind: 'wall' },
    '.': { walkable: true, kind: 'floor' },
    'w': { walkable: false, kind: 'water' },
  },
  tiles: [
    '##########',
    '#........#',
    '#...#....#',
    '#...#....#',
    '#...#.ww.#',
    '#...#....#',
    '#........#',
    '##########',
  ],
  spawn: { x: 1, y: 1 },
});

describe('line of sight', () => {
  it('sees across open floor', () => {
    expect(hasLineOfSight(area, { x: 1, y: 1 }, { x: 8, y: 1 })).toBe(true);
    expect(hasLineOfSight(area, { x: 1, y: 6 }, { x: 8, y: 6 })).toBe(true);
  });

  it('walls block sight', () => {
    // Wall column at x=4, rows 2..5 sits between (2,3) and (7,3).
    expect(hasLineOfSight(area, { x: 2, y: 3 }, { x: 7, y: 3 })).toBe(false);
    expect(hasLineOfSight(area, { x: 7, y: 3 }, { x: 2, y: 3 })).toBe(false);
  });

  it('water does not block sight', () => {
    // (5,4) to (8,4) passes over the ww pond.
    expect(hasLineOfSight(area, { x: 5, y: 4 }, { x: 8, y: 4 })).toBe(true);
  });

  it('sight goes around the wall via open rows', () => {
    // Same two parties can see each other when both stand clear of the wall line.
    expect(hasLineOfSight(area, { x: 2, y: 1 }, { x: 7, y: 1 })).toBe(true);
    expect(hasLineOfSight(area, { x: 2, y: 6 }, { x: 7, y: 6 })).toBe(true);
  });

  it('a tile sees itself and its neighbours', () => {
    expect(hasLineOfSight(area, { x: 2, y: 2 }, { x: 2, y: 2 })).toBe(true);
    expect(hasLineOfSight(area, { x: 3, y: 2 }, { x: 3, y: 3 })).toBe(true);
  });
});
