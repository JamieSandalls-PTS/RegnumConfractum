import * as THREE from 'three';
import { fnv1a } from '@rc/shared';

/**
 * A placed light source.
 *
 * ⚠ Declared HERE now. It used to come from `PROP_DEFS` — a brazier or a
 * wall torch carried its own light in content — and those types are gone with
 * the tile system (D-567). Nothing places one at the moment; the rig stays
 * because a pack asset that glows will want exactly this, and deleting it
 * would mean rebuilding the eight-light pool the next time somebody puts a
 * lantern on a wall (D-544).
 */
export interface PropLight {
  color: number;
  intensity: number;
  radius: number;
  height: number;
  flicker: number;
}

/**
 * Prop lighting (D-544): braziers, lanterns, torches and lit windows actually
 * light the ground around them.
 *
 * **The problem this solves is arithmetic, not aesthetics.** The town alone
 * carries around forty braziers and lantern posts. Every real light in a
 * Three.js scene is added to every lit material's shader, so forty point
 * lights is not "a bit slower" — it recompiles every material into something
 * that loops forty times per fragment, and on a large area it is the
 * difference between a game and a slideshow.
 *
 * So the rig keeps a **fixed pool of real lights** (eight) and hands them to
 * the nearest sources each frame. A player walking through the town sees the
 * braziers near them lit and the ones two streets away dark — which is very
 * close to what a real torch does anyway, and is invisible in play because
 * anything far enough to be dropped is too far to judge.
 *
 * Flicker is the hearth's, reused: layered sines, no randomness per frame, so
 * two clients watching the same brazier see the same flame.
 */

/** How many real lights exist. Everything else waits its turn. */
const POOL_SIZE = 8;

interface Source {
  id: string;
  x: number;
  y: number;
  light: PropLight;
  /** Fixed per source, so its flicker is its own and does not march in step. */
  seed: number;
}

export class LightRig {
  private sources = new Map<string, Source>();
  private pool: THREE.PointLight[] = [];
  private group = new THREE.Group();

  constructor(private scene: THREE.Scene) {
    for (let i = 0; i < POOL_SIZE; i++) {
      // distance 0 until used; intensity 0 so an unassigned light is inert.
      const light = new THREE.PointLight(0xffffff, 0, 10, 1.7);
      light.visible = false;
      this.pool.push(light);
      this.group.add(light);
    }
    scene.add(this.group);
  }

  /** Registers a light source at a tile. Safe to call twice for one id. */
  add(id: string, x: number, y: number, light: PropLight): void {
    this.sources.set(id, { id, x, y, light, seed: fnv1a(id) % 1000 });
  }

  remove(id: string): void {
    this.sources.delete(id);
  }

  clear(): void {
    this.sources.clear();
    for (const l of this.pool) l.visible = false;
  }

  get sourceCount(): number {
    return this.sources.size;
  }

  /** How many of the pool are currently lit — a test/inspection hook. */
  get activeCount(): number {
    return this.pool.filter((l) => l.visible).length;
  }

  /**
   * Assigns the pool to the sources nearest `focus` and flickers them.
   * Call once per frame with the point the camera is looking at.
   */
  update(focus: THREE.Vector3, t: number): void {
    if (this.sources.size === 0) {
      for (const l of this.pool) l.visible = false;
      return;
    }
    const near = [...this.sources.values()]
      .map((s) => ({ s, d: (s.x - focus.x) ** 2 + (s.y - focus.z) ** 2 }))
      // Out of range entirely: no point burning a pool slot on it.
      .filter((e) => e.d < (e.s.light.radius + 22) ** 2)
      .sort((a, b) => a.d - b.d)
      .slice(0, POOL_SIZE);

    for (let i = 0; i < this.pool.length; i++) {
      const light = this.pool[i]!;
      const entry = near[i];
      if (!entry) {
        light.visible = false;
        continue;
      }
      const { s } = entry;
      light.visible = true;
      light.color.setHex(s.light.color);
      light.distance = s.light.radius;
      light.position.set(s.x, s.light.height, s.y);
      // Layered sines rather than randomness: deterministic per source, so
      // the same brazier gutters the same way on every client.
      const p = t * 7 + s.seed;
      const wobble = s.light.flicker === 0
        ? 1
        : 1 - s.light.flicker * 0.28 * (0.5 + 0.5 * Math.sin(p) * Math.sin(p * 0.37 + 1.3))
          - s.light.flicker * 0.07 * Math.sin(p * 2.71 + 0.8);
      light.intensity = s.light.intensity * wobble;
    }
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.sources.clear();
    this.pool = [];
  }
}
