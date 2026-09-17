import { z } from 'zod';

/**
 * What an assembled character IS, as data (D-110, D-558).
 *
 * Before this, choosing an outfit meant copying FBX files into a folder by
 * hand — which is not reviewable, not diffable, and not something the
 * stakeholder can do. A character is now a small content document naming one
 * part per slot, and the build reads it. The art stays out of git; the
 * decision about which art goes in git.
 */

/**
 * The slots a humanoid is assembled from.
 *
 * Deliberately OURS, not a vendor's. Synty's POLYGON line calls a slot
 * `ArmUpperLeft` and their Sidekick line calls it `11AUPL`; both mean the
 * same joint, and a pack that names things a third way is a parser change
 * here rather than a change everywhere.
 *
 * Split into the parts that MAKE a body and the parts that hang off one,
 * because the first list is what "is this character complete?" means.
 */
/**
 * What a piece of armour is made of (D-566).
 *
 * Three, because three is the decision being served: a class admits plate or
 * it does not. It lives in `shared` rather than in the tool that measures it
 * because the class schema gates on it, CI checks it and the creation screen
 * will filter by it — four readers, one vocabulary.
 *
 * ⚠ A part tagged `base` is BARE SKIN, which is not a material and is
 * deliberately not in this list. Bare is the absence of armour, and folding it
 * in would let a class "admit bare" as though it were a kind of protection.
 */
export const ARMOUR_MATERIALS = ['plate', 'leather', 'cloth'] as const;
export type ArmourMaterial = (typeof ARMOUR_MATERIALS)[number];

export const BODY_SLOTS = [
  'head',
  'torso',
  'hips',
  'armUpperL',
  'armUpperR',
  'armLowerL',
  'armLowerR',
  'handL',
  'handR',
  'legL',
  'legR',
] as const;

/** Slots that dress a body rather than being one. All optional. */
export const ATTACHMENT_SLOTS = [
  'hair',
  'facialHair',
  'eyebrows',
  'ears',
  'headCovering',
  'helmet',
  'helmetCrest',
  'back',
  'shoulderL',
  'shoulderR',
  'elbowL',
  'elbowR',
  'kneeL',
  'kneeR',
  'hipsAttachment',
] as const;

/**
 * Which body a character is built from.
 *
 * Not a roleplaying statement and not shown to players — it selects which
 * MESHES fit together. This pack cuts most parts twice, and a female forearm
 * bound to a male upper arm meets it at the wrong diameter: the seam is
 * visible from three metres away. Parts the pack cuts once (hair, a
 * pauldron, a cape) are unisex and belong to both.
 */
export const CHARACTER_SEXES = ['male', 'female'] as const;
export type CharacterSex = (typeof CHARACTER_SEXES)[number];

export const CHARACTER_SLOTS = [...BODY_SLOTS, ...ATTACHMENT_SLOTS] as const;

export type BodySlot = (typeof BODY_SLOTS)[number];
export type CharacterSlot = (typeof CHARACTER_SLOTS)[number];

export const CharacterSlotSchema = z.enum(CHARACTER_SLOTS);

/**
 * One assembled character.
 *
 * `parts` maps a slot to a part NAME (the file stem, no extension and no
 * path) — the build resolves it against the named pack. Storing a bare name
 * rather than a path means a pack that reorganises its folders does not
 * invalidate every character.
 */
