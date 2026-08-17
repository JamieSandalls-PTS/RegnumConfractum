import * as THREE from 'three';
import {
  generateAppearance,
  type Appearance,
  type Direction,
  type Posture,
  type Presentation,
  type TransientAnim,
} from '@rc/shared';
import { Cloth, SolidHair } from './cloth';

/**
 * A character built entirely from rules at runtime (D-401/402): a "bone" is a
 * THREE.Group, geometry hangs off it, equipment is more geometry parented to
 * the same bones — which is why the sprite-sheet combinatorial explosion
 * never happens.
 *
 * v2 (stakeholder pass, 2026-08-17): sex-derived proportions on top of the
 * neutral appearance parameters, capsule limbs and shaped torso instead of
 * raw boxes, solid physics hair (see SolidHair), sprung chest for the female
 * build, and pose CROSS-FADING — every animation switch blends over ~0.22s
 * instead of snapping, and one-shot emotes play from their own start time.
 */

const FACING_ANGLE: Record<Direction, number> = {
  s: 0,
  se: Math.PI * 0.25,
  e: Math.PI * 0.5,
  ne: Math.PI * 0.75,
  n: Math.PI,
  nw: Math.PI * 1.25,
  w: Math.PI * 1.5,
  sw: Math.PI * 1.75,
};

export interface EquipmentState {
  helm: boolean;
  pauldrons: boolean;
  weapon: boolean;
  cape: boolean;
}

interface Limb {
  sh: THREE.Group;
  el: THREE.Group;
  hand: THREE.Group;
}
interface Leg {
  hip: THREE.Group;
  knee: THREE.Group;
  foot: THREE.Group;
}

/** Duration of the cross-fade when the active animation changes. */
const FADE_SECONDS = 0.22;

export class CharacterVisual {
  readonly root = new THREE.Group();
  readonly appearance: Appearance;
  equipment: EquipmentState;

  private pelvis!: THREE.Group;
  private spine!: THREE.Group;
  private chest!: THREE.Group;
  private neck!: THREE.Group;
  private head!: THREE.Group;
  private arms!: { L: Limb; R: Limb };
  private legs!: { L: Leg; R: Leg };
  private dims!: {
    hipY: number; torsoH: number; headH: number;
    shoulderW: number; hipW: number; bodyW: number;
    /** Shoulder joints' rest height — the shrug raises them from here. */
    baseShY: number;
  };

  private helmGroup: THREE.Group | null = null;
  private pauldronGroup: THREE.Group | null = null;
  private weaponGroup: THREE.Group | null = null;
  private cowlGroup: THREE.Group | null = null;
  private cape: Cloth | null = null;
  private hair: SolidHair | null = null;
  presentation: Presentation = 'normal';

  /** Sprung chest (female build): a damped spring in the chest's local
   * frame, driven by torso motion — visible bounce, clamped to stay decent. */
  private bustGroup: THREE.Group | null = null;
  private bustBase = new THREE.Vector3();
  private bustSpring = { y: 0, vy: 0, z: 0, vz: 0 };
  private lastChestWorld: THREE.Vector3 | null = null;

  private targetAngle = 0;
  private currentAngle = 0;
  private walkPhase: number;
  posture: Posture = 'standing';
  private transientQueue: TransientAnim[] = [];
  private currentTransient: { name: TransientAnim; start: number; until: number } | null = null;

  // Pose blending state
  private joints: THREE.Group[] = [];
  private lastPose: Float32Array | null = null;
  private fadeFrom: Float32Array | null = null;
  private fadeElapsed = 0;
  private lastAnimKey = '';

  /** Seconds a transient emote plays for. */
  private static TRANSIENT_SECONDS = 1.4;

  constructor(seed: number, private parent: THREE.Object3D) {
    this.appearance = generateAppearance(seed);
    this.walkPhase = (seed % 628) / 100;
    this.equipment = {
      helm: this.appearance.helm,
      pauldrons: this.appearance.pauldrons,
      weapon: this.appearance.weapon,
      cape: this.appearance.hasCape,
    };
    this.build();
    parent.add(this.root);
  }

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  private material(color: number): THREE.MeshLambertMaterial {
    return new THREE.MeshLambertMaterial({ color });
  }

