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

interface Strand {
  pos: THREE.Vector3[];
  prev: THREE.Vector3[];
  off: THREE.Vector3;
  geom: THREE.BufferGeometry;
  seg: number;
}

export class HairSet {
  readonly group = new THREE.Group();
  private strands: Strand[] = [];

  constructor(private len: number, headH: number) {
    const N = 7;
    const SEG = 5;
    for (let s = 0; s < N; s++) {
      const ang = (s / N) * Math.PI * 2;
      const off = new THREE.Vector3(
        Math.cos(ang) * headH * 0.26,
        headH * 0.62,
        Math.sin(ang) * headH * 0.24,
      );
      const pos: THREE.Vector3[] = [];
      const prev: THREE.Vector3[] = [];
      for (let i = 0; i <= SEG; i++) {
        const v = new THREE.Vector3(off.x, off.y - i * (len / SEG), off.z);
        pos.push(v);
        prev.push(v.clone());
      }
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array((SEG + 1) * 3), 3));
      const mesh = new THREE.Line(geom, new THREE.LineBasicMaterial({ color: 0x1e1a17 }));
      mesh.frustumCulled = false;
      this.strands.push({ pos, prev, off, geom, seg: SEG });
      this.group.add(mesh);
    }
  }

  step(dt: number, wind: number, t: number, headMatrix: THREE.Matrix4): void {
    const g = new THREE.Vector3(0, -9.0, 0);
    const w = new THREE.Vector3(Math.sin(t * 2.1) * 0.6 + 0.4, 0, Math.cos(t * 1.4) * 0.5)
      .multiplyScalar(wind * 5.0);
    const d = new THREE.Vector3();
    for (const st of this.strands) {
      const anchor = st.off.clone().applyMatrix4(headMatrix);
      st.pos[0]!.copy(anchor);
      st.prev[0]!.copy(anchor);
      for (let i = 1; i < st.pos.length; i++) {
        const p = st.pos[i]!;
        const pr = st.prev[i]!;
        const vx = (p.x - pr.x) * 0.94;
        const vy = (p.y - pr.y) * 0.94;
        const vz = (p.z - pr.z) * 0.94;
        pr.copy(p);
        p.x += vx + (g.x + w.x) * dt * dt;
        p.y += vy + g.y * dt * dt;
        p.z += vz + (g.z + w.z) * dt * dt;
      }
      const segLen = this.len / st.seg;
      for (let it = 0; it < 8; it++) {
        for (let i = 0; i < st.pos.length - 1; i++) {
          const a = st.pos[i]!;
          const b = st.pos[i + 1]!;
          d.subVectors(b, a);
          const dist = d.length() || 1e-6;
          d.multiplyScalar(((dist - segLen) / dist) * (i === 0 ? 1.0 : 0.5));
          if (i !== 0) a.add(d);
          b.sub(d);
        }
      }
      const arr = st.geom.attributes.position!.array as Float32Array;
      for (let i = 0; i < st.pos.length; i++) {
        arr[i * 3] = st.pos[i]!.x;
        arr[i * 3 + 1] = st.pos[i]!.y;
        arr[i * 3 + 2] = st.pos[i]!.z;
      }
      st.geom.attributes.position!.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const st of this.strands) st.geom.dispose();
  }
}
