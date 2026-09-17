import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { CHARACTER_SLOTS, markingSwap, skinPalette } from '@rc/shared';
import { assemble } from './assembly';
import { HOOD_ID, hoodPack, hoodStem } from './hood';

/** The order parts are fed to `assemble`. See `dressedParts`. */
const SLOT_ORDER: readonly string[] = CHARACTER_SLOTS;

/**
 * The built character models, loaded once and shared (D-559).
 *
 * `npm run build:characters` writes a `.glb` per character and one clip file
 * per rig variant into `client/public/models/`. A crowd in the tavern is
 * twenty entities on three models, so the download and the parse happen
 * ONCE per model and every instance is a skeleton clone over the same
 * geometry and the same material.
 *
 * Everything here is best-effort. A client whose `models/` has not been
 * built gets no manifest, `available()` stays false, and the game keeps
 * drawing procedural characters — an art pipeline that has not run must not
 * be able to leave somebody staring at an empty tavern.
 */

export interface ImportedOutfit {
  /** Person or creature: what the seed fallback may draw (D-618). */
  readonly kind?: 'person' | 'creature';
  readonly id: string;
  readonly model: string;
  readonly palette: string | null;
  readonly animations: string;
  readonly rig: string;
  readonly variant: string;
  /** Metres, as built. Instances are scaled from this to the wire height. */
  readonly height: number;
  /**
   * The slot vocabulary this character was assembled from, or null.
   *
   * ⚠ Null is the honest answer for a character discovered from a
   * `.unitypackage` or a folder of loose FBX (D-556, D-557): its meshes are
   * named after whatever file they came from, so a garment has nothing to
   * swap. Carrying the fact rather than letting the client infer it from a
   * mesh name is what stops "my armour is invisible" being a mystery.
   */
  readonly parts: {
    readonly pack: string;
    /** Which cut of the twice-cut parts this body takes (D-558). */
    readonly sex: 'male' | 'female';
    readonly parts: Record<string, string>;
  } | null;
}

export interface ManifestGarment {
  readonly id: string;
  readonly pack: string;
  readonly parts: { male: Record<string, string>; female: Record<string, string> };
}

interface Manifest {
  outfits: ImportedOutfit[];
  garments?: ManifestGarment[];
}

const MODELS = '/models/';

let manifest: Manifest | null = null;
let loading: Promise<void> | null = null;

/** One parsed model, ready to clone. */
interface Loaded {
  readonly scene: THREE.Object3D;
  readonly clips: readonly THREE.AnimationClip[];
  /**
   * How tall this scene stands, IN METRES, exactly as handed over (D-577).
   *
   * ⚠ Every loader here returns metres — the monolith is exported that way and
   * a re-assembly is converted from centimetres on the way out — so a caller
   * that wants a character at a given stature has one number to divide by.
   *
   * ⚠ It must come from the model ACTUALLY BUILT, never from the outfit's
   * manifest entry. The manifest measures the monolith; a body re-assembled
   * out of the parts a player chose is a different set of meshes and a
   * different height (1.90m against the manifest's 1.667m for the same
   * outfit), so normalising by the manifest silently mis-sizes exactly the
   * characters a player authored.
   */
  readonly height: number;
}

/**
 * How tall an assembled figure stands, measured the way the BUILD measures it.
 *
 * ⚠ From the BONES, lowest to highest, not from the mesh bounds — mirroring
 * `measureHeight` in `build:characters`, which is where every `height` in the
 * manifest comes from. The two definitions differ by real centimetres and in
 * a direction that matters: mesh bounds include a helmet crest and a hair
 * mesh, so the guard measures 1.92m by geometry against 1.70m by skeleton.
 * Normalising a crested guard by his crest makes him a short man wearing a
 * tall hat.
 *
 * Measuring it the other way here would also have silently RESIZED the
 * existing cast — up to 13% — while looking like a tidier implementation.
 */
