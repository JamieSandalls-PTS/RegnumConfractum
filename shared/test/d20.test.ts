import { describe, expect, it } from 'vitest';
import {
  ARMOUR_CLASS_BY_MATERIAL,
  ATTRIBUTE_BASE,
  BASE_ARMOUR_CLASS,
  SAVES,
  SAVE_ATTRIBUTE,
  armourClass,
  attackBonusFor,
  baseAttributes,
  diceRange,
  hitChance,
  parseDice,
  rollAgainst,
  rollDice,
  saveBonusFor,
  strike,
  type AttributeSet,
  type Save,
} from '../src/index';

/**
 * Dice combat and Armour Class (D-606).
 *
 * ⚠ Every one of these is a claim about a NUMBER, which is the point. A combat
 * system is where "it felt wrong" is least useful: the difference between a
 * fair fight and an unwinnable one is two points of a modifier, and nobody can
 * see that by playing a dozen rounds.
 */

const attrs = (over: Partial<AttributeSet> = {}): AttributeSet =>
  ({ ...baseAttributes(), ...over }) as AttributeSet;

/** A d20 that always shows the same face, so a rule can be tested alone. */
const always = (face: number) => () => face;

describe('dice', () => {
  it('reads the notations content will actually use', () => {
    expect(parseDice('1d6')).toEqual({ count: 1, sides: 6, flat: 0 });
    expect(parseDice('2d4+1')).toEqual({ count: 2, sides: 4, flat: 1 });
    expect(parseDice('1d8-1')).toEqual({ count: 1, sides: 8, flat: -1 });
    // ⚠ A flat number is legal. Most things in the world are not weapons, and
    // making the simple case expressible is what stops content inventing a
    // notation for it.
    expect(parseDice('3')).toEqual({ count: 0, sides: 0, flat: 3 });
  });

  it('rolls within the range it advertises', () => {
    for (const spec of ['1d6', '2d4+1', '1d8-1', '3'] as const) {
      const [lo, hi] = diceRange(spec);
      expect(rollDice(spec, always(1))).toBe(lo);
      expect(rollDice(spec, (sides) => sides)).toBe(hi);
    }
  });
});

describe('armour class', () => {
  it('starts at ten for everybody, as the brief asks', () => {
    expect(armourClass(attrs())).toBe(BASE_ARMOUR_CLASS);
  });

  it('moves one point per point of dexterity, both ways', () => {
    expect(armourClass(attrs({ dexterity: ATTRIBUTE_BASE + 5 }))).toBe(BASE_ARMOUR_CLASS + 5);
    // ⚠ And DOWN below ten. The brief says "negative for less", which is the
    // half a clamp at zero would quietly drop.
    expect(armourClass(attrs({ dexterity: ATTRIBUTE_BASE - 3 }))).toBe(BASE_ARMOUR_CLASS - 3);
  });

  it('takes the HEAVIEST piece, never the sum', () => {
    // ⚠ Four pieces of leather is not plate. Adding them up is how somebody in
    // gloves, boots, a cap and a jerkin out-armours a knight.
    const kitted = armourClass(attrs(), [
      { material: 'leather' }, { material: 'leather' },
      { material: 'leather' }, { material: 'leather' },
    ]);
    expect(kitted).toBe(BASE_ARMOUR_CLASS + ARMOUR_CLASS_BY_MATERIAL.leather);
    expect(kitted).toBeLessThan(BASE_ARMOUR_CLASS + ARMOUR_CLASS_BY_MATERIAL.plate);
  });

  it('adds every item bonus on top, because those DO stack', () => {
    const ac = armourClass(attrs(), [
      { material: 'plate', acBonus: 1 }, { acBonus: 2 },
    ]);
    expect(ac).toBe(BASE_ARMOUR_CLASS + ARMOUR_CLASS_BY_MATERIAL.plate + 3);
  });
});

describe('the roll', () => {
  it('a natural 1 always fails, whatever the arithmetic says', () => {
    // Bonus large enough that 1 + bonus clears the target several times over.
    const attempt = rollAgainst(5, 50, always(1));
    expect(attempt.fumble).toBe(true);
    expect(attempt.hit).toBe(false);
  });

  it('a natural 20 always hits, whatever the arithmetic says', () => {
    const attempt = rollAgainst(99, -50, always(20));
    expect(attempt.critical).toBe(true);
    expect(attempt.hit).toBe(true);
  });

  it('hits on meeting the number, not only on beating it', () => {
    expect(rollAgainst(15, 0, always(15)).hit).toBe(true);
    expect(rollAgainst(15, 0, always(14)).hit).toBe(false);
  });

  it('reports what it needed, so a log can explain itself', () => {
    const a = rollAgainst(14, 3, always(9));
    expect(a).toMatchObject({ roll: 9, total: 12, against: 14, hit: false });
  });
});