  private addMesh(parent: THREE.Object3D, geom: THREE.BufferGeometry, color: number,
    pos: [number, number, number] = [0, 0, 0]): THREE.Mesh {
    const mesh = new THREE.Mesh(geom, this.material(color));
    mesh.position.set(pos[0], pos[1], pos[2]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }

  private box(parent: THREE.Object3D, w: number, h: number, d: number, color: number,
    pos: [number, number, number] = [0, 0, 0]): THREE.Mesh {
    return this.addMesh(parent, new THREE.BoxGeometry(w, h, d), color, pos);
  }

  /**
   * A smooth lathe-turned volume from an [radius, height] profile — the
   * torso is built from these so pelvis/abdomen/ribcage share seam radii
   * and read as one blended body instead of stacked primitives (review).
   * End the profile near radius 0 to close the shape with a rounded cap.
   */
  private lathe(parent: THREE.Object3D, profile: [number, number][], color: number): THREE.Mesh {
    const pts = profile.map(([r, y]) => new THREE.Vector2(Math.max(0.008, r), y));
    const mesh = new THREE.Mesh(new THREE.LatheGeometry(pts, 18), this.material(color));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }

  /**
   * A hanging limb segment with anatomical taper: a ball at the joint, a
   * cylinder thicker at the top than the bottom (thighs, calves, arms all
   * narrow toward their far end — the stakeholder's review point).
   */
  private taperedLimb(
    parent: THREE.Object3D,
    rTop: number,
    rBottom: number,
    length: number,
    color: number,
  ): void {
    this.addMesh(parent, new THREE.SphereGeometry(rTop, 8, 6), color, [0, 0, 0]);
    this.addMesh(
      parent,
      new THREE.CylinderGeometry(rTop, rBottom, length, 9),
      color,
      [0, -length / 2, 0],
    );
    this.addMesh(parent, new THREE.SphereGeometry(rBottom, 7, 5), color, [0, -length, 0]);
  }

  private joint(parent: THREE.Object3D, pos: [number, number, number] = [0, 0, 0]): THREE.Group {
    const j = new THREE.Group();
    j.position.set(pos[0], pos[1], pos[2]);
    parent.add(j);
    return j;
  }

  private build(): void {
    const p = this.appearance;
    const fem = p.sex === 'female';
    const H = p.height;
    const headH = (H / 7.5) * p.headScale;
    const legLen = H * 0.47 * p.limb;
    const torsoH = H * 0.3;
    const upperLeg = legLen * 0.52;
    const lowerLeg = legLen * 0.48;
    // Human arm: wrist ends at crotch height → ~0.31·H from the (raised)
    // shoulder, split 55/45 — a real elbow sits at the waist, not mid-arm.
    const armLen = H * 0.31 * (1 + (p.limb - 1) * 0.4);
    const upperArm = armLen * 0.55;
    const lowerArm = armLen * 0.45;
    const hipY = legLen;

    // Sex-derived proportions on top of the neutral parameters (the neutral
    // values keep old seeds' silhouettes; these reshape, never re-roll).
    // Floor the body width: the slightest seeds still need human hips and
    // limbs, not sticks. (Bulk above the floor differentiates as before.)
    const bodyW = Math.max(p.bulk, 0.3) * (fem ? 0.94 : 1.0);
    // Compressed from the heroic archetype numbers: real shoulders span
    // ~2.5 head-widths; the uncompressed seeds render past 4 (gorilla zone).
    const shoulderW = p.shoulder * (fem ? 0.72 : 0.87);
    const hipW = bodyW * (fem ? 1.12 : 0.86); // male hips clearly inside the shoulders
    const waistW = bodyW * (fem ? 0.68 : 0.82);
    // Shoulder joints sit just below the chest TOP (real ~0.82·H) — round 4
    // found them 15cm low, which lengthened the neck and the apparent arms.
    this.dims = { hipY, torsoH, headH, shoulderW, hipW, bodyW, baseShY: torsoH * 0.4 };

    // --- Torso (review round 2): three lathe-turned volumes — pelvis,
    // abdomen, ribcage — whose seam radii MATCH, flattened front-to-back,
    // with soft masses (abs, pecs/bust, trapezius) laid over them. No
    // stacked-primitive creases, no bare spheres.
    const seamHip = hipW * 0.47; // pelvis top = abdomen bottom
    const seamWaist = waistW * 0.58; // abdomen top = ribcage bottom

    this.pelvis = this.joint(this.root, [0, hipY, 0]);
    // The pelvis DROPS between the thighs (review round 3): a V-profile
    // whose centre descends past the hip joints, so the crotch reads as
    // trousers meeting, not the underside of a ball.
    const pelvisMesh = this.lathe(this.pelvis, [
      [0.008, -torsoH * 0.19],
      [hipW * 0.16, -torsoH * 0.15],
      [hipW * 0.36, -torsoH * 0.05],
      [hipW * 0.5, torsoH * 0.04],
      [hipW * 0.49, torsoH * 0.13],
      [seamHip, torsoH * 0.24],
    ], p.cloth);
    pelvisMesh.scale.z = 0.8;

    this.spine = this.joint(this.pelvis, [0, torsoH * 0.24, 0]);
    const belly = this.lathe(this.spine, [
      [seamHip, 0],
      [waistW * 0.52, torsoH * 0.18],
      [seamWaist, torsoH * 0.35],
    ], p.cloth);
    belly.scale.z = 0.78;
    // Abdominal mass: one soft flattened swell, not carved bands.
    const abs = this.addMesh(this.spine, new THREE.SphereGeometry(waistW * 0.3, 12, 9), p.cloth,
      [0, torsoH * 0.18, this.frontZ() * 0.4]);
    abs.scale.set(1.0, 1.2, 0.3);

    // The torso garment is ONE material (cloth) so the body reads as a
    // single form; metal is reserved for actual armour pieces.
    this.chest = this.joint(this.spine, [0, torsoH * 0.34, 0]);
    // Full width HELD to the (raised) shoulder line, then a SHORT round-over:
    // the chest reaches the deltoids, and the shoulder slope stays small the
    // way a clavicle line does. Female chest band slightly slimmer.
    const bandW = shoulderW * (fem ? 0.92 : 0.98);
    const ribcage = this.lathe(this.chest, [
      [seamWaist, 0],
      [shoulderW * 0.84, torsoH * 0.18],
      [bandW, torsoH * 0.32],
      [bandW * 0.98, torsoH * 0.4],
      [shoulderW * 0.5, torsoH * 0.45],
      [bodyW * 0.17, torsoH * 0.46], // stops BELOW the neck root — the head
      [0.008, torsoH * 0.48],        // must never sit buried in the chest
    ], p.cloth);
    ribcage.scale.z = 0.66;
    // Trapezius: a soft saddle behind the neck, not a slab.
    const traps = this.addMesh(this.chest, new THREE.SphereGeometry(shoulderW * 0.46, 12, 9), p.cloth,
      [0, torsoH * 0.4, -this.frontZ() * 0.24]);
    traps.scale.set(1.45, 0.4, 0.66);
    if (fem) {
      // The sprung chest: geometry on its own group so physics can move it.
      // Sized to be READ at game distance (review round 3), not hinted.
      this.bustGroup = new THREE.Group();
      this.bustBase.set(0, torsoH * 0.26, this.frontZ() * 0.52);
      this.bustGroup.position.copy(this.bustBase);
      this.chest.add(this.bustGroup);
      for (const s of [1, -1]) {
        const b = this.addMesh(this.bustGroup, new THREE.SphereGeometry(bodyW * 0.21, 10, 8), p.cloth,
          [s * bodyW * 0.16, -bodyW * 0.02, 0]); // a slight hang, not bolted-on
        b.scale.set(1.0, 1.0, 0.85);
      }
    } else {
      // Pectorals: proud of the ribcage so the SIDE profile has a chest
      // plane, not a flat slab (cycle B).
      for (const s of [1, -1]) {
        const pec = this.addMesh(this.chest, new THREE.SphereGeometry(bodyW * 0.17, 10, 8), p.cloth,
          [s * bodyW * 0.14, torsoH * 0.28, this.frontZ() * 0.5]);
        pec.scale.set(1.05, 0.72, 0.55);
      }
    }
    // Belt line: hugs the waist seam it sits on — a strap, not a hoop.
    const belt = this.addMesh(this.chest,
      new THREE.CylinderGeometry(seamWaist * 1.04, seamWaist * 1.06, torsoH * 0.06, 18),
      p.accent, [0, torsoH * 0.01, 0]);
    belt.scale.z = 0.7;

    this.neck = this.joint(this.chest, [0, torsoH * 0.38, 0]);
    this.addMesh(this.neck, new THREE.CylinderGeometry(bodyW * 0.13, bodyW * 0.15, headH * 0.24, 8),
      p.skin, [0, headH * 0.1, 0]);

    // Head: a capsule cranium with a hinted jaw — rounder than the old box.
    this.head = this.joint(this.neck, [0, headH * 0.22, 0]);
    this.addMesh(this.head,
      new THREE.CapsuleGeometry(headH * 0.35, headH * 0.14, 4, 10),
      p.skin, [0, headH * 0.42, 0]);
    this.addMesh(this.head, new THREE.BoxGeometry(headH * 0.48, headH * 0.28, headH * 0.38),
      p.skin, [0, headH * 0.2, headH * 0.05]);

    this.arms = {
      L: this.buildArm('L', bodyW, upperArm, lowerArm, torsoH),
      R: this.buildArm('R', bodyW, upperArm, lowerArm, torsoH),
    };
    this.legs = {
      L: this.buildLeg('L', hipW, upperLeg, lowerLeg, fem),
      R: this.buildLeg('R', hipW, upperLeg, lowerLeg, fem),
    };

    // Solid hair (v2): a shaped mass on the head plus physics locks.
    if (p.hairStyle !== 'crop' || p.hairLen > 0.05) {
      this.hair = new SolidHair(p.hairStyle, Math.max(p.hairLen, 0.1), headH, p.hairColor, this.head);
      this.parentOrRoot().add(this.hair.looseGroup);
    }

    // Pose-blend joint registry: order matters, it defines the pose layout.
    this.joints = [
      this.pelvis, this.spine, this.chest, this.neck, this.head,
      this.arms.L.sh, this.arms.L.el, this.arms.L.hand,
      this.arms.R.sh, this.arms.R.el, this.arms.R.hand,
      this.legs.L.hip, this.legs.L.knee, this.legs.L.foot,
      this.legs.R.hip, this.legs.R.knee, this.legs.R.foot,
    ];

    this.setEquipment(this.equipment);
  }

  /** Torso depth helper: how far "forward" the body surface sits. */
  private frontZ(): number {
    return this.dims.bodyW * 0.31;
  }

  private buildArm(side: 'L' | 'R', bodyW: number, upperArm: number, lowerArm: number, torsoH: number): Limb {
    const p = this.appearance;
    const s = side === 'L' ? 1 : -1;
    const sh = this.joint(this.chest, [s * this.dims.shoulderW, this.dims.baseShY, 0]);
    // Deltoid: an egg-shaped mass ON the arm bone, so it rides every arm
    // move and blends the shoulder into the upper arm (review: not a bare
    // sphere hovering at the joint).
    const deltoid = this.addMesh(sh, new THREE.SphereGeometry(bodyW * 0.135, 10, 8), p.cloth,
      [-s * bodyW * 0.05, -bodyW * 0.04, 0]); // buried in the chest edge
    deltoid.scale.set(1.15, 1.2, 0.95);
    // Deltoid → wrist taper; sleeves run to the wrist (bare pale forearms
    // read as gauntlet mitts at distance — cycle B), hands alone are skin.
    this.taperedLimb(sh, bodyW * 0.125, bodyW * 0.1, upperArm, p.cloth);
    const el = this.joint(sh, [0, -upperArm, 0]);
    this.taperedLimb(el, bodyW * 0.105, bodyW * 0.07, lowerArm, p.cloth);
    const hand = this.joint(el, [0, -lowerArm, 0]);
    const palm = this.addMesh(hand, new THREE.SphereGeometry(bodyW * 0.095, 8, 6), p.skin, [0, -bodyW * 0.05, 0]);
    palm.scale.set(0.85, 1.2, 0.65);
    return { sh, el, hand };
  }

  private buildLeg(side: 'L' | 'R', hipW: number, upperLeg: number, lowerLeg: number, fem: boolean): Leg {
    const p = this.appearance;
    const s = side === 'L' ? 1 : -1;
    // Hip joints tucked in so the thighs nearly meet — cycle C found a
    // cowboy gap between the legs.
    const hip = this.joint(this.pelvis, [s * hipW * 0.24, 0, 0]);
    // Thigh: thick at the top, narrowing to the knee (the review's example).
    this.taperedLimb(hip, hipW * (fem ? 0.23 : 0.22), hipW * 0.135, upperLeg, p.cloth);
    const knee = this.joint(hip, [0, -upperLeg, 0]);
    // Calf: a bulge below the knee, tapering hard to the ankle.
    this.taperedLimb(knee, hipW * 0.15, hipW * 0.085, lowerLeg, p.cloth);
    const foot = this.joint(knee, [0, -lowerLeg, 0]);
    // A shaped foot (review: not a rectangle): rounded heel under the ankle
    // and a wedge tapering toward the toes. The 4-sided frustum, spun 45°,
    // gives a flat-soled taper no box can.
    const boot = 0x3a3028; // bright enough to survive the quantiser
    const heel = this.addMesh(foot, new THREE.SphereGeometry(hipW * 0.115, 8, 6), boot,
      [0, -hipW * 0.05, -hipW * 0.02]);
    heel.scale.set(0.95, 0.68, 1.05);
    const toe = this.addMesh(
      foot,
      new THREE.CylinderGeometry(hipW * 0.075, hipW * 0.12, hipW * 0.34, 4, 1)
        .rotateY(Math.PI / 4)
        .rotateX(Math.PI / 2),
      boot,
      [0, -hipW * 0.075, hipW * 0.16],
    );
    toe.scale.y = 0.62;
    return { hip, knee, foot };
  }

  /**
   * Equipment is geometry parented to bones, swappable at runtime (M1
   * requirement). Later milestones drive this from the inventory.
   */
  setEquipment(next: Partial<EquipmentState>): void {
    this.equipment = { ...this.equipment, ...next };
    const p = this.appearance;
    const { headH, torsoH, shoulderW, bodyW } = this.dims;

    if (this.helmGroup) { this.head.remove(this.helmGroup); this.helmGroup = null; }
    if (this.equipment.helm) {
      this.helmGroup = new THREE.Group();
      this.head.add(this.helmGroup);
      const dome = this.addMesh(this.helmGroup,
        new THREE.SphereGeometry(headH * 0.34, 10, 7, 0, Math.PI * 2, 0, Math.PI * 0.62),
        p.metal, [0, headH * 0.5, 0]);
      dome.scale.y = 0.85;
      this.box(this.helmGroup, headH * 0.1, headH * 0.3, headH * 0.7, p.metal, [0, headH * 0.52, 0.01]);
    }

    if (this.pauldronGroup) { this.chest.remove(this.pauldronGroup); this.pauldronGroup = null; }
    if (this.equipment.pauldrons) {
      this.pauldronGroup = new THREE.Group();
      this.chest.add(this.pauldronGroup);
      for (const s of [1, -1]) {
        this.addMesh(this.pauldronGroup, new THREE.SphereGeometry(bodyW * 0.22, 8, 6), p.metal,
          [s * (shoulderW + 0.02), torsoH * 0.32, 0]);
      }
    }

    if (this.weaponGroup) { this.arms.R.hand.remove(this.weaponGroup); this.weaponGroup = null; }
    if (this.equipment.weapon) {
      // Gripped in the fist, blade pointing FORWARD from the character
      // (review point): the group builds blade-down, then rotates -90° about
      // X so "down" becomes "out in front", angled slightly toward the ground.
      this.weaponGroup = new THREE.Group();
      this.arms.R.hand.add(this.weaponGroup);
      this.weaponGroup.position.set(0, -bodyW * 0.05, 0);
      this.weaponGroup.rotation.x = -Math.PI / 2 + 0.35;
      this.box(this.weaponGroup, 0.045, 0.14, 0.045, 0x2a231d, [0, 0.02, 0]);
      this.box(this.weaponGroup, 0.2, 0.035, 0.05, p.metal, [0, -0.06, 0]);
      this.box(this.weaponGroup, 0.055, 0.72, 0.022, 0x74808c, [0, -0.06 - 0.37, 0]);
    }

    if (this.cape) {
      this.parentOrRoot().remove(this.cape.mesh);
      this.cape.dispose();
      this.cape = null;
    }
    if (this.equipment.cape) {
      this.cape = new Cloth(7, 9, shoulderW * 1.9, p.height * 0.46, p.capeColor);
      this.parentOrRoot().add(this.cape.mesh);
    }
  }

  private parentOrRoot(): THREE.Object3D {
    // Cloth/hair vertices live in world space, so they attach to the scene
    // parent rather than the (rotating) character root.
    return this.parent;
  }

  // -------------------------------------------------------------------------
  // Per-frame update
  // -------------------------------------------------------------------------

  setFacing(dir: Direction): void {
    this.targetAngle = FACING_ANGLE[dir];
  }

  setPosition(x: number, z: number): void {
    this.root.position.set(x, 0, z);
  }

  setPosture(posture: Posture): void {
    this.posture = posture;
  }

  /** A deep cowl hides head and hair; build stays readable (D-219). */
  setPresentation(presentation: Presentation): void {
    if (this.presentation === presentation) return;
    this.presentation = presentation;
    const { headH } = this.dims;
    if (this.cowlGroup) {
      this.head.remove(this.cowlGroup);
      this.cowlGroup = null;
    }
    if (presentation === 'hooded') {
      this.cowlGroup = new THREE.Group();
      this.head.add(this.cowlGroup);
      this.box(this.cowlGroup, headH * 0.9, headH * 0.95, headH * 0.85, 0x241f1c, [0, headH * 0.45, -headH * 0.06]);
      this.box(this.cowlGroup, headH * 0.86, headH * 0.4, headH * 0.3, 0x1c1815, [0, headH * 0.2, headH * 0.28]);
    }
    if (this.hair) this.hair.setVisible(presentation !== 'hooded');
  }

  /** Queues one-shot emote animations (D-202 transients). */
  playTransients(names: readonly TransientAnim[]): void {
    for (const name of names) {
      if (this.transientQueue.length < 4) this.transientQueue.push(name);
    }
  }

  update(dt: number, t: number, moving: boolean, wind: number): void {
    // shortest-path turn toward facing
    let diff = this.targetAngle - this.currentAngle;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    this.currentAngle += diff * Math.min(1, dt * 12);
    this.root.rotation.y = this.currentAngle;

    // Transients pre-empt everything except walking; movement cancels them.
    if (moving && (this.currentTransient || this.transientQueue.length > 0)) {
      this.currentTransient = null;
      this.transientQueue.length = 0;
    }
    if (this.currentTransient && t >= this.currentTransient.until) this.currentTransient = null;
    if (!this.currentTransient && this.transientQueue.length > 0) {
      this.currentTransient = {
        name: this.transientQueue.shift()!,
        start: t,
        until: t + CharacterVisual.TRANSIENT_SECONDS,
      };
    }

    // 1) Write the active animation's pose directly to the bones…
    const animKey = moving
      ? 'walk'
      : this.currentTransient
        ? `transient:${this.currentTransient.name}`
        : `posture:${this.posture}`;
    this.resetPose();
    if (moving) this.animWalk(t);
    else if (this.currentTransient) {
      // One-shots play from their OWN start, not from wherever the global
      // clock happens to be mid-wave.
      this.animTransient(this.currentTransient.name, t - this.currentTransient.start);
    } else if (this.posture === 'sitting') this.animSit(t);
    else if (this.posture === 'kneeling') this.animKneel(t);
    else this.animIdle(t);

    // 2) …then cross-fade from the previous animation's last output.
    if (animKey !== this.lastAnimKey && this.lastPose) {
      this.fadeFrom = this.lastPose;
      this.fadeElapsed = 0;
    }
    this.lastAnimKey = animKey;
    if (this.fadeFrom) {
      this.fadeElapsed += dt;
      const raw = Math.min(1, this.fadeElapsed / FADE_SECONDS);
      const alpha = raw * raw * (3 - 2 * raw); // smoothstep ease
      if (raw >= 1) {
        this.fadeFrom = null;
      } else {
        this.blendFromSnapshot(this.fadeFrom, 1 - alpha);
      }
    }
    this.lastPose = this.capturePose(this.lastPose);

    this.root.updateMatrixWorld(true);
    this.stepBust(dt);
    if (this.cape) this.cape.step(dt, wind, t, this.chest.matrixWorld);
    if (this.hair) this.hair.step(dt, wind, t, this.head.matrixWorld);
  }

  /** Pose layout: [rx,ry,rz]×joints + pelvis.y + chest.y + shoulder ys. */
  private capturePose(into: Float32Array | null): Float32Array {
    const n = this.joints.length * 3 + 4;
    const out = into && into.length === n ? into : new Float32Array(n);
    for (let i = 0; i < this.joints.length; i++) {
      const r = this.joints[i]!.rotation;
      out[i * 3] = r.x;
      out[i * 3 + 1] = r.y;
      out[i * 3 + 2] = r.z;
    }
    const pi = this.joints.length * 3;
    out[pi] = this.pelvis.position.y;
    out[pi + 1] = this.chest.position.y;
    out[pi + 2] = this.arms.L.sh.position.y;
    out[pi + 3] = this.arms.R.sh.position.y;
    return out;
  }

  /** Blends the CURRENT bone pose toward a snapshot by `weight` (0..1). */
  private blendFromSnapshot(from: Float32Array, weight: number): void {
    for (let i = 0; i < this.joints.length; i++) {
      const r = this.joints[i]!.rotation;
      r.x += (from[i * 3]! - r.x) * weight;
      r.y += (from[i * 3 + 1]! - r.y) * weight;
      r.z += (from[i * 3 + 2]! - r.z) * weight;
    }
    const pi = this.joints.length * 3;
    this.pelvis.position.y += (from[pi]! - this.pelvis.position.y) * weight;
    this.chest.position.y += (from[pi + 1]! - this.chest.position.y) * weight;
    this.arms.L.sh.position.y += (from[pi + 2]! - this.arms.L.sh.position.y) * weight;
    this.arms.R.sh.position.y += (from[pi + 3]! - this.arms.R.sh.position.y) * weight;
  }

  /** Underdamped spring on the bust group, driven by torso motion: the walk
   * bounce and any posture change produce a visible follow-through wobble. */
  private stepBust(dt: number): void {
    if (!this.bustGroup || dt <= 0) return;
    const world = new THREE.Vector3();
    this.chest.getWorldPosition(world);
    if (this.lastChestWorld) {
      const velY = (world.y - this.lastChestWorld.y) / dt;
      const velXZ = Math.hypot(world.x - this.lastChestWorld.x, world.z - this.lastChestWorld.z) / dt;
      const s = this.bustSpring;
      const stiffness = 90;
      const damping = 8; // underdamped on purpose — it should carry through
      s.vy += (-stiffness * s.y - damping * s.vy - velY * 9) * dt;
      s.y = Math.max(-0.05, Math.min(0.05, s.y + s.vy * dt));
      // Forward-back lag from horizontal acceleration (start/stop of a walk).
      s.vz += (-stiffness * s.z - damping * s.vz - velXZ * 2.5) * dt;
      s.z = Math.max(-0.035, Math.min(0.035, s.z + s.vz * dt));
      this.bustGroup.position.set(
        this.bustBase.x,
        this.bustBase.y + s.y,
        this.bustBase.z + s.z,
      );
    } else {
      this.lastChestWorld = new THREE.Vector3();
    }
    this.lastChestWorld.copy(world);
  }

  private animTransient(name: TransientAnim, t: number): void {
    switch (name) {
      case 'bow': return this.animBow(t);
      case 'wave': return this.animWave(t);
      case 'laugh': return this.animLaugh(t);
      case 'point': return this.animPoint(t);
      case 'shrug': return this.animShrug(t);
    }
  }

  private resetPose(): void {
    for (const o of [this.pelvis, this.spine, this.chest, this.neck, this.head]) {
      o.rotation.set(0, 0, 0);
    }
    this.chest.position.y = this.dims.torsoH * 0.34;
    for (const s of ['L', 'R'] as const) {
      for (const o of [this.arms[s].sh, this.arms[s].el, this.arms[s].hand]) o.rotation.set(0, 0, 0);
      for (const o of [this.legs[s].hip, this.legs[s].knee, this.legs[s].foot]) o.rotation.set(0, 0, 0);
      this.arms[s].sh.position.y = this.dims.baseShY;
    }
    this.pelvis.position.y = this.dims.hipY;
  }

  private animIdle(t: number): void {
    const c = this;
    const breath = Math.sin(t * 1.4 + this.walkPhase) * 0.5 + 0.5;
    const sway = Math.sin(t * 0.4 + this.walkPhase);
    c.spine.rotation.x = 0.02 + breath * 0.02;
    c.chest.rotation.x = -0.02 - breath * 0.015;
    c.head.rotation.y = Math.sin(t * 0.5 + this.walkPhase) * 0.18;
    c.head.rotation.x = Math.sin(t * 0.9) * 0.03;
    c.pelvis.position.y = c.dims.hipY + Math.sin(t * 1.4 + this.walkPhase) * 0.008;
    c.pelvis.rotation.z = sway * 0.02;
    // Weight shifts hips against shoulders — a live stance, not a mannequin.
    c.chest.rotation.z = -sway * 0.015;
    for (const s of ['L', 'R'] as const) {
      const sg = s === 'L' ? 1 : -1;
      c.arms[s].sh.rotation.x = Math.sin(t * 1.4 + sg) * 0.03;
      c.arms[s].sh.rotation.z = sg * (0.05 + Math.sin(t * 1.2) * 0.015); // arms hang close
      c.arms[s].el.rotation.x = -0.18 - Math.sin(t * 1.4) * 0.02;
      c.legs[s].hip.rotation.z = sg * -0.02 + sway * 0.01;
    }
  }

  /*
   * Joint sign convention (learned the hard way — the review's "legs bend
   * incorrectly" was exactly this): the model faces +Z, and for any joint
   * whose child hangs BELOW it, rotation.x > 0 swings the child BACKWARD.
   * So: thighs forward = hip.x NEGATIVE; knees bend (shin back) = knee.x
   * POSITIVE; elbows bend (forearm forward) = elbow.x NEGATIVE.
   */

  private animSit(t: number): void {
    const c = this;
    const br = Math.sin(t * 1.3) * 0.012;
    c.pelvis.position.y = c.dims.hipY * 0.52;
    c.pelvis.rotation.x = -0.06;
    c.spine.rotation.x = 0.1 + br; // a slight forward slump
    c.chest.rotation.x = -0.05;
    c.head.rotation.y = Math.sin(t * 0.4 + this.walkPhase) * 0.22;
    for (const s of ['L', 'R'] as const) {
      const sg = s === 'L' ? 1 : -1;
      c.legs[s].hip.rotation.x = -1.42; // thighs out in FRONT
      c.legs[s].knee.rotation.x = 1.48; // shins drop back down to the floor
      c.legs[s].foot.rotation.x = -0.08;
      c.arms[s].sh.rotation.x = -0.3; // hands rest forward, on the lap
      c.arms[s].sh.rotation.z = sg * 0.14;
      c.arms[s].el.rotation.x = -0.8;
    }
  }

  private animKneel(t: number): void {
    const c = this;
    const br = Math.sin(t * 1.1) * 0.01;
    c.pelvis.position.y = c.dims.hipY * 0.48;
    c.spine.rotation.x = 0.16 + br;
    c.head.rotation.x = 0.1;
    // Left leg planted in front: thigh forward, shin vertical.
    c.legs.L.hip.rotation.x = -1.3;
    c.legs.L.knee.rotation.x = 1.32;
    c.legs.L.foot.rotation.x = -0.1;
    // Right knee down: thigh near vertical, shin folded back along the floor.
    c.legs.R.hip.rotation.x = 0.12;
    c.legs.R.knee.rotation.x = 1.62;
    c.legs.R.foot.rotation.x = 0.8;
    for (const s of ['L', 'R'] as const) {
      const sg = s === 'L' ? 1 : -1;
      c.arms[s].sh.rotation.x = -0.12;
      c.arms[s].sh.rotation.z = sg * 0.16;
      c.arms[s].el.rotation.x = -0.5;
    }
  }

  /** Eases 0→1→0 over the transient duration — every one-shot uses this
   * envelope so it starts and ends at the neutral pose it blends with. */
  private oneShot(t: number): number {
    const u = Math.min(1, Math.max(0, t / CharacterVisual.TRANSIENT_SECONDS));
    return Math.sin(u * Math.PI);
  }

  private animBow(t: number): void {
    const c = this;
    const d = 0.25 + this.oneShot(t) * 0.65;
    c.spine.rotation.x = d * 0.75;
    c.chest.rotation.x = d * 0.35;
    c.head.rotation.x = -d * 0.45;
    c.pelvis.position.y = c.dims.hipY - d * 0.045;
    for (const s of ['L', 'R'] as const) {
      const sg = s === 'L' ? 1 : -1;
      c.arms[s].sh.rotation.x = -d * 0.3;
      c.arms[s].sh.rotation.z = sg * (0.16 + d * 0.22);
      c.arms[s].el.rotation.x = -0.35 - d * 0.5;
      c.legs[s].hip.rotation.x = -d * 0.1; // slight flex, knees the right way
      c.legs[s].knee.rotation.x = d * 0.14;
    }
  }

  private animWave(t: number): void {
    this.animIdle(t * 0.6);
    const c = this;
    // Fast rise, held high (review: the arm was not raised enough) —
    // the hand ends up clearly above the head, waving from the elbow.
    const lift = Math.min(1, this.oneShot(t) * 1.8);
    c.arms.R.sh.rotation.z = -2.55 * lift;
    c.arms.R.sh.rotation.x = -0.1 * lift;
    c.arms.R.el.rotation.x = -0.25 * lift;
    c.arms.R.el.rotation.z = Math.sin(t * 9) * 0.5 * lift;
    c.chest.rotation.y = -0.1 * lift;
    c.head.rotation.y = -0.14 * lift;
  }

  private animLaugh(t: number): void {
    this.animIdle(t);
    const c = this;
    const amp = this.oneShot(t);
    const j = (Math.sin(t * 11) * 0.5 + 0.5) * amp;
    c.spine.rotation.x = (-0.16 - j * 0.1) * amp;
    c.chest.rotation.x = -0.1 * amp;
    c.head.rotation.x = (-0.3 - j * 0.1) * amp;
    c.pelvis.position.y = c.dims.hipY + j * 0.02;
    for (const s of ['L', 'R'] as const) {
      const sg = s === 'L' ? 1 : -1;
      c.arms[s].sh.rotation.z = sg * (0.2 + j * 0.06) * amp;
      c.arms[s].sh.rotation.x = 0.3 * amp;
      c.arms[s].el.rotation.x = -1.15 * amp;
    }
  }

  private animPoint(t: number): void {
    this.animIdle(t * 0.5);
    const c = this;
    const lift = this.oneShot(t);
    c.arms.R.sh.rotation.z = -1.45 * lift;
    c.arms.R.sh.rotation.x = -0.15 * lift;
    c.arms.R.el.rotation.x = -0.05 * lift;
    c.chest.rotation.y = -0.28 * lift;
    c.head.rotation.y = -0.34 * lift;
  }

  private animShrug(t: number): void {
    this.animIdle(t * 0.4);
    const c = this;
    const k = this.oneShot(t);
    for (const s of ['L', 'R'] as const) {
      const sg = s === 'L' ? 1 : -1;
      // The SHOULDERS rise (review point) — the gesture lives there; the
      // forearms just turn palms-up to go with it.
      c.arms[s].sh.position.y = this.dims.baseShY + k * this.dims.bodyW * 0.16;
      c.arms[s].sh.rotation.z = sg * 0.3 * k;
      c.arms[s].el.rotation.x = -0.55 * k;
      c.arms[s].el.rotation.z = sg * 0.55 * k;
    }
    c.chest.position.y = this.dims.torsoH * 0.34 + k * 0.015;
    c.head.rotation.x = k * 0.12;
    c.head.rotation.z = k * 0.06; // a little tilt sells it
  }

  private animWalk(t: number): void {
    const c = this;
    const ph = t * 4.2 + this.walkPhase;
    const stride = Math.sin(ph);
    c.pelvis.position.y = c.dims.hipY + Math.abs(stride) * 0.03 - 0.018;
    c.pelvis.rotation.y = stride * 0.09;
    c.pelvis.rotation.z = stride * 0.04;
    c.spine.rotation.y = -stride * 0.055;
    c.chest.rotation.y = -stride * 0.09;
    c.chest.rotation.x = 0.055;
    c.head.rotation.y = stride * 0.045;
    // Counter-rotation keeps the head level while hips roll.
    c.head.rotation.z = -stride * 0.02;
    for (const s of ['L', 'R'] as const) {
      const o = s === 'L' ? 0 : Math.PI;
      const sg = s === 'L' ? 1 : -1;
      const swing = Math.sin(ph + o); // > 0: this leg strides FORWARD
      // The knee bends most just after the foot leaves the ground at the
      // rear and straightens for heel-strike at the front, with a smooth
      // raised-cosine hump (a clipped max() snaps at footfall).
      const lift = Math.pow(Math.max(0, Math.sin(ph + o + 2.17)), 1.6);
      c.legs[s].hip.rotation.x = -swing * 0.55 + lift * 0.25;
      c.legs[s].knee.rotation.x = lift * 1.05 + 0.06; // shin BACK — a knee, not a bird leg
      // Feet stay roughly level with the ground through the stride.
      c.legs[s].foot.rotation.x = -(c.legs[s].hip.rotation.x + c.legs[s].knee.rotation.x) * 0.55;
      c.arms[s].sh.rotation.x = swing * 0.45; // opposite arm to leg
      c.arms[s].sh.rotation.z = sg * 0.11;
      c.arms[s].el.rotation.x = -0.25 - Math.max(0, swing) * 0.3;
    }
  }

  dispose(): void {
    this.parent.remove(this.root);
    if (this.cape) {
      this.parent.remove(this.cape.mesh);
      this.cape.dispose();
    }
    if (this.hair) {
      this.parent.remove(this.hair.looseGroup);
      this.hair.dispose();
    }
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
  }
}