export function heightOf(root: THREE.Object3D): number {
  root.updateMatrixWorld(true);
  let skeleton: THREE.Skeleton | null = null;
  root.traverse((o) => {
    const mesh = o as THREE.SkinnedMesh;
    if (!skeleton && mesh.isSkinnedMesh && mesh.skeleton) skeleton = mesh.skeleton;
  });
  if (skeleton) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const bone of (skeleton as THREE.Skeleton).bones) {
      const y = bone.matrixWorld.elements[13]!;
      lo = Math.min(lo, y);
      hi = Math.max(hi, y);
    }
    if (Number.isFinite(hi - lo) && hi - lo > 0) return hi - lo;
  }
  // Nothing rigged to measure — a prop, or a mesh that arrived unskinned.
  const box = new THREE.Box3().setFromObject(root);
  const y = box.max.y - box.min.y;
  return Number.isFinite(y) && y > 0 ? y : 0;
}

const models = new Map<string, Promise<Loaded>>();
const clipFiles = new Map<string, Promise<readonly THREE.AnimationClip[]>>();
const palettes = new Map<string, THREE.Texture>();

const loader = new GLTFLoader();
const textures = new THREE.TextureLoader();

/**
 * Read the manifest. Safe to call repeatedly and from anywhere; the first
 * call does the work and the rest await it.
 */
export function loadManifest(): Promise<void> {
  if (loading) return loading;
  loading = (async () => {
    try {
      const res = await fetch(`${MODELS}manifest.json`);
      if (!res.ok) return;
      manifest = (await res.json()) as Manifest;
    } catch {
      // No built models. Not an error: the procedural characters are still
      // the shipping default until the stakeholder says otherwise (D-555).
      manifest = null;
    }
  })();
  return loading;
}

export function available(): boolean {
  return (manifest?.outfits.length ?? 0) > 0;
}

export function outfits(): readonly ImportedOutfit[] {
  return manifest?.outfits ?? [];
}

/**
 * Which character an entity is drawn as when nobody chose a face.
 *
 * ⚠ Chosen from the appearance seed, which is still a PLACEHOLDER: the
 * seed is the server's (D-102) so every client agrees and a person keeps the
 * same body between sessions, but it is arbitrary -- nothing connects the
 * guard model to a guard.
 *
 * ⚠ It draws only from PEOPLE now (D-618). Ten of the twelve built
 * characters are monsters, so the lottery handed bots and NPCs a goblin, a
 * skeleton or a rock golem. A goblin should be drawn when content SAYS this
 * thing is a goblin -- a roamer naming its look (D-594) -- and never by
 * accident of a number.
 *
 * ⚠ If nothing is marked as a person it falls back to the whole list
 * rather than drawing nobody. An unclassified checkout showing the wrong
 * bodies is a bug you can see; an empty tavern is one that looks like the
 * server is down.
 */
export function pickOutfit(
  all: readonly ImportedOutfit[],
  seed: number,
): ImportedOutfit | null {
  if (all.length === 0) return null;
  const people = all.filter((o) => o.kind !== 'creature');
  all = people.length > 0 ? people : all;
  // Mix before taking a remainder. The low bits of a seed are the worst
  // bits, and `seed % 3` over consecutive ids hands out models in a
  // repeating cycle — a tavern where every third person is the same.
  const mixed = Math.abs(Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d)) >>> 0;
  return all[mixed % all.length] ?? null;
}

/** The built character with this id, or null if nothing built it. */
export function outfitById(id: string): ImportedOutfit | null {
  return outfits().find((o) => o.id === id) ?? null;
}

export function outfitFor(seed: number): ImportedOutfit | null {
  return pickOutfit(outfits(), seed);
}

/**
 * The outfit whose ATLAS a chosen look should be painted with (D-602).
 *
 * ⚠ A look says which MESHES; it does not say which palette, and the
 * palette was being taken from an outfit drawn out of the appearance SEED.
 * Ten of the twelve built outfits are monsters, so a player's face was
 * textured from a goblin, a skeleton or a rock golem depending on a number
 * nobody chose — and because the skin recolour substitutes the four exact
 * colours of the HERO atlas (D-560), against any other atlas it matched
 * nothing and every skin tone did nothing at all.
 *
 * ⚠ Matched on the pack the outfit's own parts came from, so it stays
 * right when more characters are authored. A whole-mesh creature (D-594) has
 * no parts and can never answer for a look.
 */
