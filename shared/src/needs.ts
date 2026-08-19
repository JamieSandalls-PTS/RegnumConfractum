import { z } from 'zod';

/**
 * Survival needs (D-526, amended by D-534): the anti-camping mechanic, and
 * the reason farming exists.
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
 *
 * D-526's third rule — that consequences plateau and nothing may kill — has
 * been **amended by the stakeholder (D-534): starvation kills.** The spirit
 * is kept by making it slow and loud: a full day of neglect before the
 * damage starts, then hours more before it is fatal, with a notice at every
 * step. Nobody is surprised by it, and anyone can be fed by anyone.
 */

export const NEED_STAGES = ['sated', 'gnawing', 'severe', 'starving'] as const;
export const NeedStageSchema = z.enum(NEED_STAGES);
export type NeedStage = z.infer<typeof NeedStageSchema>;

/**
 * Game hours between one step and the next.
 *
 * **Hunger is eight hours a stage, so a full day empties it** (stakeholder,
 * ratifying D-526's open question): sated at dawn, gnawing by mid-afternoon,
 * severe by the small hours, starving at the following dawn. A 25-minute
 * round is two and a half days, so a cast that never eats will start dying
 * inside it — but only through sustained neglect, never by surprise.
 *
 * Thirst is faster because it is the leash back to town, and a leash that
 * pays out for eight hours is not a leash.
 */
export const HUNGER_STEP_HOURS = 8;
export const THIRST_STEP_HOURS = 6;

/**
 * The furthest each need can go. **Hunger runs to the end and kills**
 * (stakeholder ruling, superseding D-526's plateau for hunger only). Thirst
 * stops at `severe`: it does not kill you, it makes something else kill you,
 * which keeps the two failures genuinely different rather than one being a
 * slower copy of the other.
 */
export const NEED_CEILING: Record<'hunger' | 'thirst', NeedStage> = {
  hunger: 'starving',
  thirst: 'severe',
};

/**
 * Health lost per game hour once starving. From a full frame this is roughly
 * ten more game hours to die — four real minutes of continuing to ignore it
 * after a full day without food. Slow enough to notice, act on, and be
 * rescued from; fast enough that ignoring it is a decision with an ending.
 */
export const STARVATION_DAMAGE_PER_HOUR = 2;

/**
 * What each stage costs. Deliberately different in KIND, so that neglecting
 * one is not the same experience as neglecting the other:
 *
 *   - hunger makes you **slow** — work takes longer, so you gather and craft
 *     less per trip. An economic penalty you feel in the ledger.
 *   - thirst makes you **frail** — your maximum health drops, so you lose
 *     fights you would otherwise win. A martial penalty you feel in a fight.
 *
 * Thirst does not kill — it makes something ELSE kill you. Hunger does kill,
 * once it has run a full day and then some (D-534). Keeping only one of them
 * fatal is what stops the second need being a slower copy of the first.
 */
export const HUNGER_WORK_MULTIPLIER: Record<NeedStage, number> = {
  sated: 1,
  gnawing: 1.4,
  severe: 1.9,
  starving: 1.9, // no worse: past here the cost is your life, not your time
};

/** Fraction of maximum health left to you at each stage of thirst. */
export const THIRST_MAX_HP_FRACTION: Record<NeedStage, number> = {
  sated: 1,
  gnawing: 0.8,
  severe: 0.6,
  starving: 0.6, // unreachable for thirst; present so the record is total
};

export interface Needs {
  hunger: NeedStage;
  thirst: NeedStage;
}

/** Steps one stage deeper, stopping at that need's own ceiling. */
export function deepen(stage: NeedStage, need: 'hunger' | 'thirst' = 'hunger'): NeedStage {
  const ceiling = NEED_STAGES.indexOf(NEED_CEILING[need]);
  return NEED_STAGES[Math.min(NEED_STAGES.indexOf(stage) + 1, ceiling)]!;
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
    if (stage === 'gnawing') {
      return 'Your stomach has started to complain. Work comes harder on an empty gut.';
    }
    if (stage === 'severe') {
      return 'You are properly hungry now. Everything takes twice as long as it should.';
    }
    return 'You have gone a full day without food. This is the part that kills people.';
  }
  return stage === 'gnawing'
    ? 'Your mouth is dry. You could do with the well.'
    : 'Thirst has you. You feel thin, and a blow would go deeper than it ought.';
}
