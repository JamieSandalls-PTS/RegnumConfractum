import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EmoteLexiconSchema } from '@rc/shared';
import { EmoteParser } from '@rc/server/game/emotes';

const lexicon = EmoteLexiconSchema.parse(
  JSON.parse(
    readFileSync(fileURLToPath(new URL('../../content/emotes/lexicon.json', import.meta.url)), 'utf8'),
  ),
);
const parser = new EmoteParser(lexicon);

describe('emote parser (D-202)', () => {
  it('matches states and transients from asterisk spans', () => {
    expect(parser.parse('*sits down*')).toEqual({ posture: 'sitting', transients: [] });
    expect(parser.parse('*bows deeply*')).toEqual({ posture: null, transients: ['bow'] });
  });

  it('fires both a state and a transient from one line', () => {
    expect(parser.parse('*sits down and laughs*')).toEqual({
      posture: 'sitting',
      transients: ['laugh'],
    });
  });

  it('standing exits a seated state', () => {
    expect(parser.parse('*stands up*').posture).toBe('standing');
  });

  it('handles negation: *doesn\'t flinch* must not flinch', () => {
    // "flinch" is not in the lexicon, so use a lexicon word to prove negation:
    expect(parser.parse("*doesn't laugh*")).toEqual({ posture: null, transients: [] });
    expect(parser.parse('*never bows*')).toEqual({ posture: null, transients: [] });
    expect(parser.parse('*refuses to kneel*')).toEqual({ posture: null, transients: [] });
  });

  it('negation only cancels the phrase it precedes', () => {
    const r = parser.parse("*doesn't laugh, but waves*");
    expect(r.transients).toEqual(['wave']);
  });

  it('ignores text outside asterisks and unmatched text inside them', () => {
    expect(parser.parse('sits down with no asterisks')).toEqual({ posture: null, transients: [] });
    expect(parser.parse('*mutters an old prayer*')).toEqual({ posture: null, transients: [] });
  });

  it('deduplicates and caps transients', () => {
    const r = parser.parse('*laughs and laughs, bows, waves, points, shrugs*');
    expect(r.transients.length).toBeLessThanOrEqual(3);
    expect(new Set(r.transients).size).toBe(r.transients.length);
  });

  it('prefers the longer phrase: "sits down" consumes "sits"', () => {
    expect(parser.parse('*sits down*')).toEqual({ posture: 'sitting', transients: [] });
  });
});
