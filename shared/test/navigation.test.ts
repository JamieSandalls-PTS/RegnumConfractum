import { describe, expect, it } from 'vitest';
import {
  CollisionLayerSchema,
  Nav,
  STEP_UP,
  VolumeSchema,
  distance,
  stepTo,
  type CollisionLayer,
  type Vec2,
  type Volume,
} from '../src/index';

/**
 * Finding a way through (D-567).
 *
 * ⚠ The assertion that matters most is not "a path exists". It is that **every
 * path the pathfinder returns is one a body can actually walk** — checked by
 * walking it with `stepTo`, the same function the server will use. A path that
 * clips a corner or climbs a wall does not throw; it produces a character
 * sliding through masonry, and the report is "the game is broken" three weeks
 * later.
 */

function vol(raw: unknown): Volume {
  return VolumeSchema.parse(raw);
}

function room(...volumes: Volume[]): CollisionLayer {
  return CollisionLayerSchema.parse({
    bounds: [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 20 },
      { x: 0, y: 20 },
    ],
    volumes,
  });
}

/**
 * Walk a returned path with the collision model and report where it fails.
 *
 * ⚠ Sampled far finer than the path's own corners, because the failure this
 * catches is a straight run between two legal points that passes through
 * something in between.
 */
function walkable(layer: CollisionLayer, path: readonly Vec2[]): string | null {
  let at = { pos: path[0]!, z: 0 };
  for (let leg = 1; leg < path.length; leg++) {
    const a = path[leg - 1]!;
    const b = path[leg]!;
    const steps = Math.max(1, Math.ceil(distance(a, b) / 0.1));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const to = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      const next = stepTo(layer, at, to);
      if (!next) {
        return `leg ${leg} blocked at (${to.x.toFixed(2)}, ${to.y.toFixed(2)})`;
      }
      at = next;
    }
  }
  return null;
}

describe('the index itself', () => {
  it('opens every cell of an empty room', () => {
    const nav = new Nav(room());
    expect(nav.openCells).toBe(nav.cols * nav.rows);
  });

  it('closes the cells a wall stands in, plus a body radius around it', () => {
    const wall = vol({ shape: { kind: 'rect', x: 10, y: 10, w: 10, h: 0.4 }, top: 3 });
    const nav = new Nav(room(wall));
    expect(nav.passable(nav.cellOf({ x: 10, y: 10 }).i, nav.cellOf({ x: 10, y: 10 }).j)).toBe(false);
    // Half the wall thickness plus the body radius is 0.5m, so 0.4m out is
    // still shut and 0.8m out is open.
    const near = nav.cellOf({ x: 10, y: 10.4 });
    const clear = nav.cellOf({ x: 10, y: 10.8 });
    expect(nav.passable(near.i, near.j)).toBe(false);
    expect(nav.passable(clear.i, clear.j)).toBe(true);
  });

  it('⚠ sees a wall that has been ROTATED', () => {
    // A 0.4 × 12 wall turned a quarter runs east-west. Bucketed by its
    // unrotated width it lands in the wrong buckets and the pathfinder simply
    // cannot see it — a route straight through a wall, with no error anywhere.
    const turned = vol({
      shape: { kind: 'rect', x: 10, y: 10, w: 0.4, h: 12, rotation: 90 },
      top: 3,
    });
    const nav = new Nav(room(turned));
    const on = nav.cellOf({ x: 15, y: 10 });
    expect(nav.passable(on.i, on.j)).toBe(false);
  });

  it('records the height of a surface, not just that it is there', () => {
    const step = vol({ shape: { kind: 'rect', x: 10, y: 10, w: 4, h: 4 }, top: 0.3, walkable: true });
    const nav = new Nav(room(step));
    const c = nav.cellOf({ x: 10, y: 10 });
    expect(nav.heightAt(c.i, c.j)).toBeCloseTo(0.3, 5);
  });
});

