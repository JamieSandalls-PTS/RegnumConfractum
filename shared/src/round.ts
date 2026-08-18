import { z } from 'zod';
import { ContentIdSchema } from './content';

/**
 * The Round (D-521 – D-526): a 20-30 minute scenario with a hidden
 * antagonist and no respawn, played over the same world the persistent game
 * uses. This module is the single source of truth for objective documents and
 * round wire shapes — the server loads with these schemas, the validator
 * fails CI on a bad file, and the client renders from the same types.
 *
 * Two rules are encoded here rather than left to convention, because both are
 * invariants and both are easy to break by accident:
 *
 *   - An objective's `brief` is antagonist-only knowledge. It travels in
 *     `round_role`, which is sent to one connection. It must never appear in
 *     `round_state`, which is broadcast.
 *   - `status: 'planned'` objectives are authored but never selected. MR1 can
 *     only evaluate what the server can already observe (deaths and the
 *     clock); steal and starve arrive with MR2's item and survival systems.
 *     A planned objective in content is a design note, not a live scenario.
 */

// ---------------------------------------------------------------------------
// Objectives — content (D-110: content is data, never hardcoded)
// ---------------------------------------------------------------------------

/**
 * What the antagonist must accomplish. Each kind names the fact the server
 * watches; nothing here is scored, and nothing rewards the cast for being
 * right about who to accuse (D-303, restated in D-521).
 */
export const ObjectiveKindSchema = z.discriminatedUnion('type', [
  /** Kill a specific NPC, matched by its public descriptor. The strongest
   * low-cast objective (D-526): the cast defends a known, defenceless target
   * instead of coin-flipping accusations at each other. */
  z.object({ type: z.literal('kill_npc'), descriptor: z.string().min(1) }),
  /** Kill one member of the cast, drawn at random at round start. Reserved
   * for larger casts — at three players this reduces to a duel (D-522). */
  z.object({ type: z.literal('kill_player') }),
  /** Simply live to the end of the round while the cast tries to find you. */
  z.object({ type: z.literal('survive') }),
  /** Take a specific item out of the round. Needs MR2's item verbs. */
  z.object({ type: z.literal('steal'), itemTemplate: ContentIdSchema }),
  /** Deny the cast food and water until they cannot go on. Needs MR2's
   * survival needs (D-526). */
  z.object({ type: z.literal('starve') }),
]);
export type ObjectiveKind = z.infer<typeof ObjectiveKindSchema>;

export const ObjectiveSchema = z
  .object({
    id: ContentIdSchema,
    name: z.string().min(1),
    /**
     * Read by the antagonist alone, at round start. Written in world voice —
     * it is the only briefing they get, so it carries the fiction as well as
     * the instruction.
     */
    brief: z.string().min(1),
    kind: ObjectiveKindSchema,
    /** Smallest cast this objective is playable at. */
    minCast: z.number().int().min(2).default(3),
    /** Largest cast, or null for no ceiling. */
    maxCast: z.number().int().min(2).nullable().default(null),
    /**
     * 'live' objectives may be selected. 'planned' ones are authored ahead of
     * the systems that would evaluate them and are never chosen — the round
     * engine refuses them rather than silently failing to resolve.
     */
    status: z.enum(['live', 'planned']).default('live'),
    /** Why this objective exists, for whoever reads the content later. */
    notes: z.string().optional(),
  })
  .strict();
export type ObjectiveDef = z.infer<typeof ObjectiveSchema>;

// ---------------------------------------------------------------------------
// Round shape and tuning
// ---------------------------------------------------------------------------

/**
 * Minimum cast (D-522, carried at this size by D-526's objective set). This is
 * the floor that lets a round *start*, not the size rounds are designed for —
 * a hidden antagonist wants five to eight to be a mystery rather than a knife
 * fight. Below three there is no deduction at all.
 */
export const ROUND_MIN_CAST = 3;

/** 25 minutes at the 10Hz tick (D-104). Unratified — first-pass length. */
export const ROUND_LENGTH_TICKS = 15_000;

// ---------------------------------------------------------------------------
// The day-night cycle (D-527)
//
// A full cycle is ten real minutes: five of day, five of night. A 25-minute
// round is therefore two and a half cycles — three day phases and TWO nights,
// opening and closing in daylight. The two nights are the round's structure:
// each one drives the cast indoors, and a body discovered at dawn is the
// oldest setup in the genre.
//
// This replaces the persistent world's fixed clock inside a round. The
// script host's TICKS_PER_GAME_HOUR (two real minutes) governs the persistent
// world; a round runs on ROUND_TICKS_PER_GAME_HOUR so that authored on_hour
// and at_hour triggers keep working, just very much faster.
// ---------------------------------------------------------------------------

