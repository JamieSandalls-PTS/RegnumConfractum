import * as THREE from 'three';
import { generateAppearance, type Direction, type LightingProfile, type TransientAnim } from '@rc/shared';
import { GameScene } from './render/scene';
import { CharacterVisual } from './render/character';
import { clothTuning } from './render/cloth';
import { ClothTab } from './cloth-ui';

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
    reattachCloth();
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
  reattachCloth();
  $('seeds').textContent = seedList.join(' · ');
}

/** Rebuilding the cast orphans the lab garments; re-pin them to the new
 * bodies whenever the cloth tab is the one on screen. */
function reattachCloth(): void {
  const tab = document.querySelector<HTMLElement>('#tabs .tab.active');
  if (tab?.dataset.tab === 'cloth') clothTab.attach(shown.map((s) => s.visual));
}

function applyHoods(): void {
  const hooded = $<HTMLInputElement>('in-hood').checked;
  for (const s of shown) s.visual.setPresentation(hooded ? 'hooded' : 'normal');
}

function applyGear(): void {
  const gear = $<HTMLInputElement>('in-gear').checked;
  const weaponSel = $<HTMLSelectElement>('in-weapon').value;
  const robe = $<HTMLInputElement>('in-robe').checked && builtInRobe;
  for (const s of shown) {
    const a = s.visual.appearance;
    const base = gear
      ? { helm: a.helm, pauldrons: a.pauldrons, weapon: a.weapon, cape: a.hasCape && builtInCape }
      : { helm: false, pauldrons: false, weapon: false, cape: false };
    // The weapon selector overrides the seed: staff forces one into every
    // hand for review; none empties them.
    if (weaponSel === 'staff' || weaponSel === 'sword') base.weapon = true;
    if (weaponSel === 'none') base.weapon = false;
    // The cast animation is meaningless without something to cast with.
    if ($<HTMLSelectElement>('in-anim').value === 'cast') base.weapon = true;
    s.visual.setEquipment({
      ...base,
      // Casting needs a stave in hand whatever the weapon selector says.
      weaponKind: weaponSel === 'staff' || $<HTMLSelectElement>('in-anim').value === 'cast'
        ? 'staff'
        : 'sword',
      robe,
    });
    s.visual.setRenderLayer(1); // characters live on the pixel layer (split mode)
  }
}

// Lights and camera must reach BOTH layers for the split render.
scene.scene.traverse((o) => {
  if ((o as THREE.Light).isLight) o.layers.enableAll();
});
scene.camera.layers.enableAll();

// --- Tabs -------------------------------------------------------------------
// One live scene; each tab is a different group of controls over it. The
// cloth tab additionally suppresses the built-in garment it stands in for,
// so what you tune is the only one on the body.

/** The cloth tab hides the character's own cape/robe while it is driving one. */
let builtInCape = true;
let builtInRobe = true;

const clothTab = new ClothTab($('cloth-panel'), (cape, robe) => {
  if (builtInCape === cape && builtInRobe === robe) return;
  builtInCape = cape;
  builtInRobe = robe;
  applyGear();
});

function showTab(name: string): void {
  for (const btn of document.querySelectorAll<HTMLElement>('#tabs .tab')) {
    btn.classList.toggle('active', btn.dataset.tab === name);
  }
  for (const sec of document.querySelectorAll<HTMLElement>('#panel section[data-panel]')) {
    sec.classList.toggle('hidden', sec.dataset.panel !== name);
  }
  // Entering the cloth tab pins the lab garment to whoever is on stage;
  // leaving it hands the body back to its own clothes.
  if (name === 'cloth') clothTab.attach(shown.map((s) => s.visual));
  else {
    clothTab.dispose();
    if (!builtInCape || !builtInRobe) {
      builtInCape = true;
      builtInRobe = true;
      applyGear();
    }
  }
}

