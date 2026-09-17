import { describe, expect, it } from 'vitest';
import {
  creationRaceProblems,
  raceHeightRange,
  racesForClass,
  lookProblems,
  partsForSlot,
  partsForSex,
  cutOfFace,
  partLabel,
  curatedPartNames,
  facesByCut,
  type RaceDef,
} from '../src';

/**
 * Choosing a race at creation (D-572).
 *
 * ⚠ These are the rules the SERVER enforces, and the reason they are pure is
 * the reason every rule in this codebase is: the client's version of them is
 * convenience, and a hand-rolled client sends whatever it likes (D-102).
 */

const elven: RaceDef = {
  id: 'elven',
  name: 'Elven',
  description: 'x',
  pack: 'modular-fantasy-hero',
  sexes: ['male', 'female'],
  height: { male: [1.7, 1.85], female: [1.6, 1.75] },
  skinTones: [],
  markings: [],
  parts: {},
  tags: [],
};

describe('a race must resolve (D-572)', () => {
  it('accepts a character with NO race, which is most of them', () => {
    // ⚠ The property the whole design rests on. Every character made before
    // races existed, every bot and every older client sends none — and a
    // class that names no races admits all of them (D-566). Authoring a race
    // narrows; it never silently locks somebody out of their own character.
    expect(creationRaceProblems(undefined, { race: undefined, classRaces: [] })).toEqual([]);
    expect(creationRaceProblems(undefined, { race: undefined, classRaces: ['elven'] })).toEqual([]);
  });

  it('refuses a race content does not have', () => {
    // Writing an id nothing can look up makes a character whose race is a
    // string and not a thing — which survives into the renderer and the
    // descriptor pipeline before anybody notices.
    expect(creationRaceProblems('dwarven', { race: undefined, classRaces: [] })).toEqual([
      "no such race 'dwarven'",
    ]);
  });

  it('reports ONE problem for an unknown race, not three', () => {
    // Nothing below the lookup can be checked against a race that does not
    // exist, and guessing would bury the real error under two invented ones.
    expect(
      creationRaceProblems('dwarven', {
        race: undefined,
        classRaces: ['elven'],
        height: 99,
      }),
    ).toHaveLength(1);
  });
});

describe('a calling may not admit every race (D-566 → D-572)', () => {
  it('refuses a race the calling does not admit, and names the calling', () => {
    const problems = creationRaceProblems('elven', {
      race: elven,
      classRaces: ['human'],
      className: 'Berserker',
    });
    expect(problems).toEqual(['a Berserker may not be elven']);
  });

  it('admits everything when the calling names nothing', () => {
    // ⚠ EMPTY MEANS UNRESTRICTED, the same rule as armour, weapons and items
    // (D-566). The nine callings authored before races existed carry no list
    // and must stay exactly as permissive as they were.
    expect(creationRaceProblems('elven', { race: elven, classRaces: [] })).toEqual([]);
  });

  it('admits a race that IS on the list', () => {
    expect(
      creationRaceProblems('elven', { race: elven, classRaces: ['elven', 'human'] }),
    ).toEqual([]);
  });
});

describe('a race bounds how tall you may be (D-572)', () => {
  it('takes the UNION of its bodies, because a character has no body sex', () => {
    // ⚠ `sex` in this codebase selects which MESHES fit together (D-558) and
    // is a property of an assembled outfit — nobody has ever asked a player
    // for one. Until creation does, the honest bound is "a height this race
    // can be at all"; narrowing per body would enforce a fact nobody stated.
    expect(raceHeightRange(elven)).toEqual([1.6, 1.85]);
  });

  it('refuses a height outside that range, and says what the range is', () => {
    const problems = creationRaceProblems('elven', { race: elven, classRaces: [], height: 2.05 });
    expect(problems).toEqual(['Elven stands between 1.6m and 1.85m, not 2.05m']);
  });

  it('accepts the ends of the range', () => {
    for (const height of [1.6, 1.85]) {
      expect(creationRaceProblems('elven', { race: elven, classRaces: [], height })).toEqual([]);
    }
  });

  it('bounds NOTHING for a race that declares no heights', () => {
    // Empty means unrestricted here too — such a character is still held to
    // `APPEARANCE_LIMITS`, which is the bound that stops a rig breaking.
    const vague: RaceDef = { ...elven, height: {} };
    expect(raceHeightRange(vague)).toBeNull();
    expect(creationRaceProblems('elven', { race: vague, classRaces: [], height: 2.05 })).toEqual([]);
  });

  it('says nothing about height when the client sent no appearance', () => {
    // Most clients do not — a bot never has — and the seed's own height is
    // generated from an archetype rather than submitted.
    expect(creationRaceProblems('elven', { race: elven, classRaces: [] })).toEqual([]);
  });
});

