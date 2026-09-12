import { describe, expect, it } from 'vitest';
import { carry, draftName } from '../src/name-assets';

/**
 * Drafting names from filenames (D-563).
 *
 * The stakeholder asked for this directly: the vendor's filenames are
 * descriptive, so six hundred names should not be typed by hand. What comes
 * out is a DRAFT — mechanical, occasionally clumsy, corrected in the tool.
 */
describe('drafting a name from a filename (D-563)', () => {
  it('drops the vendor prefixes and the variant number', () => {
    expect(draftName('SM_Wep_Broadsword_01')).toBe('Broadsword');
    expect(draftName('SM_Item_Potion_01')).toBe('Potion');
  });

  it('keeps a modifier that already reads correctly', () => {
    expect(draftName('SM_Wep_Goblin_Bone_Axe_01')).toBe('Goblin bone axe');
  });

  it('moves a TRAILING modifier to the front, where English puts it', () => {
    // `Axe_Nature` is a filing convention, not a name.
    expect(draftName('SM_Wep_Axe_Nature_01')).toBe('Nature axe');
    expect(draftName('SM_Wep_Hammer_Large_01')).toBe('Large hammer');
    expect(draftName('SM_Wep_Crystal_Axe_Large_01')).toBe('Large crystal axe');
  });

  it('drops the vendor filing infix that is not part of the name', () => {
    expect(draftName('SM_Item_Chr_Bag_Large_01')).toBe('Large bag');
  });

  it('TERMINATES when every word is a modifier', () => {
    // ⚠ The first version rotated one word at a time and looped while the new
    // last word was a modifier, so `Bone_Spikes` became `Spikes_Bone` became
    // `Bone_Spikes` forever. It did not throw — the build simply hung.
    expect(draftName('SM_Wep_Bone_Spikes_01')).toBeTruthy();
    expect(draftName('SM_Wep_Iron_Stone_Gold_01')).toBeTruthy();
    expect(draftName('SM_Wep_Large_01')).toBe('Large');
  });

  it('splits camel case, since the pack mixes both conventions', () => {
    expect(draftName('SM_Wep_FishingSpear_01')).toBe('Fishing spear');
  });
});

describe('guessing how a weapon is carried (D-563)', () => {
  it('puts a shield and a bow in the off hand', () => {
    expect(carry('SM_Wep_Shield_01')).toEqual({ attach: 'Hand_L', stance: 'one-handed-shield' });
    expect(carry('SM_Wep_Longbow_01').stance).toBe('bow');
  });

  it('reads two-handed and polearm from the name', () => {
    expect(carry('SM_Wep_Zweihander_01').stance).toBe('two-handed');
    expect(carry('SM_Wep_FishingSpear_01').stance).toBe('polearm');
    expect(carry('SM_Wep_Halberd_01').stance).toBe('polearm');
  });

  it('falls back to the SAFE guess, never to an exotic one', () => {
    // A wrong stance is one dropdown to fix; a wrong attach is a sword
    // through a wrist.
    expect(carry('SM_Wep_Unnameable_01')).toEqual({ attach: 'Hand_R', stance: 'one-handed' });
  });
});

describe('the bow pack (D-568)', () => {
  it('drafts a bow into the off hand, which the old boundary never did', () => {
    // ⚠ `/bow\b/` does NOT match `rigged_bow_testing`. `_` is a word
    // character, so there is no boundary after "bow" — the branch matched no
    // filename in any pack, and the `bow` stance was unreachable by the
    // drafter for as long as it existed. Nothing threw: a bow was drafted as
    // a one-handed weapon in the right fist, which reads as a clumsy name
    // rather than as a dead branch.
    expect(carry('Rigged_Bow_Testing')).toEqual({ attach: 'Hand_L', stance: 'bow' });
    expect(carry('SM_Wep_Bow_01').stance).toBe('bow');
  });

  it('reads a crossbow as a crossbow, never as a bow', () => {
    expect(carry('Rigged_CrossBow_Testing').stance).toBe('crossbow');
    expect(carry('SM_Wep_Crossbow_01').stance).toBe('crossbow');
  });

  it('does not call an elbow or a bowl a bow', () => {
    // The reason the boundary is `_` and not "contains".
    expect(carry('SM_Wep_Elbow_Blade_01').stance).not.toBe('bow');
    expect(carry('SM_Item_Bowl_01').stance).not.toBe('bow');
  });
});