for (const btn of document.querySelectorAll<HTMLElement>('#tabs .tab')) {
  btn.addEventListener('click', () => showTab(btn.dataset.tab!));
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
$('in-weapon').addEventListener('change', applyGear);
// Picking the cast animation has to put a staff in hand (see applyGear).
$('in-anim').addEventListener('change', applyGear);
$('in-robe').addEventListener('change', applyGear);
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
let downAt = { x: 0, y: 0 };
stage.addEventListener('pointerdown', (e) => { downAt = { x: e.clientX, y: e.clientY }; });
window.addEventListener('pointerup', (e) => {
  dragging = false;
  // Click (not drag) on the model with the editor open = pick that part;
  // ctrl-click toggles it into the group (stakeholder request).
  if (editorEl.classList.contains('hidden')) return;
  if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) return;
  const rect = stage.getBoundingClientRect();
  if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) return;
  // Screen-space pick (the raycaster proved unreliable against this ortho
  // setup — see round 11): project every part's centre, take the nearest.
  const wp = new THREE.Vector3();
  let idx = -1;
  let bestPx = 28;
  for (let i = 0; i < editParts.length; i++) {
    const q = editParts[i]!;
    if (!q.mesh.visible) continue;
    q.mesh.getWorldPosition(wp).project(scene.camera);
    const sx = rect.left + ((wp.x + 1) / 2) * rect.width;
    const sy = rect.top + ((1 - wp.y) / 2) * rect.height;
    const d = Math.hypot(sx - e.clientX, sy - e.clientY);
    if (d < bestPx) {
      bestPx = d;
      idx = i;
    }
  }
  if (idx < 0) return;
  if (e.ctrlKey) {
    if (editSelectedAll.includes(idx)) editSelectedAll = editSelectedAll.filter((x) => x !== idx);
    else editSelectedAll.push(idx);
  } else {
    editSelectedAll = [idx];
  }
  editSelected = idx;
  renderEditor();
});
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
const COMBAT_MODES = [
  'combat-idle', 'combat-walk', 'draw',
  'attack0', 'attack1', 'attack2', 'attack3', 'attack-cycle', 'cast',
  'death', 'death-collapse',
];
// The auto-cycle deliberately EXCLUDES death: a review pass that keeps
// dropping the whole cast on the floor is useless for judging anything
// else. It stays selectable on its own.
const CYCLE: string[] = [
  'idle', 'walk', 'sitting', 'kneeling', ...TRANSIENTS,
  ...COMBAT_MODES.filter((m) => m !== 'death'),
];
let cycleIndex = 0;
let cycleAt = 0;
let transientAt = 0;
/** Re-trigger clocks for the looping combat one-shots. */
let attackAt = 0;
let attackTurn = 0;
let deathAt = 0;
let lastDrivenMode = '';