describe('what the creation screen may offer (D-573)', () => {
  const human: RaceDef = { ...elven, id: 'human', name: 'Human' };
  const all = [elven, human];

  it('offers EVERY race when the calling names none', () => {
    // ⚠ The rule all nine callings rely on today. Inverting this offers
    // nobody anything, and the only symptom is an empty step.
    expect(racesForClass(all, []).map((r) => r.id)).toEqual(['elven', 'human']);
  });

  it('offers only what the calling names', () => {
    expect(racesForClass(all, ['human']).map((r) => r.id)).toEqual(['human']);
  });

  it('offers NOTHING when the calling names races that are not authored', () => {
    // ⚠ Reachable, and a content error rather than a bug: a calling can name
    // a race somebody has since deleted. The screen has to say so and send
    // the player back, not present an empty grid.
    expect(racesForClass(all, ['dwarven'])).toEqual([]);
  });

  it('hands back a copy, so a caller cannot mutate the catalogue', () => {
    const result = racesForClass(all, []);
    result.pop();
    expect(all).toHaveLength(2);
  });
});

describe('the face a player chose (D-574)', () => {
  const curated: RaceDef = {
    ...elven,
    parts: {
      head: ['Head_A', 'Head_B'],
      hair: ['Hair_1'],
    },
    skinTones: [
      { id: 'ivory', name: 'Ivory', rgb: '#ffccae' },
      { id: 'pale', name: 'Pale', rgb: '#edaf97' },
    ],
    markings: [{ id: 'woad', name: 'Woad', rgb: '#4566a9' }],
  };

  it('accepts parts the race offers', () => {
    expect(
      lookProblems({ parts: { head: 'Head_B', hair: 'Hair_1' }, skin: '#ffccae' }, curated),
    ).toEqual([]);
  });

  it('refuses a part the race does not offer, per SLOT', () => {
    // ⚠ Per slot, not merely "in the pack". A race that offers the same faces
    // as every other race is not a race (D-560), and a player who can send any
    // stem has made the curation decorative.
    expect(lookProblems({ parts: { head: 'Head_Z' } }, curated)).toEqual([
      "Elven does not offer 'Head_Z' for head",
    ]);
    // Offered for `head`, but not for `hair`.
    expect(lookProblems({ parts: { hair: 'Head_A' } }, curated)).toEqual([
      "Elven does not offer 'Head_A' for hair",
    ]);
  });

  it('refuses a skin the race does not have', () => {
    expect(lookProblems({ parts: {}, skin: '#000000' }, curated)).toEqual([
      'Elven does not have that skin',
    ]);
    // Case is not a difference — a colour is a colour.
    expect(lookProblems({ parts: {}, skin: '#FFCCAE' }, curated)).toEqual([]);
  });

  it('separates "wrong markings" from "no markings at all"', () => {
    // ⚠ Two different mistakes. "Pick a different one" reads as advice when
    // there is none to pick, so a race with an empty list says so instead.
    expect(lookProblems({ parts: {}, markings: '#123456' }, curated)).toEqual([
      'Elven does not wear those markings',
    ]);
    const plain: RaceDef = { ...curated, markings: [] };
    expect(lookProblems({ parts: {}, markings: '#4566a9' }, plain)).toEqual([
      'Elven wears no markings',
    ]);
  });

  it('refuses a look with NO race to have chosen it from', () => {
    // ⚠ Not a smaller version of a valid look: there is nothing to check it
    // against, so accepting it would let a raceless character carry any part
    // in the pack.
    expect(lookProblems({ parts: { head: 'Head_A' } }, undefined)).toEqual([
      'a chosen face needs a race to have chosen it from',
    ]);
    // An EMPTY look with no race is fine — that is every character today.
    expect(lookProblems({ parts: {} }, undefined)).toEqual([]);
  });

  it('checks nothing the race curates nothing for', () => {
    // Empty means unrestricted, here as everywhere: a race that lists no
    // tones has not said anything about skin, so it refuses nothing.
    const vague: RaceDef = { ...curated, skinTones: [] };
    expect(lookProblems({ parts: {}, skin: '#010203' }, vague)).toEqual([]);
  });
});

