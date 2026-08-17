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

/** When set, the grid collapses to this one seed at the origin. */
let soloSeed: number | null = null;

function populate(): void {
  for (const s of shown) s.visual.dispose();
  shown = [];
  if (soloSeed !== null) {
    const visual = new CharacterVisual(soloSeed, scene.scene);
    visual.setPosition(0, 0);
    visual.setFacing('s');
    shown.push({ visual, seed: soloSeed, phase: 0 });
    applyGear();
    applyHoods();
    $('seeds').textContent = `solo: ${soloSeed}`;
    return;
  }
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

// Free-look: drag orbits (yaw AND pitch), shift-drag pans the focus point,
// wheel zooms without the in-game clamp.
const cam = { az: Math.PI / 4, el: 0.59, dist: 15.3, target: new THREE.Vector3(0, 0.9, 0) };
let viewerZoom = 1;
let dragging = false;
let lastX = 0;
let lastY = 0;
stage.addEventListener('pointerdown', (e) => {
  dragging = true;
  lastX = e.clientX;
  lastY = e.clientY;
});
window.addEventListener('pointerup', () => { dragging = false; });
window.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const dx = e.clientX - lastX;
  const dy = e.clientY - lastY;
  lastX = e.clientX;
  lastY = e.clientY;
  if (e.shiftKey) {
    // Pan in the camera's screen plane, scaled by zoom so it stays 1:1-ish.
    const k = 0.0035 * viewerZoom;
    cam.target.x += (Math.sin(cam.az) * dx) * k;
    cam.target.z += (-Math.cos(cam.az) * dx) * k;
    cam.target.y += dy * k;
  } else {
    cam.az += dx * 0.008;
    cam.el = Math.min(1.5, Math.max(-0.2, cam.el + dy * 0.006));
  }
});
stage.addEventListener('wheel', (e) => {
  e.preventDefault();
  viewerZoom = Math.min(2.2, Math.max(0.02, viewerZoom * (e.deltaY > 0 ? 1.12 : 1 / 1.12)));
  scene.setZoom(viewerZoom);
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

function stepViewer(dt: number): void {
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
  // Free-look camera (stakeholder request): full orbit including elevation,
  // pannable target, near-macro zoom. Lights/shadows still track the target.
  scene.follow(cam.target);
  scene.camera.position.set(
    cam.target.x + Math.cos(cam.az) * Math.cos(cam.el) * cam.dist,
    cam.target.y + Math.sin(cam.el) * cam.dist,
    cam.target.z + Math.sin(cam.az) * Math.cos(cam.el) * cam.dist,
  );
  scene.camera.lookAt(cam.target);
  if ($<HTMLInputElement>('in-pixel').checked) {
    scene.render();
  } else {
    scene.renderer.render(scene.scene, scene.camera);
  }
}

function frame(): void {
  requestAnimationFrame(frame);
  const slow = $<HTMLInputElement>('in-slow').checked ? 0.5 : 1;
  stepViewer(Math.min(clock.getDelta(), 0.033) * slow);
}

populate();
frame();

// ---------------------------------------------------------------------------
// Model editor (stakeholder request, round 8): pick any mesh of a soloed
// character, nudge its position/scale, hide it, or add new primitives — then
// export the tweaks as JSON to paste back into the conversation. The export
// keys parts by their deterministic build order, so a tweak like
// "part 12: y +0.03" maps straight to a line of construction code.
// ---------------------------------------------------------------------------

interface PartRef {
  name: string;
  mesh: THREE.Mesh;
  base: {
    px: number; py: number; pz: number;
    sx: number; sy: number; sz: number;
    rx: number; ry: number; rz: number;
  };
}
let editParts: PartRef[] = [];
let editSelected = 0;
/** Multi-selection (stakeholder request): all of these nudge together. */
let editSelectedAll: number[] = [];
let addedCount = 0;
const editorEl = $('editor');

function collectParts(): void {
  editParts = [];
  const target = shown[0];
  if (!target) return;
  let i = 0;
  const seen = new Map<string, number>();
  target.visual.root.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      // Semantic names come from the construction code (nm() tags); repeats
      // like a limb's three segments get a numeric suffix.
      const base = o.name || o.geometry.type.replace('Geometry', '');
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      editParts.push({
        name: `#${String(i).padStart(2, '0')} ${base}${n > 1 ? ` (${n})` : ''}`,
        mesh: o,
        base: {
          px: o.position.x, py: o.position.y, pz: o.position.z,
          sx: o.scale.x, sy: o.scale.y, sz: o.scale.z,
          rx: o.rotation.x, ry: o.rotation.y, rz: o.rotation.z,
        },
      });
      i++;
    }
  });
}

