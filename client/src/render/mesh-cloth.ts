import * as THREE from 'three';
import { type ClothFile, type ClothSettings } from '@rc/shared';

/**
 * Cloth on a real mesh (D-631).
 *
 * The old solver (D-403, D-520) simulated a GENERATED grid — rows and
 * columns it made itself — pinned to a placeholder body. This one takes the
 * pack's own skinned mesh: its vertices are the particles, its triangles'
 * edges are the constraints, and which vertices hang free is read off the
 * bone weights the artist painted. A cape's collar is weighted to the spine
 * and stays where the animation puts it; the fall of the cape is weighted to
 * a chain of cape bones nothing animates, and those are the vertices that
 * swing.
 *
 * ⚠ The simulation runs in WORLD space, in metres, and draws through a PROXY
 * mesh parented to the scene rather than to the character. Gravity and wind
 * are world directions and a cape's inertia when its wearer turns is the
 * whole effect; a proxy under the (rotating, scaled) character would need
 * every position converted twice a frame. The skinned original is hidden, not
 * removed — the assembly and its caches are shared with every other instance
 * (D-571) and must not be mutated.
 *
 * ⚠ Pinned particles are re-read from the SKINNED position every substep
 * (`applyBoneTransform`), so the cloth follows whatever the animation does
 * to the bones it is pinned to, including a ragdoll.
 */

const tmp = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpC = new THREE.Vector3();
const SUBSTEP = 1 / 60;
const MAX_FRAME = 0.05;

interface Capsule {
  a: THREE.Object3D;
  b: THREE.Object3D | null;
  radius: number;
}

/** Seams are welded: two vertices at one place are one particle. */
function weld(position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): {
  vertexParticle: Uint32Array;
  count: number;
} {
  const keys = new Map<string, number>();
  const vertexParticle = new Uint32Array(position.count);
  let count = 0;
  for (let i = 0; i < position.count; i++) {
    const key = `${position.getX(i).toFixed(3)},${position.getY(i).toFixed(3)},${position.getZ(i).toFixed(3)}`;
    let p = keys.get(key);
    if (p === undefined) {
      p = count++;
      keys.set(key, p);
    }
    vertexParticle[i] = p;
  }
  return { vertexParticle, count };
}

export class MeshCloth {
  readonly proxy: THREE.Mesh;
  /** One representative vertex per particle, for reading the skinned pose. */
  private readonly rep: Uint32Array;
  private readonly vertexParticle: Uint32Array;
  private readonly pos: Float32Array;
  private readonly prev: Float32Array;
  private readonly pinned: Uint8Array;
  private readonly edges: Uint32Array;
  private readonly edgeRest: Float32Array;
  private readonly bends: Uint32Array;
  private readonly bendRest: Float32Array;
  private readonly colliders: Capsule[] = [];
  private readonly position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
  private readonly unit: number;
  private accumulator = 0;
  private windPhase = Math.random() * Math.PI * 2;
  private disposed = false;

