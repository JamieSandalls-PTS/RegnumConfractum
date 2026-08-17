import * as THREE from 'three';
import {
  ARCHETYPES,
  SKIN_COLORS,
  HAIR_COLORS,
  ACCENT_COLORS,
  CLOTH_COLORS,
  describeAppearance,
  describeHooded,
  type Appearance,
  type ArchetypeName,
  type HairStyle,
  type LightingProfile,
  type TransientAnim,
} from '@rc/shared';
import { GameScene } from './render/scene';
import { CharacterVisual } from './render/character';

/**
 * The character creator (stakeholder request, 2026-08-17): every appearance
 * parameter on an explicit control with its numeric value visible, so the
 * stakeholder can push each slider until the model breaks and ratify the
 * real creation ranges. Standalone review tool for now — the in-game
 * creation flow adopts the ratified ranges later (UI milestone).
 *
 * Slider bounds here are deliberately WIDER than the archetype ranges in
 * shared/src/appearance.ts: range-finding is the point.
 */

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const stage = $('stage');
const scene = new GameScene(stage);

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

scene.scene.traverse((o) => {
  if ((o as THREE.Light).isLight) o.layers.enableAll();
});
scene.camera.layers.enableAll();
scene.applyLighting('overcast');

// --- The parameter state ----------------------------------------------------

/** Everything the creator drives, in one bag. Colours are numbers (0xrrggbb). */
const state = {
  sex: 'male' as 'male' | 'female',
  bust: 0.5,
  height: 1.75,
  bulk: 0.35,
  shoulder: 0.28,
  limb: 1.05,
  headScale: 1.0,
  archetype: 'soldier' as ArchetypeName,
  skin: SKIN_COLORS[0]!,
  hairStyle: 'crop' as HairStyle,
  hairLen: 0.3,
  hairColor: HAIR_COLORS[0]!,
  capeColor: ACCENT_COLORS[0]!,
  cloth: CLOTH_COLORS[0]!,
  seed: 1,
  // clothing
  robe: false,
  cape: false,
  helm: false,
  pauldrons: false,
  weapon: 'none' as 'none' | 'sword' | 'staff',
  hooded: false,
};

function toAppearance(): Appearance {
  return {
    seed: state.seed,
    archetype: state.archetype,
    height: state.height,
    bulk: state.bulk,
    shoulder: state.shoulder,
    limb: state.limb,
    headScale: state.headScale,
    hairLen: state.hairLen,
    hasCape: state.cape,
    capeColor: state.capeColor,
    skin: state.skin,
    cloth: state.cloth,
    metal: 0x9aa0a8,
    accent: state.capeColor,
    helm: state.helm,
    pauldrons: state.pauldrons,
    weapon: state.weapon !== 'none',
    sex: state.sex,
    hairStyle: state.hairStyle,
    hairColor: state.hairColor,
    bust: state.bust,
  };
}

let visual: CharacterVisual | null = null;

function rebuild(): void {
  visual?.dispose();
  visual = new CharacterVisual(toAppearance(), scene.scene);
  visual.setPosition(0, 0);
  visual.setFacing('s');
  visual.setRenderLayer(1);
  visual.setEquipment({
    helm: state.helm,
    pauldrons: state.pauldrons,
    weapon: state.weapon !== 'none',
    weaponKind: state.weapon === 'staff' ? 'staff' : 'sword',
    cape: state.cape,
    robe: state.robe,
  });
  visual.setPresentation(state.hooded ? 'hooded' : 'normal');
  refreshDescriptor();
}

function refreshDescriptor(): void {
  const a = toAppearance();
  $('descriptor').textContent = state.hooded ? describeHooded(a) : describeAppearance(a);
}

// --- Control wiring ---------------------------------------------------------

/** A slider bound to a state key, with its live numeric readout. */
function bindSlider(id: string, key: keyof typeof state, fmt: (v: number) => string): void {
  const input = $<HTMLInputElement>(id);
  const readout = $(`v-${id.slice(3)}`);
  const apply = () => {
    const v = Number(input.value);
    (state as Record<string, unknown>)[key] = v;
    readout.textContent = fmt(v);
  };
  input.addEventListener('input', () => {
    apply();
    // Any manual body edit turns the preset select back to "custom".
    if (['height', 'bulk', 'shoulder', 'limb', 'headScale'].includes(key as string)) {
      $<HTMLSelectElement>('in-archetype').value = '';
    }
    rebuild();
  });
  apply();
}

const f2 = (v: number) => v.toFixed(2);
bindSlider('in-bust', 'bust', f2);
bindSlider('in-height', 'height', f2);
bindSlider('in-bulk', 'bulk', f2);
bindSlider('in-shoulder', 'shoulder', (v) => v.toFixed(3));
bindSlider('in-limb', 'limb', f2);
bindSlider('in-headscale', 'headScale', f2);
bindSlider('in-hairlen', 'hairLen', f2);
bindSlider('in-seed', 'seed', (v) => String(v));

