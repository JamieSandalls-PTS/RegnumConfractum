import { describe, expect, it } from 'vitest';
import { DIRECTION_VECTORS } from '@rc/shared';
import { findPath, type PathGrid } from '../src/game/path';

/** Builds a grid from rows of '.' (walkable) and '#' (wall). */
function grid(rows: string[]): PathGrid {
  return {
    width: rows[0]!.length,
    height: rows.length,
    walkable: (x, y) =>
      x >= 0 && y >= 0 && y < rows.length && x < rows[0]!.length && rows[y]![x] === '.',
  };
}

/** Walks the returned dirs and asserts every step is legal, ending at target. */
function walk(g: PathGrid, sx: number, sy: number, dirs: ReturnType<typeof findPath>) {
  expect(dirs).not.toBeNull();
  let x = sx;
  let y = sy;
  for (const dir of dirs!) {
    const v = DIRECTION_VECTORS[dir];
    if (v.x !== 0 && v.y !== 0) {
      expect(g.walkable(x + v.x, y)).toBe(true);
      expect(g.walkable(x, y + v.y)).toBe(true);
    }
    x += v.x;
    y += v.y;
    expect(g.walkable(x, y)).toBe(true);
  }
  return { x, y };
}

describe('click-to-move pathfinding', () => {
  it('finds a straight path', () => {
    const g = grid(['.....', '.....', '.....']);
    const end = walk(g, 0, 0, findPath(g, 0, 0, 4, 2));
    expect(end).toEqual({ x: 4, y: 2 });
  });

  it('routes around walls', () => {
    const g = grid([
      '.....',
      '###..',
      '.....',
      '..###',
      '.....',
    ]);
    const end = walk(g, 0, 0, findPath(g, 0, 0, 0, 4));
    expect(end).toEqual({ x: 0, y: 4 });
  });

  it('never cuts corners diagonally (the server rule)', () => {
    const g = grid([
      '..#',
      '#..',
      '...',
    ]);
    // A naive diagonal from (1,0) to (2,1) would cut between two walls.
    const end = walk(g, 1, 0, findPath(g, 1, 0, 2, 2));
    expect(end).toEqual({ x: 2, y: 2 });
  });

  it('returns null for unreachable or unwalkable targets', () => {
    const g = grid([
      '..#..',
      '..#..',
      '..#..',
    ]);
    expect(findPath(g, 0, 0, 4, 0)).toBeNull(); // sealed off
    expect(findPath(g, 0, 0, 2, 1)).toBeNull(); // a wall itself
  });

  it('empty path for clicking your own tile', () => {
    const g = grid(['...']);
    expect(findPath(g, 1, 0, 1, 0)).toEqual([]);
  });
});