describe('what a face step may offer (D-574)', () => {
  const HEADS = ['SK_Chr_Head_Male_00', 'SK_Chr_Head_Female_00'];
  const BROWS = ['SK_Chr_Eyebrow_Male_01', 'SK_Chr_Eyebrow_Female_01'];
  const HAIR = ['SK_Chr_Hair_01', 'SK_Chr_Hair_02'];

  it('NEVER filters the head by the cut the head decides', () => {
    // ⚠ The bug this exists to stop. Filtering the head by the chosen head's
    // own cut is a one-way door: all 46 faces show until you pick one, and
    // from then on the other 23 are gone and cannot be reached again. Nothing
    // errors — the options simply stop being drawn — so the only symptom is
    // "a player cannot make a woman".
    expect(partsForSlot(HEADS, 'head', 'SK_Chr_Head_Male_00')).toEqual(HEADS);
    expect(partsForSlot(HEADS, 'head', 'SK_Chr_Head_Female_00')).toEqual(HEADS);
  });

  it('offers everything while no face is chosen', () => {
    expect(partsForSlot(BROWS, 'eyebrows', undefined)).toEqual(BROWS);
  });

  it('matches every OTHER slot to the chosen face', () => {
    // A female brow on a male head meets it at the wrong diameter and the
    // seam is visible from three metres (D-558).
    expect(partsForSlot(BROWS, 'eyebrows', 'SK_Chr_Head_Male_00')).toEqual([
      'SK_Chr_Eyebrow_Male_01',
    ]);
    expect(partsForSlot(BROWS, 'eyebrows', 'SK_Chr_Head_Female_00')).toEqual([
      'SK_Chr_Eyebrow_Female_01',
    ]);
  });

  it('keeps parts the pack cuts ONCE for both', () => {
    // Hair and ears carry no body word and belong to everybody.
    expect(partsForSlot(HAIR, 'hair', 'SK_Chr_Head_Female_00')).toEqual(HAIR);
  });

  it('filters EVERY slot by an explicit body, head included', () => {
    // ⚠ The opposite rule to the one above, and it is not a contradiction.
    // `partsForSlot` must never filter the head because the head is what it
    // reads the cut FROM — a one-way door with no way back. An explicit body
    // selector (D-601) IS the way back, so it may filter everything.
    expect(partsForSex(HEADS, 'male')).toEqual(['SK_Chr_Head_Male_00']);
    expect(partsForSex(HEADS, 'female')).toEqual(['SK_Chr_Head_Female_00']);
    expect(partsForSex(BROWS, 'female')).toEqual(['SK_Chr_Eyebrow_Female_01']);
  });

  it('keeps unisex parts whichever body is selected', () => {
    // Hair, capes and crests carry no body word. Dropping them would empty
    // three rows that have nothing to do with which body is chosen.
    expect(partsForSex(HAIR, 'male')).toEqual(HAIR);
    expect(partsForSex(HAIR, 'female')).toEqual(HAIR);
  });

  it('is REVERSIBLE, which is the whole reason it may filter the head', () => {
    const male = partsForSex(HEADS, 'male');
    const back = partsForSex(HEADS, 'female');
    expect(male).not.toEqual(back);
    // Selecting male then female reaches the female faces again — the exact
    // thing D-575's implicit filter made impossible.
    expect(partsForSex(HEADS, 'female')).toEqual(back);
    expect(partsForSex(HEADS, 'male')).toEqual(male);
  });

  it('reads the cut off the face, and has no opinion without one', () => {
    expect(cutOfFace('SK_Chr_Head_Female_12')).toBe('female');
    expect(cutOfFace('SK_Chr_Head_Male_12')).toBe('male');
    expect(cutOfFace(undefined)).toBeNull();
    // A head the pack cuts once would be neither, and must not be guessed at.
    expect(cutOfFace('SK_Chr_Head_No_Elements_04')).toBeNull();
  });
});

