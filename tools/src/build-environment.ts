import './node-dom';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Box3, Mesh, MeshStandardMaterial, Object3D, Vector3 } from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import {
  AreaSchema,
  AssetFileSchema,
  ItemTemplateSchema,
  ResourceNodeSchema,
  StationDefSchema,
  assetAtlas,
  type CharacterItem,
  type EnvironmentAsset,
} from '@rc/shared';
import { originCorrection } from '@rc/shared';
import { packOf, meshPath, texturePaths, texturesIn } from './packs';
import { listJson } from './validate-content';

/**
 * `npm run build:environment` — pack meshes the GAME can load (D-567).
 *
 * ⚠ D-566 said this would be needed and why: the editor draws a placed asset
 * by pulling the source FBX through the authoring server, which is fine for a
 * tool running beside a 40MB pack and impossible for a browser joining a
 * world. The server already COLLIDES with placed assets; until this existed
 * the client could not draw them, so a map built from pack meshes was a set
 * of invisible walls. This is the same treatment characters got in D-555.
 *
 * ⚠ It builds only what the AREAS ACTUALLY USE, not all 1,402 meshes. The
 * alternative is shipping a few hundred megabytes of a vendor pack to every
 * player so that eleven of them can be walls, and it would grow every time
 * somebody ingested another pack. The cost is that placing a new asset means
 * re-running the build — which is why the client says so out loud when it
 * meets one it has no mesh for, rather than drawing nothing.
 */

const root = fileURLToPath(new URL('../..', import.meta.url));
const AREA_DIR = join(root, 'content', 'areas');
const ASSET_DIR = join(root, 'content', 'assets');
const STATION_DIR = join(root, 'content', 'stations');
const NODE_DIR = join(root, 'content', 'nodes');
const ITEM_DIR = join(root, 'content', 'items');
const OUT_DIR = join(root, 'client', 'public', 'models', 'env');

export const ENV_MANIFEST = 'manifest.json';

export interface EnvManifest {
  /** `pack/assetId` → the file to load, relative to this manifest. */
  readonly meshes: Record<string, string>;
  /** `pack` → its atlas file, relative to this manifest. */
  readonly atlases: Record<string, string>;
}

/**
 * Every `pack/assetId` the WORLD needs a mesh for.
 *
 * ⚠ Two sources, not one. Areas place assets, and a STATION wears one its
 * definition names (D-583) — and a station is an entity the server spawns
 * rather than something an area places, so scanning areas alone would ship a
 * map whose walls are right and whose well is a grey cylinder. The failure is
 * quiet: the client falls back to built-in geometry and nothing errors.
 */
export function placedAssetIds(
  areaDir = AREA_DIR,
  stationDir = STATION_DIR,
  nodeDir = NODE_DIR,
  itemDir = ITEM_DIR,
): Set<string> {
  const used = new Set<string>();
  for (const file of listJson(areaDir)) {
    const area = AreaSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    for (const a of area.assets) used.add(`${a.pack}/${a.asset}`);
  }
  for (const file of listJson(stationDir)) {
    const def = StationDefSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    if (def.art) used.add(`${def.art.pack}/${def.art.asset}`);
  }
  // Resource nodes wear a mesh on the same terms (D-583).
  for (const file of listJson(nodeDir)) {
    const def = ResourceNodeSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    if (def.art) used.add(`${def.art.pack}/${def.art.asset}`);
  }
  // ⚠ And what a character HOLDS (D-614). D-564 fitted 163 weapons into
  // hands by measurement and nothing ever built one for the game: the grips
  // were right, the meshes were never exported, and a player with a sword
  // equipped fought empty-handed. The items already name their art; this is
  // the line that was missing.
  for (const file of listJson(itemDir)) {
    const def = ItemTemplateSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    if (def.art) used.add(`${def.art.pack}/${def.art.asset}`);
    // And what it FIRES (D-639): an arrow is a mesh in flight, built on the
    // same terms as the bow that looses it.
    if (def.vfx?.projectile?.asset) used.add(def.vfx.projectile.asset);
  }
  return used;
}

/**
 * Everything the game may need a mesh for, by `pack/assetId`.
 *
 * ⚠ Both kinds, in one map (D-614). It read only `.environment.json`, so a
 * sword named by an item resolved to nothing and was reported as "not in the
 * asset catalogue" -- which is the message for a map pointing at art nobody
 * has, and is exactly wrong here: the art existed and the catalogue being
 * consulted was the wrong one.
 */
