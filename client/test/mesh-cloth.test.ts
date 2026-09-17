import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ClothSettingsSchema } from '@rc/shared';
import { MeshCloth, clothFor, setClothSettings } from '../src/render/mesh-cloth';

/**
 * Cloth on a real mesh (D-631), judged by measurement.
 *
 * A strip of cloth: two bones, `anchor` at the top and `tail` below it. The
 * top row is weighted to the anchor, every other row to the tail. Nothing
 * animates the tail — that is the cape chain's situation in this pack — so
 * with `freeBones: ['tail']` the top row must stay on the anchor and the
 * rest must hang, hold their edge lengths, follow the anchor when it moves,
 * and stay outside a collider.
 */

const COLS = 3;
const ROWS = 6;
/** Model units are centimetres, like the pack; the strip is 20cm wide, 50cm long. */
const W = 20;
const H = 50;

function strip(): { mesh: THREE.SkinnedMesh; anchor: THREE.Bone; tail: THREE.Bone; root: THREE.Group } {
  const anchor = new THREE.Bone();
  anchor.name = 'anchor';
  // A metre above the feet, where a collar is: the floor is measured from
  // the root and a strip pinned at the feet would have nowhere to hang.
  anchor.position.y = 100;
  const tail = new THREE.Bone();
  tail.name = 'tail';
  tail.position.y = -H;
  anchor.add(tail);

  const positions: number[] = [];
  const skinIndex: number[] = [];
  const skinWeight: number[] = [];
  const uv: number[] = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      // Authored AT the anchor: a skinned vertex sits where the artist put
      // it, and binding takes the current pose as rest (D-558's bind rule).
      positions.push((c / (COLS - 1) - 0.5) * W, 100 - (r / (ROWS - 1)) * H, 0);
      uv.push(c / (COLS - 1), r / (ROWS - 1));
      // Top row on the anchor, the rest on the tail.
      skinIndex.push(r === 0 ? 0 : 1, 0, 0, 0);
      skinWeight.push(1, 0, 0, 0);
    }
  }
  const index: number[] = [];
  for (let r = 0; r < ROWS - 1; r++) {
    for (let c = 0; c < COLS - 1; c++) {
      const a = r * COLS + c;
      const b = a + 1;
      const d = a + COLS;
      const e = d + 1;
      index.push(a, d, b, b, d, e);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setIndex(index);
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4));

  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
  mesh.name = 'back';
  const root = new THREE.Group();
  // The same shape the assembly gives the game: bones and mesh under a group
  // scaled from centimetres to metres.
  root.add(mesh);
  mesh.add(anchor);
  root.scale.setScalar(0.01);
  // ⚠ Bind AFTER the world matrices exist. `bind()` takes the bones' inverse
  // world matrices at that moment; binding first gave every bone an identity
  // inverse and the strip skinned to nonsense that still had the right count.
  root.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton([anchor, tail]));
  return { mesh, anchor, tail, root };
}

const settings = ClothSettingsSchema.parse({
  freeBones: ['tail'],
  gravity: 9.8,
  damping: 0.98,
  stiffness: 0.9,
  bend: 0.2,
  iterations: 8,
  windStrength: 0,
  floor: 0,
  colliders: [],
});

function run(cloth: MeshCloth, seconds: number, wind = 0): void {
  for (let t = 0; t < seconds; t += 1 / 60) cloth.step(1 / 60, wind, t);
}

