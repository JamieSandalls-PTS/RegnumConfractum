import { z } from 'zod';
import {
  ARMOUR_MATERIALS,
  CHARACTER_SEXES,
  CHARACTER_SLOTS,
  CharacterSlotSchema,
  parsePolygonPart,
  type ArmourMaterial,
  type CharacterSex,
  type CharacterSlot,
} from './characters';
import { ContentIdSchema, HexColourSchema } from './content';

/**
 * A garment — the thing a character actually WEARS (D-562, built in D-570).
 *
 * ⚠ The finding this exists to implement, in the stakeholder's words: a "set"
 * is a WARDROBE, not a costume. Gloves from one set mix with a torso from
 * another, and some armours leave the arms bare. So the equippable thing is
 * not "plate armour #12" — it is a LIST OF SLOT SWAPS, covering one slot or
 * five, mixing freely.
 *
 * ⚠ It has to be swaps rather than layers because of what D-560 measured:
 * there is essentially NO BARE BODY in this pack. Of 720 parts, arms and
 * hands have ONE bare option each and torso and hips have NONE — a body and
 * its clothes are the same mesh. Layering a breastplate over a torso would
 * put it over a shirt that cannot be taken off.
 *
 * ⚠ And it has to be authored by LOOKING. D-562 tried twice to group parts
 * into outfits by number: UV overlap ACROSS slots is void as a metric (an arm
 * and a torso sample different atlas regions whatever set they belong to),
 * and garment-colour overlap gives 0.34 within a number against 0.33 across —
 * no signal. The pack dresses everything from one palette. A machine cannot
 * tell which torso goes with which gloves, so the editor previews and a
 * person decides.
 */

/**
 * Slots a garment may fill.
 *
 * ⚠ Everything a person IS, rather than wears, is excluded — the face, hair,
 * brows, beard and ears. Two reasons, and the second is the one that matters:
 * a garment is stripped between rounds (D-522), so a garment that replaced
 * your face would change who you look like when you took it off; and gear
 * must never reach the descriptor pipeline, because a helm that silently
 * became a presentation change is the permanent disguise D-539 and D-547 both
 * refused.
 *
 * `helmet` IS here and is not an exception to that. In this pack a closed
 * helm is modelled as the head mesh (it has no `eyes` bone — the face is
 * inside it), so wearing one necessarily swaps the head. It conceals rather
 * than rewrites: take it off and the face underneath is the one you authored.
 */
const NOT_WORN: readonly CharacterSlot[] = ['head', 'hair', 'facialHair', 'eyebrows', 'ears'];

export const GARMENT_SLOTS = CHARACTER_SLOTS.filter(
  (s) => !NOT_WORN.includes(s),
) as readonly CharacterSlot[];

const PartMapSchema = z.record(CharacterSlotSchema, z.string().min(1));

export const GarmentSchema = z
  .object({
    id: ContentIdSchema,
    name: z.string().min(1),
    /** The ingested pack the parts come from. */
    pack: z.string().min(1),
    /**
     * Slot → part stem, per body.
     *
     * ⚠ BOTH bodies, or the garment can only be worn by half the cast. The
     * pack cuts most parts twice and the pairing is by number — measured, not
     * hoped: `Torso_Female_12` shares 0.96 of its UV islands with
     * `Torso_Male_12` and 0.36 with any other female torso (D-562). So the
     * editor fills the other side in with one button, and this schema keeps
     * the two halves in one document so they cannot drift apart.
     */
    parts: z
      .object({
        male: PartMapSchema.default({}),
        female: PartMapSchema.default({}),
      })
      .default({ male: {}, female: {} }),
    /**
     * Colour substitutions against the pack atlas, exactly as an item's art
     * carries (D-566) and safe for the same measured reason: every UV island
     * sits inside one flat region, so a substitution under NEAREST filtering
     * stays clean.
     */
    swaps: z.array(z.object({ from: HexColourSchema, to: HexColourSchema })).default([]),
    notes: z.string().optional(),
  })
  .strict();
export type GarmentDef = z.infer<typeof GarmentSchema>;

/** Every slot this garment dresses, on either body. */
export function garmentSlots(garment: GarmentDef): CharacterSlot[] {
  const out = new Set<CharacterSlot>();
  for (const sex of CHARACTER_SEXES) {
    for (const slot of Object.keys(garment.parts[sex])) out.add(slot as CharacterSlot);
  }
  return [...out].sort();
}

