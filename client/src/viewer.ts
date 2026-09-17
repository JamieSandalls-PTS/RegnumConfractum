import * as THREE from 'three';
import type { LightingProfile } from '@rc/shared';
import { GameScene } from './render/scene';
import { WorkbenchBody } from './render/workbench-body';
import { clothTuning } from './render/cloth';
import { ClothTab } from './cloth-ui';

/**
 * The CLOTH WORKBENCH (D-520, reduced to it in D-617).
 *
 * ⚠ This page was the procedural cast's viewer: a grid of twelve generated
 * characters with every animation on demand, seed filters, gear toggles and a
 * per-part colour editor, so the art-direction verdict could be given against
 * living examples rather than argument. That cast is deleted, and every one of
 * those controls browsed something that no longer exists.
 *
 * What survives is the half that is still needed — tuning a cape or a robe and
 * exporting the settings — hung on `WorkbenchBody`, a jointed placeholder at
 * roughly human proportions. ⚠ It is a stand-in and the page says so: a
 * garment tuned here is tuned against an approximation, which is the honest
 * state of cloth tuning until something rigged replaces it.
 */

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const stage = $('stage');
const scene = new GameScene(stage);

// Ground: a plain slab plus a faint grid, enough to read contact and scale.
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(40, 40).rotateX(-Math.PI / 2),
  new THREE.MeshLambertMaterial({ color: 0x5c564c }),
);
ground.receiveShadow = true;
scene.scene.add(ground);
const grid = new THREE.GridHelper(40, 40, 0x3a362e, 0x2c2a26);
(grid.material as THREE.Material).transparent = true;
(grid.material as THREE.Material & { opacity: number }).opacity = 0.35;
scene.scene.add(grid);

/** The body cloth is tuned against. One, and a placeholder. */
let body: WorkbenchBody | null = null;

const clothTab = new ClothTab($('cloth-panel'), () => {
  // The workbench owns everything the body wears now: there is no generated
  // cape or robe underneath to hide while a custom one is being tuned.
});

function populate(): void {
  body?.dispose();
  body = new WorkbenchBody(scene.scene);
  clothTab.attach([body]);
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

$('in-light').addEventListener('change', () => {
  scene.applyLighting($<HTMLSelectElement>('in-light').value as LightingProfile);
});

$('in-clothfid').addEventListener('input', () => {
  const v = Number($<HTMLInputElement>('in-clothfid').value);
  clothTuning.fidelity = v;
  $('v-clothfid').textContent = `${v.toFixed(1)}×`;
});

$('in-clothiter').addEventListener('input', () => {
  const v = Number($<HTMLInputElement>('in-clothiter').value);
  clothTuning.solverIterations = v;
  $('v-clothiter').textContent = String(v);
});

// ---------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------

let last = performance.now();

function frame(): void {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const t = now / 1000;
  // ⚠ Wind is what a cape is judged on, so it keeps moving even though the
  // body does not: a cloth setting that only looks right in dead air is a
  // setting nobody can trust.
  const wind = 0.5 + Math.sin(t * 0.7) * 0.5;
  body?.update();
  clothTab.step(dt, wind, t);
  scene.render();
  requestAnimationFrame(frame);
}

populate();
scene.applyLighting('overcast');
frame();

/** Verification hook, as every page here has (D-114). */
(window as unknown as { __viewer: unknown }).__viewer = {
  body: () => body,
  bones: () => Object.keys(body?.bones() ?? {}),
  colliders: () => Object.keys(body?.colliderCatalog() ?? {}),
};
