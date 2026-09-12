import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { Box3, Object3D, Vector3 } from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { AssetFileSchema, STANCES, type CharacterItem } from '@rc/shared';
import { assemble } from '../../client/src/render/assembly';
import { allPacks, meshPath, packOf, partStems } from '../src/packs';
import { FIT_TAG, familyOf, packScale } from '../src/fit-weapons';
import type { MeshMeasurement } from '../src/measure-weapons';
import '../src/node-dom';

/**
 * Every weapon is where a hand can hold it (D-564).
 *
 * 163 items were placed by one rule (`npm run fit:weapons`) rather than one at
 * a time, which is the only way that many get done — and the reason it is safe
 * is this file. The stakeholder does not read code (D-114) and a weapon that
 * is a hundred times too big or floating a metre from the fist looks, in a
 * screenshot, exactly like a weapon that is fine but oddly modelled.
 *
 * ⚠ The strongest assertion here is SIZE. The packs disagree about units by
 * 100x (D-561) and nothing in a file says which is which, so a wrong `scale`
 * is both the easiest mistake to make and the one nothing else catches: a
 * sword at scale 1 in a centimetre pack is 89 metres long, which renders as a
 * grey plane across the whole scene and reads as a broken shader.
 */

const root = fileURLToPath(new URL('../..', import.meta.url));
const assetsDir = join(root, 'content', 'assets');

/** The art is licensed and gitignored, so a fresh clone skips this. */
function haveArt(): boolean {
  try {
    return allPacks().length > 0;
  } catch {
    return false;
  }
}

const loader = new FBXLoader();