/**
 * What this garment counts as for a class's armour gate (D-566).
 *
 * ⚠ DERIVED, and that is the point of building garments at all. D-566 put
 * `material` on the ITEM and said so in a warning: "declared on the ITEM,
 * which is a compromise and should not outlive the garment editor... its
 * material will be derivable from those parts rather than repeated here."
 * The parts already carry it — 568 of the pack's 720 are tagged plate,
 * leather or cloth by measurement (D-563) — so asking them is one source of
 * truth instead of two that can disagree.
 *
 * ⚠ The HEAVIEST part decides. A mail hauberk with leather gloves is plate: a
 * class barred from plate may not get around it by the gloves being soft,
 * and taking the lightest would make every suit gateable by its least
 * protected inch. `base` is bare skin and is not a material at all (D-566),
 * so it never votes.
 *
 * Returns null when no part carries a material tag — an untagged garment is
 * ungated rather than treated as cloth, because empty means UNRESTRICTED
 * everywhere else in this codebase and a silent default would be the one
 * place it did not.
 */
export function garmentMaterial(
  garment: GarmentDef,
  tags: Readonly<Record<string, readonly string[]>>,
): ArmourMaterial | null {
  // Heaviest first, so the first hit wins.
  const order: ArmourMaterial[] = ['plate', 'leather', 'cloth'];
  const seen = new Set<string>();
  for (const sex of CHARACTER_SEXES) {
    for (const stem of Object.values(garment.parts[sex])) {
      for (const tag of tags[stem] ?? []) seen.add(tag);
    }
  }
  return order.find((m) => seen.has(m)) ?? null;
}

/**
 * Everything wrong with one garment, in one list.
 *
 * Pure, so CI and the authoring tool agree — the same shape `assetProblems`
 * and `recipeProblems` take, and for the same reason: the editor's promise
 * that it refuses what the build refuses is only true while both read one
 * implementation.
 *
 * `meshesInPack` is null when the caller cannot see the art. `assets/source/`
 * is gitignored, so that is CI's normal state, and a skipped check is the
 * only honest answer — never a fabricated pass.
 */
export function garmentProblems(
  garment: GarmentDef,
  meshesInPack: ReadonlySet<string> | null,
): string[] {
  const problems: string[] = [];
  const slots = garmentSlots(garment);
  if (slots.length === 0) {
    problems.push('dresses nothing — a garment must fill at least one slot');
  }

  for (const sex of CHARACTER_SEXES) {
    for (const [slot, stem] of Object.entries(garment.parts[sex])) {
      if (meshesInPack && !meshesInPack.has(stem)) {
        problems.push(`${sex} ${slot}: '${stem}' is not in ${garment.pack}`);
        continue;
      }
      const parsed = parsePolygonPart(stem);
      if (!parsed) {
        problems.push(`${sex} ${slot}: '${stem}' is not a part this pack's naming describes`);
        continue;
      }
      // ⚠ A part filed under the wrong slot key is the mistake a form makes
      // easiest — the dropdown is right there — and it is invisible in the
      // JSON afterwards, because both halves read as plausible strings.
      if (parsed.slot !== slot) {
        problems.push(`${sex} ${slot}: '${stem}' is a ${parsed.slot}, not a ${slot}`);
      }
      // ⚠ A female forearm bound to a male upper arm meets it at the wrong
      // diameter, and the seam is visible from three metres (D-558). Parts
      // the pack cuts once are unisex and belong to both.
      if (parsed.sex !== 'any' && parsed.sex !== sex) {
        problems.push(`${sex} ${slot}: '${stem}' is cut for a ${parsed.sex} body`);
      }
      if (!(GARMENT_SLOTS as readonly string[]).includes(slot)) {
        problems.push(`${sex} ${slot}: is who a character is, not what they wear`);
      }
    }
  }

  // ⚠ THE check. A garment that dresses a male torso and not a female one is
  // wearable by half the cast, and nothing downstream would say so — the
  // other half would simply render in whatever they had on underneath, which
  // reads as an art glitch rather than as missing content.
  for (const slot of slots) {
    const male = garment.parts.male[slot];
    const female = garment.parts.female[slot];
    if (male && !female) problems.push(`${slot}: dressed on a male body only`);
    if (female && !male) problems.push(`${slot}: dressed on a female body only`);
  }
  return problems;
}

/**
 * The other body's half of a garment, filled in by number.
 *
 * ⚠ Safe because the pairing was MEASURED across every slot the pack cuts
 * twice — hips 0.97, legs 0.94, arms 0.89, hands 0.94 shared UV islands,
 * against controls of 0.13 to 0.36 (D-562). It is the same garment cut for a
 * different body, not a hopeful convention.
 *
 * Returns only what it could pair, so a unisex part (a cape, a pauldron) is
 * carried across unchanged and anything the pack cuts once and names without
 * a body word is left for a person.
 */
export function mirrorGarmentParts(
  from: Readonly<Record<string, string>>,
  to: CharacterSex,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [slot, stem] of Object.entries(from)) {
    const parsed = parsePolygonPart(stem);
    if (!parsed) continue;
    if (parsed.sex === 'any') {
      out[slot] = stem;
      continue;
    }
    const other = stem.replace(/_(Male|Female)_/i, `_${to === 'male' ? 'Male' : 'Female'}_`);
    out[slot] = other;
  }
  return out;
}

export { ARMOUR_MATERIALS };
