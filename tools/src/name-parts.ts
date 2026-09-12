import './node-dom';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import type { BufferAttribute, Mesh } from 'three';
import {
  ARMOUR_MATERIALS,
  type ArmourMaterial,
  PartNamesSchema,
  SKIN_UV_MAX_V,
  mirroredName,
  mirroredPart,
  parsePolygonPart,
  preferredAtlas,
  type PartNames,
} from '@rc/shared';
import { hex, readPng, sampleUv, type Bitmap } from './png.js';
import { meshPath, packs, partStems, texturesIn } from './packs.js';

/**
 * Name and classify the character parts the stakeholder has not reached
 * (D-566).
 *
 *   npm run name:parts
 *
 * ⚠ The filenames carry NOTHING to name from. Every part is
 * `SK_Chr_Torso_Male_12` — slot, sex, number — so unlike `name:assets`
 * (D-563), which had accurate weapon filenames to rearrange, there is no text
 * here to work with at all. Drafting from the filename would invent data.
 *
 * What there IS, is pixels. A part's UVs sample a handful of flat colours out
 * of the atlas (measured: three to seven, the same finding as skin in D-560
 * and weapons in D-564), and those colours say what the thing is made of:
 * plate is desaturated grey, leather is brown, cloth is saturated. That is a
 * MEASUREMENT, so it is what this drafts from.
 *
 * ⚠ It classifies MATERIAL, not cut. "Steel plate male" on an upper arm might
 * be a pauldron, a vambrace or a mail sleeve — the colour cannot tell them
 * apart and neither can this. Every name it writes is a draft to be improved
 * by somebody looking, and the material tag under it is the part that is
 * actually load-bearing (a class admits plate or it does not).
 *
 * ⚠ It NEVER overwrites a name a person wrote, the same rule as `name:assets`
 * and `fit:weapons`.
 */

const root = fileURLToPath(new URL('../..', import.meta.url));
const partsDir = join(root, 'content', 'parts');
const loader = new FBXLoader();

/**
 * The vocabulary lives in `shared` — the class schema gates on it and CI
 * checks it, so a second copy here would be a second chance to disagree.
 */
export const MATERIALS = ARMOUR_MATERIALS;
export type Material = ArmourMaterial;

/**
 * Slots a material means something for.
 *
 * ⚠ A head is not "bare armour" and hair is not cloth. Classifying every slot
 * tagged 128 faces and hairstyles `base`, which reads as a decision and is
 * noise — and would put eyebrows in front of a class's armour rule. Only
 * things that can be ARMOUR are classified.
 */
const ARMOURABLE = new Set([
  'torso', 'hips', 'armUpperL', 'armUpperR', 'armLowerL', 'armLowerR',
  'handL', 'handR', 'legL', 'legR',
  'shoulderL', 'shoulderR', 'elbowL', 'elbowR', 'kneeL', 'kneeR',
  'helmet', 'headCovering', 'hipsAttachment', 'back',
]);

/** How grey a colour is: 0 is a pure grey, 1 is fully saturated. */
export function saturation(rgb: readonly [number, number, number]): number {
  const max = Math.max(...rgb);
  return max === 0 ? 0 : (max - Math.min(...rgb)) / max;
}

/**
 * Colours too dark to vote.
 *
 * ⚠ MEASURED, and it is the difference between a working classifier and a
 * useless one. `#2d3237` and `#3b4348` are 133,000 pixels of this atlas and
 * they are SHADOW — a robe measures 24% `#2d3237`, and so does a harness. Left
 * in the vote they read as dark steel and carry everything to plate: the
 * distribution went 155/210/227 to 381/173/38 the moment they counted.
 *
 * ⚠ And the accuracy score did not catch it — it went UP, to 93%, because the
 * names a person wrote are mostly plate torsos and a plate-biased classifier
 * scores well on them. Accuracy on an unbalanced set is not sufficient
 * evidence; the distribution has to be looked at too, which is why there is a
 * test for it.
 */
const SHADOW_FLOOR = 80;

export function isGrey(rgb: readonly [number, number, number]): boolean {
  return saturation(rgb) < 0.12;
}

/** Whether this colour says anything about the material at all. */
export function votes(rgb: readonly [number, number, number]): boolean {
  return Math.max(...rgb) >= SHADOW_FLOOR;
}

/** Is this brown — a warm, dark, half-saturated colour? Leather and wood. */
export function isBrown(rgb: readonly [number, number, number]): boolean {
  const [r, g, b] = rgb;
  const sat = saturation(rgb);
  return r > b && g >= b && sat > 0.12 && sat < 0.62 && max3(rgb) < 210;
}

const max3 = (rgb: readonly [number, number, number]): number => Math.max(...rgb);

export interface PartColours {
  /** Colour → share of sampled UVs, garment only (skin excluded). */
  readonly shares: ReadonlyMap<string, number>;
  /** How much of the part is bare skin, 0–1. */
  readonly skin: number;
}

/**
 * What material a part reads as.
 *
 * ⚠ Order matters and is not arbitrary. Bare is checked FIRST because a naked
 * arm is mostly skin and its few remaining colours are meaningless; plate
 * second, because a steel-and-leather harness is plate with straps and not
 * leather with buckles; cloth is the fallback, because everything that is
 * neither metal nor hide is fabric.
 */
