import { describe, expect, it } from 'vitest';
import {
  GARMENT_SLOTS,
  garmentMaterial,
  garmentProblems,
  garmentSlots,
  mirrorGarmentParts,
  type GarmentDef,
} from '../src';

/**
 * The wardrobe rules (D-562's finding, built as D-570).
 *
 * ⚠ These are the rules the editor and CI both read. The editor's promise is
 * that it refuses what the build refuses, and that is only true while there
 * is one implementation of "what is wrong with this garment".
 */

function garment(over: Partial<GarmentDef> = {}): GarmentDef {
  return {
    id: 'mail-hauberk',
    name: 'Mail hauberk',
    pack: 'modular-fantasy-hero',
    parts: {
      male: { torso: 'SK_Chr_Torso_Male_12' },
      female: { torso: 'SK_Chr_Torso_Female_12' },
    },
    swaps: [],
    ...over,
  };
}

describe('what a garment may dress (D-570)', () => {
  it('excludes what a character IS rather than wears', () => {
    // ⚠ A garment is stripped between rounds (D-522). One that replaced your
    // face would change who you looked like when you took it off, and gear
    // must never reach the descriptor pipeline — that is the permanent
    // disguise D-539 and D-547 both refused.
    for (const identity of ['head', 'hair', 'facialHair', 'eyebrows', 'ears']) {
      expect(GARMENT_SLOTS).not.toContain(identity);
    }
  });

  it('includes the helmet, which is not an exception to that', () => {
    // In this pack a closed helm IS the head mesh — it has no `eyes` bone,
    // because the face is inside it — so wearing one necessarily swaps the
    // head. It conceals rather than rewrites: take it off and the authored
    // face is still underneath.
    expect(GARMENT_SLOTS).toContain('helmet');
    expect(GARMENT_SLOTS).toContain('torso');
    expect(GARMENT_SLOTS).toContain('handL');
  });

  it('reports every slot dressed on either body', () => {
    expect(garmentSlots(garment())).toEqual(['torso']);
  });
});

describe('validating a garment (D-570)', () => {
  it('passes a garment cut for both bodies', () => {
    expect(garmentProblems(garment(), null)).toEqual([]);
  });

  it('refuses a garment only half the cast can wear', () => {
    // ⚠ THE check. Nothing downstream would say so: the other body would
    // simply render in whatever it had on underneath, which reads as an art
    // glitch rather than as missing content.
    const oneSided = garment({
      parts: { male: { torso: 'SK_Chr_Torso_Male_12' }, female: {} },
    });
    expect(garmentProblems(oneSided, null)).toEqual(['torso: dressed on a male body only']);

    const other = garment({
      parts: { male: {}, female: { torso: 'SK_Chr_Torso_Female_12' } },
    });
    expect(garmentProblems(other, null)).toEqual(['torso: dressed on a female body only']);
  });

  it('refuses a part filed under the wrong slot', () => {
    // The mistake a form makes easiest — the dropdown is right there — and
    // invisible in the JSON afterwards, because both halves read as plausible
    // strings.
    const wrong = garment({
      parts: {
        male: { torso: 'SK_Chr_HandLeft_Male_01' },
        female: { torso: 'SK_Chr_HandLeft_Female_01' },
      },
    });
    expect(garmentProblems(wrong, null)).toEqual([
      "male torso: 'SK_Chr_HandLeft_Male_01' is a handL, not a torso",
      "female torso: 'SK_Chr_HandLeft_Female_01' is a handL, not a torso",
    ]);
  });

  it('refuses a part cut for the other body', () => {
    // A female forearm bound to a male upper arm meets it at the wrong
    // diameter, and the seam is visible from three metres (D-558).
    const swapped = garment({
      parts: {
        male: { torso: 'SK_Chr_Torso_Female_12' },
        female: { torso: 'SK_Chr_Torso_Female_12' },
      },
    });
    expect(garmentProblems(swapped, null)).toContain(
      "male torso: 'SK_Chr_Torso_Female_12' is cut for a female body",
    );
  });

  it('refuses a garment that dresses nothing', () => {
    expect(garmentProblems(garment({ parts: { male: {}, female: {} } }), null)).toEqual([
      'dresses nothing — a garment must fill at least one slot',
    ]);
  });

  it('checks the pack only when it can SEE the pack', () => {
    // ⚠ `assets/source/` is gitignored, so `null` is CI's normal state. A
    // skipped check is the only honest answer; the authoring server passes
    // the real set because it has the art in front of it.
    expect(garmentProblems(garment(), null)).toEqual([]);
    const present = new Set(['SK_Chr_Torso_Male_12', 'SK_Chr_Torso_Female_12']);
    expect(garmentProblems(garment(), present)).toEqual([]);
    expect(garmentProblems(garment(), new Set(['SK_Chr_Torso_Male_12']))).toEqual([
      "female torso: 'SK_Chr_Torso_Female_12' is not in modular-fantasy-hero",
    ]);
  });
});

