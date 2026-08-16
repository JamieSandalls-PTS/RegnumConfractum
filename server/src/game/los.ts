import { isTileOpaque, type AreaDef, type Vec2 } from '@rc/shared';

/**
 * Tile line of sight for proximity channels (M2) and later for Perception
 * contests (D-217, D-223). Bresenham between centres; opaque tiles block.
 * Endpoints never block (you can always see out of your own tile). On exact
 * diagonal steps, sight is blocked only if BOTH flanking orthogonal tiles
 * are opaque — peeking through a wall corner gap is allowed, matching the
 * movement rule's spirit without being stricter than it.
 */

export function hasLineOfSight(area: AreaDef, from: Vec2, to: Vec2): boolean {
  const opaque = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= area.width || y >= area.height) return true;
    const ch = area.tiles[y]![x]!;
    return isTileOpaque(area.legend[ch]!);
  };

  let x = from.x;
  let y = from.y;
  const dx = Math.abs(to.x - from.x);
  const dy = Math.abs(to.y - from.y);
  const sx = from.x < to.x ? 1 : -1;
  const sy = from.y < to.y ? 1 : -1;
  let err = dx - dy;

  while (x !== to.x || y !== to.y) {
    const e2 = 2 * err;
    let steppedX = false;
    let steppedY = false;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
      steppedX = true;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
      steppedY = true;
    }
    if (steppedX && steppedY) {
      if (opaque(x - sx, y) && opaque(x, y - sy)) return false;
    }
    if (x === to.x && y === to.y) break; // target tile itself never blocks
    if (opaque(x, y)) return false;
  }
  return true;
}
