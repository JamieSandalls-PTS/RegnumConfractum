import * as THREE from 'three';
import { fnv1a, mulberry32 } from '@rc/shared';

/**
 * Terrain built from area data (D-110): the snapshot's tile grid and legend
 * are the only inputs. Instanced meshes per tile kind — a 64×64 area is a
 * handful of draw calls. Per-tile variation is seeded from tile coordinates,
 * so every client renders the identical yard.
 */

interface WireArea {
  id: string;
  width: number;
  height: number;
  legend: Record<string, { walkable: boolean; kind: string }>;
  tiles: string[];
  transitions: { x: number; y: number }[];
}

const FLOOR_SHADES = [0x625d57, 0x6e6862, 0x534e49, 0x7a736b];
// Mid-tone albedo, deliberately: lighting and the quantiser darken the final
// image — near-black sources leave the palette nothing to bite on.
const WOOD_SHADES = [0x705a43, 0x7d654b, 0x66523e, 0x8a7052];
const WALL_SHADES = [0x57524b, 0x615b53, 0x4c4841];
const TABLE_SHADES = [0x4e3d2c, 0x5a4633];
const CHAIR_SHADES = [0x5c4732, 0x69523a, 0x53402d];
const HEARTH_STONE = [0x6a635a, 0x756d62];
const WATER_COLOR = 0x24303c;

export class Terrain {
  readonly group = new THREE.Group();
  /** Animated fire pieces, driven by update(t). */
  private flames: { mesh: THREE.Mesh; seed: number; baseY: number }[] = [];
  private fireLights: { light: THREE.PointLight; seed: number; base: number }[] = [];