function drive(mode: string, t: number): { moving: boolean } {
  const isTransient = (TRANSIENTS as string[]).includes(mode);
  const isAttack = mode.startsWith('attack') || mode === 'cast';
  // Picking a one-shot should play it NOW, not at the next loop boundary:
  // selecting "death" and watching nothing happen for four seconds reads
  // as a broken animation.
  const entered = mode !== lastDrivenMode;
  lastDrivenMode = mode;
  for (const s of shown) {
    if (mode === 'sitting' || mode === 'kneeling') s.visual.setPosture(mode);
    else s.visual.setPosture('standing');
    // Combat state drives the whole draw/stance/sheathe cycle, so every
    // combat mode asserts it — except the draw loop, which toggles it.
    if (mode !== 'draw' && mode !== 'death') {
      s.visual.setCombat(COMBAT_MODES.includes(mode));
    }
  }
  if (isTransient && t - transientAt > 1.7) {
    // Re-queue the one-shot so it repeats while selected.
    transientAt = t;
    for (const s of shown) s.visual.playTransients([mode as TransientAnim]);
  }
  if (mode === 'draw') {
    // Alternate in and out of combat so the reach-and-stow reads in full.
    const drawn = Math.floor(t / 2.6) % 2 === 0;
    for (const s of shown) s.visual.setCombat(drawn);
  }
  if (isAttack && (entered || t - attackAt > 1.25)) {
    attackAt = t;
    attackTurn++;
    const variant = mode === 'attack-cycle' || mode === 'cast'
      ? attackTurn % 4
      : Number(mode.slice(-1));
    for (const s of shown) s.visual.playAttack(variant, t);
  }
  if (mode === 'death' || mode === 'death-collapse') {
    // Replay the fall on a loop: go over, lie there, stand, fall again.
    // 'death' is struck down — a blow shoves the body over from a
    // direction; 'death-collapse' has nobody behind it and drops in place.
    if (entered || t - deathAt > 4.2) {
      deathAt = t;
      const struck = mode === 'death';
      for (const [i, s] of shown.entries()) {
        s.visual.setDead(false);
        s.visual.setCombat(false);
        // Vary the blow direction across the cast so the whole row does
        // not fall the same way — it reads as a volley, not a domino.
        const a = (i / Math.max(1, shown.length)) * Math.PI * 2;
        s.visual.playDeath(
          t,
          struck ? new THREE.Vector3(Math.sin(a), 0, Math.cos(a)).multiplyScalar(1.6) : undefined,
        );
      }
    }
  } else if (deathAt !== 0) {
    // Leaving the death mode must put everyone back on their feet.
    deathAt = 0;
    for (const s of shown) s.visual.setDead(false);
  }
  return { moving: mode === 'walk' || mode === 'combat-walk' };
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
  // The lab garment steps AFTER the body, so it pins to this frame's pose.
  clothTab.step(dt, wind, t);
  // Free-look camera (stakeholder request): full orbit including elevation,
  // pannable target, near-macro zoom. Lights/shadows still track the target.
  scene.follow(cam.target);
  scene.camera.position.set(
    cam.target.x + Math.cos(cam.az) * Math.cos(cam.el) * cam.dist,
    cam.target.y + Math.sin(cam.el) * cam.dist,
    cam.target.z + Math.sin(cam.az) * Math.cos(cam.el) * cam.dist,
  );
  scene.camera.lookAt(cam.target);
  const style = $<HTMLSelectElement>('in-style').value;
  if (style === 'raw') {
    scene.renderer.render(scene.scene, scene.camera);
  } else if (style === 'split') {
    scene.post.renderSplit(scene.renderer, scene.scene, scene.camera,
      $<HTMLInputElement>('in-envpal').checked);
  } else {
    scene.render(); // uniform and palette-full (full-res via pixelScale 1)
  }
}

// Cloth tuning (stakeholder: test "floppier" clothing). Fidelity changes the
// simulated grid, so the characters must be rebuilt; floppiness is a solver
// setting and takes hold on the very next step.
$('in-clothfid').addEventListener('input', () => {
  const v = Number($<HTMLInputElement>('in-clothfid').value);
  clothTuning.fidelity = v;
  $('v-clothfid').textContent = `${v.toFixed(1)}×`;
  populate(); // garments are built in the constructor
});
$('in-clothiter').addEventListener('input', () => {
  const v = Number($<HTMLInputElement>('in-clothiter').value);
  clothTuning.solverIterations = v;
  $('v-clothiter').textContent = String(v);
});

