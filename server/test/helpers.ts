import { AreaSchema, type AreaDef } from '@rc/shared';

/** 8×8 test arena: border walls, one interior wall column at x=4 (rows 2–5). */
export function tinyArea(): AreaDef {
  return AreaSchema.parse({
    id: 'tiny-test',
    name: 'Tiny Test Arena',
    width: 8,
    height: 8,
    legend: {
      '#': { walkable: false, kind: 'wall' },
      '.': { walkable: true, kind: 'floor' },
    },
    tiles: [
      '########',
      '#......#',
      '#...#..#',
      '#...#..#',
      '#...#..#',
      '#...#..#',
      '#......#',
      '########',
    ],
    spawn: { x: 1, y: 1 },
  });
}