export function environmentCatalogue(
  assetDir = ASSET_DIR,
): Map<string, EnvironmentAsset | CharacterItem> {
  const out = new Map<string, EnvironmentAsset | CharacterItem>();
  for (const file of listJson(assetDir)) {
    const isEnv = file.endsWith('.environment.json');
    const isHeld = file.endsWith('.character-item.json');
    if (!isEnv && !isHeld) continue;
    const parsed = AssetFileSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    for (const a of parsed.assets) {
      if (a.kind !== 'environment' && a.kind !== 'character-item') continue;
      out.set(`${a.pack}/${a.id}`, a);
    }
  }
  return out;
}

/**
 * How many world units one of this pack's units is.
 *
 * ⚠ Measured, never assumed, and BAKED IN here rather than guessed at runtime.
 * The packs disagree by 100× and nothing in a file listing shows it (D-561):
 * the editor guesses from a mesh's extent, which works and is a guess made
 * afresh in every client. Doing it once, at build time, means a placed asset's
 * `scale` means exactly what it says.
 */
export function packScale(object: Object3D): number {
  const size = new Box3().setFromObject(object).getSize(new Vector3());
  return Math.max(size.x, size.y, size.z) > 20 ? 0.01 : 1;
}

function loadFbx(file: string): Object3D {
  const buf = readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  return new FBXLoader().parse(ab, '');
}

/**
 * Prepare a mesh for export: scaled to metres and sitting ON the floor.
 *
 * ⚠ The floor part matters as much as the scale. A pack models its origin
 * wherever it likes, and half a wall below the tiles reads as a sunk map
 * rather than as a missing offset — the editor learned this the same way.
 */
/**
 * What `normalise` moved, so the build SAYS it repaired something.
 *
 * ⚠ The same rule D-558 set for the character pipeline's weight repair: a
 * silent fix is a silent claim that the art was fine.
 */
const recentred: string[] = [];
let recentring: string | null = null;

/**
 * ⚠ `held` items are exported RAW (D-614) -- their own units, their own
 * origin, standing on nothing.
 *
 * Everything this function does is right for scenery and destroys a weapon.
 * A prop is placed by its centre and stands on the ground, so it is scaled to
 * metres, dropped to y=0 and centred in x/z. A weapon is placed by its GRIP,
 * and D-564's load-bearing measurement is that **the mesh origin IS the grip**
 * -- which is why a 2.1m spear and a 48cm knife take the same offset. Moving
 * the mesh so its lowest point sits at zero moves the grip by half a blade,
 * and every one of the 163 fitted transforms then means something else.
 *
 * ⚠ The scale is left alone for the same reason D-571 leaves character part
 * files unscaled: the fitted transform was measured against the raw FBX in the
 * creation tool, so baking the conversion in here would apply it twice.
 */
function normalise(
  source: Object3D,
  held = false,
): { object: Object3D; scale: number; vertices: number } {
  const scale = held ? 1 : packScale(source);
  const object = source.clone(true);
  object.scale.setScalar(scale);
  object.updateMatrixWorld(true);
  const box = new Box3().setFromObject(object);
  if (!held) object.position.y -= box.min.y;
  // ⚠ And CENTRED on its origin in x/z, for the two meshes whose origin is a
  // corner (D-591). A placed asset's x,y is the centre of the thing — the
  // editor shows it there, the collision mask is baked around it, and every
  // generator assumes it. `originCorrection` only moves a mesh that lies
  // entirely to one side of its origin, which is what a corner origin means
  // and what nothing else in three packs does.
  const fix = held
    ? { dx: 0, dz: 0 }
    : originCorrection({
      minX: box.min.x, maxX: box.max.x, minZ: box.min.z, maxZ: box.max.z,
    });
  object.position.x += fix.dx;
  object.position.z += fix.dz;
  if (fix.dx !== 0 || fix.dz !== 0) {
    recentred.push(
      `${recentring ?? '?'}: origin was a corner — moved ` +
      `${fix.dx.toFixed(2)}, ${fix.dz.toFixed(2)} to centre it`,
    );
  }
  let vertices = 0;
  object.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    vertices += mesh.geometry.getAttribute('position')?.count ?? 0;
    // ⚠ Vertex colours are dropped (D-637): the goblin staff carries a black
    // one, and a loader that finds COLOR_0 multiplies the atlas by it.
    mesh.geometry.deleteAttribute('color');
    // ⚠ The FBX's own materials are REPLACED, not merely left unembedded.
    // They carry texture references into the exporter, which then tries to
    // rasterise them and dies with "No valid image data found" — `embedImages:
    // false` governs what is written out, not what is walked. Everything these
    // materials say is discarded at load anyway: the atlas is applied then,
    // the same way the editor does it, which is what keeps recolouring cheap.
    const keep = (mesh.material as { name?: string } | undefined)?.name;
    const plain = new MeshStandardMaterial({ roughness: 1, metalness: 0 });
    if (keep) plain.name = keep;
    mesh.material = plain;
  });
  return { object, scale, vertices };
}

