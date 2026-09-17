import { describe, expect, it } from 'vitest';
import {
  itemGateProblem,
  EQUIP_SLOTS,
  EquipStatsSchema,
  MIN_DAMAGE,
  SLOT_GROUP,
  isTwoHanded,
  lookOf,
  loadoutTotals,
  slotCandidates,
  slotsOccupied,
  type EquipStats,
  type EquippedItem,
} from '../src/index';

const stats = (over: Partial<EquipStats> & { slot: EquipStats['slot'] }): EquipStats =>
  EquipStatsSchema.parse(over);

describe('slots (D-547)', () => {
  /**
   * `both-hands` is not a slot a character has — it is what an item declares.
   * Modelling it as a real slot was the first attempt and it produced a
   * shield worn alongside a greatsword, because nothing owned the conflict.
   */
  it('expands a two-hander into both hands', () => {
    expect(slotsOccupied('both-hands')).toEqual(['main-hand', 'off-hand']);
    expect(isTwoHanded('both-hands')).toBe(true);
    expect(isTwoHanded('main-hand')).toBe(false);
  });

  it('lets a ring go on either hand and defaults to the left', () => {
    expect(slotCandidates('ring')).toEqual(['ring-left', 'ring-right']);
    expect(slotsOccupied('ring')).toEqual(['ring-left']);
    expect(slotsOccupied('ring', 'ring-right')).toEqual(['ring-right']);
  });

  it('leaves an ordinary slot alone', () => {
    expect(slotsOccupied('chest')).toEqual(['chest']);
    expect(slotCandidates('chest')).toEqual(['chest']);
  });

  it('groups every slot for the paperdoll, with none left out', () => {
    for (const slot of EQUIP_SLOTS) expect(SLOT_GROUP[slot]).toBeDefined();
  });
});

describe('what a worn set is worth', () => {
  it('sums armour, reserve and weight', () => {
    const worn: EquippedItem[] = [
      { slot: 'chest', stats: stats({ slot: 'chest', armour: 3, weight: 14 }) },
      { slot: 'head', stats: stats({ slot: 'head', armour: 1, weight: 5 }) },
      { slot: 'amulet', stats: stats({ slot: 'amulet', mana: 3 }) },
    ];
    const totals = loadoutTotals(worn);
    expect(totals.armour).toBe(4);
    expect(totals.weight).toBe(19);
    expect(totals.mana).toBe(3);
  });

  /**
   * Damage takes the BEST weapon rather than the sum. Summing would make
   * dual-wielding strictly correct for everybody — a build decision nobody
   * made on purpose.
   */
  it('takes the best weapon, never the sum of two', () => {
    const worn: EquippedItem[] = [
      { slot: 'main-hand', stats: stats({ slot: 'main-hand', damage: 3 }) },
      { slot: 'off-hand', stats: stats({ slot: 'off-hand', damage: 2 }) },
    ];
    expect(loadoutTotals(worn).damage).toBe(3);
  });

  it('counts a two-hander once even though it fills two slots', () => {
    const greataxe: EquippedItem = {
      slot: 'main-hand',
      stats: stats({ slot: 'both-hands', damage: 4, weight: 14 }),
    };
    // The paperdoll shows it in both hands, so the caller may well pass it
    // twice; counting it twice would double its weight and its armour.
    expect(loadoutTotals([greataxe, greataxe]).weight).toBe(14);
    expect(loadoutTotals([greataxe, greataxe]).damage).toBe(4);
  });

  it('is zero for a naked character, at arm’s length', () => {
    // Reach falls back to one rather than zero: bare hands still reach the
    // tile in front of you, and a zero would make an unarmed character unable
    // to hit anything at all (D-550).
    // ⚠ The ac field is zero, not ten: this is what the WORN SET adds, and the base
    // ten belongs to the body (D-606). Folding the base in here would give a
    // naked character armour for being naked.
    expect(loadoutTotals([])).toEqual({
      armour: 0, damage: 0, mana: 0, weight: 0, range: 1, ac: 0,
    });
  });

  /**
   * Reach travels with the weapon that sets the damage, not separately. A bow
   * in one hand and a dagger in the other must not give a dagger's damage at
   * a bow's reach — or the correct build is always "hold a bow you never use".
   */
  it('takes reach from the weapon it is actually swinging', () => {
    const bow = { slot: 'main-hand' as const, stats: stats({ slot: 'both-hands', damage: 3, range: 6 }) };
    const dagger = { slot: 'off-hand' as const, stats: stats({ slot: 'off-hand', damage: 2 }) };
    expect(loadoutTotals([bow, dagger]).range).toBe(6);
    expect(loadoutTotals([dagger]).range).toBe(1);
  });
});

describe('the damage floor', () => {
  /**
   * Armour reduces and can never erase. An unkillable player in a round with
   * no respawn is not a tank, it is a stalemate the antagonist has no answer
   * to — so the floor is a constant the server clamps against, not a
   * tuning value that could drift to zero.
   */
  it('is at least one', () => {
    expect(MIN_DAMAGE).toBeGreaterThanOrEqual(1);
  });
});

