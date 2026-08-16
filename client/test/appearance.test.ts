import { describe, expect, it } from 'vitest';
import { ARCHETYPES, generateAppearance } from '../src/game/appearance';

describe('appearance generation (D-402)', () => {
  it('is deterministic: same seed, same appearance', () => {
    for (let seed = 1; seed < 200; seed++) {
      expect(generateAppearance(seed)).toEqual(generateAppearance(seed));
    }
  });

  it('stays inside the archetype ranges — never uniform-random mush', () => {
    for (let seed = 1; seed < 2000; seed++) {
      const a = generateAppearance(seed);
      const r = ARCHETYPES[a.archetype];
      expect(a.height).toBeGreaterThanOrEqual(r.height[0]);
      expect(a.height).toBeLessThanOrEqual(r.height[1]);
      expect(a.bulk).toBeGreaterThanOrEqual(r.bulk[0]);
      expect(a.bulk).toBeLessThanOrEqual(r.bulk[1]);
      expect(a.shoulder).toBeGreaterThanOrEqual(r.shoulder[0]);
      expect(a.shoulder).toBeLessThanOrEqual(r.shoulder[1]);
      expect(a.hairLen).toBeGreaterThanOrEqual(r.hair[0]);
      expect(a.hairLen).toBeLessThanOrEqual(r.hair[1]);
    }
  });

  it('produces every archetype across a population', () => {
    const seen = new Set<string>();
    for (let seed = 1; seed < 500; seed++) seen.add(generateAppearance(seed).archetype);
    expect([...seen].sort()).toEqual(['ascetic', 'brute', 'rogue', 'soldier']);
  });
});