describe('what a garment is made of (D-570)', () => {
  const tags = {
    SK_Chr_Torso_Male_12: ['plate'],
    SK_Chr_Torso_Female_12: ['plate'],
    SK_Chr_HandLeft_Male_03: ['leather'],
    SK_Chr_HandLeft_Female_03: ['leather'],
    SK_Chr_Torso_Male_00: ['base', 'leather'],
    SK_Chr_Torso_Female_00: ['base', 'leather'],
  };

  it('is DERIVED from the parts, not declared', () => {
    // D-566 put `material` on the item under protest and said so: "should not
    // outlive the garment editor". The parts already carry it by measurement.
    expect(garmentMaterial(garment(), tags)).toBe('plate');
  });

  it('takes the HEAVIEST part, so a suit is not gated by its softest inch', () => {
    // A mail hauberk with leather gloves is plate. Taking the lightest would
    // let a class barred from plate get around the gate by the gloves.
    const mixed = garment({
      parts: {
        male: { torso: 'SK_Chr_Torso_Male_12', handL: 'SK_Chr_HandLeft_Male_03' },
        female: { torso: 'SK_Chr_Torso_Female_12', handL: 'SK_Chr_HandLeft_Female_03' },
      },
    });
    expect(garmentMaterial(mixed, tags)).toBe('plate');
  });

  it('never lets BARE count as a material', () => {
    // `base` is bare skin, which is the absence of armour. Folding it in
    // would let a class "admit bare" as though it were a kind of protection
    // (D-566).
    const bare = garment({
      parts: {
        male: { torso: 'SK_Chr_Torso_Male_00' },
        female: { torso: 'SK_Chr_Torso_Female_00' },
      },
    });
    expect(garmentMaterial(bare, tags)).toBe('leather');
    expect(garmentMaterial(bare, { SK_Chr_Torso_Male_00: ['base'] })).toBeNull();
  });

  it('returns null rather than defaulting to cloth', () => {
    // Empty means UNRESTRICTED everywhere else in this codebase, and a silent
    // default here would be the one place it did not.
    expect(garmentMaterial(garment(), {})).toBeNull();
  });
});

describe('filling in the other body (D-570)', () => {
  it('pairs by number, which was measured', () => {
    expect(mirrorGarmentParts({ torso: 'SK_Chr_Torso_Male_12' }, 'female')).toEqual({
      torso: 'SK_Chr_Torso_Female_12',
    });
    expect(mirrorGarmentParts({ torso: 'SK_Chr_Torso_Female_12' }, 'male')).toEqual({
      torso: 'SK_Chr_Torso_Male_12',
    });
  });

  it('carries a UNISEX part across unchanged', () => {
    // Parts the pack cuts once — a cape, a pauldron — belong to both bodies,
    // and inventing a `_Female_` spelling for one would name a file that does
    // not exist.
    const cape = { back: 'SK_Chr_BackAttachment_01' };
    expect(mirrorGarmentParts(cape, 'female')).toEqual(cape);
  });

  it('round-trips', () => {
    const male = { torso: 'SK_Chr_Torso_Male_12', back: 'SK_Chr_BackAttachment_01' };
    expect(mirrorGarmentParts(mirrorGarmentParts(male, 'female'), 'male')).toEqual(male);
  });
});