describe('the schema defends the content files', () => {
  it('defaults every stat to nothing', () => {
    const parsed = EquipStatsSchema.parse({ slot: 'chest' });
    // ⚠ `acBonus` defaults to nothing and `damageDice` is ABSENT rather than
    // zeroed (D-606). A weapon with no dice falls back to its flat `damage`,
    // which is what forty-odd authored items still carry — a default of `0d0`
    // would turn every one of them into a weapon that cannot hurt anybody.
    expect(parsed).toEqual({
      slot: 'chest', armour: 0, damage: 0, mana: 0, weight: 0, range: 1, acBonus: 0,
    });
  });

  it('refuses a slot that does not exist', () => {
    expect(EquipStatsSchema.safeParse({ slot: 'tail' }).success).toBe(false);
  });

  it('bounds armour so a content typo cannot make somebody invulnerable', () => {
    expect(EquipStatsSchema.safeParse({ slot: 'chest', armour: 500 }).success).toBe(false);
  });
});

/**
 * What a calling may wear and wield (D-566).
 *
 * ⚠ The gate existed in the schema since D-566 and nothing evaluated it,
 * because an item did not know what it WAS — no material, and no link to the
 * asset carrying its stance. These pin the rules that make it safe to author.
 */
describe('class gates are access, never power', () => {
  const open = { armour: [], weapons: [], items: [] };

  it('⚠ empty means UNRESTRICTED, for every list', () => {
    // The nine classes authored before these fields existed carry none of
    // them. If empty ever meant "nothing allowed", every one of them would
    // become unplayable at once, silently.
    expect(itemGateProblem(open, { id: 'x', material: 'plate' })).toBeNull();
    expect(itemGateProblem(open, { id: 'x', stance: 'two-handed' })).toBeNull();
  });

  it('refuses a material the calling does not admit, and says which', () => {
    const caster = { armour: ['cloth'], weapons: [], items: [] };
    expect(itemGateProblem(caster, { id: 'x', material: 'plate' })).toMatch(/plate/);
    expect(itemGateProblem(caster, { id: 'x', material: 'cloth' })).toBeNull();
  });

  it('refuses a weapon stance the calling does not admit', () => {
    const caster = { armour: [], weapons: ['staff', 'dagger'], items: [] };
    expect(itemGateProblem(caster, { id: 'x', stance: 'two-handed' })).toMatch(/two-handed/);
    expect(itemGateProblem(caster, { id: 'x', stance: 'staff' })).toBeNull();
  });

  it('⚠ `items` is an EXCEPTION list, not a whitelist', () => {
    // The schema calls it "beyond the broad gates". Read as a whitelist it
    // would mean naming every ordinary item on every class, and a class with
    // one exception would lose everything else.
    const caster = { armour: ['cloth'], weapons: [], items: ['warded-plate'] };
    expect(itemGateProblem(caster, { id: 'warded-plate', material: 'plate' })).toBeNull();
    expect(itemGateProblem(caster, { id: 'ordinary-robe', material: 'cloth' })).toBeNull();
    expect(itemGateProblem(caster, { id: 'other-plate', material: 'plate' })).toMatch(/plate/);
  });

  it('says nothing about things that are neither armour nor a weapon', () => {
    const caster = { armour: ['cloth'], weapons: ['staff'], items: [] };
    // A ring, a charm, a loaf: no material, no stance, no gate.
    expect(itemGateProblem(caster, { id: 'bone-ring' })).toBeNull();
  });
});

describe('which weapon, not just that there is one (D-614)', () => {
  it('⚠ carries the art of the SAME item the silhouette picked', () => {
    // ⚠ The silhouette says 'sword' for every blade in the game, so it cannot
    // tell a client which mesh to put in the hand. The art rides alongside it
    // — and off the same item, because choosing the silhouette from one
    // weapon while drawing another is a man swinging a sword he is not
    // holding (the reasoning `stance` already carries).
    const look = lookOf([
      { slot: 'main-hand', stats: stats({ damage: 5, slot: 'main-hand' }), art: 'knights/wep-broadsword-01' },
      { slot: 'off-hand', stats: stats({ damage: 1, slot: 'off-hand' }), art: 'dungeon-pack/wep-shield-heater-01' },
    ]);
    expect(look.weapon).toBe('sword');
    expect(look.weaponArt, 'the better weapon is the one drawn').toBe('knights/wep-broadsword-01');
  });

  it('is simply absent for a weapon nobody has fitted', () => {
    // Thirty of the thirty-eight items name no art at all. Absent means "no
    // particular sword", not "no sword" — the flag beside it still says a
    // hand is full, and the procedural cast draws its own blade from that.
    const look = lookOf([
      { slot: 'main-hand', stats: stats({ damage: 3, slot: 'main-hand' }) },
    ]);
    expect(look.weapon).toBe('sword');
    expect(look.weaponArt).toBeUndefined();
  });
});
