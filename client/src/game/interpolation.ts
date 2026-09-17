import { WALK_SPEED, speedFor } from '@rc/shared';

/**
 * Client-side interpolation of server-authoritative positions (D-104, D-567).
 * The server moves entities in metres at 10Hz; the client glides the visual
 * toward the authoritative point so movement reads as continuous. The render
 * position is presentation only — it never feeds back into game state (D-102).
 *
 * Pure module: testable headlessly.
 */

/**
 * How long after the last position change a character is still "walking".
 *
 * ⚠ This exists because "is it moving" CANNOT be answered by comparing the
 * render position to the target. Under D-567 the server sends a new position
 * every tick and the client glides at the same speed, so the gap closes to
 * nothing just before each update and opens again just after — the answer
 * flickered false ten times a second, and the walk animation restarted every
 * time. What it looked like in play was a character resetting its stride
 * several times a second while walking in a straight line.
 *
 * Longer than a server tick (100ms) so an ordinary gap between updates never
 * reads as a stop, and short enough that stopping looks immediate.
 */
export const MOVE_GRACE_MS = 260;

/**
 * Seconds to cross a metre — the speed we glide at.
 *
 * ⚠ Derived from the server's own `WALK_SPEED` (D-567). It used to be
 * `MOVE_COOLDOWN_TICKS × TICK_MS`, a movement cooldown the server no longer
 * has, and the two were equal only by coincidence. Left alone it would have
 * looked perfect until the first time walking pace was tuned — and then every
 * character would glide at the old speed, arriving visibly before or after the
 * position the server reported, which reads as lag rather than as a constant.
 */
export const TILE_SECONDS = 1 / WALK_SPEED;

/**
 * Seconds to cross a metre at a RUN (D-619).
 *
 * ⚠ The glide has to know about the run or it is not presentation any
 * more. The server moves a fighting body at `RUN_SPEED` and reports the new
 * position every tick; a client gliding at walking pace closes less ground
 * each tick than arrives, so the visual falls steadily behind until the
 * catch-up factor stops it about a metre back. What that looks like is the
 * character sliding along a step behind their own sword.
 */
export const RUN_SECONDS = 1 / speedFor(true);

/** Beyond this many tiles of error, snap instead of glide (area change,
 * teleport, or resync — gliding across the map would look absurd). */
const SNAP_DISTANCE = 2.5;

export interface InterpolatedPosition {
  x: number;
  y: number;
  /** When the authoritative position last changed. See `MOVE_GRACE_MS`. */
  movedAt?: number;
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
  /** Seconds per metre. Defaults to a walk; a fighter passes `RUN_SECONDS`. */
  secondsPerMetre: number = TILE_SECONDS,
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
  const speed = (1 / secondsPerMetre) * (dist > 1 ? 1 + (dist - 1) * 0.8 : 1);
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
/**
 * Note that the authoritative position has changed.
 *
 * Called when a new target arrives, which is what "moving" actually means —
 * not whether the visual has caught up with it yet.
 */
export function markMoved(render: InterpolatedPosition, now: number): void {
  render.movedAt = now;
}

export function isMoving(
  render: InterpolatedPosition,
  target: { x: number; y: number },
  now?: number,
): boolean {
  // Still catching up: unambiguously moving.
  if (Math.hypot(target.x - render.x, target.y - render.y) > 0.01) return true;
  // Caught up, but the server moved us a moment ago — which happens between
  // every pair of updates at walking pace. Without this the walk animation
  // restarts ten times a second.
  if (now === undefined || render.movedAt === undefined) return false;
  return now - render.movedAt < MOVE_GRACE_MS;
}
