/**
 * Compare a pack mesh's UVs in the SOURCE FBX against the `.glb` the build
 * wrote (D-591).
 *
 * ⚠ Written because a render cannot tell the two apart. A prop drawn in one
 * flat wrong colour looks identical whether the art is like that, the exporter
 * flattened it, or the atlas is the wrong file — and the first guess (wrong
 * atlas) was checked against all ten of the pack's textures and was wrong.
 *
 *     npx tsx tools/src/probe-env-uv.ts sm-prop-statue-01 sm-env-path-cobble-01
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import './node-dom';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { packOf, meshPath } from './packs';
import { listJson } from './validate-content';

const OUT_DIR = join(process.cwd(), 'client', 'public', 'models', 'env');
const ASSET_DIR = join(process.cwd(), 'content', 'assets');

interface Entry { id: string; pack: string; mesh: string }

function loadCatalogue(): Map<string, Entry> {
  const out = new Map<string, Entry>();
  for (const file of listJson(ASSET_DIR)) {
    const doc = JSON.parse(readFileSync(file, 'utf8')) as { assets?: Entry[] };
    for (const a of doc.assets ?? []) out.set(a.id, a);
  }
  return out;
}

function report(label: string, root: THREE.Object3D): void {
  let verts = 0;
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  const seen = new Set<string>();
  const mats = new Set<string>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
      if (mat) mats.add(mat.name || '(unnamed)');
    }
    const uv = m.geometry.getAttribute('uv') as THREE.BufferAttribute | undefined;
    if (!uv) { console.log(`  ${label}: mesh '${o.name}' has NO uv attribute`); return; }
    verts += uv.count;
    for (let i = 0; i < uv.count; i++) {
      const u = uv.getX(i), v = uv.getY(i);
      uMin = Math.min(uMin, u); uMax = Math.max(uMax, u);
      vMin = Math.min(vMin, v); vMax = Math.max(vMax, v);
      seen.add(`${u.toFixed(4)},${v.toFixed(4)}`);
    }
  });
  console.log(
    `  ${label.padEnd(8)} ${String(verts).padStart(6)} verts  ` +
    `${String(seen.size).padStart(5)} distinct uv  ` +
    `u ${uMin.toFixed(3)}-${uMax.toFixed(3)}  v ${vMin.toFixed(3)}-${vMax.toFixed(3)}  ` +
    `materials: ${[...mats].join(', ')}`,
  );
}

async function main(): Promise<void> {
  const catalogue = loadCatalogue();
  const fbx = new FBXLoader();
  const gltf = new GLTFLoader();
  for (const id of process.argv.slice(2)) {
    const asset = catalogue.get(id);
    if (!asset) { console.log(`${id}: not in the catalogue`); continue; }
    console.log(`\n${id}  (pack ${asset.pack}, mesh ${asset.mesh})`);
    const pack = packOf(asset.pack);
    const file = pack && meshPath(pack, asset.mesh);
    if (file) report('SOURCE', fbx.parse(readFileSync(file).buffer as ArrayBuffer, ''));
    const built = join(OUT_DIR, `${asset.pack}__${asset.id}.glb`);
    if (!existsSync(built)) { console.log('  BUILT    not built — no area places it'); continue; }
    const parsed = await gltf.parseAsync(readFileSync(built).buffer as ArrayBuffer, '');
    report('BUILT', parsed.scene);
  }
}

void main();
