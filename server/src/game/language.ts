import { fnv1a, mulberry32 } from '@rc/shared';

/**
 * Language scrambling (M2): what a listener without the tongue hears. Two
 * properties matter:
 *
 * 1. DETERMINISTIC PER WORD: the same word in the same language always
 *    scrambles the same way, for every listener, forever. Recurring words
 *    become recognisable — a player can learn that "veshka" keeps appearing
 *    when smugglers argue about money. The sound of a language is content.
 * 2. EMOTE SPANS PASS THROUGH: *actions* are seen, not heard. Only speech
 *    outside asterisks is scrambled.
 *
 * Each language gets its own phoneme palette (seeded from its id), so
 * different tongues sound different, not just shuffled.
 */

const ONSETS = ['b', 'd', 'dr', 'f', 'g', 'gh', 'k', 'kh', 'l', 'm', 'n', 'p', 'r', 's', 'sh', 'sk', 't', 'th', 'v', 'z', 'zh', ''];
const VOWELS = ['a', 'e', 'i', 'o', 'u', 'a', 'e', 'ai', 'ei', 'ou', 'ya', 'yo'];
const CODAS = ['', '', '', 'k', 'l', 'm', 'n', 'r', 's', 'sh', 't', 'th', 'x', 'zz'];

function pick<T>(rnd: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rnd() * arr.length) % arr.length]!;
}

export function scrambleWord(word: string, languageId: string): string {
  const rnd = mulberry32(fnv1a(`${languageId}|${word.toLowerCase()}`));
  // A per-language bias narrows the phoneme palette so tongues sound distinct.
  const langRnd = mulberry32(fnv1a(languageId));
  const onsetBias = Math.floor(langRnd() * ONSETS.length);
  const vowelBias = Math.floor(langRnd() * VOWELS.length);

  const syllables = Math.max(1, Math.min(4, Math.round(word.length / 3)));
  let out = '';
  for (let i = 0; i < syllables; i++) {
    out += ONSETS[(onsetBias + Math.floor(rnd() * 9)) % ONSETS.length];
    out += VOWELS[(vowelBias + Math.floor(rnd() * 5)) % VOWELS.length];
    if (rnd() < 0.4) out += pick(rnd, CODAS);
  }
  if (word[0] !== undefined && word[0] === word[0]!.toUpperCase() && /\p{L}/u.test(word[0]!)) {
    out = out.charAt(0).toUpperCase() + out.slice(1);
  }
  return out;
}

/** Scrambles speech outside *emote spans*; punctuation and spacing survive. */
export function scrambleSpeech(text: string, languageId: string): string {
  return text
    .split(/(\*[^*]*\*)/g)
    .map((segment) => {
      if (segment.startsWith('*') && segment.endsWith('*')) return segment;
      return segment.replace(/\p{L}[\p{L}']*/gu, (word) => scrambleWord(word, languageId));
    })
    .join('');
}