export function outfitForPack(pack: string): ImportedOutfit | null {
  return outfits().find((o) => o.parts?.pack === pack) ?? null;
}

async function parse(file: string): Promise<THREE.Object3D & { animations: THREE.AnimationClip[] }> {
  const gltf = await loader.loadAsync(`${MODELS}${file}`);
  const scene = gltf.scene as THREE.Object3D & { animations: THREE.AnimationClip[] };
  scene.animations = gltf.animations;
  return scene;
}

/** The clips for a rig variant, shared by every character on that rig. */
function clipsFor(outfit: ImportedOutfit): Promise<readonly THREE.AnimationClip[]> {
  const existing = clipFiles.get(outfit.animations);
  if (existing) return existing;
  const started = parse(outfit.animations)
    .then((s) => s.animations as readonly THREE.AnimationClip[])
    .catch(() => [] as readonly THREE.AnimationClip[]);
  clipFiles.set(outfit.animations, started);
  return started;
}

/**
 * The palette this character was coloured against.
 *
 * NEAREST and no mipmaps, always: the atlas is tiny and every UV island
 * lands on one flat region, so a bilinear tap between two of them invents a
 * colour the artist never chose — and then D-404's quantiser has to round it
 * to something that was never in the palette either.
 */
function paletteFor(outfit: ImportedOutfit): THREE.Texture | null {
  if (!outfit.palette) return null;
  const cached = palettes.get(outfit.palette);
  if (cached) return cached;
  const tex = textures.load(`${MODELS}${outfit.palette}`);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  // NOT flipY = false. That is the glTF convention for textures the loader
  // itself brings in, but this atlas is loaded separately and applied to
  // UVs that came through the FBX exporter — flipping it samples the wrong
  // row of the palette, which does not look like a bug, it looks like the
  // artist chose black and yellow.
  palettes.set(outfit.palette, tex);
  return tex;
}

export function load(outfit: ImportedOutfit): Promise<Loaded> {
  const existing = models.get(outfit.id);
  if (existing) return existing;
  const started = (async (): Promise<Loaded> => {
    const [scene, clips] = await Promise.all([parse(outfit.model), clipsFor(outfit)]);
    const palette = paletteFor(outfit);
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // The character is far from the camera's centre in an isometric view
      // and its bounding sphere is computed for the BIND pose; a raised arm
      // then culls the whole body at the screen edge.
      mesh.frustumCulled = false;
      const material = mesh.material as THREE.MeshStandardMaterial;
      if (palette && !material.map) {
        material.map = palette;
        material.needsUpdate = true;
      }
    });
    // ⚠ The monolith is exported in metres, so it is handed over unscaled and
    // its own bounds are the honest height. `outfit.height` was measured from
    // this very file at build time and is the fallback, not the source.
    return { scene, clips, height: heightOf(scene) || outfit.height };
  })();
  models.set(outfit.id, started);
  return started;
}

/** Pull every model into memory before the world needs them. */
export async function preload(): Promise<void> {
  await loadManifest();
  await Promise.all(outfits().map((o) => load(o).catch(() => null)));
}

/* ------------------------------------------------- wearing a garment ----- */

/**
 * Dressing an imported character (D-571).
 *
 * ⚠ A garment is a set of slot SWAPS (D-570), so wearing one means building
 * the character again with different parts in those slots — not adding meshes
 * on top. That is forced by the art, not chosen: of 720 parts the torso has
 * no bare option at all, so a body and its clothes are the same mesh and
 * there is nothing to layer over (D-560).
 *
 * ⚠ It also cannot be done by grafting onto the built `.glb`, and that was
 * measured rather than assumed. Every character's skeleton is the union of
 * ITS parts' weighted bones, so the three built characters carry 53, 47 and
 * 47 bones in three different orders — and `ashfold-guard` has the cape
 * chain (`Capes_01`, `back_02`…`back_05`) that `ashfold-townsfolk` has no
 * bones for at all. Grafting a caped garment onto the townsfolk would bind
 * every cape vertex to bone zero and pool it at the pelvis, silently.
 *
 * Re-assembling has none of those problems because `assemble()` computes the
 * union for whatever combination it is given — the same call the build makes,
 * which is why what renders here is what the build would have written.
 */

