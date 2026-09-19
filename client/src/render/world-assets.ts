import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * Pack meshes drawn in the GAME (D-567).
 *
 * ⚠ The sibling of `AssetVisual`, and the difference is the whole reason this
 * file exists. That one pulls the source FBX through the authoring server,
 * which is fine for a tool sitting beside a 40MB pack and impossible for a
 * browser joining a world — D-566 flagged it as editor-only and said this
 * would be needed. The server has been colliding with placed assets since
 * D-567; until now the client could not draw them, so a map built from pack
 * meshes was a set of invisible walls.
 *
 * What it loads is what `npm run build:environment` wrote: one `.glb` per
 * asset an area actually places, already scaled to metres and sitting on the
 * floor, plus one atlas per pack.
 */

export interface WireAsset {
  readonly pack: string;
  readonly asset: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly rotation: number;
  readonly scale: number;
}

interface Manifest {
  meshes: Record<string, string>;
  atlases: Record<string, string>;
}

const BASE = 'models/env';
const loader = new GLTFLoader();
const texLoader = new THREE.TextureLoader();

/**
 * ⚠ Fetched at MODULE LOAD, not on first use. D-559 records the same trap for
 * the character manifest: `preload()` resolved after `addEntity` had already
 * run in the same function, so the first snapshot was built before the
 * manifest existed and drew everybody wrong.
 */
function readManifest(): Promise<Manifest> {
  return fetch(`${BASE}/manifest.json`)
    .then((r) => (r.ok ? (r.json() as Promise<Manifest>) : { meshes: {}, atlases: {} }))
    .catch(() => ({ meshes: {}, atlases: {} }));
}
let manifest: Promise<Manifest> = readManifest();

const meshCache = new Map<string, Promise<THREE.Object3D | null>>();
const atlasCache = new Map<string, Promise<THREE.Texture | null>>();
/** Said once per asset, not once per placement: a wall is placed forty times. */
const warned = new Set<string>();

/**
 * Re-read the environment build (D-630): a Publish may have produced a mesh
 * an area now places, and the "no built mesh" warning for it was true a
 * minute ago. What is already standing stays; the next placement fetches.
 */
export function invalidateWorldAssets(): void {
  manifest = readManifest();
  meshCache.clear();
  atlasCache.clear();
  warned.clear();
}

/**
 * The atlas is the colour (D-637). A pack mesh that carries a vertex colour
 * attribute — the dungeon pack's goblin staff does, and it is black — would
 * otherwise have the atlas multiplied by it, in every loader that honours
 * COLOR_0. Dropped at the source too; this covers a file built before that.
 */
export function stripVertexColours(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.deleteAttribute('color');
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (m.vertexColors) {
        m.vertexColors = false;
        m.needsUpdate = true;
      }
    }
  });
}

async function meshFor(key: string): Promise<THREE.Object3D | null> {
  if (!meshCache.has(key)) {
    meshCache.set(
      key,
      manifest.then(async (m) => {
        const file = m.meshes[key];
        if (!file) return null;
        const gltf = await loader.loadAsync(`${BASE}/${file}`);
        stripVertexColours(gltf.scene);
        return gltf.scene;
      }),
    );
  }
  return meshCache.get(key)!;
}

async function atlasFor(pack: string): Promise<THREE.Texture | null> {
  if (!atlasCache.has(pack)) {
    atlasCache.set(
      pack,
      manifest
        .then(async (m) => {
          const file = m.atlases[pack];
          if (!file) return null;
          const tex = await texLoader.loadAsync(`${BASE}/${file}`);
          // NEAREST, always: the palette is flat regions and a filtered edge
          // pulls colours that are not in it (D-404, D-560).
          tex.magFilter = THREE.NearestFilter;
          tex.minFilter = THREE.NearestFilter;
          tex.generateMipmaps = false;
          tex.colorSpace = THREE.SRGBColorSpace;
          // ⚠ `flipY` is LEFT AT THE DEFAULT (true), and that is a correction
          // (D-591). It was set false here citing D-559, which is about the
          // CHARACTER palette — a different atlas reaching a different
          // pipeline, where false is still right. Copying the line across
          // inverted the V axis for every piece of world scenery.
          //
          // ⚠ It survived because the miss is nearly invisible on most of the
          // pack: this atlas is roughly symmetric in tone about v=0.5, so
          // walls and houses landed on other greys and other reds and looked
          // completely fine. What it actually cost, measured by rendering each
          // mesh under both conventions and counting pixels:
          //
          //     path   false #394171 blue     ->  true #7c817d grey cobble
          //     tree   false #717171 #daa3a5  ->  true #5d6a36 #6b573f
          //     cart   false #caae86 #555558  ->  true #6b573f brown
          //
          // ⚠ And it was misread twice before it was measured. A top-down
          // render was read as "grey rocks scattered in the corners"; those
          // were the TREES, and the green around them was the painted ground.
          // The editor draws these from the source FBX and had been showing
          // the right colours the whole time — the exact disagreement between
          // a tool and the game that D-543 exists to prevent.
          return tex;
        })
        .catch(() => null),
    );
  }
  return atlasCache.get(pack)!;
}