describe('a path is something a body can actually walk', () => {
  it('crosses open ground in a straight line, not a staircase of cells', () => {
    const layer = room();
    const nav = new Nav(layer);
    const path = nav.path({ x: 2, y: 2 }, { x: 18, y: 18 })!;
    expect(path).not.toBeNull();
    // ⚠ Two points, not sixty-four. A path left as raw cells makes a character
    // zigzag across an empty field in 25cm steps — the grid showing through,
    // which is the thing D-567 exists to remove.
    expect(path.length).toBeLessThanOrEqual(2);
    expect(walkable(layer, [{ x: 2, y: 2 }, ...path])).toBeNull();
  });

  it('goes around a wall, and the whole route is walkable', () => {
    // A wall across most of the room, with a gap at the east end.
    const layer = room(vol({ shape: { kind: 'rect', x: 7, y: 10, w: 14, h: 0.4 }, top: 3 }));
    const nav = new Nav(layer);
    const path = nav.path({ x: 5, y: 4 }, { x: 5, y: 16 });
    expect(path).not.toBeNull();
    expect(walkable(layer, [{ x: 5, y: 4 }, ...path!])).toBeNull();
    // It must actually detour east past the wall's end at x=14.
    expect(Math.max(...path!.map((p) => p.x))).toBeGreaterThan(13.5);
  });

  it('threads a doorway', () => {
    const layer = room(
      vol({ shape: { kind: 'rect', x: 4.75, y: 10, w: 9.5, h: 0.4 }, top: 3 }),
      vol({ shape: { kind: 'rect', x: 15.25, y: 10, w: 9.5, h: 0.4 }, top: 3 }),
    );
    const nav = new Nav(layer);
    const path = nav.path({ x: 10, y: 4 }, { x: 10, y: 16 });
    expect(path, 'no way through a 1m doorway').not.toBeNull();
    expect(walkable(layer, [{ x: 10, y: 4 }, ...path!])).toBeNull();
  });

  it('⚠ refuses a gap narrower than a body rather than squeezing through it', () => {
    // 0.4m clear, against a 0.6m body. The path must fail, not thread it —
    // the client would then walk a route the server refuses, and the character
    // judders against the gap forever.
    const layer = room(
      vol({ shape: { kind: 'rect', x: 4.9, y: 10, w: 9.8, h: 0.4 }, top: 3 }),
      vol({ shape: { kind: 'rect', x: 15.1, y: 10, w: 9.8, h: 0.4 }, top: 3 }),
    );
    const nav = new Nav(layer);
    expect(nav.path({ x: 10, y: 4 }, { x: 10, y: 16 })).toBeNull();
  });

  it('⚠ never cuts the corner where two walls meet', () => {
    const layer = room(
      vol({ shape: { kind: 'rect', x: 5, y: 10, w: 10, h: 0.4 }, top: 3 }),
      vol({ shape: { kind: 'rect', x: 10, y: 5, w: 0.4, h: 10 }, top: 3 }),
    );
    const nav = new Nav(layer);
    const path = nav.path({ x: 4, y: 4 }, { x: 16, y: 16 });
    if (path) expect(walkable(layer, [{ x: 4, y: 4 }, ...path])).toBeNull();
  });

  it('returns null when there is genuinely no way', () => {
    const layer = room(
      vol({ shape: { kind: 'rect', x: 10, y: 10, w: 30, h: 0.4 }, top: 3 }),
    );
    const nav = new Nav(layer);
    expect(nav.path({ x: 10, y: 4 }, { x: 10, y: 16 })).toBeNull();
  });
});