/** One part file, parsed once and shared. */
const parts = new Map<string, Promise<THREE.SkinnedMesh>>();

function firstSkinned(root: THREE.Object3D): THREE.SkinnedMesh {
  let found: THREE.SkinnedMesh | null = null;
  root.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (m.isSkinnedMesh && !found) found = m;
  });
  if (!found) throw new Error('part file has no skinned mesh');
  return found;
}

function partMesh(pack: string, stem: string): Promise<THREE.SkinnedMesh> {
  const file = `parts/${pack}__${stem}.glb`;
  const existing = parts.get(file);
  if (existing) return existing;
  const started = parse(file).then(firstSkinned);
  parts.set(file, started);
  return started;
}

export function garments(): readonly ManifestGarment[] {
  return manifest?.garments ?? [];
}

/**
 * The parts a character wears, after applying garments, in slot order.
 *
 * ⚠ SLOT ORDER, and it is not cosmetic. `assemble` derives its bone array by
 * walking the hierarchy as it builds it, so the order parts arrive in decides
 * the order bones end up in. It does not affect what renders — `skinIndex` is
 * remapped and clips bind by name, both measured — but two assemblies of one
 * character that disagree are exactly the pair that makes any later
 * comparison between build and browser meaningless.
 *
 * ⚠ Later garments win. Two garments claiming the torso is a decision
 * somebody made by equipping both, and the last one on is the one you see —
 * the same rule a paperdoll already follows for a slot.
 */
/**
 * Lay one worn thing over the slots it covers (D-616).
 *
 * ⚠ ONE implementation, because there were two. `dressedParts` and
 * `loadLook` each carried their own copy of "walk the wearing list and
 * overwrite the slots" — one for a body built from a definition, one for a
 * face a player chose — and the hood was taught to the first only. So a
 * character could not raise a hood if they had picked their own face, which
 * is every player who goes through creation. Found by measuring the assembly
 * before and after: fourteen meshes, then the same fourteen.
 */
function layer(
  worn: Map<string, { pack: string; stem: string }>,
  id: string,
  sex: 'male' | 'female',
  // ⚠ The wardrobe is PASSED, not read from the module. `dressedParts`
  // takes one so a test can inject a known set, and the first cut of this
  // helper quietly ignored it and read the real manifest instead -- which
  // turned five garment tests red at once with "expected Torso_F00 to be
  // Torso_F15". Extracting shared code has to carry the seams with it.
  wardrobe: readonly ManifestGarment[] = garments(),
): void {
  // The hood is presentation, not equipment (D-219), and comes from its own
  // catalogue. It rides in the same list purely so the assembly cache and the
  // part resolution work unchanged; it is never equipped and never on the
  // wire as a garment.
  if (id === HOOD_ID) {
    const stem = hoodStem();
    // ⚠ Unisex: the pack cuts head coverings once for both bodies, so
    // nothing here picks by sex because there is nothing to pick between.
    if (stem) worn.set('headCovering', { pack: hoodPack(), stem });
    return;
  }
  const garment = wardrobe.find((g) => g.id === id);
  if (!garment) return;
  for (const [slot, stem] of Object.entries(garment.parts[sex] ?? {})) {
    worn.set(slot, { pack: garment.pack, stem });
  }
}

export function dressedParts(
  outfit: ImportedOutfit,
  wearing: readonly string[],
  wardrobe: readonly ManifestGarment[] = garments(),
): { pack: string; slot: string; stem: string }[] {
  if (!outfit.parts) return [];
  const sex = outfit.parts.sex;
  const worn = new Map<string, { pack: string; stem: string }>();
  for (const [slot, stem] of Object.entries(outfit.parts.parts)) {
    worn.set(slot, { pack: outfit.parts.pack, stem });
  }
  for (const id of wearing) layer(worn, id, sex as 'male' | 'female', wardrobe);
  return SLOT_ORDER.flatMap((slot) => {
    const part = worn.get(slot);
    return part ? [{ slot, pack: part.pack, stem: part.stem }] : [];
  });
}

