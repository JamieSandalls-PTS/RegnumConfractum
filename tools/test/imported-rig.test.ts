import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { AnimationMixer, Box3, Vector3, type Bone, type Object3D, type SkinnedMesh } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { assemble } from '../../client/src/render/assembly';
import {
  MIXAMO_HIP,
  PROP_SOCKETS,
  RIG_CORE_BONES,
  RIG_FROM_MIXAMO,
  RIG_HIP,
  type RigKind,
  coreBonesFor,
  detectRig,
  findBone,
  hipBoneFor,
} from '@rc/shared';
import '../src/node-dom';

/**
 * The imported characters, checked the way everything else here is checked:
 * by measuring, not by looking (D-114, D-555).
 *
 * `npm run build:characters` turns a Synty pack and a folder of Mixamo FBX
 * into these files. Every failure this suite has caught so far was invisible
 * in the build log and silent in the browser:
 *
 *  - a `.glb` whose meshes were bound to joints that were not in the file,
 *    because exporting the animations first had reparented the skeleton out
 *    of the character. It loaded without complaint and moved nothing.
 *  - a walk that folded a 1.78m figure into a 1.0m concertina, because
 *    Mixamo and Unreal bones do not point the same way at rest.
 *
 * Neither would have been caught by a build that only checked the exporter
 * returned bytes.
 */

const models = fileURLToPath(new URL('../../client/public/models/', import.meta.url));

interface ManifestOutfit {
  id: string;
  model: string;
  palette: string | null;
  animations: string;
  rig: RigKind;
  variant: string;
  source: 'pack' | 'fbx';
  /** A person is held to the whole skeleton; a creature to its trunk (D-631). */
  kind?: 'person' | 'creature';
  height: number;
}

interface Manifest {
  animations: string;
  clips: string[];
  outfits: ManifestOutfit[];
}

/**
 * The build needs a licensed art drop that a fresh clone does not have. When
 * the models have not been built, say so once and skip rather than failing —
 * a red suite that means "you have not bought the art" teaches people to
 * ignore red suites.
 */
const built = existsSync(`${models}manifest.json`);
const describeModels = built ? describe : describe.skip;
/**
 * What the build says it produced. Hardcoding a list of character ids here
 * would mean this suite reads a different set from the one on disk the
 * moment somebody drops in a different pack.
 */
const manifest: Manifest = built
  ? (JSON.parse(readFileSync(`${models}manifest.json`, 'utf8')) as Manifest)
  : { animations: '', clips: [], outfits: [] };
const OUTFITS = manifest.outfits.map((o) => o.id);
/** The first Synty character — the one the per-mesh checks run on. */
const BODY = (manifest.outfits.find((o) => o.rig === 'unreal') ?? manifest.outfits[0])?.id ?? '';

/**
 * EVERY character, not one per rig.
 *
 * Testing one character per rig let a real defect through: two Synty lines
 * are the same Unreal skeleton spelled differently (`pelvis` vs `Pelvis`),
 * so they passed as one rig while the shared clip file bound to neither the
 * second one's bones nor anything else. It loaded, it rendered, and it stood
 * perfectly still. Per character is the only grain that catches that.
 */
const CHARACTERS: string[] = manifest.outfits.map((o) => o.id);
const outfitOf = (id: string): ManifestOutfit => manifest.outfits.find((o) => o.id === id)!;

interface Loaded {
  scene: Object3D;
  bones: Map<string, Bone>;
  meshes: SkinnedMesh[];
  animations: { name: string; duration: number }[];
  clips: import('three').AnimationClip[];
}

async function load(file: string): Promise<Loaded> {
  const b = readFileSync(`${models}${file}`);
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  const gltf = await new GLTFLoader().parseAsync(ab, '');
  const bones = new Map<string, Bone>();
  const meshes: SkinnedMesh[] = [];
  gltf.scene.traverse((o: Object3D) => {
    if ((o as Bone).isBone) bones.set(o.name, o as Bone);
    if ((o as SkinnedMesh).isSkinnedMesh) meshes.push(o as SkinnedMesh);
  });
  return {
    scene: gltf.scene,
    bones,
    meshes,
    animations: gltf.animations.map((a) => ({ name: a.name, duration: a.duration })),
    clips: gltf.animations,
  };
}

/** Is this clip driving `canonical`, however this skeleton spells it? */
const hasTrack = (
  clip: import('three').AnimationClip,
  canonical: string,
  channel: string,
): boolean => {
  const want = `${canonical.toLowerCase()}.${channel}`;
  return clip.tracks.some((t) => t.name.toLowerCase() === want);
};

