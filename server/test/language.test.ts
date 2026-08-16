import { describe, expect, it } from 'vitest';
import { scrambleSpeech, scrambleWord } from '@rc/server/game/language';

describe('language scrambling (M2)', () => {
  it('is deterministic: the same word always scrambles the same way', () => {
    expect(scrambleWord('silver', 'old-imperial')).toBe(scrambleWord('silver', 'old-imperial'));
    expect(scrambleSpeech('the silver is buried', 'old-imperial')).toBe(
      scrambleSpeech('the silver is buried', 'old-imperial'),
    );
  });

  it('different languages sound different', () => {
    expect(scrambleWord('silver', 'old-imperial')).not.toBe(scrambleWord('silver', 'hill-tongue'));
  });

  it('recurring words stay recognisable across sentences', () => {
    const a = scrambleSpeech('bring the silver tonight', 'crypt-cant');
    const b = scrambleSpeech('the silver is gone', 'crypt-cant');
    const word = scrambleWord('silver', 'crypt-cant');
    expect(a).toContain(word);
    expect(b).toContain(word);
  });

  it('never leaks the original words', () => {
    const out = scrambleSpeech('meet me behind the granary at moonrise', 'old-imperial');
    for (const word of ['meet', 'behind', 'granary', 'moonrise']) {
      expect(out.toLowerCase()).not.toContain(word);
    }
  });

  it('emote spans pass through untouched — actions are seen, not heard', () => {
    const out = scrambleSpeech('*bows deeply* an honour, truly *waves*', 'old-imperial');
    expect(out).toContain('*bows deeply*');
    expect(out).toContain('*waves*');
    expect(out.toLowerCase()).not.toContain('honour');
  });

  it('preserves punctuation shape and capitalisation', () => {
    const out = scrambleSpeech('Halt! Who goes there?', 'hill-tongue');
    expect(out).toMatch(/^[A-Z]/);
    expect(out).toContain('!');
    expect(out).toContain('?');
  });
});
