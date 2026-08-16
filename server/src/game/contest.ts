import type { Impression, Rng } from '@rc/shared';

/**
 * The name-declaration contest (D-218): listener's Insight against speaker's
 * Bluff, resolved per observer (D-219). Two hard rules, enforced here:
 *
 * 1. Insight is GRADED and FALLIBLE. It yields "certain that is false",
 *    "something rings false", or nothing at all — and at narrow margins it is
 *    occasionally wrong in both directions: an honest man can ring false, a
 *    liar can slip through. A reliable lie detector would destroy deception
 *    roleplay outright.
 * 2. Insight reveals THAT something is off, never WHAT the truth is. The
 *    return type cannot express the truth — only doubt.
 */

/** Insight must beat Bluff by this much for certainty. */
const CERTAIN_MARGIN = 6;
/** Margins within ±NARROW of the threshold are where mistakes happen. */
const NARROW = 2;
/** Chance of a wrong reading inside the narrow band. */
const NOISE = 0.12;

export interface ContestInput {
  truthful: boolean;
  speakerBluff: number;
  listenerInsight: number;
  rng: Rng;
}

export function resolveNameContest(input: ContestInput): Impression | null {
  const { truthful, speakerBluff, listenerInsight, rng } = input;
  const bluffRoll = speakerBluff + rng.int(1, 20);
  const insightRoll = listenerInsight + rng.int(1, 20);
  const margin = insightRoll - bluffRoll; // positive: the listener read them

  if (truthful) {
    // Nothing IS off. Only a narrow, straining read produces a false alarm.
    if (margin > 0 && margin <= NARROW && rng.float() < NOISE) return 'rings_false';
    return null;
  }

  if (margin >= CERTAIN_MARGIN) return 'certain_false';
  if (margin > 0) {
    // Narrow wins can misfire into silence — the liar almost carried it.
    if (margin <= NARROW && rng.float() < NOISE) return null;
    return 'rings_false';
  }
  // The bluff held. A narrow loss occasionally leaves a nagging doubt anyway.
  if (margin > -NARROW && rng.float() < NOISE) return 'rings_false';
  return null;
}
