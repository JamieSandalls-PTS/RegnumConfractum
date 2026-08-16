import { describe, expect, it } from 'vitest';
import { Rng, fnv1a } from '@rc/shared';

describe('deterministic rng', () => {
  it('same seed produces the same sequence', () => {
    const a = new Rng(1234);
    const b = new Rng(1234);
    for (let i = 0; i < 1000; i++) {
      expect(a.int(0, 1_000_000)).toBe(b.int(0, 1_000_000));
    }
  });

  it('string seeds hash deterministically', () => {
    expect(fnv1a('regnum')).toBe(fnv1a('regnum'));
    expect(fnv1a('regnum')).not.toBe(fnv1a('confractum'));
    expect(new Rng('regnum').float()).toBe(new Rng('regnum').float());
  });

  it('int stays within bounds inclusive', () => {
    const rng = new Rng(99);
    for (let i = 0; i < 10_000; i++) {
      const v = rng.int(2, 5);
      expect(v).toBeGreaterThanOrEqual(2);
      expect(v).toBeLessThanOrEqual(5);
    }
  });
});
