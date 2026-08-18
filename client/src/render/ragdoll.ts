import * as THREE from 'three';

/**
 * A verlet ragdoll (stakeholder, 2026-08-18: "I want them to ragdoll, not
 * just fall physics based").
 *
 * Same technique as the cloth (D-403) and for the same reason: particles
 * plus distance constraints, no physics engine. Fifteen particles sit at
 * the joints, bones are hard constraints between them, the torso is
 * cross-braced so it stays a torso, and the floor stops them. The result
 * is then read BACK onto the character's bones by pointing each one at its
 * child particle, so the existing rig and everything hanging off it —
 * cape, robe, hair — follows a body that is genuinely being simulated.
 *
 * Purely visual. Nothing here decides anything; the server already said
 * this character is dead (D-102).
 */

export type JointName =
  | 'pelvis' | 'chest' | 'head'
  | 'shoulderL' | 'elbowL' | 'handL'
  | 'shoulderR' | 'elbowR' | 'handR'
  | 'hipL' | 'kneeL' | 'footL'
  | 'hipR' | 'kneeR' | 'footR';

const JOINTS: JointName[] = [
  'pelvis', 'chest', 'head',
  'shoulderL', 'elbowL', 'handL',
  'shoulderR', 'elbowR', 'handR',
  'hipL', 'kneeL', 'footL',
  'hipR', 'kneeR', 'footR',
];

/** Bone links (hard) and braces (softer) that keep the body coherent. */
const BONES: [JointName, JointName][] = [
  ['pelvis', 'chest'], ['chest', 'head'],
  ['chest', 'shoulderL'], ['shoulderL', 'elbowL'], ['elbowL', 'handL'],
  ['chest', 'shoulderR'], ['shoulderR', 'elbowR'], ['elbowR', 'handR'],
  ['pelvis', 'hipL'], ['hipL', 'kneeL'], ['kneeL', 'footL'],
  ['pelvis', 'hipR'], ['hipR', 'kneeR'], ['kneeR', 'footR'],
];

/** Without these the torso folds flat and the shoulders meet the hips. */
const BRACES: [JointName, JointName][] = [
  ['shoulderL', 'shoulderR'], ['hipL', 'hipR'],
  ['shoulderL', 'hipL'], ['shoulderR', 'hipR'],
  ['shoulderL', 'hipR'], ['shoulderR', 'hipL'],
  ['head', 'shoulderL'], ['head', 'shoulderR'],
  ['pelvis', 'shoulderL'], ['pelvis', 'shoulderR'],
];

interface Particle {
  pos: THREE.Vector3;
  prev: THREE.Vector3;
  /** Collision radius against the floor — a head sits higher than a wrist. */
  radius: number;
}

export class Ragdoll {
  private p = new Map<JointName, Particle>();
  private links: { a: JointName; b: JointName; len: number; stiff: number }[] = [];
  private tmp = new THREE.Vector3();
  private tmpQ = new THREE.Quaternion();
  private tmpQ2 = new THREE.Quaternion();
  /** Settles to true once the body has stopped moving. */
  settled = false;
  private age = 0;

  /**
   * @param world  Joint positions in WORLD space, sampled from the posed
   *               skeleton at the moment of death — so the ragdoll starts
   *               exactly where the character was standing.
   * @param scale  Body width, for collision radii.
   * @param impulse World-space shove applied to the upper body.
   */
  constructor(
    world: Record<JointName, THREE.Vector3>,
    scale: number,
    impulse: THREE.Vector3,
  ) {
    for (const name of JOINTS) {
      const pos = world[name].clone();
      // Verlet stores velocity as the gap to the previous position.
      const prev = pos.clone();
      const radius = name === 'head' ? scale * 0.42
        : name === 'pelvis' || name === 'chest' ? scale * 0.4
          : scale * 0.2;
      this.p.set(name, { pos, prev, radius });
    }
    for (const [a, b] of BONES) {
      this.links.push({ a, b, len: world[a].distanceTo(world[b]), stiff: 1 });
    }
    for (const [a, b] of BRACES) {
      this.links.push({ a, b, len: world[a].distanceTo(world[b]), stiff: 0.55 });
    }
    // The blow lands on the upper body, which is why a struck body turns
    // as it goes down instead of tipping like a plank. It is applied on
    // the FIRST step, not here: in verlet the gap between pos and prev is
    // a per-STEP displacement, so seeding it without dt launches the body
    // across the map at sixty times the intended speed.
    this.pendingImpulse = impulse.clone();
  }

  private pendingImpulse: THREE.Vector3 | null = null;

  /** Upper body takes most of a blow; the legs barely feel it. */
  private static IMPULSE_SHARE: [JointName, number][] = [
    ['chest', 0.9], ['head', 1.0], ['shoulderL', 0.8], ['shoulderR', 0.8], ['pelvis', 0.35],
  ];