async function toGlb(object: Object3D): Promise<Buffer> {
  const glb = await new GLTFExporter().parseAsync(object, {
    binary: true,
    // The atlas ships alongside as a PNG and is applied at load, exactly as
    // the editor does it. Embedding would need a canvas to rasterise, which
    // is the dependency D-555 went out of its way not to take.
    embedImages: false,
  });
  if (!(glb instanceof ArrayBuffer)) throw new Error('exporter did not return binary glTF');
  return Buffer.from(glb);
}

export async function buildEnvironment(): Promise<
  EnvManifest & { skipped: string[]; recentred: string[] }
> {
  const used = placedAssetIds();
  const catalogue = environmentCatalogue();
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const meshes: Record<string, string> = {};
  const atlases: Record<string, string> = {};
  const skipped: string[] = [];
  const packsSeen = new Set<string>();

  for (const key of [...used].sort()) {
    const asset = catalogue.get(key);
    if (!asset) {
      // ⚠ Loud. An area placing an asset the catalogue has never heard of is a
      // map pointing at art nobody has, and an invisible wall is the worst way
      // to find that out.
      skipped.push(`${key}: not in the asset catalogue`);
      continue;
    }
    const pack = packOf(asset.pack);
    const file = pack && meshPath(pack, asset.mesh);
    if (!pack || !file) {
      skipped.push(`${key}: pack '${asset.pack}' is not ingested — nothing to build from`);
      continue;
    }
    recentring = asset.id;
    const { object } = normalise(loadFbx(file), asset.kind === 'character-item');
    const out = join(OUT_DIR, `${asset.pack}__${asset.id}.glb`);
    writeFileSync(out, await toGlb(object));
    meshes[key] = `${asset.pack}__${asset.id}.glb`;
    packsSeen.add(asset.pack);
  }

  for (const id of packsSeen) {
    const pack = packOf(id)!;
    const want = assetAtlas(texturesIn(pack));
    const src = want ? texturePaths(pack).get(want) : undefined;
    if (!want || !src) {
      skipped.push(`${id}: no atlas found — its meshes will draw untextured`);
      continue;
    }
    writeFileSync(join(OUT_DIR, `${id}.png`), readFileSync(src));
    atlases[id] = `${id}.png`;
  }

  const manifest: EnvManifest = { meshes, atlases };
  writeFileSync(join(OUT_DIR, ENV_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return { ...manifest, skipped, recentred };
}

// ⚠ Matched on the SCRIPT NAME, the way every other tool here does it. The
// `import.meta.url === file://argv[1]` idiom is wrong on Windows — the URL
// carries three slashes and a drive letter — so the guard was never true, the
// build ran nothing, printed nothing and exited 0.
const invokedDirectly = process.argv[1]?.includes('build-environment');
if (invokedDirectly) {
  buildEnvironment()
    .then((r) => {
      const n = Object.keys(r.meshes).length;
      console.log(`built ${n} environment mesh(es), ${Object.keys(r.atlases).length} atlas(es)`);
      for (const s of r.skipped) console.warn(`  ⚠ ${s}`);
      // ⚠ Printed, never silent (D-558's rule for the character pipeline's
      // weight repair): a quiet fix is a quiet claim that the art was fine.
      for (const s of r.recentred) console.log(`  ↔ ${s}`);
      if (n === 0) {
        console.log('  (no area places a pack asset yet — nothing to build)');
      }
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