function slider(label: string, min: number, max: number, step: number, value: number,
  onInput: (v: number) => void): HTMLElement {
  const row = document.createElement('div');
  row.className = 'sl';
  // Paired range + number inputs, kept in sync: drag for feel, type for
  // fine-tuning (stakeholder request).
  const num = document.createElement('input');
  num.type = 'number';
  num.step = String(step);
  num.value = value.toFixed(3);
  num.style.width = '62px';
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.addEventListener('input', () => {
    const v = Number(input.value);
    num.value = v.toFixed(3);
    onInput(v);
  });
  num.addEventListener('change', () => {
    const v = Number(num.value);
    if (!Number.isFinite(v)) return;
    input.value = String(v);
    onInput(v);
  });
  const tag = document.createElement('span');
  tag.textContent = label;
  tag.style.width = '64px';
  row.append(tag, input, num);
  return row;
}

function renderEditor(): void {
  editorEl.innerHTML = '';
  if (editParts.length === 0) {
    editorEl.textContent = 'Solo a seed first (button above).';
    return;
  }
  const select = document.createElement('select');
  select.multiple = true; // ctrl/shift-click to group parts (e.g. both breasts)
  select.size = 8;
  select.style.width = '100%';
  for (let i = 0; i < editParts.length; i++) {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = editParts[i]!.name + (editParts[i]!.mesh.visible ? '' : ' (hidden)');
    if (editSelectedAll.includes(i) || i === editSelected) opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener('change', () => {
    editSelectedAll = [...select.selectedOptions].map((o) => Number(o.value));
    editSelected = editSelectedAll[0] ?? 0;
    renderEditor();
  });
  editorEl.appendChild(select);
  const hint = document.createElement('div');
  hint.className = 'drawer-title';
  hint.textContent = 'arrows: nudge ALL selected (←→ X, ↑↓ Y, ctrl+↑↓ Z; shift = ×5)';
  editorEl.appendChild(hint);
  const part = editParts[Math.min(editSelected, editParts.length - 1)]!;
  // Flash the selected part so it can be found on screen.
  const m = part.mesh.material as THREE.MeshLambertMaterial;
  const orig = m.emissive.getHex();
  m.emissive.setHex(0xa04010);
  setTimeout(() => m.emissive.setHex(orig), 700);

  const p = part.mesh.position;
  const s = part.mesh.scale;
  editorEl.appendChild(slider('Pos X (left/right)', p.x - 0.25, p.x + 0.25, 0.002, p.x, (v) => { p.x = v; }));
  editorEl.appendChild(slider('Pos Y (up/down)', p.y - 0.25, p.y + 0.25, 0.002, p.y, (v) => { p.y = v; }));
  editorEl.appendChild(slider('Pos Z (fwd/back)', p.z - 0.25, p.z + 0.25, 0.002, p.z, (v) => { p.z = v; }));
  editorEl.appendChild(slider('Width (scale X)', 0.1, 3, 0.01, s.x, (v) => { s.x = v; }));
  editorEl.appendChild(slider('Height (scale Y)', 0.1, 3, 0.01, s.y, (v) => { s.y = v; }));
  editorEl.appendChild(slider('Depth (scale Z)', 0.1, 3, 0.01, s.z, (v) => { s.z = v; }));
  const r = part.mesh.rotation;
  const deg = (rad: number) => (rad * 180) / Math.PI;
  const rad = (d: number) => (d * Math.PI) / 180;
  editorEl.appendChild(slider('Rotate X (deg)', -180, 180, 1, deg(r.x), (v) => { r.x = rad(v); }));
  editorEl.appendChild(slider('Rotate Y (deg)', -180, 180, 1, deg(r.y), (v) => { r.y = rad(v); }));
  editorEl.appendChild(slider('Rotate Z (deg)', -180, 180, 1, deg(r.z), (v) => { r.z = rad(v); }));

  const row = document.createElement('div');
  row.className = 'row2';
  const hide = document.createElement('button');
  hide.textContent = part.mesh.visible ? 'Hide part' : 'Show part';
  hide.addEventListener('click', () => {
    part.mesh.visible = !part.mesh.visible;
    renderEditor();
  });
  const addSphere = document.createElement('button');
  addSphere.textContent = '+ sphere';
  const addBox = document.createElement('button');
  addBox.textContent = '+ box';
  const addShape = (geom: THREE.BufferGeometry) => {
    const mesh = new THREE.Mesh(geom, new THREE.MeshLambertMaterial({ color: 0xb5875a }));
    mesh.castShadow = true;
    part.mesh.parent!.add(mesh);
    mesh.position.copy(part.mesh.position);
    addedCount++;
    collectParts();
    editSelected = editParts.findIndex((q) => q.mesh === mesh);
    renderEditor();
  };
  addSphere.addEventListener('click', () => addShape(new THREE.SphereGeometry(0.06, 12, 9)));
  addBox.addEventListener('click', () => addShape(new THREE.BoxGeometry(0.1, 0.1, 0.1)));
  row.append(hide, addSphere, addBox);
  editorEl.appendChild(row);
  const row3 = document.createElement('div');
  row3.className = 'row2';
  const mk = (label: string, geom: () => THREE.BufferGeometry) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', () => addShape(geom()));
    return b;
  };
  row3.append(
    mk('+ capsule', () => new THREE.CapsuleGeometry(0.04, 0.1, 3, 8)),
    mk('+ cylinder', () => new THREE.CylinderGeometry(0.05, 0.05, 0.12, 12)),
    mk('+ cone', () => new THREE.CylinderGeometry(0.01, 0.06, 0.12, 12)),
  );
  editorEl.appendChild(row3);

  const exportBtn = document.createElement('button');
  exportBtn.textContent = 'Export tweaks (paste to Claude)';
  exportBtn.style.marginTop = '6px';
  const out = document.createElement('textarea');
  exportBtn.addEventListener('click', () => {
    const tweaks: Record<string, unknown> = { seed: shown[0]?.seed, added: addedCount };
    for (const q of editParts) {
      const d = {
        dpos: [q.mesh.position.x - q.base.px, q.mesh.position.y - q.base.py, q.mesh.position.z - q.base.pz],
        scale: [q.mesh.scale.x / q.base.sx, q.mesh.scale.y / q.base.sy, q.mesh.scale.z / q.base.sz],
        drotDeg: [q.mesh.rotation.x - q.base.rx, q.mesh.rotation.y - q.base.ry, q.mesh.rotation.z - q.base.rz]
          .map((v) => (v * 180) / Math.PI),
        hidden: !q.mesh.visible,
      };
      const changed = d.hidden || d.dpos.some((v) => Math.abs(v) > 1e-4) ||
        d.scale.some((v) => Math.abs(v - 1) > 1e-3) ||
        d.drotDeg.some((v) => Math.abs(v) > 0.1);
      if (changed) tweaks[q.name] = d;
    }
    out.value = JSON.stringify(tweaks, null, 1);
    out.select();
  });
  editorEl.appendChild(exportBtn);
  editorEl.appendChild(out);
}

