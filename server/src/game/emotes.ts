import {
  POSTURES,
  TRANSIENT_ANIMS,
  type EmoteLexicon,
  type Posture,
  type TransientAnim,
} from '@rc/shared';

/**
 * Emote parsing (D-202): asterisk-wrapped spans are matched against the
 * lexicon's synonym phrases. Postures persist (last one in the line wins);
 * transients play once, deduplicated, capped. Negated phrases must not fire —
 * "*doesn't flinch*" is the canonical case. Unmatched text produces nothing
 * and never errors.
 */

export interface ParsedEmotes {
  posture: Posture | null;
  transients: TransientAnim[];
}

interface Entry {
  phrase: string[];
  kind: 'posture' | 'transient';
  key: string;
}

export class EmoteParser {
  private entries: Entry[];
  private negators: Set<string>;

  constructor(lexicon: EmoteLexicon) {
    this.negators = new Set(lexicon.negators.map((n) => n.toLowerCase()));
    this.entries = [];
    for (const posture of POSTURES) {
      for (const syn of lexicon.postures[posture] ?? []) {
        this.entries.push({ phrase: tokenize(syn), kind: 'posture', key: posture });
      }
    }
    for (const anim of TRANSIENT_ANIMS) {
      for (const syn of lexicon.transients[anim] ?? []) {
        this.entries.push({ phrase: tokenize(syn), kind: 'transient', key: anim });
      }
    }
    // Longest phrase first so "sits down" beats "sits".
    this.entries.sort((a, b) => b.phrase.length - a.phrase.length);
  }

  /** Parses the *emote spans* of a chat line. */
  parse(text: string): ParsedEmotes {
    const result: ParsedEmotes = { posture: null, transients: [] };
    for (const span of text.matchAll(/\*([^*]+)\*/g)) {
      this.parseSpan(span[1]!, result);
    }
    return result;
  }

  private parseSpan(span: string, result: ParsedEmotes): void {
    const tokens = tokenize(span);
    const consumed = new Array<boolean>(tokens.length).fill(false);
    for (const entry of this.entries) {
      for (let i = 0; i + entry.phrase.length <= tokens.length; i++) {
        if (consumed[i]) continue;
        let match = true;
        for (let j = 0; j < entry.phrase.length; j++) {
          if (tokens[i + j] !== entry.phrase[j] || consumed[i + j]) {
            match = false;
            break;
          }
        }
        if (!match) continue;
        // A negator in the two tokens before the phrase cancels it.
        const negated =
          (i >= 1 && this.negators.has(tokens[i - 1]!)) ||
          (i >= 2 && this.negators.has(tokens[i - 2]!));
        for (let j = 0; j < entry.phrase.length; j++) consumed[i + j] = true;
        if (negated) continue;
        if (entry.kind === 'posture') {
          result.posture = entry.key as Posture;
        } else if (
          result.transients.length < 3 &&
          !result.transients.includes(entry.key as TransientAnim)
        ) {
          result.transients.push(entry.key as TransientAnim);
        }
      }
    }
  }
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}