const worldY = (b: Object3D): number => new Vector3().setFromMatrixPosition(b.matrixWorld).y;
const worldPos = (b: Object3D): Vector3 => new Vector3().setFromMatrixPosition(b.matrixWorld);

describeModels('the imported character rig (D-555)', () => {
  let body: Loaded;

  beforeAll(async () => {
    body = await load(`${BODY}.glb`);
    body.scene.updateMatrixWorld(true);
  });

  it('stands a human-sized figure with its feet on the ground', () => {
    const box = new Box3().setFromObject(body.scene);
    // Metres, not the source pack's centimetres.
    expect(box.max.y).toBeGreaterThan(1.6);
    expect(box.max.y).toBeLessThan(2.0);
    // Feet at the origin, so the client can place a character by its tile
    // rather than by guessing an offset.
    expect(Math.abs(box.min.y)).toBeLessThan(0.05);
  });

  it('carries every bone an animation needs to drive', () => {
    const have = [...body.bones.keys()];
    for (const name of coreBonesFor(outfitOf(BODY).rig)) {
      expect(findBone(have, name)).toBeTruthy();
    }
  });

  /**
   * A weapon hangs off a HAND. Synty's Sidekick line adds dedicated
   * `prop_l`/`prop_r` sockets and their POLYGON line does not, so requiring
   * the sockets would be asserting one product line rather than anything the
   * game needs — the hand bones are the guarantee, and those are core.
   */
  it('has hands to hang a weapon from', () => {
    const have = [...body.bones.keys()];
    expect(findBone(have, 'hand_l')).toBeTruthy();
    expect(findBone(have, 'hand_r')).toBeTruthy();
  });

  /**
   * The bug this exists for: a skin whose joints are not in the file. The
   * loader reports it as a missing node, but a viewer just shows a character
   * that never moves.
   *
   * Deliberately says nothing about HOW MANY meshes or bones — a Sidekick
   * character is 36 parts on an 88-bone rig and a POLYGON one is 13 parts
   * whose pieces carry 7 bones each. Both are correct; only the binding is
   * an invariant.
   */
  it('binds every mesh to joints that are actually in the file', () => {
    expect(body.meshes.length).toBeGreaterThan(0);
    for (const mesh of body.meshes) {
      expect(mesh.skeleton.bones.length).toBeGreaterThan(0);
      for (const bone of mesh.skeleton.bones) {
        expect(bone).toBeTruthy();
        expect(body.bones.has(bone.name)).toBe(true);
      }
    }
  });

  it('is laid out head up, feet down, hands out', () => {
    const have = [...body.bones.keys()];
    const B = (canonical: string): Bone => body.bones.get(findBone(have, canonical)!)!;
    expect(worldY(B('head'))).toBeGreaterThan(1.4);
    expect(worldY(B(hipBoneFor(outfitOf(BODY).rig)))).toBeGreaterThan(0.8);
    expect(worldY(B('foot_l'))).toBeLessThan(0.2);
    // Left is +x. If this ever flips, every clip plays mirrored.
    expect(worldPos(B('hand_l')).x).toBeGreaterThan(0.15);
    expect(worldPos(B('hand_r')).x).toBeLessThan(-0.15);
  });

  /**
   * Body-shape blendshapes, WHERE A PACK SHIPS THEM.
   *
   * Sidekick carries them on every part (and 72 facial ones on the head,
   * which the build drops); the POLYGON line carries none. So this asserts
   * the pruning worked rather than that morphs exist — a pack without them
   * is not a broken build.
   */
  it('drops the facial blendshapes wherever a pack ships any', () => {
    for (const mesh of body.meshes) {
      const names = Object.keys(mesh.morphTargetDictionary ?? {});
      expect(names.some((n) => n.startsWith('jawOpen') || n.startsWith('mouth'))).toBe(false);
    }
  });

  /**
   * Outfits do NOT all carry the same bones, and should not: the knight
   * brings `abac_dyn_*` and `ahed_dyn_*` for its cape and helmet plume, and
   * loses the bare head's `hair_dyn_*` because the helmet replaces the hair.
   * What has to hold is narrower and is the thing that actually breaks —
   * every outfit carries the bones the shared clips name.
   */
  it('gives every character the bones its own clips drive', async () => {
    for (const outfit of manifest.outfits) {
      const anim = await load(outfit.animations);
      const driven = new Set(anim.clips.flatMap((c) => c.tracks.map((t) => t.name.split('.')[0]!)));
      expect(driven.size).toBeGreaterThan(15);
      const model = await load(outfit.model);
      for (const name of driven) expect(model.bones.has(name)).toBe(true);
      // And the core of whichever rig it is on, named the way that rig
      // names it — a Mixamo character has no bone called `pelvis`.
      //
      // ⚠ For a PERSON. A creature filed from the packs may be less than a
      // humanoid: the dungeon pack's tormented soul is a spirit with thighs
      // and calves and no feet (measured: 42 bones, no Foot_L/R), and the
      // whole point of filing it as a creature is that it is not one of the
      // cast. What a creature must still have is the trunk its clips hang
      // from; anything else it lacks is a fact about the art, not a defect.
      const have = [...model.bones.keys()];
      const core = coreBonesFor(outfit.rig);
      const required = outfit.kind === 'creature' ? core.slice(0, 6) : core;
      for (const name of required) {
        expect(findBone(have, name), `${outfit.id} lacks ${name}`).toBeTruthy();
      }
    }
  });

  /**
   * The insurance policy, and the reason it is worth a test (D-556): a
   * character that came from a plain FBX rather than from a Synty pack
   * builds through the same pipeline and comes out standing. If the Synty
   * licence ever lapses, this is the path that still works.
   */
  it('builds a character that owes nothing to any one vendor', async () => {
    const loose = manifest.outfits.filter((o) => o.source === 'fbx');
    if (loose.length === 0) return;
    for (const outfit of loose) {
      const model = await load(outfit.model);
      model.scene.updateMatrixWorld(true);
      const box = new Box3().setFromObject(model.scene);
      expect(box.max.y).toBeGreaterThan(1.5);
      expect(box.max.y).toBeLessThan(2.2);
      expect(findBone([...model.bones.keys()], hipBoneFor(outfit.rig))).toBeTruthy();
      // One rig, not the two identically-named copies a Mixamo export
      // carries. Duplicates here mean half the skeleton is orphaned.
      const names = [...model.bones.keys()];
      expect(new Set(names).size).toBe(names.length);
      expect(detectRig(names)).toBe(outfit.rig);
    }
  });
});

