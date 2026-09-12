import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { assetAtlas, originCorrection, type PlacedAsset } from '@rc/shared';

/**
 * A vendor mesh standing on the tile grid (D-566).
 *
 * The walls, houses and trees that come out of a pack, drawn in the EDITOR so
 * a map can be built from them. `WorldAssets` is the game's half.
 *
 * ⚠ It draws from the SOURCE FBX through the authoring server, which makes it
 * an editor-only path: the game cannot load a 40MB pack at runtime and must
 * not try. `npm run build:environment` writes the `.glb` the game loads
 * instead (D-567), so do not import this into `main.ts`.
 */

const loader = new FBXLoader();
const texLoader = new THREE.TextureLoader();

/** Parsed meshes and atlases, keyed by pack — a map re-places the same wall often. */
const meshCache = new Map<string, Promise<THREE.Object3D>>();
const atlasCache = new Map<string, Promise<THREE.Texture | null>>();
/** Which units a pack is modelled in, measured once from its first mesh. */
const packScale = new Map<string, number>();

export interface AssetSource {
  /** Where the authoring server lives, e.g. `http://localhost:8150/api`. */
  readonly api: string;
  /**
   * The mesh stem and atlases for a placed asset, by `pack/id`.
   *
   * ⚠ A `PlacedAsset` names the asset ID, not the FILE. Deriving one from the
   * other looks possible — `sm-env-basement-wallpanel-01` is visibly a
   * lowercased `SM_Env_Basement_WallPanel_01` — and is not: the casing is lost
   * and every fetch 404s silently, which is exactly what happened. The
   * catalogue is the only thing that knows.
   */
  readonly lookup: (pack: string, id: string) => { mesh: string; textures: readonly string[] } | undefined;
}

async function atlasFor(src: AssetSource, pack: string, textures: readonly string[]): Promise<THREE.Texture | null> {
  const want = assetAtlas(textures);
  if (!want) return null;
  const key = `${pack}/${want}`;
  if (!atlasCache.has(key)) {
    atlasCache.set(
      key,
      texLoader
        .loadAsync(`${src.api}/assetpacks/${encodeURIComponent(pack)}/tex/${encodeURIComponent(want)}`)
        .then((tex) => {
          // NEAREST, always: the palette is flat regions and a filtered edge
          // pulls colours that are not in it (D-404, D-560).
          tex.magFilter = THREE.NearestFilter;
          tex.minFilter = THREE.NearestFilter;
          tex.generateMipmaps = false;
          tex.colorSpace = THREE.SRGBColorSpace;
          return tex;
        })
        .catch((err) => {
          // ⚠ Never silent. A missing atlas does not fail — it paints the mesh
          // BLACK, which reads as a lighting or material fault and sends you
          // looking in the wrong file entirely. Ten studio servers had
          // accreted on 8150-8159 and the editor was talking to the oldest,
          // which predated this route; the only symptom was black walls.
          console.warn(`no atlas ${key} — the mesh will draw untextured: ${String(err)}`);
          return null;
        }),
    );
  }
  return atlasCache.get(key)!;
}

async function meshFor(src: AssetSource, pack: string, stem: string): Promise<THREE.Object3D> {
  const key = `${pack}/${stem}`;
  if (!meshCache.has(key)) {
    meshCache.set(
      key,
      fetch(`${src.api}/assetpacks/${encodeURIComponent(pack)}/fbx/${encodeURIComponent(stem)}`)
        .then((r) => r.arrayBuffer())
        .then((buf) => loader.parse(buf, '')),
    );
  }
  return meshCache.get(key)!;
}

/**
 * How many world units one of this pack's units is.
 *
 * ⚠ Measured, never assumed. The packs disagree by 100× and nothing in a file
 * listing shows it (D-561): a knights wall placed at scale 1 is eighty metres
 * tall and reads as a rendering failure rather than a units mistake.
 */
function scaleFor(pack: string, object: THREE.Object3D): number {
  const known = packScale.get(pack);
  if (known !== undefined) return known;
  const size = new THREE.Box3().setFromObject(object).getSize(new THREE.Vector3());
  const scale = Math.max(size.x, size.y, size.z) > 20 ? 0.01 : 1;
  packScale.set(pack, scale);
  return scale;
}

export class AssetVisual {
  private readonly root = new THREE.Group();
  private disposed = false;
  /** Drawn as a preview of what is about to be placed (editor only). */
  private ghost = false;

  constructor(
    private readonly scene: THREE.Scene,
    placed: PlacedAsset,
    src: AssetSource,
  ) {
    // Free placement (D-567): the asset's own origin goes where it was put, at
    // whatever height and angle. The footprint-centring this replaced existed
    // only because a placement had to line up with tile corners.
    this.root.position.set(placed.x, placed.z, placed.y);
    // ⚠ NEGATED. Area coordinates turn clockwise with +x east and +y south;
    // three's +y rotation turns the other way. Get the sign wrong and the mesh
    // and its collision mask mirror each other about the placement point —
    // which looks fine on anything symmetrical and is wrong for every door.
    this.root.rotation.y = (-placed.rotation * Math.PI) / 180;
    this.root.scale.setScalar(placed.scale);
    scene.add(this.root);

    void this.build(placed, src);
  }