  constructor(area: WireArea, parent: THREE.Object3D) {
    const tiles: { x: number; y: number; kind: string }[] = [];
    const kindAt = new Map<string, string>();
    for (let y = 0; y < area.height; y++) {
      const row = area.tiles[y]!;
      for (let x = 0; x < area.width; x++) {
        const def = area.legend[row[x]!]!;
        const known = ['floor', 'wood', 'wall', 'water', 'table', 'chair', 'hearth'];
        const kind = known.includes(def.kind) ? def.kind : def.walkable ? 'floor' : 'wall';
        tiles.push({ x, y, kind });
        kindAt.set(`${x}:${y}`, kind);
      }
    }
    const kindOf = (x: number, y: number): string => kindAt.get(`${x}:${y}`) ?? 'wall';

    this.addInstanced(
      tiles.filter((t) => t.kind === 'floor'),
      new THREE.BoxGeometry(0.94, 0.12, 0.94),
      (t, rnd, m) => {
        m.makeTranslation(t.x, -0.06 + rnd() * 0.015, t.y);
        return FLOOR_SHADES[Math.floor(rnd() * FLOOR_SHADES.length)]!;
      },
      { receiveShadow: true },
    );

    this.addInstanced(
      tiles.filter((t) => t.kind === 'wall'),
      new THREE.BoxGeometry(1.0, 1.0, 1.0),
      (t, rnd, m) => {
        // Ruined stubs, not full walls: at this camera elevation a wall of
        // height h occludes ~1.5h tiles of floor behind it, and full-height
        // walls swallowed characters standing beside them. Knee-to-waist
        // rubble can never hide a person and suits the decayed setting.
        // Full-height walls need a camera-side cutaway — revisit with the
        // area pipeline in M5.
        const h = 0.45 + rnd() * 0.3;
        m.makeScale(1, h, 1).setPosition(t.x, h / 2 - 0.02, t.y);
        return WALL_SHADES[Math.floor(rnd() * WALL_SHADES.length)]!;
      },
      { castShadow: true, receiveShadow: true },
    );

    this.addInstanced(
      tiles.filter((t) => t.kind === 'wood'),
      new THREE.BoxGeometry(0.98, 0.1, 0.98),
      (t, rnd, m) => {
        m.makeTranslation(t.x, -0.05, t.y);
        return WOOD_SHADES[Math.floor(rnd() * WOOD_SHADES.length)]!;
      },
      { receiveShadow: true },
    );

    // Tables and counters: waist height, sight passes over, movement doesn't.
    this.addInstanced(
      tiles.filter((t) => t.kind === 'table'),
      new THREE.BoxGeometry(0.92, 1.0, 0.92),
      (t, rnd, m) => {
        const h = 0.34 + rnd() * 0.05;
        m.makeScale(1, h, 1).setPosition(t.x, h / 2, t.y);
        return TABLE_SHADES[Math.floor(rnd() * TABLE_SHADES.length)]!;
      },
      { castShadow: true, receiveShadow: true },
    );

    this.addInstanced(
      tiles.filter((t) => t.kind === 'water'),
      new THREE.BoxGeometry(1.0, 0.04, 1.0),
      (t, _rnd, m) => {
        m.makeTranslation(t.x, -0.1, t.y);
        return WATER_COLOR;
      },
      { receiveShadow: true },
    );

    // Chairs: a seat on a leg plinth with a backrest, the backrest turned
    // AWAY from the nearest adjacent table so sitters face their table.
    const chairTiles = tiles.filter((t) => t.kind === 'chair');
    const chairAngle = (t: { x: number; y: number }): number => {
      // World: +x east, +z (tile y) south. Facing angle a rotates local -z
      // (backrest) away from the table.
      if (kindOf(t.x, t.y - 1) === 'table') return Math.PI; // table north → back south
      if (kindOf(t.x + 1, t.y) === 'table') return Math.PI / 2;
      if (kindOf(t.x - 1, t.y) === 'table') return -Math.PI / 2;
      return 0; // table south (or none): back north
    };
    this.addInstanced(
      chairTiles,
      new THREE.BoxGeometry(0.52, 0.09, 0.52),
      (t, rnd, m) => {
        m.makeRotationY(chairAngle(t) + (rnd() - 0.5) * 0.24).setPosition(t.x, 0.26, t.y);
        return CHAIR_SHADES[Math.floor(rnd() * CHAIR_SHADES.length)]!;
      },
      { castShadow: true, receiveShadow: true },
    );
    this.addInstanced(
      chairTiles,
      new THREE.BoxGeometry(0.4, 0.24, 0.4),
      (t, rnd, m) => {
        m.makeRotationY(chairAngle(t) + (rnd() - 0.5) * 0.24).setPosition(t.x, 0.1, t.y);
        return CHAIR_SHADES[Math.floor(rnd() * CHAIR_SHADES.length)]!;
      },
      { castShadow: false, receiveShadow: true },
    );
    this.addInstanced(
      chairTiles,
      new THREE.BoxGeometry(0.52, 0.44, 0.07).translate(0, 0, -0.225),
      (t, rnd, m) => {
        m.makeRotationY(chairAngle(t) + (rnd() - 0.5) * 0.24).setPosition(t.x, 0.5, t.y);
        return CHAIR_SHADES[Math.floor(rnd() * CHAIR_SHADES.length)]!;
      },
      { castShadow: true, receiveShadow: true },
    );

    // The hearth: stone chimney breast against its wall, a raised firebed,
    // glowing embers, animated flames and a flickering warm light. The
    // stone stays mid-tone (the albedo lesson: brighten the surface, not
    // the lights).
    const hearthTiles = tiles.filter((t) => t.kind === 'hearth');
    const hearthBack = (t: { x: number; y: number }): number => {
      if (kindOf(t.x, t.y - 1) === 'wall') return 0; // wall north: back at -z
      if (kindOf(t.x, t.y + 1) === 'wall') return Math.PI;
      if (kindOf(t.x - 1, t.y) === 'wall') return Math.PI / 2;
      return -Math.PI / 2;
    };
    this.addInstanced(
      hearthTiles,
      new THREE.BoxGeometry(1.0, 1.5, 0.4).translate(0, 0, -0.3),
      (t, rnd, m) => {
        m.makeRotationY(hearthBack(t)).setPosition(t.x, 0.75, t.y);
        return HEARTH_STONE[Math.floor(rnd() * HEARTH_STONE.length)]!;
      },
      { castShadow: true, receiveShadow: true },
    );
    this.addInstanced(
      hearthTiles,
      new THREE.BoxGeometry(1.0, 0.22, 0.9),
      (t, rnd, m) => {
        m.makeRotationY(hearthBack(t)).setPosition(t.x, 0.11, t.y);
        return HEARTH_STONE[Math.floor(rnd() * HEARTH_STONE.length)]!;
      },
      { castShadow: false, receiveShadow: true },
    );
    if (hearthTiles.length > 0) {
      const ember = new THREE.MeshLambertMaterial({
        color: 0x3a2418,
        emissive: 0xff5a1a,
        emissiveIntensity: 0.9,
      });
      const flameMat = new THREE.MeshBasicMaterial({ color: 0xffa73d });
      const flameCoreMat = new THREE.MeshBasicMaterial({ color: 0xffe08a });
      for (const t of hearthTiles) {
        const bed = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.08, 0.5), ember);
        bed.position.set(t.x, 0.26, t.y);
        this.group.add(bed);
        // Two faceted cones per tile, offset and out of phase.
        for (const [ox, oz, s, core] of [
          [-0.14, 0.04, 0.9, false], [0.12, -0.06, 1.1, false], [0, 0, 0.62, true],
        ] as [number, number, number, boolean][]) {
          const flame = new THREE.Mesh(
            new THREE.ConeGeometry(0.16 * s, 0.55 * s, 5),
            core ? flameCoreMat : flameMat,
          );
          flame.position.set(t.x + ox, 0.3 + 0.275 * s, t.y + oz);
          this.group.add(flame);
          this.flames.push({
            mesh: flame,
            seed: fnv1a(`fl:${t.x}:${t.y}:${ox}`) % 1000,
            baseY: flame.position.y,
          });
        }
      }
      // One light per contiguous hearth cluster, not per tile.
      const clusters: { x: number; y: number; n: number }[] = [];
      for (const t of hearthTiles) {
        const near = clusters.find((c) => Math.abs(c.x / c.n - t.x) <= 1.6 && Math.abs(c.y / c.n - t.y) <= 1.6);
        if (near) {
          near.x += t.x;
          near.y += t.y;
          near.n++;
        } else clusters.push({ x: t.x, y: t.y, n: 1 });
      }
      for (const c of clusters) {
        const light = new THREE.PointLight(0xff8a3d, 14, 9, 1.6);
        light.position.set(c.x / c.n, 1.0, c.y / c.n + 0.4);
        this.group.add(light);
        this.fireLights.push({ light, seed: fnv1a(`hl:${c.x}:${c.y}`) % 1000, base: 14 });
      }
    }

    // Way-markers on transition tiles: a worn threshold stone, warm-toned so
    // exits read at a glance.
    this.addInstanced(
      area.transitions,
      new THREE.BoxGeometry(0.8, 0.05, 0.8),
      (t, _rnd, m) => {
        m.makeTranslation(t.x, 0.03, t.y);
        return 0x9c6733;
      },
      { receiveShadow: true },
    );

    parent.add(this.group);
  }

  private addInstanced(
    tiles: { x: number; y: number }[],
    geometry: THREE.BufferGeometry,
    place: (t: { x: number; y: number }, rnd: () => number, m: THREE.Matrix4) => number,
    shadows: { castShadow?: boolean; receiveShadow?: boolean },
  ): void {
    if (tiles.length === 0) {
      geometry.dispose();
      return;
    }
    const mesh = new THREE.InstancedMesh(
      geometry,
      new THREE.MeshLambertMaterial(),
      tiles.length,
    );
    const m = new THREE.Matrix4();
    const color = new THREE.Color();
    tiles.forEach((t, i) => {
      const rnd = mulberry32(fnv1a(`${t.x}:${t.y}`));
      color.setHex(place(t, rnd, m));
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, color);
    });
    mesh.castShadow = shadows.castShadow ?? false;
    mesh.receiveShadow = shadows.receiveShadow ?? false;
    this.group.add(mesh);
  }

  /** Fire animation: flame flicker and light jitter, cheap layered sines. */
  update(t: number): void {
    for (const f of this.flames) {
      const p = t * 9 + f.seed;
      const s = 0.82 + 0.18 * Math.sin(p) * Math.sin(p * 0.37 + 1.3);
      f.mesh.scale.set(1, s, 1);
      f.mesh.position.y = f.baseY * (0.9 + 0.1 * s);
      f.mesh.rotation.y = t * (0.9 + (f.seed % 7) * 0.1);
      f.mesh.rotation.z = Math.sin(p * 0.53) * 0.06;
    }
    for (const l of this.fireLights) {
      const p = t * 7 + l.seed;
      l.light.intensity = l.base * (0.86 + 0.1 * Math.sin(p) + 0.04 * Math.sin(p * 2.71 + 0.8));
    }
  }

  dispose(parent: THREE.Object3D): void {
    parent.remove(this.group);
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.InstancedMesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
  }
}
