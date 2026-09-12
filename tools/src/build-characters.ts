/**
 * Turning somebody else's art into one file this game can load (D-555).
 *
 *   npm run build:characters
 *
 * Reads a Synty Sidekick `.unitypackage` and a folder of Mixamo `.fbx`
 * animations out of `assets/incoming/`, and writes a `.glb` per outfit into
 * `client/public/models/` with every animation already retargeted onto the
 * Sidekick skeleton and baked in.
 *
 * The point of this file is that there is NO manual step. No Blender, no
 * Unity, no engine import. Dropping a new animation in `assets/incoming/`
 * and running this again is the whole workflow, which is the only version
 * of an art pipeline that survives a stakeholder who does not open 3D tools
 * (D-114).
 */
import './node-dom';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AnimationClip,
  BufferAttribute,
  Bone,
  Group,
  Matrix4,
  MeshStandardMaterial,
  Object3D,
  Skeleton,
  SkinnedMesh,
  Vector3,
  VectorKeyframeTrack,
} from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import {
  CHARACTER_SLOTS,
  CharacterDefSchema,
  GarmentSchema,
  type GarmentDef,
  RaceSchema,
  type RaceDef,
  type CharacterDef,
  MIXAMO_HIP,
  RIG_FROM_MIXAMO,
  RIG_HIP,
  type RigKind,
  detectRig,
  findBone,
  hipBoneFor,
  parsePartName,
  rigNamesFor,
  rigVariant,
  assetAtlas,
  preferredAtlas,
} from '@rc/shared';
import { readUnityPackage } from './unitypackage';
import { type Pack, meshPath, packOf, partStems, texturePaths, texturesIn } from './packs';
// ONE assembly implementation, shared with the browser studio (D-558): a
// preview that assembles differently from the build is a preview that lies.
import { assemble, type Assembled } from '../../client/src/render/assembly';

const root = fileURLToPath(new URL('../..', import.meta.url));
const INCOMING = join(root, 'assets', 'incoming');
/**
 * Whole-character FBX files, one character each — anything that is not a
 * Synty pack. This is the escape hatch that keeps the pipeline from being
 * tied to one vendor's licence (D-556).
 */
const CHARACTER_DIR = join(INCOMING, 'characters');
/** Where the Mixamo downloader writes (D-564); loose drops still work too. */
const ANIMATION_DIR = join(INCOMING, 'animations');
const OUT_DIR = join(root, 'client', 'public', 'models');
/**
 * Characters authored in the studio (D-558).
 *
 * A small JSON document naming one part per slot. This is the path that
 * matters: the pack's own `.sk` files give us whatever the vendor happened
 * to dress, and a loose FBX folder gives us one character per folder, but
 * neither lets anybody DECIDE what a character looks like. This does, and
 * the decision is in git while the art is not (D-110).
 */
const DEF_DIR = join(root, 'content', 'characters');
const GARMENT_DIR = join(root, 'content', 'garments');
const RACE_DIR = join(root, 'content', 'races');

/**
 * Sidekick is authored in centimetres; this game is in metres (an
 * appearance height is 1.5-2.1, see `shared/src/appearance.ts`). Applying
 * the conversion as a scale on the exported root means the bones, the
 * geometry and the hip translation baked into every clip all come through
 * consistently - a scale applied to the geometry alone would leave a walk
 * cycle striding a hundred metres a step.
 */
const CM_TO_M = 0.01;

/**
 * What a character is made of.
 *
 * The pack authors this for us: every Sidekick character ships a `.sk` file
 * naming its exact parts, one slot at a time, and a colour map cut to match
 * that combination. Reading it beats guessing at a body-plus-outfit rule
 * from filenames, which produced characters whose palette belonged to
 * somebody else. Content is data (D-110), including somebody else's.
 */
interface Outfit {
  readonly id: string;
  /** Part filenames, without the `.fbx`, in the order the pack lists them. */
  readonly parts: readonly string[];
  /** The 32x32 palette this combination was coloured against, if it ships one. */
  readonly palette: Buffer | null;
  /** Where it came from, for the build log — the paths are otherwise equal. */
  readonly source: 'pack' | 'fbx' | 'defined' | 'mesh';
}

/**
 * Parse a `.sk` character definition.
 *
 * The format is a flat list of `- Name: <part>` under `Parts:`, so the parse
 * is deliberately shallow: anything else in the file is ignored rather than
 * modelled, because we only need which meshes to assemble.
 */
function parseSk(text: string): string[] {
  const parts: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^-\s*Name:\s*(\S+)/.exec(line.trim());
    if (m) parts.push(m[1]!);
  }
  return parts;
}

/** A readable id from a pack path: `Starter_01` becomes `starter-01`. */
function outfitId(skPath: string): string {
  return basename(skPath, '.sk')
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase();
}

/**
 * Every character the pack defines, with the palette it was coloured for.
 *
 * The colour map lives beside the `.sk` in a `Textures/` folder named after
 * the character. A character with no map still builds — it renders untinted
 * rather than not at all, which is the failure that is visible in play.
 */
function discoverOutfits(pkg: Map<string, Buffer>): Outfit[] {
  const outfits: Outfit[] = [];
  for (const [path, data] of pkg) {
    if (!path.endsWith('.sk')) continue;
    const dir = path.slice(0, path.lastIndexOf('/'));
    const stem = basename(path, '.sk');
    const palette = pkg.get(`${dir}/Textures/T_${stem}ColorMap.png`) ?? null;
    outfits.push({
      id: outfitId(path),
      parts: parseSk(data.toString('utf8')),
      palette,
      source: 'pack',
    });
  }
  return outfits.sort((a, b) => a.id.localeCompare(b.id));
}

function loadFbx(data: Buffer): Group {
  const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  return new FBXLoader().parse(ab, '');
}

/** Every `.fbx` in the package, keyed by its bare filename. */
function collectParts(pkg: Map<string, Buffer>): Map<string, Buffer> {
  const parts = new Map<string, Buffer>();
  for (const [path, data] of pkg) {
    if (path.toLowerCase().endsWith('.fbx')) parts.set(basename(path), data);
  }
  return parts;
}