export function materialOf(colours: PartColours): Material | 'bare' {
  if (colours.skin > 0.9) return 'bare';
  let grey = 0;
  let brown = 0;
  let counted = 0;
  for (const [h, share] of colours.shares) {
    const rgb = [
      parseInt(h.slice(1, 3), 16),
      parseInt(h.slice(3, 5), 16),
      parseInt(h.slice(5, 7), 16),
    ] as [number, number, number];
    if (!votes(rgb)) continue;
    counted += share;
    if (isGrey(rgb)) grey += share;
    else if (isBrown(rgb)) brown += share;
  }
  const norm = counted || 1;
  if (grey / norm >= 0.35) return 'plate';
  if (brown / norm >= 0.45) return 'leather';
  return 'cloth';
}

/** A word for the dominant colour, so two plate arms are not one name. */
export function shadeWord(rgb: readonly [number, number, number]): string {
  const [r, g, b] = rgb;
  const light = max3(rgb);
  if (isGrey(rgb)) return light < 70 ? 'Blackened' : light < 130 ? 'Dark' : light < 190 ? 'Steel' : 'Bright';
  if (isBrown(rgb) && r > 150 && g > 120) return 'Tan';
  if (isBrown(rgb)) return light < 90 ? 'Dark' : 'Brown';
  if (b > r && b > g) return 'Blue';
  if (g > r && g > b) return 'Green';
  if (r > 150 && g > 110 && b < 110) return 'Gold';
  if (r > g && r > b) return 'Red';
  return 'Painted';
}

/** Sample one part's UVs against the atlas. */
export function measurePart(uvs: BufferAttribute, atlas: Bitmap): PartColours {
  const shares = new Map<string, number>();
  let skin = 0;
  let garment = 0;
  for (let i = 0; i < uvs.count; i++) {
    const u = uvs.getX(i);
    const v = uvs.getY(i);
    // D-560: skin is the bottom 0.31 of the atlas. Excluding it is what makes
    // a bare arm and a mailed one distinguishable at all — otherwise every
    // limb reads as "mostly skin colour" and nothing separates them.
    if (v <= SKIN_UV_MAX_V) {
      skin++;
      continue;
    }
    garment++;
    const h = hex(sampleUv(atlas, u, v));
    shares.set(h, (shares.get(h) ?? 0) + 1);
  }
  const total = skin + garment || 1;
  const normalised = new Map<string, number>();
  for (const [h, n] of shares) normalised.set(h, n / (garment || 1));
  return { shares: normalised, skin: skin / total };
}

const SLOT_NOUN: Record<string, string> = {
  torso: 'cuirass',
  hips: 'faulds',
  armUpperL: 'pauldron',
  armUpperR: 'pauldron',
  armLowerL: 'vambrace',
  armLowerR: 'vambrace',
  handL: 'gauntlet',
  handR: 'gauntlet',
  legL: 'greave',
  legR: 'greave',
  headCovering: 'hood',
  helmet: 'helm',
  helmetCrest: 'crest',
  shoulderL: 'shoulder',
  shoulderR: 'shoulder',
  elbowL: 'couter',
  elbowR: 'couter',
  kneeL: 'poleyn',
  kneeR: 'poleyn',
  hipsAttachment: 'belt piece',
  back: 'back piece',
};

/** Cloth and leather do not wear a cuirass; they wear a jerkin and a tunic. */
const SOFT_NOUN: Record<string, string> = {
  torso: 'jerkin',
  hips: 'skirt',
  armUpperL: 'sleeve',
  armUpperR: 'sleeve',
  armLowerL: 'bracer',
  armLowerR: 'bracer',
  handL: 'glove',
  handR: 'glove',
  legL: 'legging',
  legR: 'legging',
};

export function draftName(
  slot: string,
  sex: 'male' | 'female' | 'any',
  material: Material | 'bare',
  dominant: string | null,
): string {
  const noun =
    material === 'plate' ? (SLOT_NOUN[slot] ?? slot) : (SOFT_NOUN[slot] ?? SLOT_NOUN[slot] ?? slot);
  if (material === 'bare') return cap(`bare ${SOFT_NOUN[slot] ?? SLOT_NOUN[slot] ?? slot}${suffix(sex)}`);
  const rgb = dominant
    ? ([
        parseInt(dominant.slice(1, 3), 16),
        parseInt(dominant.slice(3, 5), 16),
        parseInt(dominant.slice(5, 7), 16),
      ] as [number, number, number])
    : null;
  const shade = rgb ? shadeWord(rgb) : '';
  return cap(`${shade} ${noun}${suffix(sex)}`.replace(/\s+/g, ' ').trim());
}

const suffix = (sex: 'male' | 'female' | 'any'): string => (sex === 'any' ? '' : ` ${sex}`);
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

export interface DraftResult {
  named: number;
  kept: number;
  mirrored: number;
  byMaterial: Record<string, number>;
  problems: string[];
}

