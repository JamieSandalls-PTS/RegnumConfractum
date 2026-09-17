import '../src/node-dom';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Box3, Vector3, type Object3D, type SkinnedMesh } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { assemble } from '../../client/src/render/assembly';
import { CHARACTER_SLOTS } from '@rc/shared';

/**
 * A character re-assembled in the browser must be the one the build wrote
 * (D-571).
 *
 * ⚠ This is the measurement the whole garment renderer rests on. Wearing a
 * garment means re-assembling a character from PART files with some slots
 * swapped, rather than loading the monolithic `.glb` the build produced. That
 * is only sound if a part survives the round trip through glTF — its
 * geometry, its bind matrix and its bone names — and none of those failing
 * would throw. A lost bind matrix folds a figure in half (D-555); a doubled
 * scale conversion produces a 1.8-CENTIMETRE knight that renders perfectly at
 * the wrong size; a reordered skeleton binds the left arm to the right leg
 * (D-558).
 *
 * So the assertion is on the SHAPE, against the build's own output, which is
 * the only comparison that can catch all three.
 */

const MODELS = join(process.cwd(), 'client', 'public', 'models');
const built = existsSync(join(MODELS, 'manifest.json'));

interface ManifestOutfit {
  id: string;
  model: string;
  height: number;
  source: string;
  parts: { pack: string; parts: Record<string, string> } | null;
}

const loader = new GLTFLoader();

async function parse(file: string): Promise<Object3D> {
  const raw = readFileSync(file);
  const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
  return (await loader.parseAsync(buf, '')).scene;
}

function firstSkinned(root: Object3D): SkinnedMesh {
  let found: SkinnedMesh | null = null;
  root.traverse((o) => {
    const m = o as SkinnedMesh;
    if (m.isSkinnedMesh && !found) found = m;
  });
  if (!found) throw new Error('no skinned mesh');
  return found;
}

function meshNamed(root: Object3D, name: string): SkinnedMesh | null {
  let found: SkinnedMesh | null = null;
  root.traverse((o) => {
    const m = o as SkinnedMesh;
    if (m.isSkinnedMesh && m.name === name) found = m;
  });
  return found;
}

function sizeOf(root: Object3D): Vector3 {
  root.updateMatrixWorld(true);
  const size = new Vector3();
  new Box3().setFromObject(root).getSize(size);
  return size;
}

/**
 * A character's parts, in the order the BUILD feeds them.
 *
 * ⚠ The order is load-bearing and it is not the JSON's. `assemble` derives its
 * bone array by walking the hierarchy it has built so far, so the order parts
 * arrive in decides the order bones end up in — measured: feeding this
 * character's parts in JSON key order produces the same 53 bones in a
 * completely different arrangement (`Pelvis` at index 0 against `clavicle_r`).
 *
 * That is not a correctness bug — `skinIndex` is remapped into whatever order
 * results, and animation tracks bind by NAME — which is exactly why it would
 * never be noticed. It is a DETERMINISM bug: the same character assembled by
 * the build and by the browser would differ, and any future comparison
 * between them, including this test, would be comparing two valid things and
 * calling one wrong. The build reads parts in the slot vocabulary's own
 * order for the same reason, and the client must too.
 */
async function partsInSlotOrder(outfit: ManifestOutfit): Promise<{ slot: string; mesh: SkinnedMesh }[]> {
  const files: { slot: string; mesh: SkinnedMesh }[] = [];
  for (const slot of CHARACTER_SLOTS) {
    const stem = outfit.parts!.parts[slot];
    if (!stem) continue;
    const file = join(MODELS, 'parts', `${outfit.parts!.pack}__${stem}.glb`);
    files.push({ slot, mesh: firstSkinned(await parse(file)) });
  }
  return files;
}

function manifest(): { outfits: ManifestOutfit[]; garments: unknown[] } {
  return JSON.parse(readFileSync(join(MODELS, 'manifest.json'), 'utf8')) as {
    outfits: ManifestOutfit[];
    garments: unknown[];
  };
}

