import { MOVE_COOLDOWN_TICKS, TICK_MS } from '@rc/shared';

/**
 * Client-side interpolation of server-authoritative tile positions (D-104).
 * The server steps entities one tile per cooldown window at 10Hz; the client
 * glides the visual toward the authoritative tile so movement reads as
 * continuous. The render position is presentation only — it never feeds back
 * into game state (D-102).
 *
 * Pure module: testable headlessly.
 */

/** Seconds the server takes to cross one tile — the speed we glide at. */
export const TILE_SECONDS = (MOVE_COOLDOWN_TICKS * TICK_MS) / 1000;

/** Beyond this many tiles of error, snap instead of glide (area change,
 * teleport, or resync — gliding across the map would look absurd). */
const SNAP_DISTANCE = 2.5;

export interface InterpolatedPosition {
  x: number;
  y: number;
}

/**
 * Moves `render` toward `target` (tile coords) by up to dt's worth of tile
 * speed, with a mild catch-up factor so a stream of steps never falls
 * cumulatively behind. Mutates and returns `render`.
 */
export function stepToward(
  render: InterpolatedPosition,
  target: { x: number; y: number },
  dt: number,
): InterpolatedPosition {
  const dx = target.x - render.x;
  const dy = target.y - render.y;
  const dist = Math.hypot(dx, dy);
  if (dist === 0) return render;
  if (dist > SNAP_DISTANCE) {
    render.x = target.x;
    render.y = target.y;
    return render;
  }
  // Base speed crosses one tile in TILE_SECONDS; scale up slightly when
  // behind by more than a tile (diagonals, queued steps).
  const speed = (1 / TILE_SECONDS) * (dist > 1 ? 1 + (dist - 1) * 0.8 : 1);
  const step = speed * dt;
  if (step >= dist) {
    render.x = target.x;
    render.y = target.y;
  } else {
    render.x += (dx / dist) * step;
    render.y += (dy / dist) * step;
  }
  return render;
}

/** True when the visual should play the walk animation. */
export function isMoving(render: InterpolatedPosition, target: { x: number; y: number }): boolean {
  return Math.hypot(target.x - render.x, target.y - render.y) > 0.01;
}
