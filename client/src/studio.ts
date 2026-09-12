import { API } from './authoring-api';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  BODY_SLOTS,
  CHARACTER_SLOTS,
  SLOT_ALTERNATIVES,
  SLOT_REQUIRES,
  type CharacterDef,
  type CharacterSex,
  type CharacterSlot,
  preferredAtlas,
} from '@rc/shared';
import { GameScene } from './render/scene';
import { assemble } from './render/assembly';

/**
 * The character studio (D-558).
 *
 * Pick one part per slot, watch it walk, save the choice as content. The
 * three verbs the stakeholder asked for — define, view, store — with the
 * emphasis on the last: what is written is a small JSON document naming
 * parts, not a folder of copied meshes. The art is somebody else's and stays
 * out of git; the decision is ours and goes in.
 *
 * The preview assembles through the same `assemble()` the build uses, so
 * approving something here is approving what ships.
 */


const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const stage = $('stage');
const scene = new GameScene(stage);
scene.enableAllLayers();
// The stage is a flex child, so it has no size when the scene is
// constructed: the camera gets a zero aspect and the character lands off
// frame with only its shadow visible. Re-sizing on layout is the fix.
new ResizeObserver(() => scene.resize()).observe(stage);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(30, 30).rotateX(-Math.PI / 2),
  new THREE.MeshLambertMaterial({ color: 0x5c564c }),
);
ground.receiveShadow = true;
scene.scene.add(ground);
const grid = new THREE.GridHelper(30, 30, 0x3a362e, 0x2c2a26);
(grid.material as THREE.Material).transparent = true;
(grid.material as THREE.Material & { opacity: number }).opacity = 0.3;
scene.scene.add(grid);

interface CatalogueEntry {
  stem: string;
  sex: string;
  conceals: CharacterSlot[];
}

interface Catalogue {
  slots: Record<string, CatalogueEntry[]>;
  textures: string[];
}

const fbxLoader = new FBXLoader();
const gltfLoader = new GLTFLoader();
const texLoader = new THREE.TextureLoader();

/**
 * Fetched BYTES are cached, not parsed meshes.
 *
 * Caching the mesh and handing `.clone()` to the assembler shares one
 * skeleton across every copy, and the skinned result comes out degenerate
 * while the bounding box still measures correctly — visible only as a
 * character that does not draw. Re-parsing is cheap (a part is a few hundred
 * triangles) and makes the studio do exactly what the build does.
 */
const partBytes = new Map<string, ArrayBuffer>();
let catalogue: Catalogue = { slots: {}, textures: [] };
let pack = '';

/**
 * Which cut of the body this character is built from.
 *
 * This pack ships most parts twice and the two do not meet: a female forearm
 * on a male upper arm leaves a visible seam at the elbow. So the lists are
 * FILTERED rather than merely warned about — an option that cannot be used
 * should not be in the menu. Parts the pack cuts once (hair, pauldrons,
 * capes) are unisex and stay in both.
 */
function currentSex(): CharacterSex {
  return ($('in-sex') as HTMLSelectElement).value as CharacterSex;
}

/** The options for a slot that this body can actually wear. */
function optionsFor(slot: CharacterSlot): CatalogueEntry[] {
  const sex = currentSex();
  return (catalogue.slots[slot] ?? []).filter((o) => o.sex === 'any' || o.sex === sex);
}
let clips: THREE.AnimationClip[] = [];
let shown: { root: THREE.Object3D; mixer: THREE.AnimationMixer } | null = null;
let rebuildToken = 0;

function banner(text: string): void {
  $('banner').textContent = text;
}

