import './node-dom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AnimationMixer, Box3, Vector3, type Object3D, type SkinnedMesh } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * Where a seated body actually rests (D-648).
 *
 * `npm run measure:seat [outfit] [seat-mesh-height] [clip]` poses a built
 * character in the sitting clip and prints, in metres for a body of the
 * outfit's own height:
 *   - the height of the seat CONTACT: the lowest skin under the pelvis,
 *     which is where the top of a seat must be;
 *   - how far the hips sit from the character's origin, which is where the
 *     server stands a sitter (the seat's centre).
 * Given the seat mesh's height at scale 1, it prints the scale that puts the
 * seat top at the contact. Measured, because the stools were resized twice by
 * eye and the body still sat inside them.
 */

const models = fileURLToPath(new URL('../../client/public/models/', import.meta.url));

async function glb(file: string): Promise<{ scene: Object3D; animations: import('three').AnimationClip[] }> {
  const b = readFileSync(`${models}${file}`);
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  const gltf = await new GLTFLoader().parseAsync(ab, '');
  return { scene: gltf.scene, animations: gltf.animations };
}

export async function measureSeat(outfitId: string, clipName = 'unarmed-sitting'): Promise<{
  height: number;
  contact: number;
  hipsForward: number;
  hipsSide: number;
}> {
  const manifest = JSON.parse(readFileSync(`${models}manifest.json`, 'utf8')) as {
    outfits: { id: string; model: string; animations: string; height: number }[];
  };
  const outfit = manifest.outfits.find((o) => o.id === outfitId);
  if (!outfit) throw new Error(`no outfit '${outfitId}'`);
  const body = await glb(outfit.model);
  const anims = await glb(outfit.animations);
  const clip = anims.animations.find((c) => c.name === clipName);
  if (!clip) throw new Error(`no clip '${clipName}' in ${outfit.animations}`);

  const mixer = new AnimationMixer(body.scene);
  mixer.clipAction(clip).play();
  // Well into the loop, past any settle at its start.
  mixer.update(clip.duration * 0.5);
  body.scene.updateMatrixWorld(true);

  // The model as the client draws it: origin at the feet, scaled to its height.
  const rest = new Box3().setFromObject(body.scene);
  const pelvis = (() => {
    let found: Object3D | null = null;
    body.scene.traverse((o) => {
      if (!found && /^pelvis$/i.test(o.name)) found = o;
    });
    if (!found) throw new Error('no pelvis bone');
    return found as Object3D;
  })();
  const hip = pelvis.getWorldPosition(new Vector3());

  // Every skinned vertex, posed; the seat contact is the lowest one within a
  // hand's breadth of the pelvis horizontally.
  let contact = Infinity;
  const v = new Vector3();
  body.scene.traverse((o) => {
    const mesh = o as SkinnedMesh;
    if (!mesh.isSkinnedMesh) return;
    const pos = mesh.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      mesh.applyBoneTransform(i, v);
      v.applyMatrix4(mesh.matrixWorld);
      if (Math.hypot(v.x - hip.x, v.z - hip.z) > 0.12) continue;
      if (v.y < contact) {
        contact = v.y;
        if (process.env.SEAT_DEBUG) {
          const si = mesh.geometry.getAttribute('skinIndex');
          const sw = mesh.geometry.getAttribute('skinWeight');
          const bones = [0, 1, 2, 3].map((k) => `${mesh.skeleton.bones[si.getComponent(i, k)]?.name}:${sw.getComponent(i, k).toFixed(2)}`);
          console.log(`  lower: y=${v.y.toFixed(3)} x=${v.x.toFixed(3)} z=${v.z.toFixed(3)} ${mesh.name} ${bones.join(' ')}`);
        }
      }
    }
  });
  // The model faces +Z at rest (the client turns the root to face).
  if (process.env.SEAT_DEBUG) {
    console.log(`  pelvis joint at y=${hip.y.toFixed(3)}; rest box y ${rest.min.y.toFixed(3)}..${rest.max.y.toFixed(3)}`);
    console.log(`  clip duration ${clip.duration.toFixed(2)}s, tracks ${clip.tracks.length}`);
  }
  return { height: outfit.height, contact, hipsForward: hip.z, hipsSide: hip.x };
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('measure-seat.ts')) {
  const outfit = process.argv[2] ?? 'ashfold-townsfolk';
  const seatHeight = Number(process.argv[3] ?? 0.624);
  const clip = process.argv[4] ?? 'unarmed-sitting';
  const m = await measureSeat(outfit, clip);
  console.log(`${outfit} (${m.height.toFixed(3)} m tall), clip ${clip}`);
  console.log(`  seat contact at ${m.contact.toFixed(3)} m`);
  console.log(`  hips ${m.hipsForward.toFixed(3)} m forward, ${m.hipsSide.toFixed(3)} m to the side of the origin`);
  console.log(`  a seat ${seatHeight} m tall at scale 1 wants scale ${(m.contact / seatHeight).toFixed(3)}`);
}
