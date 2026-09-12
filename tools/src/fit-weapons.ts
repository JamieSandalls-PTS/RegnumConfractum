import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AssetFileSchema, type AssetFile, type CharacterItem } from '@rc/shared';
import type { MeshMeasurement } from './measure-weapons.js';

/**
 * Put every worn item in the hand that holds it (D-564).
 *
 *   npm run fit:weapons
 *
 * 163 weapons cannot be placed one at a time by eye, and they do not have to
 * be. What a grip transform is actually made of is three things, and only one
 * of them varies per mesh:
 *
 *  - the UNITS the pack was modelled in, which is measured, not assumed: the
 *    dungeon pack is metres and the other three are centimetres, a 100x
 *    difference that nothing in a file listing shows (D-561);
 *  - the wrist-to-palm offset and the twist that turns a modelled weapon into
 *    a held one, which belong to the HAND and are therefore constant across
 *    every weapon of a family;
 *  - which family it is — a sword is gripped along its length, a shield is
 *    gripped through its middle, and a saw is modelled lying on a different
 *    axis entirely.
 *
 * ⚠ The load-bearing measurement is that the mesh ORIGIN is the grip, in both
 * families. Weapons measure with their origin low on the haft (0.0–0.4 of the
 * way up) and shields measure with theirs at the centre of the boss
 * (0.44–0.71, or dead centre when the board is wider than it is tall) — which
 * is exactly where each is held. So the offset does not need to scale with the
 * weapon: a 2.1m spear and a 48cm knife take the same one.
 *
 * ⚠ It NEVER overwrites a transform somebody has already tuned, the same rule
 * `name:assets` follows. The stakeholder's arming sword is where these numbers
 * came from and it must stay the reference rather than be reformatted by its
 * own descendants.
 */

const root = fileURLToPath(new URL('../..', import.meta.url));
const assetsDir = join(root, 'content', 'assets');
const measurementsFile = join(root, 'tools', 'weapon-measurements.json');

export type Family = 'blade' | 'shield' | 'tool' | 'bow' | 'crossbow';

/**
 * Which of the three a mesh is.
 *
 * By NAME, deliberately, not by shape. A round shield and a war hammer have
 * similar proportions, and a rule that guessed from the box would put one of
 * them in the wrong hand — which is the failure that looks like art rather
 * than like a bug. The names in these packs are accurate (D-563).
 */
export function familyOf(mesh: string, measurement: MeshMeasurement): Family {
  if (/shield|buckler/i.test(mesh)) return 'shield';
  // Crossbow before bow, for the same reason the drafter checks it first.
  if (/crossbow/i.test(mesh)) return 'crossbow';
  if (/(^|_)bow(_|$)/i.test(mesh)) return 'bow';
  // Modelled lying along Z rather than standing on Y: the smith's tools and
  // the horns. Their long axis IS the thing held, so they are blades as far
  // as the grip is concerned, but the twist that stands them up differs.
  if (measurement.axis === 'z') return 'tool';
  return 'blade';
}

/** A weapon's rest transform, per family and per hand. */
interface Grip {
  /** Degrees, applied XYZ, in the bone's own frame. */
  rotation: [number, number, number];
  /** Metres from the wrist. `x` is mirrored for the left hand. */
  position: [number, number, number];
}

/**
 * ⚠ These numbers are the stakeholder's, taken off the arming sword they
 * placed by hand, and everything else is derived from them. The right hand's
 * local +X points back toward the shoulder and the left hand's points away
 * (measured, `measure-hand.ts`), so mirroring a grip is a sign flip on x and
 * nothing else.
 */
const GRIPS: Record<Family, Grip> = {
  blade: { rotation: [270, 10, 0], position: [-0.12, 0.02, -0.02] },
  // ⚠ A shield needs NO rotation, which is the opposite of what it looks like
  // it should need. The left hand's bone frame is the world's in the rest pose
  // (measured, `measure-hand.ts`), and the shields are modelled upright and
  // facing +Z — so identity already stands them up and points them where the
  // character looks. The first guess here was a quarter turn off the blade
  // convention and laid the shield along the arm like a plank.
  shield: { rotation: [0, 0, 0], position: [-0.06, 0.02, -0.02] },
  // Already lying along Z, so it needs the roll but not the stand-up.
  tool: { rotation: [0, 10, 0], position: [-0.12, 0.02, -0.02] },
  // ⚠ A bow needs NO rotation either, and for the shield's reason: it goes in
  // the LEFT hand, whose bone frame is the world's at rest. Measured, both
  // bows are modelled standing on Y (1.46m and 1.42m) with their depth on Z
  // (riser at +Z, string at -Z), so identity already holds the bow upright
  // with the string toward the archer — which is the pose, not an accident.
  //
  // ⚠ The grip needs no offset along the bow either, because the origin sits
  // at the mesh's exact centre (min -72.8, max +72.8) and the centre of a bow
  // IS the riser. That is D-564's finding holding for a third family: these
  // packs model the origin at the hand.
  bow: { rotation: [0, 0, 0], position: [-0.06, 0.02, -0.02] },
  // ⚠ The crossbow is the one weapon in any pack whose origin is NOT the
  // grip. Measured, it runs from z -102.7 to +9.4 — 92% of it behind the
  // origin — so identity leaves the stock hanging a metre behind the fist.
  // `originAt` is what the offset is derived from, per mesh, below; the
  // rotation is identity for the bow's reason.
  crossbow: { rotation: [0, 0, 0], position: [-0.06, 0.02, -0.02] },
};

