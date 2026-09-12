import { z } from 'zod';

/**
 * Attributes (D-546). Four numbers underneath every character, each with
 * exactly one job, so that a player asking "what does this do" gets an answer
 * rather than a paragraph.
 *
 *   strength    what you hit for, and what you can carry
 *   dexterity   whether the blow lands square or glances
 *   vigor       how much of it you can take
 *   will        the depth of the well you draw on
 *
 * Every class starts at 10 in all four with 10 more to place (stakeholder,
 * 2026-08-20). The baseline is deliberately the SAME for every class: a class
 * is a bundle of access and options (D-208, D-511), and giving the man-at-arms
 * +2 strength for free would make the calling a stat block, which is the
 * design this project has refused since D-303.
 *
 * ⚠ THE TENSION, STATED PLAINLY. D-538 fenced levels off from raw power:
 * "a level never grants hit points, never grants damage." Attribute points at
 * level-up cross that fence, because strength IS damage and vigor IS hit
 * points. The stakeholder asked for it directly, so it is built — but the
 * magnitude is held down hard (see ATTRIBUTE_LEVELS below) precisely so that
 * D-529's buddy system survives: a level-10 veteran walks the night with
 * about four more hit points and one more damage than a first-timer, which is
 * not enough to make going out alone correct.
 *
 * Pure module: no DOM, no server. Both sides compute the same numbers and the
 * server stays the authority (D-102).
 */

export const ATTRIBUTES = ['strength', 'dexterity', 'vigor', 'will'] as const;
export type Attribute = (typeof ATTRIBUTES)[number];
export const AttributeSchema = z.enum(ATTRIBUTES);

/** Human labels and the one-line answer to "what does this do". */
export const ATTRIBUTE_INFO: Record<Attribute, { name: string; blurb: string }> = {
  strength: {
    name: 'Strength',
    blurb:
      'Weight behind a blow, and weight on your back. Raises damage and what you can carry — including what a body weighs.',
  },
  dexterity: {
    name: 'Dexterity',
    blurb:
      'Not being quite where the edge was. Turns some of what lands on you into a glancing blow.',
  },
  vigor: {
    name: 'Vigor',
    blurb: 'Meat and stubbornness. Every point is a point of health.',
  },
  will: {
    name: 'Will',
    blurb:
      'What you have left to spend on rites and spells. Sets the size of your reserve and how fast it returns.',
  },
};

/** Where every attribute starts, for every class, always. */
export const ATTRIBUTE_BASE = 10;
/** Points the player places at creation, on top of the base. */
export const ATTRIBUTE_CREATION_POINTS = 10;
/**
 * The highest any single attribute may reach at CREATION. Base plus the whole
 * allocation — so a specialist is possible on day one and cannot be exceeded
 * by hoarding.
 */
export const ATTRIBUTE_CREATION_MAX = ATTRIBUTE_BASE + ATTRIBUTE_CREATION_POINTS;
/**
 * The hard ceiling including everything a lifetime of levels can add. Every
 * derived stat below is designed against this number, not against the
 * creation cap — the level-10 specialist is the one balance has to survive.
 */
export const ATTRIBUTE_MAX = ATTRIBUTE_CREATION_MAX + 4;

/**
 * Which levels hand out an attribute point (D-546). FOUR points across nine
 * levels, and the sparseness is the whole safety argument: at the ceiling
 * that is +4 health OR +1 damage OR +4 carry — visible on a character sheet,
 * invisible in a fight. A point per level would have been +9, which is half
 * a starting character's health, and that would decide fights.
 *
 * ⚠ UNRATIFIED magnitude, like every other number in the progression chain.
 */
export const ATTRIBUTE_LEVELS: readonly number[] = [3, 5, 7, 9];

/** How many attribute points a character of this level has been handed. */
export function attributePointsAt(level: number): number {
  return ATTRIBUTE_LEVELS.filter((l) => l <= level).length;
}

export type AttributeSet = Record<Attribute, number>;

/** A fresh, unallocated set — the identical starting point for every class. */
export function baseAttributes(): AttributeSet {
  return {
    strength: ATTRIBUTE_BASE,
    dexterity: ATTRIBUTE_BASE,
    vigor: ATTRIBUTE_BASE,
    will: ATTRIBUTE_BASE,
  };
}

/**
 * Fills in anything missing from a stored or wire-borne partial set. Every
 * reader goes through this rather than indexing the record directly, so a
 * character written before attributes existed reads as a straight 10/10/10/10
 * — which is exactly the character the pre-attribute code produced, and is
 * why no migration has to backfill anything.
 */
export function resolveAttributes(
  partial: Partial<Record<string, number>> | null | undefined,
): AttributeSet {
  const out = baseAttributes();
  if (!partial) return out;
  for (const attr of ATTRIBUTES) {
    const v = partial[attr];
    if (typeof v === 'number' && Number.isFinite(v)) {
      out[attr] = Math.max(0, Math.min(ATTRIBUTE_MAX, Math.round(v)));
    }
  }
  return out;
}

