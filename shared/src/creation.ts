import { z } from 'zod';
import { CHARACTER_SEXES, CharacterSlotSchema, type CharacterSlot } from './characters';

/**
 * What a player may BE, as content (D-560).
 *
 * The character studio (D-558) answers "which parts make this character".
 * This answers the different question the creation screen asks: "which parts
 * may a player CHOOSE, and what are they called when a player sees them".
 * Those are not the same list and must not be the same file — a guard is
 * assembled by a designer from anything in the pack, while a player picks a
 * face from a curated few.
 */

/* ------------------------------------------------------------------ names */

/**
 * What a part is called in the game.
 *
 * `SK_Chr_Head_Male_04` is the right name for a file and the wrong name for
 * a person. Nothing downstream — the creation screen, a character sheet, a
 * description — can show a filename, so the mapping has to exist before any
 * of them can be built.
 *
 * Only the DECISION is stored. Which slot a part fills, which body it is cut
 * for and whether it is bare skin are all derived from the file by
 * `parsePolygonPart` and measured from its UVs; writing them here as well
 * would create two sources that can disagree, and the file would win.
 */
export const PartNamesSchema = z.object({
  /** The ingested pack these names belong to (a folder in `assets/source/`). */
  pack: z.string().min(1),
  /** Part file stem → the name a player sees. */
  names: z.record(z.string().min(1), z.string().min(1)).default({}),
  /**
   * Free keywords per part, for anything that wants to select on them later
   * — "scarred", "young", "highland". Deliberately open: a closed enum here
   * would mean a code change every time somebody names a new quality.
   */
  tags: z.record(z.string().min(1), z.array(z.string().min(1))).default({}),
});
export type PartNames = z.infer<typeof PartNamesSchema>;

/* ------------------------------------------------------------------ races */

/**
 * A skin tone a player may pick.
 *
 * A COLOUR, not a texture name. The pack ships three tones as three atlases,
 * but skin in this art is only four flat colours out of a 1024² atlas, so any
 * colour is reachable by substituting them (`shared/src/skin.ts`). Three tones
 * was a property of how many files somebody exported, and it should not have
 * become a property of the game.
 */
export const SkinToneSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().min(1),
  /** `#rrggbb`. The base skin colour; the shading follows from it. */
  rgb: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'a colour like #c98f6a'),
});
export type SkinTone = z.infer<typeof SkinToneSchema>;

/** Inclusive range, low first. Used for height. */
const RangeSchema = z
  .tuple([z.number().positive(), z.number().positive()])
  .refine(([lo, hi]) => lo <= hi, { message: 'range must be low, high' });

/**
 * A race a player may be.
 *
 * ⚠ What varies between races is narrower than it looks, and the art is the
 * reason. This pack's body and clothing are the SAME mesh: of 720 parts,
 * exactly one arm, one hand and one leg per body are bare skin, and no torso
 * or hips are. So a race is expressed through the FACE — head, ears, hair,
 * brows — plus skin tone and stature. Anything that needs a different BODY
 * needs different art, not a different definition here.
 */
export const RaceSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().min(1),
  description: z.string().min(1),
  /** The pack its parts come from. */
  pack: z.string().min(1),
  /** Which bodies exist for this race. A race may legitimately have one. */
  sexes: z.array(z.enum(CHARACTER_SEXES)).min(1),
  /**
   * Metres, per body. The server bounds what a client may submit (D-102),
   * and descriptors like "towering" are computed from it (D-201), so this is
   * the range in which a race's statures are actually true.
   */
  height: z.record(z.enum(CHARACTER_SEXES), RangeSchema).default({}),
  skinTones: z.array(SkinToneSchema).default([]),
  /**
   * Face markings a player may choose. Twenty-eight of this pack's heads
   * carry war paint, on a colour channel no other part touches, so it
   * recolours independently of skin — and on some heads it is the only thing
   * that distinguishes them.
   */
  markings: z.array(SkinToneSchema).default([]),
  /**
   * Slot → the part stems a player may choose from.
   *
   * Curated, not "everything in the pack". A creation screen offering 46
   * heads is not a choice, it is a catalogue; and a race means nothing if
   * every race offers the same faces. Parts cut for the other body are
   * filtered out at creation from the file name, so one list serves both.
   */
  parts: z.record(CharacterSlotSchema, z.array(z.string().min(1))).default({}),
  /** Keywords other content selects on — see `CreationTagsSchema`. */
  tags: z.array(z.string().min(1)).default([]),
});
export type RaceDef = z.infer<typeof RaceSchema>;

/**
 * Slots a player picks from at creation.
 *
 * The FACE and nothing below the neck, because nothing below the neck is
 * separable from clothing in this art. Ordered as the screen should ask.
 */
