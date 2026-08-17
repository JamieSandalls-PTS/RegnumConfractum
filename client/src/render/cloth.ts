import * as THREE from 'three';

/**
 * Verlet cloth and hair (D-403): position-based chains with distance
 * constraints and a torso collider. ~100 lines each, no physics engine.
 * Wind arrives as a parameter — under D-305 it will be a world variable, so
 * capes react to weather for free.
 */

export class Cloth {
  private pos: THREE.Vector3[] = [];
  private prev: THREE.Vector3[] = [];
  private constraints: { a: number; b: number; len: number }[] = [];
  private geom: THREE.PlaneGeometry;
  readonly mesh: THREE.Mesh;

  constructor(
    private cols: number,
    private rows: number,
    private width: number,
    private height: number,
    color: number,
  ) {
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const v = new THREE.Vector3((x / (cols - 1) - 0.5) * width, (-y / (rows - 1)) * height, 0);
        this.pos.push(v);
        this.prev.push(v.clone());
      }
    }
    const idx = (x: number, y: number) => y * cols + x;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (x < cols - 1) this.addConstraint(idx(x, y), idx(x + 1, y));
        if (y < rows - 1) this.addConstraint(idx(x, y), idx(x, y + 1));
        if (x < cols - 1 && y < rows - 1) this.addConstraint(idx(x, y), idx(x + 1, y + 1));
      }
    }
    this.geom = new THREE.PlaneGeometry(width, height, cols - 1, rows - 1);
    this.mesh = new THREE.Mesh(
      this.geom,
      new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide }),
    );
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false; // vertices move in world space
  }

  private addConstraint(a: number, b: number): void {
    this.constraints.push({ a, b, len: this.pos[a]!.distanceTo(this.pos[b]!) });
  }

  step(dt: number, wind: number, t: number, chestMatrix: THREE.Matrix4): void {
    const cols = this.cols;
    const gravity = new THREE.Vector3(0, -9.0, 0);
    const w = new THREE.Vector3(
      Math.sin(t * 1.7) * 0.6 + 0.5,
      Math.sin(t * 2.3) * 0.2,
      Math.cos(t * 1.1) * 0.6 + 0.3,
    ).multiplyScalar(wind * 7.0);

    const acc = new THREE.Vector3();
    for (let i = cols; i < this.pos.length; i++) {
      const p = this.pos[i]!;
      const pr = this.prev[i]!;
      acc.copy(gravity).add(w);
      const vx = (p.x - pr.x) * 0.97;
      const vy = (p.y - pr.y) * 0.97;
      const vz = (p.z - pr.z) * 0.97;
      pr.copy(p);
      p.x += vx + acc.x * dt * dt;
      p.y += vy + acc.y * dt * dt;
      p.z += vz + acc.z * dt * dt;
    }

    // pin the top row to the shoulders in world space
    for (let x = 0; x < cols; x++) {
      const local = new THREE.Vector3((x / (cols - 1) - 0.5) * this.width, 0, -0.04);
      local.applyMatrix4(chestMatrix);
      this.pos[x]!.copy(local);
      this.prev[x]!.copy(local);
    }

    const d = new THREE.Vector3();
    const torso = new THREE.Vector3();
    for (let iter = 0; iter < 6; iter++) {
      for (const c of this.constraints) {
        const pa = this.pos[c.a]!;
        const pb = this.pos[c.b]!;
        d.subVectors(pb, pa);
        const dist = d.length() || 1e-6;
        d.multiplyScalar(((dist - c.len) / dist) * 0.5);
        if (c.a >= cols) pa.add(d);
        if (c.b >= cols) pb.sub(d);
      }
      torso.set(0, 0, 0).applyMatrix4(chestMatrix);
      for (let i = cols; i < this.pos.length; i++) {
        const p = this.pos[i]!;
        const ddx = p.x - torso.x;
        const ddz = p.z - torso.z;
        const rad = 0.2;
        const len = Math.hypot(ddx, ddz);
        if (len < rad && p.y < torso.y + 0.05 && p.y > torso.y - this.height * 0.6) {
          const s = rad / (len || 1e-6);
          p.x = torso.x + ddx * s;
          p.z = torso.z + ddz * s;
        }
      }
    }

    const arr = this.geom.attributes.position!.array as Float32Array;
    for (let i = 0; i < this.pos.length; i++) {
      arr[i * 3] = this.pos[i]!.x;
      arr[i * 3 + 1] = this.pos[i]!.y;
      arr[i * 3 + 2] = this.pos[i]!.z;
    }
    this.geom.attributes.position!.needsUpdate = true;
    this.geom.computeVertexNormals();
  }

  dispose(): void {
    this.geom.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

/** One physics lock: a verlet chain rendered as solid tapered segments. */
interface Lock {
  pos: THREE.Vector3[];
  prev: THREE.Vector3[];
  /** Anchor offset in head-bone space. */
  off: THREE.Vector3;
  meshes: THREE.Mesh[];
  segLen: number;
}

import type { HairStyle } from '@rc/shared';

/**
 * Solid hair (v2, stakeholder pass 2026-08-17): a shaped rigid mass fitted to
 * the cranium — hair reads as a SHAPE, not spaghetti — plus a few chunky
 * physics locks (verlet chains rendered as tapered solid segments) that
 * wobble and flow. Style comes from the appearance seed:
 *   crop — the cap alone        bob  — cap + jaw-length shell
 *   tail — cap + one back lock  long — cap + shell + three locks
 */
export class SolidHair {
  /** Rigid meshes, parented to the head bone by the constructor. */
  private capGroup = new THREE.Group();
  /** World-space physics meshes — the caller adds this to the scene. */
  readonly looseGroup = new THREE.Group();
  private locks: Lock[] = [];
  private headRadius: number;
  private headCenter: THREE.Vector3;

  constructor(
    style: HairStyle,
    len: number,
    headH: number,
    color: number,
    headBone: THREE.Object3D,
  ) {
    this.headRadius = headH * 0.36;
    this.headCenter = new THREE.Vector3(0, headH * 0.42, 0);
    const mat = () => new THREE.MeshLambertMaterial({ color });

    // The cap: a close-fitting shell just proud of the cranium, pulled down
    // at the back. Every style has one — hair grows from the whole scalp.
    const cap = new THREE.Mesh(
      new THREE.SphereGeometry(headH * 0.365, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.56),
      mat(),
    );
    cap.position.set(0, headH * 0.46, -headH * 0.02);
    cap.castShadow = true;
    this.capGroup.add(cap);

    if (style === 'bob' || style === 'long') {
      // A jaw-length shell around sides and back — the solid silhouette.
      const shell = new THREE.Mesh(
        new THREE.SphereGeometry(headH * 0.38, 12, 8, Math.PI * 0.15, Math.PI * 1.7, Math.PI * 0.3, Math.PI * 0.52),
        mat(),
      );
      shell.rotation.y = Math.PI; // opening faces the face
      shell.position.set(0, headH * 0.42, -headH * 0.04);
      shell.castShadow = true;
      this.capGroup.add(shell);
    }
    headBone.add(this.capGroup);

    // Physics locks.
    const lockDefs: { off: THREE.Vector3; len: number; width: number }[] = [];
    if (style === 'tail') {
      lockDefs.push({
        off: new THREE.Vector3(0, headH * 0.62, -headH * 0.32),
        len: len * 1.3 + headH * 0.4,
        width: headH * 0.2,
      });
    } else if (style === 'long') {
      lockDefs.push(
        { off: new THREE.Vector3(0, headH * 0.5, -headH * 0.34), len: len * 1.5 + headH * 0.5, width: headH * 0.24 },
        { off: new THREE.Vector3(headH * 0.3, headH * 0.42, -headH * 0.16), len: len * 1.2 + headH * 0.35, width: headH * 0.15 },
        { off: new THREE.Vector3(-headH * 0.3, headH * 0.42, -headH * 0.16), len: len * 1.2 + headH * 0.35, width: headH * 0.15 },
      );
    }
    const SEG = 3;
    for (const def of lockDefs) {
      const pos: THREE.Vector3[] = [];
      const prev: THREE.Vector3[] = [];
      for (let i = 0; i <= SEG; i++) {
        const v = new THREE.Vector3(def.off.x, def.off.y - i * (def.len / SEG), def.off.z);
        pos.push(v);
        prev.push(v.clone());
      }
      const meshes: THREE.Mesh[] = [];
      for (let i = 0; i < SEG; i++) {
        const w = def.width * (1 - i * 0.22);
        const seg = new THREE.Mesh(
          new THREE.BoxGeometry(w, def.len / SEG + w * 0.3, w * 0.8),
          mat(),
        );
        seg.castShadow = true;
        seg.frustumCulled = false;
        meshes.push(seg);
        this.looseGroup.add(seg);
      }
      this.locks.push({ pos, prev, off: def.off, meshes, segLen: def.len / SEG });
    }
  }

  setVisible(v: boolean): void {
    this.capGroup.visible = v;
    this.looseGroup.visible = v;
  }

  step(dt: number, wind: number, t: number, headMatrix: THREE.Matrix4): void {
    if (this.locks.length === 0) return;
    const g = new THREE.Vector3(0, -9.0, 0);
    const w = new THREE.Vector3(Math.sin(t * 2.1) * 0.6 + 0.4, 0, Math.cos(t * 1.4) * 0.5)
      .multiplyScalar(wind * 4.0);
    const d = new THREE.Vector3();
    const headWorld = this.headCenter.clone().applyMatrix4(headMatrix);
    const up = new THREE.Vector3(0, -1, 0);
    const q = new THREE.Quaternion();

    for (const lock of this.locks) {
      const anchor = lock.off.clone().applyMatrix4(headMatrix);
      lock.pos[0]!.copy(anchor);
      lock.prev[0]!.copy(anchor);
      for (let i = 1; i < lock.pos.length; i++) {
        const p = lock.pos[i]!;
        const pr = lock.prev[i]!;
        const vx = (p.x - pr.x) * 0.9;
        const vy = (p.y - pr.y) * 0.9;
        const vz = (p.z - pr.z) * 0.9;
        pr.copy(p);
        p.x += vx + (g.x + w.x) * dt * dt;
        p.y += vy + g.y * dt * dt;
        p.z += vz + (g.z + w.z) * dt * dt;
      }
      for (let it = 0; it < 8; it++) {
        for (let i = 0; i < lock.pos.length - 1; i++) {
          const a = lock.pos[i]!;
          const b = lock.pos[i + 1]!;
          d.subVectors(b, a);
          const dist = d.length() || 1e-6;
          d.multiplyScalar(((dist - lock.segLen) / dist) * (i === 0 ? 1.0 : 0.5));
          if (i !== 0) a.add(d);
          b.sub(d);
        }
        // Keep locks off the face: push nodes outside the cranium sphere.
        for (let i = 1; i < lock.pos.length; i++) {
          const p = lock.pos[i]!;
          d.subVectors(p, headWorld);
          const dist = d.length();
          const min = this.headRadius * 1.02;
          if (dist < min) p.copy(headWorld).addScaledVector(d, min / (dist || 1e-6));
        }
      }
      // Solid segments follow the chain: midpoint position, oriented along it.
      for (let i = 0; i < lock.meshes.length; i++) {
        const a = lock.pos[i]!;
        const b = lock.pos[i + 1]!;
        const mesh = lock.meshes[i]!;
        mesh.position.copy(a).add(b).multiplyScalar(0.5);
        d.subVectors(b, a).normalize();
        q.setFromUnitVectors(up, d);
        mesh.quaternion.copy(q);
      }
    }
  }

  dispose(): void {
    this.capGroup.parent?.remove(this.capGroup);
    for (const group of [this.capGroup, this.looseGroup]) {
      group.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
    }
  }
}
