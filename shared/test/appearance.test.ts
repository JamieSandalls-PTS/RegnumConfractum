import { describe, expect, it } from 'vitest';
import { APPEARANCE_LIMITS, CREATURE_HEIGHT, WireEntitySchema, validateAppearanceOverride } from '../src';

/**
 * A creature is taller than a player may be (D-638's finding).
 *
 * The wire entity carries the same appearance override for a roamer as for
 * a player, and when its schema copied the PLAYER bound a 2.2m golem authored
 * in the tool spawned, hunted and was refused by every client's parser —
 * nobody could see it. The wire takes the creature bound; the server still
 * refuses a player outside their own.
 */
describe('a creature is taller than a player may be (D-638)', () => {
  it('the wire carries a 3.3m warden, and a player may still not be one', () => {
    const tall = WireEntitySchema.safeParse({
      id: 1, descriptor: 'something tall', kind: 'npc', x: 0, y: 0, facing: 's', posture: 'standing',
      presentation: 'normal', appearanceSeed: 1, appearance: { height: 3.3 }, look: null,
    });
    expect(tall.success, JSON.stringify(tall.success ? '' : tall.error.issues)).toBe(true);
    expect(CREATURE_HEIGHT[1]).toBeGreaterThan(APPEARANCE_LIMITS.height[1]);
    expect(validateAppearanceOverride({ height: 3.3 }).length).toBeGreaterThan(0);
    expect(validateAppearanceOverride({ height: 1.8 })).toEqual([]);
  });
});