async function partMesh(stem: string): Promise<THREE.SkinnedMesh> {
  const key = `${pack}/${stem}`;
  let buf = partBytes.get(key);
  if (!buf) {
    buf = await (
      await fetch(`${API}/packs/${pack}/fbx/${encodeURIComponent(stem)}`)
    ).arrayBuffer();
    partBytes.set(key, buf);
  }
  // `parse` consumes the buffer, so hand it a copy or the second use of a
  // cached part reads a detached ArrayBuffer.
  const group = fbxLoader.parse(buf.slice(0), '');
  let found: THREE.SkinnedMesh | null = null;
  group.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh && !found) found = o as THREE.SkinnedMesh;
  });
  if (!found) throw new Error(`${stem} has no skinned mesh`);
  return found;
}

/** The slot pickers' current state, in the order `assemble` wants. */
function chosenParts(): { slot: CharacterSlot; stem: string }[] {
  return CHARACTER_SLOTS.flatMap((slot) => {
    const stem = ($(`sel-${slot}`) as HTMLSelectElement).value;
    return stem ? [{ slot, stem }] : [];
  });
}

/**
 * Rebuild the preview.
 *
 * Guarded by a token because a person clicking through a 72-entry head list
 * fires far faster than the fetches return, and without it the last mesh to
 * arrive wins rather than the last one chosen.
 */
async function refresh(): Promise<void> {
  const token = ++rebuildToken;
  const chosen = chosenParts();
  markSlots();
  if (chosen.length === 0) {
    if (shown) scene.scene.remove(shown.root);
    shown = null;
    banner('nothing chosen');
    return;
  }

  banner('loading…');
  const meshes = await Promise.all(
    chosen.map(async (c) => ({ slot: c.slot, mesh: await partMesh(c.stem) })),
  );
  if (token !== rebuildToken) return;

  let built;
  try {
    built = assemble(meshes);
  } catch (e) {
    banner(`cannot assemble: ${(e as Error).message}`);
    return;
  }

  if (shown) scene.scene.remove(shown.root);
  // Source art is in centimetres. `assemble` leaves the hierarchy with fresh
  // world matrices, so the new scale has to be forced through — otherwise
  // nothing is marked dirty, the group renders at 190 units, and the camera
  // ends up INSIDE the character: a large shadow and no visible surface.
  built.group.scale.setScalar(0.01);
  built.group.updateMatrixWorld(true);
  built.group.traverse((o) => {
    o.castShadow = true;
    o.receiveShadow = true;
  });
  applyTexture(built.group);
  scene.scene.add(built.group);

  const mixer = new THREE.AnimationMixer(built.group);
  shown = { root: built.group, mixer };
  playClip(($('in-clip') as HTMLSelectElement).value);

  const box = new THREE.Box3().setFromObject(built.group);
  frameToFit(box);
  // The verification hook this project uses elsewhere (`window.__rc`): the
  // studio is judged by eye, so it needs a way to be judged by measurement.
  (window as unknown as { __studio: unknown }).__studio = { scene, built, box };
  const verts = built.meshes.reduce((n, m) => n + m.geometry.attributes.position!.count, 0);
  // Say when a part had to be corrected. The pipeline is allowed to fix a
  // weighting fault in somebody else's art, but somebody choosing that part
  // should know it was faulty — a silent fix is a silent claim that the art
  // was fine.
  const repaired = built.repairs.length ? ` · repaired ${built.repairs.length} part` : '';
  banner(
    `${meshes.length} parts · ${verts} verts · ${(box.max.y - box.min.y).toFixed(2)}m${repaired}`,
  );
  if (built.repairs.length) console.warn(built.repairs.join('; '));
}

let texture: THREE.Texture | null = null;

function applyTexture(root: THREE.Object3D): void {
  if (!texture) return;
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mat = mesh.material as THREE.MeshStandardMaterial;
    mat.map = texture;
    mat.needsUpdate = true;
  });
}

async function loadTexture(stem: string): Promise<void> {
  if (!stem) {
    texture = null;
    return;
  }
  const tex = await texLoader.loadAsync(`${API}/packs/${pack}/tex/${encodeURIComponent(stem)}`);
  // The atlas is small and every UV island lands on one region; a bilinear
  // tap between two of them invents a colour the artist never chose.
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  texture = tex;
}

