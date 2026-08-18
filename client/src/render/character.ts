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
import { Ragdoll } from './ragdoll';
import { toonMaterial } from './toon';

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
  /** What the weapon hand holds when `weapon` is true. */
  weaponKind: 'sword' | 'staff';
  cape: boolean;
  /** Full-length robe: skirt to the ankles, overtunic, rope belt. */
  robe: boolean;
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
    hipY: number; torsoH: number; headH: number; capeAnchorY: number;
    shoulderW: number; hipW: number; bodyW: number;
    /** Shoulder joints' rest height — the shrug raises them from here. */
    baseShY: number;
    /** Limb segment lengths — the robe's cloth colliders need them. */
    upperLeg: number; lowerLeg: number; lowerArm: number;
  };

  /** Cape pin point: the UPPER BACK. The chest bone's origin is the waist
   * seam, and pinning there was the review's cape-from-the-waist bug. */
  private capeAnchor: THREE.Group | null = null;
  private helmGroup: THREE.Group | null = null;
  private pauldronMeshes: THREE.Mesh[] = [];
  private weaponGroup: THREE.Group | null = null;
  private cowlGroup: THREE.Group | null = null;
  /** The hood's shoulder mantle lives on the chest, not the head. */
  private mantleGroup: THREE.Group | null = null;
  /** Physics flaps hanging from the hood's front rim (stakeholder). */
  private hoodFlaps: { cloth: Cloth; anchor: THREE.Group; side: 'L' | 'R' }[] = [];
  /** Robe meshes, parented across several bones — tracked for teardown. */
  private robeParts: THREE.Mesh[] = [];
  /** The robe's PHYSICS pieces: the skirt tube and two sleeve cuffs. */
  private robeSkirt: Cloth | null = null;
  private robeSleeves: { cloth: Cloth; side: 'L' | 'R' }[] = [];
  private cape: Cloth | null = null;
  private capeTie: THREE.Mesh | null = null;
  private hair: SolidHair | null = null;
  presentation: Presentation = 'normal';

  /** Sprung chest (female build): a damped spring in the chest's local
   * frame, driven by torso motion — visible bounce, clamped to stay decent. */
  private bustGroup: THREE.Group | null = null;
  private bustBase = new THREE.Vector3();
  private bustSpring = { y: 0, vy: 0, z: 0, vz: 0 };
  private lastChestWorld: THREE.Vector3 | null = null;

  /** Grip-to-ground length of the held staff (0 = no staff). */
  private staffBelow = 0;

  /**
   * Weapon carry (stakeholder, 2026-08-18). Out of combat a weapon rides on
   * the back (sword/staff) or hip (short blades); entering combat draws it.
   * The weapon hangs off the ROOT and its transform is interpolated between
   * two anchors each frame, so the draw is one continuous motion rather
   * than a reparenting pop.
   */
  private handAnchor: THREE.Group | null = null;
  private backAnchor: THREE.Group | null = null;
  /** 0 = stowed, 1 = in the hand. Eased toward the combat state. */
  private drawT = 0;
  private inCombat = false;
  private mRootInv = new THREE.Matrix4();
  private mA = new THREE.Matrix4();
  private mB = new THREE.Matrix4();
  private pA = new THREE.Vector3();
  private pB = new THREE.Vector3();
  private qA = new THREE.Quaternion();
  private qB = new THREE.Quaternion();
  private sTmp = new THREE.Vector3();
  /** In-flight attack swing, if any. */
  private attackAnim: { variant: number; start: number; until: number } | null = null;
  /** When this character died, for the collapse; null while living. */
  private deathStart: number | null = null;
  /** The simulated body, once this character is falling or down. */
  private ragdoll: Ragdoll | null = null;
  /** Ground height captured when the fall began. */
  private deathGroundY = 0;
  /** True once the collapse has finished (or for a corpse spawned dead). */
  private dead = false;
  private static UP_AXIS = new THREE.Vector3(0, 1, 0);
  private tmpQ = new THREE.Quaternion();
  private tmpQ2 = new THREE.Quaternion();
  private tmpV = new THREE.Vector3();
  private tmpV2 = new THREE.Vector3();

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

  /** Pass a seed for the deterministic D-402 look, or a full Appearance
   * to drive every parameter explicitly (the character creator does). */
  constructor(seed: number | Appearance, private parent: THREE.Object3D) {
    this.appearance = typeof seed === 'number' ? generateAppearance(seed) : seed;
    this.walkPhase = (this.appearance.seed % 628) / 100;
    this.equipment = {
      helm: this.appearance.helm,
      pauldrons: this.appearance.pauldrons,
      weapon: this.appearance.weapon,
      weaponKind: 'sword',
      cape: this.appearance.hasCape,
      robe: false,
    };
    this.build();
    parent.add(this.root);
  }

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  private material(color: number): THREE.Material {
    // Banded toon shading: intersection creases between overlapping
    // primitives land in the same shade band and vanish (see toon.ts).
    return toonMaterial(color);
  }

  /** Editor part-naming: meshes built after nm('x') are named 'x' — the
   * viewer's model editor shows these instead of raw geometry types. */
  private partName = 'part';
  private nm(name: string): void {
    this.partName = name;
  }

  private addMesh(parent: THREE.Object3D, geom: THREE.BufferGeometry, color: number,
    pos: [number, number, number] = [0, 0, 0]): THREE.Mesh {
    const mesh = new THREE.Mesh(geom, this.material(color));
    mesh.name = this.partName;
    mesh.position.set(pos[0], pos[1], pos[2]);
    mesh.castShadow = true;
    // No receiveShadow: primitive-on-primitive self-shadows draw hard lines
    // along every overlap — the other half of the visible-seams problem.
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
  private lathe(
    parent: THREE.Object3D,
    profile: [number, number][],
    color: number,
    /** Cloth folds: subtle vertical ridges, strongest toward the hem. */
    folds?: { count: number; amp: number },
  ): THREE.Mesh {
    const pts = profile.map(([r, y]) => new THREE.Vector2(Math.max(0.008, r), y));
    const geom = new THREE.LatheGeometry(pts, folds ? 28 : 18);
    if (folds) {
      const pos = geom.attributes.position!;
      const ys = profile.map(([, y]) => y);
      const yMin = Math.min(...ys);
      const yMax = Math.max(...ys);
      const phase = (this.appearance.seed % 7) * 0.9;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const y = pos.getY(i);
        const z = pos.getZ(i);
        const r = Math.hypot(x, z);
        if (r < 0.02) continue; // leave the caps alone
        const angle = Math.atan2(z, x);
        const hem = 1 - (y - yMin) / Math.max(1e-6, yMax - yMin); // 1 at bottom
        const ripple = 1 + Math.sin(angle * folds.count + phase) * folds.amp * (0.35 + 0.65 * hem);
        pos.setX(i, x * ripple);
        pos.setZ(i, z * ripple);
      }
      geom.computeVertexNormals();
    }
    const mesh = new THREE.Mesh(geom, this.material(color));
    mesh.name = this.partName;
    mesh.castShadow = true;
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

  /**
   * Bust geometry from the appearance (female builds): radius and lateral
   * offset. Volume tracks body width only up to a cap — unclamped, the
   * brute preset's chest came out ~50% oversized (stakeholder ruling,
   * 2026-08-17). At bust 0.5 on a mid build this reproduces the tuned
   * fixed size exactly (model editor, seed 1005).
   */
  private bustDims(): { r: number; x: number } {
    const bust = this.appearance.bust ?? 0.5;
    const bodyW = this.dims.bodyW;
    const w = Math.min(bodyW, 0.38) + Math.max(0, bodyW - 0.38) * 0.15;
    return { r: w * (0.13 + 0.16 * bust), x: bodyW * (0.12 + 0.08 * bust) };
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
    // Feet stand ON the ground: the ankle joint sits a foot's height above
    // it (stakeholder: the model sat below the floor to the ankles).
    const hipYAdj = hipY + hipW * 0.11;
    // Where the cape hangs from, measured up the ACTUAL rig rather than
    // guessed from nominal height (stakeholder, 2026-08-18: the cape sat
    // differently on larger models). Leg length carries a per-archetype
    // `limb` multiplier, so this height ranges from ~0.76 to ~0.85 of
    // nominal height — a garment sized off `p.height` therefore hung from
    // a different place on every build. Sizing off THIS makes the hem land
    // at the same point on the body for everyone.
    const capeAnchorY = hipYAdj + torsoH * (0.24 + 0.34 + 0.45);
    // Shoulder height and arm seating stakeholder-tuned via editor export 2.
    this.dims = {
      hipY: hipYAdj, torsoH, headH, shoulderW, hipW, bodyW, capeAnchorY,
      baseShY: torsoH * 0.32, upperLeg, lowerLeg, lowerArm,
    };

    // --- Torso (review round 2): three lathe-turned volumes — pelvis,
    // abdomen, ribcage — whose seam radii MATCH, flattened front-to-back,
    // with soft masses (abs, pecs/bust, trapezius) laid over them. No
    // stacked-primitive creases, no bare spheres.
    const seamHip = hipW * 0.47; // pelvis top = abdomen bottom
    const seamWaist = waistW * 0.58; // abdomen top = ribcage bottom

    this.pelvis = this.joint(this.root, [0, hipYAdj, 0]);
    this.nm('pelvis');
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
    ], p.cloth, { count: 7, amp: 0.035 });
    // Reference check (round 7) + editor export 2: near-flat front, mass at
    // the sides and rear.
    pelvisMesh.scale.set(0.96, 1, 0.6);
    pelvisMesh.position.z = -hipW * 0.04;
    // One wide flattened mass under the cloth, faintly creased by the fold
    // ripples — two bare spheres read as exactly that (round 8).
    this.nm('buttocks');
    const glutes = this.addMesh(this.pelvis, new THREE.SphereGeometry(hipW * 0.26, 14, 10), p.cloth,
      [0, torsoH * 0.07, -hipW * 0.18]); // editor export 2: higher, wider
    // Depth pulled in (Muybridge side rows: the round-1 sheet showed a shelf).
    glutes.scale.set(1.74, 0.85, 0.58);

    this.spine = this.joint(this.pelvis, [0, torsoH * 0.24, 0]);
    this.nm('abdomen');
    const belly = this.lathe(this.spine, [
      [seamHip, 0],
      [waistW * 0.52, torsoH * 0.18],
      [seamWaist, torsoH * 0.35],
    ], p.cloth, { count: 6, amp: 0.025 });
    belly.scale.set(0.97, 1, 0.62); // flat-fronted (editor export 2)
    belly.position.z = -waistW * 0.04;
    // (The separate stomach swell was hidden in the stakeholder's export and
    // called redundant — removed.)

    // The torso garment is ONE material (cloth) so the body reads as a
    // single form; metal is reserved for actual armour pieces.
    this.chest = this.joint(this.spine, [0, torsoH * 0.34, 0]);
    // Full width HELD to the (raised) shoulder line, then a SHORT round-over:
    // the chest reaches the deltoids, and the shoulder slope stays small the
    // way a clavicle line does. Female chest band slightly slimmer.
    // Male band pulled in from 0.98 (stakeholder: "the male torso looks very
    // odd") — the near-shoulder-width band read as a barrel slab.
    const bandW = shoulderW * (fem ? 0.92 : 0.93);
    this.nm('chest');
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
    this.nm('upper back');
    const traps = this.addMesh(this.chest, new THREE.SphereGeometry(shoulderW * 0.46, 12, 9), p.cloth,
      [0, torsoH * 0.4, -this.frontZ() * 0.24]);
    traps.scale.set(1.45, 0.4, 0.66);
    // The cape's collar arc is centred on the NECK ROOT (stakeholder cape
    // reference: fabric ties at the throat and wraps the shoulder tops —
    // the old between-the-shoulder-blades pin hung off the back only).
    // Anchor at the upper back, not the neck: the pinned line spreads
    // across the trapezius/deltoid breadth (stakeholder correction).
    this.capeAnchor = this.joint(this.chest, [0, torsoH * 0.45, 0]);
    if (fem) {
      // The sprung chest: geometry on its own group so physics can move it.
      // Sized to be READ at game distance (review round 3), not hinted.
      this.bustGroup = new THREE.Group();
      this.bustBase.set(0, torsoH * 0.26, this.frontZ() * 0.52);
      this.bustGroup.position.copy(this.bustBase);
      this.chest.add(this.bustGroup);
      const { r: bustR, x: bustX } = this.bustDims();
      for (const s of [1, -1]) {
        this.nm(s === 1 ? 'breast left' : 'breast right');
        const b = this.addMesh(this.bustGroup, new THREE.SphereGeometry(bustR, 10, 8), p.cloth,
          [s * bustX, -bodyW * 0.065, bodyW * 0.075]);
        b.scale.set(1.2, 1.3, 1.3);
      }
    } else {
      // The male chest, reworked the way the female one was (stakeholder
      // pass): ONE wide flattened mass under the cloth instead of two proud
      // spheres — the pair read as exactly that, the same twin-sphere bug the
      // glutes fix solved. A single plate gives the side profile its chest
      // plane and the front a clean pectoral shelf.
      this.nm('pectorals');
      const pecs = this.addMesh(this.chest, new THREE.SphereGeometry(bodyW * 0.2, 14, 10), p.cloth,
        [0, torsoH * 0.27, this.frontZ() * 0.42]);
      pecs.scale.set(1.62, 0.68, 0.5);
    }
    // Belt: at the HIPS, where trousers are belted (review round 6 — it had
    // drifted to the ribs). Parented to the spine so it rides the hip line.
    this.nm('belt');
    // Stakeholder-tuned via the model editor: slimmer, flatter, set back.
    const belt = this.addMesh(this.spine,
      new THREE.CylinderGeometry(seamHip * 0.99, seamHip * 1.02, torsoH * 0.07, 18),
      p.accent, [0, torsoH * 0.03, -0.012]);
    belt.scale.z = 0.64;

    this.neck = this.joint(this.chest, [0, torsoH * 0.38, 0]);
    this.nm('neck');
    // Taller (editor export 2): fills to the jaw with no gap at the collar.
    this.addMesh(this.neck, new THREE.CylinderGeometry(bodyW * 0.13, bodyW * 0.16, headH * 0.5, 8),
      p.skin, [0, headH * 0.14, 0]);

    // Head: a capsule cranium with a hinted jaw — rounder than the old box.
    this.head = this.joint(this.neck, [0, headH * 0.22, 0]);
    this.nm('head');
    this.addMesh(this.head,
      new THREE.CapsuleGeometry(headH * 0.35, headH * 0.14, 4, 10),
      p.skin, [0, headH * 0.42, 0]);
    // Jaw: an ellipsoid, not a box — the box corners read as "a cube near
    // the chin" (round 8). Narrower on the female build (reference: oval).
    this.nm('jaw');
    const jaw = this.addMesh(this.head,
      new THREE.SphereGeometry(headH * 0.26, 12, 9),
      p.skin, [0, headH * 0.22, headH * 0.04]);
    jaw.scale.set(fem ? 0.82 : 0.95, 0.66, 0.8);
    this.buildFace(headH);

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

  /** Multiplies a hex colour toward black — shading for lips/brows/nose. */
  private static shade(color: number, f: number): number {
    const r = Math.round(((color >> 16) & 255) * f);
    const g = Math.round(((color >> 8) & 255) * f);
    const b = Math.round((color & 255) * f);
    return (r << 16) | (g << 8) | b;
  }

  /**
   * A face (next-tier pass): eyes, brows, a nose, a mouth line. At game
   * distance these read as the dark pixels a face needs; up close they are
   * honest features. All deterministic from the appearance.
   */
  private buildFace(headH: number): void {
    const p = this.appearance;
    const browCol = CharacterVisual.shade(p.hairColor, 0.85);
    const lipCol = CharacterVisual.shade(p.skin, 0.72);
    const eyeWhite = 0xe8e2d6;
    const iris = CharacterVisual.shade(p.hairColor, 0.5);
    const faceZ = headH * 0.3;
    for (const s of [1, -1]) {
      const lr = s === 1 ? 'left' : 'right';
      this.nm(`eye ${lr}`);
      const white = this.addMesh(this.head, new THREE.SphereGeometry(headH * 0.055, 8, 6), eyeWhite,
        [s * headH * 0.13, headH * 0.44, faceZ]);
      white.scale.z = 0.45;
      this.nm(`iris ${lr}`);
      const pupil = this.addMesh(this.head, new THREE.SphereGeometry(headH * 0.028, 6, 5), iris,
        [s * headH * 0.13, headH * 0.44, faceZ + headH * 0.028]);
      pupil.scale.z = 0.5;
      this.nm(`brow ${lr}`);
      const brow = this.box(this.head, headH * 0.14, headH * 0.032, headH * 0.03, browCol,
        [s * headH * 0.13, headH * 0.53, faceZ + headH * 0.012]);
      brow.rotation.z = s * -0.12;
    }
    // Nose: a small three-sided prism, point forward.
    this.nm('nose');
    const nose = this.addMesh(this.head,
      new THREE.CylinderGeometry(headH * 0.035, headH * 0.05, headH * 0.14, 3),
      p.skin, [0, headH * 0.33, faceZ + headH * 0.02]);
    nose.rotation.x = -0.12;
    // Mouth: a soft darker line on the jaw.
    this.nm('mouth');
    const mouth = this.box(this.head, headH * 0.16, headH * 0.025, headH * 0.02, lipCol,
      [0, headH * 0.16, headH * 0.235]);
    mouth.rotation.x = 0.05;
  }

  private buildArm(side: 'L' | 'R', bodyW: number, upperArm: number, lowerArm: number, torsoH: number): Limb {
    const p = this.appearance;
    const s = side === 'L' ? 1 : -1;
    const lr = side === 'L' ? 'left' : 'right';
    const sh = this.joint(this.chest, [s * this.dims.shoulderW, this.dims.baseShY, 0]);
    // Deltoid: an egg-shaped mass ON the arm bone, so it rides every arm
    // move and blends the shoulder into the upper arm (review: not a bare
    // sphere hovering at the joint).
    this.nm(`${lr} shoulder`);
    // Editor export 2: further in, slightly high, wider and deeper.
    const deltoid = this.addMesh(sh, new THREE.SphereGeometry(bodyW * 0.135, 10, 8), p.cloth,
      [-s * bodyW * 0.12, bodyW * 0.02, 0]);
    deltoid.scale.set(1.35, 1.2, 1.44);
    // Deltoid → wrist taper; sleeves run to the wrist (bare pale forearms
    // read as gauntlet mitts at distance — cycle B), hands alone are skin.
    this.nm(`${lr} upper arm`);
    this.taperedLimb(sh, bodyW * 0.125, bodyW * 0.1, upperArm, p.cloth);
    const el = this.joint(sh, [0, -upperArm, 0]);
    this.nm(`${lr} forearm`);
    this.taperedLimb(el, bodyW * 0.105, bodyW * 0.07, lowerArm, p.cloth);
    const hand = this.joint(el, [0, -lowerArm, 0]);
    // A hand (next-tier pass): palm, a gently curled finger mass, and an
    // opposable thumb on the inner side — not a mitt sphere.
    this.nm(`${lr} palm`);
    const palm = this.addMesh(hand, new THREE.SphereGeometry(bodyW * 0.085, 8, 6), p.skin,
      [0, -bodyW * 0.04, 0]);
    palm.scale.set(0.8, 1.0, 0.55);
    this.nm(`${lr} fingers`);
    const fingers = this.addMesh(hand,
      new THREE.CapsuleGeometry(bodyW * 0.055, bodyW * 0.09, 3, 7), p.skin,
      [0, -bodyW * 0.14, bodyW * 0.012]);
    fingers.scale.set(1.25, 1.0, 0.7);
    fingers.rotation.x = 0.28; // relaxed curl
    this.nm(`${lr} thumb`);
    const thumb = this.addMesh(hand,
      new THREE.CapsuleGeometry(bodyW * 0.032, bodyW * 0.07, 3, 6), p.skin,
      [-s * bodyW * 0.075, -bodyW * 0.06, bodyW * 0.03]);
    thumb.rotation.z = -s * 0.7;
    thumb.rotation.x = 0.35;
    return { sh, el, hand };
  }

  private buildLeg(side: 'L' | 'R', hipW: number, upperLeg: number, lowerLeg: number, fem: boolean): Leg {
    const p = this.appearance;
    const s = side === 'L' ? 1 : -1;
    const lr = side === 'L' ? 'left' : 'right';
    // Hip joints tucked in so the thighs nearly meet — cycle C found a
    // cowboy gap between the legs.
    const hip = this.joint(this.pelvis, [s * hipW * 0.24, 0, 0]);
    // Thigh: thick at the top, narrowing to the knee (the review's example).
    this.nm(`${lr} thigh`);
    this.taperedLimb(hip, hipW * (fem ? 0.23 : 0.22), hipW * 0.135, upperLeg, p.cloth);
    const knee = this.joint(hip, [0, -upperLeg, 0]);
    // Calf: a bulge below the knee, tapering hard to the ankle.
    this.nm(`${lr} calf`);
    this.taperedLimb(knee, hipW * 0.15, hipW * 0.085, lowerLeg, p.cloth);
    const foot = this.joint(knee, [0, -lowerLeg, 0]);
    // A shaped foot (review: not a rectangle): rounded heel under the ankle
    // and a wedge tapering toward the toes. The 4-sided frustum, spun 45°,
    // gives a flat-soled taper no box can.
    const boot = 0x3a3028; // bright enough to survive the quantiser
    this.nm(`${lr} heel`);
    const heel = this.addMesh(foot, new THREE.SphereGeometry(hipW * 0.115, 8, 6), boot,
      [0, -hipW * 0.05, -hipW * 0.02]);
    heel.scale.set(0.95, 0.68, 1.05);
    this.nm(`${lr} foot`);
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
      this.nm('helm');
      this.helmGroup = new THREE.Group();
      this.head.add(this.helmGroup);
      const dome = this.addMesh(this.helmGroup,
        new THREE.SphereGeometry(headH * 0.34, 10, 7, 0, Math.PI * 2, 0, Math.PI * 0.62),
        p.metal, [0, headH * 0.5, 0]);
      dome.scale.y = 0.85;
      this.box(this.helmGroup, headH * 0.1, headH * 0.3, headH * 0.7, p.metal, [0, headH * 0.52, 0.01]);
    }

    for (const m of this.pauldronMeshes) m.parent?.remove(m);
    this.pauldronMeshes = [];
    if (this.equipment.pauldrons) {
      // On the ARM bones, so they ride every shoulder move (stakeholder bug
      // report), tucked in and raised per the editor export.
      for (const side of ['L', 'R'] as const) {
        const s = side === 'L' ? 1 : -1;
        this.nm(side === 'L' ? 'pauldron left' : 'pauldron right');
        const m = this.addMesh(this.arms[side].sh, new THREE.SphereGeometry(bodyW * 0.2, 8, 6),
          p.metal, [-s * bodyW * 0.125, bodyW * 0.02, 0]);
        m.scale.set(1.46, 1, 1.15); // editor export 2
        this.pauldronMeshes.push(m);
      }
    }

    if (this.weaponGroup) {
      this.weaponGroup.parent?.remove(this.weaponGroup);
      this.weaponGroup = null;
    }
    for (const a of [this.handAnchor, this.backAnchor]) a?.parent?.remove(a);
    this.handAnchor = null;
    this.backAnchor = null;
    if (this.equipment.weapon && this.equipment.weaponKind === 'staff') {
      // A walking staff: built VERTICAL with the grip at the group origin.
      // update() keeps the group world-upright every frame and, when the
      // character is stationary, slides it in the grip so the iron-shod base
      // sits exactly on the ground — a planted staff, not a carried stick.
      this.nm('staff');
      this.weaponGroup = new THREE.Group();
      this.root.add(this.weaponGroup); // placed each frame between anchors
      const above = p.height * 0.34; // shaft above the grip
      const below = p.height * 0.58; // grip down to the ground shoe
      this.staffBelow = below;
      // Held: upright in the fist. Stowed: slung diagonally across the back.
      this.handAnchor = this.joint(this.arms.R.hand, [0, 0, 0]);
      this.backAnchor = this.joint(this.chest, [
        -bodyW * 0.34, torsoH * 0.1, -this.frontZ() * 0.9,
      ]);
      this.backAnchor.rotation.set(0.25, 0, -0.42);
      const wood = 0x4a3a28;
      this.addMesh(this.weaponGroup,
        new THREE.CylinderGeometry(0.021, 0.027, above + below, 8),
        wood, [0, (above - below) / 2, 0]);
      // A gnarled head-knot rather than a wizardly orb — low fantasy.
      const knot = this.addMesh(this.weaponGroup, new THREE.SphereGeometry(0.045, 8, 6),
        CharacterVisual.shade(wood, 1.25), [0, above, 0]);
      knot.scale.set(1, 1.3, 1);
      this.nm('staff ferrule');
      this.addMesh(this.weaponGroup, new THREE.CylinderGeometry(0.024, 0.03, 0.07, 8),
        p.metal, [0, -below + 0.035, 0]);
    } else if (this.equipment.weapon) {
      // Gripped in the fist, blade pointing FORWARD from the character
      // (review point): the group builds blade-down, then rotates -90° about
      // X so "down" becomes "out in front", angled slightly toward the ground.
      this.nm('sword');
      this.weaponGroup = new THREE.Group();
      this.root.add(this.weaponGroup); // placed each frame between anchors
      // Held: gripped in the fist, blade forward and angled down.
      this.handAnchor = this.joint(this.arms.R.hand, [0, -bodyW * 0.05, 0]);
      this.handAnchor.rotation.x = -Math.PI / 2 + 0.35;
      // Stowed: hung down the back, hilt at the right shoulder — the
      // over-the-shoulder draw the sheathe animation reaches for.
      this.backAnchor = this.joint(this.chest, [
        -bodyW * 0.26, torsoH * 0.34, -this.frontZ() * 0.95,
      ]);
      this.backAnchor.rotation.set(0.22, 0, -0.34);
      this.box(this.weaponGroup, 0.045, 0.14, 0.045, 0x2a231d, [0, 0.02, 0]);
      this.box(this.weaponGroup, 0.2, 0.035, 0.05, p.metal, [0, -0.06, 0]);
      this.box(this.weaponGroup, 0.055, 0.72, 0.022, 0x74808c, [0, -0.06 - 0.37, 0]);
    }

    if (this.cape) {
      this.parentOrRoot().remove(this.cape.mesh);
      this.cape.dispose();
      this.cape = null;
    }
    if (this.capeTie) {
      this.capeTie.parent?.remove(this.capeTie);
      this.capeTie.geometry.dispose();
      (this.capeTie.material as THREE.Material).dispose();
      this.capeTie = null;
    }
    if (this.equipment.cape) {
      // Collar layout: pinned in an arc around the neck; the fabric is cut
      // WIDER than the arc so it gathers at the collar and spreads over the
      // shoulder caps (reference image), falling to mid-calf.
      // The shoulder ring reaches past the deltoids: the cape drapes over
      // the tops of the ARMS (stakeholder correction), not just the torso.
      // The cut scales with BULK, not just shoulder span: sized off
      // shoulderW alone, a heavy build wore a taut apron that bunched the
      // moment it moved (stakeholder).
      // Length is a fraction of the ANCHOR's own height, so the hem lands
      // at the same point on the leg for a long-limbed ascetic and a
      // squat brute alike (stakeholder: "anchored at the same relative Y").
      const capeLen = this.dims.capeAnchorY * 0.76;
      // The collar is a NECK ring, so it is sized off the head — not off
      // bulk. The old max(shoulderW, bodyW) term nearly doubled across
      // builds, and on heavy bodies the pinned ring grew wide enough to
      // carry the fabric up around the head.
      const collar = headH * 0.62 + shoulderW * 0.16;
      // The cut follows the SHOULDER SPAN, which is what a cape hangs
      // from, with only a modest allowance for girth. Driving it off bulk
      // (the old 0.95·bodyW) made a heavy character's cape 1.9× its own
      // shoulder span against a lean one's 1.5× — the same garment read as
      // a cloak on one build and a blanket on another.
      const capeWidth = shoulderW * 2.9 + bodyW * 0.25;
      this.capeCut = { width: capeWidth, length: capeLen, collar, anchorY: this.dims.capeAnchorY };
      this.cape = new Cloth(11, 10, capeWidth, capeLen,
        p.capeColor, 'collar', collar, shoulderW + bodyW * 0.12);
      this.parentOrRoot().add(this.cape.mesh);
      // The tie at the throat, so the collar reads as fastened.
      this.nm('cape tie');
      this.capeTie = this.addMesh(this.chest,
        new THREE.CylinderGeometry(bodyW * 0.15, bodyW * 0.16, torsoH * 0.05, 12),
        CharacterVisual.shade(p.capeColor, 0.75), [0, torsoH * 0.45, 0]);
      this.capeTie.scale.z = 0.7;
    }

    for (const m of this.robeParts) {
      m.parent?.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.robeParts = [];
    if (this.robeSkirt) {
      this.parentOrRoot().remove(this.robeSkirt.mesh);
      this.robeSkirt.dispose();
      this.robeSkirt = null;
    }
    for (const s of this.robeSleeves) {
      this.parentOrRoot().remove(s.cloth.mesh);
      s.cloth.dispose();
    }
    this.robeSleeves = [];
    if (this.equipment.robe) {
      // A full-length robe in the cape colour so robed figures read as a
      // distinct silhouette. The fitted overtunic and rope belt are rigid;
      // the SKIRT and SLEEVE CUFFS are cloth tubes ("flowing material
      // around the sleeves/legs" — stakeholder), colliding with the limbs.
      // Legs stay visible under the moving fabric.
      const fem = p.sex === 'female';
      const hipW = this.dims.hipW;
      const seamHip = hipW * 0.47;
      const waistW = bodyW * (fem ? 0.68 : 0.82);
      this.nm('robe tunic');
      // The bottom ring tucks INTO the rope belt (chest-space −0.33 ≈
      // spine-space +0.01, under the belt band): the old −0.12 hem left
      // the under-tunic waist showing between robe top and skirt
      // (stakeholder, 2026-08-17).
      const tunic = this.lathe(this.chest, [
        [seamHip * 1.0, -torsoH * 0.33],
        [waistW * 0.64, -torsoH * 0.12],
        [shoulderW * 0.88, torsoH * 0.18],
        [shoulderW * 1.0, torsoH * 0.32],
        [shoulderW * 0.52, torsoH * 0.45],
        [0.008, torsoH * 0.47],
      ], p.capeColor, { count: 8, amp: 0.03 });
      tunic.scale.z = 0.68;
      this.robeParts.push(tunic);
      this.nm('rope belt');
      const rope = this.addMesh(this.spine,
        new THREE.CylinderGeometry(seamHip * 1.04, seamHip * 1.06, torsoH * 0.045, 18),
        0x6b5a3a, [0, torsoH * 0.03, -0.01]);
      rope.scale.z = 0.66;
      this.robeParts.push(rope);
      // The skirt: a closed A-line tube from the waist to above the ankle.
      // RIGID (bone-following) from waist to the knee line — a fitted
      // garment — with free-flowing cloth only below (stakeholder).
      const skirtLen = this.dims.hipY * 0.9;
      const skirtRows = 12;
      // Rigid only through the fitted WAIST band — a knee-length rigid
      // cone jutted straight out when sitting (stakeholder); from the hips
      // down the fabric flexes with the pose.
      this.robeSkirt = new Cloth(13, skirtRows, 0, skirtLen, p.capeColor,
        'tube', seamHip * 1.05, hipW * 0.95, 2);
      this.parentOrRoot().add(this.robeSkirt.mesh);
      // Sleeves: shoulder cap over the deltoid joins the tunic to the arm,
      // the rigid upper sleeve runs to the elbow, and the cloth cuff pins
      // at the SAME radius the sleeve ends with — one continuous garment.
      const armLen = p.height * 0.31 * (1 + (p.limb - 1) * 0.4);
      const upperArm = armLen * 0.55;
      for (const side of ['L', 'R'] as const) {
        const s = side === 'L' ? 1 : -1;
        this.nm(side === 'L' ? 'robe shoulder left' : 'robe shoulder right');
        // The cap must swallow BOTH the deltoid egg (inboard) and the
        // upper arm's joint ball (outboard): the old inboard-only offset
        // left a wedge of bare arm showing above the sleeve rim
        // (stakeholder, 2026-08-17: "the top sleeves must cover the
        // deltoids"). Centred nearly on the joint and cut larger.
        const cap = this.addMesh(this.arms[side].sh,
          new THREE.SphereGeometry(bodyW * 0.15, 10, 8), p.capeColor,
          [-s * bodyW * 0.07, bodyW * 0.02, 0]);
        cap.scale.set(1.6, 1.35, 1.6);
        this.robeParts.push(cap);
        this.nm(side === 'L' ? 'robe sleeve left' : 'robe sleeve right');
        this.robeParts.push(this.addMesh(this.arms[side].sh,
          new THREE.CylinderGeometry(bodyW * 0.17, bodyW * 0.18, upperArm * 1.05, 10),
          p.capeColor, [0, -upperArm * 0.5, 0]));
        const cuff = new Cloth(9, 5, 0, this.dims.lowerArm * 0.85, p.capeColor,
          'tube', bodyW * 0.18, bodyW * 0.26);
        this.parentOrRoot().add(cuff.mesh);
        this.robeSleeves.push({ cloth: cuff, side });
      }
      // The tunic covers the bust: capeColor overlays riding the same
      // sprung group, slightly larger than the forms beneath (stakeholder).
      if (this.bustGroup) {
        const { r: bustR, x: bustX } = this.bustDims();
        for (const sb of [1, -1]) {
          this.nm('robe bodice');
          const cover = this.addMesh(this.bustGroup,
            new THREE.SphereGeometry(bustR * 1.1, 10, 8), p.capeColor,
            [sb * bustX, -bodyW * 0.065, bodyW * 0.075]);
          cover.scale.set(1.2, 1.3, 1.3);
          this.robeParts.push(cover);
        }
      }
      // Warm-start: the cloth spawns at rest-local coordinates and takes a
      // couple of seconds to drape in; pre-stepping hides that from players
      // (and from the review sheets).
      this.root.updateMatrixWorld(true);
      for (let i = 0; i < 50; i++) {
        this.robeSkirt.step(1 / 30, 0, 0, this.spine.matrixWorld, this.skirtColliders());
        for (const s of this.robeSleeves) {
          s.cloth.step(1 / 30, 0, 0, this.arms[s.side].el.matrixWorld, this.sleeveColliders(s.side));
        }
      }
    }
    // The robe carries its hood; equipment changes rebuild it.
    this.refreshHood();
  }

  /** The skirt flows around the LEGS: a capsule per thigh and calf,
   * hanging below its joint (`off`), plus the pelvis core. */
  private skirtColliders(): { matrix: THREE.Matrix4; radius: number; height?: number; off?: number }[] {
    return [
      {
        matrix: this.pelvis.matrixWorld,
        radius: this.dims.hipW * 0.48,
        height: this.dims.torsoH * 0.18,
      },
      ...(['L', 'R'] as const).flatMap((s) => [
        {
          matrix: this.legs[s].hip.matrixWorld,
          radius: this.dims.hipW * 0.26,
          height: this.dims.upperLeg / 2,
          off: -this.dims.upperLeg / 2,
        },
        {
          matrix: this.legs[s].knee.matrixWorld,
          radius: this.dims.hipW * 0.17,
          height: this.dims.lowerLeg / 2,
          off: -this.dims.lowerLeg / 2,
        },
      ]),
    ];
  }

  private sleeveColliders(side: 'L' | 'R'): { matrix: THREE.Matrix4; radius: number; height?: number; off?: number }[] {
    const arm = this.arms[side];
    return [
      {
        matrix: arm.el.matrixWorld,
        radius: this.dims.bodyW * 0.11,
        height: this.dims.lowerArm / 2,
        off: -this.dims.lowerArm / 2,
      },
      { matrix: arm.hand.matrixWorld, radius: this.dims.bodyW * 0.1 },
    ];
  }

  private parentOrRoot(): THREE.Object3D {
    // Cloth/hair vertices live in world space, so they attach to the scene
    // parent rather than the (rotating) character root.
    return this.parent;
  }

  // -------------------------------------------------------------------------
  // Cloth workbench support (stakeholder, 2026-08-18)
  //
  // The viewer's cloth tab needs to re-pin a garment to any bone and choose
  // its colliders by name. Exposing the skeleton read-only is far cleaner
  // than the workbench reaching into privates, and keeps the naming in one
  // place — these are the same names the model editor uses.
  // -------------------------------------------------------------------------

  /** Every bone a garment may be pinned to, by display name. */
  bones(): Record<string, THREE.Object3D> {
    return {
      pelvis: this.pelvis,
      spine: this.spine,
      chest: this.chest,
      'upper back (cape anchor)': this.capeAnchor ?? this.chest,
      neck: this.neck,
      head: this.head,
      'shoulder left': this.arms.L.sh,
      'shoulder right': this.arms.R.sh,
      'elbow left': this.arms.L.el,
      'elbow right': this.arms.R.el,
      'hand left': this.arms.L.hand,
      'hand right': this.arms.R.hand,
      'hip left': this.legs.L.hip,
      'hip right': this.legs.R.hip,
      'knee left': this.legs.L.knee,
      'knee right': this.legs.R.knee,
    };
  }

  /** Body volumes a garment may be told to collide with, by display name. */
  colliderCatalog(): Record<string, { matrix: THREE.Matrix4; radius: number; height?: number; axisCol?: number; off?: number }> {
    const d = this.dims;
    const out: Record<string, { matrix: THREE.Matrix4; radius: number; height?: number; axisCol?: number; off?: number }> = {
      chest: {
        matrix: this.chest.matrixWorld,
        radius: d.bodyW * 0.45,
        height: Math.max(0.02, d.torsoH * 0.55 - d.bodyW * 0.45),
      },
      pelvis: {
        matrix: this.pelvis.matrixWorld,
        radius: d.hipW * 0.5,
        height: Math.max(0.02, d.torsoH * 0.35 - d.hipW * 0.5),
      },
      'shoulder left': { matrix: this.arms.L.sh.matrixWorld, radius: d.bodyW * 0.27 },
      'shoulder right': { matrix: this.arms.R.sh.matrixWorld, radius: d.bodyW * 0.27 },
      'hips (skirt)': {
        matrix: this.pelvis.matrixWorld,
        radius: d.hipW * 0.48,
        height: d.torsoH * 0.18,
      },
    };
    for (const s of ['L', 'R'] as const) {
      const side = s === 'L' ? 'left' : 'right';
      out[`thigh ${side}`] = {
        matrix: this.legs[s].hip.matrixWorld,
        radius: d.hipW * 0.26,
        height: d.upperLeg / 2,
        off: -d.upperLeg / 2,
      };
      out[`shin ${side}`] = {
        matrix: this.legs[s].knee.matrixWorld,
        radius: d.hipW * 0.17,
        height: d.lowerLeg / 2,
        off: -d.lowerLeg / 2,
      };
      out[`forearm ${side}`] = {
        matrix: this.arms[s].el.matrixWorld,
        radius: d.bodyW * 0.11,
        height: d.lowerArm / 2,
        off: -d.lowerArm / 2,
      };
      out[`hand ${side}`] = { matrix: this.arms[s].hand.matrixWorld, radius: d.bodyW * 0.1 };
    }
    return out;
  }

  /** Body measurements the workbench sizes garments against. */
  get measurements(): {
    shoulderW: number; bodyW: number; hipW: number; torsoH: number;
    headH: number; height: number; capeAnchorY: number;
  } {
    return {
      shoulderW: this.dims.shoulderW,
      bodyW: this.dims.bodyW,
      hipW: this.dims.hipW,
      torsoH: this.dims.torsoH,
      headH: this.dims.headH,
      height: this.appearance.height,
      // Rig-derived, and the right thing to size hanging garments against.
      capeAnchorY: this.dims.capeAnchorY,
    };
  }

  /** The scene object custom garments must be added to (world-space verts). */
  get clothParent(): THREE.Object3D {
    return this.parentOrRoot();
  }

  /**
   * The cape's actual cut, for proportion tests (D-114). A garment must sit
   * the same way on every build; these are the numbers that prove it.
   * Null when no cape is worn.
   */
  private capeCut: { width: number; length: number; collar: number; anchorY: number } | null = null;
  capeMetrics(): { width: number; length: number; collar: number; anchorY: number } | null {
    return this.equipment.cape ? this.capeCut : null;
  }

  // -------------------------------------------------------------------------
  // Per-frame update
  // -------------------------------------------------------------------------

  setFacing(dir: Direction): void {
    this.targetAngle = FACING_ANGLE[dir];
  }

  setPosition(x: number, z: number): void {
    // Y is owned by the death animation (a fallen body sinks to the floor),
    // so only the horizontal placement is written here.
    this.root.position.x = x;
    this.root.position.z = z;
  }

  setPosture(posture: Posture): void {
    this.posture = posture;
  }

  /** Presentation drives the D-219 concealment: hood + veil. */
  setPresentation(presentation: Presentation): void {
    if (this.presentation === presentation) return;
    this.presentation = presentation;
    this.refreshHood();
  }

  /**
   * The hood, rebuilt to the stakeholder's references (2026-08-17):
   * - Worn as CLOTHING (part of the robe): the cowl frames a fully VISIBLE
   *   face — an arch over the brow, roomy sides, folds at the shoulders —
   *   like the monk photo. No mechanical effect.
   * - The D-219 "go hooded" presentation adds a VEIL across the lower
   *   face: eyes visible, nose/mouth masked (the stakeholder's veil
   *   photo) — concealment without the old face-void.
   */
  private refreshHood(): void {
    const { headH, torsoH, shoulderW, bodyW } = this.dims;
    for (const g of [this.cowlGroup, this.mantleGroup]) {
      if (!g) continue;
      g.parent?.remove(g);
      g.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
    }
    this.cowlGroup = null;
    this.mantleGroup = null;
    for (const f of this.hoodFlaps) {
      this.parentOrRoot().remove(f.cloth.mesh);
      f.cloth.dispose();
      f.anchor.parent?.remove(f.anchor);
    }
    this.hoodFlaps = [];
    const veiled = this.presentation === 'hooded';
    const hoodUp = veiled || this.equipment.robe;
    if (hoodUp) {
      // Robes carry their hood in the robe colour; a bare "go hooded" uses
      // the anonymous dark cowl.
      const hoodCol = this.equipment.robe ? this.appearance.capeColor : 0x241f1c;
      this.cowlGroup = new THREE.Group();
      this.head.add(this.cowlGroup);
      const shellMat = toonMaterial(hoodCol);
      shellMat.side = THREE.DoubleSide; // the inside shows through the opening
      // ANGULAR fabric, not a ball (stakeholder): low segment counts, made
      // faceted by dropping shared vertices so every face keeps its own
      // flat normal (MeshToonMaterial has no flatShading). The shell is
      // deep and swept back to a point, and sits FORWARD so the face is
      // recessed INSIDE the opening — the cowl overhangs the brow and
      // frames the cheeks (stakeholder: it wasn't covering the front).
      const faceted = (g: THREE.BufferGeometry): THREE.BufferGeometry => {
        const n = g.toNonIndexed();
        n.computeVertexNormals();
        g.dispose();
        return n;
      };
      // The hood per the stakeholder's two reference photos (2026-08-17,
      // round 16). The SIDE photo dictates the silhouette: the front tip
      // overhangs the brow, the top edge runs back near-horizontal over
      // the crown, and ONE straight diagonal falls from the top-back
      // corner to the shoulders. The FRONT photo dictates the opening: a
      // pointed arch, edges dropping in straight diagonals framing the
      // face closely, the face recessed under the overhang. Built as a
      // hand-lofted ridge tent — a centre ridge polyline and, per side, a
      // mid (volume) and rim (opening + hem) polyline, laddered into flat
      // triangles. A cone/dome assembly could not make this silhouette:
      // its apex read as a forward horn from the side (round 15).
      this.nm('hood');
      const h = headH;
      const V = (x: number, y: number, z: number) => new THREE.Vector3(x * h, y * h, z * h);
      // Centre ridge: tip → over crown (near-horizontal, slight peak) →
      // top-back corner → ONE straight diagonal to the nape hem.
      const ridge = [V(0, 0.86, 0.66), V(0, 0.94, 0.05), V(0, 0.86, -0.32), V(0, -0.25, -0.50)];
      const tip = ridge[0]!;
      const nape = ridge[3]!;
      const sideLines = (s: number) => ({
        // Mid line: pushes the side sheet out so it clears skull + hair cap.
        mid: [tip, V(s * 0.20, 0.76, 0.60), V(s * 0.36, 0.78, 0.02), V(s * 0.32, 0.66, -0.34),
          V(s * 0.18, -0.22, -0.46), nape] as THREE.Vector3[],
        // Rim: down the face opening (temple, jaw), then the hem sweeping
        // back over the shoulder to the nape. The jaw corner tucks BACK so
        // the side profile recedes under the tip's overhang instead of
        // standing as a vertical wall.
        rim: [tip, V(s * 0.40, 0.48, 0.50), V(s * 0.46, 0.08, 0.26), V(s * 0.50, -0.20, -0.12),
          V(s * 0.34, -0.20, -0.38), nape] as THREE.Vector3[],
      });
      // Ladder two polylines sharing endpoints into a triangle strip,
      // advancing along whichever side's next vertex is nearer in
      // normalised arc length — keeps every authored corner crisp.
      const positions: number[] = [];
      const ladder = (a: THREE.Vector3[], b: THREE.Vector3[]): void => {
        const params = (pts: THREE.Vector3[]): number[] => {
          const t = [0];
          for (let i = 1; i < pts.length; i++) t.push(t[i - 1]! + pts[i]!.distanceTo(pts[i - 1]!));
          return t.map((v) => v / (t[t.length - 1]! || 1));
        };
        const ta = params(a);
        const tb = params(b);
        let i = 0;
        let j = 0;
        while (i < a.length - 1 || j < b.length - 1) {
          if (j >= b.length - 1 || (i < a.length - 1 && ta[i + 1]! <= tb[j + 1]!)) {
            positions.push(...a[i]!.toArray(), ...b[j]!.toArray(), ...a[i + 1]!.toArray());
            i++;
          } else {
            positions.push(...a[i]!.toArray(), ...b[j]!.toArray(), ...b[j + 1]!.toArray());
            j++;
          }
        }
      };
      for (const s of [1, -1]) {
        const { mid, rim } = sideLines(s);
        ladder(ridge, mid);
        ladder(mid, rim);
      }
      const shellGeo = new THREE.BufferGeometry();
      shellGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      shellGeo.computeVertexNormals();
      const shell = new THREE.Mesh(shellGeo, shellMat);
      shell.name = 'hood';
      shell.castShadow = true;
      this.cowlGroup.add(shell);
      this.nm('hood gather');
      // The fabric roll where the hood gathers at the neck (reference
      // sheet: nearly every drawing has it).
      const gather = this.addMesh(this.cowlGroup,
        faceted(new THREE.TorusGeometry(headH * 0.34, headH * 0.1, 5, 8)) as THREE.BufferGeometry,
        hoodCol, [0, headH * 0.04, headH * 0.06]);
      gather.rotation.x = Math.PI * 0.46;
      gather.scale.set(1, 1, 0.85);
      // PHYSICS on the front/side rim (stakeholder): a small cloth strip
      // hangs from each rim edge, swaying with the head and resting on
      // the shoulders.
      for (const side of ['L', 'R'] as const) {
        const s = side === 'L' ? 1 : -1;
        // Anchored at the rim's jaw corner: a narrow drape falling down
        // the chest beside the face (front reference photo) — the old
        // wide temple flap curtained across the whole side view.
        const anchor = this.joint(this.head, [s * headH * 0.4, headH * 0.06, headH * 0.24]);
        anchor.rotation.y = s * 0.35; // strip plane faces outward-forward
        const flap = new Cloth(3, 4, headH * 0.18, headH * 0.36, hoodCol);
        this.parentOrRoot().add(flap.mesh);
        this.hoodFlaps.push({ cloth: flap, anchor, side });
      }
      if (veiled) {
        this.nm('veil');
        // Lower-face veil: top edge just under the eye line, reaching
        // past the chin and over the nose.
        const veil = this.addMesh(this.cowlGroup, new THREE.SphereGeometry(headH * 0.34, 12, 9),
          0x17130f, [0, headH * 0.28, headH * 0.17]);
        veil.scale.set(0.9, 0.56, 0.6);
      }
      // Mantle: the hood's cloth spreading over the shoulders.
      this.mantleGroup = new THREE.Group();
      this.chest.add(this.mantleGroup);
      this.nm('hood mantle');
      // A SHORT capelet: head and the tops of the shoulders only — the
      // long version read as a poncho over the torso (stakeholder). Few,
      // deep folds; faceted like the shell.
      const mantle = this.lathe(this.mantleGroup, [
        [shoulderW * 1.02, torsoH * 0.32],
        [bodyW * 0.48, torsoH * 0.46],
        [bodyW * 0.24, torsoH * 0.56],
      ], hoodCol, { count: 6, amp: 0.05 });
      mantle.scale.z = 0.82;
      mantle.geometry = ((): THREE.BufferGeometry => {
        const n = mantle.geometry.toNonIndexed();
        n.computeVertexNormals();
        mantle.geometry.dispose();
        return n;
      })();
    }
    if (this.hair) {
      // ANY worn-up hood — clothing or the D-219 concealment — hides the
      // hair entirely (stakeholder 2026-08-17): no fringe peeking, no
      // bun bulging through the shell. hoodUp already covers veiled.
      this.hair.setVisible(!hoodUp);
    }
  }

  /** Queues one-shot emote animations (D-202 transients). */
  playTransients(names: readonly TransientAnim[]): void {
    for (const name of names) {
      if (this.transientQueue.length < 4) this.transientQueue.push(name);
    }
  }

  /**
   * Combat state, straight from the server. Turning it on draws the weapon
   * and holds a ready stance; turning it off sheathes and returns to the
   * true idle. The transition is animated, not snapped.
   */
  setCombat(inCombat: boolean): void {
    this.inCombat = inCombat;
  }

  get combat(): boolean {
    return this.inCombat;
  }

  /** True once the weapon is fully in hand — the ready stance waits for it. */
  private get weaponReady(): boolean {
    return !this.equipment.weapon || this.drawT > 0.92;
  }

  /** Plays one attack; `variant` is chosen server-side so observers agree. */
  playAttack(variant: number, t: number): void {
    // A swing implies the weapon is out — no waiting for the draw to finish.
    this.inCombat = true;
    this.attackAnim = { variant, start: t, until: t + CharacterVisual.ATTACK_SECONDS };
  }

  /** Whether this character casts rather than swings, from what it holds. */
  get castsSpells(): boolean {
    return this.equipment.weapon && this.equipment.weaponKind === 'staff';
  }

  /** World position of the weapon's business end — where a bolt is born. */
  weaponMuzzle(out: THREE.Vector3): THREE.Vector3 {
    const src = this.weaponGroup ?? this.arms.R.hand;
    src.updateMatrixWorld();
    // The staff's knot sits at the top of the shaft; a fist is its own tip.
    out.set(0, this.castsSpells ? this.appearance.height * 0.34 : 0, 0);
    return out.applyMatrix4(src.matrixWorld);
  }

  /**
   * Starts the fall. Rather than replaying a canned collapse, the body is
   * integrated as an inverted pendulum pivoting on its own feet
   * (stakeholder, 2026-08-18): a blow shoves it over in the direction the
   * blow came from, and a death from bleeding or sickness simply buckles
   * and drops where it stands.
   *
   * `impulse` is a WORLD-space push (its length is the strength). Omit it
   * for a death with nobody behind it.
   */
  playDeath(t: number, impulse?: THREE.Vector3): void {
    if (this.deathStart !== null || this.dead) return;
    this.deathStart = t;
    this.attackAnim = null;
    this.transientQueue.length = 0;
    this.currentTransient = null;
    this.ragdoll = this.makeRagdoll(impulse);
  }

  /** Samples the CURRENT pose into a ragdoll, so it falls from where it
   * stood rather than snapping to a neutral stance first. */
  private makeRagdoll(impulse?: THREE.Vector3): Ragdoll {
    this.root.updateMatrixWorld(true);
    const at = (o: THREE.Object3D): THREE.Vector3 =>
      new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
    const world = {
      pelvis: at(this.pelvis),
      chest: at(this.chest),
      head: at(this.head),
      shoulderL: at(this.arms.L.sh),
      elbowL: at(this.arms.L.el),
      handL: at(this.arms.L.hand),
      shoulderR: at(this.arms.R.sh),
      elbowR: at(this.arms.R.el),
      handR: at(this.arms.R.hand),
      hipL: at(this.legs.L.hip),
      kneeL: at(this.legs.L.knee),
      footL: at(this.legs.L.foot),
      hipR: at(this.legs.R.hip),
      kneeR: at(this.legs.R.knee),
      footR: at(this.legs.R.foot),
    };
    // No blow behind it? Then nothing pushes: gravity alone folds the body
    // where it stands, which is what bleeding out looks like.
    const push = impulse ? impulse.clone().setY(impulse.y * 0.35 + 0.25) : new THREE.Vector3();
    // The ground is where the character was standing — NOT its root height
    // once the fall starts moving it, which would floor the body at hip
    // level and leave it standing upright forever.
    this.deathGroundY = this.root.position.y;
    return new Ragdoll(world, this.dims.bodyW, push);
  }

  /** Holds the final prone pose — used for corpses that spawn already dead. */
  setDead(dead: boolean): void {
    this.dead = dead;
    if (dead) {
      this.deathStart = null;
      if (!this.ragdoll) {
        // Already down when we first saw it (a corpse in a snapshot): let
        // it fall now and fast-forward the simulation so it arrives
        // already settled rather than toppling in front of the observer.
        this.ragdoll = this.makeRagdoll();
        for (let i = 0; i < 240 && !this.ragdoll.settled; i++) this.ragdoll.step(1 / 60);
      }
    } else {
      // Standing back up must clear the whole fall, not just the flag:
      // leaving deathStart set left the character permanently "dying" with
      // no ragdoll, and playDeath's guard then refused to ever fire again
      // (stakeholder: the ragdoll only ran once).
      this.ragdoll = null;
      this.deathStart = null;
    }
  }

  private static ATTACK_SECONDS = 0.62;
  private static DEATH_SECONDS = 1.15;
  private static DRAW_SECONDS = 0.42;

  update(dt: number, t: number, moving: boolean, wind: number): void {
    // shortest-path turn toward facing
    let diff = this.targetAngle - this.currentAngle;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    this.currentAngle += diff * Math.min(1, dt * 12);
    this.root.rotation.y = this.currentAngle;

    // Death outranks everything: a falling body takes no more orders. It
    // is "dead" once the simulation has stopped moving, not on a timer —
    // a hard shove reaches the ground sooner than a slow crumple.
    const dying = this.deathStart !== null;
    if (dying && this.ragdoll?.settled) {
      this.deathStart = null;
      this.dead = true;
    }
    if (this.attackAnim && t >= this.attackAnim.until) this.attackAnim = null;

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

    // The weapon slides between back and hand. Drawing takes priority over
    // an attack's own timing so a surprised character swings as it clears.
    const drawTarget = this.inCombat || this.attackAnim ? 1 : 0;
    const drawSpeed = dt / CharacterVisual.DRAW_SECONDS;
    this.drawT = drawTarget > this.drawT
      ? Math.min(1, this.drawT + drawSpeed)
      : Math.max(0, this.drawT - drawSpeed);
    // Mid-transition the free hand reaches over the shoulder: that reach IS
    // the sheathe/draw animation, blended over whatever else is playing.
    const swapping = this.equipment.weapon && this.drawT > 0.02 && this.drawT < 0.98
      && !this.attackAnim && !dying && !this.dead;

    // 1) Write the active animation's pose directly to the bones…
    const animKey = this.dead || dying
      ? 'death'
      : this.attackAnim
        ? `attack:${this.attackAnim.variant}`
        : moving
          ? `walk${this.inCombat ? ':combat' : ''}`
          : this.currentTransient
            ? `transient:${this.currentTransient.name}`
            : this.posture === 'standing' && this.inCombat && this.weaponReady
              ? 'combat-idle'
              : `posture:${this.posture}`;
    this.resetPose();
    if ((this.dead || dying) && this.ragdoll) {
      // The simulation owns the skeleton now — no keyframes, no blending.
      // The floor sits at the character's own base, wherever it stands.
      this.ragdoll.step(dt, this.deathGroundY);
      this.ragdoll.applyTo({
        root: this.root,
        pelvis: this.pelvis,
        spine: this.spine,
        chest: this.chest,
        neck: this.neck,
        head: this.head,
        arms: this.arms,
        legs: this.legs,
      });
      this.lastAnimKey = animKey;
      this.lastPose = this.capturePose(this.lastPose);
      this.fadeFrom = null;
      this.stepCloth(dt, t, wind);
      return;
    }
    if (this.attackAnim) {
      this.animAttack(this.attackAnim.variant, (t - this.attackAnim.start) / CharacterVisual.ATTACK_SECONDS, t);
    } else if (moving) this.animWalk(t);
    else if (this.currentTransient) {
      // One-shots play from their OWN start, not from wherever the global
      // clock happens to be mid-wave.
      this.animTransient(this.currentTransient.name, t - this.currentTransient.start);
    } else if (this.posture === 'sitting') this.animSit(t);
    else if (this.posture === 'kneeling') this.animKneel(t);
    else if (this.inCombat && this.weaponReady) this.animCombatIdle(t);
    else this.animIdle(t);
    if (swapping) this.animWeaponSwap(this.drawT);

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

    // The weapon rides between its two anchors. Both are resolved into ROOT
    // space and blended, so a half-drawn sword is genuinely halfway out of
    // its harness rather than snapping between parents.
    if (this.weaponGroup && this.handAnchor && this.backAnchor) {
      this.handAnchor.updateMatrixWorld(true);
      this.backAnchor.updateMatrixWorld(true);
      this.mRootInv.copy(this.root.matrixWorld).invert();
      this.mA.multiplyMatrices(this.mRootInv, this.backAnchor.matrixWorld);
      this.mB.multiplyMatrices(this.mRootInv, this.handAnchor.matrixWorld);
      this.mA.decompose(this.pA, this.qA, this.sTmp);
      this.mB.decompose(this.pB, this.qB, this.sTmp);
      // Ease the middle so the blade leaves the scabbard fast and settles.
      const raw = this.drawT;
      const e = raw * raw * (3 - 2 * raw);
      this.weaponGroup.position.copy(this.pA).lerp(this.pB, e);
      this.weaponGroup.quaternion.copy(this.qA).slerp(this.qB, e);
      // A drawn staff still plants itself when its bearer stands still —
      // the walking-staff idle, kept for the out-of-combat drawn case.
      if (this.equipment.weaponKind === 'staff' && this.drawT > 0.98 && !moving
        && !this.inCombat && !this.attackAnim) {
        this.tmpV.copy(this.weaponGroup.position).applyMatrix4(this.root.matrixWorld);
        const dy = this.staffBelow - this.tmpV.y;
        this.weaponGroup.position.y += dy;
      }
    }

    this.stepCloth(dt, t, wind);
  }

  /**
   * Steps every simulated garment and the hair against the CURRENT pose.
   * Split out of update() because a ragdolling body still has to drag its
   * cape down with it — the fall path returns early but calls this.
   */
  private stepCloth(dt: number, t: number, wind: number): void {
    this.stepBust(dt);
    if (this.cape) {
      // Colliders = torso core AND pelvis: the cloth rests on the back and
      // drapes over the buttocks instead of clipping through them.
      this.cape.step(
        dt, wind, t,
        (this.capeAnchor ?? this.chest).matrixWorld,
        [
          // Half-lengths shrunk by radius (capsule reach = halfLen+radius),
          // matching the old cylinders' vertical extent.
          {
            matrix: this.chest.matrixWorld,
            radius: this.dims.bodyW * 0.45,
            height: Math.max(0.02, this.dims.torsoH * 0.55 - this.dims.bodyW * 0.45),
          },
          {
            matrix: this.pelvis.matrixWorld,
            radius: this.dims.hipW * 0.5,
            height: Math.max(0.02, this.dims.torsoH * 0.35 - this.dims.hipW * 0.5),
          },
          // Shoulder caps (spheres): the collar-pinned fabric drapes OVER
          // the deltoids and rests there, per the cape reference image.
          { matrix: this.arms.L.sh.matrixWorld, radius: this.dims.bodyW * 0.27 },
          { matrix: this.arms.R.sh.matrixWorld, radius: this.dims.bodyW * 0.27 },
        ],
        // Below the shoulder line the cape stays behind the coronal plane;
        // above it, wrapped fabric may sit on and ahead of the shoulders.
        {
          matrix: this.chest.matrixWorld,
          maxZ: -this.dims.bodyW * 0.12,
          exemptAboveY: this.dims.torsoH * 0.26,
        },
      );
    }
    if (this.robeSkirt) {
      this.robeSkirt.step(dt, wind, t, this.spine.matrixWorld, this.skirtColliders());
    }
    for (const sleeve of this.robeSleeves) {
      sleeve.cloth.step(dt, wind, t, this.arms[sleeve.side].el.matrixWorld,
        this.sleeveColliders(sleeve.side));
    }
    for (const flap of this.hoodFlaps) {
      flap.cloth.step(dt, wind, t, flap.anchor.matrixWorld, [
        { matrix: this.arms[flap.side].sh.matrixWorld, radius: this.dims.bodyW * 0.26 },
        {
          matrix: this.chest.matrixWorld,
          radius: this.dims.bodyW * 0.26,
          height: this.dims.shoulderW * 0.75,
          axisCol: 0,
        },
      ]);
    }
    if (this.hair) {
      // Same colliders as the cape — chest and pelvis cylinders PLUS the
      // shoulder-cap spheres, so locks drape over the shoulders and arms
      // instead of clipping through them (stakeholder round 2).
      // Capsule half-lengths are SHRUNK by the radius: a capsule's reach is
      // halfLen + radius, and on bulky builds the unshrunk chest cap
      // swallowed the neck, flinging short hair upward (tavern screenshot).
      this.hair.step(dt, wind, t, this.head.matrixWorld, [
        {
          matrix: this.chest.matrixWorld,
          radius: this.dims.bodyW * 0.45,
          height: Math.max(0.02, this.dims.torsoH * 0.55 - this.dims.bodyW * 0.45),
        },
        {
          matrix: this.pelvis.matrixWorld,
          radius: this.dims.hipW * 0.5,
          height: Math.max(0.02, this.dims.torsoH * 0.35 - this.dims.hipW * 0.5),
        },
        { matrix: this.arms.L.sh.matrixWorld, radius: this.dims.bodyW * 0.24 },
        { matrix: this.arms.R.sh.matrixWorld, radius: this.dims.bodyW * 0.24 },
        // Clavicle bar: a horizontal capsule across the shoulder line
        // (chest local X). Shrinking the chest capsule uncovered the upper
        // chest laterally — strands slipped through at the collarbones.
        {
          matrix: this.chest.matrixWorld,
          radius: this.dims.bodyW * 0.26,
          height: this.dims.shoulderW * 0.75,
          axisCol: 0,
        },
        // The bust is proud of the chest capsule — without its own collider
        // front-falling strands vanished into it (stakeholder screenshot).
        ...(this.bustGroup
          ? [{ matrix: this.bustGroup.matrixWorld, radius: this.bustDims().r * 1.43 }]
          : []),
      ]);
    }
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
    // The fall writes root roll and height; everything else must clear them
    // or a revived character would stay lying down.
    this.root.rotation.z = 0;
    this.root.position.y = 0;
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
    // The staff-bearer's idle: the weapon arm reaches forward to the planted
    // staff and the body settles a little of its weight onto it.
    if (this.equipment.weapon && this.equipment.weaponKind === 'staff') {
      c.arms.R.sh.rotation.x = -0.52 + Math.sin(t * 1.4) * 0.02;
      c.arms.R.sh.rotation.z = -0.08;
      c.arms.R.el.rotation.x = -0.28;
      c.arms.R.hand.rotation.x = 0.2; // knuckles wrap the shaft
      c.chest.rotation.z = -0.028;    // lean toward the support
      c.head.rotation.z = 0.02;       // head counter-tilts level
    }
  }

  /*
   * Joint sign convention (learned the hard way — the review's "legs bend
   * incorrectly" was exactly this): the model faces +Z, and for any joint
   * whose child hangs BELOW it, rotation.x > 0 swings the child BACKWARD.
   * So: thighs forward = hip.x NEGATIVE; knees bend (shin back) = knee.x
   * POSITIVE; elbows bend (forearm forward) = elbow.x NEGATIVE.
   */

  /**
   * The ready stance: weight back on a braced rear leg, knees soft, weapon
   * up and the off hand raised to guard. Everything breathes faster than
   * the idle — this is a body expecting to be hit.
   */
  private animCombatIdle(t: number): void {
    const c = this;
    const breath = Math.sin(t * 2.6 + this.walkPhase);
    const shift = Math.sin(t * 1.1 + this.walkPhase);
    // Bladed stance: the body turns side-on to present less of itself.
    c.pelvis.rotation.y = -0.22;
    c.chest.rotation.y = 0.3;
    c.chest.rotation.x = 0.12 + breath * 0.015; // crouched forward
    c.spine.rotation.x = 0.06;
    c.head.rotation.y = -0.26 + Math.sin(t * 0.9) * 0.04; // eyes on the front
    c.pelvis.position.y = c.dims.hipY - 0.055 + Math.abs(breath) * 0.006;
    // Feet split fore-and-aft, both knees loaded.
    c.legs.R.hip.rotation.x = 0.3;
    c.legs.R.knee.rotation.x = 0.34;
    c.legs.R.hip.rotation.z = -0.12;
    c.legs.L.hip.rotation.x = -0.26;
    c.legs.L.knee.rotation.x = 0.3;
    c.legs.L.hip.rotation.z = 0.14;
    c.legs.L.foot.rotation.x = -0.12;

    if (this.castsSpells) {
      // The caster holds the stave upright and across, free hand open.
      c.arms.R.sh.rotation.x = -0.72 + breath * 0.03;
      c.arms.R.sh.rotation.z = -0.24;
      c.arms.R.el.rotation.x = -1.02;
      c.arms.L.sh.rotation.x = -0.34;
      c.arms.L.sh.rotation.z = 0.42;
      c.arms.L.el.rotation.x = -0.86;
    } else {
      // Sword up and across the body, point high and forward — a guard,
      // not an outstretched arm. The wrist cocks the blade up: without it
      // the abducted shoulder swings the point out sideways.
      c.arms.R.sh.rotation.x = -0.62 + breath * 0.035;
      c.arms.R.sh.rotation.z = -0.1;
      c.arms.R.el.rotation.x = -1.5;
      c.arms.R.hand.rotation.x = -0.75;
      c.arms.L.sh.rotation.x = -0.5;
      c.arms.L.sh.rotation.z = 0.32;
      c.arms.L.el.rotation.x = -1.15;
    }
    c.chest.rotation.z = shift * 0.02;
  }

  /**
   * Reaching over the shoulder to draw or stow. `d` is the draw fraction, so
   * the same curve runs backwards when sheathing — the hand meets the hilt
   * at the back at d=0 and finishes low and forward at d=1.
   */
  private animWeaponSwap(d: number): void {
    const c = this;
    // Peaks mid-motion: the arm is highest when the hand is at the scabbard.
    const reach = Math.sin(Math.PI * Math.min(1, Math.max(0, d)));
    c.arms.R.sh.rotation.x = -0.2 - reach * 1.5; // up and back over the shoulder
    c.arms.R.sh.rotation.z = -0.1 - reach * 0.55;
    c.arms.R.el.rotation.x = -0.3 - reach * 1.35;
    c.arms.R.hand.rotation.z = reach * 0.5;
    c.chest.rotation.y = reach * 0.22; // the torso twists into the reach
    c.head.rotation.y = reach * 0.1;
    c.arms.L.sh.rotation.x = -reach * 0.18;
  }

  /**
   * Attack variants (stakeholder: "a variety of different swing/stab
   * animations"). The server picks the index, so every observer sees the
   * same blow. Casters get their own wind-up-and-release instead.
   *
   * `f` runs 0→1 across the swing: wind up, strike, recover.
   */
  private animAttack(variant: number, f: number, t: number): void {
    const c = this;
    const clamp = Math.min(1, Math.max(0, f));
    // Wind-up occupies the first 35%, the strike snaps, then it recovers.
    const wind = Math.min(1, clamp / 0.35);
    const strike = clamp < 0.35 ? 0 : Math.min(1, (clamp - 0.35) / 0.25);
    const recover = clamp < 0.6 ? 0 : (clamp - 0.6) / 0.4;
    // Ease: slow load, fast release.
    const load = wind * wind;
    const hit = strike * (2 - strike);
    const settle = 1 - recover * recover;

    if (this.castsSpells) {
      // Cast: staff raised, then thrust forward as the bolt leaves it.
      c.chest.rotation.y = 0.24 * load - 0.34 * hit;
      c.chest.rotation.x = -0.1 * load + 0.18 * hit;
      c.arms.R.sh.rotation.x = -0.9 - 0.85 * load + 1.05 * hit;
      c.arms.R.sh.rotation.z = -0.22;
      c.arms.R.el.rotation.x = -1.1 + 0.75 * hit;
      c.arms.L.sh.rotation.x = -0.4 - 0.5 * hit;
      c.arms.L.sh.rotation.z = 0.5;
      c.arms.L.el.rotation.x = -0.9;
      c.pelvis.position.y = c.dims.hipY - 0.03 * settle;
      c.legs.L.hip.rotation.x = -0.18 * hit;
      c.legs.R.hip.rotation.x = 0.16 * hit;
      c.head.rotation.y = -0.12;
      return;
    }

    switch (variant % 4) {
      case 0: {
        // Overhead chop: both feet planted, the whole body falls into it.
        c.arms.R.sh.rotation.x = -0.5 - 2.0 * load + 2.6 * hit;
        c.arms.R.sh.rotation.z = -0.2;
        c.arms.R.el.rotation.x = -1.5 + 1.25 * hit;
        c.chest.rotation.x = -0.2 * load + 0.4 * hit;
        c.chest.rotation.y = 0.1 * load;
        c.pelvis.position.y = c.dims.hipY - 0.02 - 0.05 * hit;
        c.legs.R.knee.rotation.x = 0.2 + 0.3 * hit;
        c.legs.L.knee.rotation.x = 0.18 + 0.24 * hit;
        break;
      }
      case 1: {
        // Horizontal slash: torso winds right, unwinds through the target.
        c.chest.rotation.y = 0.62 * load - 1.0 * hit;
        c.pelvis.rotation.y = 0.24 * load - 0.4 * hit;
        c.arms.R.sh.rotation.x = -0.7 - 0.3 * load + 0.15 * hit;
        c.arms.R.sh.rotation.z = -0.5 - 0.4 * load + 0.9 * hit;
        c.arms.R.el.rotation.x = -1.15 + 0.85 * hit;
        c.arms.L.sh.rotation.z = 0.3 + 0.35 * hit;
        c.legs.R.hip.rotation.z = -0.12;
        c.legs.L.knee.rotation.x = 0.2;
        break;
      }
      case 2: {
        // Thrust: the point goes first, weight driving off the back foot.
        c.chest.rotation.y = 0.34 * load - 0.5 * hit;
        c.arms.R.sh.rotation.x = -0.5 - 0.45 * load - 0.5 * hit;
        c.arms.R.sh.rotation.z = -0.24;
        c.arms.R.el.rotation.x = -1.45 + 1.4 * hit;
        c.arms.R.hand.rotation.x = 0.3;
        c.arms.L.sh.rotation.x = -0.3 - 0.3 * hit;
        c.arms.L.sh.rotation.z = 0.4;
        // The lunge: front leg reaches, rear leg extends behind.
        c.legs.L.hip.rotation.x = -0.2 - 0.5 * hit;
        c.legs.L.knee.rotation.x = 0.24 + 0.3 * hit;
        c.legs.R.hip.rotation.x = 0.18 + 0.4 * hit;
        c.pelvis.position.y = c.dims.hipY - 0.03 - 0.07 * hit;
        break;
      }
      default: {
        // Backhand: a return cut from the off side, shorter and meaner.
        c.chest.rotation.y = -0.5 * load + 0.85 * hit;
        c.pelvis.rotation.y = -0.16 * load + 0.28 * hit;
        c.arms.R.sh.rotation.x = -0.85 - 0.2 * load;
        c.arms.R.sh.rotation.z = 0.35 * load - 0.95 * hit;
        c.arms.R.el.rotation.x = -1.35 + 0.95 * hit;
        c.arms.L.sh.rotation.z = 0.28;
        c.legs.R.knee.rotation.x = 0.2;
        break;
      }
    }
    // A little breath on the recovery so the pose does not freeze.
    c.head.rotation.x = 0.05 * hit + Math.sin(t * 3) * 0.01 * settle;
  }

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
    const fem = this.appearance.sex === 'female';
    // 3.7 rad/s and a quiet pelvis: at 4.2 with 3cm of bounce and bent
    // elbows the gait read as a JOG (stakeholder). A walk keeps one foot
    // down, barely bounces, and swings near-straight arms.
    const ph = t * 3.7 + this.walkPhase;
    const stride = Math.sin(ph);
    // Gait differentiation against the references (stakeholder walk-cycle
    // illustration vs Muybridge Plate 1): the female walk carries more hip
    // rotation and a narrower, quieter arm swing; the male more shoulder.
    c.pelvis.rotation.y = stride * (fem ? 0.13 : 0.09);
    c.pelvis.rotation.z = stride * (fem ? 0.055 : 0.04);
    c.spine.rotation.y = -stride * 0.055;
    c.chest.rotation.y = -stride * (fem ? 0.07 : 0.1);
    c.chest.rotation.x = 0.075; // Muybridge: a walker leans slightly in
    c.head.rotation.y = stride * 0.045;
    // Counter-rotation keeps the head level while hips roll.
    c.head.rotation.z = -stride * 0.02;
    const armAmp = fem ? 0.28 : 0.36;
    for (const s of ['L', 'R'] as const) {
      const o = s === 'L' ? 0 : Math.PI;
      const sg = s === 'L' ? 1 : -1;
      const swing = Math.sin(ph + o); // > 0: this leg strides FORWARD
      // The knee bends most just after the foot leaves the ground at the
      // rear and straightens for heel-strike at the front, with a smooth
      // raised-cosine hump (a clipped max() snaps at footfall).
      // Muybridge check (Plate 1, contact-sheet round 1): a walking swing
      // leg stays LOW, foot skimming the ground — the previous 1.05 rad
      // knee fold read as a soldier's high-step from every direction.
      // SWING TIMING against the gait cycle (Inman; stakeholder bob
      // report): toe-off must come AFTER the opposite heel strikes, never
      // before — the old +2.17 phase lifted the rear foot while the front
      // leg was still reaching, leaving single support on a fully tilted
      // leg and a 9cm crater in the pelvis path. +1.2 gives ~8% of the
      // cycle in double support at each step, like the reference.
      const lift = Math.pow(Math.max(0, Math.sin(ph + o + 1.2)), 1.6);
      // ASYMMETRIC hip range (Muybridge): the thigh reaches well forward
      // but extends only modestly behind — the symmetric ±25° pendulum was
      // half the wrongness of the leg action.
      const hipFwd = fem ? 0.48 : 0.52;
      const hipBack = 0.26;
      const hipAmp = hipBack + (hipFwd - hipBack) * (0.5 + 0.5 * swing);
      c.legs[s].hip.rotation.x = -swing * hipAmp + lift * 0.14;
      // Double knee action: the loading flex arrives WITH the heel
      // strike (peak just after contact, ~0.16 rad) so the body visibly
      // drops onto the front foot as it takes the weight — the old later
      // peak made the dip lag the strike (stakeholder report).
      const load = Math.pow(Math.max(0, Math.sin(ph + o - 0.93)), 3) * 0.13;
      // Stance-knee flexion through stance (Saunders' third gait
      // determinant): the support knee stays softly bent while the body
      // vaults over it, shaving the top off the inverted-pendulum arc.
      // Centred slightly PAST vertical, into terminal stance — that is
      // where the solved pelvis path actually peaks.
      const midFlex = Math.pow(Math.max(0, Math.sin(ph + o - 1.9)), 2) * 0.26;
      // Pre-swing knee break (terminal stance → toe-off): the trailing
      // knee folds while the toe is still down, UNLOADING the rear leg —
      // without this the toe-standing rear leg propped the body up
      // through double support and the dip missed the front foot's
      // strike entirely. Fades as the swing lift takes over.
      const preSwing = Math.pow(Math.max(0, Math.sin(ph + o - 3.9)), 3) * 0.32 * (1 - lift);
      c.legs[s].knee.rotation.x = lift * 0.68 + load + midFlex + preSwing + 0.05;
      // Foot roll (Muybridge side row): heel leading at the front, and a
      // STRONG heel rise at the rear push-off — the ankle rocker that
      // keeps the trailing leg effectively long through double support
      // and fills the valley of the pendulum arc (Inman: the heel is
      // well off the ground before the far heel strikes).
      c.legs[s].foot.rotation.x =
        -(c.legs[s].hip.rotation.x + c.legs[s].knee.rotation.x) * 0.55
        - Math.max(0, swing) * 0.1    // heel-strike: toes up at the front
        + Math.max(0, -swing) * 0.55; // toe-off: heel rises, foot points
      c.arms[s].sh.rotation.x = swing * armAmp; // opposite arm to leg
      c.arms[s].sh.rotation.z = sg * (fem ? 0.09 : 0.11);
      // Near-straight arms: a walker's elbow barely bends (Muybridge);
      // the old -0.55 peak was a jogger's carry.
      c.arms[s].el.rotation.x = -0.14 - Math.max(0, swing) * 0.12;
    }
    // GROUNDING (stakeholder: at no point may both feet be off the floor).
    // The old hand-tuned bounce constant never guaranteed contact — with
    // both legs splayed the geometric leg span shortens and both soles
    // hung in the air. Instead, solve each leg's contact height from its
    // actual angles and set the pelvis so the LOWER foot touches y=0; the
    // inverted-pendulum bob (high at mid-stance, dipping through double
    // support) then emerges from the geometry itself.
    const { hipY, hipW } = c.dims;
    const legLen = hipY - hipW * 0.11; // dims.hipY carries the ankle lift
    const upperLeg = legLen * 0.52;
    const lowerLeg = legLen * 0.48;
    const sole = hipW * 0.11;
    const toeLen = hipW * 0.3; // ankle→toe-tip reach along +z
    let need = 0;
    for (const s of ['L', 'R'] as const) {
      const sgn = s === 'L' ? 1 : -1;
      const hipRx = c.legs[s].hip.rotation.x;
      const kneeRx = c.legs[s].knee.rotation.x;
      const pitch = hipRx + kneeRx + c.legs[s].foot.rotation.x; // world foot pitch
      const drop = upperLeg * Math.cos(hipRx) + lowerLeg * Math.cos(hipRx + kneeRx);
      // Contact point: the sole when the foot is level-ish, the toe tip
      // when it points down at push-off (pitch > 0 = toes down).
      const contact = sole * Math.cos(pitch) + toeLen * Math.max(0, Math.sin(pitch));
      // Pelvis roll raises one hip socket and lowers the other.
      const hipLift = sgn * hipW * 0.24 * Math.sin(c.pelvis.rotation.z);
      need = Math.max(need, drop + contact - hipLift);
    }
    c.pelvis.position.y = need;
  }

  /** Puts every piece of this character (body, cape, loose hair) on a render
   * layer — the split shader draws layer 1 through the pixel quantiser. */
  setRenderLayer(layer: number): void {
    const apply = (o: THREE.Object3D) => o.traverse((x) => x.layers.set(layer));
    apply(this.root);
    if (this.cape) apply(this.cape.mesh);
    if (this.hair) apply(this.hair.looseGroup);
    if (this.robeSkirt) apply(this.robeSkirt.mesh);
    for (const s of this.robeSleeves) apply(s.cloth.mesh);
    for (const f of this.hoodFlaps) apply(f.cloth.mesh);
  }

  dispose(): void {
    this.parent.remove(this.root);
    if (this.cape) {
      this.parent.remove(this.cape.mesh);
      this.cape.dispose();
    }
    if (this.robeSkirt) {
      this.parent.remove(this.robeSkirt.mesh);
      this.robeSkirt.dispose();
    }
    for (const s of this.robeSleeves) {
      this.parent.remove(s.cloth.mesh);
      s.cloth.dispose();
    }
    for (const f of this.hoodFlaps) {
      this.parent.remove(f.cloth.mesh);
      f.cloth.dispose();
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
