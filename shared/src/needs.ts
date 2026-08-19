import { z } from 'zod';

/**
 * Survival needs (D-526): the anti-camping mechanic, and the reason farming
 * exists.
 *
 * **They deliberately pull in OPPOSITE directions**, which is the whole
 * design and not a side effect:
 *
 *   - **Hunger pushes you OUT.** Food comes from the farm, so a cast that
 *     never leaves town eventually has nothing to eat.
 *   - **Thirst pulls you IN.** Water comes from the well at the town's
 *     centre, so a cast that lives in the field eventually has to come home.
 *
 * Between them nobody can settle anywhere. That is stronger than two needs
 * that both push outward, which would just be one need with two bars — and it
 * makes the well the single most valuable object on the map, which is exactly
 * what D-529 needs it to be for a poisoner to have anything worth poisoning.
 *
 * D-526's rules, encoded here rather than left to convention:
 *   - **coarse, not continuous** — a handful of stages on the round clock,
 *     never a draining bar
 *   - **the first stage forces a DECISION, not damage**
 *   - **consequences plateau** — no death spiral, and a round decided by a
 *     hunger bar rather than by a person is a failed round
 */

export const NEED_STAGES = ['sated', 'gnawing', 'severe'] as const;
export const NeedStageSchema = z.enum(NEED_STAGES);
export type NeedStage = z.infer<typeof NeedStageSchema>;

/**
 * Game hours between one step and the next. Hunger is slower than thirst,
 * because thirst is the leash back to town and a leash that pays out for six
 * hours is not a leash. ⚠ UNRATIFIED — D-526 left the event count open.
 */
export const HUNGER_STEP_HOURS = 8;
export const THIRST_STEP_HOURS = 6;

/**
 * What each stage costs. Deliberately different in KIND, so that neglecting
 * one is not the same experience as neglecting the other:
 *
 *   - hunger makes you **slow** — work takes longer, so you gather and craft
 *     less per trip. An economic penalty you feel in the ledger.
 *   - thirst makes you **frail** — your maximum health drops, so you lose
 *     fights you would otherwise win. A martial penalty you feel in a fight.
 *
 * Neither kills. Starvation stopping at "useless in a fight and slow at work"
 * is a ruling, not an oversight: a round decided by an unattended bar is a
 * failed round, and the antagonist is meant to be the threat.
 * ⚠ Whether starvation may kill inside a round is UNRATIFIED (D-526).
 */
export const HUNGER_WORK_MULTIPLIER: Record<NeedStage, number> = {
  sated: 1,
  gnawing: 1.4,
  severe: 1.9,
};

/** Fraction of maximum health left to you at each stage of thirst. */
export const THIRST_MAX_HP_FRACTION: Record<NeedStage, number> = {
  sated: 1,
  gnawing: 0.8,
  severe: 0.6,
};

export interface Needs {
  hunger: NeedStage;
  thirst: NeedStage;
}

/** Steps one stage deeper, stopping at the worst. Plateau, never spiral. */
export function deepen(stage: NeedStage): NeedStage {
  const i = NEED_STAGES.indexOf(stage);
  return NEED_STAGES[Math.min(i + 1, NEED_STAGES.length - 1)]!;
}

/**
 * What a serving is worth. Eating always clears the need entirely: a system
 * of partial top-ups is exactly the fiddly bookkeeping D-526 rejected. What
 * varies is not how MUCH a meal restores but where it is worth taking — see
 * `facilityBonus`.
 */
export function relieve(): NeedStage {
  return 'sated';
}

/**
 * D-530's trade, applied to food: eating at the storehouse or drinking at the
 * well is worth more than doing it alone in a field. The "more" is TIME, not
 * quantity — a meal taken properly holds you longer.
 *
 * Pooled goods are efficient but only redeemable in town, in daylight, when
 * you are not the one bleeding in the wood. Carrying your own is wasteful and
 * redeemable anywhere. Neither dominates, which is the point.
 */
export const FACILITY_NEED_BONUS = 1.5;

export function stepHoursFor(need: 'hunger' | 'thirst', atFacility: boolean): number {
  const base = need === 'hunger' ? HUNGER_STEP_HOURS : THIRST_STEP_HOURS;
  return atFacility ? base * FACILITY_NEED_BONUS : base;
}

/** Line shown when a need deepens. Pressure should read as flavour, not UI. */
export function needNotice(need: 'hunger' | 'thirst', stage: NeedStage): string | null {
  if (stage === 'sated') return null;
  if (need === 'hunger') {
    return stage === 'gnawing'
      ? 'Your stomach has started to complain. Work comes harder on an empty gut.'
      : 'You are properly hungry now. Everything takes twice as long as it should.';
  }
  return stage === 'gnawing'
    ? 'Your mouth is dry. You could do with the well.'
    : 'Thirst has you. You feel thin, and a blow would go deeper than it ought.';
}
