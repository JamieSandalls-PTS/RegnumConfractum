import { describe, expect, it } from 'vitest';
import { Rng } from '@rc/shared';
import { resolveNameContest } from '@rc/server/game/contest';

function tally(opts: { truthful: boolean; bluff: number; insight: number }, runs = 2000) {
  const rng = new Rng(4242);
  const counts = { certain_false: 0, rings_false: 0, nothing: 0 };
  for (let i = 0; i < runs; i++) {
    const r = resolveNameContest({
      truthful: opts.truthful,
      speakerBluff: opts.bluff,
      listenerInsight: opts.insight,
      rng,
    });
    counts[r ?? 'nothing']++;
  }
  return counts;
}

describe('name declaration contest (D-218)', () => {
  it('an overwhelming insight advantage reads a liar with certainty', () => {
    const c = tally({ truthful: false, bluff: 0, insight: 40 });
    expect(c.certain_false).toBe(2000);
  });

  it('an overwhelming bluff advantage always slips through', () => {
    const c = tally({ truthful: false, bluff: 40, insight: 0 });
    expect(c.certain_false).toBe(0);
    expect(c.rings_false).toBe(0);
  });

  it('insight never reads certainty from an honest declaration', () => {
    const c = tally({ truthful: true, bluff: 0, insight: 40 });
    expect(c.certain_false).toBe(0);
    // Decisive reads of an honest man are silent, not accusatory.
    expect(c.rings_false).toBe(0);
  });

  it('is fallible at narrow margins in both directions', () => {
    // Evenly matched: an honest speaker occasionally rings false...
    const honest = tally({ truthful: true, bluff: 10, insight: 10 });
    expect(honest.rings_false).toBeGreaterThan(0);
    expect(honest.rings_false).toBeLessThan(200); // ...but only occasionally.
    // ...and a liar sometimes slips a narrow read.
    const liar = tally({ truthful: false, bluff: 10, insight: 10 });
    expect(liar.nothing).toBeGreaterThan(0);
    expect(liar.rings_false + liar.certain_false).toBeGreaterThan(0);
  });

  it('never expresses the truth, only doubt', () => {
    // The type system already restricts outputs; assert the runtime values.
    const rng = new Rng(1);
    for (let i = 0; i < 500; i++) {
      const r = resolveNameContest({ truthful: false, speakerBluff: 10, listenerInsight: 12, rng });
      expect([null, 'rings_false', 'certain_false']).toContain(r);
    }
  });
});
