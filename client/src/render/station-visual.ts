import * as THREE from 'three';
import { loadOneAsset } from './world-assets';
import { fnv1a, mulberry32, type CoreStationType } from '@rc/shared';
import { applyOcclusionFade } from './occlusion';

/**
 * The four facilities, drawn (D-530, D-542).
 *
 * ⚠ All that survives of the 44 procedural prop types. Those were the tile
 * system's scenery — placed on whole tiles, blocking whole tiles — and they
 * are gone: a map is built from pack meshes now (D-567). A station is not
 * scenery, though. It is a gameplay object the server spawns as an entity, it
 * has to be visible across the square for thirst to work as a leash (D-529),
 * and the well has to be findable by somebody who means to poison it.
 *
 * ⚠ So these four are a KNOWN residue, not an exception worth keeping. They
 * should become pack assets like everything else, at which point this file
 * goes too. Said here rather than left for somebody to discover the last
 * procedural geometry in the game hiding behind a different filename.
 *
 * House style, inherited from the terrain and the character rig: chunky boxes
 * and cylinders, few polygons, and **mid-tone albedo**. Lighting and the
 * palette quantiser both darken the final image, so a near-black barrel
 * arrives as a black smear with nothing for the palette to bite on. Brighten
 * the surface, never the lights (D-514).
 */

type Rnd = () => number;

const WOOD = [0x7a6144, 0x6d5639, 0x866c4c, 0x5f4c34];
const PALE_WOOD = [0x9a8156, 0xa88f61, 0x8d7549];
const IRON = [0x6f6a63, 0x7d776e, 0x5f5a54];
const STONE = [0x8a8279, 0x7b746b, 0x968d83];
const CLOTH = [0x8c6a52, 0x6b7360, 0x7a6a80, 0x94836a];

const pick = (rnd: Rnd, arr: readonly number[]): number =>
  arr[Math.floor(rnd() * arr.length) % arr.length]!;

function box(
  w: number,
  h: number,
  d: number,
  color: number,
  x = 0,
  y = 0,
  z = 0,
  ry = 0,
): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshLambertMaterial({ color }),
  );
  mesh.position.set(x, y, z);
  mesh.rotation.y = ry;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function cyl(
  rTop: number,
  rBottom: number,
  h: number,
  color: number,
  segments = 8,
  x = 0,
  y = 0,
  z = 0,
): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(rTop, rBottom, h, segments),
    new THREE.MeshLambertMaterial({ color }),
  );
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function barrel(rnd: Rnd, scale = 1): THREE.Group {
  const g = new THREE.Group();
  const wood = pick(rnd, WOOD);
  g.add(
    cyl(0.2 * scale, 0.23 * scale, 0.62 * scale, wood, 10, 0, 0.31 * scale, 0),
    cyl(0.235 * scale, 0.235 * scale, 0.05 * scale, pick(rnd, IRON), 10, 0, 0.16 * scale, 0),
    cyl(0.235 * scale, 0.235 * scale, 0.05 * scale, pick(rnd, IRON), 10, 0, 0.46 * scale, 0),
    cyl(0.19 * scale, 0.19 * scale, 0.04 * scale, pick(rnd, PALE_WOOD), 10, 0, 0.63 * scale, 0),
  );
  return g;
}