describe('MeshCloth', () => {
  it('pins what the artist weighted to the body and frees the rest', () => {
    const { mesh, root } = strip();
    const cloth = new MeshCloth(mesh, settings, root);
    expect(cloth.particleCount).toBe(COLS * ROWS);
    expect(cloth.freeCount).toBe(COLS * (ROWS - 1));
    for (let p = 0; p < COLS; p++) expect(cloth.isPinned(p)).toBe(true);
    expect(cloth.isPinned(COLS)).toBe(false);
    // The original is hidden and a proxy draws in its place.
    expect(mesh.visible).toBe(false);
    expect(cloth.proxy.geometry.getAttribute('position').count).toBe(COLS * ROWS);
  });

  it('⚠ hangs under gravity and holds its edges', () => {
    const { mesh, root } = strip();
    const cloth = new MeshCloth(mesh, settings, root);
    run(cloth, 3);
    const top = cloth.particle(0);
    const bottom = cloth.particle((ROWS - 1) * COLS);
    // Pinned row sits on the anchor (world y 1); the hem is about the strip's
    // length below it — 0.5m in world metres — and has not drifted sideways.
    expect(top.y).toBeCloseTo(1, 5);
    expect(bottom.y).toBeLessThan(0.6);
    expect(bottom.y).toBeGreaterThan(0.45);
    expect(Math.abs(bottom.z)).toBeLessThan(0.05);
    // Every vertical edge is within a few percent of its rest length.
    const rest = (H / (ROWS - 1)) * 0.01;
    for (let r = 0; r < ROWS - 1; r++) {
      const a = cloth.particle(r * COLS + 1);
      const b = cloth.particle((r + 1) * COLS + 1);
      expect(Math.abs(a.distanceTo(b) - rest) / rest).toBeLessThan(0.06);
    }
  });

  it('follows the bone it is pinned to', () => {
    const { mesh, anchor, root } = strip();
    const cloth = new MeshCloth(mesh, settings, root);
    run(cloth, 1);
    anchor.position.x += 100; // one metre, in centimetres
    root.updateMatrixWorld(true);
    run(cloth, 3);
    // Particle 0 is the top-left vertex, 10cm left of the anchor: it moved
    // exactly the metre the bone did.
    expect(cloth.particle(0).x).toBeCloseTo(-0.1 + 1, 3);
    // The hem catches up: it hangs below the new anchor, not the old one.
    expect(cloth.particle((ROWS - 1) * COLS).x).toBeGreaterThan(0.8);
  });

  it('⚠ stays outside a collider', () => {
    const { mesh, anchor, tail, root } = strip();
    // A sphere on the tail bone, 25cm below the anchor, radius 15cm: the
    // cloth has to drape over it rather than pass through.
    tail.position.y = -25;
    root.updateMatrixWorld(true);
    const withBall = ClothSettingsSchema.parse({
      ...settings,
      colliders: [{ bone: 'tail', radius: 0.15 }],
      thickness: 0,
    });
    const cloth = new MeshCloth(mesh, withBall, root);
    run(cloth, 3);
    const centre = tail.getWorldPosition(new THREE.Vector3());
    for (let p = 0; p < cloth.particleCount; p++) {
      if (cloth.isPinned(p)) continue;
      expect(cloth.particle(p).distanceTo(centre)).toBeGreaterThanOrEqual(0.15 - 1e-3);
    }
    void anchor;
  });

  it('is pushed by wind', () => {
    const { mesh, root } = strip();
    const windy = ClothSettingsSchema.parse({ ...settings, windStrength: 30, windScale: 1 });
    const cloth = new MeshCloth(mesh, windy, root);
    run(cloth, 3, 1);
    const hem = cloth.particle((ROWS - 1) * COLS + 1);
    expect(Math.hypot(hem.x, hem.z)).toBeGreaterThan(0.1);
  });

  it('⚠ takes a non-indexed mesh, as the pack ships them', () => {
    const { mesh, root } = strip();
    // What FBXLoader hands over: every triangle its own three vertices.
    const soup = mesh.geometry.toNonIndexed();
    mesh.geometry = soup;
    const cloth = new MeshCloth(mesh, settings, root);
    // Welded back into the same particles, so the same physics.
    expect(cloth.particleCount).toBe(COLS * ROWS);
    expect(cloth.freeCount).toBe(COLS * (ROWS - 1));
    run(cloth, 3);
    expect(cloth.particle((ROWS - 1) * COLS).y).toBeLessThan(0.6);
    expect(cloth.particle((ROWS - 1) * COLS).y).toBeGreaterThan(0.45);
  });

  it('dispose puts the original back', () => {
    const { mesh, root } = strip();
    const scene = new THREE.Scene();
    const cloth = new MeshCloth(mesh, settings, root);
    scene.add(cloth.proxy);
    cloth.dispose();
    expect(mesh.visible).toBe(true);
    expect(cloth.proxy.parent).toBeNull();
  });
});

describe('the cloth registry', () => {
  it('answers by pack and stem', () => {
    setClothSettings([{ pack: 'p', cloth: { SK_Chr_BackAttachment_15: settings } }]);
    expect(clothFor('p', 'SK_Chr_BackAttachment_15')).toBe(settings);
    expect(clothFor('p', 'SK_Chr_BackAttachment_14')).toBeNull();
    expect(clothFor('q', 'SK_Chr_BackAttachment_15')).toBeNull();
  });
});