export const CharacterDefSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'lower-case, digits and dashes'),
  /** What a person calls it in the studio. Never shown to players. */
  name: z.string().min(1),
  /** Which ingested pack the parts come from (a folder in `assets/source/`). */
  pack: z.string().min(1),
  /**
   * Which cut of the body. Required rather than defaulted: a character whose
   * sex is implied by whichever parts happen to have been chosen is one
   * mismatched limb away from being neither.
   */
  sex: z.enum(CHARACTER_SEXES),
  /**
   * Slot → part file stem, for a character assembled out of a MODULAR pack.
   *
   * ⚠ Empty when `mesh` is set. A pack ships people in two shapes and both are
   * legitimate: `modular-fantasy-hero` is 720 separate part files, and the
   * dungeon pack's goblins and skeletons are one rigged FBX each. Forcing the
   * second through the first would mean inventing a "whole body" slot and
   * pretending an assembler ran.
   */
  parts: z.record(CharacterSlotSchema, z.string().min(1)).default({}),
  /**
   * One FBX in the pack that IS the whole character (D-594).
   *
   * ⚠ This is how enemies get in. The dungeon pack ships sixteen finished
   * people — goblins, skeletons, ghosts, a rock golem — as single rigged
   * meshes, and measured, they are on the **Unreal humanoid rig**, the same
   * one the Sidekick characters use (D-555). So the 126-clip animation library
   * retargets onto them with no new work: a goblin walks because a knight
   * already does.
   *
   * ⚠ Named from the PACK rather than copied into `assets/incoming/`, which
   * would build identically and require a manual step — the thing D-555 made
   * the whole pipeline to avoid.
   */
  mesh: z.string().min(1).optional(),
  /**
   * Whether this is a PERSON or a CREATURE (D-618).
   *
   * WARNING: it decides what an entity with no chosen face is drawn as. That
   * fallback picks from every built character, and ten of the twelve are
   * monsters -- so a bot, an NPC or anybody who never went through creation
   * was drawn as a goblin, a skeleton or a rock golem depending on a number
   * nobody chose. Reported as "one of the bots shows up as a goblin".
   *
   * WARNING: DECLARED, not inferred. The tempting rule -- "a whole mesh is a
   * creature, an assembly is a person" -- is true of today's twelve and is an
   * accident of which art happened to be modular: `polygon-hero-male` is a
   * whole mesh and is the most person-shaped thing in the pack. Inferring it
   * would put the hero back in the monster lottery the day somebody adds a
   * modular goblin.
   *
   * WARNING: defaults to `creature`, which is the safe direction. A new
   * definition nobody has classified stays OUT of the fallback pool: the cost
   * of a wrong default here is "this NPC is never picked at random", and the
   * cost the other way is the bug being fixed.
   */
  kind: z.enum(['person', 'creature']).default('creature'),
  /** The colour atlas, a file stem in the pack's textures. */
  texture: z.string().min(1).optional(),
  /** Free text for whoever opens this in six months. */
  note: z.string().optional(),
}).superRefine((def, ctx) => {
  // ⚠ One or the other, never both and never neither. A definition with both
  // would have an assembler and a finished body disagreeing about what the
  // character is, and the build would silently pick one.
  const hasParts = Object.keys(def.parts).length > 0;
  if (hasParts === (def.mesh !== undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: def.mesh
        ? 'a character is either assembled from `parts` or IS a `mesh`, not both'
        : 'a character needs either `parts` to assemble or a `mesh` to be',
    });
  }
});

export type CharacterDef = z.infer<typeof CharacterDefSchema>;

/**
 * A body slot something else can satisfy.
 *
 * A helmed head IS the head — the mesh includes the neck and the skull, and
 * carries no `eyes` bone because there is no face to put them in. So a
 * character in a great helm has no separate head part and is not incomplete.
 */
export const SLOT_ALTERNATIVES: Readonly<Partial<Record<BodySlot, CharacterSlot>>> = Object.freeze({
  head: 'helmet',
});

/**
 * A slot that only means anything when another one is filled.
 *
 * A helmet crest is a plume or a pair of horns that mounts on a helm. Worn
 * on a bare head it floats above the hair.
 */
export const SLOT_REQUIRES: Readonly<Partial<Record<CharacterSlot, CharacterSlot>>> = Object.freeze({
  helmetCrest: 'helmet',
});

/**
 * Is this character assemblable?
 *
 * A missing arm is not a schema error — every slot is legitimately optional
 * in isolation — but it IS a broken character, and the studio should say so
 * before it writes rather than the build failing later.
 */
export function missingBodySlots(def: CharacterDef): BodySlot[] {
  // ⚠ A character that IS a mesh has no parts and is not incomplete (D-594).
  // The pack's goblins and skeletons ship as one finished rigged body; asking
  // which file supplies their left forearm is a question about assembly, and
  // nothing assembled them.
  if (def.mesh !== undefined) return [];
  return BODY_SLOTS.filter((s) => {
    if (def.parts[s]) return false;
    const instead = SLOT_ALTERNATIVES[s];
    return !instead || !def.parts[instead];
  });
}

