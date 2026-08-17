import * as THREE from 'three';
import { generateAppearance, type LightingProfile, type TransientAnim } from '@rc/shared';
import { GameScene } from './render/scene';
import { CharacterVisual } from './render/character';

/**
 * The character/animation viewer (stakeholder request, 2026-08-17): a page of
 * generated characters with every animation on demand, so the art-direction
 * verdict (D-406) can be given against living examples rather than argument.
 * Seeds are listed so any character on screen can be reproduced exactly.
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

const COLS = 4;
const ROWS = 3;
const SPACING = 2.4;
const COUNT = COLS * ROWS;

interface Shown {
  visual: CharacterVisual;
  seed: number;
  phase: number;
}
let shown: Shown[] = [];

function matchesFilter(seed: number, filter: string): boolean {
  if (filter === 'all') return true;
  const a = generateAppearance(seed);
  if (filter === 'female' || filter === 'male') return a.sex === filter;
  if (filter.startsWith('hair:')) return a.hairStyle === filter.slice(5);
  return true;
}

function populate(): void {
  for (const s of shown) s.visual.dispose();
  shown = [];
  const base = Number($<HTMLInputElement>('in-seed').value) || 0;
  const filter = $<HTMLSelectElement>('in-filter').value;
  const seedList: number[] = [];
  let candidate = base;
  while (seedList.length < COUNT && candidate < base + 100000) {
    if (matchesFilter(candidate, filter)) seedList.push(candidate);
    candidate++;
  }
  for (let i = 0; i < seedList.length; i++) {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const visual = new CharacterVisual(seedList[i]!, scene.scene);
    visual.setPosition((col - (COLS - 1) / 2) * SPACING, (row - (ROWS - 1) / 2) * SPACING);
    visual.setFacing('s');
    shown.push({ visual, seed: seedList[i]!, phase: i * 0.7 });
  }
  applyGear();
  applyHoods();
  $('seeds').textContent = seedList.join(' · ');
}

function applyHoods(): void {
  const hooded = $<HTMLInputElement>('in-hood').checked;
  for (const s of shown) s.visual.setPresentation(hooded ? 'hooded' : 'normal');
}

function applyGear(): void {
  const gear = $<HTMLInputElement>('in-gear').checked;
  for (const s of shown) {
    if (gear) {
      const a = s.visual.appearance;
      s.visual.setEquipment({ helm: a.helm, pauldrons: a.pauldrons, weapon: a.weapon, cape: a.hasCape });
    } else {
      s.visual.setEquipment({ helm: false, pauldrons: false, weapon: false, cape: false });
    }
  }
}

// --- Controls ---------------------------------------------------------------

$('btn-reroll').addEventListener('click', () => {
  $<HTMLInputElement>('in-seed').value = String(Math.floor(Math.random() * 1_000_000));
  populate();
});
$('in-seed').addEventListener('change', populate);
$('in-filter').addEventListener('change', populate);
$('in-hood').addEventListener('change', applyHoods);
$('in-gear').addEventListener('change', applyGear);
$('in-light').addEventListener('change', () => {
  scene.applyLighting($<HTMLSelectElement>('in-light').value as LightingProfile);
});
scene.applyLighting('overcast');
$('in-pixelscale').addEventListener('input', () => {
  // Stakeholder control over the pixelation degree: internal resolution is
  // stage-size / pixelScale, so 1 is near-native and 6 is very chunky.
  scene.post.pixelScale = Number($<HTMLInputElement>('in-pixelscale').value);
  scene.resize();
});

// Orbit + zoom, same feel as the game client.
let dragging = false;
let lastX = 0;
stage.addEventListener('pointerdown', (e) => {
  dragging = true;
  lastX = e.clientX;
});
window.addEventListener('pointerup', () => { dragging = false; });
window.addEventListener('pointermove', (e) => {
  if (dragging) {
    scene.rotateBy((e.clientX - lastX) * 0.008);
    lastX = e.clientX;
  }
});
stage.addEventListener('wheel', (e) => {
  e.preventDefault();
  scene.zoomBy(e.deltaY > 0 ? 1.12 : 1 / 1.12);
}, { passive: false });

// --- Animation driving ------------------------------------------------------

const TRANSIENTS: TransientAnim[] = ['bow', 'wave', 'laugh', 'point', 'shrug'];
const CYCLE: string[] = ['idle', 'walk', 'sitting', 'kneeling', ...TRANSIENTS];
let cycleIndex = 0;
let cycleAt = 0;
let transientAt = 0;

function drive(mode: string, t: number): { moving: boolean } {
  const isTransient = (TRANSIENTS as string[]).includes(mode);
  for (const s of shown) {
    if (mode === 'sitting' || mode === 'kneeling') s.visual.setPosture(mode);
    else s.visual.setPosture('standing');
  }
  if (isTransient && t - transientAt > 1.7) {
    // Re-queue the one-shot so it repeats while selected.
    transientAt = t;
    for (const s of shown) s.visual.playTransients([mode as TransientAnim]);
  }
  return { moving: mode === 'walk' };
}

const clock = new THREE.Clock();
let t = 0;
function frame(): void {
  requestAnimationFrame(frame);
  const slow = $<HTMLInputElement>('in-slow').checked ? 0.5 : 1;
  const dt = Math.min(clock.getDelta(), 0.033) * slow;
  t += dt;
  const wind = 0.25 + Math.sin(t * 0.13) * 0.12;

  let mode = $<HTMLSelectElement>('in-anim').value;
  if (mode === 'cycle') {
    if (t - cycleAt > 3.2) {
      cycleAt = t;
      cycleIndex = (cycleIndex + 1) % CYCLE.length;
    }
    mode = CYCLE[cycleIndex]!;
  }
  const { moving } = drive(mode, t);

  for (const s of shown) s.visual.update(dt, t + s.phase, moving, wind);

  scene.updateCamera(dt);
  scene.follow(new THREE.Vector3(0, 0, 0));
  if ($<HTMLInputElement>('in-pixel').checked) {
    scene.render();
  } else {
    scene.renderer.render(scene.scene, scene.camera);
  }
}

populate();
frame();