$('in-envscale').addEventListener('input', () => {
  scene.post.envPixelScale = Number($<HTMLInputElement>('in-envscale').value);
  scene.resize();
});
$('in-style').addEventListener('change', () => {
  const style = $<HTMLSelectElement>('in-style').value;
  scene.post.pixelScale = style === 'palette-full'
    ? 1
    : Number($<HTMLInputElement>('in-pixelscale').value);
  scene.resize();
});

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
  // Checkbox list (stakeholder: the multi-select jumped around): checking a
  // box adds to the group WITHOUT re-rendering; clicking a name makes that
  // part primary (sliders bind to it). Ctrl-click the 3D model also selects.
  const list = document.createElement('div');
  list.style.cssText = 'max-height:210px;overflow-y:auto;border:1px solid var(--line);padding:2px';
  for (let i = 0; i < editParts.length; i++) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:5px;align-items:center;font-size:11px;cursor:pointer;' +
      'line-height:1.35;padding:0 2px;white-space:nowrap;overflow:hidden;' +
      (i === editSelected ? 'color:#e8c88f' : '');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.style.cssText = 'margin:0;width:12px;height:12px;flex:none';
    cb.checked = editSelectedAll.includes(i);
    cb.addEventListener('click', (e) => {
      e.stopPropagation();
      if (cb.checked) editSelectedAll.push(i);
      else editSelectedAll = editSelectedAll.filter((x) => x !== i);
    });
    const nameEl = document.createElement('span');
    nameEl.textContent = editParts[i]!.name + (editParts[i]!.mesh.visible ? '' : ' (hidden)');
    row.append(cb, nameEl);
    row.addEventListener('click', () => {
      editSelected = i;
      if (!editSelectedAll.includes(i)) editSelectedAll.push(i);
      renderEditor();
    });
    list.appendChild(row);
    if (i === editSelected) setTimeout(() => row.scrollIntoView({ block: 'nearest' }), 0);
  }
  editorEl.appendChild(list);
  const hint = document.createElement('div');
  hint.className = 'drawer-title';
  hint.textContent = 'ctrl-click model = select · arrows nudge ALL checked (←→ X, ↑↓ Y, ctrl Z, shift ×5)';
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
  // Mirror (stakeholder request): copy every checked left/right part onto
  // its opposite-side twin, flipped across the body's centre plane.
  const mirror = document.createElement('button');
  mirror.textContent = 'Mirror to other side';
  mirror.addEventListener('click', () => {
    for (const i of editSelectedAll) {
      const q = editParts[i];
      if (!q) continue;
      const other = q.name.includes('left')
        ? q.name.replace(/left/g, 'right')
        : q.name.includes('right') ? q.name.replace(/right/g, 'left') : null;
      if (!other) continue;
      const twin = editParts.find((t) => t.name === other);
      if (!twin) continue;
      twin.mesh.position.set(-q.mesh.position.x, q.mesh.position.y, q.mesh.position.z);
      twin.mesh.scale.copy(q.mesh.scale);
      twin.mesh.rotation.set(q.mesh.rotation.x, -q.mesh.rotation.y, -q.mesh.rotation.z);
      twin.mesh.visible = q.mesh.visible;
    }
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
  row.append(hide, mirror, addSphere, addBox);
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
      view: (azimuthRad: number, zoom: number, orbitHeight?: number, targetY?: number) => void;
      pick: (fx: number, fy: number) => unknown;
      advance: (seconds: number) => void;
      shoot: (name: string) => Promise<string>;
      sheet: (name: string, style?: string) => Promise<string>;
      equip: (partial: Record<string, unknown>) => string;
      /** The live visuals, for state inspection during review. */
      visuals: () => CharacterVisual[];
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
    $<HTMLSelectElement>('in-style').value = on ? 'uniform' : 'raw';
    if (scale) {
      scene.post.pixelScale = scale;
      scene.resize();
    }
  },
  view(azimuthRad, zoom, orbitHeight, targetY) {
    cam.az = azimuthRad;
    viewerZoom = zoom;
    scene.setZoom(zoom);
    if (orbitHeight !== undefined) cam.el = Math.atan2(orbitHeight, 12.7);
    if (targetY !== undefined) cam.target.y = targetY; // frame heads close up
  },
  advance(seconds) {
    const steps = Math.max(1, Math.round(seconds * 60));
    for (let i = 0; i < steps; i++) stepViewer(1 / 60);
  },
  pick(fx: number, fy: number) {
    // Mirrors the click handler's screen-space pick, for automation tests.
    const rect = stage.getBoundingClientRect();
    const wp = new THREE.Vector3();
    let best = '';
    let bestPx = 28;
    for (const q of editParts) {
      if (!q.mesh.visible) continue;
      q.mesh.getWorldPosition(wp).project(scene.camera);
      const sx = ((wp.x + 1) / 2) * rect.width;
      const sy = ((1 - wp.y) / 2) * rect.height;
      const d = Math.hypot(sx - fx * rect.width, sy - fy * rect.height);
      if (d < bestPx) {
        bestPx = d;
        best = q.name;
      }
    }
    return best || 'no part within range';
  },
  async shoot(name) {
    stepViewer(1 / 60); // fresh render in this task so toDataURL sees pixels
    const canvas = scene.renderer.domElement;
    const url = canvas.toDataURL('image/png');
    await fetch(`http://127.0.0.1:8123/${name}`, { method: 'POST', body: url, mode: 'no-cors' });
    return `sent ${name} (${canvas.width}x${canvas.height})`;
  },
  visuals: () => shown.map((s) => s.visual),
  /** Automation: equipment override on every shown character. */
  equip(partial) {
    for (const s of shown) s.visual.setEquipment(partial as Parameters<typeof s.visual.setEquipment>[0]);
    return `equipped ${JSON.stringify(partial)} on ${shown.length}`;
  },
  /**
   * The 8-direction contact sheet (stakeholder workflow, 2026-08-17): one
   * PNG, columns = facings, rows = idle + four walk keyframes, captured at
   * a near-level camera like the Muybridge plates. Requires a soloed seed.
   */
  async sheet(name, style = 'raw') {
    if (!shown[0]) return 'solo a seed first';
    const visual = shown[0].visual;
    const styleSel = $<HTMLSelectElement>('in-style');
    const prevStyle = styleSel.value;
    styleSel.value = style;
    const animSel = $<HTMLSelectElement>('in-anim');
    const prevAnim = animSel.value;
    // Muybridge-level camera: azimuth fixed at the model's front, low
    // elevation, full body framed.
    window.__viewer!.view(Math.PI / 2, 0.24, 1.6, 0.85);
    window.__viewer!.advance(3.5); // physics settle: cloth starts at rest-local coords
    const dirs: Direction[] = ['s', 'se', 'e', 'ne', 'n', 'nw', 'w', 'sw'];
    const CELL = 220;
    // The bow row exists because bent poses caught three bugs the upright
    // rows never showed (colliders, cape bunching): review them always.
    const rowLabels = ['idle', 'walk ¼', 'walk ½', 'walk ¾', 'walk 4/4', 'bow'];
    const out = document.createElement('canvas');
    out.width = CELL * dirs.length;
    out.height = CELL * rowLabels.length;
    const ctx = out.getContext('2d')!;
    ctx.fillStyle = '#141318';
    ctx.fillRect(0, 0, out.width, out.height);
    const src = scene.renderer.domElement;
    const grab = (col: number, row: number) => {
      const side = Math.min(src.width, src.height);
      ctx.drawImage(src, (src.width - side) / 2, (src.height - side) / 2, side, side,
        col * CELL, row * CELL, CELL, CELL);
    };
    for (let c = 0; c < dirs.length; c++) {
      visual.setFacing(dirs[c]!);
      animSel.value = 'idle';
      window.__viewer!.advance(0.9); // turn + cloth settle
      grab(c, 0);
      animSel.value = 'walk';
      window.__viewer!.advance(0.8); // stride in
      for (let k = 0; k < 4; k++) {
        window.__viewer!.advance((2 * Math.PI / 3.7) / 4); // quarter walk cycle
        grab(c, 1 + k);
      }
      animSel.value = 'idle';
      window.__viewer!.advance(1.8); // settle, and let the bow re-queue
      animSel.value = 'bow';
      window.__viewer!.advance(0.75); // mid-bow
      grab(c, 5);
      animSel.value = 'idle';
    }
    ctx.fillStyle = '#d8d0c0';
    ctx.font = '13px monospace';
    dirs.forEach((d, c) => ctx.fillText(d.toUpperCase(), c * CELL + 6, 16));
    rowLabels.forEach((l, r) => ctx.fillText(l, 6, r * CELL + 32));
    animSel.value = prevAnim;
    styleSel.value = prevStyle;
    const url = out.toDataURL('image/png');
    await fetch(`http://127.0.0.1:8123/${name}`, { method: 'POST', body: url, mode: 'no-cors' });
    return `sheet ${name}: ${out.width}x${out.height} (${style})`;
  },
};