/**
 * Slots that what has already been chosen covers up.
 *
 * Concealment is a property of the PART, not of the slot: this pack ships
 * head coverings in three cuts — `Base_Hair` is modelled around hair,
 * `No_Hair` replaces it, `No_FacialHair` shaves the beard — and they all sit
 * in the same slot. Reading it off the file is what lets one hood show hair
 * and the next one not.
 */
export function concealedSlots(chosen: readonly ParsedPart[]): Set<CharacterSlot> {
  const out = new Set<CharacterSlot>();
  for (const part of chosen) for (const slot of part.conceals) out.add(slot);
  return out;
}

/**
 * Everything wrong with a set of chosen parts, in the order a person would
 * want to hear it. Pure, so the studio's live warnings and the save endpoint's
 * refusal are the same rule rather than two that drift.
 */
export function partProblems(chosen: readonly ParsedPart[], sex?: CharacterSex): string[] {
  const problems: string[] = [];
  const bySlot = new Map(chosen.map((p) => [p.slot, p]));
  const hidden = concealedSlots(chosen);

  if (sex) {
    for (const part of chosen) {
      if (part.sex !== 'any' && part.sex !== sex) {
        problems.push(`${part.slot}: ${part.stem} is a ${part.sex} part on a ${sex} character`);
      }
    }
  }

  for (const [slot, needs] of Object.entries(SLOT_REQUIRES) as [CharacterSlot, CharacterSlot][]) {
    if (bySlot.has(slot) && !bySlot.has(needs)) {
      problems.push(`${slot} needs a ${needs}: it has nothing to mount on`);
    }
  }
  for (const slot of hidden) {
    if (bySlot.has(slot)) {
      const by = chosen.find((p) => p.conceals.includes(slot))!;
      problems.push(`${slot} is hidden by ${by.stem} — it would never be seen`);
    }
  }
  return problems;
}

/**
 * Where a Synty POLYGON part belongs.
 *
 * Their modular line names files `SK_Chr_<Slot>_<Sex>_<NN>` — with the sex
 * omitted on the pieces that are unisex (`SK_Chr_Hair_07`,
 * `SK_Chr_ShoulderAttachLeft_03`). Returns null for anything unrecognised so
 * a stray file in a pack folder is skipped rather than silently landing in
 * the wrong slot.
 */
export interface ParsedPart {
  readonly slot: CharacterSlot;
  readonly sex: 'male' | 'female' | 'any';
  readonly stem: string;
  /** Slots this part covers up, so nothing is chosen that cannot be seen. */
  readonly conceals: readonly CharacterSlot[];
}

/**
 * What each of this pack's prefixes actually is, and what wearing it hides.
 *
 * Two of these are not what their filenames suggest, and getting them wrong
 * put a menu of helmets in the head list and a menu of plumes in the helmet
 * list:
 *
 *  - `Head_No_Elements_*` is not a plain head with the extras left off. It
 *    is a HELMED head — two to four times the vertices of a bare one, much
 *    deeper front to back, and with no `eyes` bone at all, because the face
 *    is inside it.
 *  - `HelmetAttachment_*` is not a helmet. It is what mounts ON one: crests
 *    and plumes sitting at y=173-195, above the skull.
 */
const POLYGON_SLOTS: Readonly<Record<string, { slot: CharacterSlot; conceals?: CharacterSlot[] }>> =
  Object.freeze({
    head: { slot: 'head' },
    head_no_elements: {
      slot: 'helmet',
      // A closed helm covers the lot, the head included: this mesh IS the
      // head, so a bare one chosen as well would sit inside it and poke
      // through. A hood goes the same way — it is cut to sit on a skull, not
      // over a helm, and the two intersect. Offering any of them under a
      // helmet is offering a choice with no visible consequence.
      conceals: ['head', 'headCovering', 'hair', 'facialHair', 'eyebrows', 'ears'],
    },
    torso: { slot: 'torso' },
    hips: { slot: 'hips' },
    armupperleft: { slot: 'armUpperL' },
    armupperright: { slot: 'armUpperR' },
    armlowerleft: { slot: 'armLowerL' },
    armlowerright: { slot: 'armLowerR' },
    handleft: { slot: 'handL' },
    handright: { slot: 'handR' },
    legleft: { slot: 'legL' },
    legright: { slot: 'legR' },
    hair: { slot: 'hair' },
    facialhair: { slot: 'facialHair' },
    eyebrow: { slot: 'eyebrows' },
    ear_ear: { slot: 'ears' },
    // The pack states the cut in the filename, so believe it rather than
    // guessing from the shape of the mesh.
    headcoverings_base_hair: { slot: 'headCovering' },
    headcoverings_no_hair: { slot: 'headCovering', conceals: ['hair'] },
    headcoverings_no_facialhair: { slot: 'headCovering', conceals: ['facialHair'] },
    helmetattachment: { slot: 'helmetCrest' },
    backattachment: { slot: 'back' },
    shoulderattachleft: { slot: 'shoulderL' },
    shoulderattachright: { slot: 'shoulderR' },
    elbowattachleft: { slot: 'elbowL' },
    elbowattachright: { slot: 'elbowR' },
    kneeattachleft: { slot: 'kneeL' },
    kneeattachright: { slot: 'kneeR' },
    hipsattachment: { slot: 'hipsAttachment' },
  });