  step(dt: number, floorY = 0): void {
    if (this.settled) return;
    const GRAVITY = -11;
    const DAMP = 0.985;
    this.age += dt;
    // Convert the blow from a velocity into this step's displacement.
    if (this.pendingImpulse) {
      for (const [name, k] of Ragdoll.IMPULSE_SHARE) {
        this.p.get(name)!.prev.addScaledVector(this.pendingImpulse, -k * dt);
      }
      this.pendingImpulse = null;
    }
    let moved = 0;
    for (const q of this.p.values()) {
      const vx = (q.pos.x - q.prev.x) * DAMP;
      const vy = (q.pos.y - q.prev.y) * DAMP;
      const vz = (q.pos.z - q.prev.z) * DAMP;
      q.prev.copy(q.pos);
      q.pos.x += vx;
      q.pos.y += vy + GRAVITY * dt * dt;
      q.pos.z += vz;
      moved += Math.abs(vx) + Math.abs(vy) + Math.abs(vz);
    }

    // Constraint passes. Bones are near-rigid; braces give a little, which
    // is what stops a ragdoll looking like a wire armature.
    for (let iter = 0; iter < 8; iter++) {
      for (const link of this.links) {
        const pa = this.p.get(link.a)!;
        const pb = this.p.get(link.b)!;
        this.tmp.subVectors(pb.pos, pa.pos);
        const dist = this.tmp.length() || 1e-6;
        this.tmp.multiplyScalar(((dist - link.len) / dist) * 0.5 * link.stiff);
        pa.pos.add(this.tmp);
        pb.pos.sub(this.tmp);
      }
      // The floor, with friction: a dropped limb skids a little and stops.
      for (const q of this.p.values()) {
        const rest = floorY + q.radius;
        if (q.pos.y < rest) {
          q.pos.y = rest;
          const fx = (q.pos.x - q.prev.x) * 0.55;
          const fz = (q.pos.z - q.prev.z) * 0.55;
          q.prev.x = q.pos.x - fx;
          q.prev.z = q.pos.z - fz;
        }
      }
    }
    // Once it has stopped twitching, stop simulating it entirely: a corpse
    // lies on the floor for fifteen minutes (D-511) and must cost nothing.
    // The age guard matters: on the first step every particle still has
    // zero velocity, so without it the body "settles" before it falls.
    // A body that will not stop twitching must not keep the character in
    // a permanent "falling" state, so settling is also capped by time.
    if ((this.age > 0.6 && moved < 0.0006) || this.age > 6) this.settled = true;
  }

  position(name: JointName): THREE.Vector3 {
    return this.p.get(name)!.pos;
  }

  /**
   * Writes the simulated pose onto the rig. Each bone is turned so its own
   * child axis points at the child particle; limbs hang along -Y in this
   * rig and the torso rises along +Y, hence the per-bone axis.
   */
  applyTo(bones: {
    root: THREE.Object3D;
    pelvis: THREE.Object3D;
    spine: THREE.Object3D;
    chest: THREE.Object3D;
    neck: THREE.Object3D;
    head: THREE.Object3D;
    arms: Record<'L' | 'R', { sh: THREE.Object3D; el: THREE.Object3D }>;
    legs: Record<'L' | 'R', { hip: THREE.Object3D; knee: THREE.Object3D }>;
  }): void {
    const UP = new THREE.Vector3(0, 1, 0);
    const DOWN = new THREE.Vector3(0, -1, 0);
    // The root carries the body to where the pelvis particle is; every
    // rotation below is then relative to an unrotated root.
    bones.root.quaternion.identity();
    bones.root.position.copy(this.position('pelvis'));
    bones.pelvis.position.set(0, 0, 0);
    bones.spine.rotation.set(0, 0, 0);
    bones.neck.rotation.set(0, 0, 0);
    bones.root.updateMatrixWorld(true);

    /** Turns `bone` so `axis` (in its own space) points along a world dir. */
    const aim = (bone: THREE.Object3D, axis: THREE.Vector3, from: JointName, to: JointName): void => {
      this.tmp.subVectors(this.position(to), this.position(from));
      if (this.tmp.lengthSq() < 1e-8) return;
      this.tmp.normalize();
      this.tmpQ.setFromUnitVectors(axis, this.tmp);
      // Strip the parent's world rotation to get this bone's local one.
      bone.parent?.getWorldQuaternion(this.tmpQ2);
      bone.quaternion.copy(this.tmpQ2.invert()).multiply(this.tmpQ);
      bone.updateMatrixWorld(true);
    };

    aim(bones.pelvis, UP, 'pelvis', 'chest');
    aim(bones.chest, UP, 'chest', 'head');
    for (const s of ['L', 'R'] as const) {
      aim(bones.arms[s].sh, DOWN, `shoulder${s}` as JointName, `elbow${s}` as JointName);
      aim(bones.arms[s].el, DOWN, `elbow${s}` as JointName, `hand${s}` as JointName);
      aim(bones.legs[s].hip, DOWN, `hip${s}` as JointName, `knee${s}` as JointName);
      aim(bones.legs[s].knee, DOWN, `knee${s}` as JointName, `foot${s}` as JointName);
    }
    bones.root.updateMatrixWorld(true);
  }
}