export const CREATION_SLOTS = ['head', 'ears', 'hair', 'eyebrows', 'facialHair'] as const;
export type CreationSlot = (typeof CREATION_SLOTS)[number];

/**
 * Everything wrong with a race, in one list.
 *
 * Pure, so the tool's live warnings and the CI validator are the same rule
 * rather than two that drift apart — the mistake D-558 was careful to avoid
 * between the studio and the build.
 */
export function raceProblems(
  race: RaceDef,
  known: { partsInPack: ReadonlySet<string> } | null,
): string[] {
  const problems: string[] = [];

  for (const slot of CREATION_SLOTS) {
    const offered = race.parts[slot] ?? [];
    // `head` is the one slot with nothing to fall back on: a character with
    // no head is not a character. The rest may legitimately be empty — a
    // race with no facial hair is a statement, not an omission.
    if (slot === 'head' && offered.length === 0) {
      problems.push(`${race.id}: offers no heads, so nobody can be one`);
    }
  }
  if (race.skinTones.length === 0) {
    problems.push(`${race.id}: offers no skin tones`);
  }
  for (const sex of race.sexes) {
    if (!race.height[sex]) problems.push(`${race.id}: no height range for ${sex}`);
  }
  const ids = race.skinTones.map((t) => t.id);
  if (new Set(ids).size !== ids.length) problems.push(`${race.id}: duplicate skin tone id`);

  // Only checkable where the art is present. `assets/source/` is gitignored,
  // so in CI this half simply does not run.
  if (known) {
    for (const [slot, stems] of Object.entries(race.parts)) {
      for (const stem of stems ?? []) {
        if (!known.partsInPack.has(stem)) {
          problems.push(`${race.id}: ${slot} offers "${stem}", which ${race.pack} does not ship`);
        }
      }
    }

  }
  return problems;
}

/* ------------------------------------------------- choosing a race ------ */

/**
 * Everything wrong with the race a character is being created with (D-572).
 *
 * ⚠ Until this existed a character had NO RACE AT ALL. `content/races/` was
 * authored and curated in the creation tool, `ClassSchema` carried a `races`
 * list, and nothing in the game had a field to put one in — so the gate could
 * not fire and the authored height ranges and skin tones bounded nothing. This
 * is the join between "races are content" and "the game reads them".
 *
 * ⚠ A race is OPTIONAL, exactly as a class is. Every character made before
 * this, every bot and every pre-race client carries none, and none of them
 * changes behaviour — which is the same property D-566 rests on: narrowing is
 * a deliberate edit and nothing is silently locked by adding a field.
 */
export function creationRaceProblems(
  raceId: string | undefined,
  ctx: {
    /** The resolved race, or undefined when content has no such id. */
    race: RaceDef | undefined;
    /** Which races the chosen calling admits. Empty means ALL (D-566). */
    classRaces: readonly string[];
    /** For the message, so a refusal names the calling rather than an id. */
    className?: string;
    /** The appearance the client submitted, if it sent one. */
    height?: number;
  },
): string[] {
  if (raceId === undefined) return [];
  const problems: string[] = [];
  if (!ctx.race) {
    problems.push(`no such race '${raceId}'`);
    // Nothing below can be checked against a race that does not exist, and
    // guessing would turn one error into three.
    return problems;
  }
  if (ctx.classRaces.length > 0 && !ctx.classRaces.includes(raceId)) {
    problems.push(
      `a ${ctx.className ?? 'character'} may not be ${ctx.race.name.toLowerCase()}`,
    );
  }
  if (ctx.height !== undefined) {
    const range = raceHeightRange(ctx.race);
    if (range && (ctx.height < range[0] || ctx.height > range[1])) {
      problems.push(
        `${ctx.race.name} stands between ${range[0]}m and ${range[1]}m, not ${ctx.height}m`,
      );
    }
  }
  return problems;
}

/**
 * The heights this race can be, across every body it has.
 *
 * ⚠ The UNION of its per-body ranges, not the one that matches the character
 * — because a character does not have a body sex to match against. `sex` in
 * this codebase selects which MESHES fit together (D-558) and is a property of
 * an assembled outfit, not something a player has ever been asked. Until
 * creation asks, the honest bound is "a height this race can be at all";
 * narrowing it per body would be enforcing a fact nobody has stated.
 *
 * Returns null for a race that declares no heights, which then bounds nothing
 * beyond `APPEARANCE_LIMITS` — empty means unrestricted, here as everywhere.
 */