const invokedDirectly = process.argv[1]?.includes('name-parts');
if (invokedDirectly) {
  for (const pack of packs()) {
    const file = join(partsDir, `${pack.id}.json`);
    const existing: PartNames = existsSync(file)
      ? PartNamesSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
      : { pack: pack.id, names: {}, tags: {} };

    const atlasName = preferredAtlas(texturesIn(pack));
    if (!atlasName || !pack.textureDir) {
      console.log(`${pack.id}: no atlas to sample — nothing can be classified by colour`);
      continue;
    }
    const atlasFile = join(pack.textureDir, `${atlasName}.png`);
    const atlas = readPng(readFileSync(atlasFile));
    console.log(`${pack.id}: sampling against ${atlasName} (${atlas.width}x${atlas.height})`);

    const result: DraftResult = { named: 0, kept: 0, mirrored: 0, byMaterial: {}, problems: [] };
    const taken = new Map<string, Set<string>>();
    for (const [stem, name] of Object.entries(existing.names)) {
      const slot = parsePolygonPart(stem)?.slot ?? '?';
      if (!taken.has(slot)) taken.set(slot, new Set());
      taken.get(slot)!.add(name.toLowerCase());
    }

    for (const stem of [...partStems(pack)].sort()) {
      const already = existing.names[stem];
      const parsed = parsePolygonPart(stem);
      if (!parsed) {
        result.problems.push(`${stem}: not a recognisable part filename`);
        continue;
      }
      // A part whose MIRROR is already named takes that name, swapped. This is
      // measured, not assumed: D-562 found 0.89–0.97 UV overlap across the
      // male/female cut of every twice-cut slot.
      // ⚠ A part that is already NAMED still has to be classified: the material
      // tag is the thing a class gates on, and skipping the 221 the stakeholder
      // named by hand would leave every plate cuirass in the game untagged —
      // which is the half of the job that actually matters.
      const twin = mirroredPart(stem);
      if (!already && twin && existing.names[twin] && parsed.sex !== 'any') {
        existing.names[stem] = mirroredName(existing.names[twin], parsed.sex);
        result.mirrored++;
      }

      const path = meshPath(pack, stem);
      if (!path) {
        result.problems.push(`${stem}: no mesh on disk`);
        continue;
      }
      let uvs: BufferAttribute | null = null;
      try {
        const group = loader.parse(readFileSync(path).buffer as ArrayBuffer, '');
        group.traverse((o) => {
          const mesh = o as Mesh;
          const a = mesh.isMesh ? (mesh.geometry?.getAttribute('uv') as BufferAttribute) : null;
          if (a && !uvs) uvs = a;
        });
      } catch (e) {
        result.problems.push(`${stem}: ${(e as Error).message}`);
        continue;
      }
      if (!uvs) {
        result.problems.push(`${stem}: no UVs`);
        continue;
      }

      const colours = measurePart(uvs, atlas);
      const material = materialOf(colours);
      const dominant = [...colours.shares].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

      if (!existing.names[stem]) {
        let name = draftName(parsed.slot, parsed.sex, material, dominant);
        // Two identical names in one slot is a menu where a player chooses
        // between two of the same word (D-560). Number only the collisions.
        if (!taken.has(parsed.slot)) taken.set(parsed.slot, new Set());
        const used = taken.get(parsed.slot)!;
        if (used.has(name.toLowerCase())) {
          let n = 2;
          while (used.has(`${name} ${n}`.toLowerCase())) n++;
          name = `${name} ${n}`;
        }
        used.add(name.toLowerCase());
        existing.names[stem] = name;
        result.named++;
      } else {
        result.kept++;
      }

      const tags = new Set(existing.tags[stem] ?? []);
      for (const m of MATERIALS) tags.delete(m);
      if (ARMOURABLE.has(parsed.slot)) {
        if (material === 'bare') tags.add('base');
        else tags.add(material);
        // ⚠ Counted AFTER the armour gate, not before. Counting the
        // classification rather than the tag reported 128 bare parts when 19
        // were written — every face and hairstyle read as bare skin, got no
        // tag, and was tallied anyway. A summary that does not describe the
        // file is worse than no summary.
        result.byMaterial[material] = (result.byMaterial[material] ?? 0) + 1;
      } else {
        // A face has no material. Any it picked up on an earlier run goes.
        tags.delete('base');
        result.byMaterial.unclassified = (result.byMaterial.unclassified ?? 0) + 1;
      }
      // `draft` marks a NAME nobody has looked at. A name the stakeholder wrote
      // is not a draft even though its material tag was measured here.
      if (already) tags.delete('draft');
      else tags.add('draft');
      existing.tags[stem] = [...tags];
    }

    writeFileSync(file, `${JSON.stringify(PartNamesSchema.parse(existing), null, 2)}\n`);
    console.log(
      `  kept ${result.kept} already named · drafted ${result.named} · mirrored ${result.mirrored}`,
    );
    console.log(`  by material: ${JSON.stringify(result.byMaterial)}`);
    for (const p of result.problems.slice(0, 10)) console.log(`  ! ${p}`);
    if (result.problems.length > 10) console.log(`  ! …and ${result.problems.length - 10} more`);
  }
}
