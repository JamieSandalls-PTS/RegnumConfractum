import { describe, expect, it } from 'vitest';
import {
  BODY_HEIGHT,
  CollisionLayerSchema,
  MAX_DROP,
  STEP_UP,
  VolumeSchema,
  canOccupy,
  distance,
  distanceToShape,
  polygonContains,
  rectCorners,
  segmentHitsShape,
  shapeContains,
  sightBlocked,
  standingHeight,
  stepTo,
  surfaceHeight,
  type CollisionLayer,
  type Volume,
} from '../src/collision';

/**
 * The collision layer (D-567).
 *
 * ⚠ These tests are the only correctness gate on the thing that replaced the
 * tile grid (D-114). The four behaviours in the "one rule" table are asserted
 * individually and then against each other, because the failure that matters
 * is not "a wall does not block" — it is a wall blocking and an arch blocking
 * too, which reads as the system working.
 */

const ROOM: CollisionLayer['bounds'] = [
  { x: 0, y: 0 },
  { x: 20, y: 0 },
  { x: 20, y: 20 },
  { x: 0, y: 20 },
];

function layer(...volumes: Volume[]): CollisionLayer {
  return CollisionLayerSchema.parse({ bounds: ROOM, volumes });
}

function vol(raw: unknown): Volume {
  return VolumeSchema.parse(raw);
}

const GROUND = { pos: { x: 5, y: 5 }, z: 0 };

describe('geometry', () => {
  it('rotates a rect about its centre, not its corner', () => {
    const corners = rectCorners({ kind: 'rect', x: 10, y: 10, w: 4, h: 2, rotation: 90 });
    // Turning a 4×2 about its centre gives a 2×4 in the same place.
    const xs = corners.map((c) => c.x);
    const ys = corners.map((c) => c.y);
    expect(Math.min(...xs)).toBeCloseTo(9, 6);
    expect(Math.max(...xs)).toBeCloseTo(11, 6);
    expect(Math.min(...ys)).toBeCloseTo(8, 6);
    expect(Math.max(...ys)).toBeCloseTo(12, 6);
  });

  it('tests a rotated rect in its own frame', () => {
    const r = { kind: 'rect', x: 0, y: 0, w: 10, h: 1, rotation: 45 } as const;
    expect(shapeContains(r, { x: 3, y: 3 })).toBe(true);
    expect(shapeContains(r, { x: 3, y: -3 })).toBe(false);
  });

  it('measures distance to a shape as zero inside it', () => {
    const c = { kind: 'circle', x: 0, y: 0, r: 2 } as const;
    expect(distanceToShape(c, { x: 1, y: 0 })).toBe(0);
    expect(distanceToShape(c, { x: 5, y: 0 })).toBeCloseTo(3, 6);
  });

  it('does not count a vertex twice when a ray grazes it', () => {
    const tri = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 2, y: 4 },
    ];
    expect(polygonContains(tri, { x: 2, y: 1 })).toBe(true);
    expect(polygonContains(tri, { x: 2, y: 5 })).toBe(false);
    // The ray from this point passes exactly through the apex.
    expect(polygonContains(tri, { x: -1, y: 4 })).toBe(false);
  });

  it('finds a segment that crosses a shape without either end inside it', () => {
    const wall = { kind: 'rect', x: 10, y: 10, w: 6, h: 0.4, rotation: 0 } as const;
    expect(segmentHitsShape(wall, { x: 10, y: 5 }, { x: 10, y: 15 })).toBe(true);
    expect(segmentHitsShape(wall, { x: 0, y: 5 }, { x: 0, y: 15 })).toBe(false);
  });
});