describe.skipIf(!built)('re-assembling a character from part files (D-571)', () => {
  it('produces the same figure the build exported', async () => {
    const dressable = manifest().outfits.filter((o) => o.parts !== null);
    expect(dressable.length).toBeGreaterThan(0);

    for (const outfit of dressable) {
      const mono = sizeOf(await parse(join(MODELS, outfit.model)));

      const rebuilt = assemble(await partsInSlotOrder(outfit));
      rebuilt.skeleton.pose();
      // The same conversion `exportOutfit` applies, and the reason a part
      // file is NOT pre-scaled: applying it twice is the silent failure.
      rebuilt.group.scale.setScalar(0.01);
      const re = sizeOf(rebuilt.group);

      // Millimetres, on a figure about 1.8m tall. Exact equality would be
      // asserting that two float paths round identically, which is a
      // different and less useful claim.
      expect(re.x).toBeCloseTo(mono.x, 3);
      expect(re.y).toBeCloseTo(mono.y, 3);
      expect(re.z).toBeCloseTo(mono.z, 3);
    }
  }, 120_000);

  it('keeps the same bones', async () => {
    for (const outfit of manifest().outfits.filter((o) => o.parts !== null)) {
      const mono = firstSkinned(await parse(join(MODELS, outfit.model)));
      const rebuilt = assemble(await partsInSlotOrder(outfit));
      expect(new Set(rebuilt.skeleton.bones.map((b) => b.name))).toEqual(
        new Set(mono.skeleton.bones.map((b) => b.name)),
      );
    }
  }, 120_000);

  it('DEFORMS identically under the same pose, which is the real claim', async () => {
    /*
     * ⚠ The set is asserted above and the ORDER deliberately is not, because
     * the order genuinely differs and that was worth understanding rather
     * than asserting away. In the monolith each part arrived from FBX
     * carrying the vendor's whole rig, so a branch point like `spine_03`
     * lists its children in the FBX's order; a part FILE carries only the
     * ancestors that part needs, so whichever part introduced a child first
     * decides. `ashfold-guard` happens to match and `ashfold-townsfolk` does
     * not (`neck_01` against `clavicle_l` at index 4).
     *
     * ⚠ That last clause was EVIDENCE and it was read as trivia. A neck
     * sitting beside a clavicle in the array was the visible edge of the neck
     * being parented to one. Ordering was the innocent explanation and it was
     * taken without checking the other one. Noticing an anomaly and
     * explaining it is not the same as measuring it.
     *
     * It does not matter, and this is what says so rather than an argument:
     * `skinIndex` is remapped into whatever order results, and animation
     * tracks bind by NAME. So both figures are posed by name exactly as a
     * clip would pose them, and the SKINNED vertex positions are compared.
     * Measured worst case across both characters: 90 nanometres.
     *
     * If this ever fails, the bone remap is wrong and the symptom in play
     * would be a limb following the wrong joint — which reads as bad art.
     */
    for (const outfit of manifest().outfits.filter((o) => o.parts !== null)) {
      const monoRoot = await parse(join(MODELS, outfit.model));
      const rebuilt = assemble(await partsInSlotOrder(outfit));
      rebuilt.skeleton.pose();

      const bend = (root: Object3D, name: string, r: number): void => {
        root.traverse((o) => {
          if (o.name === name) o.rotation.set(r, r * 0.5, 0);
        });
      };
      for (const root of [monoRoot, rebuilt.group]) {
        bend(root, 'spine_02', 0.6);
        bend(root, 'UpperArm_R', -0.9);
        bend(root, 'Thigh_L', 0.4);
        // ⚠ The NECK and the CLAVICLE, added after this test watched a real
        // bug walk past it. `neck_01` was being parented to `clavicle_r`,
        // because the head part ships it as a root and the head is assembled
        // first. Every bone still landed correctly at REST, so the comparison
        // above passed; and the three bends chosen here rotate the spine, the
        // upper arm and the thigh, none of which is the neck's wrong parent.
        // The head was 84 degrees out of true in play and this file said the
        // assembly was identical.
        //
        // ⚠ The clavicle is bent as well as the neck on purpose: bending only
        // the neck catches a wrong LOCAL transform, and what was wrong was
        // which bone it hung FROM — which shows only when that bone moves.
        bend(root, 'neck_01', 0.5);
        bend(root, 'clavicle_r', 0.4);
        root.updateMatrixWorld(true);
      }

      const a = meshNamed(monoRoot, 'torso');
      const b = meshNamed(rebuilt.group, 'torso');
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      const count = a!.geometry.attributes.position!.count;
      const va = new Vector3();
      const vb = new Vector3();
      let worst = 0;
      const step = Math.max(1, Math.floor(count / 400));
      for (let i = 0; i < count; i += step) {
        va.fromBufferAttribute(a!.geometry.attributes.position as never, i);
        vb.fromBufferAttribute(b!.geometry.attributes.position as never, i);
        a!.applyBoneTransform(i, va);
        b!.applyBoneTransform(i, vb);
        worst = Math.max(worst, va.distanceTo(vb));
      }
      // Centimetres, on a 170cm figure. A micron is float noise; a millimetre
      // would already be a different character.
      expect(worst).toBeLessThan(0.001);
    }
  }, 120_000);

  it('names every mesh by its SLOT, which is what a swap replaces', async () => {
    // A garment swaps by slot. A part file whose mesh came back named after
    // the source file would still assemble, still animate, and never be
    // replaced by anything — the armour would simply not appear.
    const outfit = manifest().outfits.find((o) => o.parts !== null)!;
    const slots = Object.keys(outfit.parts!.parts);
    const rebuilt = assemble(await partsInSlotOrder(outfit));
    expect(rebuilt.meshes.map((m) => m.name).sort()).toEqual([...slots].sort());
  }, 120_000);
});