/** Colour swatch row: fixed palette buttons + a free colour picker + hex readout. */
function bindSwatches(
  rowId: string,
  palette: readonly number[],
  key: 'skin' | 'hairColor' | 'capeColor' | 'cloth',
): void {
  const row = $(rowId);
  const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;
  const readout = document.createElement('span');
  const picker = document.createElement('input');
  picker.type = 'color';
  const setColor = (n: number) => {
    state[key] = n;
    readout.textContent = hex(n);
    picker.value = hex(n);
    for (const b of row.querySelectorAll('button')) {
      b.classList.toggle('active', Number(`0x${b.dataset.c}`) === n);
    }
    rebuild();
  };
  for (const c of palette) {
    const b = document.createElement('button');
    b.style.background = hex(c);
    b.dataset.c = c.toString(16).padStart(6, '0');
    b.title = hex(c);
    b.addEventListener('click', () => setColor(c));
    row.appendChild(b);
  }
  picker.addEventListener('input', () => setColor(parseInt(picker.value.slice(1), 16)));
  row.appendChild(picker);
  row.appendChild(readout);
  readout.textContent = hex(state[key]);
  picker.value = hex(state[key]);
  row.querySelector('button')?.classList.add('active');
}

bindSwatches('sw-skin', SKIN_COLORS, 'skin');
bindSwatches('sw-hair', HAIR_COLORS, 'hairColor');
bindSwatches('sw-cape', ACCENT_COLORS, 'capeColor');
bindSwatches('sw-cloth', CLOTH_COLORS, 'cloth');

$('in-sex').addEventListener('change', () => {
  state.sex = $<HTMLSelectElement>('in-sex').value as 'male' | 'female';
  $('row-bust').classList.toggle('hidden', state.sex !== 'female');
  rebuild();
});
$('row-bust').classList.toggle('hidden', state.sex !== 'female');

$('in-hairstyle').addEventListener('change', () => {
  state.hairStyle = $<HTMLSelectElement>('in-hairstyle').value as HairStyle;
  rebuild();
});

// Body type preset: snap the body sliders to the archetype's mid-range so
// each type is one click, then fine-tune from there.
$('in-archetype').addEventListener('change', () => {
  const name = $<HTMLSelectElement>('in-archetype').value as ArchetypeName | '';
  if (!name) return;
  state.archetype = name;
  const a = ARCHETYPES[name];
  const mid = (r: readonly [number, number]) => (r[0] + r[1]) / 2;
  const set = (id: string, v: number) => {
    $<HTMLInputElement>(id).value = String(v);
    $(`v-${id.slice(3)}`).textContent = v.toFixed(2);
  };
  state.height = mid(a.height); set('in-height', state.height);
  state.bulk = mid(a.bulk); set('in-bulk', state.bulk);
  state.shoulder = mid(a.shoulder); set('in-shoulder', state.shoulder);
  state.limb = mid(a.limb); set('in-limb', state.limb);
  state.headScale = mid(a.headScale); set('in-headscale', state.headScale);
  rebuild();
});

for (const [id, key] of [
  ['in-robe', 'robe'], ['in-cape', 'cape'], ['in-helm', 'helm'],
  ['in-pauldrons', 'pauldrons'], ['in-hood', 'hooded'],
] as const) {
  $(id).addEventListener('change', () => {
    state[key] = $<HTMLInputElement>(id).checked;
    rebuild();
  });
}
$('in-weapon').addEventListener('change', () => {
  state.weapon = $<HTMLSelectElement>('in-weapon').value as typeof state.weapon;
  rebuild();
});

$('in-light').addEventListener('change', () => {
  scene.applyLighting($<HTMLSelectElement>('in-light').value as LightingProfile);
});
$('in-style').addEventListener('change', () => {
  scene.post.pixelScale = Number($<HTMLInputElement>('in-pixelscale').value);
  scene.resize();
});
$('in-pixelscale').addEventListener('input', () => {
  const v = Number($<HTMLInputElement>('in-pixelscale').value);
  $('v-pixelscale').textContent = String(v);
  scene.post.pixelScale = v;
  scene.resize();
});
$('v-pixelscale').textContent = $<HTMLInputElement>('in-pixelscale').value;

$('btn-export').addEventListener('click', () => {
  const out = $<HTMLTextAreaElement>('export-out');
  out.value = JSON.stringify(
    { ...state, skin: `#${state.skin.toString(16)}`, hairColor: `#${state.hairColor.toString(16)}`,
      capeColor: `#${state.capeColor.toString(16)}`, cloth: `#${state.cloth.toString(16)}` },
    null, 1,
  );
  out.select();
  navigator.clipboard?.writeText(out.value).catch(() => { /* selection is enough */ });
});

// --- Camera (viewer's free-look) --------------------------------------------

