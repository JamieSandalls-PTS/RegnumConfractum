import * as THREE from 'three';
import { WALL_KINDS, fnv1a, mulberry32 } from '@rc/shared';
import { applyOcclusionFade } from './occlusion';

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
// Raised for full height (D-542): at knee height these read fine, but a
// 2.5-unit wall is mostly in its own shadow and the old mid-greys arrived as
// black slabs. The albedo lesson again — brighten the surface, not the lights.
// The wall family (D-545). Each kind is a different material, and they are
// told apart by colour and by how ragged their top course is — silhouette
// does as much work as albedo at this camera angle.
const WALL_SHADES = [0x8a8175, 0x958b7e, 0x7d746a, 0x9d9384];
const WALL_MATERIALS: Record<string, { shades: number[]; height: number; jitter: number; cap: boolean }> = {
  wall: { shades: WALL_SHADES, height: 2.45, jitter: 0.16, cap: true },
  'wall-timber': { shades: [0x7d6446, 0x8a6f4e, 0x6d573c, 0x94795a], height: 2.35, jitter: 0.1, cap: true },
  'wall-plaster': { shades: [0xb3a894, 0xc0b49e, 0xa89c88, 0xbfb6a4], height: 2.4, jitter: 0.08, cap: true },
  'wall-brick': { shades: [0x8e5a48, 0x9a6350, 0x7f5040, 0xa06b56], height: 2.5, jitter: 0.12, cap: true },
  'wall-cave': { shades: [0x6f6a62, 0x7b756c, 0x635e57, 0x847d73], height: 2.9, jitter: 0.55, cap: false },
  palisade: { shades: [0x6a563c, 0x776146, 0x5e4c35], height: 2.6, jitter: 0.3, cap: false },
};
const TABLE_SHADES = [0x4e3d2c, 0x5a4633];
const CHAIR_SHADES = [0x5c4732, 0x69523a, 0x53402d];
const HEARTH_STONE = [0x6a635a, 0x756d62];
const WATER_COLOR = 0x24303c;
// The round map's own kinds (D-529's cross), which used to fall through to
// grey floor and knee-high grey stubs — the single biggest reason the world
// looked bare. Grass is a spoke you can read at a glance; dirt is worked
// ground; tree and rock are the obstacles that give a spoke its texture.
// Olive rather than meadow: this is a decayed empire, not a golf course.
// Bright enough for the quantiser to bite on, dull enough to sit beside the
// stone and the cloth without shouting.
const GRASS_SHADES = [0x55603c, 0x5e6943, 0x4b5536, 0x646f48];
const DIRT_SHADES = [0x796450, 0x6d5a48, 0x847059, 0x635244];
const TRUNK_SHADES = [0x6a5238, 0x7a5f42, 0x5c4730];
const LEAF_SHADES = [0x47593a, 0x506442, 0x3e5133, 0x5a6d46];
const BOULDER_SHADES = [0x847b70, 0x746c62, 0x938a7e];

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
        const known = [
          'floor', 'wood', 'water', 'table', 'chair', 'hearth',
          'grass', 'dirt', 'tree', 'rock',
          ...WALL_KINDS,
        ];
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

    // Full-height walls at last (D-542), now in materials (D-545). The old
    // comment here explained why they had to be knee-high — at this camera
    // elevation a wall of height h hides ~1.5h tiles behind it — and asked for
    // a camera-side cutaway before raising them. `occlusion.ts` is that
    // cutaway, so a wall can be a wall.
    for (const kind of WALL_KINDS) {
      if (kind === 'wall-forest') continue; // built as trees, below
      const spec = WALL_MATERIALS[kind]!;
      const kindTiles = tiles.filter((t) => t.kind === kind);
      if (kindTiles.length === 0) continue;
      const heightOf = (t: { x: number; y: number }, rnd: () => number): number => {
        const ruined = rnd() < 0.07;
        return ruined ? 0.55 + rnd() * 0.35 : spec.height + rnd() * spec.jitter;
      };
      this.addInstanced(
        kindTiles,
        new THREE.BoxGeometry(1.0, 1.0, 1.0),
        (t, rnd, m) => {
          const h = heightOf(t, rnd);
          m.makeScale(1.02, h, 1.02).setPosition(t.x, h / 2 - 0.02, t.y);
          return spec.shades[Math.floor(rnd() * spec.shades.length)]!;
        },
        { castShadow: true, receiveShadow: true, occludes: true },
      );
      if (spec.cap) {
        // A capstone course, so the top of a wall reads as masonry rather
        // than as the end of a box.
        this.addInstanced(
          kindTiles.filter((t) => (fnv1a(`${t.x}:${t.y}`) & 7) > 0),
          new THREE.BoxGeometry(1.06, 0.14, 1.06),
          (t, rnd, m) => {
            const h = heightOf(t, rnd);
            m.makeTranslation(t.x, h, t.y);
            return spec.shades[(Math.floor(rnd() * spec.shades.length) + 1) % spec.shades.length]!;
          },
          { castShadow: true, receiveShadow: true, occludes: true },
        );
      }
      if (kind === 'palisade') {
        // Sharpened tops: a palisade is stakes, and the silhouette is the
        // whole point of choosing one over a stone wall.
        this.addInstanced(
          kindTiles,
          new THREE.ConeGeometry(0.5, 0.5, 4),
          (t, rnd, m) => {
            const h = heightOf(t, rnd);
            m.makeRotationY(Math.PI / 4).setPosition(t.x, h + 0.24, t.y);
            return spec.shades[Math.floor(rnd() * spec.shades.length)]!;
          },
          { castShadow: true, receiveShadow: true, occludes: true },
        );
      }
    }

    // A treeline used as a boundary (stakeholder, D-545): the way to close
    // off open ground without a stone wall appearing in a field.
    const forestTiles = tiles.filter((t) => t.kind === 'wall-forest');
    this.addInstanced(
      forestTiles,
      new THREE.CylinderGeometry(0.2, 0.3, 3.4, 6),
      (t, rnd, m) => {
        const h = 0.9 + rnd() * 0.4;
        m.makeScale(1, h, 1).setPosition(t.x, 1.7 * h, t.y);
        return TRUNK_SHADES[Math.floor(rnd() * TRUNK_SHADES.length)]!;
      },
      { castShadow: true, receiveShadow: true, occludes: true },
    );
    for (const [tier, radius, height, lift] of [
      [0, 1.2, 1.8, 2.5], [1, 0.9, 1.5, 3.5], [2, 0.55, 1.1, 4.3],
    ] as const) {
      this.addInstanced(
        forestTiles.filter((t) => tier === 0 || (fnv1a(`fw${tier}:${t.x}:${t.y}`) & 3) !== 0),
        new THREE.ConeGeometry(radius, height, 7),
        (t, rnd, m) => {
          const h = 0.9 + rnd() * 0.4;
          m.makeRotationY(rnd() * 2).setPosition(t.x, lift * h, t.y);
          return LEAF_SHADES[Math.floor(rnd() * LEAF_SHADES.length)]!;
        },
        { castShadow: true, receiveShadow: true, occludes: true },
      );
    }

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

    // --- the round map's ground (D-529's cross) --------------------------
    this.addInstanced(
      tiles.filter((t) => t.kind === 'grass'),
      new THREE.BoxGeometry(0.98, 0.12, 0.98),
      (t, rnd, m) => {
        m.makeTranslation(t.x, -0.06 + rnd() * 0.02, t.y);
        return GRASS_SHADES[Math.floor(rnd() * GRASS_SHADES.length)]!;
      },
      { receiveShadow: true },
    );
    // Tufts on a scattering of grass tiles: enough to break the flatness,
    // sparse enough that a hundred-tile field is still a handful of draws.
    this.addInstanced(
      tiles.filter((t) => t.kind === 'grass' && (fnv1a(`tuft:${t.x}:${t.y}`) & 7) === 0),
      new THREE.BoxGeometry(0.16, 0.22, 0.16),
      (t, rnd, m) => {
        m.makeRotationY(rnd() * 3).setPosition(
          t.x + (rnd() - 0.5) * 0.5, 0.08, t.y + (rnd() - 0.5) * 0.5,
        );
        return LEAF_SHADES[Math.floor(rnd() * LEAF_SHADES.length)]!;
      },
      { castShadow: false, receiveShadow: true },
    );

    this.addInstanced(
      tiles.filter((t) => t.kind === 'dirt'),
      new THREE.BoxGeometry(0.98, 0.12, 0.98),
      (t, rnd, m) => {
        m.makeTranslation(t.x, -0.06 + rnd() * 0.02, t.y);
        return DIRT_SHADES[Math.floor(rnd() * DIRT_SHADES.length)]!;
      },
      { receiveShadow: true },
    );
    // Loose stones on worked ground — the mine and the road read as used.
    this.addInstanced(
      tiles.filter((t) => t.kind === 'dirt' && (fnv1a(`grit:${t.x}:${t.y}`) & 15) === 0),
      new THREE.BoxGeometry(0.2, 0.1, 0.17),
      (t, rnd, m) => {
        m.makeRotationY(rnd() * 3).setPosition(
          t.x + (rnd() - 0.5) * 0.55, 0.04, t.y + (rnd() - 0.5) * 0.55,
        );
        return BOULDER_SHADES[Math.floor(rnd() * BOULDER_SHADES.length)]!;
      },
      { castShadow: true, receiveShadow: true },
    );

    // Trees: a real trunk and a real crown, instanced. These were rendering
    // as knee-high grey stubs, which is why a wood looked like a car park.
    const treeTiles = tiles.filter((t) => t.kind === 'tree');
    this.addInstanced(
      treeTiles,
      new THREE.CylinderGeometry(0.16, 0.24, 3.2, 6),
      (t, rnd, m) => {
        const h = 0.8 + rnd() * 0.45;
        m.makeScale(1, h, 1).setPosition(t.x, 1.6 * h, t.y);
        return TRUNK_SHADES[Math.floor(rnd() * TRUNK_SHADES.length)]!;
      },
      { castShadow: true, receiveShadow: true, occludes: true },
    );
    for (const [tier, radius, height, lift] of [
      [0, 1.05, 1.5, 2.5], [1, 0.78, 1.3, 3.4], [2, 0.46, 1.0, 4.1],
    ] as const) {
      this.addInstanced(
        treeTiles.filter((t) => tier === 0 || (fnv1a(`c${tier}:${t.x}:${t.y}`) & 3) !== 0),
        new THREE.ConeGeometry(radius, height, 7),
        (t, rnd, m) => {
          const h = 0.8 + rnd() * 0.45;
          m.makeRotationY(rnd() * 2).setPosition(t.x, lift * h, t.y);
          return LEAF_SHADES[Math.floor(rnd() * LEAF_SHADES.length)]!;
        },
        { castShadow: true, receiveShadow: true, occludes: true },
      );
    }

    // Rock: boulders and outcrops, the mine's whole texture.
    const rockTiles = tiles.filter((t) => t.kind === 'rock');
    this.addInstanced(
      rockTiles,
      new THREE.DodecahedronGeometry(0.62, 0),
      (t, rnd, m) => {
        const s = 0.85 + rnd() * 0.5;
        m.makeRotationY(rnd() * 3).scale(new THREE.Vector3(s, s * (0.7 + rnd() * 0.5), s));
        m.setPosition(t.x, 0.3 * s, t.y);
        return BOULDER_SHADES[Math.floor(rnd() * BOULDER_SHADES.length)]!;
      },
      { castShadow: true, receiveShadow: true, occludes: true },
    );
    this.addInstanced(
      rockTiles.filter((t) => (fnv1a(`chip:${t.x}:${t.y}`) & 1) === 0),
      new THREE.DodecahedronGeometry(0.3, 0),
      (t, rnd, m) => {
        m.makeRotationY(rnd() * 3).setPosition(
          t.x + (rnd() - 0.5) * 0.6, 0.5 + rnd() * 0.35, t.y + (rnd() - 0.5) * 0.6,
        );
        return BOULDER_SHADES[Math.floor(rnd() * BOULDER_SHADES.length)]!;
      },
      { castShadow: true, receiveShadow: true, occludes: true },
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
    shadows: { castShadow?: boolean; receiveShadow?: boolean; occludes?: boolean },
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
    // Tall geometry gets the see-through cutout; floors never need it.
    if (shadows.occludes) applyOcclusionFade(mesh);
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