export function raceHeightRange(race: RaceDef): [number, number] | null {
  const ranges = Object.values(race.height).filter((r): r is [number, number] => Array.isArray(r));
  if (ranges.length === 0) return null;
  return [
    Math.min(...ranges.map((r) => r[0])),
    Math.max(...ranges.map((r) => r[1])),
  ];
}

/**
 * The races a calling admits, out of everything content offers (D-572).
 *
 * ⚠ Extracted from the creation screen rather than left there, because the
 * repo's testing doctrine forbids logic that can only be exercised through a
 * browser — and this is the rule that decides what a player is allowed to be.
 * Getting it backwards offers exactly the races a calling refuses, and the
 * only symptom is a refusal at the LAST step, after the character is named.
 *
 * ⚠ Empty `classRaces` means ALL, the same rule as armour, weapons and items
 * (D-566). All nine callings declare none today, so inverting this would
 * offer nobody anything.
 */
export function racesForClass(
  races: readonly RaceDef[],
  classRaces: readonly string[],
): RaceDef[] {
  if (classRaces.length === 0) return [...races];
  return races.filter((r) => classRaces.includes(r.id));
}

/* ------------------------------------------- the face a player chose ---- */

/**
 * The parts and colours a player picked at creation (D-560, built as D-574).
 *
 * ⚠ SEPARATE from `AppearanceOverride`, deliberately. That is the procedural
 * parameter set — build, stature, palette — and it is what the descriptor
 * pipeline reads to call a stranger "a towering, heavy-built figure"
 * (D-201/D-539). Those numbers have to survive whatever art renders them, so a
 * look is an ADDITIONAL layer rather than a replacement: a character with no
 * look renders exactly as it did before, which is every character that exists.
 *
 * ⚠ Curated, not free. Every part must be one the RACE offers for that slot —
 * "a race that offers the same faces as every other race is not a race"
 * (D-560), and a player who can send any stem in the pack has made the
 * curation decorative.
 */
export const CharacterLookSchema = z.object({
  /** Slot → the part stem chosen for it. */
  parts: z.record(CharacterSlotSchema, z.string().min(1)).default({}),
  /**
   * Skin, as an RGB rather than one of three files.
   *
   * ⚠ D-560 measured why: skin is FOUR flat colours in the whole atlas, which
   * the vendor's `_A/_B/_C` variants merely remap, so a tone is a colour a
   * person picks and the recolour is four exact substitutions. Storing the
   * colour rather than a tone id also means a race can rename or reorder its
   * tones without silently changing somebody's face.
   */
  skin: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  /**
   * Face markings, on their own colour channel.
   *
   * ⚠ 28 of this pack's 46 heads carry war paint on a colour no other part
   * touches (D-560), so markings recolour without disturbing skin — and on
   * some heads they are the only thing that distinguishes one from another.
   */
  markings: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});
export type CharacterLook = z.infer<typeof CharacterLookSchema>;

/**
 * Everything wrong with a chosen look, given the race it was chosen under.
 *
 * Pure, so the creation screen and the server agree — and the server is the
 * one that decides (D-102). A hand-rolled client sends whatever it likes.
 */
export function lookProblems(
  look: CharacterLook,
  race: RaceDef | undefined,
): string[] {
  const problems: string[] = [];
  if (!race) {
    // ⚠ A look without a race is not a smaller version of a valid look — there
    // is nothing to check it against, and accepting it would let a raceless
    // character carry any part in the pack. `creationRaceProblems` has already
    // refused an unknown race; this refuses a look that names none.
    if (Object.keys(look.parts).length > 0 || look.skin !== undefined) {
      problems.push('a chosen face needs a race to have chosen it from');
    }
    return problems;
  }
  for (const [slot, stem] of Object.entries(look.parts)) {
    const offered: readonly string[] = race.parts[slot as CharacterSlot] ?? [];
    if (!offered.includes(stem)) {
      problems.push(`${race.name} does not offer '${stem}' for ${slot}`);
    }
  }
  if (look.skin !== undefined && race.skinTones.length > 0) {
    const tones = race.skinTones.map((t) => t.rgb.toLowerCase());
    if (!tones.includes(look.skin.toLowerCase())) {
      problems.push(`${race.name} does not have that skin`);
    }
  }
  if (look.markings !== undefined && race.markings.length > 0) {
    const marks = race.markings.map((m) => m.rgb.toLowerCase());
    if (!marks.includes(look.markings.toLowerCase())) {
      problems.push(`${race.name} does not wear those markings`);
    }
  }
  // ⚠ Markings with no markings to choose from is not a near miss, it is a
  // client inventing a field. Said separately because the message above would
  // read as "pick a different one" when there is none to pick.
  if (look.markings !== undefined && race.markings.length === 0) {
    problems.push(`${race.name} wears no markings`);
  }
  return problems;
}

