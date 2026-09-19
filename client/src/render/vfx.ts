import * as THREE from 'three';
import { MAX_MOTES, VfxDefSchema, type AttackShow, type VfxDef } from '@rc/shared';
import { LightRig } from './lights';
import { loadOneAsset } from './world-assets';

/**
 * Visual effects, drawn from content (D-639).
 *
 * A VFX is a definition in `content/vfx/` — particles, a light, a glow — and
 * this is the one thing that draws one, wherever it is asked for: standing in
 * an area (a fire in a fireplace), burning on a held weapon (a glowing
 * blade), leaving a weapon as a projectile (a fireball, or an arrow with a
 * trail) and landing as an impact. The editor and the authoring tool run this
 * same class on their stages, so what somebody tunes is what the game draws —
 * the promise D-543 and D-558 make for maps and bodies.
 *
 * ⚠ Everything here is PRESENTATION. Nothing decides anything; a projectile
 * that visibly misses did what the server said (D-102). Definitions arrive on
 * `render_content` (D-630), never as imports, so a Publish reaches a running
 * client without a rebuild.
 *
 * ⚠ Lights go through the `LightRig` pool (D-544), never as their own
 * `PointLight`: forty torches with a light each is a shader that loops forty
 * times per fragment. An effect re-registers its light every frame, which is
 * a Map write, and the rig hands the eight real lights to the nearest.
 *
 * ⚠ Motes are simulated in WORLD space, whatever they are attached to. A
 * held glow's parent is a bone at a scale of 0.01 with a bind matrix of its
 * own (D-563, D-614); parenting a particle system under that and undoing the
 * scale is the class of bug that made a sword a dot in a fist. Reading the
 * parent's world position each frame costs one matrix read and cannot be
 * wrong by a factor.
 */

const LAYER_CHARACTER = 1;

/** Motes stop being emitted this far from the point of view; they still age out. */
const EMIT_RANGE = 45;

/* ---------------------------------------------------------- definitions --- */

const DEFS = new Map<string, VfxDef>();
const warnedMissing = new Set<string>();