describe('the one rule produces four behaviours', () => {
  it('a kerb is walked OVER, and the feet end up on top of it', () => {
    const kerb = vol({ shape: { kind: 'rect', x: 5, y: 8, w: 6, h: 1 }, top: 0.15, walkable: true });
    const after = stepTo(layer(kerb), GROUND, { x: 5, y: 8 });
    expect(after).not.toBeNull();
    expect(after!.z).toBeCloseTo(0.15, 6);
  });

  it('a wall BLOCKS', () => {
    const wall = vol({ shape: { kind: 'rect', x: 5, y: 8, w: 6, h: 0.4 }, top: 3 });
    expect(stepTo(layer(wall), GROUND, { x: 5, y: 8 })).toBeNull();
  });

  it('an arch is walked UNDER', () => {
    const arch = vol({ shape: { kind: 'rect', x: 5, y: 8, w: 6, h: 3 }, base: 2.4, top: 4 });
    const after = stepTo(layer(arch), GROUND, { x: 5, y: 8 });
    expect(after).not.toBeNull();
    expect(after!.z).toBe(0);
  });

  it('a stair is walked UP, one step at a time', () => {
    // Six metres long, climbing 2.4m — a real staircase, at 30 cm a stride.
    const stair = vol({
      shape: { kind: 'rect', x: 10, y: 10, w: 2, h: 6 },
      top: 2.4,
      walkable: true,
      ramp: { along: 'y', low: 0, high: 2.4 },
    });
    const l = layer(stair);
    let at = { pos: { x: 10, y: 7 }, z: 0 };
    // ⚠ Counted, not accumulated: `y += 0.3` drifts to 13.000000000000004 and
    // stops one stride short of the top, which looks like the ramp failing.
    for (let i = 1; i <= 20; i++) {
      const y = 7 + (i * 6) / 20;
      const next = stepTo(l, at, { x: 10, y });
      expect(next, `stalled at y=${y.toFixed(2)}, feet ${at.z.toFixed(2)}m`).not.toBeNull();
      at = next!;
    }
    expect(at.z).toBeCloseTo(2.4, 6);
  });

  it('⚠ the same stair, jumped at from the side, refuses at the top', () => {
    // The failure this guards: a ramp that can be climbed one step at a time
    // must not also be a lift you step onto sideways at full height.
    const stair = vol({
      shape: { kind: 'rect', x: 10, y: 10, w: 2, h: 6 },
      top: 2.4,
      walkable: true,
      ramp: { along: 'y', low: 0, high: 2.4 },
    });
    expect(stepTo(layer(stair), { pos: { x: 8, y: 12.5 }, z: 0 }, { x: 10, y: 12.5 })).toBeNull();
  });
});

describe('height rules', () => {
  const platform = vol({ shape: { kind: 'rect', x: 10, y: 10, w: 6, h: 6 }, top: 2, walkable: true });

  it('a platform cannot be walked onto from the ground', () => {
    expect(stepTo(layer(platform), GROUND, { x: 10, y: 10 })).toBeNull();
  });

  it('standing height never exceeds one step up', () => {
    expect(standingHeight(layer(platform), { x: 10, y: 10 }, 0)).toBe(0);
    expect(standingHeight(layer(platform), { x: 10, y: 10 }, 2)).toBe(2);
    expect(standingHeight(layer(platform), { x: 10, y: 10 }, 2 - STEP_UP)).toBe(2);
  });

  it('a drop beyond MAX_DROP refuses — a cliff is a boundary', () => {
    const l = layer(platform);
    // Standing on the platform at 2m, the ground is a 2m fall.
    expect(MAX_DROP).toBeLessThan(2);
    expect(stepTo(l, { pos: { x: 10, y: 10 }, z: 2 }, { x: 10, y: 14 })).toBeNull();
  });

  it('a drop within MAX_DROP is allowed, and the feet land on the floor', () => {
    const ledge = vol({ shape: { kind: 'rect', x: 10, y: 10, w: 6, h: 6 }, top: 1, walkable: true });
    const after = stepTo(layer(ledge), { pos: { x: 10, y: 10 }, z: 1 }, { x: 10, y: 14 });
    expect(after).not.toBeNull();
    expect(after!.z).toBe(0);
  });

  it('a ramp surface is clamped at its ends, not extrapolated', () => {
    const ramp = vol({
      shape: { kind: 'rect', x: 0, y: 0, w: 2, h: 4 },
      top: 2,
      walkable: true,
      ramp: { along: 'y', low: 0, high: 2 },
    });
    expect(surfaceHeight(ramp, { x: 0, y: -2 })).toBeCloseTo(0, 6);
    expect(surfaceHeight(ramp, { x: 0, y: 0 })).toBeCloseTo(1, 6);
    expect(surfaceHeight(ramp, { x: 0, y: 2 })).toBeCloseTo(2, 6);
    expect(surfaceHeight(ramp, { x: 0, y: 40 })).toBeCloseTo(2, 6);
  });

  it('a ramp turned 90° still climbs its own length', () => {
    const flat = vol({
      shape: { kind: 'rect', x: 0, y: 0, w: 2, h: 4, rotation: 0 },
      top: 2,
      walkable: true,
      ramp: { along: 'y', low: 0, high: 2 },
    });
    const turned = vol({
      shape: { kind: 'rect', x: 0, y: 0, w: 2, h: 4, rotation: 90 },
      top: 2,
      walkable: true,
      ramp: { along: 'y', low: 0, high: 2 },
    });
    // The turned ramp's uphill direction is now -x, so the point that was
    // halfway up is still halfway up after the same rotation.
    expect(surfaceHeight(flat, { x: 0, y: 1 })).toBeCloseTo(1.5, 6);
    expect(surfaceHeight(turned, { x: -1, y: 0 })).toBeCloseTo(1.5, 6);
  });

  it('an unwalkable top is never a surface — you pass over it, never onto it', () => {
    // ⚠ Below a step, `walkable` decides where your FEET end up, not whether
    // you may go. A 30cm lip you cannot stand on is something you step over,
    // and the feet stay on the floor.
    const lip = vol({
      shape: { kind: 'rect', x: 10, y: 10, w: 2, h: 2 },
      top: 0.3,
      walkable: false,
    });
    const over = stepTo(layer(lip), GROUND, { x: 10, y: 10 });
    expect(over).not.toBeNull();
    expect(over!.z).toBe(0);
  });

  it('and above a step, an unwalkable top blocks', () => {
    const spikes = vol({
      shape: { kind: 'rect', x: 10, y: 10, w: 2, h: 2 },
      top: 0.8,
      walkable: false,
    });
    expect(stepTo(layer(spikes), GROUND, { x: 10, y: 10 })).toBeNull();
  });

  it('a ramp nobody can stand on is refused as a contradiction', () => {
    expect(() =>
      vol({
        shape: { kind: 'rect', x: 0, y: 0, w: 2, h: 4 },
        top: 2,
        walkable: false,
        ramp: { along: 'y', low: 0, high: 2 },
      }),
    ).toThrow(/not a ramp/);
  });
});

