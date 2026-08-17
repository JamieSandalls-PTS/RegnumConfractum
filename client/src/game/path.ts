import type { Direction } from '@rc/shared';

/**
 * Client-side A* over the area grid for click-to-move. Movement rules mirror
 * World.moveTarget exactly — 8-way, diagonals may not cut corners — so a
 * found path is a path the server will accept step by step. The server stays
 * authoritative: this only chooses which intents to send (D-102).
 *
 * Pure module: no Three.js, no DOM — testable headlessly (D-114).
 */

export interface PathGrid {
  width: number;
  height: number;
  walkable(x: number, y: number): boolean;
}

interface Step {
  dx: number;
  dy: number;
  dir: Direction;
  cost: number;
}

const STEPS: Step[] = [
  { dx: 0, dy: -1, dir: 'n', cost: 1 },
  { dx: 1, dy: -1, dir: 'ne', cost: Math.SQRT2 },
  { dx: 1, dy: 0, dir: 'e', cost: 1 },
  { dx: 1, dy: 1, dir: 'se', cost: Math.SQRT2 },
  { dx: 0, dy: 1, dir: 's', cost: 1 },
  { dx: -1, dy: 1, dir: 'sw', cost: Math.SQRT2 },
  { dx: -1, dy: 0, dir: 'w', cost: 1 },
  { dx: -1, dy: -1, dir: 'nw', cost: Math.SQRT2 },
];

/** Octile distance — admissible for 8-way movement with √2 diagonals. */
function heuristic(x0: number, y0: number, x1: number, y1: number): number {
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
}

/**
 * Finds a step-by-step direction list from (sx,sy) to (tx,ty), or null when
 * unreachable. Bounded by an explored-node cap so a click on the far side of
 * a sealed wall fails fast instead of flooding the map.
 */
export function findPath(
  grid: PathGrid,
  sx: number,
  sy: number,
  tx: number,
  ty: number,
  maxNodes = 4000,
): Direction[] | null {
  if (sx === tx && sy === ty) return [];
  if (!grid.walkable(tx, ty)) return null;
  const key = (x: number, y: number) => y * grid.width + x;

  const gScore = new Map<number, number>();
  const cameFrom = new Map<number, { from: number; dir: Direction }>();
  // Simple binary-ish open list: sorted insert is fine at these map sizes.
  const open: { k: number; x: number; y: number; f: number }[] = [];
  gScore.set(key(sx, sy), 0);
  open.push({ k: key(sx, sy), x: sx, y: sy, f: heuristic(sx, sy, tx, ty) });
  let explored = 0;

  while (open.length > 0 && explored < maxNodes) {
    let bestIdx = 0;
    for (let i = 1; i < open.length; i++) {
      if (open[i]!.f < open[bestIdx]!.f) bestIdx = i;
    }
    const cur = open.splice(bestIdx, 1)[0]!;
    explored++;
    if (cur.x === tx && cur.y === ty) {
      const dirs: Direction[] = [];
      let k = cur.k;
      while (k !== key(sx, sy)) {
        const link = cameFrom.get(k)!;
        dirs.push(link.dir);
        k = link.from;
      }
      return dirs.reverse();
    }
    const curG = gScore.get(cur.k)!;
    for (const step of STEPS) {
      const nx = cur.x + step.dx;
      const ny = cur.y + step.dy;
      if (!grid.walkable(nx, ny)) continue;
      // Diagonals may not cut corners — the server's rule, mirrored.
      if (step.dx !== 0 && step.dy !== 0 &&
          (!grid.walkable(cur.x + step.dx, cur.y) || !grid.walkable(cur.x, cur.y + step.dy))) {
        continue;
      }
      const nk = key(nx, ny);
      const g = curG + step.cost;
      if (g >= (gScore.get(nk) ?? Infinity)) continue;
      gScore.set(nk, g);
      cameFrom.set(nk, { from: cur.k, dir: step.dir });
      open.push({ k: nk, x: nx, y: ny, f: g + heuristic(nx, ny, tx, ty) });
    }
  }
  return null;
}