/** Replace the catalogue — from `render_content`, or a tool's own list. */
export function setVfxDefinitions(defs: readonly unknown[]): void {
  DEFS.clear();
  for (const raw of defs) {
    const parsed = VfxDefSchema.safeParse(raw);
    if (parsed.success) DEFS.set(parsed.data.id, parsed.data);
    else console.warn(`[vfx] a definition was refused: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }
}

export function vfxDefinition(id: string): VfxDef | null {
  return DEFS.get(id) ?? null;
}

export function vfxDefinitions(): readonly VfxDef[] {
  return [...DEFS.values()];
}

/** How many effects the client knows. For the verification hook. */
export function vfxCount(): number {
  return DEFS.size;
}

/* ---------------------------------------------------------- the system ---- */

/** Something that is burning and can be put out. */
export interface VfxHandle {
  stop(): void;
  readonly alive: boolean;
}

export interface SpawnOptions {
  scale?: number;
  /** Where the effect is each frame; returning null ends it. */
  follow?: () => THREE.Vector3 | null;
  /** The object the effect rides on — its world position, and its visibility. */
  parent?: THREE.Object3D;
}

interface Mote {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  age: number;
  life: number;
  phase: number;
}

interface Live {
  key: number;
  def: VfxDef;
  scale: number;
  origin: THREE.Vector3;
  follow: (() => THREE.Vector3 | null) | null;
  parent: THREE.Object3D | null;
  age: number;
  /** No more emission; the effect is removed once its motes have died. */
  stopped: boolean;
  emitAccum: number;
  motes: Mote[];
  points: THREE.Points | null;
  positions: Float32Array;
  colours: Float32Array;
  sizes: Float32Array;
  alphas: Float32Array;
  glow: THREE.Mesh | null;
  lightId: string | null;
  visible: boolean;
  placed: boolean;
}

interface Flight {
  group: THREE.Group;
  from: THREE.Vector3;
  to: THREE.Vector3;
  elapsed: number;
  duration: number;
  arc: number;
  impact: string | undefined;
  trail: VfxHandle | null;
  done: boolean;
}

const VERT = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  attribute vec3 aColour;
  uniform float uPixelsPerMetre;
  varying vec3 vColour;
  varying float vAlpha;
  void main() {
    vColour = aColour;
    vAlpha = aAlpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    // ⚠ Sized in METRES and converted with the camera's own scale. The game
    // camera is orthographic (D-102), where perspective attenuation by -mv.z
    // does nothing, so a size in pixels would grow as the player zoomed in.
    gl_PointSize = max(1.0, aSize * uPixelsPerMetre);
  }
`;

const FRAG = /* glsl */ `
  varying vec3 vColour;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - vec2(0.5));
    float a = smoothstep(0.5, 0.12, d) * vAlpha;
    if (a <= 0.002) discard;
    gl_FragColor = vec4(vColour, a);
  }
`;

const _v = new THREE.Vector3();
const _c0 = new THREE.Color();
const _c1 = new THREE.Color();
const _c = new THREE.Color();

function chainVisible(o: THREE.Object3D | null): boolean {
  for (let p = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}

function lerp(a: number, b: number, f: number): number {
  return a + (b - a) * f;
}

export class VfxSystem {
  private readonly group = new THREE.Group();
  private readonly live: Live[] = [];
  private readonly flights: Flight[] = [];
  private readonly rig: LightRig;
  private readonly ownsRig: boolean;
  private readonly uniforms = { uPixelsPerMetre: { value: 40 } };
  private readonly glowGeo = new THREE.SphereGeometry(1, 12, 8);
  private nextKey = 1;
  private disposed = false;

  constructor(private readonly scene: THREE.Scene, rig?: LightRig) {
    this.ownsRig = !rig;
    this.rig = rig ?? new LightRig(scene);
    this.group.name = 'vfx';
    scene.add(this.group);
  }

  /* ------------------------------------------------------------ placing -- */

  /** An effect standing in the area (D-639). Cleared as a set by `clearPlaced`. */
  place(vfx: string, x: number, y: number, z = 0, scale = 1): VfxHandle | null {
    const handle = this.spawn(vfx, new THREE.Vector3(x, z, y), { scale });
    if (handle) this.live[this.live.length - 1]!.placed = true;
    return handle;
  }

  clearPlaced(): void {
    for (const l of [...this.live]) if (l.placed) this.remove(l);
  }

  /**
   * Start an effect. A `loop` definition burns until its handle is stopped
   * (or its `follow` returns null); a one-shot bursts now and ends after its
   * duration. An id nothing defines draws nothing and says so ONCE — never a
   * stand-in effect that looks like somebody chose it.
   */
  spawn(vfx: string | VfxDef, at: THREE.Vector3, opts: SpawnOptions = {}): VfxHandle | null {
    if (this.disposed) return null;
    const def = typeof vfx === 'string' ? DEFS.get(vfx) : vfx;
    if (!def) {
      if (!warnedMissing.has(vfx as string)) {
        warnedMissing.add(vfx as string);
        console.warn(`[vfx] no definition '${vfx as string}' — nothing drawn`);
      }
      return null;
    }
    const scale = opts.scale ?? 1;
    const live: Live = {
      key: this.nextKey++,
      def,
      scale,
      origin: at.clone(),
      follow: opts.follow ?? null,
      parent: opts.parent ?? null,
      age: 0,
      stopped: false,
      emitAccum: 0,
      motes: [],
      points: null,
      positions: new Float32Array(0),
      colours: new Float32Array(0),
      sizes: new Float32Array(0),
      alphas: new Float32Array(0),
      glow: null,
      lightId: def.light ? `vfx:${this.nextKey}` : null,
      visible: true,
      placed: false,
    };
    if (live.parent) live.parent.getWorldPosition(live.origin);

    if (def.particles) {
      const n = MAX_MOTES;
      live.positions = new Float32Array(n * 3);
      live.colours = new Float32Array(n * 3);
      live.sizes = new Float32Array(n);
      live.alphas = new Float32Array(n);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(live.positions, 3));
      geo.setAttribute('aColour', new THREE.BufferAttribute(live.colours, 3));
      geo.setAttribute('aSize', new THREE.BufferAttribute(live.sizes, 1));
      geo.setAttribute('aAlpha', new THREE.BufferAttribute(live.alphas, 1));
      geo.setDrawRange(0, 0);
      const mat = new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
        blending: def.particles.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      });
      const points = new THREE.Points(geo, mat);
      points.frustumCulled = false;
      points.layers.set(LAYER_CHARACTER);
      this.group.add(points);
      live.points = points;
      // ⚠ A one-shot bursts NOW: `rate` is the whole burst, not a rate.
      if (!def.loop) for (let i = 0; i < Math.round(def.particles.rate); i++) this.emit(live);
    }
    if (def.glow) {
      const mat = new THREE.MeshBasicMaterial({
        color: def.glow.colour,
        transparent: true,
        opacity: def.glow.opacity,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const glow = new THREE.Mesh(this.glowGeo, mat);
      glow.layers.set(LAYER_CHARACTER);
      this.group.add(glow);
      live.glow = glow;
    }
    this.live.push(live);
    this.pose(live, 0);
    return this.handleFor(live);
  }

  /** The same effect riding on an object: a glow on the sword in a hand. */
  attach(vfx: string | VfxDef, parent: THREE.Object3D, scale = 1): VfxHandle | null {
    return this.spawn(vfx, new THREE.Vector3(), { parent, scale });
  }

  /**
   * What a blow SHOWS (D-639): the projectile leaves `from` for `to` at the
   * item's speed on its arc, an asset and/or a trailing effect, and the
   * impact plays where it lands. The attack effect itself is the caller's —
   * it plays at the muzzle when the swing begins, not when the shot leaves.
   */
  fireProjectile(show: AttackShow, from: THREE.Vector3, to: THREE.Vector3): void {
    const proj = show.projectile;
    if (!proj || this.disposed) return;
    const group = new THREE.Group();
    group.position.copy(from);
    group.layers.set(LAYER_CHARACTER);
    this.group.add(group);
    const flight: Flight = {
      group,
      from: from.clone(),
      to: to.clone(),
      elapsed: 0,
      duration: Math.max(0.05, from.distanceTo(to) / proj.speed),
      arc: proj.arc,
      impact: show.impact,
      trail: null,
      done: false,
    };
    if (proj.asset) {
      const [pack, asset] = proj.asset.split('/');
      if (pack && asset) {
        void loadOneAsset(pack, asset).then((obj) => {
          if (!obj || flight.done) return;
          const holder = alignProjectile(obj);
          holder.traverse((o) => o.layers.set(LAYER_CHARACTER));
          group.add(holder);
        });
      }
    }
    if (proj.vfx) {
      flight.trail = this.spawn(proj.vfx, from, {
        follow: () => (flight.done ? null : group.position),
      });
    }
    this.flights.push(flight);
  }

  /* ------------------------------------------------------------ per frame */

  /**
   * Advance everything. `focus` is where the player is (emission is culled
   * beyond `EMIT_RANGE` of it); `pixelsPerMetre` is the camera's scale, so a
   * mote's size in metres becomes the right number of pixels.
   */
  update(dt: number, t: number, focus: THREE.Vector3 | null, pixelsPerMetre: number): void {
    if (this.disposed) return;
    this.uniforms.uPixelsPerMetre.value = pixelsPerMetre;

    for (let i = this.flights.length - 1; i >= 0; i--) {
      const f = this.flights[i]!;
      f.elapsed += dt;
      const k = Math.min(1, f.elapsed / f.duration);
      const prev = _v.copy(f.group.position);
      f.group.position.copy(f.from).lerp(f.to, k);
      f.group.position.y += Math.sin(k * Math.PI) * f.arc;
      if (f.group.position.distanceToSquared(prev) > 1e-8) f.group.lookAt(f.group.position.clone().multiplyScalar(2).sub(prev));
      if (k >= 1) {
        f.done = true;
        f.trail?.stop();
        if (f.impact) this.spawn(f.impact, f.to);
        this.group.remove(f.group);
        this.flights.splice(i, 1);
      }
    }

    for (let i = this.live.length - 1; i >= 0; i--) {
      const l = this.live[i]!;
      if (l.follow) {
        const at = l.follow();
        if (!at) l.stopped = true;
        else l.origin.copy(at);
      }
      if (l.parent) {
        l.parent.getWorldPosition(l.origin);
        l.visible = chainVisible(l.parent);
      }
      l.age += dt;
      const oneShot = !l.def.loop;
      if (oneShot && l.age >= l.def.duration) l.stopped = true;

      const p = l.def.particles;
      if (p && l.def.loop && !l.stopped && l.visible) {
        const near = !focus || l.origin.distanceToSquared(focus) < EMIT_RANGE * EMIT_RANGE;
        if (near) {
          l.emitAccum += p.rate * dt;
          while (l.emitAccum >= 1 && l.motes.length < MAX_MOTES) {
            this.emit(l);
            l.emitAccum -= 1;
          }
          if (l.emitAccum >= 1) l.emitAccum = 0;
        }
      }
      if (p) this.stepMotes(l, p, dt);
      this.pose(l, t);

      if (l.stopped && l.motes.length === 0) this.remove(l);
    }
  }

  private emit(l: Live): void {
    const p = l.def.particles!;
    if (l.motes.length >= MAX_MOTES) return;
    const r = p.radius * l.scale;
    // Born inside a sphere of `radius`, not on it — a hearth burns through
    // its logs, not on a shell around them.
    const bx = (Math.random() * 2 - 1) * r;
    const by = (Math.random() * 2 - 1) * r;
    const bz = (Math.random() * 2 - 1) * r;
    let dx = 0;
    let dy = 0;
    let dz = 0;
    if (p.direction !== 'none') {
      const rx = Math.random() * 2 - 1;
      const ry = Math.random() * 2 - 1;
      const rz = Math.random() * 2 - 1;
      const rl = Math.hypot(rx, ry, rz) || 1;
      if (p.direction === 'out') {
        dx = rx / rl; dy = ry / rl; dz = rz / rl;
      } else {
        const base = p.direction === 'up' ? 1 : -1;
        dx = (rx / rl) * p.spread;
        dy = base * (1 - p.spread) + (ry / rl) * p.spread;
        dz = (rz / rl) * p.spread;
        const dl = Math.hypot(dx, dy, dz) || 1;
        dx /= dl; dy /= dl; dz /= dl;
      }
    }
    const speed = lerp(p.speed[0], p.speed[1], Math.random()) * l.scale;
    l.motes.push({
      x: l.origin.x + bx, y: l.origin.y + by, z: l.origin.z + bz,
      vx: dx * speed, vy: dy * speed, vz: dz * speed,
      age: 0,
      life: Math.max(0.05, lerp(p.life[0], p.life[1], Math.random())),
      phase: Math.random() * Math.PI * 2,
    });
  }

  private stepMotes(l: Live, p: NonNullable<VfxDef['particles']>, dt: number): void {
    _c0.set(p.colour[0]);
    _c1.set(p.colour[1]);
    let n = 0;
    for (let i = l.motes.length - 1; i >= 0; i--) {
      const m = l.motes[i]!;
      m.age += dt;
      if (m.age >= m.life) {
        l.motes.splice(i, 1);
        continue;
      }
      m.vy -= p.gravity * dt;
      // A wander, not a random walk: deterministic per mote so a paused frame
      // does not scatter them, and gentle enough to read as air.
      const wander = p.drift * l.scale;
      m.x += (m.vx + Math.sin(m.age * 3.1 + m.phase) * wander) * dt;
      m.y += m.vy * dt;
      m.z += (m.vz + Math.cos(m.age * 2.3 + m.phase) * wander) * dt;
    }
    for (const m of l.motes) {
      const f = m.age / m.life;
      l.positions[n * 3] = m.x;
      l.positions[n * 3 + 1] = m.y;
      l.positions[n * 3 + 2] = m.z;
      _c.copy(_c0).lerp(_c1, f);
      l.colours[n * 3] = _c.r;
      l.colours[n * 3 + 1] = _c.g;
      l.colours[n * 3 + 2] = _c.b;
      l.sizes[n] = lerp(p.size[0], p.size[1], f) * l.scale;
      // Full until the last third of its life, then out.
      l.alphas[n] = (f < 0.66 ? 1 : (1 - f) / 0.34) * (l.visible ? 1 : 0);
      n++;
    }
    if (l.points) {
      const geo = l.points.geometry;
      for (const name of ['position', 'aColour', 'aSize', 'aAlpha']) {
        (geo.getAttribute(name) as THREE.BufferAttribute).needsUpdate = true;
      }
      geo.setDrawRange(0, n);
    }
  }

  /** Put the glow and the light where the effect is now. */
  private pose(l: Live, t: number): void {
    const oneShot = !l.def.loop;
    const fade = oneShot ? Math.max(0, 1 - l.age / l.def.duration) : 1;
    const shown = l.visible && !(oneShot && l.stopped);
    if (l.glow && l.def.glow) {
      const g = l.def.glow;
      const pulse = 1 + g.pulse.amount * Math.sin(t * g.pulse.speed * Math.PI * 2 + l.key);
      l.glow.visible = shown;
      l.glow.position.set(l.origin.x, l.origin.y + g.height * l.scale, l.origin.z);
      l.glow.scale.setScalar(Math.max(1e-4, g.radius * l.scale * pulse));
      (l.glow.material as THREE.MeshBasicMaterial).opacity = g.opacity * fade;
    }
    if (l.lightId && l.def.light) {
      const li = l.def.light;
      if (shown && fade > 0) {
        this.rig.add(l.lightId, l.origin.x, l.origin.z, {
          color: new THREE.Color(li.colour).getHex(),
          intensity: li.intensity * fade * l.scale,
          radius: li.distance * l.scale,
          height: l.origin.y + li.height * l.scale,
          flicker: li.flicker.amount,
        });
      } else {
        this.rig.remove(l.lightId);
      }
    }
  }

  private remove(l: Live): void {
    const at = this.live.indexOf(l);
    if (at >= 0) this.live.splice(at, 1);
    l.stopped = true;
    if (l.points) {
      this.group.remove(l.points);
      l.points.geometry.dispose();
      (l.points.material as THREE.Material).dispose();
      l.points = null;
    }
    if (l.glow) {
      this.group.remove(l.glow);
      (l.glow.material as THREE.Material).dispose();
      l.glow = null;
    }
    if (l.lightId) this.rig.remove(l.lightId);
  }

  private handleFor(l: Live): VfxHandle {
    return {
      stop: () => {
        // A loop stops emitting and its motes die out; a one-shot ends now.
        l.stopped = true;
        if (l.def.loop) {
          if (l.glow) l.glow.visible = false;
          if (l.lightId) this.rig.remove(l.lightId);
        } else {
          this.remove(l);
        }
      },
      get alive() {
        return !l.stopped;
      },
    };
  }

  /** What is burning — the verification hook, not a feature. */
  stats(): { live: number; placed: number; motes: number; flights: number; lights: number } {
    return {
      live: this.live.length,
      placed: this.live.filter((l) => l.placed).length,
      motes: this.live.reduce((n, l) => n + l.motes.length, 0),
      flights: this.flights.length,
      lights: this.live.filter((l) => l.lightId !== null && !l.stopped).length,
    };
  }

  /** Where the live projectiles are, for a test to watch one fly. */
  flightPositions(): THREE.Vector3[] {
    return this.flights.map((f) => f.group.position.clone());
  }

  /** The LightRig this system reports to — the frame loop updates it. */
  get lights(): LightRig {
    return this.rig;
  }

  dispose(): void {
    this.disposed = true;
    for (const l of [...this.live]) this.remove(l);
    for (const f of this.flights) this.group.remove(f.group);
    this.flights.length = 0;
    this.scene.remove(this.group);
    this.glowGeo.dispose();
    if (this.ownsRig) this.rig.dispose();
  }
}

/**
 * Wrap a projectile mesh so it flies along +Z, tip first, about its middle.
 *
 * ⚠ Measured, not assumed. Packs disagree about which axis an arrow lies
 * along (D-561 found they disagree about units by 100×), and nothing in a
 * file listing says. The longest extent of the bounding box is the shaft;
 * the end with the smaller cross-section is the point. Returns a holder the
 * caller parents; the mesh itself is untouched apart from being centred.
 */
export function alignProjectile(obj: THREE.Object3D): THREE.Group {
  const holder = new THREE.Group();
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj);
  if (box.isEmpty()) {
    holder.add(obj);
    return holder;
  }
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const axis: 0 | 1 | 2 = size.x >= size.y && size.x >= size.z ? 0 : size.y >= size.z ? 1 : 2;
  const tipForward = tipIsPositive(obj, axis, box);
  obj.position.sub(centre);
  holder.add(obj);
  if (axis === 0) holder.rotation.y = tipForward ? -Math.PI / 2 : Math.PI / 2;
  else if (axis === 1) holder.rotation.x = tipForward ? Math.PI / 2 : -Math.PI / 2;
  else if (!tipForward) holder.rotation.y = Math.PI;
  return holder;
}

/** Whether the narrower end of the mesh lies at the positive end of `axis`. */
function tipIsPositive(obj: THREE.Object3D, axis: 0 | 1 | 2, box: THREE.Box3): boolean {
  const min = box.min.getComponent(axis);
  const max = box.max.getComponent(axis);
  const span = max - min || 1;
  let loExtent = 0;
  let hiExtent = 0;
  const v = new THREE.Vector3();
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const pos = mesh.geometry.getAttribute('position');
    if (!pos) return;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      const along = (v.getComponent(axis) - min) / span;
      const a1 = (axis + 1) % 3;
      const a2 = (axis + 2) % 3;
      const radial = Math.hypot(v.getComponent(a1), v.getComponent(a2));
      if (along < 0.15) loExtent = Math.max(loExtent, radial);
      else if (along > 0.85) hiExtent = Math.max(hiExtent, radial);
    }
  });
  return hiExtent <= loExtent;
}

/** The camera's scale: how many device pixels one metre covers at the focus. */
export function pixelsPerMetre(camera: THREE.OrthographicCamera, drawingBufferHeight: number): number {
  const worldHeight = (camera.top - camera.bottom) / camera.zoom;
  return worldHeight > 0 ? drawingBufferHeight / worldHeight : 40;
}

/* ------------------------------------------------- the active system ----- */

let active: VfxSystem | null = null;

/** The world's system, for visuals that want to hang an effect on themselves. */
export function setActiveVfx(system: VfxSystem | null): void {
  active = system;
}

export function activeVfx(): VfxSystem | null {
  return active;
}