describe('a doorway is passable, which is what tiles could not express', () => {
  // Two jambs 0.9m apart in a 6m wall — the shape of every door frame in the
  // packs, and the exact case that had 3×1 door assets sealing their own
  // openings.
  const jambs = [
    vol({ shape: { kind: 'rect', x: 8.3, y: 10, w: 2.6, h: 0.4 }, top: 3, opaque: true }),
    vol({ shape: { kind: 'rect', x: 11.7, y: 10, w: 2.6, h: 0.4 }, top: 3, opaque: true }),
  ];
  const l = layer(...jambs);

  it('a body fits through the gap', () => {
    const after = stepTo(l, { pos: { x: 10, y: 8 }, z: 0 }, { x: 10, y: 10 });
    expect(after).not.toBeNull();
  });

  it('and does not fit through the wall either side of it', () => {
    expect(stepTo(l, { pos: { x: 8, y: 8 }, z: 0 }, { x: 8, y: 10 })).toBeNull();
    expect(stepTo(l, { pos: { x: 12, y: 8 }, z: 0 }, { x: 12, y: 10 })).toBeNull();
  });

  it('and a gap narrower than a body refuses', () => {
    const tight = layer(
      vol({ shape: { kind: 'rect', x: 8.75, y: 10, w: 3.5, h: 0.4 }, top: 3 }),
      vol({ shape: { kind: 'rect', x: 11.25, y: 10, w: 3.5, h: 0.4 }, top: 3 }),
    );
    // 0.5m clear — narrower than the 0.6m body.
    expect(stepTo(tight, { pos: { x: 10, y: 8 }, z: 0 }, { x: 10, y: 10 })).toBeNull();
  });
});

describe('bounds', () => {
  it('outside the polygon is outside the map', () => {
    expect(canOccupy(layer(), { x: 10, y: 10 }, 0)).toBe(true);
    expect(canOccupy(layer(), { x: 21, y: 10 }, 0)).toBe(false);
    expect(canOccupy(layer(), { x: -1, y: 10 }, 0)).toBe(false);
  });

  it('a non-rectangular area is expressible at all', () => {
    const wedge = CollisionLayerSchema.parse({
      bounds: [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 0, y: 20 },
      ],
    });
    expect(canOccupy(wedge, { x: 2, y: 2 }, 0)).toBe(true);
    expect(canOccupy(wedge, { x: 18, y: 18 }, 0)).toBe(false);
  });
});