  constructor(
    private readonly mesh: THREE.SkinnedMesh,
    public settings: ClothSettings,
    /** Whose feet the floor is measured from: the character's root. */
    private readonly anchor: THREE.Object3D,
  ) {
    const geometry = mesh.geometry;
    const position = geometry.getAttribute('position');
    this.position = position;
    const skinIndex = geometry.getAttribute('skinIndex');
    const skinWeight = geometry.getAttribute('skinWeight');
    // ⚠ The pack's FBX parts are NON-INDEXED triangle soup (measured: every
    // cape is), and so may a built part be. A sequential index makes them one
    // case: the weld below folds the duplicated corners into shared particles,
    // which is where the edges come from.
    const index = geometry.getIndex() ?? new THREE.BufferAttribute(
      Uint32Array.from({ length: position.count }, (_, i) => i), 1,
    );

    // How many metres one model unit is on THIS instance: the assembly is
    // centimetres scaled by 0.01 and then by the character's stature (D-577).
    mesh.updateMatrixWorld(true);
    this.unit = tmp.setFromMatrixColumn(mesh.matrixWorld, 1).length();

    const { vertexParticle, count } = weld(position);
    this.vertexParticle = vertexParticle;
    this.rep = new Uint32Array(count);
    for (let v = position.count - 1; v >= 0; v--) this.rep[vertexParticle[v]!] = v;

    // Free where the artist weighted it to a free bone, pinned otherwise.
    const free = new Set(settings.freeBones);
    const boneNames = mesh.skeleton.bones.map((b) => b.name);
    this.pinned = new Uint8Array(count).fill(1);
    const weightOnFree = new Float32Array(count);
    for (let v = 0; v < position.count; v++) {
      let w = 0;
      for (let k = 0; k < 4; k++) {
        const bone = boneNames[skinIndex.getComponent(v, k)];
        if (bone !== undefined && free.has(bone)) w += skinWeight.getComponent(v, k);
      }
      const p = vertexParticle[v]!;
      weightOnFree[p] = Math.max(weightOnFree[p]!, w);
    }
    for (let p = 0; p < count; p++) if (weightOnFree[p]! >= settings.freeWeight) this.pinned[p] = 0;

    // Particles start where the skinned mesh is right now.
    this.pos = new Float32Array(count * 3);
    this.prev = new Float32Array(count * 3);
    this.mesh.skeleton.update();
    for (let p = 0; p < count; p++) {
      this.skinnedWorld(this.rep[p]!, tmp);
      this.pos[p * 3] = tmp.x;
      this.pos[p * 3 + 1] = tmp.y;
      this.pos[p * 3 + 2] = tmp.z;
    }
    this.prev.set(this.pos);

    // Constraints from the triangles: every unique edge holds its length,
    // and every pair of triangles sharing an edge holds the distance across
    // it, which is what resists folding.
    const edgeSet = new Map<string, [number, number]>();
    const across = new Map<string, number[]>();
    const tri = index.array;
    for (let t = 0; t < tri.length; t += 3) {
      const a = vertexParticle[tri[t]!]!;
      const b = vertexParticle[tri[t + 1]!]!;
      const c = vertexParticle[tri[t + 2]!]!;
      for (const [x, y, z] of [[a, b, c], [b, c, a], [c, a, b]] as [number, number, number][]) {
        if (x === y) continue;
        const key = x < y ? `${x},${y}` : `${y},${x}`;
        if (!edgeSet.has(key)) edgeSet.set(key, [x, y]);
        (across.get(key) ?? across.set(key, []).get(key)!).push(z);
      }
    }
    const dist = (p: number, q: number): number => {
      const dx = this.pos[p * 3]! - this.pos[q * 3]!;
      const dy = this.pos[p * 3 + 1]! - this.pos[q * 3 + 1]!;
      const dz = this.pos[p * 3 + 2]! - this.pos[q * 3 + 2]!;
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    };
    const edges: number[] = [];
    const edgeRest: number[] = [];
    for (const [p, q] of edgeSet.values()) {
      if (this.pinned[p] && this.pinned[q]) continue;
      edges.push(p, q);
      edgeRest.push(dist(p, q));
    }
    const bends: number[] = [];
    const bendRest: number[] = [];
    for (const opposite of across.values()) {
      if (opposite.length < 2) continue;
      const [p, q] = [opposite[0]!, opposite[1]!];
      if (p === q || (this.pinned[p] && this.pinned[q])) continue;
      bends.push(p, q);
      bendRest.push(dist(p, q));
    }
    this.edges = Uint32Array.from(edges);
    this.edgeRest = Float32Array.from(edgeRest);
    this.bends = Uint32Array.from(bends);
    this.bendRest = Float32Array.from(bendRest);

    const byName = new Map(mesh.skeleton.bones.map((b) => [b.name, b]));
    for (const c of settings.colliders) {
      const a = byName.get(c.bone);
      if (!a) continue;
      this.colliders.push({ a, b: c.to ? byName.get(c.to) ?? null : null, radius: c.radius });
    }

    // The proxy: same triangles, same material, positions in world space.
    const proxyGeometry = new THREE.BufferGeometry();
    proxyGeometry.setIndex(index.clone());
    proxyGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(position.count * 3), 3));
    const uv = geometry.getAttribute('uv');
    if (uv) proxyGeometry.setAttribute('uv', uv.clone());
    this.proxy = new THREE.Mesh(proxyGeometry, mesh.material);
    this.proxy.name = `cloth:${mesh.name}`;
    this.proxy.frustumCulled = false;
    this.proxy.castShadow = mesh.castShadow;
    this.proxy.receiveShadow = mesh.receiveShadow;
    this.proxy.layers.mask = mesh.layers.mask;
    mesh.visible = false;
    this.writeBack();
  }

  get particleCount(): number {
    return this.pinned.length;
  }

  get freeCount(): number {
    let n = 0;
    for (const p of this.pinned) if (!p) n++;
    return n;
  }

  /**
   * The skinned, world-space position of a vertex right now.
   *
   * ⚠ `applyBoneTransform` takes the vertex IN the vector it is handed — it
   * does not read the position attribute itself (the older `boneTransform`
   * did). Handing it an empty vector skins the origin, which lands every
   * pinned particle on its bone's pivot and looks like a cape gathered into
   * a point at the collar.
   */
  private skinnedWorld(vertex: number, out: THREE.Vector3): THREE.Vector3 {
    out.fromBufferAttribute(this.position, vertex);
    this.mesh.applyBoneTransform(vertex, out);
    return out.applyMatrix4(this.mesh.matrixWorld);
  }

  /** Advance by a frame; `wind` is 0..1 from the world, `t` seconds. */
  step(dt: number, wind: number, t: number): void {
    if (this.disposed) return;
    this.accumulator += Math.min(MAX_FRAME, Math.max(0, dt));
    this.mesh.updateMatrixWorld(true);
    this.mesh.skeleton.update();
    let stepped = false;
    while (this.accumulator >= SUBSTEP) {
      this.accumulator -= SUBSTEP;
      this.substep(SUBSTEP, wind, t);
      stepped = true;
    }
    if (stepped) this.writeBack();
  }

  private substep(dt: number, wind: number, t: number): void {
    const s = this.settings;
    const n = this.pinned.length;
    const pos = this.pos;
    const prev = this.prev;

    // Wind: a direction that wanders, a strength that gusts.
    const dir = t * 0.11 + this.windPhase;
    const gust = wind * s.windStrength * s.windScale * (0.65 + 0.35 * Math.sin(t * 2.3 + this.windPhase));
    const wx = Math.cos(dir) * gust;
    const wz = Math.sin(dir) * gust;
    const gy = -s.gravity;
    const dt2 = dt * dt;

    for (let p = 0; p < n; p++) {
      const i = p * 3;
      if (this.pinned[p]) {
        this.skinnedWorld(this.rep[p]!, tmp);
        pos[i] = prev[i] = tmp.x;
        pos[i + 1] = prev[i + 1] = tmp.y;
        pos[i + 2] = prev[i + 2] = tmp.z;
        continue;
      }
      const x = pos[i]!;
      const y = pos[i + 1]!;
      const z = pos[i + 2]!;
      pos[i] = x + (x - prev[i]!) * s.damping + wx * dt2;
      pos[i + 1] = y + (y - prev[i + 1]!) * s.damping + gy * dt2;
      pos[i + 2] = z + (z - prev[i + 2]!) * s.damping + wz * dt2;
      prev[i] = x;
      prev[i + 1] = y;
      prev[i + 2] = z;
    }

    const floorY = this.anchor.getWorldPosition(tmpC).y + s.floor * this.unit * 100;
    const thickness = s.thickness * this.unit * 100;
    for (let it = 0; it < s.iterations; it++) {
      this.relax(this.edges, this.edgeRest, s.stiffness);
      if (s.bend > 0) this.relax(this.bends, this.bendRest, s.bend);
      for (const c of this.colliders) this.collide(c, thickness);
      for (let p = 0; p < n; p++) {
        if (this.pinned[p]) continue;
        if (pos[p * 3 + 1]! < floorY) pos[p * 3 + 1] = floorY;
      }
    }
  }

  private relax(pairs: Uint32Array, rest: Float32Array, k: number): void {
    const pos = this.pos;
    for (let e = 0; e < rest.length; e++) {
      const p = pairs[e * 2]!;
      const q = pairs[e * 2 + 1]!;
      const i = p * 3;
      const j = q * 3;
      let dx = pos[j]! - pos[i]!;
      let dy = pos[j + 1]! - pos[i + 1]!;
      let dz = pos[j + 2]! - pos[i + 2]!;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < 1e-9) continue;
      const diff = ((d - rest[e]!) / d) * k;
      dx *= diff;
      dy *= diff;
      dz *= diff;
      const pp = this.pinned[p]!;
      const pq = this.pinned[q]!;
      if (pp && pq) continue;
      const wp = pp ? 0 : pq ? 1 : 0.5;
      const wq = pq ? 0 : pp ? 1 : 0.5;
      pos[i] = pos[i]! + dx * wp;
      pos[i + 1] = pos[i + 1]! + dy * wp;
      pos[i + 2] = pos[i + 2]! + dz * wp;
      pos[j] = pos[j]! - dx * wq;
      pos[j + 1] = pos[j + 1]! - dy * wq;
      pos[j + 2] = pos[j + 2]! - dz * wq;
    }
  }

  private collide(c: Capsule, thickness: number): void {
    const a = c.a.getWorldPosition(tmp);
    const b = c.b ? c.b.getWorldPosition(tmpB) : tmpB.copy(a);
    const r = c.radius * this.unit * 100 + thickness;
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const abz = b.z - a.z;
    const ab2 = abx * abx + aby * aby + abz * abz;
    const pos = this.pos;
    for (let p = 0; p < this.pinned.length; p++) {
      if (this.pinned[p]) continue;
      const i = p * 3;
      const px = pos[i]!;
      const py = pos[i + 1]!;
      const pz = pos[i + 2]!;
      let u = ab2 > 0 ? ((px - a.x) * abx + (py - a.y) * aby + (pz - a.z) * abz) / ab2 : 0;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const cx = a.x + abx * u;
      const cy = a.y + aby * u;
      const cz = a.z + abz * u;
      const dx = px - cx;
      const dy = py - cy;
      const dz = pz - cz;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d >= r || d < 1e-9) continue;
      const push = r / d;
      pos[i] = cx + dx * push;
      pos[i + 1] = cy + dy * push;
      pos[i + 2] = cz + dz * push;
    }
  }

  private writeBack(): void {
    const attr = this.proxy.geometry.getAttribute('position') as THREE.BufferAttribute;
    const out = attr.array as Float32Array;
    for (let v = 0; v < this.vertexParticle.length; v++) {
      const p = this.vertexParticle[v]! * 3;
      out[v * 3] = this.pos[p]!;
      out[v * 3 + 1] = this.pos[p + 1]!;
      out[v * 3 + 2] = this.pos[p + 2]!;
    }
    attr.needsUpdate = true;
    this.proxy.geometry.computeVertexNormals();
  }

  /** A particle's current world position, for measuring. */
  particle(p: number, out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(this.pos[p * 3]!, this.pos[p * 3 + 1]!, this.pos[p * 3 + 2]!);
  }

  isPinned(p: number): boolean {
    return this.pinned[p] === 1;
  }

  dispose(): void {
    this.disposed = true;
    this.mesh.visible = true;
    this.proxy.parent?.remove(this.proxy);
    this.proxy.geometry.dispose();
  }
}

/* ------------------------------------------------------ the registry ---- */

/**
 * Which parts have cloth, off the wire (`render_content`, D-630). Keyed by
 * `pack/stem` because a part is only meaningful inside its pack.
 */
const registry = new Map<string, ClothSettings>();

export function setClothSettings(files: readonly ClothFile[]): void {
  registry.clear();
  for (const file of files) {
    for (const [stem, settings] of Object.entries(file.cloth)) registry.set(`${file.pack}/${stem}`, settings);
  }
}

export function clothFor(pack: string, stem: string): ClothSettings | null {
  return registry.get(`${pack}/${stem}`) ?? null;
}

export function clothCount(): number {
  return registry.size;
}