/** One full day-night cycle: 10 real minutes at 10Hz. */
export const ROUND_DAY_TICKS = 6_000;

/** 24 game hours to a cycle, so a game hour is 25 real seconds. */
export const ROUND_TICKS_PER_GAME_HOUR = ROUND_DAY_TICKS / 24; // 250

/** Night falls at 18:00 and lifts at 06:00 — an even split. */
export const ROUND_DUSK_HOUR = 18;
export const ROUND_DAWN_HOUR = 6;

/**
 * Game hour 0-23 within the round's compressed cycle.
 *
 * A round OPENS AT DAWN. Without the offset, tick 0 is midnight and a
 * 25-minute round gets a truncated opening night plus two more — three
 * nights, starting in the dark, which is neither what D-527 specifies nor a
 * sensible way to begin a round the cast is meant to walk into. The offset
 * is what makes the cycle land as designed: day, night, day, night, day.
 */
export function roundHour(tickIntoRound: number): number {
  return (ROUND_DAWN_HOUR + Math.floor(tickIntoRound / ROUND_TICKS_PER_GAME_HOUR)) % 24;
}

/**
 * Whether it is dark out. Night is the round's pressure inwards: NPCs roam
 * outdoors, so open ground is perilous and the brave are paid for crossing it
 * (D-527). It completes a set of three forces — the dungeon pulls players
 * out (D-523), hunger pushes them out (D-526), night drives them in — and no
 * single spot is safe against all three, which is what stops the cast from
 * simply barricading together for the whole round.
 */
export function isNight(tickIntoRound: number): boolean {
  const h = roundHour(tickIntoRound);
  return h >= ROUND_DUSK_HOUR || h < ROUND_DAWN_HOUR;
}

/**
 * What night pays over day (D-528, stakeholder: "night should return 50% more
 * rewards"). It applies ONLY to what is earned OUTDOORS after dusk, because
 * the bonus is compensation for the peril and there is no peril where the
 * sky does not reach. Applied everywhere it would be worse than useless: it
 * would make the safest possible choice — sitting indoors, or diving where
 * roamers cannot follow — also the best-paid one, which inverts the whole
 * point of night.
 *
 * It multiplies xp and materials only. It must never touch anything that
 * wins a round (D-522), and it cannot leak into player kills because those
 * pay nothing at all inside a round.
 */
export const NIGHT_REWARD_MULTIPLIER = 1.5;

/**
 * Scales a reward for where and when it was earned. Rounded rather than
 * floored so small rewards are not quietly swallowed — at these numbers an
 * odd value floored would cost more than the bonus gives.
 */
export function applyNightBonus(amount: number, opts: { outdoor: boolean; night: boolean }): number {
  if (!opts.outdoor || !opts.night) return amount;
  return Math.round(amount * NIGHT_REWARD_MULTIPLIER);
}

/** Which day-night phase a tick falls in, for lighting and spawn logic. */
export function roundPhaseOfDay(tickIntoRound: number): 'day' | 'night' {
  return isNight(tickIntoRound) ? 'night' : 'day';
}

export const RoundPhaseSchema = z.enum(['lobby', 'running', 'resolved']);
export type RoundPhase = z.infer<typeof RoundPhaseSchema>;

/** Why the round ended. Descriptive only — a round ends, it does not grade. */
export const RoundOutcomeSchema = z.enum([
  /** The cast found and killed the antagonist. */
  'antagonist_dead',
  /** Nobody on the cast is still standing. */
  'cast_wiped',
  /** The antagonist did the thing it was sent to do. */
  'objective_complete',
  /** The clock ran out with the antagonist alive and the deed undone. */
  'time_expired',
  /** Too few players remained connected to continue. */
  'abandoned',
]);
export type RoundOutcome = z.infer<typeof RoundOutcomeSchema>;

export type RoundWinner = 'cast' | 'antagonist' | 'nobody';

/** Which side an outcome favours. Kept beside the outcome so the mapping is
 * defined once — the client must never infer a winner from an outcome. */
export function winnerFor(outcome: RoundOutcome): RoundWinner {
  switch (outcome) {
    case 'antagonist_dead':
    case 'time_expired':
      return 'cast';
    case 'cast_wiped':
    case 'objective_complete':
      return 'antagonist';
    case 'abandoned':
      return 'nobody';
  }
}