/**
 * Resolve a character's part list to meshes.
 *
 * One slot, one mesh: the `.sk` already picks a winner per slot, so nothing
 * here layers anything. A part the pack names but does not ship is a broken
 * definition and throws — silently dropping it produces a character missing
 * a shin, which nobody notices until it is on screen.
 */
function partsFor(outfit: Outfit, all: Map<string, Buffer>): { slot: string; mesh: SkinnedMesh }[] {
  const bySlot = new Map<string, Buffer>();
  for (const name of outfit.parts) {
    const file = `${name}.fbx`;
    const data = all.get(file);
    if (!data) throw new Error(`${outfit.id} names ${file}, which is not in the package`);
    const parsed = parsePartName(file);
    if (!parsed) throw new Error(`cannot read a slot out of ${file}`);
    bySlot.set(parsed.slot, data);
  }
  return [...bySlot.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([slot, data]) => ({ slot, mesh: firstSkinnedMesh(loadFbx(data), slot) }));
}

/**
 * The one skinned mesh in a loaded FBX, or the first of several.
 *
 * A part file holds exactly one; a whole-character file may hold two or
 * three (Mixamo splits body and joints). Callers that want all of them use
 * {@link skinnedMeshes}.
 */
function firstSkinnedMesh(group: Group, what: string): SkinnedMesh {
  const all = skinnedMeshes(group);
  if (all.length === 0) throw new Error(`${what} has no skinned mesh`);
  return all[0]!;
}

function skinnedMeshes(group: Group): SkinnedMesh[] {
  const out: SkinnedMesh[] = [];
  group.traverse((o: Object3D) => {
    if ((o as SkinnedMesh).isSkinnedMesh) out.push(o as SkinnedMesh);
  });
  return out;
}

/**
 * Retarget one Mixamo clip onto the assembled rig.
 *
 * `retargetClip` looks names up target-first, so the dictionary is keyed by
 * OUR bone names. Bones with no entry — twists, the IK chain, the
 * attachment sockets — keep their rest orientation relative to a parent
 * that did move, which is what you want; inventing a mapping for a twist
 * bone is how an elbow comes to rotate twice.
 */
/**
 * The correction that makes a Mixamo clip fit an Unreal skeleton.
 *
 * `retarget` copies each source bone's WORLD rotation onto the target bone.
 * That is only right when the two rigs agree about which way a bone points
 * at rest, and they do not: Mixamo's bones run down one axis and Sidekick's
 * (Unreal's) down another. Copied raw, the first export stood a 1.78m
 * character up and then folded it into a 1.0m concertina — spine, arms and
 * legs all collapsed to roughly hip height.
 *
 * The fix is per-bone and arithmetic rather than artistic: for each mapped
 * pair take `sourceRest⁻¹ · targetRest` in rotation only, and hand it to
 * `localOffsets`. `retarget` then computes
 * `sourceAnimated · sourceRest⁻¹ · targetRest`, which is the source's
 * rotation DELTA applied to the target's own rest orientation. Feed it the
 * source at rest and the target comes out at rest, which is the property the
 * naive version lacked.
 *
 * Nothing here is tuned by eye, so it holds for any Mixamo clip rather than
 * for the five that happened to be tried.
 */
/**
 * Put a rig into its rest pose with fresh world matrices, and hand back the
 * object those matrices are relative to.
 *
 * The reference frame has to be the top of the HIERARCHY, not the
 * SkinnedMesh — bones are siblings of the mesh, not its children, so
 * `mesh.updateMatrixWorld(true)` refreshes the mesh and leaves every bone
 * on whatever the loader last computed. That reads as a subtly wrong number
 * rather than an error: the hip scale came out 0.14 instead of 0.91 and the
 * walk shrank to a shuffle, 12cm off the floor, moving at a fifth of a pace.
 */
/**
 * A rig in its bind pose, with fresh world matrices, and the object those
 * matrices are relative to.
 *
 * Two things here were each worth a wrong character.
 *
 * The frame has to be the top of the HIERARCHY, not the SkinnedMesh: bones
 * are siblings of the mesh, not its children, so `mesh.updateMatrixWorld()`
 * refreshes the mesh and leaves every bone on whatever the loader last
 * computed. That reads as a subtly wrong number rather than an error — the
 * hip scale came out 0.14 instead of 0.91 and the walk became a shuffle
 * 12cm off the floor.
 *
 * And the pose is `Skeleton.pose()` — the BIND pose, rebuilt from the
 * inverse-bind matrices — not whatever pose the file's node hierarchy
 * happens to be in. Those differ, and the bind pose is the one the vertex
 * weights were authored against.
 */
function restFrame(mesh: SkinnedMesh): Object3D {
  let top: Object3D = mesh;
  while (top.parent) top = top.parent;
  mesh.skeleton.pose();
  top.updateMatrixWorld(true);
  return top;
}

function localOffsets(
  target: SkinnedMesh,
  source: SkinnedMesh,
  names: Record<string, string>,
): Record<string, Matrix4> {
  const targetFrame = restFrame(target);
  const sourceFrame = restFrame(source);

  const rotationOf = (bone: Object3D, frame: Object3D): Matrix4 => {
    const m = new Matrix4().copy(frame.matrixWorld).invert().multiply(bone.matrixWorld);
    const scale = new Vector3().setFromMatrixScale(m);
    return m.scale(new Vector3(1 / scale.x, 1 / scale.y, 1 / scale.z)).setPosition(0, 0, 0);
  };

  const byName = (skeleton: Skeleton, name: string): Object3D | undefined =>
    skeleton.bones.find((b) => b.name === name);

  const offsets: Record<string, Matrix4> = {};
  for (const [targetName, sourceName] of Object.entries(names)) {
    const t = byName(target.skeleton, targetName);
    const s = byName(source.skeleton, sourceName);
    if (!t || !s) continue;
    const sourceRest = rotationOf(s, sourceFrame);
    const targetRest = rotationOf(t, targetFrame);
    offsets[targetName] = sourceRest.invert().multiply(targetRest);
  }
  return offsets;
}