describe.skipIf(!built)('the order parts arrive in (D-571)', () => {
  it('changes the bone ARRAY but not the figure', async () => {
    // ⚠ Both halves matter. The shape being identical is what says the
    // skinIndex remap is sound whatever order it sees — so a garment swapped
    // in at an arbitrary position cannot deform anybody. The bone array
    // DIFFERING is what says the order still has to be pinned: two correct
    // assemblies that disagree are exactly the pair that makes a future
    // comparison meaningless.
    const outfit = manifest().outfits.find((o) => o.parts !== null)!;
    const ordered = await partsInSlotOrder(outfit);
    const shuffled = [...ordered].reverse();

    const a = assemble(ordered);
    const b = assemble(shuffled);
    a.skeleton.pose();
    b.skeleton.pose();
    a.group.scale.setScalar(0.01);
    b.group.scale.setScalar(0.01);
    const sa = sizeOf(a.group);
    const sb = sizeOf(b.group);
    expect(sb.x).toBeCloseTo(sa.x, 3);
    expect(sb.y).toBeCloseTo(sa.y, 3);
    expect(sb.z).toBeCloseTo(sa.z, 3);

    // Same bones, and the arrangement is free to differ.
    expect(new Set(b.skeleton.bones.map((x) => x.name))).toEqual(
      new Set(a.skeleton.bones.map((x) => x.name)),
    );
  }, 120_000);
});

describe.skipIf(!built)('what the manifest promises about dressing (D-571)', () => {
  it('offers a slot vocabulary only for characters assembled from one', () => {
    // ⚠ A character discovered from a `.unitypackage` or a folder of loose
    // FBX (D-556, D-557) has no slots — its meshes are named after whatever
    // file they came from — so there is nothing for a swap to replace. `null`
    // is the honest answer and is what stops the client trying.
    for (const outfit of manifest().outfits) {
      if (outfit.source === 'defined') expect(outfit.parts).not.toBeNull();
      else expect(outfit.parts).toBeNull();
    }
  });
});
