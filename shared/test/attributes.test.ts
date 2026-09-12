import { describe, expect, it } from 'vitest';
import {
  ATTRIBUTES,
  ATTRIBUTE_BASE,
  ATTRIBUTE_CREATION_MAX,
  ATTRIBUTE_CREATION_POINTS,
  ATTRIBUTE_LEVELS,
  DEFAULT_MAX_HP,
  MAX_LEVEL,
  advancementBudget,
  advancementUnspent,
  attributePointsAt,
  baseAttributes,
  carryBonusFor,
  damageBonusFor,
  emptyAdvances,
  glanceChanceFor,
  maxHpFor,
  maxManaFor,
  resolveAttributes,
  totalAttributes,
  validateAttributeAllocation,
  GLANCE_CAP,
} from '../src/index';

describe('attributes start identical for every calling (D-546)', () => {
  it('bases at ten across the board', () => {
    const base = baseAttributes();
    for (const attr of ATTRIBUTES) expect(base[attr]).toBe(ATTRIBUTE_BASE);
  });

  /**
   * The compatibility contract, and the reason no migration backfills
   * anything: a character written before attributes existed reads back as the
   * character the pre-attribute code produced, with the same health it had.
   */
  it('reads a missing set as the old character exactly', () => {
    expect(resolveAttributes(null)).toEqual(baseAttributes());
    expect(resolveAttributes(undefined)).toEqual(baseAttributes());
    expect(maxHpFor(resolveAttributes(null))).toBe(DEFAULT_MAX_HP);
    expect(damageBonusFor(resolveAttributes(null))).toBe(0);
    expect(carryBonusFor(resolveAttributes(null))).toBe(0);
    expect(glanceChanceFor(resolveAttributes(null))).toBe(0);
  });

  it('fills only the fields a partial set names', () => {
    const set = resolveAttributes({ vigor: 17 });
    expect(set.vigor).toBe(17);
    expect(set.strength).toBe(ATTRIBUTE_BASE);
  });
});

describe('derived stats', () => {
  it('turns vigor into health, one for one', () => {
    expect(maxHpFor({ ...baseAttributes(), vigor: 20 })).toBe(DEFAULT_MAX_HP + 10);
    expect(maxHpFor({ ...baseAttributes(), vigor: 4 })).toBe(DEFAULT_MAX_HP - 6);
  });

  it('never lets health reach zero from attributes alone', () => {
    expect(maxHpFor({ ...baseAttributes(), vigor: 0 })).toBeGreaterThan(0);
  });

  it('turns will into a reserve', () => {
    expect(maxManaFor(baseAttributes())).toBeGreaterThan(0);
    expect(maxManaFor({ ...baseAttributes(), will: 20 })).toBeGreaterThan(
      maxManaFor(baseAttributes()),
    );
  });

  /**
   * The whole creation allocation in strength buys +2 on a 2-6 roll. If this
   * ever climbs, D-529's buddy system is what pays for it — a character who
   * can take the night alone deletes the reason to take a partner.
   */
  it('keeps the strength damage bonus coarse and small', () => {
    expect(damageBonusFor(baseAttributes())).toBe(0);
    expect(damageBonusFor({ ...baseAttributes(), strength: ATTRIBUTE_CREATION_MAX })).toBe(2);
    // Even at the lifetime ceiling.
    expect(damageBonusFor({ ...baseAttributes(), strength: ATTRIBUTE_CREATION_MAX + 4 })).toBe(3);
  });

  it('caps evasion so a fight is never decided by luck alone', () => {
    expect(glanceChanceFor({ ...baseAttributes(), dexterity: 99 })).toBe(GLANCE_CAP);
  });
});

describe('the creation allocation is bounded (D-102)', () => {
  it('accepts a legal spread', () => {
    expect(validateAttributeAllocation({ strength: 14, vigor: 16 })).toEqual([]);
  });

  it('refuses more points than the budget', () => {
    const errors = validateAttributeAllocation({ strength: 20, vigor: 20 });
    expect(errors.join(' ')).toContain('overspent');
  });

  it('refuses a single attribute above the creation cap', () => {
    const errors = validateAttributeAllocation({ strength: ATTRIBUTE_CREATION_MAX + 1 });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('refuses dumping below the base to fund a specialist', () => {
    // Without this, 4/4/4/28 would be legal by point count alone.
    const errors = validateAttributeAllocation({ strength: 4, vigor: 16 });
    expect(errors.join(' ')).toContain('cannot go below');
  });

  it('refuses an attribute that does not exist', () => {
    expect(validateAttributeAllocation({ charisma: 14 }).join(' ')).toContain('unknown');
  });

  it('spends exactly the advertised budget at the cap', () => {
    expect(
      validateAttributeAllocation({ strength: ATTRIBUTE_BASE + ATTRIBUTE_CREATION_POINTS }),
    ).toEqual([]);
  });
});

describe('level-up spending (D-546)', () => {
  it('hands out attribute points only on the named levels', () => {
    expect(attributePointsAt(1)).toBe(0);
    expect(attributePointsAt(2)).toBe(0);
    expect(attributePointsAt(ATTRIBUTE_LEVELS[0]!)).toBe(1);
    expect(attributePointsAt(MAX_LEVEL)).toBe(ATTRIBUTE_LEVELS.length);
  });

  /**
   * The safety argument for crossing D-538's fence at all: four points across
   * a whole career. At the ceiling that is +4 health OR +1 damage — visible
   * on a sheet, invisible in a fight.
   */
  it('never lets a lifetime of levels buy more than four points', () => {
    expect(advancementBudget(MAX_LEVEL, false).attributePoints).toBeLessThanOrEqual(4);
  });

  it('gives a caster spells and everyone else none', () => {
    expect(advancementBudget(MAX_LEVEL, true).spells).toBeGreaterThan(0);
    expect(advancementBudget(MAX_LEVEL, false).spells).toBe(0);
  });

  it('grants nothing at all at level one', () => {
    const budget = advancementBudget(1, true);
    expect(budget.attributePoints).toBe(0);
    expect(budget.skillPoints).toBe(0);
    expect(budget.feats).toBe(0);
    expect(budget.spells).toBe(0);
  });

  it('reports what is still on the table', () => {
    const unspent = advancementUnspent(MAX_LEVEL, false, emptyAdvances());
    expect(unspent.attributePoints).toBe(advancementBudget(MAX_LEVEL, false).attributePoints);
    const half = { ...emptyAdvances(), attributes: { strength: 2 } };
    expect(advancementUnspent(MAX_LEVEL, false, half).attributePoints).toBe(
      unspent.attributePoints - 2,
    );
  });

  /**
   * A player who levelled twice while away must not lose a pick. The budget
   * is cumulative, so both screens' worth is waiting when they come back.
   */
  it('accumulates rather than expiring', () => {
    expect(advancementBudget(5, false).skillPoints).toBeGreaterThan(
      advancementBudget(3, false).skillPoints,
    );
  });

  it('adds level-up points on top of the creation allocation', () => {
    const total = totalAttributes({ strength: 16 }, { strength: 3 });
    expect(total.strength).toBe(19);
    expect(total.vigor).toBe(ATTRIBUTE_BASE);
  });
});