/**
 * How much of the source's hip travel to keep.
 *
 * The hip is the one bone whose TRANSLATION is copied, and Mixamo's actor is
 * not the same height as ours. Copied unscaled, a walk cycle either drifts
 * ahead of the feet or lags behind them — the classic skating. The ratio of
 * hip heights at rest is the honest conversion.
 *
 * Both heights are measured in their own rig's frame, so a source that
 * happens to be loaded under a scaled parent cannot quietly change the
 * answer.
 */
function hipScale(target: SkinnedMesh, source: SkinnedMesh, kind: RigKind): number {
  const hip = findBone(
    target.skeleton.bones.map((b) => b.name),
    hipBoneFor(kind),
  );
  const t = target.skeleton.bones.find((b) => b.name === hip);
  const s = source.skeleton.bones.find((b) => b.name === MIXAMO_HIP);
  if (!t || !s) return 1;
  const heightIn = (bone: Object3D, frame: Object3D): number =>
    new Vector3()
      .setFromMatrixPosition(
        new Matrix4().copy(frame.matrixWorld).invert().multiply(bone.matrixWorld),
      )
      .y;
  const th = heightIn(t, restFrame(target));
  const sh = heightIn(s, restFrame(source));
  return Math.abs(sh) > 1e-6 ? th / sh : 1;
}

/**
 * The real rig, when a Mixamo export ships two.
 *
 * `Neutral Idle.fbx` contains two skinned meshes: `Beta_Surface`, bound to
 * the actual 65-bone skeleton, and `Beta_Joints`, bound to 64 zero-offset
 * LEAF stubs — one hung off each real bone, each with no children of its
 * own. Taking the first skinned mesh in the file picked the stubs.
 *
 * The result is a pose that is wrong in a way no log would show. A retarget
 * reads world matrices, and a stub's world matrix is its real parent's REST
 * transform times whatever the clip just wrote to the stub: none of the
 * rotation accumulated down the chain is there, because the stub has no
 * chain. The clip binds to the stubs too, so the real skeleton never moves.
 * This character came out with its arms folded over its head and its legs
 * crumpled underneath it, while the other four clips — whose duplicate rig
 * is a SIBLING rather than a shadow — were fine.
 *
 * So the rule is structural, not a filename: the real rig is the one that is
 * not a set of duplicates hanging off another rig's bones. A file with only
 * one skeleton is unaffected, which is every other drop we have.
 */
function animationSource(group: Group, what: string): SkinnedMesh {
  const all = skinnedMeshes(group);
  if (all.length === 0) return boneOnlySource(group, what);
  const isShadow = (mesh: SkinnedMesh): boolean =>
    mesh.skeleton.bones.some((bone) => {
      for (let up: Object3D | null = bone.parent; up; up = up.parent) {
        if (up.name === bone.name) return true;
      }
      return false;
    });
  return all.find((m) => !isShadow(m)) ?? all[0]!;
}

/**
 * A source rig for an animation file that carries no mesh at all.
 *
 * A library export asked for WITHOUT skin is bones and curves and nothing
 * else, which is what we want — the mesh is 3 MB of a character nobody is
 * going to draw. But `retargetClip` reads `source.skeleton`, and so do the
 * scale and offset calculations, so there has to be one. This wraps the file's
 * bone hierarchy in a `Skeleton` and hangs an empty `SkinnedMesh` off it.
 *
 * ⚠ The bones go in PARENT-BEFORE-CHILD order. `SkeletonUtils` walks
 * `skeleton.bones` as a flat array and derives each bone's local transform
 * from its parent's world matrix, so a child listed first is solved against a
 * parent that has not been solved yet — the defect that put the right forearm
 * 82 degrees out in D-558. Discovery order from `traverse` happens to be
 * correct here, but stating it is what stops it silently ceasing to be.
 */
function boneOnlySource(group: Group, what: string): SkinnedMesh {
  const bones: Bone[] = [];
  const walk = (o: Object3D): void => {
    if ((o as Bone).isBone) bones.push(o as Bone);
    for (const child of o.children) walk(child);
  };
  for (const child of group.children) walk(child);
  if (bones.length === 0) throw new Error(`${what} has neither a skinned mesh nor any bones`);

  group.updateMatrixWorld(true);
  const inverses = bones.map((b) => new Matrix4().copy(b.matrixWorld).invert());
  const mesh = new SkinnedMesh();
  // A SIBLING of the bone root, never its parent: reparenting the root under
  // the mesh while the mesh is under the group makes a cycle, and the first
  // `updateMatrixWorld` walks it until the stack runs out. `restFrame` only
  // needs to reach the file's top, and from a sibling it does.
  group.add(mesh);
  // An explicit identity bind matrix keeps the bind off whatever transform the
  // exporter happened to leave on the mesh node.
  mesh.bind(new Skeleton(bones, inverses), new Matrix4());
  group.updateMatrixWorld(true);
  return mesh;
}

/**
 * Take the net travel out of a clip that loops.
 *
 * Mixamo will sell you a walk with root motion baked in, and this one has
 * it: 155cm of forward hip travel over a 1.03s cycle. Played on a character
 * whose position the SERVER owns (invariant 1), that is the client deciding
 * where somebody is — the figure slides a metre and a half ahead of itself
 * and then snaps back when the clip wraps, which is what reads as jank.
 *
 * A cycle is recognised, not configured: a clip that ends at the hip height
 * it started at has returned to its own first pose, so any horizontal
 * distance it covered is drift. Removing it as a straight ramp keeps the
 * side-to-side sway of the hips — zeroing the axes outright would flatten
 * the walk into a glide.
 *
 * Clips that genuinely end somewhere else are left alone: `death` drops to
 * the floor and `stand-to-sit` moves onto a stool, and both need their
 * translation. Those still travel, which is a question for whoever places
 * the body, not something to silently delete here.
 */