/**
 * Where along its own length a weapon is held, as a fraction from the low end.
 *
 * ⚠ Only the crossbow needs this. Every other family in these packs models
 * the origin at the grip, so the fraction is whatever `originAt` already is
 * and the correction is zero. A crossbow is held about a third forward of the
 * butt, and the mesh is modelled from the nose, so the two disagree by most
 * of a metre — which is the difference between a weapon in a hand and a
 * weapon floating behind a shoulder.
 *
 * ⚠ UNRATIFIED, and the number is a starting point rather than a measurement:
 * nothing in the mesh says where the trigger is. It is tagged `auto-fit`, so
 * one pass with the wheel in the asset tool (D-565) replaces it for good.
 */
const HELD_AT: Partial<Record<Family, number>> = { crossbow: 0.35 };

/**
 * The scale that turns a pack's own units into metres.
 *
 * Measured from the pack rather than configured: anything modelled at tens or
 * hundreds of units is centimetres, and anything around one is metres. The
 * median is used rather than the mean so one outsized halberd cannot decide it
 * for seventy other meshes.
 */
export function packScale(lengths: readonly number[]): number {
  if (lengths.length === 0) return 1;
  const sorted = [...lengths].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  return median > 10 ? 0.01 : 1;
}

/**
 * The tag this tool writes on everything it places.
 *
 * ⚠ It is what makes re-running safe. Without it there is no way to tell a
 * transform this tool wrote from one a person tuned, so either the tool can
 * never correct its own mistake or it silently overwrites the stakeholder's
 * arming sword. The creation tool STRIPS this tag the moment somebody edits an
 * offset by hand, so a human edit wins from then on.
 */
export const FIT_TAG = 'auto-fit';

/** Whether this tool may write over what is there. */
export function mayFit(item: CharacterItem): boolean {
  const t = item.transform;
  const untouched = t.position.every((v) => v === 0) && t.rotation.every((v) => v === 0);
  return untouched || item.tags.includes(FIT_TAG);
}

export interface FitResult {
  fitted: string[];
  kept: string[];
  missing: string[];
}

export function fitPack(
  assets: AssetFile,
  measurements: readonly MeshMeasurement[],
): FitResult {
  const out: FitResult = { fitted: [], kept: [], missing: [] };
  const byMesh = new Map(measurements.map((m) => [m.mesh, m]));
  const scale = packScale(measurements.map((m) => m.length));

  for (const asset of assets.assets) {
    if (asset.kind !== 'character-item') continue;
    const item = asset;
    const measurement = byMesh.get(item.mesh);
    if (!measurement) {
      out.missing.push(item.mesh);
      continue;
    }
    if (!mayFit(item)) {
      out.kept.push(item.id);
      continue;
    }
    const family = familyOf(item.mesh, measurement);
    const grip = GRIPS[family];
    const mirror = item.attach.endsWith('_L') ? -1 : 1;
    const position: [number, number, number] = [
      grip.position[0] * mirror,
      grip.position[1],
      grip.position[2],
    ];
    // Shift a weapon whose origin is not its grip along its own long axis, in
    // METRES — `length` is in the pack's units, so it goes through `scale`.
    const heldAt = HELD_AT[family];
    if (heldAt !== undefined) {
      const axis = { x: 0, y: 1, z: 2 }[measurement.axis] as 0 | 1 | 2;
      position[axis] += (measurement.originAt - heldAt) * measurement.length * scale;
    }
    item.transform = { position, rotation: [...grip.rotation], scale };
    if (!item.tags.includes(FIT_TAG)) item.tags = [...item.tags, FIT_TAG];
    out.fitted.push(`${item.id} (${family})`);
  }
  return out;
}

const invokedDirectly = process.argv[1]?.includes('fit-weapons');
if (invokedDirectly) {
  if (!existsSync(measurementsFile)) {
    console.log('no measurements — run `npx tsx tools/src/measure-weapons.ts` first');
  } else {
    const all = JSON.parse(readFileSync(measurementsFile, 'utf8')) as MeshMeasurement[];
    const packs = [...new Set(all.map((m) => m.pack))];
    for (const pack of packs) {
      const file = join(assetsDir, `${pack}.character-item.json`);
      if (!existsSync(file)) continue;
      const assets = AssetFileSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
      const result = fitPack(
        assets,
        all.filter((m) => m.pack === pack),
      );
      writeFileSync(file, `${JSON.stringify(AssetFileSchema.parse(assets), null, 2)}\n`);
      console.log(
        `${pack.padEnd(22)} fitted ${String(result.fitted.length).padStart(3)}  ` +
          `kept ${result.kept.length} already tuned  ` +
          `${result.missing.length ? `${result.missing.length} unmeasured` : ''}`,
      );
    }
  }
}