function build(root: THREE.Group, type: CoreStationType, rnd: Rnd): void {
  switch (type) {
    case 'workshop': {
      // Block, waist, and the horn — an anvil reads by its silhouette.
      root.add(box(0.5, 0.16, 0.34, pick(rnd, WOOD), 0, 0.08, 0));
      root.add(box(0.24, 0.22, 0.22, pick(rnd, IRON), 0, 0.27, 0));
      root.add(box(0.52, 0.14, 0.3, pick(rnd, IRON), 0, 0.45, 0));
      const horn = cyl(0.03, 0.09, 0.24, pick(rnd, IRON), 6, 0.34, 0.45, 0);
      horn.rotation.z = Math.PI / 2;
      root.add(horn);
      // A bucket to quench in, so the anvil is a workplace not an ornament.
      root.add(cyl(0.11, 0.09, 0.2, pick(rnd, WOOD), 8, -0.36, 0.1, 0.22));
      break;
    }

    case 'well': {
      // The most important object on the map (D-529): thirst is the leash
      // back to town, so the well has to be visible across the square.
      const stone = pick(rnd, STONE);
      root.add(cyl(0.42, 0.46, 0.5, stone, 12, 0, 0.25, 0));
      root.add(cyl(0.34, 0.34, 0.06, 0x2c3b46, 12, 0, 0.46, 0));
      for (const sx of [-0.36, 0.36]) {
        root.add(box(0.1, 1.3, 0.1, pick(rnd, WOOD), sx, 0.9, 0));
      }
      const roof = new THREE.Mesh(
        new THREE.ConeGeometry(0.72, 0.42, 4),
        new THREE.MeshLambertMaterial({ color: pick(rnd, WOOD) }),
      );
      roof.position.y = 1.75;
      roof.rotation.y = Math.PI / 4;
      roof.castShadow = true;
      root.add(roof);
      const spindle = cyl(0.05, 0.05, 0.72, pick(rnd, PALE_WOOD), 8, 0, 1.42, 0);
      spindle.rotation.z = Math.PI / 2;
      root.add(spindle);
      root.add(box(0.02, 0.5, 0.02, 0x4a4038, 0, 1.15, 0));
      root.add(cyl(0.1, 0.08, 0.16, pick(rnd, WOOD), 8, 0, 0.85, 0));
      break;
    }

    case 'storehouse': {
      const wood = pick(rnd, WOOD);
      for (const sx of [-0.44, 0.44]) root.add(box(0.09, 1.8, 0.09, wood, sx, 0.9, -0.2));
      root.add(box(1.0, 0.07, 0.44, pick(rnd, PALE_WOOD), 0, 0.62, 0));
      root.add(box(1.0, 0.07, 0.44, pick(rnd, PALE_WOOD), 0, 1.16, 0));
      const b1 = barrel(rnd, 0.8);
      b1.position.set(-0.24, 0.65, 0);
      const b2 = barrel(rnd, 0.8);
      b2.position.set(0.26, 0.65, -0.02);
      root.add(b1, b2);
      for (let i = 0; i < 3; i++) {
        root.add(box(0.26, 0.2, 0.22, pick(rnd, CLOTH), (i - 1) * 0.3, 1.29, 0, rnd()));
      }
      break;
    }

    case 'infirmary': {
      root.add(box(1.0, 0.09, 0.52, 0xb8ac93, 0, 0.72, 0));
      for (const [sx, sz] of [[-0.42, -0.2], [0.42, -0.2], [-0.42, 0.2], [0.42, 0.2]] as const) {
        root.add(box(0.08, 0.72, 0.08, pick(rnd, WOOD), sx, 0.36, sz));
      }
      // The shelf of stoppered jars the descriptor promises.
      root.add(box(0.9, 0.06, 0.2, pick(rnd, PALE_WOOD), 0, 1.2, -0.22));
      for (let i = 0; i < 4; i++) {
        root.add(cyl(0.055, 0.06, 0.17, i % 2 ? 0x7f8f7a : 0x9c8a6a, 7, (i - 1.5) * 0.2, 1.31, -0.22));
      }
      root.add(box(0.3, 0.05, 0.2, 0xd8cdb4, 0.2, 0.78, 0.06, 0.2));
      break;
    }
  }
}

export class StationVisual {
  /** ⚠ Public so the hover outline can be built around it (D-622). */
  readonly root = new THREE.Group();
  private disposed = false;

  constructor(
    private readonly scene: THREE.Scene,
    type: CoreStationType,
    x: number,
    y: number,
    /** The mesh its definition names (D-583). Absent keeps the built-in shape. */
    art?: { pack: string; asset: string; rotation: number; scale: number },
  ) {
    // Colour and small offsets are seeded from the position, so every client
    // draws the identical scene.
    //
    // ⚠ The built-in geometry is built FIRST and replaced only when a mesh
    // actually arrives. Waiting for the fetch would leave a hole where the
    // well is for as long as the download takes, and a facility that is not
    // there yet is one a player walks past — thirst is a leash to a PLACE
    // (D-529), so the place has to be visible from the first frame.
    build(this.root, type, mulberry32(fnv1a(`${type}:${Math.round(x)}:${Math.round(y)}`)));
    this.root.position.set(x, 0, y);
    scene.add(this.root);
    if (art) void this.wear(art);
  }

  /** Swap the built-in shape for the authored mesh, once it has loaded. */
  private async wear(art: {
    pack: string; asset: string; rotation: number; scale: number;
  }): Promise<void> {
    const object = await loadOneAsset(art.pack, art.asset);
    if (!object || this.disposed) return;
    // Only now is the placeholder taken away.
    for (const child of [...this.root.children]) this.root.remove(child);
    object.rotation.y = (-art.rotation * Math.PI) / 180;
    object.scale.setScalar(art.scale);
    this.root.add(object);
  }

  setPosition(x: number, z: number, elevation = 0): void {
    this.root.position.set(x, elevation, z);
  }

  update(): void {
    applyOcclusionFade(this.root);
  }

  dispose(): void {
    this.disposed = true;
    this.scene.remove(this.root);
    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    });
    this.root.clear();
  }
}