export function parsePolygonPart(file: string): ParsedPart | null {
  const stem = file.replace(/\.fbx$/i, '');
  const m = /^SK_Chr_(.+?)(?:_(Male|Female))?_(\d+)$/i.exec(stem);
  if (!m) return null;
  const entry = POLYGON_SLOTS[m[1]!.toLowerCase()];
  if (!entry) return null;
  const sex = m[2] ? (m[2].toLowerCase() as 'male' | 'female') : 'any';
  return { slot: entry.slot, sex, stem, conceals: entry.conceals ?? [] };
}

/**
 * What a calling is allowed (D-566).
 *
 * ⚠ Empty means UNRESTRICTED, everywhere, and the whole design rests on it:
 * a class authored before these fields existed carries none of them, parses to
 * `[]`, and stays exactly as permissive as it was. Narrowing is a deliberate
 * edit; nothing is silently locked by adding a field.
 *
 * The `list` is whatever the class declared and `want` is what is being
 * attempted — a material, a stance or a race id. Kept as one function rather
 * than three because the rule is one rule, and three copies of it are three
 * chances for one of them to invert.
 */
export function classAdmits(list: readonly string[], want: string): boolean {
  return list.length === 0 || list.includes(want);
}

/**
 * Why this calling may not use this thing, or null if it may (D-566).
 *
 * WARNING: **empty means UNRESTRICTED**, one rule for all of them. The nine
 * classes authored before these fields existed carry none of them, parse to
 * `[]`, and behave exactly as before; authoring a class is NARROWING from
 * everything, so a half-finished class is permissive rather than unplayable.
 *
 * WARNING: `items` is ADDITIVE, not another restriction. The schema calls it
 * "specific item templates this calling may use, BEYOND the broad gates" --
 * it is an exception list, so a magus barred from plate can still be handed
 * the one warded breastplate the story needs. Reading it as a whitelist would
 * mean naming every ordinary item on every class.
 *
 * WARNING: this is ACCESS, never power (D-207 -> D-522). Telling a magus they
 * may not wear plate removes an option; it does not make the man-at-arms hit
 * harder. Nothing here may grant anything.
 */
export function itemGateProblem(
  gates: { armour: readonly string[]; weapons: readonly string[]; items: readonly string[] },
  item: { id: string; material?: string; stance?: string },
): string | null {
  if (gates.items.includes(item.id)) return null;
  if (item.material !== undefined && !classAdmits(gates.armour, item.material)) {
    return `cannot wear ${item.material}`;
  }
  if (item.stance !== undefined && !classAdmits(gates.weapons, item.stance)) {
    return `cannot wield ${item.stance} weapons`;
  }
  return null;
}

/** Everything wrong with a class's gates, given what exists to gate on. */
export function classGateProblems(
  gates: { armour: readonly string[]; weapons: readonly string[]; races: readonly string[] },
  known: { races: ReadonlySet<string> } | null,
): string[] {
  const problems: string[] = [];
  // ⚠ Only race ids can be wrong here — `armour` and `weapons` are closed
  // enums the schema already rejects, but a race is content and can be
  // renamed or deleted out from under a class that names it.
  if (known) {
    for (const race of gates.races) {
      if (!known.races.has(race)) {
        problems.push(`admits race '${race}', which no content/races file defines`);
      }
    }
  }
  return problems;
}
