import { z } from 'zod';
import { ATTRIBUTE_BASE, type AttributeSet } from './attributes';
import { ARMOUR_MATERIALS, type ArmourMaterial } from './characters';

/**
 * Dice-roll combat and Armour Class (D-606).
 *
 * The stakeholder's brief, in their words: "Think of NWN. Classes start with a
 * base AC of 10. Dexterity should add 1 AC per point over 10... Each attack
 * should be a D20 roll vs the opponents AC... A roll of 1 is always a fail. A
 * roll of 20 is always a hit... Damage/effectiveness is a separate roll made
 * alongside the attack."
 *
 * ⚠ Everything here is PURE and takes its randomness as an argument. The
 * doctrine (D-114) is that the simulation must run headlessly and
 * deterministically, and a combat system is the single place where "it felt
 * wrong" is least useful and a seeded test is most. Nothing in this file
 * reaches for `Math.random`.
 *
 * ⚠ What this SUPERSEDES, said plainly rather than left to be discovered:
 *
 *  * D-546's `glanceChanceFor`. Dexterity used to give a flat chance to halve
 *    an incoming blow. It is now Armour Class instead — keeping both would pay
 *    dexterity twice for one idea, and "sometimes it does half" is the fuzzy
 *    version of the miss this replaces it with.
 *  * D-547's "armour reduces and can never erase". Armour raises AC now, the
 *    way it does in the game this is modelled on. Doing both would count a
 *    breastplate twice, and the floor of one damage existed precisely because
 *    subtraction could otherwise reach zero — which is not a risk a roll has.
 *
 * ⚠ What it deliberately does NOT take from NWN: a base attack bonus that
 * grows with level. That is raw power, and D-522/D-538 are explicit that a
 * level buys access and options and never raw power, because characters
 * persist across rounds and a veteran who simply hits more often makes the
 * cast of three unplayable. Attack comes from strength, the weapon, and feats
 * a character chose.
 */

/* ------------------------------------------------------------------ dice */

/** `2d6`, `1d8+1`, or a flat `3`. */
export const DiceSchema = z
  .string()
  .regex(/^(\d+d\d+([+-]\d+)?|\d+)$/i, 'must look like 1d6, 2d8+1 or a flat number');
export type Dice = z.infer<typeof DiceSchema>;

export interface ParsedDice {
  readonly count: number;
  readonly sides: number;
  readonly flat: number;
}

/**
 * ⚠ A flat number parses as zero dice plus that number, rather than as an
 * error. Most items in the world are not weapons and a fist is not `1d0`;
 * making the simple case expressible is what stops content inventing a
 * notation for it.
 */
export function parseDice(spec: Dice): ParsedDice {
  const m = /^(\d+)d(\d+)([+-]\d+)?$/i.exec(spec);
  if (!m) return { count: 0, sides: 0, flat: Number(spec) };
  return { count: Number(m[1]), sides: Number(m[2]), flat: Number(m[3] ?? 0) };
}

/** Rolls it. `roll(sides)` must return 1..sides inclusive. */
export function rollDice(spec: Dice, roll: (sides: number) => number): number {
  const { count, sides, flat } = parseDice(spec);
  let total = flat;
  for (let i = 0; i < count; i++) total += roll(sides);
  return total;
}

/** The smallest and largest a spec can produce — for tests and for tuning. */
export function diceRange(spec: Dice): [number, number] {
  const { count, sides, flat } = parseDice(spec);
  return [count * 1 + flat, count * sides + flat];
}

/* ------------------------------------------------------- the modifiers */

/**
 * How much one point of an attribute is worth.
 *
 * ⚠ RAW, not halved. The stakeholder asked for "1 AC per point over 10", and
 * these are the two numbers that implement it — kept as named constants
 * because they are the steepest levers in the game and the first thing to
 * move if play says so.
 *
 * ⚠ The arithmetic is worth knowing before it is judged in play. Attributes
 * here run 10 to 20 at creation and 24 at the ceiling (D-546), and NWN feeds
 * its scores through `(score - 10) / 2` so that a 20 is +5. Raw, a 20 is +10
 * — half of a d20. Measured across the plausible spread: strength 10 against
 * dexterity 20 hits on a natural 20 only, and plate on top of that puts a
 * fully strong attacker at one hit in four. It is symmetric, so two invested
 * characters play normally; it is the UNINVESTED attacker who falls off a
 * cliff. Halving both (or halving the attribute spread) is one edit here.
 */
export const AC_PER_DEXTERITY = 1;
export const ATTACK_PER_STRENGTH = 1;

/** Everybody starts here, before dexterity, armour or anything worn. */
export const BASE_ARMOUR_CLASS = 10;

/**
 * What each kind of armour is worth, before any bonus an item carries.
 *
 * ⚠ A rule, so it lives here rather than in content: a suit whose protection
 * is authored per item is a suit somebody can make better by editing a file,
 * and D-547 already put the ARMOUR GATE on material for the same reason. What
 * content may add is the bonus on top — a fine breastplate, an enchanted ring
 * — which is `EquipStats.acBonus`.
 */
