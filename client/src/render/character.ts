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
  private dims!: { hipY: number; torsoH: number; headH: number; shoulderW: number; hipW: number; bodyW: number };

  private helmGroup: THREE.Group | null = null;
  private pauldronGroup: THREE.Group | null = null;
  private weaponGroup: THREE.Group | null = null;
  private cowlGroup: THREE.Group | null = null;
  private cape: Cloth | null = null;
  private hair: SolidHair | null = null;
  presentation: Presentation = 'normal';

  /** Sprung chest (female build): a critically-damped vertical offset driven
   * by the torso's motion. Small and clamped — secondary motion, not a gag. */
  private bustGroup: THREE.Group | null = null;
  private bustSpring = { y: 0, v: 0 };
  private lastChestWorldY: number | null = null;

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

  /** A vertical capsule whose TOP sits at the parent origin — limbs hang. */
  private capsuleDown(parent: THREE.Object3D, radius: number, length: number, color: number): THREE.Mesh {
    const geom = new THREE.CapsuleGeometry(radius, Math.max(0.01, length - radius * 2), 3, 8);
    return this.addMesh(parent, geom, color, [0, -length / 2, 0]);
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
    const armLen = H * 0.4 * p.limb;
    const upperArm = armLen * 0.5;
    const lowerArm = armLen * 0.5;
    const hipY = legLen;

    // Sex-derived proportions on top of the neutral parameters (the neutral
    // values keep old seeds' silhouettes; these reshape, never re-roll).
    const bodyW = p.bulk * (fem ? 0.94 : 1.0);
    const shoulderW = p.shoulder * (fem ? 0.84 : 1.02);
    const hipW = bodyW * (fem ? 1.16 : 0.94);
    const waistW = bodyW * (fem ? 0.68 : 0.82);
    this.dims = { hipY, torsoH, headH, shoulderW, hipW, bodyW };

    // Pelvis: a rounded block the width of the hips.
    this.pelvis = this.joint(this.root, [0, hipY, 0]);
    this.addMesh(
      this.pelvis,
      new THREE.CapsuleGeometry(hipW * 0.5, torsoH * 0.1, 3, 10).rotateZ(Math.PI / 2),
      p.cloth,
      [0, torsoH * 0.08, 0],
    );

    // Waist: visibly narrower — the box figure's biggest tell.
    this.spine = this.joint(this.pelvis, [0, torsoH * 0.24, 0]);
    this.addMesh(
      this.spine,
      new THREE.CylinderGeometry(waistW * 0.5, hipW * 0.46, torsoH * 0.34, 10),
      p.cloth,
      [0, torsoH * 0.14, 0],
    );

    // Chest: broader at the shoulders, tapering down to the waist.
    this.chest = this.joint(this.spine, [0, torsoH * 0.34, 0]);
    this.addMesh(
      this.chest,
      new THREE.CylinderGeometry(shoulderW * 0.92, waistW * 0.56, torsoH * 0.42, 10),
      p.metal,
      [0, torsoH * 0.18, 0],
    );
    // Shoulder caps — garment, not armour: cloth-coloured and tucked in, or
    // they read as a puffy collar next to the (metal) pauldrons.
    for (const s of [1, -1]) {
      this.addMesh(this.chest, new THREE.SphereGeometry(bodyW * 0.125, 8, 6), p.cloth,
        [s * shoulderW * 0.96, torsoH * 0.3, 0]);
    }
    // Belt line.
    this.addMesh(this.chest, new THREE.CylinderGeometry(waistW * 0.6, waistW * 0.6, torsoH * 0.07, 10),
      p.accent, [0, -torsoH * 0.02, 0]);

    if (fem) {
      // The sprung chest: geometry on its own group so physics can move it.
      this.bustGroup = new THREE.Group();
      this.bustGroup.position.set(0, torsoH * 0.22, this.frontZ() * 0.62);
      this.chest.add(this.bustGroup);
      for (const s of [1, -1]) {
        this.addMesh(this.bustGroup, new THREE.SphereGeometry(bodyW * 0.155, 8, 6), p.metal,
          [s * bodyW * 0.16, 0, 0]);
      }
    }

    this.neck = this.joint(this.chest, [0, torsoH * 0.38, 0]);
    this.addMesh(this.neck, new THREE.CylinderGeometry(bodyW * 0.13, bodyW * 0.15, headH * 0.24, 8),
      p.skin, [0, headH * 0.1, 0]);

    // Head: a capsule cranium with a hinted jaw — rounder than the old box.
    this.head = this.joint(this.neck, [0, headH * 0.22, 0]);
    this.addMesh(this.head,
      new THREE.CapsuleGeometry(headH * 0.33, headH * 0.16, 4, 10),
      p.skin, [0, headH * 0.42, 0]);
    this.addMesh(this.head, new THREE.BoxGeometry(headH * 0.46, headH * 0.26, headH * 0.36),
      p.skin, [0, headH * 0.2, headH * 0.06]);

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
    const sh = this.joint(this.chest, [s * this.dims.shoulderW, torsoH * 0.3, 0]);
    this.capsuleDown(sh, bodyW * 0.135, upperArm, p.cloth);
    const el = this.joint(sh, [0, -upperArm, 0]);
    this.capsuleDown(el, bodyW * 0.115, lowerArm, p.skin);
    const hand = this.joint(el, [0, -lowerArm, 0]);
    this.addMesh(hand, new THREE.SphereGeometry(bodyW * 0.12, 6, 5), p.skin, [0, -bodyW * 0.06, 0]);
    return { sh, el, hand };
  }

  private buildLeg(side: 'L' | 'R', hipW: number, upperLeg: number, lowerLeg: number, fem: boolean): Leg {
    const p = this.appearance;
    const s = side === 'L' ? 1 : -1;
    const hip = this.joint(this.pelvis, [s * hipW * 0.28, 0, 0]);
    this.capsuleDown(hip, hipW * (fem ? 0.2 : 0.19), upperLeg, p.cloth);
    const knee = this.joint(hip, [0, -upperLeg, 0]);
    this.capsuleDown(knee, hipW * 0.15, lowerLeg, p.cloth);
    const foot = this.joint(knee, [0, -lowerLeg, 0]);
    this.box(foot, hipW * 0.24, hipW * 0.13, hipW * 0.44, 0x241e19, [0, -hipW * 0.05, hipW * 0.09]);
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
      this.weaponGroup = new THREE.Group();
      this.arms.R.hand.add(this.weaponGroup);
      this.box(this.weaponGroup, 0.045, 0.11, 0.045, 0x2a231d, [0, -bodyW * 0.28, 0]);
      this.box(this.weaponGroup, 0.2, 0.035, 0.05, p.metal, [0, -bodyW * 0.34, 0]);
      this.box(this.weaponGroup, 0.055, 0.78, 0.022, 0x74808c, [0, -bodyW * 0.34 - 0.4, 0]);
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

  /** Pose layout: [rx,ry,rz]×joints + pelvis.y + chest.y. */
  private capturePose(into: Float32Array | null): Float32Array {
    const n = this.joints.length * 3 + 2;
    const out = into && into.length === n ? into : new Float32Array(n);
    for (let i = 0; i < this.joints.length; i++) {
      const r = this.joints[i]!.rotation;
      out[i * 3] = r.x;
      out[i * 3 + 1] = r.y;
      out[i * 3 + 2] = r.z;
    }
    out[this.joints.length * 3] = this.pelvis.position.y;
    out[this.joints.length * 3 + 1] = this.chest.position.y;
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
  }

  /** Critically-damped spring on the bust group, driven by torso motion. */
  private stepBust(dt: number): void {
    if (!this.bustGroup) return;
    const world = new THREE.Vector3();
    this.chest.getWorldPosition(world);
    if (this.lastChestWorldY !== null && dt > 0) {
      const chestVel = (world.y - this.lastChestWorldY) / dt;
      const s = this.bustSpring;
      const stiffness = 160;
      const damping = 18;
      s.v += (-stiffness * s.y - damping * s.v - chestVel * 4) * dt;
      s.y += s.v * dt;
      s.y = Math.max(-0.028, Math.min(0.028, s.y));
      this.bustGroup.position.y = this.dims.torsoH * 0.22 + s.y;
    }
    this.lastChestWorldY = world.y;
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
      c.arms[s].sh.rotation.z = sg * (0.1 + Math.sin(t * 1.2) * 0.015);
      c.arms[s].el.rotation.x = -0.18 - Math.sin(t * 1.4) * 0.02;
      c.legs[s].hip.rotation.z = sg * -0.02 + sway * 0.01;
    }
  }

  private animSit(t: number): void {
    const c = this;
    const br = Math.sin(t * 1.3) * 0.012;
    c.pelvis.position.y = c.dims.hipY * 0.52;
    c.pelvis.rotation.x = 0.06;
    c.spine.rotation.x = 0.1 + br;
    c.chest.rotation.x = -0.05;
    c.head.rotation.y = Math.sin(t * 0.4 + this.walkPhase) * 0.22;
    for (const s of ['L', 'R'] as const) {
      const sg = s === 'L' ? 1 : -1;
      c.legs[s].hip.rotation.x = 1.42;
      c.legs[s].knee.rotation.x = -1.5;
      c.legs[s].foot.rotation.x = 0.16;
      c.arms[s].sh.rotation.x = 0.34;
      c.arms[s].sh.rotation.z = sg * 0.2;
      c.arms[s].el.rotation.x = -0.85;
    }
  }

  private animKneel(t: number): void {
    const c = this;
    const br = Math.sin(t * 1.1) * 0.01;
    c.pelvis.position.y = c.dims.hipY * 0.48;
    c.spine.rotation.x = 0.18 + br;
    c.head.rotation.x = 0.1;
    c.legs.L.hip.rotation.x = 1.35;
    c.legs.L.knee.rotation.x = -1.55;
    c.legs.L.foot.rotation.x = 0.3;
    c.legs.R.hip.rotation.x = -0.15;
    c.legs.R.knee.rotation.x = -1.75;
    c.legs.R.foot.rotation.x = 0.9;
    for (const s of ['L', 'R'] as const) {
      const sg = s === 'L' ? 1 : -1;
      c.arms[s].sh.rotation.x = 0.15;
      c.arms[s].sh.rotation.z = sg * 0.16;
      c.arms[s].el.rotation.x = -0.55;
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
      c.legs[s].hip.rotation.x = -d * 0.12;
      c.legs[s].knee.rotation.x = -d * 0.1;
    }
  }

  private animWave(t: number): void {
    this.animIdle(t * 0.6);
    const c = this;
    const lift = this.oneShot(t);
    c.arms.R.sh.rotation.z = -2.0 * lift;
    c.arms.R.sh.rotation.x = -0.25 * lift;
    c.arms.R.el.rotation.x = -0.5 * lift;
    c.arms.R.el.rotation.z = Math.sin(t * 9) * 0.45 * lift;
    c.chest.rotation.y = -0.12 * lift;
    c.head.rotation.y = -0.15 * lift;
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
      c.arms[s].sh.rotation.z = sg * (0.55 + k * 0.45) * k;
      c.arms[s].sh.rotation.x = 0.2 * k;
      c.arms[s].el.rotation.x = (-1.25 - k * 0.25) * k;
      c.arms[s].el.rotation.z = sg * 0.45 * k;
    }
    c.chest.position.y = this.dims.torsoH * 0.34 + k * 0.02;
    c.head.rotation.x = k * 0.1;
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
      const swing = Math.sin(ph + o);
      // Knee bend is a smooth raised-cosine hump, not a clipped max() — the
      // old version's visible snap at footfall came from that clipping.
      const lift = Math.pow(Math.max(0, Math.sin(ph + o + 1.05)), 1.6);
      c.legs[s].hip.rotation.x = swing * 0.6;
      c.legs[s].knee.rotation.x = -lift * 0.95 - 0.06;
      c.legs[s].foot.rotation.x = -swing * 0.18 + lift * 0.12 + 0.06;
      c.arms[s].sh.rotation.x = -swing * 0.5;
      c.arms[s].sh.rotation.z = sg * 0.11;
      c.arms[s].el.rotation.x = -0.28 - Math.max(0, -swing) * 0.3;
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