/**
 * The model for a face a player CHOSE, rather than one picked from a seed
 * (D-574).
 *
 * ⚠ This is the answer to the question D-559 left open — "which character an
 * entity is drawn as is UNRESOLVED... picked from the seed, which is
 * deterministic and agreed across clients but arbitrary: nothing connects the
 * guard model to a guard." Nothing needs to connect it: the player said. A
 * look names a part per slot, and those parts are what gets assembled.
 *
 * ⚠ It falls back to the seed when there is no look, which is every NPC, every
 * roamer, every corpse and every character made before the face step. That is
 * not a degraded path, it is the path almost everything still takes.
 *
 * ⚠ The body slots come from the look too, not from an outfit — a race curates
 * a bare torso and limbs alongside the face (D-563), so a chosen face arrives
 * with a body to hang it on. A look missing a body slot simply has no mesh
 * there, which is visible immediately rather than silently wrong.
 */
/**
 * The palette this character's skin and markings are painted on (D-574).
 *
 * ⚠ A recolour on the ATLAS, not on the material. D-560 measured why it is
 * safe: skin is FOUR flat colours in the whole 1024² atlas and markings are a
 * fifth that no other part touches, so substituting them exactly leaves every
 * garment colour alone — and NEAREST filtering means each UV island stays
 * inside one flat region rather than sampling a blend of two.
 *
 * ⚠ Cached per colour, not per character. A cast of twenty in three skin
 * tones is three textures, and without the cache it would be twenty canvases
 * and twenty uploads.
 */
const tinted = new Map<string, THREE.Texture | null>();

function tintedPalette(
  outfit: ImportedOutfit,
  skin: string | undefined,
  markings: string | undefined,
): THREE.Texture | null {
  const base = paletteFor(outfit);
  if (!base || (!skin && !markings)) return base;
  const key = `${outfit.palette}|${skin ?? ''}|${markings ?? ''}`;
  const cached = tinted.get(key);
  if (cached !== undefined) return cached;

  const image = base.image as HTMLImageElement | undefined;
  // ⚠ The image may not have decoded yet. Returning the untinted palette is
  // the honest miss — a wrong SKIN for a frame — rather than caching a blank
  // canvas under this key and painting everybody in that tone for good.
  if (!image?.width) return base;

  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return base;
  ctx.drawImage(image, 0, 0);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = data.data;

  const swaps = new Map<number, [number, number, number]>();
  for (const { from, to } of [
    ...(skin ? skinPalette(skin) : []),
    ...(markings ? [markingSwap(markings)] : []),
  ]) {
    const f = parseInt(from.slice(1), 16);
    const t = parseInt(to.slice(1), 16);
    swaps.set(f, [(t >> 16) & 255, (t >> 8) & 255, t & 255]);
  }
  for (let i = 0; i < px.length; i += 4) {
    const hit = swaps.get((px[i]! << 16) | (px[i + 1]! << 8) | px[i + 2]!);
    if (!hit) continue;
    px[i] = hit[0];
    px[i + 1] = hit[1];
    px[i + 2] = hit[2];
  }
  ctx.putImageData(data, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tinted.set(key, tex);
  return tex;
}

export function loadLook(
  look: { parts: Record<string, string>; skin?: string; markings?: string },
  pack: string,
  outfit: ImportedOutfit,
  wearing: readonly string[] = [],
): Promise<Loaded> {
  const worn = new Map<string, { pack: string; stem: string }>();
  for (const [slot, stem] of Object.entries(look.parts)) worn.set(slot, { pack, stem });
  // ⚠ A garment is cut for a BODY (D-571), and a look has no sex of its
  // own — the parts it names carry it. Read the cut from the parts
  // themselves rather than guessing, so a female body does not end up in a
  // male hauberk at the wrong diameter.
  for (const id of wearing) layer(worn, id, sexOfLook(look.parts));

  // ⚠ The colours are part of the key. Two characters in the same parts and
  // different skin are two models, and leaving the tone out would hand the
  // second one the first one's face.
  const key = `look:${pack}:${SLOT_ORDER.map((s) => worn.get(s)?.stem ?? '').join(',')}`
    + `|${look.skin ?? ''}|${look.markings ?? ''}`;
  const existing = dressed.get(key);
  if (existing) return existing;

  const started = (async (): Promise<Loaded> => {
    const wanted = SLOT_ORDER.flatMap((slot) => {
      const part = worn.get(slot);
      return part ? [{ slot, ...part }] : [];
    });
    const [meshes, clips] = await Promise.all([
      Promise.all(wanted.map(async (p) => ({ slot: p.slot, mesh: await partMesh(p.pack, p.stem) }))),
      clipsFor(outfit),
    ]);
    const built = assemble(meshes);
    built.skeleton.pose();
    built.group.scale.setScalar(0.01);
    built.group.updateMatrixWorld(true);
    const palette = tintedPalette(outfit, look.skin, look.markings);
    for (const mesh of built.meshes) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      const material = mesh.material as THREE.MeshStandardMaterial;
      if (palette && !material.map) {
        material.map = palette;
        material.needsUpdate = true;
      }
    }
    return { scene: built.group, clips, height: heightOf(built.group) };
  })();
  dressed.set(key, started);
  return started;
}

