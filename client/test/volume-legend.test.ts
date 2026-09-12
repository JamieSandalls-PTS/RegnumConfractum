import { describe, expect, it } from 'vitest';
import {
  CollisionLayerSchema,
  VolumeSchema,
  sightBlocked,
  stepTo,
  type CollisionLayer,
  type Volume,
} from '@rc/shared';
import { VOLUME_COLOURS, volumeColour } from '../src/render/volume-view';

/**
 * The collision overlay's legend must not lie (D-567).
 *
 * ⚠ This is the one test that matters for the mask editor. A collision mask is
 * invisible in play and decisive in it, and it is authored by a person looking
 * at coloured cages. If a cage is drawn red and the simulation walks through
 * it, that person authors an entire map confidently against the wrong picture
 * and finds out in play — the worst version of every silent-failure story in
 * this repo.
 *
 * So every colour is asserted against what `stepTo` and `sightBlocked` actually
 * do, rather than against how the colour was computed.
 */

const ROOM = [
  { x: -5, y: -5 },
  { x: 25, y: -5 },
  { x: 25, y: 25 },
  { x: -5, y: 25 },
];

function vol(raw: unknown): Volume {
  return VolumeSchema.parse(raw);
}

function layer(v: Volume): CollisionLayer {
  return CollisionLayerSchema.parse({ bounds: ROOM, volumes: [v] });
}

/** Walk at the volume from 4m away and report what happened. */
function approach(v: Volume): { passed: boolean; feetEndedAt: number } {
  const after = stepTo(layer(v), { pos: { x: 10, y: 6 }, z: 0 }, { x: 10, y: 10 });
  return { passed: after !== null, feetEndedAt: after?.z ?? 0 };
}

function looksThrough(v: Volume): boolean {
  return !sightBlocked(layer(v), { x: 10, y: 5 }, { x: 10, y: 15 });
}

const AT = { x: 10, y: 10, w: 6, h: 1, rotation: 0 } as const;

describe('every colour says what the simulation does', () => {
  it('RED is drawn on exactly the things that stop you', () => {
    const wall = vol({ shape: { kind: 'rect', ...AT }, top: 3, opaque: true });
    expect(volumeColour(wall)).toBe(VOLUME_COLOURS.block);
    expect(approach(wall).passed).toBe(false);
  });

  it('GREEN is drawn on things you end up standing on', () => {
    const kerb = vol({ shape: { kind: 'rect', ...AT }, top: 0.15, walkable: true });
    expect(volumeColour(kerb)).toBe(VOLUME_COLOURS.stand);
    const walked = approach(kerb);
    expect(walked.passed).toBe(true);
    expect(walked.feetEndedAt).toBeCloseTo(0.15, 6);
  });

  it('AMBER is drawn on things that climb', () => {
    const stair = vol({
      shape: { kind: 'rect', x: 10, y: 10, w: 2, h: 6, rotation: 0 },
      top: 2.4,
      walkable: true,
      ramp: { along: 'y', low: 0, high: 2.4 },
    });
    expect(volumeColour(stair)).toBe(VOLUME_COLOURS.ramp);
  });

  it('BLUE is drawn only where an eye stops and a body does not', () => {
    const thicket = vol({
      shape: { kind: 'circle', x: 10, y: 10, r: 2 },
      top: 0.25,
      walkable: true,
      opaque: true,
      sightTop: 2.2,
    });
    expect(volumeColour(thicket)).toBe(VOLUME_COLOURS.sight);
    expect(approach(thicket).passed).toBe(true);
    expect(looksThrough(thicket)).toBe(false);
  });

  it('GREY is drawn on what you walk under', () => {
    const arch = vol({ shape: { kind: 'rect', ...AT }, base: 2.4, top: 4, opaque: true });
    expect(volumeColour(arch)).toBe(VOLUME_COLOURS.under);
    expect(approach(arch).passed).toBe(true);
    expect(looksThrough(arch)).toBe(true);
  });
});

describe('the legend never contradicts the model', () => {
  // A spread wide enough to catch a rule keyed off the wrong field: the same
  // heights walkable and not, opaque and not, at ground level and overhead.
  const cases: Volume[] = [];
  for (const top of [0.1, 0.3, 0.35, 0.4, 1.2, 1.8, 3]) {
    for (const base of [0, 1.9, 2.4]) {
      for (const walkable of [true, false]) {
        for (const opaque of [true, false]) {
          if (top < base) continue;
          cases.push(vol({ shape: { kind: 'rect', ...AT }, base, top, walkable, opaque }));
        }
      }
    }
  }

  it('has cases to check', () => {
    expect(cases.length).toBeGreaterThan(30);
  });

  it('⚠ paints RED if and only if the body is actually stopped', () => {
    for (const v of cases) {
      const red = volumeColour(v) === VOLUME_COLOURS.block;
      expect(
        red,
        `base ${v.base} top ${v.top} walkable ${v.walkable}: painted ${red ? 'red' : 'not red'} ` +
          `but the body ${approach(v).passed ? 'walked through' : 'was stopped'}`,
      ).toBe(!approach(v).passed);
    }
  });

  it('⚠ never paints BLUE on something a sight line passes through', () => {
    for (const v of cases) {
      if (volumeColour(v) !== VOLUME_COLOURS.sight) continue;
      expect(looksThrough(v), `base ${v.base} top ${v.top} painted blue but sight passes`).toBe(
        false,
      );
    }
  });

  it('⚠ never paints GREEN on something that does not hold you up', () => {
    for (const v of cases) {
      if (volumeColour(v) !== VOLUME_COLOURS.stand) continue;
      const walked = approach(v);
      expect(walked.passed, `base ${v.base} top ${v.top} painted green but the body was stopped`).toBe(
        true,
      );
      expect(
        walked.feetEndedAt,
        `base ${v.base} top ${v.top} painted green but the feet stayed on the floor`,
      ).toBeCloseTo(v.top, 6);
    }
  });
});