describe('a player is never shown a filename (D-560 → D-576)', () => {
  const NAMES = { SK_Chr_Head_Male_03: 'Scarred mouth' };

  it('shows the name the stakeholder wrote', () => {
    expect(partLabel('SK_Chr_Head_Male_03', NAMES)).toBe('Scarred mouth');
  });

  it('falls back to the stem, KEEPING the body word', () => {
    // ⚠ D-575: a fallback exists to be legible until somebody names the part.
    // Stripping the cut made six faces read "Head 00"…"Head 08" and put
    // "Eyebrow 01" in both lists meaning two different meshes.
    expect(partLabel('SK_Chr_Head_Female_05', {})).toBe('Head Female 05');
  });

  it('carries every name the races curate, and nothing else', () => {
    // ⚠ The property that matters: a curated part with no name is a part
    // nobody has named, never a name that failed to arrive. The pack names
    // 720 and the races offer 142 — shipping the other 578 garment meshes to
    // a screen that cannot show them is six times the payload for nothing.
    const race: RaceDef = {
      ...elven,
      parts: { head: ['Head_A', 'Head_Unnamed'], hair: ['Hair_1'] },
    };
    const names = new Map([
      ['Head_A', 'Scarred mouth'],
      ['Hair_1', 'Cropped'],
      ['Torso_Never_Offered', 'Brigandine'],
    ]);
    expect(curatedPartNames([race], names)).toEqual({
      Head_A: 'Scarred mouth',
      Hair_1: 'Cropped',
    });
  });
});

describe('faces are grouped by the cut they decide (D-576)', () => {
  it('splits the two cuts, because naming them CREATED a collision', () => {
    // ⚠ 20 of 23 head names are shared across the cuts — "Burnt" is a male
    // face AND a female face — and D-575 requires all 46 on screen at once.
    // Labelling by name alone therefore gives twenty pairs of chips reading
    // the same thing, which is a worse screen than the file stems were.
    const heads = [
      'SK_Chr_Head_Male_07',
      'SK_Chr_Head_Female_07',
      'SK_Chr_Head_Male_08',
    ];
    expect(facesByCut(heads)).toEqual({
      male: ['SK_Chr_Head_Male_07', 'SK_Chr_Head_Male_08'],
      female: ['SK_Chr_Head_Female_07'],
      common: [],
    });
  });

  it('puts a head the pack cuts ONCE in neither group', () => {
    // A helmet, or a race whose body is a garment (D-563). Guessing a cut for
    // it would file it under a heading that is not true.
    expect(facesByCut(['SK_Chr_Head_No_Elements_04'])).toEqual({
      male: [],
      female: [],
      common: ['SK_Chr_Head_No_Elements_04'],
    });
  });

  it('loses nothing — every offered face lands in exactly one group', () => {
    const heads = ['SK_Chr_Head_Male_00', 'SK_Chr_Head_Female_00', 'SK_Chr_Head_No_Elements_01'];
    const { male, female, common } = facesByCut(heads);
    expect([...male, ...female, ...common].sort()).toEqual([...heads].sort());
  });
});
