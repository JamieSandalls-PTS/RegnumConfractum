import { describe, expect, it } from 'vitest';
import { CAPE_COLLIDERS, ClothFileSchema, clothProblems, defaultClothSettings } from '../src/cloth';

/**
 * A cape collides with the whole body (D-631, the stakeholder's ruling):
 * thighs, legs, feet, arms and hands, not only the trunk. A default that
 * dropped a limb would let the cape fall through a striding leg and look
 * like the solver was broken.
 */
describe('the cape defaults', () => {
  it('⚠ cover the trunk, both arms to the hands and both legs to the feet', () => {
    const bones = new Set(CAPE_COLLIDERS.flatMap((c) => [c.bone, ...(c.to ? [c.to] : [])]));
    for (const b of ['pelvis', 'spine_02', 'neck_01', 'upperarm_l', 'lowerarm_l', 'hand_l',
      'upperarm_r', 'lowerarm_r', 'hand_r', 'thigh_l', 'calf_l', 'foot_l', 'thigh_r', 'calf_r', 'foot_r']) {
      expect(bones.has(b), b).toBe(true);
    }
    // Hands are spheres; feet run to the toe bone.
    expect(CAPE_COLLIDERS.filter((c) => !c.to).map((c) => c.bone).sort()).toEqual(['hand_l', 'hand_r']);
    expect(bones.has('ball_l') && bones.has('ball_r')).toBe(true);
  });

  it('parse as settings, and file cleanly', () => {
    const s = defaultClothSettings(['back_02']);
    const file = ClothFileSchema.parse({ pack: 'p', cloth: { SK_Chr_BackAttachment_15: s } });
    expect(clothProblems(file, new Set(['SK_Chr_BackAttachment_15']))).toEqual([]);
    expect(clothProblems(file, new Set(['other']))).toEqual(['SK_Chr_BackAttachment_15: not a part of p']);
  });
});