function removeCycleDrift(clip: AnimationClip, hip: string): number {
  const track = clip.tracks.find(
    (t): t is VectorKeyframeTrack => t.name === `.bones[${hip}].position`,
  );
  if (!track) return 0;
  const v = track.values;
  const times = track.times;
  const n = times.length;
  if (n < 2) return 0;

  // Ends at the height it began: the pose has come back round, so whatever
  // ground it covered is travel rather than part of the motion.
  const startY = v[1]!;
  const endY = v[(n - 1) * 3 + 1]!;
  if (Math.abs(endY - startY) > 2) return 0;

  const driftX = v[(n - 1) * 3]! - v[0]!;
  const driftZ = v[(n - 1) * 3 + 2]! - v[2]!;
  const distance = Math.hypot(driftX, driftZ);
  if (distance < 1) return 0;

  const span = times[n - 1]! - times[0]!;
  for (let i = 0; i < n; i++) {
    const k = span > 0 ? (times[i]! - times[0]!) / span : 0;
    v[i * 3] = v[i * 3]! - driftX * k;
    v[i * 3 + 2] = v[i * 3 + 2]! - driftZ * k;
  }
  return distance;
}

function retarget(
  target: SkinnedMesh,
  sourceFbx: Group,
  name: string,
  kind: RigKind,
): AnimationClip {
  const clip = sourceFbx.animations.find((a) => a.tracks.length > 0);
  if (!clip) throw new Error(`${name} carries no animation`);
  const source = animationSource(sourceFbx, name);
  const names = rigNamesFor(
    target.skeleton.bones.map((b) => b.name),
    kind,
  );
  const out = SkeletonUtils.retargetClip(target, source, clip, {
    names,
    scale: hipScale(target, source, kind),
    hip: MIXAMO_HIP,
    fps: 30,
    // `localOffsets` is implemented and documented in three r185's
    // SkeletonUtils but missing from @types/three, so it has to be widened
    // in. Without it the retarget is not merely imprecise, it folds the
    // character in half - see `localOffsets` above.
    ...({ localOffsets: localOffsets(target, source, names) } as object),
  });
  out.name = name;
  removeCycleDrift(out, findBone(target.skeleton.bones.map((b) => b.name), hipBoneFor(kind)) ?? '');
  return rebindToBoneNames(out);
}

/**
 * `retargetClip` names its tracks `.bones[pelvis].quaternion`, which only
 * resolves if the clip is played on the SkinnedMesh itself. glTF animates
 * nodes, so the exporter looks the name up in the scene graph, finds
 * nothing, and drops the track — leaving a `.glb` that loads cleanly,
 * animates nothing, and gives no reason why. Renaming to the plain bone
 * name makes the same track resolve against the Bone node in both worlds.
 */
function rebindToBoneNames(clip: AnimationClip): AnimationClip {
  for (const track of clip.tracks) {
    track.name = track.name.replace(/^\.bones\[([^\]]+)\]\./, '$1.');
  }
  return clip;
}