export const ARMOUR_CLASS_BY_MATERIAL: Readonly<Record<ArmourMaterial, number>> = {
  cloth: 1,
  leather: 3,
  plate: 6,
};

export function dexterityAc(attrs: AttributeSet): number {
  return (attrs.dexterity - ATTRIBUTE_BASE) * AC_PER_DEXTERITY;
}

export function attackBonusFor(attrs: AttributeSet): number {
  return (attrs.strength - ATTRIBUTE_BASE) * ATTACK_PER_STRENGTH;
}

/**
 * What a body is worth defending, all in.
 *
 * ⚠ The HEAVIEST piece decides the armour half, not the sum. Wearing four
 * leather pieces is not plate, and adding them up is how a player in gloves,
 * boots, a cap and a jerkin out-armours a knight. The same rule D-570 uses to
 * derive a garment's material from its parts, applied to a worn set.
 */
export function armourClass(
  attrs: AttributeSet,
  worn: readonly { material?: ArmourMaterial; acBonus?: number }[] = [],
): number {
  let best = 0;
  let bonus = 0;
  for (const piece of worn) {
    if (piece.material) best = Math.max(best, ARMOUR_CLASS_BY_MATERIAL[piece.material]);
    bonus += piece.acBonus ?? 0;
  }
  return BASE_ARMOUR_CLASS + dexterityAc(attrs) + best + bonus;
}

/* --------------------------------------------------------------- saves */

/**
 * The three ways to resist something, and which attribute answers for each.
 *
 * ⚠ This is what gives every attribute a roll, which is the half of the brief
 * most easily lost: strength rolls to hit and to hurt, dexterity sets AC and
 * rolls reflex, vigor sets health and rolls fortitude, will holds the mana
 * pool and rolls will. No attribute is only a number on a sheet.
 *
 * ⚠ `vigor` is this game's constitution and `will` its wisdom. The names were
 * fixed by D-546 before any of this existed and renaming them now would touch
 * every character record for no gain — so the mapping is written down instead.
 */
export const SAVES = ['fortitude', 'reflex', 'will'] as const;
export type Save = (typeof SAVES)[number];
export const SaveSchema = z.enum(SAVES);

export const SAVE_ATTRIBUTE: Readonly<Record<Save, keyof AttributeSet>> = {
  fortitude: 'vigor',
  reflex: 'dexterity',
  will: 'will',
};

export function saveBonusFor(attrs: AttributeSet, save: Save): number {
  return attrs[SAVE_ATTRIBUTE[save]] - ATTRIBUTE_BASE;
}

/* --------------------------------------------------------------- rolls */

export interface Attempt {
  /** The face that came up, 1..20, before anything is added. */
  readonly roll: number;
  /** The face plus every bonus. */
  readonly total: number;
  /** What it had to beat or match. */
  readonly against: number;
  readonly hit: boolean;
  /** A natural 20: hits whatever the numbers say. */
  readonly critical: boolean;
  /** A natural 1: misses whatever the numbers say. */
  readonly fumble: boolean;
}

export const D20 = 20;

/**
 * One d20 against a number.
 *
 * ⚠ A natural 1 always fails and a natural 20 always succeeds, whatever the
 * arithmetic says. That is the stakeholder's brief and it is also the rule
 * that keeps a fight from being decided before it starts: without it, an
 * attacker who cannot reach the AC on any face has no reason to swing, and
 * the underdog has no reason to be there.
 */
export function rollAgainst(
  against: number,
  bonus: number,
  roll: (sides: number) => number,
): Attempt {
  const face = roll(D20);
  const total = face + bonus;
  const critical = face === D20;
  const fumble = face === 1;
  return {
    roll: face,
    total,
    against,
    hit: critical || (!fumble && total >= against),
    critical,
    fumble,
  };
}

export interface Blow {
  readonly attack: Attempt;
  /** Zero when the attack missed. Rolled SEPARATELY, as the brief asks. */
  readonly damage: number;
}

/**
 * A whole swing: the attack, and — only if it lands — the damage.
 *
 * ⚠ The damage is its own roll and is not derived from how well the attack
 * roll went. A single roll doing both makes a hit that barely landed weak and
 * a hit that landed well strong, which sounds reasonable and means a character
 * who cannot miss also cannot roll badly.
 */
export function strike(
  attack: { bonus: number; damage: Dice; damageBonus: number },
  targetAc: number,
  roll: (sides: number) => number,
): Blow {
  const attempt = rollAgainst(targetAc, attack.bonus, roll);
  if (!attempt.hit) return { attack: attempt, damage: 0 };
  // ⚠ At least one. A hit that does nothing is indistinguishable from a miss
  // to everybody watching, and the brief separates the two on purpose.
  const rolled = rollDice(attack.damage, roll) + attack.damageBonus;
  return { attack: attempt, damage: Math.max(1, rolled) };
}

/** Handy for content notes and for the sheet: "needs 14+ (35%)". */
export function hitChance(bonus: number, against: number): number {
  const need = against - bonus;
  if (need <= 1) return 0.95; // a natural 1 still misses
  if (need > D20) return 0.05; // a natural 20 still hits
  return (D20 - need + 1) / D20;
}

export { ARMOUR_MATERIALS };