/** A plain body, assembled the way the tools and the build both assemble one. */
function mannequin(): Object3D {
  const pack = packOf('modular-fantasy-hero');
  if (!pack) throw new Error('no character pack');
  const stems = [...partStems(pack)];
  const keys = [
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
  const meshes = keys
    .map((key) => stems.find((s) => s.includes(key)))
    .filter((s): s is string => Boolean(s))
    .map((stem) => {
      const file = meshPath(pack, stem)!;
      const group = loader.parse(readFileSync(file).buffer as ArrayBuffer, '');
      let found: Object3D | null = null;
      group.traverse((o) => {
        if ((o as { isSkinnedMesh?: boolean }).isSkinnedMesh && !found) found = o;
      });
      return { slot: stem, mesh: found };
    })
    .filter((m) => m.mesh);
  const built = assemble(meshes as never);
  built.group.scale.setScalar(0.01);
  built.group.updateMatrixWorld(true);
  return built.group;
}

interface Placed {
  item: CharacterItem;
  /** How far the item's grip ends up from the bone that holds it, in metres. */
  gripDistance: number;
  /** Longest dimension of the item as it appears in the world, in metres. */
  worldLength: number;
  /** Its box in world space, for the overlap check. */
  box: Box3;
}

/**
 * Put one item on the body exactly the way the tool and the game do.
 *
 * ⚠ Divided by the bone's measured world scale, not by an assumed 0.01. A bind
 * matrix can carry scale of its own, and assuming the group's is what turned a
 * sword into a dot in D-563.
 */
function place(body: Object3D, item: CharacterItem, mesh: Object3D): Placed | null {
  const bone = body.getObjectByName(item.attach);
  if (!bone) return null;
  body.updateMatrixWorld(true);
  const boneScale = new Vector3();
  bone.getWorldScale(boneScale);
  const factor = boneScale.x || 1;
  const t = item.transform;

  const holder = new Object3D();
  holder.scale.setScalar(t.scale / factor);
  holder.position.set(t.position[0] / factor, t.position[1] / factor, t.position[2] / factor);
  holder.rotation.set(
    (t.rotation[0] * Math.PI) / 180,
    (t.rotation[1] * Math.PI) / 180,
    (t.rotation[2] * Math.PI) / 180,
  );
  holder.add(mesh);
  bone.add(holder);
  body.updateMatrixWorld(true);

  const box = new Box3().setFromObject(mesh);
  const size = new Vector3();
  box.getSize(size);
  const gripWorld = new Vector3().setFromMatrixPosition(mesh.matrixWorld);
  const boneWorld = new Vector3().setFromMatrixPosition(bone.matrixWorld);

  bone.remove(holder);
  body.updateMatrixWorld(true);

  return {
    item,
    gripDistance: gripWorld.distanceTo(boneWorld),
    worldLength: Math.max(size.x, size.y, size.z),
    box,
  };
}

function items(): CharacterItem[] {
  if (!existsSync(assetsDir)) return [];
  return readdirSync(assetsDir)
    .filter((f) => f.endsWith('.character-item.json'))
    .flatMap((f) => AssetFileSchema.parse(JSON.parse(readFileSync(join(assetsDir, f), 'utf8'))).assets)
    .filter((a): a is CharacterItem => a.kind === 'character-item');
}

describe.skipIf(!haveArt())('every worn item fits a hand', () => {
  let body: Object3D;
  let placed: Placed[] = [];
  let unplaceable: string[] = [];

  beforeAll(() => {
    body = mannequin();
    for (const item of items()) {
      const pack = packOf(item.pack);
      const file = pack ? meshPath(pack, item.mesh) : null;
      if (!file) {
        unplaceable.push(`${item.pack}/${item.mesh}: no mesh`);
        continue;
      }
      const mesh = loader.parse(readFileSync(file).buffer as ArrayBuffer, '');
      const result = place(body, item, mesh);
      if (!result) unplaceable.push(`${item.id}: no bone named ${item.attach}`);
      else placed.push(result);
    }
  }, 300_000);

  it('names a bone the rig actually has', () => {
    expect(unplaceable).toEqual([]);
    expect(placed.length).toBeGreaterThan(100);
  });

  /**
   * The unit check, and the reason this file exists.
   *
   * A weapon between a hand-axe and a pike. Anything outside that is a scale
   * mistake rather than an unusual weapon — at 100x wrong, a sword is 89
   * metres long, and at 1/100th it is a speck inside the fist.
   */
  it('ends up somewhere between 15cm and 3m long', () => {
    const wrong = placed
      .filter((p) => p.worldLength < 0.15 || p.worldLength > 3)
      .map((p) => `${p.item.pack}/${p.item.id} is ${(p.worldLength * 100).toFixed(0)}cm`);
    expect(wrong).toEqual([]);
  });

  it('sits on the limb rather than out on a pole', () => {
    // ⚠ The allowance SCALES with the item, and that is not slack for its own
    // sake. A shield strapped to the forearm has its centre a third of a metre
    // from the elbow because that is where the middle of a shield is, and a
    // 2.7m halberd gripped a third of the way up is held 40cm from the fist.
    // A flat 30cm threshold called both of those broken; you cannot hold a
    // thing further from you than the thing is long, which is the real rule.
    //
    // ⚠ The CROSSBOW is exempt from the tight form of this, and it is the one
    // weapon in any pack that has to be. Every other mesh here is modelled
    // with its origin AT the grip (D-564), so a big grip distance really is a
    // placement error. The crossbow is modelled from the nose with 92% of it
    // behind the origin, so holding it correctly — a third forward of the
    // butt — puts the origin 62cm ahead of the fist by construction. What
    // still has to hold for it is the real rule underneath: you cannot hold a
    // thing further from you than the thing is long.
    const allowance = (p: Placed): number =>
      /crossbow/i.test(p.item.mesh) ? p.worldLength : 0.3 + p.worldLength * 0.25;
    const adrift = placed
      .filter((p) => p.gripDistance > allowance(p))
      .map((p) => `${p.item.pack}/${p.item.id} grips ${(p.gripDistance * 100).toFixed(0)}cm from ${p.item.attach} (it is ${(p.worldLength * 100).toFixed(0)}cm long)`);
    expect(adrift).toEqual([]);
  });

  /**
   * Nothing is buried in the character's own chest.
   *
   * Measured against the torso rather than the whole body, because a
   * greatsword's tip legitimately passes a knee in a T-pose and a shield
   * legitimately covers a forearm. A weapon whose CENTRE is inside the ribs is
   * the failure — that is what a missing rotation looks like.
   */
  it('does not have its middle inside the character', () => {
    const torso = new Box3().setFromObject(body);
    const size = new Vector3();
    torso.getSize(size);
    // The middle third of the figure, at chest depth.
    const chest = new Box3(
      new Vector3(torso.min.x + size.x * 0.42, torso.min.y + size.y * 0.55, torso.min.z + size.z * 0.3),
      new Vector3(torso.min.x + size.x * 0.58, torso.min.y + size.y * 0.85, torso.min.z + size.z * 0.7),
    );
    const buried = placed
      .filter((p) => chest.containsPoint(p.box.getCenter(new Vector3())))
      .map((p) => `${p.item.pack}/${p.item.id}`);
    expect(buried).toEqual([]);
  });

  it('declares a stance the animation layer knows', () => {
    const unknown = items()
      .filter((i) => i.stance && !(STANCES as readonly string[]).includes(i.stance))
      .map((i) => `${i.id}: ${i.stance}`);
    expect(unknown).toEqual([]);
  });

  /**
   * Everything the fitter placed still carries the fitter's numbers.
   *
   * ⚠ This is the test that catches a rotation quietly going wrong, and the
   * geometric checks above do NOT: an un-rotated blade stands upright out of
   * the fist, which hits nothing, sits in the hand and measures the right
   * length. It is only wrong compared to the other 162. So the assertion is
   * CONSISTENCY — an item the fitter owns must match its family, and an item a
   * person tuned has lost the tag and is exempt by construction.
   */
  it('keeps every auto-fitted item on its family transform', () => {
    const measurements = JSON.parse(
      readFileSync(join(root, 'tools', 'weapon-measurements.json'), 'utf8'),
    ) as MeshMeasurement[];
    const byMesh = new Map(measurements.map((m) => [m.mesh, m]));
    const scaleFor = new Map<string, number>();
    for (const m of measurements) {
      scaleFor.set(
        m.pack,
        packScale(measurements.filter((x) => x.pack === m.pack).map((x) => x.length)),
      );
    }
    const expected: Record<string, [number, number, number]> = {
      blade: [270, 10, 0],
      shield: [0, 0, 0],
      tool: [0, 10, 0],
      bow: [0, 0, 0],
      crossbow: [0, 0, 0],
    };
    const off: string[] = [];
    for (const item of items()) {
      if (!item.tags.includes(FIT_TAG)) continue;
      const measurement = byMesh.get(item.mesh);
      if (!measurement) continue;
      const family = familyOf(item.mesh, measurement);
      const want = expected[family]!;
      if (item.transform.rotation.some((v, i) => v !== want[i])) {
        off.push(`${item.pack}/${item.id} is a ${family} at ${item.transform.rotation.join(',')}`);
      }
      if (item.transform.scale !== scaleFor.get(item.pack)) {
        off.push(`${item.pack}/${item.id} scale ${item.transform.scale}`);
      }
    }
    expect(off).toEqual([]);
  });

  it('carries a shield on the off SIDE, by whichever bone', () => {
    // ⚠ Not `Hand_L`. A shield is strapped to the forearm, not gripped in the
    // fist, and the stakeholder moved ten of them to `lowerarm_l` by hand —
    // which is more correct than where the fitting rule put them. What has to
    // hold is the SIDE: a shield on the sword arm renders perfectly and plays
    // every animation backwards.
    const wrongSide = items()
      .filter((i) => /shield|buckler/i.test(i.mesh) && !/_l$|left/i.test(i.attach))
      .map((i) => `${i.id} on ${i.attach}`);
    expect(wrongSide).toEqual([]);
  });
});