describe('the swing', () => {
  it('rolls damage SEPARATELY, and only when the attack landed', () => {
    const miss = strike({ bonus: 0, damage: '1d6', damageBonus: 0 }, 30, always(2));
    expect(miss.attack.hit).toBe(false);
    expect(miss.damage).toBe(0);
  });

  it('does not derive damage from how well the attack rolled', () => {
    // ⚠ The thing a single roll doing both would break: a hit that barely
    // landed would be weak, so a character who cannot miss also cannot roll
    // badly. Here the attack face is fixed and the damage still varies.
    const faces = [1, 2, 3, 4, 5, 6];
    let next = 0;
    const roll = (sides: number): number => (sides === 20 ? 20 : faces[next++ % faces.length]!);
    const seen = new Set<number>();
    for (let i = 0; i < faces.length; i++) {
      next = i;
      seen.add(strike({ bonus: 0, damage: '1d6', damageBonus: 0 }, 10, roll).damage);
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('never lands for nothing', () => {
    // A hit that does no damage is indistinguishable from a miss to everybody
    // watching, and the brief separates the two on purpose.
    const blow = strike({ bonus: 0, damage: '1d6', damageBonus: -20 }, 5, always(20));
    expect(blow.attack.hit).toBe(true);
    expect(blow.damage).toBeGreaterThanOrEqual(1);
  });
});

describe('every attribute rolls something', () => {
  it('gives each save an attribute, and each attribute a job', () => {
    // ⚠ The half of the brief most easily lost: "Every stat should impact some
    // sort of roll." Strength rolls to hit and to hurt; dexterity sets AC and
    // rolls reflex; vigor holds health and rolls fortitude; will holds mana
    // and rolls will. No attribute is only a number on a sheet.
    expect(new Set(Object.values(SAVE_ATTRIBUTE))).toEqual(
      new Set(['vigor', 'dexterity', 'will']),
    );
    expect(attackBonusFor(attrs({ strength: ATTRIBUTE_BASE + 4 }))).toBeGreaterThan(0);
  });

  it('moves a save one point per point, both ways', () => {
    for (const save of SAVES) {
      const attr = SAVE_ATTRIBUTE[save];
      expect(saveBonusFor(attrs({ [attr]: ATTRIBUTE_BASE + 3 } as Partial<AttributeSet>), save))
        .toBe(3);
      expect(saveBonusFor(attrs({ [attr]: ATTRIBUTE_BASE - 2 } as Partial<AttributeSet>), save))
        .toBe(-2);
    }
  });

  it('keeps the three saves independent', () => {
    // Dumping dexterity must not make you easier to poison.
    const nimble = attrs({ dexterity: 20, vigor: 10 });
    const tough = attrs({ dexterity: 10, vigor: 20 });
    expect(saveBonusFor(nimble, 'reflex')).toBeGreaterThan(saveBonusFor(tough, 'reflex'));
    expect(saveBonusFor(tough, 'fortitude')).toBeGreaterThan(saveBonusFor(nimble, 'fortitude'));
  });
});

describe('the curve, stated so it can be argued with', () => {
  it('never makes a fight completely unwinnable', () => {
    // ⚠ The reason the natural 20 rule is not decoration. An unarmoured
    // attacker with no strength against a nimble opponent in plate still has
    // one chance in twenty, so there is a reason to swing.
    expect(hitChance(0, 99)).toBeCloseTo(0.05, 5);
    expect(hitChance(99, 0)).toBeCloseTo(0.95, 5);
  });

  it('is the curve the stakeholder asked for, at the numbers this game uses', () => {
    // Written down rather than discovered in play: an UNINVESTED attacker
    // against an invested defender is the case that falls off a cliff, and
    // this is the line that will fail the day somebody halves the modifiers.
    const weak = attackBonusFor(attrs());
    const nimble = armourClass(attrs({ dexterity: 20 }));
    expect(hitChance(weak, nimble)).toBeCloseTo(0.05, 5);

    const strong = attackBonusFor(attrs({ strength: 20 }));
    expect(hitChance(strong, nimble)).toBeCloseTo(0.55, 5);
    // Two evenly matched, unarmoured: a coin flip and a bit, which is the
    // shape a d20 system is supposed to have.
    expect(hitChance(weak, armourClass(attrs()))).toBeCloseTo(0.55, 5);
  });
});

describe('a save is a roll like any other', () => {
  it('resists on meeting the difficulty', () => {
    const save: Save = 'will';
    const bonus = saveBonusFor(attrs({ will: 14 }), save);
    expect(rollAgainst(15, bonus, always(11)).hit).toBe(true);
    expect(rollAgainst(15, bonus, always(10)).hit).toBe(false);
  });
});