/**
 * Which cut a chosen face is, or null if none is chosen yet.
 *
 * ⚠ Read from the part's own filename rather than stored. `sex` selects which
 * MESHES fit together (D-558) and the chosen head already contains the answer;
 * a second copy of it is a second thing that can disagree.
 */
export function cutOfFace(head: string | undefined): 'male' | 'female' | null {
  if (!head) return null;
  if (/_Female_/i.test(head)) return 'female';
  if (/_Male_/i.test(head)) return 'male';
  return null;
}

/**
 * The parts a creation screen may offer for one slot (D-574).
 *
 * ⚠ THE HEAD IS NOT FILTERED, and that is the whole reason this is a function
 * with a test rather than a condition inside a render loop. The head is the
 * slot that DECIDES the cut, so filtering it by the cut it decides is a
 * one-way door: every face shows until you pick one, and from then on half of
 * them are gone and cannot be reached again. The symptom is "a player cannot
 * make a woman" and the cause is invisible — the options do not error, they
 * simply stop being drawn.
 *
 * Everything else IS filtered, because a female brow on a male head meets it
 * at the wrong diameter and the seam is visible from three metres (D-558).
 * Parts the pack cuts once — hair, ears — carry no body word and belong to
 * both.
 */
export function partsForSlot(
  offered: readonly string[],
  slot: CharacterSlot,
  chosenHead: string | undefined,
): string[] {
  if (slot === 'head') return [...offered];
  const cut = cutOfFace(chosenHead);
  if (!cut) return [...offered];
  return offered.filter((stem) => {
    if (!/_(Male|Female)_/i.test(stem)) return true;
    return new RegExp(`_${cut}_`, 'i').test(stem);
  });
}

/**
 * What a player is told a part is called (D-560, delivered to the game in D-576).
 *
 * ⚠ The names have existed in `content/parts/` since D-560 and reached no
 * player: that file is read by the authoring tools and by CI, and the game
 * server never loaded it. The creation screen therefore derived a label from
 * the FILE STEM and showed "Head Female 05" where the stakeholder had written
 * "Scarred mouth". Nothing was lost and nothing errored — the names were
 * simply never asked for.
 *
 * The fallback is the stem, KEEPING the body word, for the reason recorded in
 * D-575: a fallback exists to be legible until somebody names the part, and
 * one that hides the only distinction on screen is worse than the filename.
 */
export function partLabel(stem: string, names: Readonly<Record<string, string>>): string {
  return names[stem] ?? stem.replace(/^SK_Chr_/, '').replace(/_/g, ' ');
}

/**
 * The names the creation screen can actually use.
 *
 * ⚠ Trimmed to what the races CURATE rather than sent whole. The pack names
 * 720 parts and the races between them offer 142; the other 578 are garment
 * meshes that creation never shows, and a catalogue is not the place to ship
 * six times what any screen can display. Everything creation offers is
 * covered, which is the property that matters and the one the test asserts.
 */
export function curatedPartNames(
  races: readonly RaceDef[],
  names: ReadonlyMap<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const race of races) {
    for (const stems of Object.values(race.parts)) {
      for (const stem of stems ?? []) {
        const name = names.get(stem);
        if (name !== undefined) out[stem] = name;
      }
    }
  }
  return out;
}

/**
 * The faces a race offers, split by the cut each one is.
 *
 * ⚠ This exists because naming the parts CREATED a collision that the file
 * stems had hidden. 20 of the 23 head names are shared across the two cuts —
 * "Burnt", "Cut eye", "Markings 10" are each a male head and a female head —
 * and D-575 requires all 46 to be visible at once, so labelling them by name
 * alone puts twenty pairs of identical chips in one row.
 *
 * ⚠ Grouping is the honest answer rather than suffixing the name with its
 * cut. The head is the slot that DECIDES the cut — every other slot is
 * filtered by it (D-558) and the body is filled from it (D-574) — so a player
 * choosing a face is choosing that, and showing it as a heading says so
 * plainly. It is not a question about the player.
 *
 * A head the pack cuts once belongs to neither group and is returned in
 * `common`, which is where a race whose body IS a garment (D-563) lands.
 */
export function facesByCut(offered: readonly string[]): {
  male: string[];
  female: string[];
  common: string[];
} {
  const out = { male: [] as string[], female: [] as string[], common: [] as string[] };
  for (const stem of offered) {
    const cut = cutOfFace(stem);
    if (cut === 'male') out.male.push(stem);
    else if (cut === 'female') out.female.push(stem);
    else out.common.push(stem);
  }
  return out;
}
