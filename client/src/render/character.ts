import * as THREE from 'three';
import {
  generateAppearance,
  type Appearance,
  type Direction,
  type Posture,
  type Presentation,
  type TransientAnim,
} from '@rc/shared';
import { Cloth, HairSet } from './cloth';

/**
 * A character built entirely from rules at runtime (D-401/402): a "bone" is a
 * THREE.Group, geometry hangs off it, equipment is more geometry parented to
 * the same bones — which is why the sprite-sheet combinatorial explosion
 * never happens. Animation is a function of time (each emote ~8 lines).
 * Geometry is deliberately primitive; at ~80px character height the
 * pixelation is the error budget (D-401), though production forms still owe
 * a pass of chamfering and more parts per limb (D-406).
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
  private dims!: { hipY: number; torsoH: number; headH: number };

  private helmGroup: THREE.Group | null = null;
  private pauldronGroup: THREE.Group | null = null;
  private weaponGroup: THREE.Group | null = null;
  private cowlGroup: THREE.Group | null = null;
  private cape: Cloth | null = null;
  private hair: HairSet | null = null;
  presentation: Presentation = 'normal';

  private targetAngle = 0;
  private currentAngle = 0;
  private walkPhase: number;
  posture: Posture = 'standing';
  private transientQueue: TransientAnim[] = [];
  private currentTransient: { name: TransientAnim; until: number } | null = null;

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

  private box(
    parent: THREE.Object3D,
    w: number,
    h: number,
    d: number,
    color: number,
    pos: [number, number, number] = [0, 0, 0],
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshLambertMaterial({ color }),
    );
    mesh.position.set(pos[0], pos[1], pos[2]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }

  private joint(parent: THREE.Object3D, pos: [number, number, number] = [0, 0, 0]): THREE.Group {
    const j = new THREE.Group();
    j.position.set(pos[0], pos[1], pos[2]);
    parent.add(j);
    return j;
  }

  private build(): void {
    const p = this.appearance;
    const H = p.height;
    const headH = (H / 7.5) * p.headScale; // 7.5-head figure, not chibi
    const legLen = H * 0.47 * p.limb;
    const torsoH = H * 0.3;
    const upperLeg = legLen * 0.52;
    const lowerLeg = legLen * 0.48;
    const armLen = H * 0.4 * p.limb;
    const upperArm = armLen * 0.5;
    const lowerArm = armLen * 0.5;
    const hipY = legLen;
    this.dims = { hipY, torsoH, headH };
    const bodyW = p.bulk;
    const bodyD = p.bulk * 0.62;

    this.pelvis = this.joint(this.root, [0, hipY, 0]);
    this.box(this.pelvis, bodyW * 0.95, torsoH * 0.3, bodyD, p.cloth, [0, torsoH * 0.1, 0]);

    this.spine = this.joint(this.pelvis, [0, torsoH * 0.24, 0]);
    this.box(this.spine, bodyW * 0.88, torsoH * 0.34, bodyD * 0.92, p.cloth, [0, torsoH * 0.16, 0]);

    this.chest = this.joint(this.spine, [0, torsoH * 0.34, 0]);
    this.box(this.chest, p.shoulder * 2, torsoH * 0.4, bodyD, p.metal, [0, torsoH * 0.18, 0]);
    this.box(this.chest, p.shoulder * 2.05, torsoH * 0.08, bodyD * 1.04, p.accent, [0, torsoH * 0.1, 0]);

    this.neck = this.joint(this.chest, [0, torsoH * 0.38, 0]);
    this.box(this.neck, bodyW * 0.3, headH * 0.22, bodyD * 0.45, p.skin, [0, headH * 0.11, 0]);

    this.head = this.joint(this.neck, [0, headH * 0.22, 0]);
    this.box(this.head, headH * 0.68, headH * 0.78, headH * 0.66, p.skin, [0, headH * 0.39, 0]);

    this.arms = { L: this.buildArm('L', bodyW, upperArm, lowerArm, torsoH), R: this.buildArm('R', bodyW, upperArm, lowerArm, torsoH) };
    this.legs = { L: this.buildLeg('L', bodyW, upperLeg, lowerLeg), R: this.buildLeg('R', bodyW, upperLeg, lowerLeg) };

    if (p.hairLen > 0.08) {
      this.hair = new HairSet(p.hairLen, headH);
      this.parentOrRoot().add(this.hair.group);
    }
    this.setEquipment(this.equipment);
  }

  private buildArm(side: 'L' | 'R', bodyW: number, upperArm: number, lowerArm: number, torsoH: number): Limb {
    const p = this.appearance;
    const s = side === 'L' ? 1 : -1;
    const sh = this.joint(this.chest, [s * p.shoulder, torsoH * 0.32, 0]);
    this.box(sh, bodyW * 0.26, upperArm, bodyW * 0.26, p.cloth, [0, -upperArm / 2, 0]);
    const el = this.joint(sh, [0, -upperArm, 0]);
    this.box(el, bodyW * 0.23, lowerArm, bodyW * 0.23, p.skin, [0, -lowerArm / 2, 0]);
    const hand = this.joint(el, [0, -lowerArm, 0]);
    this.box(hand, bodyW * 0.24, bodyW * 0.22, bodyW * 0.24, p.skin, [0, -bodyW * 0.1, 0]);
    return { sh, el, hand };
  }

  private buildLeg(side: 'L' | 'R', bodyW: number, upperLeg: number, lowerLeg: number): Leg {
    const p = this.appearance;
    const s = side === 'L' ? 1 : -1;
    const hip = this.joint(this.pelvis, [s * bodyW * 0.26, 0, 0]);
    this.box(hip, bodyW * 0.3, upperLeg, bodyW * 0.3, p.cloth, [0, -upperLeg / 2, 0]);
    const knee = this.joint(hip, [0, -upperLeg, 0]);
    this.box(knee, bodyW * 0.27, lowerLeg, bodyW * 0.27, p.cloth, [0, -lowerLeg / 2, 0]);
    const foot = this.joint(knee, [0, -lowerLeg, 0]);
    this.box(foot, bodyW * 0.3, bodyW * 0.16, bodyW * 0.52, 0x241e19, [0, -bodyW * 0.06, bodyW * 0.1]);
    return { hip, knee, foot };
  }

  /**
   * Equipment is geometry parented to bones, swappable at runtime (M1
   * requirement). Later milestones drive this from the inventory.
   */
  setEquipment(next: Partial<EquipmentState>): void {
    this.equipment = { ...this.equipment, ...next };
    const p = this.appearance;
    const { headH, torsoH } = this.dims;
    const bodyW = p.bulk;

    if (this.helmGroup) { this.head.remove(this.helmGroup); this.helmGroup = null; }
    if (this.equipment.helm) {
      this.helmGroup = new THREE.Group();
      this.head.add(this.helmGroup);
      this.box(this.helmGroup, headH * 0.76, headH * 0.44, headH * 0.74, p.metal, [0, headH * 0.6, 0]);
      this.box(this.helmGroup, headH * 0.14, headH * 0.34, headH * 0.8, p.metal, [0, headH * 0.42, 0.01]);
    }

    if (this.pauldronGroup) { this.chest.remove(this.pauldronGroup); this.pauldronGroup = null; }
    if (this.equipment.pauldrons) {
      this.pauldronGroup = new THREE.Group();
      this.chest.add(this.pauldronGroup);
      for (const s of [1, -1]) {
        this.box(this.pauldronGroup, bodyW * 0.42, bodyW * 0.3, bodyW * 0.46, p.metal,
          [s * p.shoulder + s * 0.02, torsoH * 0.33, 0]);
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
      this.cape = new Cloth(7, 9, p.shoulder * 1.9, p.height * 0.46, p.capeColor);
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
    if (this.hair) this.hair.group.visible = presentation !== 'hooded';
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
        until: t + CharacterVisual.TRANSIENT_SECONDS,
      };
    }

    this.resetPose();
    if (moving) this.animWalk(t);
    else if (this.currentTransient) this.animTransient(this.currentTransient.name, t);
    else if (this.posture === 'sitting') this.animSit(t);
    else if (this.posture === 'kneeling') this.animKneel(t);
    else this.animIdle(t);

    this.root.updateMatrixWorld(true);
    if (this.cape) this.cape.step(dt, wind, t, this.chest.matrixWorld);
    if (this.hair) this.hair.step(dt, wind, t, this.head.matrixWorld);
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
    const b = Math.sin(t * 1.4 + this.walkPhase) * 0.5 + 0.5;
    c.spine.rotation.x = 0.02 + b * 0.02;
    c.chest.rotation.x = -0.02 - b * 0.015;
    c.head.rotation.y = Math.sin(t * 0.5 + this.walkPhase) * 0.18;
    c.head.rotation.x = Math.sin(t * 0.9) * 0.03;
    c.pelvis.position.y = c.dims.hipY + Math.sin(t * 1.4 + this.walkPhase) * 0.008;
    c.pelvis.rotation.z = Math.sin(t * 0.4) * 0.02;
    for (const s of ['L', 'R'] as const) {
      const sg = s === 'L' ? 1 : -1;
      c.arms[s].sh.rotation.x = Math.sin(t * 1.4 + sg) * 0.03;
      c.arms[s].sh.rotation.z = sg * (0.1 + Math.sin(t * 1.2) * 0.015);
      c.arms[s].el.rotation.x = -0.18 - Math.sin(t * 1.4) * 0.02;
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

  private animBow(t: number): void {
    const c = this;
    const k = Math.sin(t * 1.6) * 0.5 + 0.5;
    const d = 0.35 + k * 0.55;
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
    c.arms.R.sh.rotation.z = -2.0;
    c.arms.R.sh.rotation.x = -0.25;
    c.arms.R.el.rotation.x = -0.5;
    c.arms.R.el.rotation.z = Math.sin(t * 7) * 0.45;
    c.chest.rotation.y = -0.12;
    c.head.rotation.y = -0.15;
  }

  private animLaugh(t: number): void {
    this.animIdle(t);
    const c = this;
    const j = Math.sin(t * 11) * 0.5 + 0.5;
    c.spine.rotation.x = -0.16 - j * 0.1;
    c.chest.rotation.x = -0.1;
    c.head.rotation.x = -0.3 - j * 0.1;
    c.pelvis.position.y = c.dims.hipY + j * 0.02;
    for (const s of ['L', 'R'] as const) {
      const sg = s === 'L' ? 1 : -1;
      c.arms[s].sh.rotation.z = sg * (0.2 + j * 0.06);
      c.arms[s].sh.rotation.x = 0.3;
      c.arms[s].el.rotation.x = -1.15;
    }
  }

  private animPoint(t: number): void {
    this.animIdle(t * 0.5);
    const c = this;
    const s = Math.sin(t * 2) * 0.04;
    c.arms.R.sh.rotation.z = -1.45 + s;
    c.arms.R.sh.rotation.x = -0.15;
    c.arms.R.el.rotation.x = -0.05;
    c.chest.rotation.y = -0.28;
    c.head.rotation.y = -0.34;
  }

  private animShrug(t: number): void {
    this.animIdle(t * 0.4);
    const c = this;
    const k = Math.sin(t * 1.8) * 0.5 + 0.5;
    for (const s of ['L', 'R'] as const) {
      const sg = s === 'L' ? 1 : -1;
      c.arms[s].sh.rotation.z = sg * (0.55 + k * 0.45);
      c.arms[s].sh.rotation.x = 0.2;
      c.arms[s].el.rotation.x = -1.25 - k * 0.25;
      c.arms[s].el.rotation.z = sg * 0.45;
    }
    c.chest.position.y = this.dims.torsoH * 0.34 + k * 0.02;
    c.head.rotation.x = k * 0.1;
  }

  private animWalk(t: number): void {
    const c = this;
    const ph = t * 4.2 + this.walkPhase;
    c.pelvis.position.y = c.dims.hipY + Math.abs(Math.sin(ph)) * 0.035 - 0.02;
    c.pelvis.rotation.y = Math.sin(ph) * 0.1;
    c.pelvis.rotation.z = Math.sin(ph) * 0.045;
    c.spine.rotation.y = -Math.sin(ph) * 0.06;
    c.chest.rotation.y = -Math.sin(ph) * 0.1;
    c.chest.rotation.x = 0.06;
    c.head.rotation.y = Math.sin(ph) * 0.05;
    for (const s of ['L', 'R'] as const) {
      const o = s === 'L' ? 0 : Math.PI;
      const sg = s === 'L' ? 1 : -1;
      const swing = Math.sin(ph + o);
      c.legs[s].hip.rotation.x = swing * 0.62;
      c.legs[s].knee.rotation.x = -Math.max(0, Math.sin(ph + o + 1.1)) * 0.95 - 0.05;
      c.legs[s].foot.rotation.x = -swing * 0.22 + 0.1;
      c.arms[s].sh.rotation.x = -swing * 0.55;
      c.arms[s].sh.rotation.z = sg * 0.11;
      c.arms[s].el.rotation.x = -0.3 - Math.max(0, -swing) * 0.35;
    }
  }

  dispose(): void {
    this.parent.remove(this.root);
    if (this.cape) {
      this.parent.remove(this.cape.mesh);
      this.cape.dispose();
    }
    if (this.hair) {
      this.parent.remove(this.hair.group);
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