function playClip(name: string): void {
  if (!shown) return;
  const clip = clips.find((c) => c.name === name);
  if (!clip) return;
  shown.mixer.stopAllAction();
  shown.mixer.clipAction(clip).reset().play();
}

/** The part currently chosen in a slot, with what it hides. */
function chosenIn(slot: CharacterSlot): CatalogueEntry | undefined {
  const stem = ($(`sel-${slot}`) as HTMLSelectElement).value;
  if (!stem) return undefined;
  return (catalogue.slots[slot] ?? []).find((o) => o.stem === stem);
}

/**
 * Rebuild the pickers for a different body, keeping what still fits.
 *
 * Switching from male to female is not a reason to lose the cape and the
 * helmet crest — those are cut once and fit either. Only the parts that are
 * specifically the other body's are dropped.
 */
function applySex(): void {
  const keep = new Map<CharacterSlot, string>();
  for (const slot of CHARACTER_SLOTS) {
    const stem = ($(`sel-${slot}`) as HTMLSelectElement).value;
    if (stem && optionsFor(slot).some((o) => o.stem === stem)) keep.set(slot, stem);
  }
  buildSlotList();
  for (const [slot, stem] of keep) ($(`sel-${slot}`) as HTMLSelectElement).value = stem;
  void refresh();
}

/**
 * Which slots the current choice rules out, and why.
 *
 * Enforced by GREYING OUT rather than by refusing to save. A helmet crest
 * with nothing to mount on and hair under a closed helm both build perfectly
 * well — they are simply never seen — so a person clicking through the lists
 * would have no way of knowing they had wasted the choice. The picker itself
 * has to say so.
 */
function slotBlocks(): Map<CharacterSlot, string> {
  const chosen = CHARACTER_SLOTS.map((s) => chosenIn(s)).filter((p): p is CatalogueEntry =>
    Boolean(p),
  );
  const blocked = new Map<CharacterSlot, string>();

  for (const part of chosen) {
    for (const slot of part.conceals) blocked.set(slot, `hidden by ${part.stem}`);
  }
  for (const [slot, needs] of Object.entries(SLOT_REQUIRES) as [CharacterSlot, CharacterSlot][]) {
    if (!chosenIn(needs)) blocked.set(slot, `needs a ${needs}`);
  }
  return blocked;
}

/** Red-edge the required slots that are still empty; grey out the impossible. */
function markSlots(): void {
  const blocked = slotBlocks();
  for (const slot of CHARACTER_SLOTS) {
    const el = $(`slot-${slot}`);
    const sel = $(`sel-${slot}`) as HTMLSelectElement;
    const why = blocked.get(slot);
    // Clear it as well as disable it, or a part chosen before the helmet
    // went on would stay in the saved definition, invisible.
    if (why && sel.value) sel.value = '';
    sel.disabled = Boolean(why);
    el.classList.toggle('blocked', Boolean(why));
    el.classList.toggle('empty', sel.value === '');
    const note = el.querySelector('em');
    if (note) note.textContent = why ?? '';
  }

  const missing = (BODY_SLOTS as readonly CharacterSlot[]).filter((s) => {
    if (($(`sel-${s}`) as HTMLSelectElement).value) return false;
    // A helmed head IS the head, so it fills the slot.
    const instead = SLOT_ALTERNATIVES[s as keyof typeof SLOT_ALTERNATIVES];
    return !instead || !($(`sel-${instead}`) as HTMLSelectElement).value;
  });
  const box = $('problems');
  box.innerHTML = missing.length
    ? `<div class="bad">Missing: ${missing.join(', ')}</div>`
    : '<div class="good">Complete — every body slot filled.</div>';
  ($('btn-save') as HTMLButtonElement).disabled = missing.length > 0;
}

