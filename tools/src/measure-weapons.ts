import './node-dom';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Box3, Group, Mesh, Object3D, Vector3 } from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { AssetFileSchema, type AssetFile } from '@rc/shared';
import { allPacks, meshPath } from './packs';

/**
 * Measure every worn item's mesh, so a grip can be derived rather than guessed
 * (D-564).
 *
 *   npx tsx tools/src/measure-weapons.ts
 *
 * 163 weapons cannot be positioned one at a time by eye, and they do not need
 * to be: within a pack they are modelled on ONE convention, and what actually
 * differs between a dagger and a greatsword is length, which is a measurement.
 * So this prints, per mesh, the thing a grip transform is a function of — the
 * bounding box in the mesh's own space, which axis it is long on, and where
 * the ORIGIN sits along that axis.
 *
 * ⚠ The origin is the whole point. A mesh whose origin is at the butt of the
 * grip needs a different offset from one centred on the blade, and nothing in
 * a file listing says which it is. `originAt` is 0 at the low end of the long
 * axis and 1 at the high end, so 0.0 means "modelled from the pommel up" and
 * 0.5 means "modelled about its middle".
 */

const root = fileURLToPath(new URL('../..', import.meta.url));
const assetsDir = join(root, 'content', 'assets');
const outFile = join(root, 'tools', 'weapon-measurements.json');

export interface MeshMeasurement {
  pack: string;
  id: string;
  mesh: string;
  /** Longest axis of the mesh in its own space. */
  axis: 'x' | 'y' | 'z';
  /** Length along that axis, in the file's own units. */
  length: number;
  /** Thickness across the other two axes. */
  girth: [number, number];
  /** Where the origin sits along the long axis: 0 at the low end, 1 at the high. */
  originAt: number;
  /** The box, so an offset can be derived without reloading the mesh. */
  min: [number, number, number];
  max: [number, number, number];
}

const loader = new FBXLoader();

function boxOf(object: Object3D): Box3 {
  const box = new Box3();
  object.updateMatrixWorld(true);
  object.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    mesh.geometry.computeBoundingBox();
    const b = mesh.geometry.boundingBox;
    if (b) box.union(new Box3().copy(b).applyMatrix4(mesh.matrixWorld));
  });
  return box;
}

export function measureMesh(object: Group): Omit<MeshMeasurement, 'pack' | 'id' | 'mesh'> {
  const box = boxOf(object);
  const size = new Vector3();
  box.getSize(size);
  const axes: ('x' | 'y' | 'z')[] = ['x', 'y', 'z'];
  const axis = axes.reduce((best, a) => (size[a] > size[best] ? a : best), 'x');
  const others = axes.filter((a) => a !== axis);
  const length = size[axis];
  // Where zero falls between the two ends. Clamped, because a mesh whose
  // origin is genuinely outside its own bounds — a few of these are — would
  // otherwise report a number that reads like a proportion and is not one.
  const at = length > 1e-6 ? (0 - box.min[axis]) / length : 0;
  return {
    axis,
    length,
    girth: [size[others[0]!], size[others[1]!]],
    originAt: Math.max(-1, Math.min(2, at)),
    min: [box.min.x, box.min.y, box.min.z],
    max: [box.max.x, box.max.y, box.max.z],
  };
}

export async function measureAll(): Promise<MeshMeasurement[]> {
  const out: MeshMeasurement[] = [];
  for (const pack of allPacks()) {
    const file = join(assetsDir, `${pack.id}.character-item.json`);
    if (!existsSync(file)) continue;
    const assets: AssetFile = AssetFileSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    for (const asset of assets.assets) {
      const path = meshPath(pack, asset.mesh);
      if (!path) {
        console.log(`  ! ${pack.id}/${asset.mesh}: no mesh on disk`);
        continue;
      }
      try {
        const object = loader.parse(readFileSync(path).buffer as ArrayBuffer, '');
        out.push({ pack: pack.id, id: asset.id, mesh: asset.mesh, ...measureMesh(object) });
      } catch (e) {
        console.log(`  ! ${pack.id}/${asset.mesh}: ${(e as Error).message}`);
      }
    }
  }
  return out;
}

const invokedDirectly = process.argv[1]?.includes('measure-weapons');
if (invokedDirectly) {
  const all = await measureAll();
  writeFileSync(outFile, `${JSON.stringify(all, null, 2)}\n`);
  const byPack = new Map<string, MeshMeasurement[]>();
  for (const m of all) byPack.set(m.pack, [...(byPack.get(m.pack) ?? []), m]);
  for (const [pack, items] of byPack) {
    const axes = new Set(items.map((i) => i.axis));
    const at = items.map((i) => i.originAt);
    console.log(
      `${pack.padEnd(22)} ${String(items.length).padStart(3)} meshes  ` +
        `axis ${[...axes].join('/')}  ` +
        `length ${Math.min(...items.map((i) => i.length)).toFixed(2)}–${Math.max(...items.map((i) => i.length)).toFixed(2)}  ` +
        `origin ${Math.min(...at).toFixed(2)}–${Math.max(...at).toFixed(2)}`,
    );
  }
  console.log(`${all.length} measured → ${outFile}`);
}