/** Every placed asset in the current area. Rebuilt whole on an area change. */
/**
 * One pack mesh, parented where the caller says (D-583).
 *
 * ⚠ The same loader a placed asset uses, deliberately. A station is an
 * ENTITY rather than area scenery — the server spawns it, it can be stood
 * beside and used — but there is no reason for it to be drawn by a second
 * mechanism, and a separate path is how the well ends up in a different
 * palette from the wall behind it.
 *
 * Returns null when the build has no mesh for it, so the caller can fall back
 * to geometry rather than showing nothing: a facility that fails to draw is a
 * well nobody can find, and thirst is a leash to a place (D-529).
 */
export async function loadOneAsset(
  pack: string,
  asset: string,
): Promise<THREE.Object3D | null> {
  const key = `${pack}/${asset}`;
  const source = await meshFor(key);
  if (!source) {
    if (!warned.has(key)) {
      warned.add(key);
      console.warn(
        `no built mesh for ${key} — run 'npm run build:environment' ` +
          '(the build only ships assets the world actually uses)',
      );
    }
    return null;
  }
  const object = source.clone(true);
  const atlas = await atlasFor(pack);
  object.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const mat = (mesh.material as THREE.MeshStandardMaterial).clone();
    if (atlas) mat.map = atlas;
    mat.needsUpdate = true;
    mesh.material = mat;
  });
  return object;
}

export class WorldAssets {
  private readonly group = new THREE.Group();
  private disposed = false;
  /**
   * What stands on each tile, keyed `x,y` (D-622).
   *
   * ⚠ A chair is SCENERY, not an entity -- it is a placement in the area
   * document, so nothing in the entity table can be asked about it. The hover
   * outline needs the actual object to build a hull around, and `sit` already
   * finds the seat by tile, so this is the same key from the other side.
   *
   * ⚠ Last placement on a tile wins, deliberately. Two things on one tile
   * is one of them being scatter, and outlining the wrong one is a cosmetic
   * miss where refusing to outline anything is a feature that looks broken.
   */
  private readonly byTile = new Map<string, THREE.Object3D>();

  constructor(
    private readonly scene: THREE.Scene,
    assets: readonly WireAsset[],
  ) {
    scene.add(this.group);
    void this.build(assets);
  }

  private async build(assets: readonly WireAsset[]): Promise<void> {
    for (const a of assets) {
      const key = `${a.pack}/${a.asset}`;
      const source = await meshFor(key);
      if (this.disposed) return;
      if (!source) {
        if (!warned.has(key)) {
          warned.add(key);
          // ⚠ Loud, and specific about the fix. The failure mode is a wall you
          // cannot see and cannot walk through, which reads as the collision
          // system being broken rather than as a missing build step.
          console.warn(
            `no built mesh for ${key} — run 'npm run build:environment' ` +
              '(the build only ships assets the areas actually place)',
          );
        }
        continue;
      }
      const object = source.clone(true);
      object.position.set(a.x, a.z, a.y);
      // ⚠ NEGATED, exactly as the editor does it. Area coordinates turn
      // clockwise with +x east and +y south; three's +y rotation turns the
      // other way. Get the sign wrong and the mesh mirrors about its own
      // placement point — invisible on anything symmetrical, wrong for every
      // door (D-567).
      object.rotation.y = (-a.rotation * Math.PI) / 180;
      object.scale.setScalar(a.scale);

      const atlas = await atlasFor(a.pack);
      if (this.disposed) return;
      object.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        // A cloned mesh shares its material, and one shared material means the
        // last atlas set wins for every wall on the map at once.
        const mat = (mesh.material as THREE.MeshStandardMaterial).clone();
        if (atlas) mat.map = atlas;
        mat.needsUpdate = true;
        mesh.material = mat;
      });
      this.group.add(object);
      this.byTile.set(`${Math.round(a.x)},${Math.round(a.y)}`, object);
    }
  }

  /** The object standing on this tile, if one has finished loading (D-622). */
  objectAt(x: number, y: number): THREE.Object3D | null {
    return this.byTile.get(`${Math.round(x)},${Math.round(y)}`) ?? null;
  }

  /** How many are actually in the scene — a verification hook, not a feature. */
  get drawn(): number {
    return this.group.children.length;
  }

  dispose(): void {
    this.disposed = true;
    this.scene.remove(this.group);
    this.byTile.clear();
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      // ⚠ Geometry and textures are NOT freed — they belong to the cached
      // source every other copy of this wall clones from. Freeing them here
      // blanks the lot, the mistake D-559 records for characters.
      const mat = mesh.material as THREE.Material;
      if (mat && !Array.isArray(mat)) mat.dispose();
    });
    this.group.clear();
  }
}