describe('height decides where a path may go', () => {
  // ⚠ `walkable: true` is the whole point of a platform: it is a surface you
  // stand on, unreachable from the ground. Left at the default it is simply a
  // solid block, and "will not climb its side" would pass for the wrong reason.
  const platform = vol({
    shape: { kind: 'rect', x: 14, y: 10, w: 8, h: 8 },
    top: 2,
    walkable: true,
  });

  it('will not climb the side of a platform', () => {
    const nav = new Nav(room(platform));
    expect(nav.path({ x: 4, y: 10 }, { x: 14, y: 10 })).toBeNull();
  });

  it('finds the ramp when there is one, and the walk holds up', () => {
    const ramp = vol({
      shape: { kind: 'rect', x: 8, y: 10, w: 4, h: 3 },
      top: 2,
      walkable: true,
      ramp: { along: 'x', low: 0, high: 2 },
    });
    const layer = room(platform, ramp);
    const nav = new Nav(layer);
    const path = nav.path({ x: 4, y: 10 }, { x: 14, y: 10 });
    expect(path, 'the ramp was not used').not.toBeNull();
    expect(walkable(layer, [{ x: 4, y: 10 }, ...path!])).toBeNull();
  });

  it('walks over a kerb without treating it as a wall', () => {
    const layer = room(
      vol({ shape: { kind: 'rect', x: 10, y: 10, w: 14, h: 1 }, top: STEP_UP, walkable: true }),
    );
    const nav = new Nav(layer);
    const path = nav.path({ x: 10, y: 4 }, { x: 10, y: 16 });
    expect(path).not.toBeNull();
    expect(walkable(layer, [{ x: 10, y: 4 }, ...path!])).toBeNull();
  });

  it('walks UNDER an arch', () => {
    const layer = room(
      vol({ shape: { kind: 'rect', x: 10, y: 10, w: 14, h: 1 }, base: 2.4, top: 4 }),
    );
    const nav = new Nav(layer);
    const path = nav.path({ x: 10, y: 4 }, { x: 10, y: 16 })!;
    expect(path.length).toBeLessThanOrEqual(2);
    expect(walkable(layer, [{ x: 10, y: 4 }, ...path])).toBeNull();
  });
});

describe('the awkward ends of a path', () => {
  it('walks as close as it can to a point inside a wall', () => {
    const layer = room(vol({ shape: { kind: 'rect', x: 10, y: 10, w: 6, h: 6 }, top: 3 }));
    const nav = new Nav(layer);
    // Clicking the middle of a building must walk you to its wall, not do
    // nothing — "nothing happened" reads as a broken control.
    const path = nav.path({ x: 3, y: 3 }, { x: 10, y: 10 });
    expect(path).not.toBeNull();
    const end = path![path!.length - 1]!;
    expect(distance(end, { x: 10, y: 10 })).toBeLessThan(5);
    expect(walkable(layer, [{ x: 3, y: 3 }, ...path!])).toBeNull();
  });

  it('gets a body out of somewhere it should not be', () => {
    const layer = room(vol({ shape: { kind: 'rect', x: 10, y: 10, w: 6, h: 6 }, top: 3 }));
    const nav = new Nav(layer);
    expect(nav.path({ x: 10, y: 10 }, { x: 3, y: 3 })).not.toBeNull();
  });
});

describe('it is fast enough to run at load', () => {
  it('bakes a 100m area and paths across it', () => {
    const volumes: Volume[] = [];
    // A rough town: forty buildings on a 100×100 field.
    for (let i = 0; i < 40; i++) {
      volumes.push(
        vol({
          shape: {
            kind: 'rect',
            x: 8 + (i % 8) * 11,
            y: 8 + Math.floor(i / 8) * 18,
            w: 6,
            h: 6,
            rotation: (i * 17) % 90,
          },
          top: 4,
          opaque: true,
        }),
      );
    }
    const layer = CollisionLayerSchema.parse({
      bounds: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
        { x: 0, y: 100 },
      ],
      volumes,
    });
    const t0 = Date.now();
    const nav = new Nav(layer);
    const baked = Date.now() - t0;
    const t1 = Date.now();
    const path = nav.path({ x: 2, y: 2 }, { x: 98, y: 98 });
    const found = Date.now() - t1;
    expect(path).not.toBeNull();
    expect(walkable(layer, [{ x: 2, y: 2 }, ...path!])).toBeNull();
    // Generous bounds: this is a guard against an accidental quadratic, not a
    // performance target. Without the spatial hash the bake alone is minutes.
    expect(baked, `bake took ${baked}ms`).toBeLessThan(4000);
    expect(found, `path took ${found}ms`).toBeLessThan(1500);
  });
});