function buildSlotList(): void {
  const host = $('slotlist');
  host.replaceChildren();
  for (const slot of CHARACTER_SLOTS) {
    const required = (BODY_SLOTS as readonly string[]).includes(slot);
    const options = optionsFor(slot);
    const row = document.createElement('div');
    row.className = `slot${required ? ' required' : ''}`;
    row.id = `slot-${slot}`;
    row.innerHTML =
      `<span>${slot}${required ? ' <b>*</b>' : ''}<i>${options.length}</i></span>` +
      `<em></em>`;
    const sel = document.createElement('select');
    sel.id = `sel-${slot}`;
    sel.add(new Option(required ? '— none —' : '— none —', ''));
    for (const o of options) {
      sel.add(new Option(o.sex === 'any' ? o.stem : `${o.stem}`, o.stem));
    }
    sel.onchange = () => void refresh();
    row.appendChild(sel);
    host.appendChild(row);
  }
}

/** A complete, plausible character, for getting started or shaking out slots. */
function randomise(): void {
  // The body is a choice like any other, so rolling a character rolls it —
  // and everything below reads the picker rather than a local.
  const sexSel = $('in-sex') as HTMLSelectElement;
  sexSel.value = Math.random() < 0.5 ? 'male' : 'female';
  buildSlotList();
  // Decide the head first — bare or helmed — because everything above the
  // neck depends on the answer, and rolling hair before the helmet means
  // throwing the hair away again.
  const helmed = Math.random() < 0.3;
  for (const slot of CHARACTER_SLOTS) {
    const sel = $(`sel-${slot}`) as HTMLSelectElement;
    sel.value = '';
    const pool = optionsFor(slot);
    if (pool.length === 0) continue;
    const required = (BODY_SLOTS as readonly string[]).includes(slot);
    if (slot === 'head' && helmed) continue;
    if (slot === 'helmet' && !helmed) continue;
    // Attachments are mostly absent on a real person; filling every one
    // produces a walking armoury rather than a character.
    if (!required && slot !== 'helmet' && Math.random() > 0.35) continue;
    sel.value = pool[Math.floor(Math.random() * pool.length)]!.stem;
  }
  // One pass to drop anything the head just made invisible, so the preview
  // and the saved definition agree with the pickers.
  markSlots();
  void refresh();
}

function currentDef(): CharacterDef {
  const parts: Record<string, string> = {};
  for (const { slot, stem } of chosenParts()) parts[slot] = stem;
  const texStem = ($('in-texture') as HTMLSelectElement).value;
  return {
    id: ($('in-id') as HTMLInputElement).value.trim(),
    name: ($('in-name') as HTMLInputElement).value.trim(),
    pack,
    sex: currentSex(),
    parts: parts as CharacterDef['parts'],
    ...(texStem ? { texture: texStem } : {}),
    ...(($('in-note') as HTMLTextAreaElement).value.trim()
      ? { note: ($('in-note') as HTMLTextAreaElement).value.trim() }
      : {}),
  };
}