  private async build(placed: PlacedAsset, src: AssetSource): Promise<void> {
    const entry = src.lookup(placed.pack, placed.asset);
    if (!entry) {
      // Loud: an asset the catalogue has never heard of is a map pointing at
      // art that is not installed, and an invisible wall is the worst way to
      // find that out.
      console.warn(`no catalogue entry for ${placed.pack}/${placed.asset} — nothing drawn`);
      return;
    }
    let source: THREE.Object3D;
    try {
      source = await meshFor(src, placed.pack, entry.mesh);
    } catch {
      console.warn(`could not load ${placed.pack}/${entry.mesh}`);
      return;
    }
    if (this.disposed) return;
    const object = source.clone(true);
    const scale = scaleFor(placed.pack, source);
    object.scale.setScalar(scale);

    const atlas = await atlasFor(src, placed.pack, entry.textures);
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
    // Sit it ON the floor rather than through it: a pack models its origin
    // wherever it likes, and half a wall below the tiles reads as a sunk map.
    const box = new THREE.Box3().setFromObject(object);
    object.position.y -= box.min.y;
    // ⚠ The same origin correction the build applies (D-591), from the same
    // implementation. The editor and the game drew the cobble paths a metre
    // and a half off in identical ways, so the two AGREED and the preview was
    // no help at all — which is the failure D-543 promised this file would not
    // have. Two copies of a rule is how that happens.
    const fix = originCorrection({
      minX: box.min.x, maxX: box.max.x, minZ: box.min.z, maxZ: box.max.z,
    });
    object.position.x += fix.dx;
    object.position.z += fix.dz;
    this.root.add(object);
    // ⚠ The mesh arrives over HTTP long after the caller asked for a ghost,
    // so the flag is re-applied here. Setting it only in `setGhost` gives a
    // preview that is solid until you happen to toggle something.
    if (this.ghost) this.setGhost(true);
  }

  /** The scene node, for raycasting a click onto the thing you can see. */
  get object(): THREE.Object3D {
    return this.root;
  }

  /**
   * Draw this one as a GHOST: the thing about to be placed rather than a
   * thing that is there (editor only).
   *
   * ⚠ Safe to set per instance because `build` already clones every
   * material — it had to, or one shared material meant the last atlas set won
   * for every wall on the map at once. Without that, making the preview
   * translucent would make the whole town translucent.
   *
   * ⚠ It also stops the ghost being raycast. The preview sits exactly where
   * the next click lands, so a solid one would intercept every pick and make
   * selecting the thing underneath it impossible.
   */
  setGhost(on: boolean): void {
    this.ghost = on;
    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.raycast = on ? () => {} : THREE.Mesh.prototype.raycast;
      mesh.castShadow = !on;
      mesh.receiveShadow = !on;
      const mat = mesh.material as THREE.MeshStandardMaterial;
      if (!mat || Array.isArray(mat)) return;
      mat.transparent = on;
      mat.opacity = on ? 0.45 : 1;
      mat.depthWrite = !on;
      mat.needsUpdate = true;
    });
  }

  /** Show or hide without tearing down the loaded mesh. */
  setVisible(on: boolean): void {
    this.root.visible = on;
  }

  /**
   * Move an already-built visual, without re-parsing the FBX.
   *
   * ⚠ Nudging by rebuilding is hopeless per wheel notch — the same finding
   * D-565 recorded for weapon offsets — and here it is worse, because a rebuild
   * re-fetches a mesh over HTTP.
   */
  moveTo(placed: PlacedAsset): void {
    this.root.position.set(placed.x, placed.z, placed.y);
    this.root.rotation.y = (-placed.rotation * Math.PI) / 180;
    this.root.scale.setScalar(placed.scale);
  }

  /**
   * Where this actually ended up in the scene, and whether a mesh arrived.
   *
   * ⚠ A verification hook, not a renderer feature — the D-559 lesson that two
   * things at isometric distance are hard to tell apart in a screenshot, so
   * placement is MEASURED rather than looked at.
   */
  placement(): { x: number; y: number; z: number; yaw: number; drawn: boolean } {
    return {
      x: this.root.position.x,
      z: this.root.position.y,
      y: this.root.position.z,
      yaw: (-this.root.rotation.y * 180) / Math.PI,
      drawn: this.root.children.length > 0,
    };
  }

  dispose(): void {
    this.disposed = true;
    this.scene.remove(this.root);
    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      // ⚠ Geometry is NOT freed — it belongs to the cached source mesh that
      // every other copy of this wall clones from. Freeing it here blanks them
      // all, the mistake D-559 records for characters.
      const mat = mesh.material as THREE.Material;
      if (mat && !Array.isArray(mat)) mat.dispose();
    });
    this.root.clear();
  }
}