describeModels('the retargeted animations (D-555)', () => {
  let body: Loaded;
  let anim: Loaded;

  beforeAll(async () => {
    body = await load(`${BODY}.glb`);
    // The clip file this character actually uses. Hardcoding `animations.glb`
    // held only while every character shared the canonical variant; the
    // moment one did not, this whole suite silently SKIPPED rather than
    // failed, taking the walk-shape checks with it.
    anim = await load(outfitOf(BODY).animations);
  });

  it('keeps the clips in one file per rig VARIANT, not one per character', async () => {
    expect(anim.animations.length).toBeGreaterThanOrEqual(5);
    // Baking them per character is what made the first build 12MB apiece.
    for (const outfit of manifest.outfits) {
      const model = await load(outfit.model);
      expect(model.animations).toHaveLength(0);
    }
    // One file per VARIANT, not per rig: two Synty lines are the same Unreal
    // skeleton spelled differently, and a clip binds by exact bone name.
    const files = new Set(manifest.outfits.map((o) => o.animations));
    const variants = new Set(manifest.outfits.map((o) => o.variant));
    expect(files.size).toBe(variants.size);
  });

  it('addresses bones by name, so one clip drives every outfit', () => {
    const walk = anim.clips.find((c) => c.name === 'walking')!;
    for (const track of walk.tracks) {
      const [node] = track.name.split('.');
      // Not `.bones[pelvis].quaternion` - that form only resolves when the
      // clip is played on the SkinnedMesh, and glTF animates nodes.
      expect(track.name.startsWith('.bones[')).toBe(false);
      expect(body.bones.has(node!)).toBe(true);
    }
  });

  it('moves the hip and turns the joints', () => {
    const walk = anim.clips.find((c) => c.name === 'walking')!;
    // Tracks are named for the TARGET skeleton's bones, and one vendor
    // spells them `Pelvis` where another spells them `pelvis`, so every
    // lookup here resolves case-insensitively.
    expect(hasTrack(walk, hipBoneFor(outfitOf(BODY).rig), 'position')).toBe(true);
    for (const bone of ['spine_01', 'thigh_l', 'thigh_r', 'upperarm_l']) {
      expect(hasTrack(walk, bone, 'quaternion')).toBe(true);
    }
  });

  it('leaves the fingers out, and no other core bone', () => {
    const walk = anim.clips.find((c) => c.name === 'walking')!;
    const named = walk.tracks.map((t) => t.name.split('.')[0]!);
    expect(named.some((n) => /^(thumb|index|middle|ring|pinky|finger)_/i.test(n))).toBe(false);
    for (const bone of coreBonesFor(outfitOf(BODY).rig)) {
      expect(findBone(named, bone)).toBeTruthy();
    }
  });

  it('holds no NaN', () => {
    for (const clip of anim.clips) {
      for (const track of clip.tracks) {
        for (const v of track.values) expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  /**
   * The concertina test.
   *
   * `retargetClip` copies world rotations, so without a rest-pose correction
   * the Mixamo clip folded a 1.78m figure down to about a metre — head, feet
   * and hips all bunched at hip height. Measuring the standing shape while
   * the clip plays is the only thing that catches it; the build succeeded and
   * the file loaded.
   */
  /**
   * The concertina test, run once per RIG rather than once per build.
   *
   * Every rig needs its own bone dictionary, and a wrong dictionary does not
   * fail — it produces a character that loads, animates, and is folded in
   * half. Checking only the first rig would mean the second one shipped
   * broken, which is the exact shape of the bug this suite exists for.
   */
  it.each(CHARACTERS)('keeps %s standing while it walks', async (id) => {
    const outfit = outfitOf(id);
    const kind = outfit.rig;
    const model = await load(outfit.model);
    const clips = await load(outfit.animations);
    const walk = clips.clips.find((c) => c.name === 'walking')!;
    const have = [...model.bones.keys()];
    const core = coreBonesFor(kind);
    const [hipName, headName, footLName, footRName] = [
      hipBoneFor(kind),
      core[5]!,
      core[18]!,
      core[19]!,
    ].map((n) => findBone(have, n));
    // A creature with no feet cannot be judged on its feet; a person with
    // none is a build fault and fails here by name.
    if (!footLName || !footRName) {
      expect(outfit.kind, `${id} has no feet`).toBe('creature');
      return;
    }
    const mixer = new AnimationMixer(model.scene);
    mixer.clipAction(walk).play();

    const hipTrace: number[] = [];
    for (let i = 0; i <= 8; i++) {
      mixer.setTime((i / 8) * walk.duration * 0.999);
      model.scene.updateMatrixWorld(true);
      const hip = worldY(model.bones.get(hipName!)!);
      const head = worldY(model.bones.get(headName!)!);
      const footL = worldY(model.bones.get(footLName!)!);
      const footR = worldY(model.bones.get(footRName!)!);
      hipTrace.push(hip);

      expect(head).toBeGreaterThan(hip + 0.4);
      expect(hip).toBeGreaterThan(0.7);
      expect(hip).toBeLessThan(1.25);
      expect(Math.min(footL, footR)).toBeLessThan(0.35);
      // Neither foot ever climbs to the waist.
      expect(Math.max(footL, footR)).toBeLessThan(hip);
    }

    // And it MOVED. A clip whose track names do not match this skeleton's
    // bones binds to nothing: the character loads, renders, and stands in
    // its bind pose while every other assertion above still passes.
    expect(Math.max(...hipTrace) - Math.min(...hipTrace)).toBeGreaterThan(0.01);
  });

  it.each(CHARACTERS)("alternates %s's feet", async (id) => {
    const outfit = outfitOf(id);
    const kind = outfit.rig;
    const model = await load(outfit.model);
    const clips = await load(outfit.animations);
    const walk = clips.clips.find((c) => c.name === 'walking')!;
    const have = [...model.bones.keys()];
    const core = coreBonesFor(kind);
    const footL = findBone(have, core[18]!);
    const footR = findBone(have, core[19]!);
    if (!footL || !footR) {
      expect(outfit.kind, `${id} has no feet`).toBe('creature');
      return;
    }
    const mixer = new AnimationMixer(model.scene);
    mixer.clipAction(walk).play();
    const lift: { l: number[]; r: number[] } = { l: [], r: [] };
    for (let i = 0; i < 16; i++) {
      mixer.setTime((i / 16) * walk.duration);
      model.scene.updateMatrixWorld(true);
      lift.l.push(worldY(model.bones.get(footL)!));
      lift.r.push(worldY(model.bones.get(footR)!));
    }
    const swing = (ys: number[]): number => Math.max(...ys) - Math.min(...ys);
    expect(swing(lift.l)).toBeGreaterThan(0.05);
    expect(swing(lift.r)).toBeGreaterThan(0.05);
    const peak = (ys: number[]): number => ys.indexOf(Math.max(...ys));
    expect(Math.abs(peak(lift.l) - peak(lift.r))).toBeGreaterThan(2);
  });

  /**
   * Supersedes an earlier check that REQUIRED the walk to travel 0.8-2.5 m/s.
   *
   * That was asserting a defect. Mixamo bakes root motion into the walk it
   * sells — 155cm of forward hip travel per 1.03s cycle — and the server owns
   * position (invariant 1), so a clip that also moves the character makes the
   * client the authority on where somebody is. On screen it slid a metre and
   * a half ahead of itself and snapped back every time the clip wrapped,
   * which is what reads as jank.
   */
  it('does not travel: a cycle ends where it began', () => {
    const hip = hipBoneFor(outfitOf(BODY).rig);
    for (const clip of anim.clips) {
      const track = clip.tracks.find(
        (t) => t.name.toLowerCase() === `${hip.toLowerCase()}.position`,
      );
      if (!track) continue;
      const n = track.times.length;
      const start = [track.values[0]!, track.values[1]!, track.values[2]!];
      const end = [
        track.values[(n - 1) * 3]!,
        track.values[(n - 1) * 3 + 1]!,
        track.values[(n - 1) * 3 + 2]!,
      ];
      // A clip that ends at a different HEIGHT is not a cycle — `death`
      // finishes on the floor and `stand-to-sit` on a stool, and both are
      // entitled to have gone somewhere.
      if (Math.abs(end[1]! - start[1]!) > 2) continue;
      const travelled = Math.hypot(end[0]! - start[0]!, end[2]! - start[2]!);
      expect(travelled, `${clip.name} drifts ${travelled.toFixed(0)}cm per loop`).toBeLessThan(1);
    }
  });

  /**
   * The stride now has to be measured at the feet, since the hips no longer
   * travel — and this is the better place for it anyway, because it is the
   * legs that say whether the retarget kept the scale of the walk.
   */
  it('strides, rather than shuffling or doing the splits', async () => {
    const outfit = outfitOf(BODY);
    const model = await load(outfit.model);
    const walk = anim.clips.find((c) => c.name === 'walking')!;
    const core = coreBonesFor(outfit.rig);
    const have = [...model.bones.keys()];
    const foot = model.bones.get(findBone(have, core[18]!)!)!;
    const mixer = new AnimationMixer(model.scene);
    mixer.clipAction(walk).play();
    let front = -Infinity;
    let back = Infinity;
    for (let i = 0; i < 16; i++) {
      mixer.setTime((i / 16) * walk.duration);
      model.scene.updateMatrixWorld(true);
      const z = worldPos(foot).z;
      front = Math.max(front, z);
      back = Math.min(back, z);
    }
    const stride = front - back;
    expect(stride).toBeGreaterThan(0.3);
    expect(stride).toBeLessThan(1.5);
  });

  /**
   * Every clip has to start from the same standing figure.
   *
   * `Neutral Idle.fbx` ships two skinned meshes: the real 65-bone rig, and a
   * shadow of 64 zero-offset LEAF stubs hung one off each real bone. Taking
   * the first skinned mesh picked the stubs, whose world matrices carry none
   * of the rotation accumulated down a chain they do not have — so the idle
   * retargeted to a figure with its arms folded over its head, its legs
   * crumpled under it and its hips at 172cm instead of 85cm. Nothing threw,
   * the clip had all 23 tracks, and the other four animations were perfect.
   *
   * A standing person's hips sit near the middle of them, so that is the
   * assertion: measured against the character's own height, it needs no
   * per-clip numbers and holds for a child or an ogre.
   */
  it('starts every clip from a figure standing on the ground', () => {
    const hip = hipBoneFor(outfitOf(BODY).rig);
    const height = outfitOf(BODY).height;
    // Clips that legitimately do not start on the floor. `climb` opens partway
    // up a ladder and `downed` and `sleep` open lying on it — the exemption is
    // named per clip rather than widening the band, because a wide band is
    // what let a polearm idle ship in a crouch (D-564).
    // ACTIONS that deliberately do not begin on the feet, so a stance's own
    // version is covered by the same entry. Named one by one rather than by
    // widening the band, because a wide band is exactly what let a polearm
    // idle ship in a crouch and a crafting clip ship as a squat (D-564).
    const notStanding = [
      'climb', // partway up a ladder
      'downed', // lying where you fell
      'sleep', // lying down
      'get-up', // starts on the floor, by definition
      'revive', // the same motion, from the same place
      'stand-up', // starts seated
      'sitting', // stays seated
      'kneel', // on one knee
      'treat-wound', // kneeling over somebody
      'harvest-gather', // crouched over what is being picked up
      'swim', // horizontal in water
    ];
    const offFeet = (name: string): boolean =>
      notStanding.some((action) => name === action || name.endsWith(`-${action}`));
    for (const clip of anim.clips) {
      if (offFeet(clip.name)) continue;
      const track = clip.tracks.find(
        (t) => t.name.toLowerCase() === `${hip.toLowerCase()}.position`,
      );
      if (!track) continue;
      const hipHeight = (track.values[1]! * 0.01) / height;
      expect(hipHeight, `${clip.name} opens with its hips at ${hipHeight.toFixed(2)} of its height`)
        .toBeGreaterThan(0.35);
      expect(hipHeight, `${clip.name} opens with its hips at ${hipHeight.toFixed(2)} of its height`)
        .toBeLessThan(0.65);
    }
  });
});

describeModels('the assembled skeleton (D-558)', () => {
  /**
   * `SkeletonUtils.retarget` walks `skeleton.bones` IN ARRAY ORDER and
   * derives each bone's local matrix from `bone.parent.matrixWorld`. A child
   * listed before its parent is therefore solved against a stale parent, and
   * the error propagates into everything below it.
   *
   * The assembler used to emit bones in the order it discovered them, which
   * is leaf-first — `neck_01` at index 0, `Pelvis` at index 4. Nothing
   * errored and nothing logged. What it produced was a character whose right
   * forearm pointed 82 degrees away from where the source clip put it, while
   * the legs, which happened to be interleaved favourably, were within two.
   */
  it.each(CHARACTERS)('lists %s bones parent before child', async (id) => {
    const model = await load(outfitOf(id).model);
    const order = new Map<string, number>();
    const mesh = model.meshes[0]!;
    mesh.skeleton.bones.forEach((b, i) => order.set(b.name, i));
    for (const [name, i] of order) {
      const parent = model.bones.get(name)?.parent;
      if (!parent || !order.has(parent.name)) continue;
      expect(order.get(parent.name), `${parent.name} must precede its child ${name}`).toBeLessThan(i);
    }
  });

  it.each(CHARACTERS)('names each of %s bones once', async (id) => {
    const model = await load(outfitOf(id).model);
    for (const mesh of model.meshes) {
      const names = mesh.skeleton.bones.map((b) => b.name);
      expect(new Set(names).size, `${mesh.name} lists a bone twice`).toBe(names.length);
    }
  });

  /**
   * Every bone hangs off the body, so everything the character wears travels
   * with them.
   *
   * A cape is the case that broke: thirteen of this pack's parts are a chain
   * of their own with no body bone in the file, because the vendor's engine
   * parents it to a socket on import. Assembled as a second root it sat
   * where it was put and stayed there while its owner walked off.
   */
  it.each(CHARACTERS)('hangs every one of %s bones off a single root', async (id) => {
    const model = await load(outfitOf(id).model);
    const roots = new Set<string>();
    for (const bone of model.bones.values()) {
      // Walk through EVERY parent, not only bones. A holder node that
      // nothing is weighted to is not a joint, so it round-trips through
      // glTF as a plain node — a cape's `Capes_00` does exactly that. Its
      // chain is still attached; stopping at it would report a cape hanging
      // off nothing when it is hanging off the spine.
      let top: Object3D = bone;
      let highest = bone.name;
      for (let p: Object3D | null = top.parent; p; p = p.parent) {
        if ((p as Bone).isBone) highest = p.name;
      }
      roots.add(highest);
    }
    expect([...roots]).toHaveLength(1);
  });
});

describe('the Mixamo bone dictionary (D-555)', () => {
  it('maps every core bone', () => {
    for (const bone of RIG_CORE_BONES) {
      expect(RIG_FROM_MIXAMO[bone]).toBeTruthy();
    }
  });

  it('leaves twists, IK and attachment sockets unmapped', () => {
    // A twist bone given a mapping rotates a second time on top of its
    // parent, which is how an elbow ends up inside out.
    for (const bone of ['calf_twist_01_l', 'ik_foot_l', 'headAttach', PROP_SOCKETS.rightHand]) {
      expect(RIG_FROM_MIXAMO[bone]).toBeUndefined();
    }
  });

  it('points the hip at Mixamo, in the direction retargetClip reads', () => {
    expect(RIG_FROM_MIXAMO[RIG_HIP]).toBe(MIXAMO_HIP);
  });

  it('never maps two of our bones onto one of theirs', () => {
    const sources = Object.values(RIG_FROM_MIXAMO);
    expect(new Set(sources).size).toBe(sources.length);
  });
});


/**
 * The cape, assembled straight from the source art (D-558).
 *
 * This has to build a character rather than read one out of
 * `client/public/models/`: the built outfit does not happen to wear a cape,
 * so the "one root" assertion above passes on it whatever the assembler
 * does. A guard that cannot fail on the case it was written for is worse
 * than no guard, so this one puts a cape on deliberately.
 */
const capeDir = fileURLToPath(
  new URL('../../assets/source/modular-fantasy-hero/FBX/', import.meta.url),
);
const CAPE = 'SK_Chr_BackAttachment_03';
const TORSO = 'SK_Chr_Torso_Male_04';
const haveSource = existsSync(`${capeDir}${CAPE}.fbx`) && existsSync(`${capeDir}${TORSO}.fbx`);
const describeSource = haveSource ? describe : describe.skip;

describeSource('a cape, assembled from source art (D-558)', () => {
  const part = (stem: string): SkinnedMesh => {
    const b = readFileSync(`${capeDir}${stem}.fbx`);
    const group = new FBXLoader().parse(
      b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer,
      '',
    );
    let found: SkinnedMesh | null = null;
    group.traverse((o: Object3D) => {
      if ((o as SkinnedMesh).isSkinnedMesh && !found) found = o as SkinnedMesh;
    });
    return found!;
  };

  const wear = (): ReturnType<typeof assemble> =>
    assemble([
      { slot: 'torso', mesh: part(TORSO) },
      { slot: 'back', mesh: part(CAPE) },
    ]);

  it('hangs off the body rather than standing beside it', () => {
    const built = wear();
    const roots = new Set<string>();
    for (const bone of built.skeleton.bones) {
      let top: Object3D = bone;
      while (top.parent && (top.parent as Bone).isBone) top = top.parent;
      roots.add(top.name);
    }
    // Two roots means the cape is a separate object that happens to be
    // standing in the right place, and it will stay there when the character
    // walks away.
    expect([...roots]).toHaveLength(1);
  });

  it('sits on the back, not on the floor', () => {
    const built = wear();
    built.group.updateMatrixWorld(true);
    const tip = built.skeleton.bones.find((b) => b.name === 'back_05');
    expect(tip, 'the cape brought no bones').toBeTruthy();
    const at = worldPos(tip!);
    // Source art is in centimetres. The cape's own node hierarchy puts this
    // bone at y=-80 — below the floor — because the exporter dropped the
    // socket it hung from; its BIND matrix puts it at y=54, down the back.
    expect(at.y).toBeGreaterThan(30);
    expect(at.y).toBeLessThan(90);
    // And behind them: -z is the character's back.
    expect(at.z).toBeLessThan(-10);
  });

  it('travels with the torso it is pinned to', async () => {
    if (!built) return;
    const walkClips = await load(outfitOf(BODY).animations);
    const clip = walkClips.clips.find((c) => c.name === 'walking')!;
    const built_ = wear();
    const spine = built_.skeleton.bones.find((b) => b.name === 'spine_03')!;
    const tip = built_.skeleton.bones.find((b) => b.name === 'back_05')!;
    const mixer = new AnimationMixer(built_.group);
    mixer.clipAction(clip).play();
    const gaps: number[] = [];
    const walked: number[] = [];
    for (let i = 0; i < 8; i++) {
      mixer.setTime((i / 8) * clip.duration);
      built_.group.updateMatrixWorld(true);
      gaps.push(worldPos(spine).distanceTo(worldPos(tip)));
      walked.push(worldPos(tip).x);
    }
    // Rigid for now — the flowing part is D-519's cloth system, not the
    // importer's — but rigid TO THE BODY, which is the whole point.
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThan(1);
    // And it actually went somewhere, or a cape left at the origin would
    // also hold its distance from a character standing still.
    expect(Math.max(...walked) - Math.min(...walked)).toBeGreaterThan(1);
  });
});


/**
 * Weighting faults in the source art, found and corrected (D-558).
 *
 * The stakeholder spotted this one by watching the guard walk: the RIGHT
 * wing of his helmet tore away from the helm on every arm swing, and the
 * left one did not. `SK_Chr_HelmetAttachment_03` is 98% weighted to the head
 * and has twenty-six vertices at the root of the right wing weighted, fully,
 * to `clavicle_r` and `UpperArm_R`. It is a weight painted onto the wrong
 * bone at the vendor and it would do the same in their own engine.
 *
 * The narrowness of the rule is the point, and these tests hold it there. Of
 * 720 parts in this pack, seven are lopsided about the centre line and six of
 * those are lopsided ON PURPOSE — a sash over one shoulder, a drape over one
 * hip. Only a part anchored on the spine that touches one side and not the
 * other, for a twentieth of its weight, is a mistake.
 */
describeSource('weighting faults in the source art (D-558)', () => {
  const part = (stem: string): SkinnedMesh => load(stem);
  const load = (stem: string): SkinnedMesh => {
    const b = readFileSync(`${capeDir}${stem}.fbx`);
    const group = new FBXLoader().parse(
      b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer,
      '',
    );
    let found: SkinnedMesh | null = null;
    group.traverse((o: Object3D) => {
      if ((o as SkinnedMesh).isSkinnedMesh && !found) found = o as SkinnedMesh;
    });
    return found!;
  };

  const CREST = 'SK_Chr_HelmetAttachment_03';

  it('finds the wing that was bound to the shoulder', () => {
    const built = assemble([{ slot: 'helmetCrest', mesh: load(CREST) }]);
    expect(built.repairs.join(' ')).toMatch(/clavicle_r/);
    expect(built.repairs.join(' ')).toMatch(/moved to head/);
  });

  it('leaves the crest driven only by the head', () => {
    const built = assemble([{ slot: 'helmetCrest', mesh: load(CREST) }]);
    const mesh = built.meshes[0]!;
    const index = mesh.geometry.getAttribute('skinIndex');
    const weight = mesh.geometry.getAttribute('skinWeight');
    const driven = new Set<string>();
    for (let v = 0; v < index.count; v++) {
      for (let k = 0; k < 4; k++) {
        if (weight.getComponent(v, k) > 0) {
          driven.add(built.skeleton.bones[index.getComponent(v, k)]!.name);
        }
      }
    }
    // Nothing on the arms. `eyes` and `eyebrows` stay: they are rigid
    // children of the head and no clip drives them, so they carry the crest
    // exactly as the head does.
    for (const arm of ['clavicle_r', 'UpperArm_R', 'clavicle_l', 'UpperArm_L']) {
      expect([...driven], `${arm} still drives part of the crest`).not.toContain(arm);
    }
  });

  it('keeps every vertex weight summing to what it did', () => {
    // An influence is repointed, never removed, so the part cannot lose
    // volume where it was corrected.
    const before = load(CREST);
    const after = assemble([{ slot: 'helmetCrest', mesh: load(CREST) }]).meshes[0]!;
    const wa = before.geometry.getAttribute('skinWeight');
    const wb = after.geometry.getAttribute('skinWeight');
    expect(wb.count).toBe(wa.count);
    for (let v = 0; v < wa.count; v++) {
      let sa = 0;
      let sb = 0;
      for (let k = 0; k < 4; k++) {
        sa += wa.getComponent(v, k);
        sb += wb.getComponent(v, k);
      }
      expect(sb).toBeCloseTo(sa, 5);
    }
  });

  it('does not touch a part that is lopsided on purpose', () => {
    // A one-shouldered tunic really is weighted more to one clavicle than
    // the other. Correcting that would be the pipeline overruling the artist.
    for (const stem of ['SK_Chr_Torso_Male_08', 'SK_Chr_Torso_Male_26', 'SK_Chr_Hips_Male_21']) {
      if (!existsSync(`${capeDir}${stem}.fbx`)) continue;
      expect(assemble([{ slot: 'torso', mesh: load(stem) }]).repairs, stem).toEqual([]);
    }
  });

  it('does not touch a plain body part', () => {
    expect(assemble([{ slot: 'torso', mesh: load(TORSO) }]).repairs).toEqual([]);
  });

  /**
   * A part assembled ALONE lands where it belongs (D-560).
   *
   * `Skeleton.pose()` restores each skinned bone's local from its bind matrix
   * relative to its PARENT'S WORLD matrix, and only sets world matrices for
   * bones that are in the skeleton. A head's `spine_03` is an unweighted
   * ancestor, so on a freshly built hierarchy it read as identity and the
   * head was placed at its bind position measured from the ORIGIN — 1.6m
   * behind the character, which is its own eye height.
   *
   * A whole character never showed it, because almost every bone in that
   * chain carries weights. Only the creation tool, which previews one part at
   * a time, ever assembled a chain with an unweighted link in the middle.
   */
  it('places a head assembled on its own at head height, not adrift', () => {
    const built = assemble([{ slot: 'head', mesh: part('SK_Chr_Head_Male_00') }]);
    built.group.updateMatrixWorld(true);
    const head = built.skeleton.bones.find((b) => b.name.toLowerCase() === 'head')!;
    const at = worldPos(head);
    // Source art is in centimetres, and this head binds at (0, 156.9, -0.5).
    expect(at.y).toBeGreaterThan(140);
    expect(at.y).toBeLessThan(175);
    expect(Math.abs(at.x)).toBeLessThan(5);
    expect(Math.abs(at.z)).toBeLessThan(5);
  });

  it('puts a part on the same head whether it is alone or with others', () => {
    // The creation tool previews an eyebrow by assembling it ONTO a head, so
    // the two assemblies have to agree about where the head is.
    const alone = assemble([{ slot: 'head', mesh: part('SK_Chr_Head_Male_00') }]);
    const withHair = assemble([
      { slot: 'head', mesh: part('SK_Chr_Head_Male_00') },
      { slot: 'hair', mesh: part('SK_Chr_Hair_04') },
    ]);
    alone.group.updateMatrixWorld(true);
    withHair.group.updateMatrixWorld(true);
    const a = worldPos(alone.skeleton.bones.find((b) => b.name.toLowerCase() === 'head')!);
    const b = worldPos(withHair.skeleton.bones.find((b2) => b2.name.toLowerCase() === 'head')!);
    expect(a.distanceTo(b)).toBeLessThan(0.5);
  });
});