$('btn-edit').addEventListener('click', () => {
  const seed = Number($<HTMLInputElement>('in-solo').value) || 1005;
  soloSeed = seed;
  populate();
  collectParts();
  editSelected = 0;
  editSelectedAll = [0];
  editorEl.classList.remove('hidden');
  renderEditor();
});

// Arrow-key nudging for the whole selection (stakeholder request): move a
// grouped set — both breasts, a full arm — in one gesture.
window.addEventListener('keydown', (e) => {
  if (editorEl.classList.contains('hidden')) return;
  if (document.activeElement instanceof HTMLInputElement) return;
  if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  e.preventDefault();
  const step = 0.004 * (e.shiftKey ? 5 : 1);
  for (const i of editSelectedAll) {
    const q = editParts[i];
    if (!q) continue;
    if (e.key === 'ArrowLeft') q.mesh.position.x -= step;
    if (e.key === 'ArrowRight') q.mesh.position.x += step;
    if (e.key === 'ArrowUp') (e.ctrlKey ? q.mesh.position.z -= step : q.mesh.position.y += step);
    if (e.key === 'ArrowDown') (e.ctrlKey ? q.mesh.position.z += step : q.mesh.position.y -= step);
  }
});

// ---------------------------------------------------------------------------
// Automation hook: lets headless review drive the viewer without rAF (the
// browser pane stops compositing when hidden) and post frames to a local
// receiver for inspection (D-503 technique). Not part of the product.
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    __viewer?: {
      solo: (seed: number | null) => void;
      setAnim: (mode: string) => void;
      setPixel: (on: boolean, scale?: number) => void;
      view: (azimuthRad: number, zoom: number, orbitHeight?: number) => void;
      advance: (seconds: number) => void;
      shoot: (name: string) => Promise<string>;
    };
  }
}

window.__viewer = {
  solo(seed) {
    soloSeed = seed;
    populate();
  },
  setAnim(mode) {
    $<HTMLSelectElement>('in-anim').value = mode;
  },
  setPixel(on, scale) {
    $<HTMLInputElement>('in-pixel').checked = on;
    if (scale) {
      scene.post.pixelScale = scale;
      scene.resize();
    }
  },
  view(azimuthRad, zoom, orbitHeight) {
    cam.az = azimuthRad;
    viewerZoom = zoom;
    scene.setZoom(zoom);
    if (orbitHeight !== undefined) cam.el = Math.atan2(orbitHeight, 12.7);
  },
  advance(seconds) {
    const steps = Math.max(1, Math.round(seconds * 60));
    for (let i = 0; i < steps; i++) stepViewer(1 / 60);
  },
  async shoot(name) {
    stepViewer(1 / 60); // fresh render in this task so toDataURL sees pixels
    const canvas = scene.renderer.domElement;
    const url = canvas.toDataURL('image/png');
    await fetch(`http://127.0.0.1:8123/${name}`, { method: 'POST', body: url, mode: 'no-cors' });
    return `sent ${name} (${canvas.width}x${canvas.height})`;
  },
};
