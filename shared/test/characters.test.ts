import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_SLOTS,
  BODY_SLOTS,
  CHARACTER_SLOTS,
  CharacterDefSchema,
  SLOT_ALTERNATIVES,
  SLOT_REQUIRES,
  type CharacterDef,
  type ParsedPart,
  concealedSlots,
  missingBodySlots,
  parsePolygonPart,
  partProblems,
} from '../src/characters';

/**
 * What a part IS, and what wearing it rules out (D-558).
 *
 * Two of this pack's prefixes are not what they sound like, and the
 * stakeholder found both by looking at the studio's lists:
 *
 *   - `SK_Chr_Head_No_Elements_*` reads like a plain head with the trimmings
 *     left off. It is a HELMED head — two to four times the vertices of a
 *     bare one, half again as deep front to back, and carrying no `eyes`
 *     bone because the face is inside it.
 *   - `SK_Chr_HelmetAttachment_*` reads like a helmet. It is a crest, and it
 *     sits at y=173-195, above the skull, with nothing to mount on unless a
 *     helm is already there.
 *
 * Filed under both slots wrongly, the studio offered 72 "heads" of which a
 * third were helmets, and a "helmet" list made entirely of plumes.
 */
describe('the part catalogue (D-558)', () => {
  const of = (file: string): ParsedPart => {
    const parsed = parsePolygonPart(file);
    expect(parsed, `${file} did not parse`).toBeTruthy();
    return parsed!;
  };

  it('files a bare head as a head', () => {
    expect(of('SK_Chr_Head_Male_04.fbx').slot).toBe('head');
    expect(of('SK_Chr_Head_Male_04.fbx').sex).toBe('male');
    expect(of('SK_Chr_Head_Male_04.fbx').conceals).toHaveLength(0);
  });

  it('files a helmed head as a helmet, not a head', () => {
    const helm = of('SK_Chr_Head_No_Elements_Male_04.fbx');
    expect(helm.slot).toBe('helmet');
    expect(helm.sex).toBe('male');
  });

  it('files a helmet attachment as a crest, not a helmet', () => {
    expect(of('SK_Chr_HelmetAttachment_07.fbx').slot).toBe('helmetCrest');
  });

  it('reads what a head covering hides off its own name', () => {
    // The pack states the cut in the filename, so three hoods in one slot
    // can disagree about whether hair shows.
    expect(of('SK_Chr_HeadCoverings_Base_Hair_01.fbx').conceals).toHaveLength(0);
    expect(of('SK_Chr_HeadCoverings_No_Hair_01.fbx').conceals).toEqual(['hair']);
    expect(of('SK_Chr_HeadCoverings_No_FacialHair_01.fbx').conceals).toEqual(['facialHair']);
  });

  it('still ignores a file it does not recognise', () => {
    expect(parsePolygonPart('SK_Chr_Wings_Male_01.fbx')).toBeNull();
    expect(parsePolygonPart('readme.txt')).toBeNull();
  });

  it('names every slot it files into', () => {
    // A slot the parser can produce but the vocabulary does not list is a
    // part that vanishes from the studio without a word.
    for (const file of [
      'SK_Chr_Head_Male_04',
      'SK_Chr_Head_No_Elements_Male_04',
      'SK_Chr_HelmetAttachment_01',
      'SK_Chr_HeadCoverings_No_Hair_01',
      'SK_Chr_BackAttachment_03',
      'SK_Chr_Ear_Ear_01',
    ]) {
      expect(CHARACTER_SLOTS).toContain(of(`${file}.fbx`).slot);
    }
  });
});

