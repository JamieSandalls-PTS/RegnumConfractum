import { describe, expect, it } from 'vitest';
import { WALK_SPEED } from '@rc/shared';
import {
  MOVE_GRACE_MS,
  TILE_SECONDS,
  isMoving,
  markMoved,
  stepToward,
} from '../src/game/interpolation';

describe('movement interpolation (D-104)', () => {
  it('crosses a metre in roughly the time the server takes to walk one', () => {
    const render = { x: 0, y: 0 };
    const target = { x: 1, y: 0 };
    let elapsed = 0;
    const dt = 1 / 60;
    while (isMoving(render, target) && elapsed < 2) {
      stepToward(render, target, dt);
      elapsed += dt;
    }
    // ⚠ Close, not equal. The glide stops within a centimetre of the target,
    // and whether it lands exactly on it depends on the step dividing evenly
    // into the distance — which it did at the old walk speed and stopped doing
    // the moment that number was tuned (D-567).
    expect(render.x).toBeCloseTo(target.x, 1);
    expect(render.y).toBeCloseTo(target.y, 6);
    expect(elapsed).toBeGreaterThan(TILE_SECONDS * 0.8);
    expect(elapsed).toBeLessThan(TILE_SECONDS * 1.3);
  });

  it('never overshoots the target', () => {
    const render = { x: 0, y: 0 };
    for (let i = 0; i < 200; i++) {
      stepToward(render, { x: 1, y: 1 }, 1 / 30);
      expect(render.x).toBeLessThanOrEqual(1);
      expect(render.y).toBeLessThanOrEqual(1);
    }
    expect(render).toEqual({ x: 1, y: 1 });
  });

  it('snaps across large discontinuities instead of gliding', () => {
    const render = { x: 0, y: 0 };
    stepToward(render, { x: 20, y: 20 }, 1 / 60);
    expect(render).toEqual({ x: 20, y: 20 });
  });

  it('catches up when more than a tile behind', () => {
    const dt = 0.05;
    const farMoved = stepToward({ x: 0, y: 0 }, { x: 2, y: 0 }, dt).x;
    const nearMoved = stepToward({ x: 1, y: 0 }, { x: 2, y: 0 }, dt).x - 1;
    // An entity two tiles behind must close distance faster than one a tile behind.
    expect(farMoved).toBeGreaterThan(nearMoved);
  });

  it('is stationary at the target', () => {
    const render = { x: 3, y: 4 };
    expect(isMoving(render, { x: 3, y: 4 })).toBe(false);
    stepToward(render, { x: 3, y: 4 }, 0.1);
    expect(render).toEqual({ x: 3, y: 4 });
  });
});

/**
 * "Is it moving" asks the wrong question, and these pin down the right one.
 *
 * ⚠ Written after a report from play that the walk animation resets several
 * times a second. I could NOT reproduce that from the position-gap test alone
 * — simulated at fixed and at jittered frame rates, the gap never read as zero
 * mid-walk — so this does not claim to be that bug's fix. What it does assert
 * is the property that matters either way: a character the server is still
 * moving must read as walking, whether or not the visual has caught up. The
 * old test could only answer the second question.
 */
describe('walking is decided by the SERVER moving you, not by catching up', () => {
  const TICK_MS = 100;
  const STEP = WALK_SPEED / 10; // one tick of walking, in metres

  /**
   * Walk for two seconds at the pace the server sends.
   *
   * ⚠ With JITTERED frame times, which is the whole point. At a clean 60fps
   * the render position never quite lands on the target and the flicker does
   * not appear — the first version of this test used a fixed dt, failed to
   * reproduce the bug, and would have let a fix ship on a guess. Real frames
   * vary, `stepToward` snaps whenever one step covers the remaining gap, and
   * that is when the gap reads as zero.
   */
  function run(useGrace: boolean): { frames: number; stopped: number } {
    const render = { x: 0, y: 0 } as { x: number; y: number; movedAt?: number };
    let target = { x: 0, y: 0 };
    let now = 0;
    let nextTick = TICK_MS;
    let frames = 0;
    let stopped = 0;
    let seed = 12345;
    const jitter = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return 11 + (seed % 10); // 11-20ms, i.e. 50-90fps
    };
    while (now < 2000) {
      const dtMs = jitter();
      now += dtMs;
      if (now >= nextTick) {
        target = { x: target.x + STEP, y: 0 };
        markMoved(render, now);
        nextTick += TICK_MS;
      }
      const moving = isMoving(render, target, useGrace ? now : undefined);
      stepToward(render, target, dtMs / 1000);
      // ⚠ Counted only once walking has STARTED. Before the first update the
      // character genuinely is standing still, and including those frames
      // made the fixed version look broken.
      if (render.movedAt !== undefined) {
        frames++;
        if (!moving) stopped++;
      }
    }
    return { frames, stopped };
  }

  it('reports a continuous stream of updates as continuous walking', () => {
    expect(run(true).stopped, 'the walk was reported as stopped mid-stride').toBe(0);
  });


  it('still stops when the server stops moving you', () => {
    const render = { x: 5, y: 5, movedAt: 0 };
    // Well past the grace window, and already caught up.
    expect(isMoving(render, { x: 5, y: 5 }, MOVE_GRACE_MS + 50)).toBe(false);
  });
});