/** Creation allocation plus every level-up point already placed. */
export function totalAttributes(
  allocated: Partial<Record<string, number>> | null | undefined,
  advanced: Partial<Record<string, number>> | null | undefined,
): AttributeSet {
  const out = resolveAttributes(allocated);
  if (advanced) {
    for (const attr of ATTRIBUTES) {
      const v = advanced[attr];
      if (typeof v === 'number' && Number.isFinite(v)) {
        out[attr] = Math.max(0, Math.min(ATTRIBUTE_MAX, out[attr] + Math.round(v)));
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Derived stats. One function each, all pure, all read by the server.
//
// The calibration constant that matters: at the base 10 every one of these
// returns EXACTLY what the game returned before attributes existed. Health is
// 20 (DEFAULT_MAX_HP), the damage bonus is 0, the carry bonus is 0. That is
// deliberate — it means an unallocated character is the old character, and
// nothing that was tuned against the old numbers silently shifted.
// ---------------------------------------------------------------------------

/** Health at base vigor. Matches DEFAULT_MAX_HP; the two must not drift. */
export const HP_AT_BASE_VIGOR = 20;

/** Maximum health before wounds, thirst and gear. */
export function maxHpFor(attrs: AttributeSet): number {
  return Math.max(1, HP_AT_BASE_VIGOR + (attrs.vigor - ATTRIBUTE_BASE));
}

/** The reserve rites and spells are paid out of, at base will. */
export const MANA_AT_BASE_WILL = 10;
/** Each point of will over the base. */
export const MANA_PER_WILL = 2;

export function maxManaFor(attrs: AttributeSet): number {
  return Math.max(0, MANA_AT_BASE_WILL + (attrs.will - ATTRIBUTE_BASE) * MANA_PER_WILL);
}

/**
 * Mana returned per real second out of combat. Will pays twice — a deep well
 * that refills slowly is just a worse shallow one.
 */
export function manaRegenPerSecond(attrs: AttributeSet): number {
  return 0.25 + (attrs.will - ATTRIBUTE_BASE) * 0.05;
}

/**
 * Added to every weapon blow. One point per FOUR of strength, so the whole
 * creation allocation buys +2 on a 2–6 roll and the level ceiling buys +3.
 * Deliberately coarse: a smooth curve here would make one attribute point the
 * difference between two-shotting and three-shotting somebody, and that is
 * the fight-deciding granularity D-546 is trying not to have.
 */
export function damageBonusFor(attrs: AttributeSet): number {
  return Math.floor((attrs.strength - ATTRIBUTE_BASE) / 4);
}

/** Added to CARRY_BASE_CAPACITY, alongside athletics and the carry feats. */
export function carryBonusFor(attrs: AttributeSet): number {
  return attrs.strength - ATTRIBUTE_BASE;
}

/**
 * The chance an incoming blow only grazes. A glance HALVES damage rather than
 * erasing it: a whiff-based defence reads as the game ignoring your input,
 * and at these numbers a run of them would decide a fight by luck alone.
 */
export const GLANCE_CAP = 0.25;

export function glanceChanceFor(attrs: AttributeSet): number {
  return Math.max(0, Math.min(GLANCE_CAP, (attrs.dexterity - ATTRIBUTE_BASE) * 0.02));
}

/**
 * Validates a creation allocation. Returns [] when legal, else reasons — the
 * same shape validateBuild uses, for the same reason: the client calls it for
 * live feedback and the server calls it as the authority (D-102).
 */
export function validateAttributeAllocation(
  alloc: Partial<Record<string, number>> | undefined,
): string[] {
  const errors: string[] = [];
  if (!alloc) return errors;
  let spent = 0;
  for (const [id, raw] of Object.entries(alloc)) {
    if (!(ATTRIBUTES as readonly string[]).includes(id)) {
      errors.push(`unknown attribute '${id}'`);
      continue;
    }
    const value = raw ?? 0;
    if (!Number.isInteger(value)) {
      errors.push(`${ATTRIBUTE_INFO[id as Attribute].name} must be a whole number`);
      continue;
    }
    if (value < ATTRIBUTE_BASE) {
      errors.push(`${ATTRIBUTE_INFO[id as Attribute].name} cannot go below ${ATTRIBUTE_BASE}`);
      continue;
    }
    if (value > ATTRIBUTE_CREATION_MAX) {
      errors.push(
        `${ATTRIBUTE_INFO[id as Attribute].name} exceeds the creation cap of ${ATTRIBUTE_CREATION_MAX}`,
      );
    }
    spent += value - ATTRIBUTE_BASE;
  }
  if (spent > ATTRIBUTE_CREATION_POINTS) {
    errors.push(`attribute points overspent: ${spent} of ${ATTRIBUTE_CREATION_POINTS}`);
  }
  return errors;
}