describe('what a helmet rules out (D-558)', () => {
  const helm = parsePolygonPart('SK_Chr_Head_No_Elements_Male_04.fbx')!;
  const crest = parsePolygonPart('SK_Chr_HelmetAttachment_01.fbx')!;
  const hair = parsePolygonPart('SK_Chr_Hair_01.fbx')!;
  const hood = parsePolygonPart('SK_Chr_HeadCoverings_No_Hair_01.fbx')!;
  const bareHead = parsePolygonPart('SK_Chr_Head_Male_04.fbx')!;

  it('hides hair, the beard, the brows, the ears and the head itself', () => {
    const hidden = concealedSlots([helm]);
    for (const slot of ['head', 'headCovering', 'hair', 'facialHair', 'eyebrows', 'ears'] as const) {
      expect(hidden.has(slot), `a helm should cover ${slot}`).toBe(true);
    }
    // Not everything, though — a shoulder is still visible under a helm.
    expect(hidden.has('shoulderL')).toBe(false);
  });

  it('objects to hair worn under it', () => {
    expect(partProblems([helm, hair]).join(' ')).toMatch(/hair is hidden/i);
  });

  it('objects to a bare head worn under it', () => {
    // The helmed mesh IS the head. Both would put a face inside a helmet and
    // let it poke through the visor.
    expect(partProblems([helm, bareHead]).join(' ')).toMatch(/head is hidden/i);
  });

  it('objects to a crest with no helm to sit on', () => {
    expect(partProblems([bareHead, crest]).join(' ')).toMatch(/helmetCrest needs a helmet/i);
    expect(partProblems([helm, crest])).toHaveLength(0);
  });

  it('lets a hood that is cut around hair keep it', () => {
    const openHood = parsePolygonPart('SK_Chr_HeadCoverings_Base_Hair_01.fbx')!;
    expect(partProblems([bareHead, openHood, hair])).toHaveLength(0);
    expect(partProblems([bareHead, hood, hair]).join(' ')).toMatch(/hair is hidden/i);
  });

  it('objects to a hood worn over it', () => {
    // A hood is cut to sit on a skull, not over a great helm; they intersect
    // rather than stack.
    expect(partProblems([helm, hood]).join(' ')).toMatch(/headCovering is hidden/i);
  });

  it('says nothing about a plain character', () => {
    expect(partProblems([bareHead, hair])).toHaveLength(0);
  });
});

describe('which body a part is cut for (D-558)', () => {
  const maleTorso = parsePolygonPart('SK_Chr_Torso_Male_04.fbx')!;
  const femaleTorso = parsePolygonPart('SK_Chr_Torso_Female_04.fbx')!;
  const cape = parsePolygonPart('SK_Chr_BackAttachment_03.fbx')!;

  it('reads the body off the filename, and unisex where there is none', () => {
    expect(maleTorso.sex).toBe('male');
    expect(femaleTorso.sex).toBe('female');
    expect(cape.sex).toBe('any');
  });

  it('objects to a part cut for the other body', () => {
    // The two cuts do not meet: a female forearm on a male upper arm leaves
    // a seam at the elbow that is visible from three metres away.
    expect(partProblems([femaleTorso], 'male').join(' ')).toMatch(/female part on a male/i);
    expect(partProblems([maleTorso], 'female').join(' ')).toMatch(/male part on a female/i);
  });

  it('lets a part the pack cuts once belong to both', () => {
    expect(partProblems([cape], 'male')).toHaveLength(0);
    expect(partProblems([cape], 'female')).toHaveLength(0);
  });

  it('says nothing about the body when it is not asked', () => {
    // The studio filters its lists, so it has no use for the check; the
    // saved document and CI do.
    expect(partProblems([femaleTorso])).toHaveLength(0);
  });
});

describe('a complete character (D-558)', () => {
  const def = (parts: Partial<Record<string, string>>): CharacterDef =>
    CharacterDefSchema.parse({
      id: 'test',
      name: 'Test',
      pack: 'modular-fantasy-hero',
      sex: 'male',
      parts,
    });

  const wholeBody = Object.fromEntries(BODY_SLOTS.map((s) => [s, `part-${s}`]));

  it('wants every body slot', () => {
    expect(missingBodySlots(def(wholeBody))).toHaveLength(0);
    const { torso: _torso, ...noTorso } = wholeBody;
    expect(missingBodySlots(def(noTorso))).toEqual(['torso']);
  });

  it('accepts a helmed head in place of a head', () => {
    // Otherwise a character in a great helm is reported as headless and the
    // studio refuses to save something perfectly buildable.
    const { head: _head, ...headless } = wholeBody;
    expect(missingBodySlots(def(headless))).toEqual(['head']);
    expect(missingBodySlots(def({ ...headless, helmet: 'SK_Chr_Head_No_Elements_Male_04' })))
      .toHaveLength(0);
  });

  it('keeps the alternative and the requirement pointing at real slots', () => {
    for (const [slot, instead] of Object.entries(SLOT_ALTERNATIVES)) {
      expect(BODY_SLOTS).toContain(slot);
      expect(CHARACTER_SLOTS).toContain(instead);
    }
    for (const [slot, needs] of Object.entries(SLOT_REQUIRES)) {
      expect(ATTACHMENT_SLOTS).toContain(slot);
      expect(CHARACTER_SLOTS).toContain(needs);
    }
  });
});