/**
 * Which cut a look's parts are, read from the parts rather than stored.
 *
 * ⚠ Not a roleplaying statement and never shown (D-558): it selects which
 * MESHES fit, and the look already contains the answer in its own filenames.
 * Storing it as well would be a second source that can disagree with the
 * parts it describes.
 */
export function sexOfLook(parts: Record<string, string>): 'male' | 'female' {
  for (const stem of Object.values(parts)) {
    if (/_Female_/i.test(stem)) return 'female';
    if (/_Male_/i.test(stem)) return 'male';
  }
  return 'male';
}

/** A stable name for one combination, so a crowd in the same kit shares one. */
function dressedKey(outfit: ImportedOutfit, wearing: readonly string[]): string {
  return `${outfit.id}|${[...wearing].sort().join(',')}`;
}

const dressed = new Map<string, Promise<Loaded>>();

/**
 * The model for a character wearing these garments.
 *
 * ⚠ Falls straight through to {@link load} when there is nothing to wear, so
 * the common case costs exactly what it did before: one download, one parse,
 * one shared scene. Assembling is only paid for by somebody actually dressed.
 *
 * ⚠ A character with no slot vocabulary cannot be dressed and says so by
 * returning the plain model. One discovered from a `.unitypackage` or a
 * folder of loose FBX (D-556, D-557) has meshes named after whatever file
 * they came from, so there is nothing for a swap to replace — that is a
 * property of how it was assembled, not a fault, and the manifest carries
 * `parts: null` to make it checkable rather than guessable.
 */
export function loadDressed(
  outfit: ImportedOutfit,
  wearing: readonly string[],
): Promise<Loaded> {
  if (wearing.length === 0 || !outfit.parts) return load(outfit);
  const key = dressedKey(outfit, wearing);
  const existing = dressed.get(key);
  if (existing) return existing;

  const started = (async (): Promise<Loaded> => {
    const wanted = dressedParts(outfit, wearing);
    const [meshes, clips] = await Promise.all([
      Promise.all(
        wanted.map(async (p) => ({ slot: p.slot, mesh: await partMesh(p.pack, p.stem) })),
      ),
      clipsFor(outfit),
    ]);
    const built = assemble(meshes);
    built.skeleton.pose();
    // ⚠ The part files are exported at the scale they were modelled, in
    // centimetres, precisely so this conversion happens ONCE and here. A part
    // pre-scaled by the build would be converted twice and produce a
    // 1.8-centimetre knight, which renders perfectly at the wrong size.
    built.group.scale.setScalar(0.01);
    built.group.updateMatrixWorld(true);

    const palette = paletteFor(outfit);
    for (const mesh of built.meshes) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      const material = mesh.material as THREE.MeshStandardMaterial;
      if (palette && !material.map) {
        material.map = palette;
        material.needsUpdate = true;
      }
    }
    return { scene: built.group, clips, height: heightOf(built.group) };
  })();
  dressed.set(key, started);
  return started;
}
