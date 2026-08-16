import { describe, expect, it } from 'vitest';
import { TILE_SECONDS, isMoving, stepToward } from '../src/game/interpolation';

describe('movement interpolation (D-104)', () => {
  it('crosses one tile in roughly the server cooldown window', () => {
    const render = { x: 0, y: 0 };
    const target = { x: 1, y: 0 };
    let elapsed = 0;
    const dt = 1 / 60;
    while (isMoving(render, target) && elapsed < 2) {
      stepToward(render, target, dt);
      elapsed += dt;
    }
    expect(render).toEqual(target);
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