describe('sight is separate from passage (D-217)', () => {
  it('a rail stops a body and not an eye', () => {
    const rail = vol({ shape: { kind: 'rect', x: 10, y: 10, w: 8, h: 0.3 }, top: 1, opaque: false });
    const l = layer(rail);
    expect(stepTo(l, { pos: { x: 10, y: 8 }, z: 0 }, { x: 10, y: 10 })).toBeNull();
    expect(sightBlocked(l, { x: 10, y: 6 }, { x: 10, y: 14 })).toBe(false);
  });

  it('a thicket stops an eye and not a body', () => {
    // ⚠ This is the test that added `sightTop`. Written first as a volume from
    // 0.4m to 2.5m — which the model correctly REFUSED to let anyone walk
    // through, because something at shin height does stop a body. Undergrowth
    // you push through is low enough to walk on and tall enough to hide in,
    // and those are two different numbers.
    const thicket = vol({
      shape: { kind: 'circle', x: 10, y: 10, r: 2 },
      top: 0.25,
      opaque: true,
      sightTop: 2.2,
    });
    const l = layer(thicket);
    expect(stepTo(l, { pos: { x: 10, y: 6 }, z: 0 }, { x: 10, y: 10 })).not.toBeNull();
    expect(sightBlocked(l, { x: 10, y: 5 }, { x: 10, y: 15 })).toBe(true);
  });

  it('⚠ a body at shin height is NOT walked through — the geometry decides', () => {
    // The rejected first draft of the thicket, kept as an assertion: passage
    // stays an outcome of shape, and `sightTop` cannot be used to smuggle in a
    // solid you can walk through.
    const shin = vol({ shape: { kind: 'circle', x: 10, y: 10, r: 2 }, base: 0.4, top: 2.5 });
    expect(stepTo(layer(shin), { pos: { x: 10, y: 6 }, z: 0 }, { x: 10, y: 10 })).toBeNull();
  });

  it('an eye stopped lower than a body is refused as a spelling of opaque:false', () => {
    expect(() =>
      vol({ shape: { kind: 'rect', x: 0, y: 0, w: 2, h: 2 }, top: 3, opaque: true, sightTop: 1 }),
    ).toThrow(/opaque: false/);
  });

  it('an eye passes over a low wall and under an arch', () => {
    const low = vol({ shape: { kind: 'rect', x: 10, y: 10, w: 8, h: 0.4 }, top: 1.1, opaque: true });
    const arch = vol({
      shape: { kind: 'rect', x: 10, y: 10, w: 8, h: 0.4 },
      base: 2.4,
      top: 4,
      opaque: true,
    });
    expect(sightBlocked(layer(low), { x: 10, y: 5 }, { x: 10, y: 15 })).toBe(false);
    expect(sightBlocked(layer(arch), { x: 10, y: 5 }, { x: 10, y: 15 })).toBe(false);
  });

  it('a full wall stops both', () => {
    const wall = vol({ shape: { kind: 'rect', x: 10, y: 10, w: 8, h: 0.4 }, top: 3, opaque: true });
    const l = layer(wall);
    expect(stepTo(l, { pos: { x: 10, y: 8 }, z: 0 }, { x: 10, y: 10 })).toBeNull();
    expect(sightBlocked(l, { x: 10, y: 5 }, { x: 10, y: 15 })).toBe(true);
  });
});

describe('the schema refuses what cannot be drawn', () => {
  it('a top below its base', () => {
    expect(() => vol({ shape: { kind: 'circle', x: 0, y: 0, r: 1 }, base: 2, top: 1 })).toThrow();
  });

  it('a ramp on a circle, which has no axis to run along', () => {
    expect(() =>
      vol({
        shape: { kind: 'circle', x: 0, y: 0, r: 1 },
        top: 2,
        ramp: { along: 'x', low: 0, high: 2 },
      }),
    ).toThrow(/no local axis/);
  });

  it('a ramp authored downhill — turn the shape instead', () => {
    expect(() =>
      vol({
        shape: { kind: 'rect', x: 0, y: 0, w: 2, h: 2 },
        top: 2,
        ramp: { along: 'x', low: 2, high: 0 },
      }),
    ).toThrow(/downhill/);
  });
});

describe('distance is Euclidean, in metres', () => {
  it('⚠ a diagonal neighbour is 1.41m, not 1 — every range constant re-tunes', () => {
    expect(distance({ x: 0, y: 0 }, { x: 1, y: 1 })).toBeCloseTo(Math.SQRT2, 6);
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });

  it('a body is shorter than a arch is high, or nothing walks under anything', () => {
    expect(BODY_HEIGHT).toBeLessThan(2.4);
  });
});