function animationName(file: string): string {
  return basename(file, '.fbx')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Where the shared clips land, alongside the outfit meshes. */
export const ANIMATION_FILE = 'animations.glb';

/**
 * What was built, written beside the models.
 *
 * The client should not have to hardcode a list of character ids that only
 * exists because of whatever somebody dropped in `assets/incoming` — the
 * build knows, so the build says.
 */
export const MANIFEST_FILE = 'manifest.json';

export interface BuildReport {
  outfits: {
    id: string;
    palette: boolean;
    parts: number;
    vertices: number;
    height: number;
    bytes: number;
    rig: RigKind;
    variant: string;
    source: 'pack' | 'fbx' | 'defined' | 'mesh';
  }[];
  clips: { name: string; duration: number; tracks: number }[];
  /**
   * Weighting faults found in the source art and corrected. Printed, never
   * swallowed: the pipeline is allowed to fix somebody else's art, but not
   * to do it quietly.
   */
  repairs: string[];
  animationBytes: number;
  /** One `.glb` per part any definition or garment names (D-571). */
  parts: { file: string; bytes: number }[];
  partBytes: number;
}

function measureHeight(a: Assembled): number {
  a.skeleton.pose();
  a.group.updateMatrixWorld(true);
  let lo = Infinity;
  let hi = -Infinity;
  for (const bone of a.skeleton.bones) {
    const y = bone.matrixWorld.elements[13]!;
    lo = Math.min(lo, y);
    hi = Math.max(hi, y);
  }
  return hi - lo;
}

async function toGlb(root: Object3D, clips: readonly AnimationClip[]): Promise<Buffer> {
  const glb = await new GLTFExporter().parseAsync(root, {
    binary: true,
    animations: clips as AnimationClip[],
    // The palette is generated per character at runtime, so there is nothing
    // to embed and nothing here needs a canvas to rasterise it.
    embedImages: false,
  });
  if (!(glb instanceof ArrayBuffer)) throw new Error('exporter did not return binary glTF');
  return Buffer.from(glb);
}

/**
 * The blendshapes worth carrying.
 *
 * Every Sidekick part ships morph targets, and the head ships seventy-two of
 * them — a full facial set: jaw, brows, every eyelid. On an orthographic
 * camera nineteen units out a lip curl is invisible, and they cost 7 MB of
 * the first build's 11.6. These four are the ones that do visible work: they
 * are the body-shape sliders, and they are how `bulk` and `masculine` in
 * `shared/src/appearance.ts` reach an imported mesh rather than being
 * quietly dropped on the way in.
 *
 * Widening this list is the whole change if a close camera ever arrives.
 */
const KEEP_MORPHS: readonly string[] = ['defaultBuff', 'defaultSkinny', 'defaultHeavy', 'masculineFeminine'];

/**
 * Drop every morph target but {@link KEEP_MORPHS}, in place.
 *
 * Names arrive namespaced by part (`HEADBlends.defaultBuff`,
 * `HAIRBlends.defaultBuff`), so the match is on the suffix — otherwise the
 * same slider would have to be listed once per part and would silently stop
 * working the first time somebody added a hat.
 */
function pruneMorphs(mesh: SkinnedMesh): void {
  const dict = mesh.morphTargetDictionary;
  const attrs = mesh.geometry.morphAttributes;
  if (!dict || !attrs.position) return;
  const keep = Object.entries(dict)
    .filter(([name]) => KEEP_MORPHS.includes(name.split('.').pop() ?? name))
    .sort((a, b) => a[1] - b[1]);
  const nextDict: Record<string, number> = {};
  type MorphAttr = (typeof attrs.position)[number];
  const nextPositions: MorphAttr[] = [];
  const nextNormals: MorphAttr[] | undefined = attrs.normal ? [] : undefined;
  for (const [name, index] of keep) {
    nextDict[name.split('.').pop() ?? name] = nextPositions.length;
    nextPositions.push(attrs.position[index]!);
    if (nextNormals && attrs.normal) nextNormals.push(attrs.normal[index]!);
  }
  attrs.position = nextPositions;
  if (nextNormals) attrs.normal = nextNormals;
  mesh.morphTargetDictionary = nextDict;
  mesh.morphTargetInfluences = nextPositions.map(() => 0);
}

/** One outfit's meshes and skeleton, with no animation in the file. */
async function exportOutfit(built: Assembled): Promise<Buffer> {
  for (const mesh of built.meshes) pruneMorphs(mesh);
  built.skeleton.pose();
  built.group.scale.setScalar(CM_TO_M);
  built.group.updateMatrixWorld(true);
  return toGlb(built.group, []);
}

/**
 * One PART, on its own, at the scale it was modelled (D-571).
 *
 * ⚠ Not scaled to metres, unlike {@link exportOutfit}. A part file is an
 * ingredient, not a finished figure: the browser feeds it back through the
 * SAME `assemble()` the build uses and that call scales the result. Baking
 * the metre conversion in here would apply it twice and produce a
 * 1.8-centimetre knight — which renders perfectly, at the wrong size, with
 * nothing in any log.
 *
 * ⚠ Morphs are pruned for the same reason they are on a whole character: the
 * head alone ships seventy-two, and they are 7 MB nobody can see from an
 * isometric camera.
 */
async function exportPart(mesh: SkinnedMesh): Promise<Buffer> {
  // The mesh still belongs to the FBX hierarchy it was read from, so export
  // the rig root rather than the mesh: a SkinnedMesh detached from its bones
  // exports as a mesh with no skeleton, which reassembles as a puddle at the
  // origin.
  const built = assemble([{ slot: mesh.name || 'part', mesh }]);
  for (const m of built.meshes) pruneMorphs(m);
  built.skeleton.pose();
  built.group.updateMatrixWorld(true);
  return toGlb(built.group, []);
}

/** A part file's name, unique across packs. */
export function partFileName(pack: string, stem: string): string {
  return `${pack}__${stem}.glb`;
}

/**
 * The clips, once, in a file of their own.
 *
 * Every outfit is animated by the same skeleton, so baking the clips into
 * each of them multiplied five seconds of walking by however many outfits
 * exist — the first build wrote 12 MB per character, nearly all of it the
 * same keyframes again. Tracks address bones by name, so a clip lifted off
 * one rig drives any rig with those bones.
 */
async function exportAnimations(
  built: Assembled,
  clips: readonly AnimationClip[],
): Promise<Buffer> {
  const rig = new Group();
  rig.scale.setScalar(CM_TO_M);
  // Bones only. A SkinnedMesh here would drag its geometry into the file.
  let top: Object3D = built.skeleton.bones[0]!;
  while (top.parent && (top.parent as Bone).isBone) top = top.parent;
  // A CLONE, because `add` reparents: handing the live skeleton to a second
  // group lifts it straight out of the character it belongs to, and that
  // outfit then exports as meshes bound to joints that are not in the file.
  // It loads without complaint and animates nothing.
  rig.add(top.clone(true));
  return toGlb(rig, clips);
}

/**
 * Finger joints, dropped from every exported clip.
 *
 * Thirty of a clip's fifty-three tracks are fingers, and at an orthographic
 * camera nineteen units out a knuckle is well under a pixel. They cost more
 * than half the animation data to say nothing. The bones stay in the rig —
 * they are simply not keyframed, so a hand holds its rest pose.
 */
function stripFingers(clip: AnimationClip): AnimationClip {
  const finger = /^(thumb|index|middle|ring|pinky)_\d\d_[lr]\./;
  clip.tracks = clip.tracks.filter((t) => !finger.test(t.name));
  return clip;
}

/**
 * Characters that are just FBX, with no pack around them (D-556).
 *
 * Two shapes, because art drops arrive in two shapes:
 *
 *  - `assets/incoming/characters/thing.fbx` — one file, one character,
 *    however many skinned meshes it holds.
 *  - `assets/incoming/characters/thing/*.fbx` — a FOLDER of parts that are
 *    assembled into one character, which is how a modular pack ships: a
 *    body, boots, gauntlets and a helmet, each its own file on a shared
 *    skeleton. Which parts make a character is then a matter of which files
 *    you put in the folder, so choosing an outfit needs no new file format
 *    and no code change (D-110).
 *
 * Neither depends on a particular vendor: a Mixamo character, a CC0 pack or
 * a Polytope armour set all build through the same path.
 */
interface LooseCharacter {
  readonly id: string;
  readonly files: readonly string[];
  /**
   * A `.png` in the folder is that character's colour atlas. One convention,
   * no manifest: a pack's texture sits next to its meshes and the build
   * finds it, exactly as the Sidekick `.sk` path finds its palette.
   */
  readonly palette: Buffer | null;
}

/**
 * Authored characters that ARE a pack mesh rather than a set of parts (D-594).
 *
 * ⚠ Read from the same folder the studio writes, so an enemy is content in
 * exactly the way a townsfolk is — one list, one validator, one editor.
 */
function wholeMeshDefinitions(): CharacterDef[] {
  if (!existsSync(DEF_DIR)) return [];
  return readdirSync(DEF_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => CharacterDefSchema.parse(
      JSON.parse(readFileSync(join(DEF_DIR, f), 'utf8')),
    ))
    .filter((d) => d.mesh !== undefined);
}

function discoverLooseCharacters(): LooseCharacter[] {
  if (!existsSync(CHARACTER_DIR)) return [];
  const out: LooseCharacter[] = [];
  for (const entry of readdirSync(CHARACTER_DIR, { withFileTypes: true })) {
    const full = join(CHARACTER_DIR, entry.name);
    if (entry.isDirectory()) {
      const inside = readdirSync(full);
      const parts = inside
        .filter((f) => f.toLowerCase().endsWith('.fbx'))
        .sort()
        .map((f) => join(full, f));
      const png = inside.find((f) => f.toLowerCase().endsWith('.png'));
      if (parts.length > 0) {
        out.push({
          id: animationName(entry.name),
          files: parts,
          palette: png ? readFileSync(join(full, png)) : null,
        });
      }
    } else if (entry.name.toLowerCase().endsWith('.fbx')) {
      out.push({ id: animationName(entry.name), files: [full], palette: null });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The animation file for a skeleton VARIANT, not merely for a rig.
 *
 * Clips bind by bone name, so two characters on the same rig spelled
 * differently cannot share one — see `rigVariant`.
 */
function animationFileFor(variant: string): string {
  return variant === 'unreal' ? ANIMATION_FILE : `animations-${variant}.glb`;
}

/**
 * Every authored garment (D-571).
 *
 * ⚠ A garment that will not parse STOPS THE BUILD rather than being skipped.
 * The alternative is a character that dresses in nothing with no error, and
 * "my armour is invisible" is a much worse bug report than "the build said
 * garment X is malformed".
 */
/** Every authored race, for the parts it curates (D-574). */
function savedRaces(): RaceDef[] {
  if (!existsSync(RACE_DIR)) return [];
  return readdirSync(RACE_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => RaceSchema.parse(JSON.parse(readFileSync(join(RACE_DIR, f), 'utf8'))));
}

function savedGarments(): GarmentDef[] {
  if (!existsSync(GARMENT_DIR)) return [];
  return readdirSync(GARMENT_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => GarmentSchema.parse(JSON.parse(readFileSync(join(GARMENT_DIR, f), 'utf8'))));
}

interface BuiltCharacter {
  readonly outfit: Outfit;
  readonly built: Assembled;
  readonly kind: RigKind;
  /** The rig AND its spelling — what decides which clip file it can use. */
  readonly variant: string;
}

/**
 * Assemble a character and work out which rig it is on.
 *
 * The rig has to be known before anything is retargeted onto it, and it is
 * read off the bone names rather than assumed from where the file came
 * from — a pack could ship a second skeleton one day, and the failure would
 * otherwise be a silently folded character rather than an error.
 */
function buildCharacter(
  outfit: Outfit,
  meshes: { slot: string; mesh: SkinnedMesh }[],
): BuiltCharacter {
  if (meshes.length === 0) throw new Error(`${outfit.id} has no meshes`);
  const built = assemble(meshes);
  const names = built.skeleton.bones.map((b) => b.name);
  const kind = detectRig(names);
  if (!kind) {
    throw new Error(
      `${outfit.id} is on a rig with no bone map - add it to RIG_SIGNATURES in shared/src/rig.ts`,
    );
  }
  return { outfit, built, kind, variant: rigVariant(names, kind) };
}

/**
 * Turn every saved character definition into something assemblable.
 *
 * The definition names a pack and a part per slot; this resolves those
 * against `assets/source/`. A definition whose pack is not ingested STOPS
 * THE BUILD by name rather than being skipped — a character silently missing
 * from `client/public/models/` is the failure that shows up much later, as a
 * blank space where somebody expected a knight.
 *
 * Parts are read in the slot vocabulary's own order rather than the JSON's,
 * so the same definition always produces byte-identical output. `assemble`
 * no longer cares about order — that was fixed in D-558 — but a build whose
 * output depends on key order in a hand-edited file is one that cannot be
 * diffed.
 */
function definedCharacters(): { def: CharacterDef; pack: Pack }[] {
  if (!existsSync(DEF_DIR)) return [];
  const out: { def: CharacterDef; pack: Pack }[] = [];
  for (const file of readdirSync(DEF_DIR).filter((f) => f.endsWith('.json')).sort()) {
    const def = CharacterDefSchema.parse(JSON.parse(readFileSync(join(DEF_DIR, file), 'utf8')));
    // ⚠ A definition that IS a mesh is not assembled from parts (D-594) and is
    // built further down. Without this it arrives here with an empty `parts`
    // record and fails as "<id> has no meshes" — which is true, and says
    // nothing about the actual cause.
    if (def.mesh !== undefined) continue;
    const pack = packOf(def.pack);
    if (!pack) {
      throw new Error(
        `character "${def.id}" wants pack "${def.pack}", which is not in assets/source - ` +
          `ingest it, or delete content/characters/${file}`,
      );
    }
    const have = partStems(pack);
    const missing = Object.values(def.parts).filter((stem) => !have.has(stem));
    if (missing.length > 0) {
      throw new Error(`character "${def.id}" names parts "${def.pack}" does not ship: ${missing.join(', ')}`);
    }
    out.push({ def, pack });
  }
  return out;
}

/** The parts of one definition, in slot order, as loaded meshes. */
function partsOfDefinition(def: CharacterDef, pack: Pack): { slot: string; mesh: SkinnedMesh }[] {
  return CHARACTER_SLOTS.flatMap((slot) => {
    const stem = def.parts[slot];
    if (!stem) return [];
    const group = loadFbx(readFileSync(join(pack.meshDir, `${stem}.fbx`)));
    return [{ slot, mesh: firstSkinnedMesh(group, `${def.id}/${slot}`) }];
  });
}

export async function build(): Promise<BuildReport> {
  if (!existsSync(INCOMING)) throw new Error(`nothing in ${INCOMING}`);
  const drops = readdirSync(INCOMING);
  // Animations live loose in `assets/incoming/` (where they were first
  // dropped by hand) OR in `assets/incoming/animations/` (where the
  // downloader puts them). Both, so an existing drop keeps working and a
  // hundred new clips do not bury the packs they sit beside.
  const animFiles: string[] = [
    ...drops.filter((f) => f.toLowerCase().endsWith('.fbx')).map((f) => join(INCOMING, f)),
    ...(existsSync(ANIMATION_DIR)
      ? readdirSync(ANIMATION_DIR)
          .filter((f) => f.toLowerCase().endsWith('.fbx'))
          .map((f) => join(ANIMATION_DIR, f))
      : []),
  ];
  if (animFiles.length === 0) throw new Error('no animation .fbx in assets/incoming');

  const characters: BuiltCharacter[] = [];

  const pkgFile = drops.find((f) => f.endsWith('.unitypackage'));
  if (pkgFile) {
    const pkg = readUnityPackage(readFileSync(join(INCOMING, pkgFile)));
    const parts = collectParts(pkg);
    for (const outfit of discoverOutfits(pkg)) {
      characters.push(buildCharacter(outfit, partsFor(outfit, parts)));
    }
  }

  for (const { def, pack } of definedCharacters()) {
    const palette =
      def.texture && pack.textureDir
        ? readFileSync(join(pack.textureDir, `${def.texture}.png`))
        : null;
    characters.push(
      buildCharacter(
        { id: def.id, parts: Object.values(def.parts), palette, source: 'defined' },
        partsOfDefinition(def, pack),
      ),
    );
  }

  // ⚠ A FOURTH source: a definition that names one finished mesh in a pack
  // rather than a set of parts (D-594). It goes through the SAME path a loose
  // FBX takes — `buildCharacter` with `parts: []` — because that is exactly
  // what it is: one rigged body, however many skinned meshes it holds. The
  // only thing this adds is finding the file inside an ingested pack instead
  // of requiring somebody to copy it into `assets/incoming/` by hand.
  for (const def of wholeMeshDefinitions()) {
    const pack = packOf(def.pack);
    if (!pack) {
      throw new Error(
        `character '${def.id}' names pack '${def.pack}', which is not ingested — ` +
          `put it in assets/source/${def.pack}, or delete content/characters/${def.id}.json`,
      );
    }
    const file = meshPath(pack, def.mesh!);
    if (!file) {
      throw new Error(
        `character '${def.id}' names mesh '${def.mesh}', which pack '${def.pack}' ` +
          'does not ship — check the spelling against the pack\'s FBX folder',
      );
    }
    // ⚠ `preferredAtlas`, not `assetAtlas`: a CHARACTER wants the lettered cut,
    // because D-560 measured that the unlettered atlas is the markings-free
    // variant and a face sampled against it silently returns plain skin.
    // `assetAtlas` stays right for props, which have no colourways.
    //
    // ⚠ For the dungeon pack specifically it makes NO DIFFERENCE, and that is
    // measured rather than assumed: the skeleton knight's 152 distinct UVs
    // land on the same eleven colours in `Dungeons_Texture_01` and
    // `_01_A` — this pack's letters are colourways, not channels. It is here
    // for the packs where it does matter.
    //
    // ⚠ It was nearly justified with a bug that did not exist. A pale patch on
    // the knight's chest was read as flesh showing through a breastplate;
    // sampling the UVs says the colour is #cab593, which is BONE — a ribcage,
    // on a skeleton, correctly. Reading a render is not measuring one (D-560),
    // and this is the second time in one sitting.
    const want = def.texture ?? preferredAtlas(texturesIn(pack));
    const texture = want ? texturePaths(pack).get(want) : undefined;
    const meshes = skinnedMeshes(loadFbx(readFileSync(file))).map((mesh, i) => ({
      slot: mesh.name || `${def.mesh}-${i}`,
      mesh,
    }));
    if (meshes.length === 0) {
      throw new Error(`character '${def.id}': '${def.mesh}' holds no skinned mesh`);
    }
    characters.push(
      buildCharacter(
        {
          id: def.id,
          parts: [],
          palette: texture ? readFileSync(texture) : null,
          // ⚠ `mesh`, not `defined`. Both come from `content/characters/`, and
          // the manifest has to say which is which: D-571 promises that a
          // character carrying a slot vocabulary can be RE-DRESSED, and a
          // finished pack body cannot be — there are no parts to swap. Reusing
          // `defined` made a goblin claim to be dressable and broke the test
          // that guards exactly that promise.
          source: 'mesh',
        },
        meshes,
      ),
    );
  }

  for (const { id, files, palette } of discoverLooseCharacters()) {
    const meshes = files.flatMap((file) =>
      skinnedMeshes(loadFbx(readFileSync(file))).map((mesh, i) => ({
        slot: mesh.name || `${basename(file, '.fbx')}-${i}`,
        mesh,
      })),
    );
    characters.push(buildCharacter({ id, parts: [], palette, source: 'fbx' }, meshes));
  }

  // Three sources can name a character, and the id is the output filename.
  // Two of them agreeing on one id means the second silently overwrites the
  // first's `.glb` — the character builds, loads, and is somebody else.
  const seen = new Map<string, string>();
  for (const { outfit } of characters) {
    const already = seen.get(outfit.id);
    if (already) {
      throw new Error(
        `two characters are both called "${outfit.id}" (from ${already} and ${outfit.source}) - ` +
          `rename one, or remove the source that is now redundant`,
      );
    }
    seen.set(outfit.id, outfit.source);
  }

  if (characters.length === 0) {
    throw new Error(
      'no characters: author one in the studio (npm run dev:studio), or put a ' +
        '.unitypackage or assets/incoming/characters/*.fbx in assets/incoming',
    );
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const report: BuildReport = {
    outfits: [], clips: [], animationBytes: 0, repairs: [], parts: [], partBytes: 0,
  };

  // One animation file per RIG, cut against the first character on it.
  // Clips address bones by name, so every character on that rig can share
  // them; a character on a different rig needs its own, because its bones
  // are not called the same things.
  const doneRigs = new Set<string>();
  for (const { built, kind, variant } of characters) {
    if (doneRigs.has(variant)) continue;
    doneRigs.add(variant);
    const clips = animFiles.map((f) =>
      stripFingers(
        retarget(built.meshes[0]!, loadFbx(readFileSync(f)), animationName(basename(f)), kind),
      ),
    );
    const anim = await exportAnimations(built, clips);
    writeFileSync(join(OUT_DIR, animationFileFor(variant)), anim);
    report.animationBytes += anim.byteLength;
    if (report.clips.length === 0) {
      report.clips = clips.map((c) => ({
        name: c.name,
        duration: c.duration,
        tracks: c.tracks.length,
      }));
    }
  }

  for (const { outfit, built, kind, variant } of characters) {
    const vertices = built.meshes.reduce((n, m) => n + m.geometry.attributes.position!.count, 0);
    const height = measureHeight(built) * CM_TO_M;
    const glb = await exportOutfit(built);
    writeFileSync(join(OUT_DIR, `${outfit.id}.glb`), glb);
    // The palette rides alongside rather than inside: it is a 32x32 PNG the
    // client can tint per character, and embedding it would need a canvas
    // Node does not have.
    if (outfit.palette) writeFileSync(join(OUT_DIR, `${outfit.id}.png`), outfit.palette);
    for (const r of built.repairs) report.repairs.push(`${outfit.id} ${r}`);
    report.outfits.push({
      id: outfit.id,
      palette: outfit.palette !== null,
      parts: built.meshes.length,
      vertices,
      height,
      bytes: glb.byteLength,
      rig: kind,
      variant,
      source: outfit.source,
    });
  }

  /*
   * The PARTS a garment needs to swap against, and the garments themselves
   * (D-571).
   *
   * ⚠ Only what content actually references — the same rule `build:environment`
   * follows. The pack ships 720 parts; a character definition names about
   * fourteen and a garment three, so this writes tens of small files rather
   * than a folder nobody asked for.
   *
   * ⚠ Garments apply to DEFINED characters only. A character discovered from
   * a `.unitypackage` or a folder of loose FBX (D-556, D-557) has no slot
   * vocabulary — its meshes are named after whatever file they came from —
   * so there is nothing for a swap to replace. The manifest says which
   * characters can be dressed rather than leaving the client to guess from a
   * mesh name, and a character that cannot be is not a bug, it is a
   * character assembled by a route that never knew about slots.
   */
  const wanted = new Map<string, { pack: Pack; stem: string }>();
    /**
   * ⚠ The body's sex is carried here because a garment is cut for a BODY, not
   * chosen by a player (D-558): the pack cuts most parts twice and a female
   * forearm on a male upper arm meets it at the wrong diameter. Which cut to
   * wear is therefore a property of the character that was assembled, and
   * putting it on the wire instead would be asking the wrong question of the
   * wrong system.
   */
  const outfitParts: Record<
    string,
    { pack: string; sex: string; parts: Record<string, string> }
  > = {};
  for (const { def, pack } of definedCharacters()) {
    outfitParts[def.id] = { pack: def.pack, sex: def.sex, parts: { ...def.parts } };
    for (const stem of Object.values(def.parts) as string[]) {
      wanted.set(partFileName(def.pack, stem), { pack, stem });
    }
  }
  /*
   * A RACE's curated parts (D-560, exported here for D-574).
   *
   * ⚠ Without these a player picks a face at creation and the client asks for
   * a `.glb` that was never written — a 404 and a head that never appears.
   * The race is the list of what a player MAY choose, so every one of them has
   * to exist before the choice is offered, not after it is made.
   *
   * ⚠ This is the one source that is large: two races curate 142 distinct
   * parts against the 29 a character definition and a garment name. It is
   * still only what content references, and a client downloads the face it is
   * looking at rather than the catalogue.
   */
  for (const race of savedRaces()) {
    const pack = packOf(race.pack);
    if (!pack) {
      throw new Error(
        `race "${race.id}" wants pack "${race.pack}", which is not in assets/source - ` +
          'ingest it or repoint the race',
      );
    }
    for (const stems of Object.values(race.parts)) {
      for (const stem of stems as string[]) {
        wanted.set(partFileName(race.pack, stem), { pack, stem });
      }
    }
  }

  const garments = savedGarments();
  for (const garment of garments) {
    const pack = packOf(garment.pack);
    if (!pack) {
      throw new Error(
        `garment "${garment.id}" wants pack "${garment.pack}", which is not in assets/source - ` +
          'ingest it or delete the garment',
      );
    }
    for (const sex of ['male', 'female'] as const) {
      for (const stem of Object.values(garment.parts[sex]) as string[]) {
        wanted.set(partFileName(garment.pack, stem), { pack, stem });
      }
    }
  }

  const partsDir = join(OUT_DIR, 'parts');
  mkdirSync(partsDir, { recursive: true });
  let partBytes = 0;
  for (const [file, { pack, stem }] of [...wanted].sort((a, b) => a[0].localeCompare(b[0]))) {
    const path = meshPath(pack, stem);
    if (!path) throw new Error(`part "${stem}" is not in pack "${pack.id}"`);
    const glb = await exportPart(firstSkinnedMesh(loadFbx(readFileSync(path)), stem));
    writeFileSync(join(partsDir, file), glb);
    partBytes += glb.byteLength;
    report.parts.push({ file, bytes: glb.byteLength });
  }

  writeFileSync(
    join(OUT_DIR, MANIFEST_FILE),
    `${JSON.stringify(
      {
        // Kept for readers that only know about one rig; every character
        // also names its own, which is the field to prefer.
        animations: ANIMATION_FILE,
        clips: report.clips.map((c) => c.name),
        outfits: report.outfits.map((o) => ({
          id: o.id,
          model: `${o.id}.glb`,
          palette: o.palette ? `${o.id}.png` : null,
          animations: animationFileFor(o.variant),
          rig: o.rig,
          variant: o.variant,
          source: o.source,
          height: Number(o.height.toFixed(3)),
          // Present only for a character the build assembled from a slot
          // vocabulary. `null` is the honest answer for the other two
          // sources, and it is what stops the client trying to dress one.
          parts: outfitParts[o.id] ?? null,
        })),
        garments: garments.map((g) => ({
          id: g.id,
          pack: g.pack,
          parts: g.parts,
        })),
      },
      null,
      2,
    )}
`,
  );
  report.partBytes = partBytes;
  return report;
}

const invokedDirectly = process.argv[1] !== undefined && process.argv[1].includes('build-characters');
if (invokedDirectly) {
  const r = await build();
  for (const o of r.outfits) {
    console.log(
      `${o.id.padEnd(18)} ${String(o.parts).padStart(2)} parts  ${String(o.vertices).padStart(6)} verts  ` +
        `${o.height.toFixed(2)}m  ${(o.bytes / 1024 / 1024).toFixed(2)} MB  ${o.variant.padEnd(14)} ` +
        `${o.palette ? 'palette' : 'no palette'}`,
    );
  }
  for (const line of r.repairs) console.log(`  ! repaired ${line}`);
  console.log(`animations         ${(r.animationBytes / 1024).toFixed(0)} KB in total`);
  for (const c of r.clips) {
    console.log(`  clip ${c.name.padEnd(28)} ${c.duration.toFixed(2)}s  ${c.tracks} tracks`);
  }
}
