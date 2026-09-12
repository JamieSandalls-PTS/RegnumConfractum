import './node-dom';
import { readFileSync } from 'node:fs';
import { Matrix4, Object3D, Quaternion, Vector3, type SkinnedMesh } from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { assemble } from '../../client/src/render/assembly';
import { meshPath, packOf, partStems } from './packs';

/**
 * Which way a hand bone points (D-564).
 *
 *   npm run measure:hand
 *
 * The measurement `fit:weapons` is built on. A grip offset is "out along the
 * fingers", and which local axis that IS differs between the two hands — so
 * mirroring a weapon is a sign flip on one axis and the question is which one.
 * Guessing gives a sword that hangs backwards out of the wrist, which looks
 * like a bad rotation rather than like a bad sign.
 *
 * The answer for this rig, printed by running it: the right hand's local +X
 * points back toward the shoulder and the left hand's points away, and the
 * left hand's frame is otherwise the world's. That last part is why a shield
 * needs no rotation at all.
 */

const loader = new FBXLoader();

const SLOT_KEYS = [
  'Head_',
  'Torso_',
  'Hips_',
  'ArmUpperRight',
  'ArmUpperLeft',
  'ArmLowerRight',
  'ArmLowerLeft',
  'HandRight',
  'HandLeft',
  'LegRight',
  'LegLeft',
];

function mannequin(packId: string): Object3D {
  const pack = packOf(packId);
  if (!pack) throw new Error(`no pack '${packId}' in assets/source`);
  const stems = [...partStems(pack)];
  const meshes = SLOT_KEYS.map((key) => stems.find((s) => s.includes(key)))
    .filter((s): s is string => Boolean(s))
    .map((stem) => {
      const group = loader.parse(readFileSync(meshPath(pack, stem)!).buffer as ArrayBuffer, '');
      const found: SkinnedMesh[] = [];
      group.traverse((o) => {
        if ((o as SkinnedMesh).isSkinnedMesh) found.push(o as SkinnedMesh);
      });
      return { slot: stem, mesh: found[0] };
    })
    .flatMap((m) => (m.mesh ? [{ slot: m.slot, mesh: m.mesh }] : []));
  const built = assemble(meshes);
  built.group.updateMatrixWorld(true);
  return built.group;
}

const invokedDirectly = process.argv[1]?.includes('measure-hand');
if (invokedDirectly) {
  const body = mannequin(process.argv[2] ?? 'modular-fantasy-hero');
  for (const name of ['Hand_R', 'Hand_L']) {
    const bone = body.getObjectByName(name);
    if (!bone) {
      console.log(`${name}: not in this rig`);
      continue;
    }
    const world = bone.matrixWorld;
    const position = new Vector3().setFromMatrixPosition(world);
    const rotation = new Quaternion();
    world.decompose(new Vector3(), rotation, new Vector3());
    const scale = new Vector3().setFromMatrixScale(world);
    const towards = (v: Vector3): string =>
      v
        .clone()
        .applyQuaternion(rotation)
        .normalize()
        .toArray()
        .map((n) => n.toFixed(2))
        .join(', ');
    console.log(
      `${name}  at ${position.toArray().map((v) => v.toFixed(1)).join(', ')}  ` +
        `bone scale ${scale.x.toFixed(4)}`,
    );
    console.log(`   local +X points ${towards(new Vector3(1, 0, 0))}`);
    console.log(`   local +Y points ${towards(new Vector3(0, 1, 0))}`);
    console.log(`   local +Z points ${towards(new Vector3(0, 0, 1))}`);
    // Which way the shoulder lies, in the bone's own frame. The direction a
    // weapon has to travel to reach the fist is the OPPOSITE of this.
    const shoulder = body.getObjectByName(name === 'Hand_R' ? 'UpperArm_R' : 'UpperArm_L');
    if (shoulder) {
      const local = new Vector3().setFromMatrixPosition(
        new Matrix4().copy(world).invert().multiply(shoulder.matrixWorld),
      );
      console.log(
        `   the shoulder is at ${local.toArray().map((v) => v.toFixed(2)).join(', ')} in bone space`,
      );
    }
  }
}
