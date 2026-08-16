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
const WATER_COLOR = 0x24303c;

export class Terrain {
  readonly group = new THREE.Group();

  constructor(area: WireArea, parent: THREE.Object3D) {
    const tiles: { x: number; y: number; kind: string }[] = [];
    for (let y = 0; y < area.height; y++) {
      const row = area.tiles[y]!;
      for (let x = 0; x < area.width; x++) {
        const def = area.legend[row[x]!]!;
        const known = ['floor', 'wood', 'wall', 'water', 'table'];
        const kind = known.includes(def.kind) ? def.kind : def.walkable ? 'floor' : 'wall';
        tiles.push({ x, y, kind });
      }
    }

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

  dispose(parent: THREE.Object3D): void {
    parent.remove(this.group);
    this.group.traverse((o) => {
      if (o instanceof THREE.InstancedMesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
  }
}
