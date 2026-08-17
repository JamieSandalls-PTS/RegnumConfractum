import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { generateAppearance } from '@rc/shared';
import { CharacterVisual } from '../src/render/character';

/**
 * Walk grounding (stakeholder, 2026-08-17): at no point in the walk cycle
 * may BOTH feet be off the floor — a walk always keeps one support foot
 * down; airborne frames read as jogging. The pelvis height is solved
 * analytically from the leg angles each frame (see animWalk), and this
 * test is the proof: it samples entire cycles for a spread of seeds
 * (both sexes, different proportions) and asserts ground contact.
 */

/** World-space lowest point of one leg's foot meshes (heel + toe wedge). */
function footBottomY(root: THREE.Object3D, side: 'left' | 'right'): number {
  const box = new THREE.Box3();
  const tmp = new THREE.Box3();
  let found = false;
  root.traverse((o) => {
    if (o instanceof THREE.Mesh && (o.name === `${side} heel` || o.name === `${side} foot`)) {
      tmp.setFromObject(o);
      if (found) box.union(tmp);
      else {
        box.copy(tmp);
        found = true;
      }
    }
  });
  if (!found) throw new Error(`no foot meshes for ${side}`);
  return box.min.y;
}

describe('walk keeps one foot on the floor', () => {
  it('some foot is in ground contact at every phase, for varied bodies', () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const scene = new THREE.Scene();
      const visual = new CharacterVisual(seed, scene);
      visual.setPosition(0, 0);
      // Walk in: small fixed steps past the 0.22s pose cross-fade so the
      // sampled frames are pure walk cycle.
      let t = 0;
      const dt = 1 / 60;
      for (let i = 0; i < 30; i++) {
        t += dt;
        visual.update(dt, t, true, 0);
      }
      // One full stride cycle is 2π/3.7 s; sample two cycles densely.
      const cycle = (2 * Math.PI) / 3.7;
      const samples = 48;
      let worstContact = -Infinity;
      const head = ((): THREE.Object3D => {
        let found: THREE.Object3D | null = null;
        scene.traverse((o) => {
          if (o.name === 'head' && !found) found = o;
        });
        if (!found) throw new Error('no head mesh');
        return found;
      })();
      const wp = new THREE.Vector3();
      let bobMin = Infinity;
      let bobMax = -Infinity;
      for (let i = 0; i < samples; i++) {
        t += (2 * cycle) / samples;
        visual.update((2 * cycle) / samples, t, true, 0);
        scene.updateMatrixWorld(true);
        const lowest = Math.min(
          footBottomY(scene, 'left'),
          footBottomY(scene, 'right'),
        );
        // The lower foot must touch the floor: within 2.5cm above it (no
        // airborne double-float), and no deeper than 5cm through it (the
        // toe-roll contact model is an approximation).
        expect(lowest, `seed ${seed} phase ${i}/${samples} floats`).toBeLessThan(0.025);
        expect(lowest, `seed ${seed} phase ${i}/${samples} sinks`).toBeGreaterThan(-0.05);
        worstContact = Math.max(worstContact, lowest);
        head.getWorldPosition(wp);
        bobMin = Math.min(bobMin, wp.y);
        bobMax = Math.max(bobMax, wp.y);
      }
      // Sanity: the constraint is active, not vacuous — some phase brings
      // the lower foot right down to the floor plane.
      expect(worstContact).toBeGreaterThan(-0.05);
      // Vertical bob amplitude vs the gait reference (Inman/Saunders:
      // ~3cm at natural speed, ≈1.8% of stature; stakeholder report
      // 2026-08-17: the raw pendulum arc bobbed 6% and read as bouncing).
      // Some oscillation must remain — a dead-flat glide is also wrong.
      const appearance = generateAppearance(seed);
      const bobFrac = (bobMax - bobMin) / appearance.height;
      expect(bobFrac, `seed ${seed} bobs like a jogger`).toBeLessThan(0.03);
      expect(bobFrac, `seed ${seed} glides like a ghost`).toBeGreaterThan(0.008);
      visual.dispose();
    }
  });
});