const cam = { az: Math.PI / 2, el: 0.25, dist: 15.3, target: new THREE.Vector3(0, 0.95, 0) };
let zoom = 0.28;
scene.setZoom(zoom);
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
    const k = 0.0035 * zoom;
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
  zoom = Math.min(2.2, Math.max(0.02, zoom * (e.deltaY > 0 ? 1.12 : 1 / 1.12)));
  scene.setZoom(zoom);
}, { passive: false });

// --- Animation loop ---------------------------------------------------------

const TRANSIENTS: TransientAnim[] = ['bow', 'wave', 'laugh', 'point', 'shrug'];
const CYCLE: string[] = ['idle', 'walk', 'sitting', 'kneeling', ...TRANSIENTS];
let cycleIndex = 0;
let cycleAt = 0;
let transientAt = 0;
const clock = new THREE.Clock();
let t = 0;

function step(dt: number): void {
  t += dt;
  if (!visual) return;
  const wind = 0.25 + Math.sin(t * 0.13) * 0.12;
  let mode = $<HTMLSelectElement>('in-anim').value;
  if (mode === 'cycle') {
    if (t - cycleAt > 3.2) {
      cycleAt = t;
      cycleIndex = (cycleIndex + 1) % CYCLE.length;
    }
    mode = CYCLE[cycleIndex]!;
  }
  if (mode === 'sitting' || mode === 'kneeling') visual.setPosture(mode);
  else visual.setPosture('standing');
  if ((TRANSIENTS as string[]).includes(mode) && t - transientAt > 1.7) {
    transientAt = t;
    visual.playTransients([mode as TransientAnim]);
  }
  visual.update(dt, t, mode === 'walk', wind);
  scene.follow(cam.target);
  scene.camera.position.set(
    cam.target.x + Math.cos(cam.az) * Math.cos(cam.el) * cam.dist,
    cam.target.y + Math.sin(cam.el) * cam.dist,
    cam.target.z + Math.sin(cam.az) * Math.cos(cam.el) * cam.dist,
  );
  scene.camera.lookAt(cam.target);
  if ($<HTMLSelectElement>('in-style').value === 'raw') {
    scene.renderer.render(scene.scene, scene.camera);
  } else {
    scene.render();
  }
}

function frame(): void {
  requestAnimationFrame(frame);
  const slow = $<HTMLInputElement>('in-slow').checked ? 0.4 : 1;
  step(Math.min(clock.getDelta(), 0.033) * slow);
}

rebuild();
frame();

// --- Automation hook (screenshot loop, mirrors the viewer's) ----------------

declare global {
  interface Window {
    __creator?: {
      set: (partial: Partial<typeof state>) => string;
      get: () => typeof state;
      view: (azimuthRad: number, zoomLevel: number, orbitHeight?: number, targetY?: number) => void;
      advance: (seconds: number) => void;
      shoot: (name: string) => Promise<string>;
    };
  }
}

window.__creator = {
  set(partial) {
    Object.assign(state, partial);
    // Reflect into the DOM controls so the panel stays truthful.
    const setVal = (id: string, v: string | number) => {
      const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
      if (el) el.value = String(v);
    };
    setVal('in-sex', state.sex);
    setVal('in-hairstyle', state.hairStyle);
    setVal('in-weapon', state.weapon);
    for (const [id, key] of [
      ['in-bust', 'bust'], ['in-height', 'height'], ['in-bulk', 'bulk'],
      ['in-shoulder', 'shoulder'], ['in-limb', 'limb'], ['in-headscale', 'headScale'],
      ['in-hairlen', 'hairLen'], ['in-seed', 'seed'],
    ] as const) {
      setVal(id, state[key] as number);
      const r = document.getElementById(`v-${id.slice(3)}`);
      if (r) r.textContent = Number(state[key]).toFixed(2);
    }
    for (const [id, key] of [
      ['in-robe', 'robe'], ['in-cape', 'cape'], ['in-helm', 'helm'],
      ['in-pauldrons', 'pauldrons'], ['in-hood', 'hooded'],
    ] as const) {
      const el = document.getElementById(id) as HTMLInputElement | null;
      if (el) el.checked = state[key] as boolean;
    }
    $('row-bust').classList.toggle('hidden', state.sex !== 'female');
    rebuild();
    return JSON.stringify(state);
  },
  get: () => ({ ...state }),
  view(azimuthRad, zoomLevel, orbitHeight, targetY) {
    cam.az = azimuthRad;
    zoom = zoomLevel;
    scene.setZoom(zoomLevel);
    if (orbitHeight !== undefined) cam.el = Math.atan2(orbitHeight, 12.7);
    if (targetY !== undefined) cam.target.y = targetY;
  },
  advance(seconds) {
    const steps = Math.max(1, Math.round(seconds * 60));
    for (let i = 0; i < steps; i++) step(1 / 60);
  },
  async shoot(name) {
    step(1 / 60);
    const canvas = scene.renderer.domElement;
    const url = canvas.toDataURL('image/png');
    await fetch(`http://127.0.0.1:8123/${name}`, { method: 'POST', body: url, mode: 'no-cors' });
    return `sent ${name} (${canvas.width}x${canvas.height})`;
  },
};
