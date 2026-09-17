import { z } from 'zod';

/**
 * Cloth physics for a clothing PART (D-631).
 *
 * The workbench used to tune a generated grid pinned to a placeholder body
 * and export the numbers for somebody to bake by hand (D-520, reduced to a
 * stand-in by D-617). The stakeholder's ask is the other way round: pick a
 * real clothing asset from the pack — a cape, a skirt, a hood — and define
 * the physics FOR THAT MESH. So the settings are keyed by part stem, live in
 * `content/cloth/<pack>.json` beside the part names, and the solver runs on
 * the mesh's own vertices: which of them hang free is read off the pack's
 * bone weights rather than authored as a grid.
 *
 * ⚠ Per PART, not per garment. A garment covers up to five slots and the same
 * cape stem is worn by many garments; the physics belongs to the mesh.
 *
 * ⚠ Every number here is a feel setting the stakeholder tunes by looking, and
 * none is ratified. The defaults are a cape that hangs.
 */

export const ClothColliderSchema = z
  .object({
    /** A bone of the rig, by name (`spine_02`, `thigh_l`). */
    bone: z.string().min(1),
    /** A second bone: the volume is a capsule from `bone` to `to`. Absent means a sphere. */
    to: z.string().min(1).optional(),
    /** Metres, on a 1.0-scale figure. */
    radius: z.number().positive().max(1),
  })
  .strict();
export type ClothCollider = z.infer<typeof ClothColliderSchema>;

export const ClothSettingsSchema = z
  .object({
    /**
     * Bones whose weighted vertices are SIMULATED. Everything else on the
     * mesh is pinned to the animation. For this pack's capes that is the
     * orphan chain `back_02..back_06`; the collar, weighted to the spine,
     * stays put.
     */
    freeBones: z.array(z.string().min(1)).min(1),
    /** A vertex is free when its weight on `freeBones` is at least this. */
    freeWeight: z.number().min(0).max(1).default(0.5),
    /** Metres per second squared, downward. */
    gravity: z.number().min(0).max(60).default(9.8),
    /** Velocity kept per step; lower is deader. */
    damping: z.number().min(0.5).max(1).default(0.985),
    /** How hard an edge holds its rest length, per pass. */
    stiffness: z.number().min(0).max(1).default(0.9),
    /** How hard the surface resists folding, per pass. 0 is silk. */
    bend: z.number().min(0).max(1).default(0.25),
    /** Constraint passes per substep. */
    iterations: z.number().int().min(1).max(20).default(6),
    /** Multiplies the wind the world reports. */
    windScale: z.number().min(0).max(10).default(1),
    /** Metres per second squared at full wind. */
    windStrength: z.number().min(0).max(60).default(4),
    /** Kept between the cloth and a collider, metres. */
    thickness: z.number().min(0).max(0.2).default(0.02),
    /** Metres above the character's feet the cloth may not fall below. */
    floor: z.number().min(0).max(1).default(0.02),
    colliders: z.array(ClothColliderSchema).default([]),
    note: z.string().optional(),
  })
  .strict();
export type ClothSettings = z.infer<typeof ClothSettingsSchema>;

/** One file per pack: stem → settings, like `content/parts/<pack>.json`. */
export const ClothFileSchema = z
  .object({
    pack: z.string().min(1),
    cloth: z.record(z.string().min(1), ClothSettingsSchema).default({}),
  })
  .strict();
export type ClothFile = z.infer<typeof ClothFileSchema>;

/**
 * The body a cape has to get round, as capsules on the Unreal rig (D-555):
 * the trunk, both arms down to the hands, both legs down to the feet. The
 * stakeholder's ruling (D-631): a cape collides with thighs, legs, feet, arms
 * and hands — not only the trunk, or it falls through a striding leg and a
 * swinging arm. Radii are measured off the pack's male body: a starting
 * point, not a tuning.
 *
 * ⚠ Names are matched without case: the rig spells `Pelvis` and `Thigh_R`
 * beside `spine_02` and `calf_l`.
 */
export const CAPE_COLLIDERS: readonly ClothCollider[] = [
  { bone: 'pelvis', to: 'spine_02', radius: 0.17 },
  { bone: 'spine_02', to: 'neck_01', radius: 0.16 },
  { bone: 'upperarm_l', to: 'lowerarm_l', radius: 0.06 },
  { bone: 'upperarm_r', to: 'lowerarm_r', radius: 0.06 },
  { bone: 'lowerarm_l', to: 'hand_l', radius: 0.05 },
  { bone: 'lowerarm_r', to: 'hand_r', radius: 0.05 },
  { bone: 'hand_l', radius: 0.06 },
  { bone: 'hand_r', radius: 0.06 },
  { bone: 'thigh_l', to: 'calf_l', radius: 0.09 },
  { bone: 'thigh_r', to: 'calf_r', radius: 0.09 },
  { bone: 'calf_l', to: 'foot_l', radius: 0.07 },
  { bone: 'calf_r', to: 'foot_r', radius: 0.07 },
  { bone: 'foot_l', to: 'ball_l', radius: 0.07 },
  { bone: 'foot_r', to: 'ball_r', radius: 0.07 },
];

export function defaultClothSettings(freeBones: readonly string[]): ClothSettings {
  return ClothSettingsSchema.parse({ freeBones: [...freeBones], colliders: [...CAPE_COLLIDERS] });
}

/**
 * Everything wrong with a cloth file, in the author's words. Pure, so the
 * tool refuses exactly what CI refuses (D-543).
 *
 * `partStems` is the pack's part list when the caller can see the art, or
 * null in CI, where `assets/source/` is gitignored and the check is against
 * the NAMED parts instead.
 */
export function clothProblems(
  file: ClothFile,
  partStems: ReadonlySet<string> | null,
): string[] {
  const problems: string[] = [];
  for (const [stem, s] of Object.entries(file.cloth)) {
    if (partStems && !partStems.has(stem)) {
      problems.push(`${stem}: not a part of ${file.pack}`);
    }
    for (const c of s.colliders) {
      if (c.to === c.bone) problems.push(`${stem}: collider ${c.bone} runs to itself`);
    }
    const dup = new Set<string>();
    for (const b of s.freeBones) {
      if (dup.has(b)) problems.push(`${stem}: free bone ${b} listed twice`);
      dup.add(b);
    }
  }
  return problems;
}
