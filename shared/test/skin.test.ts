import { describe, expect, it } from 'vitest';
import {
  MARKING_SOURCE,
  SKIN_SOURCE,
  VENDOR_SKIN_TONES,
  markingSwap,
  mirroredName,
  mirroredPart,
  skinFraction,
  parseHex,
  preferredAtlas,
  skinPalette,
  toHex,
} from '../src/skin';

/**
 * Skin as a colour rather than a file (D-560).
 *
 * The pack ships three tones as three atlases. Skin in this art is only FOUR
 * flat colours out of a 1024² atlas, so any colour a person picks is
 * reachable by substituting them — three was a property of how many files
 * somebody exported, not of the art.
 */
describe('recolouring skin (D-560)', () => {
  it('substitutes exactly the four colours the art uses', () => {
    const swaps = skinPalette('#ffccae');
    expect(swaps.map((s) => s.from)).toEqual([...SKIN_SOURCE]);
  });

  it('leaves the pale tone essentially where the artist put it', () => {
    // Picking the vendor's own base colour must reproduce the vendor's own
    // atlas, or the derivation is not describing this art.
    const swaps = skinPalette('#ffccae');
    expect(swaps[0]!.to).toBe('#ffccae');
    for (const [i, expected] of ['#ffccae', '#edaf97', '#cdb3a1', '#433622'].entries()) {
      const got = parseHex(swaps[i]!.to);
      const want = parseHex(expected);
      for (let c = 0; c < 3; c++) {
        // Within a few levels: the ratios are averaged across the vendor's
        // three tones, so no single tone is reproduced to the bit.
        expect(Math.abs(got[c]! - want[c]!), `${expected} channel ${c}`).toBeLessThan(24);
      }
    }
  });

  it('reproduces the darker vendor tones about as closely', () => {
    for (const tone of VENDOR_SKIN_TONES) {
      const base = parseHex(skinPalette(tone.rgb)[0]!.to);
      expect(base).toEqual(parseHex(tone.rgb));
    }
  });

  it('keeps every shade darker than the base', () => {
    // The three are shading, so a formula that ever brightened one would put
    // a highlight where the artist drew a shadow.
    for (const rgb of ['#ffffff', '#c98f6a', '#3a2418', '#000000']) {
      const swaps = skinPalette(rgb);
      const base = parseHex(swaps[0]!.to);
      for (const swap of swaps.slice(1)) {
        const shade = parseHex(swap.to);
        const sum = (c: readonly number[]): number => c[0]! + c[1]! + c[2]!;
        expect(sum(shade), `${rgb} -> ${swap.to}`).toBeLessThanOrEqual(sum(base));
      }
    }
  });

  it('stays inside the byte range at both ends', () => {
    for (const rgb of ['#ffffff', '#000000']) {
      for (const swap of skinPalette(rgb)) {
        expect(swap.to).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it('round-trips a colour', () => {
    expect(toHex(parseHex('#c98f6a'))).toBe('#c98f6a');
    expect(() => parseHex('nonsense')).toThrow();
  });
});

/**
 * Face markings, and the atlas that has them (D-560).
 *
 * The stakeholder named nine of twenty-three male heads and stopped, because
 * the other fourteen looked identical. They were right about why: those
 * fourteen carry war paint, and the tools were rendering against the ONE
 * atlas that does not have it.
 */
describe('face markings (D-560)', () => {
  it('is a channel of its own, not a skin colour', () => {
    // No other part in the pack touches it, so recolouring paint cannot
    // disturb skin and recolouring skin cannot disturb paint.
    expect(SKIN_SOURCE).not.toContain(MARKING_SOURCE);
    expect(markingSwap('#8f2f2f')).toEqual({ from: MARKING_SOURCE, to: '#8f2f2f' });
  });

  it('is untouched by a skin recolour', () => {
    for (const swap of skinPalette('#906850')) {
      expect(swap.from).not.toBe(MARKING_SOURCE);
    }
  });
});

describe('which atlas to render against (D-560)', () => {
  const PACK = [
    'PolygonFantasyHero_Texture_01',
    'PolygonFantasyHero_Texture_01_A',
    'PolygonFantasyHero_Texture_01_B',
    'PolygonFantasyHero_Texture_02_A',
    'PolygonFantasyHero_Texture_Mask_01',
  ];

  it('never picks the unlettered atlas, which has no markings', () => {
    // It LOOKS like the honest default — no colourway suffix — and it is the
    // markings-free cut. Against it, 28 of 46 heads sample plain skin and
    // become indistinguishable from the unmarked ones.
    expect(preferredAtlas(PACK)).toBe('PolygonFantasyHero_Texture_01_A');
  });

  it('never picks a mask, which is a shader channel and not a colourway', () => {
    expect(preferredAtlas(['PolygonFantasyHero_Texture_Mask_01'])).toBe('');
  });

  it('falls back rather than failing on a pack that names things differently', () => {
    expect(preferredAtlas(['some_other_atlas'])).toBe('some_other_atlas');
    expect(preferredAtlas([])).toBe('');
  });

  it('prefers any lettered variant when there is no _01_A', () => {
    expect(preferredAtlas(['x_02_B', 'x_plain'])).toBe('x_02_B');
  });
});

/**
 * Carrying a name to the other body (D-562).
 *
 * ⚠ The pairing is by NUMBER, and it is measured rather than hoped for: a
 * female torso shares 0.96 of its UV islands with the male torso of the same
 * number and 0.36 with any other one. Across every slot this pack cuts twice
 * — hips 0.97, legs 0.94, arms 0.89, hands 0.94 — against controls of 0.13 to
 * 0.36. It is the same garment cut for a different body.
 */
describe('mirroring a part to the other body (D-562)', () => {
  it('finds the counterpart by swapping the body, not the number', () => {
    expect(mirroredPart('SK_Chr_Torso_Male_12')).toBe('SK_Chr_Torso_Female_12');
    expect(mirroredPart('SK_Chr_Torso_Female_12')).toBe('SK_Chr_Torso_Male_12');
  });

  it('has nothing to say about a part the pack only cuts once', () => {
    // Hair, capes and pauldrons are unisex; inventing a counterpart would
    // name a file that does not exist.
    expect(mirroredPart('SK_Chr_Hair_04')).toBeNull();
    expect(mirroredPart('SK_Chr_BackAttachment_03')).toBeNull();
  });

  it('swaps the body word inside the name rather than copying it', () => {
    // "Studded leather male" arriving on a woman is the kind of mistake that
    // survives three hundred rows unnoticed.
    expect(mirroredName('Studded leather male', 'female')).toBe('Studded leather female');
    expect(mirroredName('Fine jacket Male', 'female')).toBe('Fine jacket Female');
    expect(mirroredName('Robe female', 'male')).toBe('Robe male');
  });

  it('leaves a name that says nothing about the body alone', () => {
    expect(mirroredName('Gothic plate', 'female')).toBe('Gothic plate');
    // And does not maul a word that merely contains one.
    expect(mirroredName('Malevolent robe', 'female')).toBe('Malevolent robe');
  });
});

describe('telling a bare body from a garment (D-562)', () => {
  const uvs = (vs: number[]): { count: number; getY(i: number): number } => ({
    count: vs.length,
    getY: (i: number) => vs[i]!,
  });

  it('reads it off the UVs, since the pack does not label its nude parts', () => {
    // Skin occupies the bottom 0.31 of the atlas — measured as the only
    // pixels that differ between the light and dark skin variants.
    expect(skinFraction(uvs([0.1, 0.2, 0.3]))).toBe(1);
    expect(skinFraction(uvs([0.5, 0.6]))).toBe(0);
    expect(skinFraction(uvs([0.1, 0.9]))).toBe(0.5);
  });

  it('says nothing about a part with no UVs rather than dividing by zero', () => {
    expect(skinFraction(uvs([]))).toBe(0);
  });
});
