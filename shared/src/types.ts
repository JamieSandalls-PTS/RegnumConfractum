export interface Vec2 {
  x: number;
  y: number;
}

export const DIRECTIONS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const;
export type Direction = (typeof DIRECTIONS)[number];

// Screen-space convention: +x east, +y south (row-major grids).
export const DIRECTION_VECTORS: Record<Direction, Vec2> = {
  n: { x: 0, y: -1 },
  ne: { x: 1, y: -1 },
  e: { x: 1, y: 0 },
  se: { x: 1, y: 1 },
  s: { x: 0, y: 1 },
  sw: { x: -1, y: 1 },
  w: { x: -1, y: 0 },
  nw: { x: -1, y: -1 },
};

export function isDiagonal(dir: Direction): boolean {
  const v = DIRECTION_VECTORS[dir];
  return v.x !== 0 && v.y !== 0;
}

export function chebyshev(a: Vec2, b: Vec2): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}