async function save(): Promise<void> {
  const def = currentDef();
  const box = $('problems');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(def.id)) {
    box.innerHTML = '<div class="bad">Id must be lower-case letters, digits and dashes.</div>';
    return;
  }
  if (!def.name) {
    box.innerHTML = '<div class="bad">Give it a name.</div>';
    return;
  }
  const res = await fetch(`${API}/characters/${def.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(def),
  });
  const body = (await res.json()) as { problems?: string[]; issues?: unknown[]; error?: string };
  if (!res.ok) {
    const lines = body.problems ?? [body.error ?? 'refused'];
    box.innerHTML = lines.map((l) => `<div class="bad">${l}</div>`).join('');
    return;
  }
  box.innerHTML = `<div class="good">Saved content/characters/${def.id}.json</div>`;
  await loadSavedList(def.id);
}

async function loadSavedList(select = ''): Promise<void> {
  const saved = (await (await fetch(`${API}/characters`)).json()) as CharacterDef[];
  const sel = $('in-saved') as HTMLSelectElement;
  sel.replaceChildren();
  sel.add(new Option('— new character —', ''));
  for (const c of saved) sel.add(new Option(`${c.name} (${c.id})`, c.id));
  sel.value = select;
  (sel as HTMLSelectElement & { _saved?: CharacterDef[] })._saved = saved;
}

async function openSaved(id: string): Promise<void> {
  const sel = $('in-saved') as HTMLSelectElement & { _saved?: CharacterDef[] };
  const def = sel._saved?.find((c) => c.id === id);
  if (!def) return;
  if (def.pack !== pack) {
    ($('in-pack') as HTMLSelectElement).value = def.pack;
    await loadPack(def.pack);
  }
  ($('in-id') as HTMLInputElement).value = def.id;
  ($('in-name') as HTMLInputElement).value = def.name;
  // Before the slot lists are read: they are filtered by it.
  ($('in-sex') as HTMLSelectElement).value = def.sex;
  buildSlotList();
  ($('in-note') as HTMLTextAreaElement).value = def.note ?? '';
  ($('in-texture') as HTMLSelectElement).value = def.texture ?? '';
  await loadTexture(def.texture ?? '');
  for (const slot of CHARACTER_SLOTS) {
    ($(`sel-${slot}`) as HTMLSelectElement).value = def.parts[slot] ?? '';
  }
  await refresh();
}

async function loadPack(id: string): Promise<void> {
  pack = id;
  partBytes.clear();
  catalogue = (await (await fetch(`${API}/packs/${id}`)).json()) as Catalogue;
  buildSlotList();
  const texSel = $('in-texture') as HTMLSelectElement;
  texSel.replaceChildren();
  texSel.add(new Option('— none —', ''));
  for (const t of catalogue.textures) texSel.add(new Option(t, t));
  // ⚠ NOT the unlettered atlas: it is the markings-free cut, and against it
  // every head that carries war paint renders as a plain face (D-560).
  const base = preferredAtlas(catalogue.textures);
  texSel.value = base;
  await loadTexture(base);
  markSlots();
}

async function boot(): Promise<void> {
  let packList: { id: string }[];
  try {
    packList = (await (await fetch(`${API}/packs`)).json()) as { id: string }[];
  } catch {
    banner('studio api not running — npm run dev:studio');
    return;
  }
  if (packList.length === 0) {
    banner('no ingested packs with character parts in assets/source');
    return;
  }
  const packSel = $('in-pack') as HTMLSelectElement;
  for (const p of packList) packSel.add(new Option(p.id, p.id));
  await loadPack(packList[0]!.id);
  await loadSavedList();

  const anim = await gltfLoader.loadAsync('/models/animations-unreal-19qg3fd.glb').catch(() => null);
  clips = anim?.animations ?? [];
  const clipSel = $('in-clip') as HTMLSelectElement;
  for (const c of clips) clipSel.add(new Option(c.name, c.name));
  clipSel.value = clips.find((c) => c.name === 'walking')?.name ?? clips[0]?.name ?? '';
  if (clips.length === 0) clipSel.add(new Option('none built yet', ''));

  packSel.onchange = () => void loadPack(packSel.value);
  ($('in-sex') as HTMLSelectElement).onchange = () => applySex();
  clipSel.onchange = () => playClip(clipSel.value);
  ($('in-saved') as HTMLSelectElement).onchange = (e) =>
    void openSaved((e.target as HTMLSelectElement).value);
  ($('in-texture') as HTMLSelectElement).onchange = async (e) => {
    await loadTexture((e.target as HTMLSelectElement).value);
    if (shown) applyTexture(shown.root);
  };
  $('btn-random').onclick = () => randomise();
  $('btn-save').onclick = () => void save();

  randomise();
}

const zoom = $('in-zoom') as HTMLInputElement;
const spin = $('in-spin') as HTMLInputElement;
const angle = $('in-angle') as HTMLInputElement;
const speed = $('in-speed') as HTMLInputElement;
const mode = $('in-render') as HTMLSelectElement;
const clock = new THREE.Clock();
// Face-on is a quarter turn from the orbit's zero — the presets are named
// for what you SEE, so `Front` has to be the angle that shows a face.
let azimuth = Math.PI / 2;

/**
 * Zoom that puts a whole character on the stage.
 *
 * The default was a fixed 0.30, which frames a 1.8m figure at about a
 * quarter of the stage and framed the FIRST load so tightly that the camera
 * sat inside the character — all that reached the screen was its shadow, and
 * a preview that has to be zoomed by hand before it shows anything is a
 * preview nobody trusts. Deriving it from the measured box means a 2.4m
 * ogre and a child both arrive framed.
 *
 * The factor is measured off this camera, not argued from its elevation:
 * the orbit looks down, so a standing figure covers less of the frustum than
 * its own height.
 */
const ZOOM_PER_METRE = 0.105;

function frameToFit(box: THREE.Box3): void {
  const height = Math.max(0.4, box.max.y - box.min.y);
  const want = Math.min(Number(zoom.max), Math.max(Number(zoom.min), height * ZOOM_PER_METRE));
  zoom.value = want.toFixed(2);
}

/**
 * Turning the model is a control, not a console command.
 *
 * A walk cycle read from one fixed three-quarter angle hides a great deal —
 * a forearm rotated ninety degrees out looks, from the front, like an arm
 * held slightly oddly. Drag, the three preset views and a speed of zero are
 * all here so that judging an animation does not require taking a different
 * screenshot and hoping.
 */
let turning = false;
let lastX = 0;
stage.addEventListener('pointerdown', (e) => {
  turning = true;
  lastX = e.clientX;
  stage.classList.add('turning');
  stage.setPointerCapture(e.pointerId);
});
stage.addEventListener('pointermove', (e) => {
  if (!turning) return;
  spin.checked = false;
  setAngle(azimuth + (e.clientX - lastX) * 0.008);
  lastX = e.clientX;
});
const endTurn = (e: PointerEvent): void => {
  if (!turning) return;
  turning = false;
  stage.classList.remove('turning');
  stage.releasePointerCapture(e.pointerId);
};
stage.addEventListener('pointerup', endTurn);
stage.addEventListener('pointercancel', endTurn);
stage.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const next = Number(zoom.value) * (e.deltaY > 0 ? 1.12 : 0.89);
    zoom.value = String(Math.min(Number(zoom.max), Math.max(Number(zoom.min), next)));
  },
  { passive: false },
);

function setAngle(radians: number): void {
  azimuth = radians;
  const deg = ((((azimuth * 180) / Math.PI) % 360) + 360) % 360;
  angle.value = String(Math.round(deg));
  $('lbl-angle').textContent = `${Math.round(deg)}°`;
}

angle.oninput = () => {
  spin.checked = false;
  setAngle((Number(angle.value) * Math.PI) / 180);
};
for (const b of Array.from($('views').querySelectorAll('button'))) {
  b.onclick = () => {
    spin.checked = false;
    setAngle((Number((b as HTMLElement).dataset.deg) * Math.PI) / 180);
  };
}
speed.oninput = () => {
  $('lbl-speed').textContent = `${Number(speed.value).toFixed(2)}×`;
};

function frame(): void {
  const dt = clock.getDelta();
  if (spin.checked) setAngle(azimuth + dt * 0.35);
  scene.setAzimuth(azimuth);
  scene.setZoom(Number(zoom.value));
  scene.follow(new THREE.Vector3(0, 0, 0));
  // Speed zero holds the pose rather than stopping the loop, so the stage
  // still redraws while the model is turned around a frozen frame.
  shown?.mixer.update(dt * Number(speed.value));
  if (mode.value === 'raw') scene.renderer.render(scene.scene, scene.camera);
  else scene.render();
  requestAnimationFrame(frame);
}

void boot();
frame();
