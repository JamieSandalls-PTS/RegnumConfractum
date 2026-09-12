import { API } from './authoring-api';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import {
  ACTION_GROUPS,
  ANIMATION_LAYERS,
  type GarmentDef,
  mirrorGarmentParts,
  type RecipeDef,
  type RoamerDef,
  type ObjectiveDef,
  type SoundCueDef,
  type EmoteLexicon,
  type Language,
  CRAFT_STATIONS,
  ARMOUR_MATERIALS,
  ATTRIBUTES,
  ATTRIBUTE_BASE,
  ATTRIBUTE_CREATION_POINTS,
  CLASS_ABILITIES,
  EQUIP_SLOTS,
  ITEM_CATEGORIES,
  MAX_LEVEL,
  type ItemTemplate,
  STANCES,
  type ClassDef,
  type SkillDef,
  type FeatDef,
  type SpellDef,
  type Action,
  type AnimationLayer,
  type AnimationSet,
  BODY_SLOTS,
  CHARACTER_SLOTS,
  CREATION_SLOTS,
  type CharacterSex,
  type CharacterSlot,
  type CreationSlot,
  type PartNames,
  type RaceDef,
  type SkinTone,
  VENDOR_SKIN_TONES,
  inheritedAnimations,
  markingSwap,
  missingActions,
  mirroredName,
  mirroredPart,
  assetAtlas,
  preferredAtlas,
  resolveAnimations,
  skinFraction,
  skinPalette,
  type MeshShelf,
} from '@rc/shared';
import {
  type AssetDef,
  type AssetFile,
  type AssetKind,
  type AssetPackCatalogue,
  type CharacterItem,
  STANCE_OPTIONS,
  assetMesh,
  blankAsset,
  guessScale,
  loadAssetCatalogue,
  loadAssetPacks,
  loadAssets,
  measure,
  nameFromMesh,
  saveAssets,
} from './creation-assets';
import { GameScene } from './render/scene';
import { assemble } from './render/assembly';

/**
 * The creation-rules tool (D-560).
 *
 * The studio (D-558) answers "which parts make this character". This answers
 * the different question the creation screen asks: which parts may a PLAYER
 * choose, what are they called when a player sees them, and what is a race.
 *
 * Two things drove the shape of it. First, nothing downstream can show a
 * filename — `SK_Chr_Head_Male_04` is the right name for a file and the
 * wrong name for a person — so naming comes before everything else and has
 * to be fast: 122 parts across the five creation slots, which is a lot of
 * typing if each one costs a click to reach.
 *
 * Second, the preview is not a luxury here. Naming a face without seeing it
 * is naming a filename, and curating a race's faces from a list of stems is
 * not curation. Both tabs share one preview and one assembler — the same
 * `assemble()` the build uses, so what is approved is what ships.
 */


const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/* ------------------------------------------------------------------ scene */

const stage = $('stage');
const scene = new GameScene(stage);
scene.enableAllLayers();
// Eye level, not the game's overhead orbit. `follow` looks 0.9 above the
// point it is given, so a focus at 0.72 puts the look-line through a face at
// about 1.6m, and an orbit height of 0.9 puts the CAMERA there too. Left at
// the game's 8.5 the camera stares down at the top of somebody's head, which
// is the one angle a face cannot be judged from.
scene.setOrbitHeight(0.9);
new ResizeObserver(() => scene.resize()).observe(stage);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(30, 30).rotateX(-Math.PI / 2),
  new THREE.MeshLambertMaterial({ color: 0x5c564c }),
);
ground.receiveShadow = true;
scene.scene.add(ground);

const fbxLoader = new FBXLoader();
const texLoader = new THREE.TextureLoader();

/** Fetched BYTES, not parsed meshes — see the note in the studio. */
const partBytes = new Map<string, ArrayBuffer>();
let shown: THREE.Object3D | null = null;
let texture: THREE.Texture | null = null;
let previewToken = 0;

/* ------------------------------------------------------------------ state */

interface CatalogueEntry {
  stem: string;
  sex: string;
  conceals: CharacterSlot[];
}
interface Catalogue {
  slots: Record<string, CatalogueEntry[]>;
  textures: string[];
}

let pack = '';
let catalogue: Catalogue = { slots: {}, textures: [] };
let names: PartNames = { pack: '', names: {}, tags: {} };
let races: RaceDef[] = [];
let tab: 'parts' | 'races' | 'animations' | 'unfiled' | AssetKind = 'parts';

/** Which slot the naming tab is showing, and which part is previewed. */
let namingSlot: CharacterSlot = 'head';
let namingSex: CharacterSex = 'male';
let previewed = '';

/** The race being edited, and the body it is previewed as. */
let editing: RaceDef | null = null;
let raceSex: CharacterSex = 'male';
/** Body slots the person has asked to see the garments of. */
const expandedSlots = new Set<CharacterSlot>();

function banner(text: string): void {
  $('banner').textContent = text;
}
function status(text: string, kind: '' | 'good' | 'bad' = ''): void {
  const el = $('status');
  el.textContent = text;
  el.className = `status ${kind}`;
}

/* ---------------------------------------------------------------- preview */

async function partMesh(stem: string): Promise<THREE.SkinnedMesh> {
  const key = `${pack}/${stem}`;
  let buf = partBytes.get(key);
  if (!buf) {
    buf = await (await fetch(`${API}/packs/${pack}/fbx/${encodeURIComponent(stem)}`)).arrayBuffer();
    partBytes.set(key, buf);
  }
  const group = fbxLoader.parse(buf.slice(0), '');
  let found: THREE.SkinnedMesh | null = null;
  group.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh && !found) found = o as THREE.SkinnedMesh;
  });
  if (!found) throw new Error(`${stem} has no skinned mesh`);
  return found;
}

/**
 * Show a face.
 *
 * Always a whole head, never a lone part: an eyebrow floating in space says
 * nothing about whether it is the right eyebrow. A part being previewed is
 * assembled ONTO a head so it can be judged where it will be worn.
 */
async function preview(stems: readonly string[]): Promise<void> {
  const token = ++previewToken;
  const wanted = stems.filter(Boolean);
  if (wanted.length === 0) {
    if (shown) scene.scene.remove(shown);
    shown = null;
    banner('nothing to show');
    return;
  }
  banner('loading…');
  let meshes;
  try {
    meshes = await Promise.all(
      wanted.map(async (stem) => ({ slot: stem, mesh: await partMesh(stem) })),
    );
  } catch (e) {
    banner((e as Error).message);
    return;
  }
  if (token !== previewToken) return;

  let built;
  try {
    built = assemble(meshes);
  } catch (e) {
    banner(`cannot assemble: ${(e as Error).message}`);
    return;
  }
  if (shown) scene.scene.remove(shown);
  built.group.scale.setScalar(0.01);
  built.group.updateMatrixWorld(true);
  built.group.traverse((o) => {
    o.castShadow = true;
    o.receiveShadow = true;
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && texture) {
      const mat = mesh.material as THREE.MeshStandardMaterial;
      mat.map = texture;
      mat.needsUpdate = true;
    }
  });
  scene.scene.add(built.group);
  shown = built.group;
  // The part being JUDGED, not the scaffolding it is standing in. Listing
  // eleven stems tells you nothing and hides the one that matters.
  banner(previewed || wanted[wanted.length - 1] || '');
  // Judged by eye, so it needs a way to be judged by measurement — the same
  // hook the game and the studio carry.
  (window as unknown as { __tool: unknown }).__tool = {
    scene,
    shown,
    box: new THREE.Box3().setFromObject(built.group),
    camera: scene.camera,
  };
}

/** The atlas as loaded, kept so a tone can be re-applied without re-fetching. */
let atlasImage: HTMLImageElement | null = null;

async function loadTextureFrom(pack2: string, stem: string): Promise<void> {
  const tex = await texLoader.loadAsync(
    `${API}/packs/${encodeURIComponent(pack2)}/tex/${encodeURIComponent(stem)}`,
  );
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  atlasImage = tex.image as HTMLImageElement;
  texture = tex;
}

async function loadTexture(stem: string): Promise<void> {
  if (!stem) {
    texture = null;
    atlasImage = null;
    return;
  }
  const tex = await texLoader.loadAsync(`${API}/packs/${pack}/tex/${encodeURIComponent(stem)}`);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  atlasImage = tex.image as HTMLImageElement;
  texture = tex;
}

/**
 * Repaint the atlas's skin in a chosen colour.
 *
 * Skin in this art is four flat colours, so this is four exact substitutions
 * over the whole image — no mask, no shader, no second texture to ship. It is
 * why a tone can be an RGB a person picks rather than one of the three files
 * the vendor happened to export.
 *
 * NEAREST filtering is what makes it safe: every UV island lands inside one
 * flat region, so replacing a colour cannot bleed into its neighbour.
 */
function applySkinTone(rgb: string | null, marking?: string): void {
  if (!atlasImage) return;
  if (!rgb && !marking) {
    void loadTexture(currentAtlas).then(() => repaint());
    return;
  }
  const w = atlasImage.naturalWidth || atlasImage.width;
  const h = atlasImage.naturalHeight || atlasImage.height;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;
  ctx.drawImage(atlasImage, 0, 0);
  const data = ctx.getImageData(0, 0, w, h);
  const px = data.data;

  const swaps = new Map<number, [number, number, number]>();
  // Markings are their own channel — no other part in the pack touches that
  // colour — so war paint recolours without disturbing skin, and skin
  // recolours without disturbing war paint.
  const all = [...(rgb ? skinPalette(rgb) : []), ...(marking ? [markingSwap(marking)] : [])];
  for (const { from, to } of all) {
    const f = parseInt(from.slice(1), 16);
    const t = parseInt(to.slice(1), 16);
    swaps.set(f, [(t >> 16) & 255, (t >> 8) & 255, t & 255]);
  }
  for (let i = 0; i < px.length; i += 4) {
    const key = (px[i]! << 16) | (px[i + 1]! << 8) | px[i + 2]!;
    const to = swaps.get(key);
    if (!to) continue;
    px[i] = to[0];
    px[i + 1] = to[1];
    px[i + 2] = to[2];
  }
  ctx.putImageData(data, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  texture = tex;
  repaint();
}

/** Push the current texture onto whatever is on the stage. */
function repaint(): void {
  shown?.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mat = mesh.material as THREE.MeshStandardMaterial;
    mat.map = texture;
    mat.needsUpdate = true;
  });
}

/** The parts of a slot this body can wear. */
function optionsFor(slot: CharacterSlot, sex: CharacterSex): CatalogueEntry[] {
  return (catalogue.slots[slot] ?? []).filter((o) => o.sex === 'any' || o.sex === sex);
}

/** A head to hang the part being judged on, matching the body it is cut for. */
function headFor(sex: CharacterSex): string {
  const heads = optionsFor('head', sex);
  return heads[0]?.stem ?? '';
}

/**
 * A plain body to judge a part against.
 *
 * The bare `_00` set — which sorts first in every slot, so this needs no
 * table of names. A pauldron floating in space says nothing about whether it
 * is the right pauldron; on a shoulder it does. For the face slots the body
 * would only be in the way, so those are previewed on a head alone.
 */
function mannequin(sex: CharacterSex): string[] {
  return BODY_SLOTS.flatMap((slot) => {
    const first = optionsFor(slot, sex)[0];
    return first ? [first.stem] : [];
  });
}

/** Is this slot judged on a face, or on a whole body? */
function isFaceSlot(slot: CharacterSlot): boolean {
  return (CREATION_SLOTS as readonly string[]).includes(slot);
}

/* ------------------------------------------------------------ parts tab */

/**
 * Naming, built for volume.
 *
 * Every part in the slot is a row with its name field already there, so
 * naming a hundred faces is a hundred keystrokes and no clicks. Enter moves
 * to the next row and previews it, which turns the whole job into: look,
 * type, Enter.
 */
function renderPartsList(): void {
  const host = $('list');
  const options = optionsFor(namingSlot, namingSex);
  const done = options.filter((o) => names.names[o.stem]).length;

  host.replaceChildren();
  const head = document.createElement('div');
  head.innerHTML =
    `<h1>Parts &amp; names</h1>` +
    `<div class="count">${done} of ${options.length} named in this slot</div>`;
  host.appendChild(head);

  const table = document.createElement('table');
  for (const [i, option] of options.entries()) {
    const tr = document.createElement('tr');
    tr.className = names.names[option.stem] ? 'named' : '';
    if (option.stem === previewed) tr.classList.add('on');
    const base = isBase(option.stem);
    const bare = bareness.get(option.stem);

    const mark = document.createElement('td');
    mark.style.cssText = 'width:34px;cursor:pointer;font-size:10px;text-align:right;padding-right:6px';
    mark.textContent = base ? '● base' : bare === undefined ? '' : `${Math.round(bare * 100)}%`;
    mark.style.color = base ? 'var(--good)' : 'var(--dim)';
    mark.title = 'Mark as a base body part — what character creation offers';
    mark.onclick = () => {
      setBase(option.stem, !isBase(option.stem));
      render();
    };

    const stem = document.createElement('td');
    stem.className = 'stem';
    // The file name stays visible. It is the wrong name for a player and the
    // right one for whoever has to find the file again.
    stem.textContent = option.stem.replace(/^SK_Chr_/, '');
    stem.title = option.stem;
    stem.onclick = () => showPart(option.stem);

    const cell = document.createElement('td');
    cell.className = 'name';
    const input = document.createElement('input');
    input.value = names.names[option.stem] ?? '';
    input.placeholder = 'in-game name';
    input.onfocus = () => showPart(option.stem);
    input.oninput = () => {
      const value = input.value.trim();
      if (value) names.names[option.stem] = value;
      else delete names.names[option.stem];
      tr.className = value ? 'named on' : 'on';
      markDirty();
    };
    input.onkeydown = (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const next = table.querySelectorAll('input')[i + 1] as HTMLInputElement | undefined;
      if (next) next.focus();
      else void save();
    };
    cell.appendChild(input);

    tr.append(mark, stem, cell);
    table.appendChild(tr);
  }
  host.appendChild(table);
}

function renderPartsSide(): void {
  const host = $('side');
  host.replaceChildren();
  const box = document.createElement('div');
  box.innerHTML = `
    <h1>Naming</h1>
    <label for="in-pack">Pack</label><select id="in-pack"></select>
    <label for="in-slot">Slot</label><select id="in-slot"></select>
    <label for="in-sex">Body</label>
    <select id="in-sex"><option value="male">male</option><option value="female">female</option></select>
    <label for="in-tex">Preview atlas</label><select id="in-tex"></select>
    <h2>Carry across</h2>
    <button id="btn-mirror">Mirror names to the other body</button>
    <div class="hint" style="border:0;padding-top:6px;margin-top:2px">
      A part's number IS its counterpart: <code>Torso_Female_12</code> shares
      0.96 of its texture islands with <code>Torso_Male_12</code> and 0.36
      with any other. Existing names are never overwritten.</div>
    <h2>Base body</h2>
    <button id="btn-base">Measure bare skin in this slot</button>
    <div id="base-note" class="hint" style="border:0;padding-top:6px;margin-top:2px"></div>
    <h2>Save</h2>
    <button id="btn-save" class="primary">Save names</button>
    <div id="problems"></div>
    <div class="hint">Type a name, press <b>Enter</b> for the next one. Names
      are written to <code>content/parts/</code> — the art stays out of git,
      what a player is told it is called goes in.</div>`;
  host.appendChild(box);

  const packSel = $('in-pack') as HTMLSelectElement;
  for (const p of packList) packSel.add(new Option(p, p));
  packSel.value = pack;
  packSel.onchange = () => void loadPack(packSel.value);

  // EVERY slot, not only the face. A torso still needs a name — it is what a
  // player is told they are wearing — and the creation screen is only one of
  // the readers. The ones a player picks at creation are marked, so the
  // distinction survives without hiding the rest.
  const slotSel = $('in-slot') as HTMLSelectElement;
  for (const slot of CHARACTER_SLOTS) {
    const n = optionsFor(slot, namingSex).length;
    if (n === 0) continue;
    const done = optionsFor(slot, namingSex).filter((o) => names.names[o.stem]).length;
    const mark = (CREATION_SLOTS as readonly string[]).includes(slot) ? '★ ' : '   ';
    slotSel.add(new Option(`${mark}${slot} — ${done}/${n}`, slot));
  }
  slotSel.value = namingSlot;
  slotSel.onchange = () => {
    namingSlot = slotSel.value as CharacterSlot;
    previewed = '';
    render();
  };

  const sexSel = $('in-sex') as HTMLSelectElement;
  sexSel.value = namingSex;
  sexSel.onchange = () => {
    namingSex = sexSel.value as CharacterSex;
    render();
  };

  const texSel = $('in-tex') as HTMLSelectElement;
  for (const t of catalogue.textures) texSel.add(new Option(t, t));
  texSel.value = currentAtlas;
  texSel.onchange = async () => {
    currentAtlas = texSel.value;
    await loadTexture(currentAtlas);
    if (previewed) showPart(previewed);
  };

  $('btn-save').onclick = () => void save();
  $('btn-mirror').onclick = () => mirrorNames();
  $('btn-base').onclick = () => void measureBareness();
  showBaseNote();
}

/** Preview one part, worn where it belongs so it can be judged in place. */
function showPart(stem: string): void {
  previewed = stem;
  let wanted: string[];
  if (namingSlot === 'head' || namingSlot === 'helmet') {
    wanted = [stem];
  } else if (isFaceSlot(namingSlot)) {
    wanted = [headFor(namingSex), stem];
  } else {
    // Swap the part INTO a plain body rather than adding it, or a torso is
    // previewed inside another torso and neither can be judged.
    const body = mannequin(namingSex).filter((s2) => {
      const part = (catalogue.slots[namingSlot] ?? []).some((o) => o.stem === s2);
      return !part;
    });
    wanted = [...body, stem];
  }
  frameFor(namingSlot);
  void preview(wanted);
  for (const tr of Array.from($('list').querySelectorAll('tr'))) {
    tr.classList.toggle('on', tr.querySelector('td.stem')?.getAttribute('title') === stem);
  }
}

/**
 * Carry every name across to the other body.
 *
 * The pairing is by number and it is measured, not assumed: a female torso
 * shares 0.96 of its UV islands with the male torso of the same number and
 * 0.36 with any other. Across every slot the pack cuts twice the figure is
 * 0.89 to 0.97, against controls of 0.13 to 0.36.
 *
 * Never overwrites. Somebody who has already named a part looked at it, and
 * a bulk operation that silently replaces considered work is one nobody dares
 * press twice.
 */
function mirrorNames(): void {
  let copied = 0;
  let skipped = 0;
  for (const [stem, name] of Object.entries(names.names)) {
    const twin = mirroredPart(stem);
    if (!twin) continue;
    // Only to a part the pack actually ships.
    const exists = CHARACTER_SLOTS.some((slot) =>
      (catalogue.slots[slot] ?? []).some((o) => o.stem === twin),
    );
    if (!exists) continue;
    if (names.names[twin]) {
      skipped++;
      continue;
    }
    names.names[twin] = mirroredName(name, /_Female_/i.test(twin) ? 'female' : 'male');
    copied++;
  }
  if (copied) markDirty();
  status(`mirrored ${copied} names${skipped ? `, left ${skipped} already named` : ''}`, copied ? 'good' : '');
  render();
}

/** How much skin each measured part shows, so a person can judge the edge. */
const bareness = new Map<string, number>();

/**
 * Measure how much of each part in this slot is bare skin.
 *
 * The pack does not label its nude parts and the distinction is the one that
 * matters for creation: a character is built from a body, everything else is
 * a garment belonging to an equippable item. Measured from the UVs — skin
 * occupies the bottom 0.31 of the atlas — rather than guessed from a number,
 * because `_00` being the bare one is a convention this pack happens to
 * follow and the next one may not.
 *
 * ⚠ It REPORTS rather than decides, and a torso is why. No torso in this pack
 * is fully bare: the nude one still has a waistband, so it measures around
 * two thirds and a threshold strict enough to exclude a shirt excludes it
 * too. The numbers go beside the parts and the mark is a person's to set —
 * a tool that quietly ruled the nude torso out would be wrong in the one slot
 * that matters most.
 */
async function measureBareness(): Promise<void> {
  const options = optionsFor(namingSlot, namingSex);
  for (const [i, option] of options.entries()) {
    status(`measuring ${i + 1} of ${options.length}…`);
    try {
      const mesh = await partMesh(option.stem);
      bareness.set(option.stem, skinFraction(mesh.geometry.getAttribute('uv')));
    } catch {
      // A part that will not parse is one the build would reject anyway.
    }
  }
  // Anything essentially all skin is marked without asking; the rest is
  // ranked and left to a person.
  let sure = 0;
  for (const option of options) {
    if ((bareness.get(option.stem) ?? 0) > 0.95) {
      setBase(option.stem, true);
      sure++;
    }
  }
  const ranked = options
    .filter((o) => !isBase(o.stem))
    .sort((a, b) => (bareness.get(b.stem) ?? 0) - (bareness.get(a.stem) ?? 0))[0];
  const hint = ranked
    ? ` Next barest: ${ranked.stem.replace(/^SK_Chr_/, '')} at ${Math.round((bareness.get(ranked.stem) ?? 0) * 100)}%.`
    : '';
  markDirty();
  status(`${sure} certainly bare in ${namingSlot}.${hint}`, 'good');
  render();
}

function isBase(stem: string): boolean {
  return (names.tags[stem] ?? []).includes('base');
}

/** The mark is a decision, so it is stored as a tag and survives renaming. */
function setBase(stem: string, on: boolean): void {
  const tags = new Set(names.tags[stem] ?? []);
  if (on) tags.add('base');
  else tags.delete('base');
  if (tags.size) names.tags[stem] = [...tags];
  else delete names.tags[stem];
  markDirty();
}

function showBaseNote(): void {
  const el = document.getElementById('base-note');
  if (!el) return;
  const marked = optionsFor(namingSlot, namingSex).filter((o) =>
    (names.tags[o.stem] ?? []).includes('base'),
  );
  el.textContent = marked.length
    ? `${marked.length} marked: ${marked.map((m) => m.stem.replace(/^SK_Chr_/, '')).join(', ')}`
    : 'Nothing marked. Bare parts are what creation offers; the rest are garments. ' +
      'Measuring shows a percentage beside each part — click it to mark one.';
}

/* ------------------------------------------------------------ races tab */

const EMPTY_RACE = (): RaceDef => ({
  id: '',
  name: '',
  description: '',
  pack,
  sexes: ['male', 'female'],
  height: { male: [1.7, 1.85], female: [1.6, 1.75] },
  skinTones: [],
  markings: [],
  parts: {},
  tags: [],
});

/**
 * Curating a race, one slot at a time.
 *
 * Every part in the slot is a chip; clicking one adds or removes it from
 * what this race offers, and hovering shows it on a face. Chips rather than
 * a multi-select because the whole job is comparing faces against each
 * other, and forty stems in a scrolling box is not a comparison.
 */
function renderRacesList(): void {
  const host = $('list');
  host.replaceChildren();
  const head = document.createElement('div');
  head.innerHTML = '<h1>Race &mdash; what it may look like</h1>';
  host.appendChild(head);

  if (!editing) {
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'Pick a race on the right, or start a new one.';
    host.appendChild(hint);
    return;
  }

  // EVERY slot, not only the face. Races are humanoid in this art because
  // that is all the art has, but a goblin or a golem is a different BODY and
  // the schema always allowed one — only this list did not.
  for (const slot of CHARACTER_SLOTS) {
    const face = (CREATION_SLOTS as readonly string[]).includes(slot);
    const all = optionsFor(slot, raceSex);
    if (all.length === 0) continue;
    const chosen = new Set(editing.parts[slot] ?? []);
    // Below the neck, offer the BARE parts by default. The rest are garments
    // and belong to equipment, so listing 29 torsos as things a race can be
    // would be offering a wardrobe as an ancestry — but a race whose body IS
    // a garment (a skeleton, a suit of armour) needs the full list, so it is
    // a toggle rather than a rule.
    const bare = all.filter((o) => (names.tags[o.stem] ?? []).includes('base') || chosen.has(o.stem));
    const showAll = face || expandedSlots.has(slot) || bare.length === 0;
    const options = showAll ? all : bare;
    const group = document.createElement('div');
    const heading = document.createElement('h2');
    heading.textContent = `${slot} — ${all.filter((o) => chosen.has(o.stem)).length} of ${options.length} offered`;
    group.appendChild(heading);
    if (!face && all.length > options.length) {
      const more = document.createElement('span');
      more.className = 'chip';
      more.textContent = `show all ${all.length} (garments)`;
      more.onclick = () => {
        expandedSlots.add(slot);
        render();
      };
      group.appendChild(more);
    }
    for (const option of options) {
      const chip = document.createElement('span');
      chip.className = `chip${chosen.has(option.stem) ? ' on' : ''}`;
      // The in-game name if it has one, the file stem if it does not, so an
      // unnamed part is visibly unfinished rather than quietly indistinct.
      const named = names.names[option.stem];
      chip.textContent = named ?? option.stem.replace(/^SK_Chr_/, '');
      if (!named) chip.classList.add('warn');
      chip.title = option.stem;
      chip.onclick = () => {
        const list = new Set(editing?.parts[slot] ?? []);
        if (list.has(option.stem)) list.delete(option.stem);
        else list.add(option.stem);
        if (editing) editing.parts[slot] = [...list];
        markDirty();
        render();
        showRaceFace(slot, option.stem);
      };
      chip.onmouseenter = () => showRaceFace(slot, option.stem);
      group.appendChild(chip);
    }
    host.appendChild(group);
  }
}

function showRaceFace(slot: CharacterSlot, stem: string): void {
  previewed = stem;
  frameFor(slot);
  // Below the neck a part is judged on a body, exactly as in the naming tab:
  // a torso hung under a floating head says nothing about how it sits.
  if (slot === 'head' || slot === 'helmet') {
    void preview([stem]);
  } else if ((CREATION_SLOTS as readonly string[]).includes(slot)) {
    void preview([headFor(raceSex), stem]);
  } else {
    const body = mannequin(raceSex).filter(
      (s2) => !(catalogue.slots[slot] ?? []).some((o) => o.stem === s2),
    );
    void preview([...body, stem]);
  }
}

function renderRacesSide(): void {
  const host = $('side');
  host.replaceChildren();
  const box = document.createElement('div');
  box.innerHTML = [
    '<h1>Races</h1>',
    '<label for="in-race">Open</label><select id="in-race"></select>',
    '<button id="btn-new">New race</button>',
    '<div id="race-form" class="hidden">',
    '<label for="r-id">Id</label><input id="r-id" placeholder="highland-folk" spellcheck="false">',
    '<label for="r-name">Name</label><input id="r-name" placeholder="Highland folk">',
    '<label for="r-desc">Description</label><textarea id="r-desc" rows="3"></textarea>',
    '<label for="r-sex">Previewing</label>',
    '<select id="r-sex"><option value="male">male</option><option value="female">female</option></select>',
    '<h2>Bodies</h2><div class="row">',
    '<label style="margin:0"><input type="checkbox" id="r-male" style="width:auto"> male</label>',
    '<label style="margin:0"><input type="checkbox" id="r-female" style="width:auto"> female</label>',
    '</div>',
    '<h2>Height (metres)</h2>',
    '<div class="row"><input id="r-mh0" type="number" step="0.01"><input id="r-mh1" type="number" step="0.01"><span style="color:var(--dim)">M</span></div>',
    '<div class="row" style="margin-top:4px"><input id="r-fh0" type="number" step="0.01"><input id="r-fh1" type="number" step="0.01"><span style="color:var(--dim)">F</span></div>',
    '<h2>Skin tones</h2><div id="r-tones"></div>',
    '<h2>Face markings</h2><div id="r-markings"></div>',
    '<button id="btn-save-race" class="primary">Save race</button>',
    '<div id="problems"></div>',
    '</div>',
    '<div class="hint">A race is a face, a stature and a set of skin tones.',
    ' &#9888; Not a body: in this art a torso and its clothing are the same',
    ' mesh, so there is no bare body to vary.</div>',
  ].join('');
  host.appendChild(box);

  const sel = $('in-race') as HTMLSelectElement;
  sel.add(new Option('- choose -', ''));
  for (const r of races) sel.add(new Option(`${r.name} (${r.id})`, r.id));
  sel.value = editing?.id ?? '';
  sel.onchange = () => {
    const found = races.find((r) => r.id === sel.value);
    editing = found ? structuredClone(found) : null;
    render();
  };
  $('btn-new').onclick = () => {
    editing = EMPTY_RACE();
    render();
  };
  if (!editing) return;
  $('race-form').classList.remove('hidden');

  const bind = (id: string, value: string, set: (v: string) => void): void => {
    const el = $(id) as HTMLInputElement;
    el.value = value;
    el.oninput = () => {
      set(el.value);
      markDirty();
    };
  };
  bind('r-id', editing.id, (v) => {
    if (editing) editing.id = v.trim();
  });
  bind('r-name', editing.name, (v) => {
    if (editing) editing.name = v;
  });
  bind('r-desc', editing.description, (v) => {
    if (editing) editing.description = v;
  });

  const sexSel = $('r-sex') as HTMLSelectElement;
  sexSel.value = raceSex;
  sexSel.onchange = () => {
    raceSex = sexSel.value as CharacterSex;
    render();
  };

  for (const sex of ['male', 'female'] as const) {
    const cb = $(`r-${sex}`) as HTMLInputElement;
    cb.checked = editing.sexes.includes(sex);
    cb.onchange = () => {
      if (!editing) return;
      const set = new Set(editing.sexes);
      if (cb.checked) set.add(sex);
      else set.delete(sex);
      editing.sexes = [...set];
      markDirty();
    };
  }

  const heights: [string, CharacterSex, 0 | 1][] = [
    ['r-mh0', 'male', 0],
    ['r-mh1', 'male', 1],
    ['r-fh0', 'female', 0],
    ['r-fh1', 'female', 1],
  ];
  for (const [id, sex, i] of heights) {
    const el = $(id) as HTMLInputElement;
    el.value = String(editing.height[sex]?.[i] ?? '');
    el.oninput = () => {
      if (!editing) return;
      const pair = [...(editing.height[sex] ?? [1.6, 1.8])] as [number, number];
      pair[i] = Number(el.value);
      editing.height[sex] = pair;
      markDirty();
    };
  }

  // A tone is a COLOUR, not one of three files. Each chip repaints the face
  // in front of you the moment you touch it, because a skin tone described in
  // hex is not a skin tone anybody can judge.
  const tones = $('r-tones');
  for (const tone of editing.skinTones) {
    const row = document.createElement('div');
    row.className = 'row';
    row.style.marginTop = '4px';

    const swatch = document.createElement('input');
    swatch.type = 'color';
    swatch.value = tone.rgb;
    swatch.style.flex = '0 0 34px';
    swatch.style.padding = '0';
    swatch.oninput = () => {
      tone.rgb = swatch.value;
      markDirty();
      applySkinTone(tone.rgb, editing?.markings[0]?.rgb);
    };

    const name = document.createElement('input');
    name.value = tone.name;
    name.placeholder = 'what a player calls it';
    name.oninput = () => {
      tone.name = name.value;
      // The id follows the name, so nothing has to be typed twice; a tone
      // already saved keeps whatever id it was saved under.
      tone.id = name.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || tone.id;
      markDirty();
    };

    const drop = document.createElement('button');
    drop.textContent = '×';
    drop.style.flex = '0 0 26px';
    drop.onclick = () => {
      if (!editing) return;
      editing.skinTones = editing.skinTones.filter((t) => t !== tone);
      markDirty();
      render();
    };

    row.onmouseenter = () => applySkinTone(tone.rgb, editing?.markings[0]?.rgb);
    row.append(swatch, name, drop);
    tones.appendChild(row);
  }

  const add = document.createElement('div');
  add.style.marginTop = '6px';
  for (const preset of VENDOR_SKIN_TONES) {
    // The three the artist chose, as starting points rather than as the only
    // options — they are the right place to start and the wrong place to stop.
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = `+ ${preset.name}`;
    chip.style.borderLeft = `6px solid ${preset.rgb}`;
    chip.onmouseenter = () => applySkinTone(preset.rgb, editing?.markings[0]?.rgb);
    chip.onclick = () => {
      if (!editing) return;
      const id = uniqueToneId(editing, preset.id);
      editing.skinTones = [...editing.skinTones, { ...preset, id } satisfies SkinTone];
      markDirty();
      render();
    };
    add.appendChild(chip);
  }
  const custom = document.createElement('span');
  custom.className = 'chip';
  custom.textContent = '+ pick a colour';
  custom.onclick = () => {
    if (!editing) return;
    const id = uniqueToneId(editing, 'tone');
    editing.skinTones = [...editing.skinTones, { id, name: id, rgb: '#c98f6a' }];
    markDirty();
    render();
  };
  add.appendChild(custom);
  tones.appendChild(add);

  renderMarkings();
  $('btn-save-race').onclick = () => void saveRace();
}

/**
 * Face markings, as a colour a race chooses.
 *
 * Twenty-eight of the 46 heads carry war paint, and it is the ONLY thing
 * separating some of them — two heads can share a silhouette and differ
 * entirely in what is painted on it. Making the colour a race's choice is
 * what turns that from an accident of the atlas into a decision.
 */
function renderMarkings(): void {
  const host = document.getElementById('r-markings');
  if (!host || !editing) return;
  host.replaceChildren();
  for (const mark of editing.markings) {
    const row = document.createElement('div');
    row.className = 'row';
    row.style.marginTop = '4px';
    const swatch = document.createElement('input');
    swatch.type = 'color';
    swatch.value = mark.rgb;
    swatch.style.flex = '0 0 34px';
    swatch.style.padding = '0';
    swatch.oninput = () => {
      mark.rgb = swatch.value;
      markDirty();
      applySkinTone(editing?.skinTones[0]?.rgb ?? '#ffccae', mark.rgb);
    };
    const name = document.createElement('input');
    name.value = mark.name;
    name.placeholder = 'what a player calls it';
    name.oninput = () => {
      mark.name = name.value;
      mark.id = name.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || mark.id;
      markDirty();
    };
    const drop = document.createElement('button');
    drop.textContent = '×';
    drop.style.flex = '0 0 26px';
    drop.onclick = () => {
      if (!editing) return;
      editing.markings = editing.markings.filter((m) => m !== mark);
      markDirty();
      render();
    };
    row.onmouseenter = () => applySkinTone(editing?.skinTones[0]?.rgb ?? '#ffccae', mark.rgb);
    row.append(swatch, name, drop);
    host.appendChild(row);
  }
  const add = document.createElement('span');
  add.className = 'chip';
  add.textContent = '+ a marking colour';
  add.onclick = () => {
    if (!editing) return;
    const taken = new Set(editing.markings.map((m) => m.id));
    let id = 'paint';
    for (let n = 2; taken.has(id); n++) id = `paint-${n}`;
    editing.markings = [...editing.markings, { id, name: id, rgb: '#4566a9' }];
    markDirty();
    render();
  };
  host.appendChild(add);
}

/** An id nothing else in this race is already using. */
function uniqueToneId(race: RaceDef, want: string): string {
  const taken = new Set(race.skinTones.map((t) => t.id));
  if (!taken.has(want)) return want;
  for (let n = 2; ; n++) if (!taken.has(`${want}-${n}`)) return `${want}-${n}`;
}

/* --------------------------------------------------------------- saving */

let dirty = false;
function markDirty(): void {
  dirty = true;
  status('unsaved changes', 'bad');
}

function showProblems(lines: readonly string[], ok: string): void {
  const box = document.getElementById('problems');
  if (!box) return;
  box.innerHTML = lines.length
    ? lines.map((l) => `<div class="bad">${l}</div>`).join('')
    : `<div class="good">${ok}</div>`;
}

async function save(): Promise<void> {
  const res = await fetch(`${API}/parts/${encodeURIComponent(pack)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(names),
  });
  const body = (await res.json()) as { problems?: string[]; error?: string; named?: number };
  if (!res.ok) {
    showProblems(body.problems ?? [body.error ?? 'refused'], '');
    return;
  }
  dirty = false;
  status(`saved ${body.named} names`, 'good');
  showProblems([], `Saved content/parts/${pack}.json`);
}

async function saveRace(): Promise<void> {
  if (!editing) return;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(editing.id)) {
    showProblems(['Id must be lower-case letters, digits and dashes.'], '');
    return;
  }
  const res = await fetch(`${API}/races/${encodeURIComponent(editing.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(editing),
  });
  const body = (await res.json()) as { problems?: string[]; error?: string; issues?: unknown[] };
  if (!res.ok) {
    const lines = body.problems ?? body.issues?.map((i) => JSON.stringify(i)) ?? [
      body.error ?? 'refused',
    ];
    showProblems(lines as string[], '');
    return;
  }
  dirty = false;
  status('race saved', 'good');
  showProblems([], `Saved content/races/${editing.id}.json`);
  await loadRaces();
  render();
}

/* ------------------------------------------------------------------ boot */

let packList: string[] = [];
let currentAtlas = '';

function render(): void {
  $('list').className = 'pane';
  if (section === 'classes') {
    renderClassList();
    renderClassSide();
    return;
  }
  if (section === 'items') {
    renderItemList();
    renderItemSide();
    return;
  }
  if (tab === 'parts') {
    renderPartsList();
    renderPartsSide();
  } else if (tab === 'races') {
    renderRacesList();
    renderRacesSide();
  } else if (tab === 'animations') {
    renderAnimationsList();
    renderAnimationsSide();
  } else {
    renderAssetList();
    renderAssetSide();
  }
  for (const b of Array.from($('tabs').querySelectorAll('button'))) {
    b.classList.toggle('on', (b as HTMLElement).dataset.tab === tab);
  }
}

async function loadRaces(): Promise<void> {
  races = (await (await fetch(`${API}/races`)).json()) as RaceDef[];
}

async function loadPack(id: string): Promise<void> {
  pack = id;
  partBytes.clear();
  catalogue = (await (await fetch(`${API}/packs/${id}`)).json()) as Catalogue;
  names = (await (await fetch(`${API}/parts/${encodeURIComponent(id)}`)).json()) as PartNames;
  // ⚠ NOT the unlettered atlas. It looks like the honest default — no
  // colourway suffix — and it is the markings-free cut: against it, the 28
  // heads that carry war paint sample plain skin and become indistinguishable
  // from the unmarked ones. That is what "many heads with no visible
  // difference" was.
  currentAtlas = preferredAtlas(catalogue.textures);
  await loadTexture(currentAtlas);
  render();
  const first = optionsFor(namingSlot, namingSex)[0];
  if (first) showPart(first.stem);
}

async function boot(): Promise<void> {
  let found: { id: string }[];
  try {
    found = (await (await fetch(`${API}/packs`)).json()) as { id: string }[];
  } catch {
    banner('authoring api not running - npm run dev:studio');
    return;
  }
  if (found.length === 0) {
    banner('no ingested packs in assets/source');
    return;
  }
  packList = found.map((p) => p.id);
  await loadRaces();
  await loadPack(packList[0]!);

  assetPacks = await loadAssetPacks();
  for (const b of Array.from($('sections').querySelectorAll('button'))) {
    b.addEventListener('click', () => {
      section = ((b as HTMLElement).dataset.section as Section) ?? 'core';
      applySection();
    });
  }
  for (const b of Array.from($('tabs').querySelectorAll('button'))) {
    b.addEventListener('click', () => {
      const next = ((b as HTMLElement).dataset.tab as typeof tab) ?? 'parts';
      tab = next;
      if (next === 'animations') {
        void loadAnimations().then(() => {
          void showAnimationBody();
          render();
        });
        return;
      }
      if (next !== 'parts' && next !== 'races') {
        // Each asset tab reads its own file, so switching tab reloads rather
        // than showing the previous kind's assets under a new heading.
        void loadAssetPack(assetPack || assetPacks[0] || '');
        return;
      }
      render();
    });
  }
  // Leaving with work unsaved is the one mistake this tool can make that
  // cannot be undone by looking at it again.
  window.addEventListener('beforeunload', (e) => {
    if (!dirty) return;
    e.preventDefault();
    e.returnValue = '';
  });
}

/* ---------------------------------------------------------------- camera */

let azimuth = Math.PI / 2;
let zoom = 0.09;
/**
 * Where the camera looks, and how far back.
 *
 * A face is judged at eye level and close; a body is judged whole. `follow`
 * looks 0.9 above the point it is given, so the focus is the target height
 * minus that, and the orbit height puts the camera on the same line.
 */
let focusY = 0.72;
let orbitH = 0.9;

function frameFor(slot: CharacterSlot): void {
  const face = isFaceSlot(slot) || slot === 'helmet' || slot === 'helmetCrest';
  focusY = face ? 0.72 : 0.05;
  orbitH = face ? 0.9 : 1.0;
  zoom = face ? 0.09 : 0.22;
  scene.setOrbitHeight(orbitH);
}
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
  azimuth += (e.clientX - lastX) * 0.008;
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
    // ⚠ The ceiling is 4, not 1. A single character never needed more than 1,
    // but a contact sheet of twelve is six metres wide and simply refused to
    // zoom out — the scroll wheel did nothing and it read as a broken camera.
    zoom = Math.min(4, Math.max(0.03, zoom * (e.deltaY > 0 ? 1.12 : 0.89)));
  },
  { passive: false },
);

const animClock = new THREE.Clock();

function frame(): void {
  // The mixer runs whatever tab is showing: a weapon parented to a bone only
  // moves because the bone does.
  const delta = animClock.getDelta();
  bodyMixer?.update(delta);
  for (const mixer of sheetMixers) mixer.update(delta);
  scene.setAzimuth(azimuth);
  scene.setZoom(zoom);
  // Faces are judged at eye level, not from the game's overhead orbit: this
  // tool is the one place somebody looks a character in the eye.
  scene.follow(new THREE.Vector3(0, focusY, 0));
  scene.renderer.render(scene.scene, scene.camera);
  requestAnimationFrame(frame);
}

/* ----------------------------------------------------------- asset tabs */

/**
 * Worn items, environment and pickups — one implementation, three tabs.
 *
 * The list is every mesh in the pack whose prefix suggests this kind; naming
 * one turns it into an asset. Selecting shows it, and for a worn item it
 * shows it IN THE HAND of a body, because a sword judged floating in space is
 * a sword whose grip nobody has checked.
 */
let assetPacks: string[] = [];
let assetPack = '';
let assetCat: AssetPackCatalogue = { meshes: [], textures: [] };
let assetFile: AssetFile | null = null;
let assetSel = '';
/** Measured extent of the selected mesh, in its own units. */
let assetSize = 0;

/**
 * A body to hang worn items on, and the bones it offers.
 *
 * ⚠ Built from the CHARACTER pack while the item comes from another — a
 * knights sword goes in a modular-hero hand — so the two packs meet here and
 * nowhere else. Cached, because assembling eleven parts per weapon would make
 * clicking down a list unbearable.
 */
let attachBody: { group: THREE.Object3D; bones: string[] } | null = null;
/** Whatever is currently hanging off that body, so it can be taken off again. */
let attachedItem: THREE.Object3D | null = null;
/** The asset mesh currently on the stage, whether on a body or on its own. */
let shownAssetObject: THREE.Object3D | null = null;

/**
 * How much one nudge moves a weapon (D-565).
 *
 * Per GROUP rather than one number for everything, because the three fields
 * are not in the same units and never want the same granularity: a centimetre
 * is a sensible offset step and a useless rotation step, and 5 degrees is a
 * sensible rotation step that would throw a weapon across the room as metres.
 */
type NudgeGroup = 'position' | 'rotation' | 'scale';
const NUDGE_STEPS: Record<NudgeGroup, readonly number[]> = {
  position: [0.001, 0.005, 0.01, 0.05, 0.1],
  rotation: [1, 5, 15, 45, 90],
  scale: [0.001, 0.005, 0.01, 0.1],
};
const nudgeStep: Record<NudgeGroup, number> = { position: 0.01, rotation: 5, scale: 0.01 };

/**
 * Move the weapon that is already on the body, without rebuilding anything.
 *
 * ⚠ `showAsset` re-PARSES the FBX and reassembles the preview, which is fine
 * once per click and hopeless on a scroll wheel — a fitting pass is hundreds
 * of small adjustments and every one of them would have cost a mesh parse.
 * This writes the three fields straight onto the object already parented to
 * the bone, so a nudge is a matrix update.
 */
function nudgeAttached(item: CharacterItem): boolean {
  const bone = attachedItem?.parent;
  if (!attachedItem || !bone) return false;
  // The same measured factor `showAsset` uses: a bind matrix can carry scale
  // of its own, so the item's stored offsets only mean metres after dividing
  // by what the bone actually is (D-563).
  const boneScale = new THREE.Vector3();
  bone.getWorldScale(boneScale);
  const factor = boneScale.x || 1;
  const t = item.transform;
  attachedItem.scale.setScalar(t.scale / factor);
  attachedItem.position.set(
    t.position[0] / factor,
    t.position[1] / factor,
    t.position[2] / factor,
  );
  attachedItem.rotation.set(
    (t.rotation[0] * Math.PI) / 180,
    (t.rotation[1] * Math.PI) / 180,
    (t.rotation[2] * Math.PI) / 180,
  );
  return true;
}

/** Keep the "as placed" reading honest while a scale is being scrolled. */
function refreshPlacedNote(item: CharacterItem): void {
  const note = document.getElementById('placed-note');
  if (note) {
    note.innerHTML =
      `Mesh measures <b>${assetSize.toFixed(2)}</b> in its own units, ` +
      `<b>${(assetSize * item.transform.scale * 100).toFixed(0)}cm</b> as placed. ` +
      '&#9888; Packs disagree: dungeon weapons are metres, knights and vikings centimetres.';
  }
}

/**
 * The built clips, and a mixer on the shared body.
 *
 * A weapon's offset cannot be judged on a T-pose. A sword that sits perfectly
 * in an outstretched hand can pass through the thigh at the bottom of a walk
 * cycle, and the only way to see that is to run the walk. So the preview body
 * animates, and the item — parented to a bone — comes along for the ride.
 */
let clipLibrary: THREE.AnimationClip[] = [];
let bodyMixer: THREE.AnimationMixer | null = null;
let bodyAction: THREE.AnimationAction | null = null;
let playingClip = '';

async function loadClipLibrary(): Promise<THREE.AnimationClip[]> {
  if (clipLibrary.length) return clipLibrary;
  try {
    const manifest = (await (await fetch('/models/manifest.json')).json()) as {
      outfits: { animations: string }[];
    };
    const file = manifest.outfits[0]?.animations;
    if (!file) return [];
    const gltf = await new GLTFLoader().loadAsync(`/models/${file}`);
    clipLibrary = gltf.animations;
  } catch {
    // No built models. The tool still works; there is simply nothing to play.
    clipLibrary = [];
  }
  return clipLibrary;
}

function playOnBody(name: string): void {
  playingClip = name;
  if (!bodyMixer) return;
  const clip = clipLibrary.find((c) => c.name === name);
  bodyAction?.fadeOut(0.2);
  if (!clip) {
    // The rest pose IS a choice: it is how a weapon's grip is checked, and
    // stopping the mixer without resetting leaves the last frame frozen,
    // which looks like a pose somebody chose.
    bodyMixer.stopAllAction();
    attachBody?.group.traverse((o) => {
      const b = o as THREE.Bone;
      if (b.isBone) b.updateMatrixWorld(true);
    });
    bodyAction = null;
    return;
  }
  const next = bodyMixer.clipAction(clip);
  next.reset().fadeIn(0.2).play();
  bodyAction = next;
}

/** The character pack's atlas, loaded once and kept apart from the item's. */
let characterTexture: THREE.Texture | null = null;
async function characterAtlas(): Promise<THREE.Texture | null> {
  if (characterTexture) return characterTexture;
  const want = preferredAtlas(catalogue.textures);
  if (!want) return null;
  try {
    const tex = await texLoader.loadAsync(
      `${API}/packs/${encodeURIComponent(pack)}/tex/${encodeURIComponent(want)}`,
    );
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    characterTexture = tex;
  } catch {
    characterTexture = null;
  }
  return characterTexture;
}

async function bodyToAttachTo(): Promise<{ group: THREE.Object3D; bones: string[] } | null> {
  if (attachBody) return attachBody;
  const wanted = mannequin('male');
  if (wanted.length === 0) return null;
  try {
    const meshes = await Promise.all(
      wanted.map(async (stem) => ({ slot: stem, mesh: await partMesh(stem) })),
    );
    const built = assemble(meshes);
    built.group.scale.setScalar(0.01);
    built.group.updateMatrixWorld(true);
    // The body wears the CHARACTER pack's atlas, not the item pack's. They
    // are different images with different layouts: painting a hero mesh from
    // the knights atlas samples whatever happens to sit at its UVs, which
    // comes out as a bleached mannequin.
    const bodyTexture = await characterAtlas();
    built.group.traverse((o) => {
      o.castShadow = true;
      o.receiveShadow = true;
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && bodyTexture) {
        const mat = mesh.material as THREE.MeshStandardMaterial;
        mat.map = bodyTexture;
        mat.needsUpdate = true;
      }
    });
    attachBody = {
      group: built.group,
      bones: built.skeleton.bones.map((b) => b.name).sort(),
    };
    await loadClipLibrary();
    bodyMixer = new THREE.AnimationMixer(built.group);
    bodyAction = null;
    if (playingClip) playOnBody(playingClip);
    return attachBody;
  } catch (e) {
    // Never silent. A body that fails to assemble leaves the item floating,
    // which looks like a framing choice rather than a failure.
    console.warn('could not build a body to attach to:', e);
    banner(`no body to attach to: ${(e as Error).message}`);
    return null;
  }
}

function assetKind(): AssetKind {
  // ⚠ The Unfiled shelf has no catalogue of its own: a mesh nobody has
  // classified is not yet a kind of thing. It borrows the environment file so
  // naming one there files it as scenery, which is what almost all of them
  // turn out to be — and the ones that are not get moved by hand, which is
  // D-568's ruling about the three oddities, not a new escape hatch.
  return tab === 'unfiled' ? 'environment' : (tab as AssetKind);
}

/** Which shelf the active tab shows. */
function assetShelf(): MeshShelf {
  return tab === 'unfiled' ? 'unfiled' : (tab as MeshShelf);
}

function assetOf(mesh: string): AssetDef | undefined {
  return assetFile?.assets.find((a: AssetDef) => a.mesh === mesh);
}

/**
 * The pack's own atlas.
 *
 * Each pack colours its meshes from its own texture — a knights sword is not
 * painted from the hero atlas — so the asset preview loads the one belonging
 * to the pack being browsed, not whatever the character tabs left loaded.
 */
async function loadAssetTexture(): Promise<void> {
  // ⚠ The SHARED resolver. This used to have its own rule and it disagreed
  // with the server's: the tool measured a sword's colours off one atlas and
  // painted it from another, so every swatch named a colour the mesh did not
  // contain and recolouring silently did nothing.
  const want = assetAtlas(assetCat.textures);
  if (!want || want === loadedAssetTexture) return;
  try {
    // ⚠ The ASSETPACKS route, not the character one: `/api/packs/:pack/tex`
    // only serves packs that ship character parts, so a weapon pack's atlas
    // 404'd here and the catch below hid it.
    const tex = await texLoader.loadAsync(
      `${API}/assetpacks/${encodeURIComponent(assetPack)}/tex/${encodeURIComponent(want)}`,
    );
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    atlasImage = tex.image as HTMLImageElement;
    texture = tex;
    loadedAssetTexture = want;
  } catch (e) {
    // Never silent: a missing atlas is why a sword comes out bleached.
    console.warn(`could not load atlas '${want}' for ${assetPack}:`, e);
    texture = null;
  }
}
let loadedAssetTexture = '';

async function loadAssetPack(id: string): Promise<void> {
  assetPack = id;
  assetCat = await loadAssetCatalogue(id);
  assetFile = await loadAssets(id, assetKind());
  assetSel = '';
  render();
  const first = assetCat.meshes.find((m) => m.shelf === assetShelf());
  if (first) void showAsset(first.stem);
}

async function showAsset(stem: string): Promise<void> {
  assetSel = stem;
  const token = ++previewToken;
  banner('loading…');
  let object: THREE.Object3D;
  try {
    object = await assetMesh(assetPack, stem);
  } catch (e) {
    banner((e as Error).message);
    return;
  }
  if (token !== previewToken) return;

  // Texture it, or every weapon is a black silhouette and no two are
  // distinguishable — the same failure the character atlas had.
  await loadAssetTexture();
  const size = measure(object);
  assetSize = Math.max(size.x, size.y, size.z);
  const asset = assetOf(stem);
  const scale =
    asset && 'transform' in asset ? asset.transform.scale : guessScale(assetSize);

  if (shown) scene.scene.remove(shown);
  const holder = new THREE.Group();
  object.traverse((o) => {
    o.castShadow = true;
    o.receiveShadow = true;
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && texture) {
      const mat = mesh.material as THREE.MeshStandardMaterial;
      mat.map = texture;
      mat.needsUpdate = true;
    }
  });

  const metres = assetSize * scale;
  let onBody = false;
  if (asset && asset.kind === 'character-item') {
    const body = await bodyToAttachTo();
    const bone = body?.group.getObjectByName(asset.attach);
    if (body && bone) {
      // ⚠ MEASURE the bone's world scale, never assume it. The body group is
      // scaled 0.01 because the art is centimetres, but a bone's bind matrix
      // can carry scale of its own, so the factor an item inherits is not
      // simply 0.01 — and getting it wrong by even a little makes a sword a
      // dot in a fist. Dividing by what the bone actually is makes the
      // item's stored offsets mean metres, whatever the rig does.
      const t = asset.transform;
      body.group.updateMatrixWorld(true);
      const boneScale = new THREE.Vector3();
      bone.getWorldScale(boneScale);
      const factor = boneScale.x || 1;
      object.scale.setScalar(scale / factor);
      object.position.set(
        t.position[0] / factor,
        t.position[1] / factor,
        t.position[2] / factor,
      );
      object.rotation.set(
        (t.rotation[0] * Math.PI) / 180,
        (t.rotation[1] * Math.PI) / 180,
        (t.rotation[2] * Math.PI) / 180,
      );
      // The body is CACHED and shared between previews, so the last item has
      // to come off before this one goes on. Without it a knight ends up
      // holding every weapon in the pack at once, each hidden inside the
      // next.
      if (attachedItem?.parent) attachedItem.parent.remove(attachedItem);
      attachedItem = object;
      bone.add(object);
      holder.add(body.group);
      onBody = true;
    }
  }
  if (!onBody) {
    object.scale.setScalar(scale);
    holder.add(object);
    holder.position.set(0, assetKind() === 'character-item' ? 1.1 : 0, 0);
  }
  scene.scene.add(holder);
  shown = holder;
  // ⚠ Kept so a recolour can find the ITEM rather than guessing which meshes
  // are it. Comparing `material.map` against the module's texture looked
  // equivalent and was not: the item's own mesh and the body it hangs on both
  // carry maps, and after one recolour the comparison stops matching at all.
  shownAssetObject = object;
  (window as unknown as { __tool: unknown }).__tool = {
    scene,
    shown,
    box: new THREE.Box3().setFromObject(holder),
    camera: scene.camera,
    item: object,
  };

  // Frame what is ACTUALLY there, measured, rather than at a fixed zoom.
  // A body in a T-pose is wider than it is tall and a weapon sits past the
  // end of an outstretched hand — a zoom chosen for the torso cuts off the
  // very thing being judged.
  const bounds = new THREE.Box3().setFromObject(holder);
  const extent = new THREE.Vector3();
  bounds.getSize(extent);
  const centre = new THREE.Vector3();
  bounds.getCenter(centre);
  // `follow` aims 0.9 above the point it is given, so a barrel on the floor
  // needs a negative focus or the camera stares at the air above it.
  focusY = centre.y - 0.9;
  orbitH = 0.9;
  // Derive the frustum from the camera rather than hard-coding it, so this
  // survives a change to either the constant or the aspect.
  const perZoom = scene.camera.top / Math.max(1e-6, zoom);
  const aspect = scene.camera.right / Math.max(1e-6, scene.camera.top);
  const wide = Math.max(extent.x, extent.z);
  const need = Math.max(extent.y / 2, wide / 2 / Math.max(0.1, aspect));
  zoom = Math.min(2, Math.max(0.05, (need / perZoom) * 1.25));
  scene.setOrbitHeight(orbitH);
  banner(`${stem}  ·  ${(metres * 100).toFixed(0)}cm as placed`);
  render();
}

function renderAssetList(): void {
  const host = $('list');
  host.replaceChildren();
  const shelf = assetShelf();
  const mine = assetCat.meshes.filter((m) => m.shelf === shelf);
  const named = mine.filter((m) => assetOf(m.stem)).length;
  const head = document.createElement('div');
  head.innerHTML =
    `<h1>${shelf.replace('-', ' ')}</h1>` +
    `<div class="count">${named} of ${mine.length} named in ${assetPack || '—'}</div>`;
  host.appendChild(head);

  const table = document.createElement('table');
  for (const [i, entry] of mine.entries()) {
    const asset = assetOf(entry.stem);
    const tr = document.createElement('tr');
    tr.className = asset ? 'named' : '';
    if (entry.stem === assetSel) tr.classList.add('on');

    const stem = document.createElement('td');
    stem.className = 'stem';
    stem.textContent = entry.stem.replace(/^S[MK]_/, '');
    stem.title = entry.stem;
    stem.onclick = () => void showAsset(entry.stem);

    const cell = document.createElement('td');
    cell.className = 'name';
    const input = document.createElement('input');
    input.value = asset?.name ?? '';
    // A draft from the filename, shown as a placeholder rather than filled
    // in: a hundred rows of accepted guesses look identical to a hundred
    // rows somebody actually read.
    input.placeholder = nameFromMesh(entry.stem);
    input.onfocus = () => void showAsset(entry.stem);
    input.oninput = () => {
      const value = input.value.trim();
      const had = Boolean(assetOf(entry.stem));
      upsertAsset(entry.stem, value);
      tr.className = value ? 'named on' : 'on';
      markDirty();
      // Naming a mesh is what CREATES the asset, so its properties appear the
      // moment it has a name. Waiting for a re-render leaves somebody typing
      // into a panel that has not noticed — and the PREVIEW has to run again
      // too, because until the asset existed there was no attach point to
      // hang it from and it was drawn floating on its own.
      if (had !== Boolean(assetOf(entry.stem))) {
        renderAssetProps();
        void showAsset(entry.stem);
      }
    };
    input.onkeydown = (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const next = table.querySelectorAll('input')[i + 1] as HTMLInputElement | undefined;
      if (next) next.focus();
      else void saveAssetFile();
    };
    cell.appendChild(input);
    tr.append(stem, cell);
    table.appendChild(tr);
  }
  host.appendChild(table);
  if (mine.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = `No ${shelf.replace('-', ' ')} meshes in this pack. Try another.`;
    host.appendChild(hint);
  }
}

/** Create, rename or drop the asset for a mesh. */
function upsertAsset(mesh: string, name: string): void {
  if (!assetFile) return;
  const existing = assetOf(mesh);
  if (!name) {
    assetFile.assets = assetFile.assets.filter((a: AssetDef) => a.mesh !== mesh);
    return;
  }
  if (existing) {
    existing.name = name;
    return;
  }
  const fresh = blankAsset(assetKind(), assetPack, mesh, guessScale(assetSize || 1));
  fresh.name = name;
  assetFile.assets = [...assetFile.assets, fresh];
}

function renderAssetSide(): void {
  const host = $('side');
  host.replaceChildren();
  const kind = assetKind();
  const box = document.createElement('div');
  box.innerHTML = [
    `<h1>${kind.replace('-', ' ')}</h1>`,
    '<label for="a-pack">Pack</label><select id="a-pack"></select>',
    '<div id="a-props"></div>',
    '<button id="a-save" class="primary">Save</button>',
    '<div id="problems"></div>',
    '<div class="hint">Type a name, press <b>Enter</b> for the next. Written to',
    ' <code>content/assets/</code>.</div>',
  ].join('');
  host.appendChild(box);

  const sel = $('a-pack') as HTMLSelectElement;
  for (const p of assetPacks) sel.add(new Option(p, p));
  sel.value = assetPack;
  sel.onchange = () => void loadAssetPack(sel.value);
  $('a-save').onclick = () => void saveAssetFile();

  // The contact sheet, on the tab that needs it. Only worn items are held, so
  // only worn items have a grip that can be wrong.
  if (kind === 'character-item') {
    const bar = document.createElement('div');
    bar.style.margin = '8px 0';
    const sheet = document.createElement('button');
    sheet.textContent = sheetOn ? 'Back to one item' : 'Contact sheet (12 at a time)';
    sheet.onclick = () => {
      sheetOn = !sheetOn;
      if (sheetOn) void showContactSheet().then(render);
      else if (assetSel) void showAsset(assetSel);
      else render();
    };
    bar.appendChild(sheet);
    if (sheetOn) {
      for (const [label, step] of [['prev', -1], ['next', 1]] as [string, number][]) {
        const b = document.createElement('button');
        b.textContent = label;
        b.style.marginLeft = '6px';
        b.onclick = () => {
          sheetPage += step;
          void showContactSheet();
        };
        bar.appendChild(b);
      }
      const play = document.createElement('select');
      play.style.marginTop = '6px';
      play.add(new Option('still (rest pose)', ''));
      for (const clip of clipLibrary) play.add(new Option(clip.name, clip.name));
      play.value = playingClip;
      play.onchange = () => {
        playingClip = play.value;
        void showContactSheet();
      };
      bar.appendChild(play);
    }
    box.appendChild(bar);
  }

  renderAssetProps();
}

/** The properties that differ per kind, for the selected asset. */
function renderAssetProps(): void {
  const host = document.getElementById('a-props');
  if (!host) return;
  host.replaceChildren();
  const asset = assetOf(assetSel);
  if (!asset) {
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = assetSel
      ? 'Naming it is what creates it. Type a name on the left and its attach ' +
        'point, offset and stance appear here.'
      : 'Pick a mesh on the left.';
    host.appendChild(hint);
    return;
  }

  const field = (label: string, el: HTMLElement): void => {
    const l = document.createElement('label');
    l.textContent = label;
    host.append(l, el);
  };
  /**
   * A number field you can scroll (D-565).
   *
   * Fitting a weapon by typing is the wrong shape of interaction: it is a
   * dozen small corrections in a row, each one judged by looking, and typing
   * breaks the loop every time. The wheel over the field steps it, the arrow
   * keys step it by the same amount, and shift/alt change the step for one
   * gesture without changing the setting.
   */
  const num = (
    value: number,
    set: (v: number) => void,
    group: NudgeGroup = 'position',
  ): HTMLInputElement => {
    const i = document.createElement('input');
    i.type = 'number';
    i.step = String(nudgeStep[group]);
    i.value = String(value);
    const decimals = group === 'rotation' ? 2 : 4;
    const commit = (v: number): void => {
      const rounded = Number(v.toFixed(decimals));
      i.value = String(rounded);
      set(rounded);
      // ⚠ A hand edit takes the item out of `fit:weapons`' reach for good.
      // The fitter places 163 weapons from one rule and re-runs to correct
      // itself, so without this the next run would quietly undo whatever
      // somebody just spent five minutes getting right.
      asset.tags = asset.tags.filter((t) => t !== 'auto-fit');
      markDirty();
      // Move what is already on the body if we can; only rebuild if we cannot.
      if (asset.kind === 'character-item' && nudgeAttached(asset)) {
        refreshPlacedNote(asset);
      } else {
        void showAsset(assetSel);
      }
    };
    i.oninput = () => commit(Number(i.value));
    i.addEventListener(
      'wheel',
      (e) => {
        // ⚠ Both, not just preventDefault: the stage's own wheel handler
        // zooms the camera, and a scroll that nudged the weapon AND flew the
        // camera backwards would be unusable.
        e.preventDefault();
        e.stopPropagation();
        const step = nudgeStep[group] * (e.shiftKey ? 10 : 1) / (e.altKey ? 10 : 1);
        commit(Number(i.value) - Math.sign(e.deltaY) * step);
      },
      { passive: false },
    );
    return i;
  };

  /** The chips that choose how far one notch of the wheel goes. */
  const steps = (group: NudgeGroup, unit: string): HTMLElement => {
    const row = document.createElement('div');
    row.style.cssText = 'margin:-2px 0 6px';
    for (const step of NUDGE_STEPS[group]) {
      const chip = document.createElement('span');
      chip.className = `chip${nudgeStep[group] === step ? ' on' : ''}`;
      chip.textContent = `${step}${unit}`;
      chip.onclick = () => {
        nudgeStep[group] = step;
        render();
      };
      row.appendChild(chip);
    }
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.style.cssText = 'margin-left:6px';
    hint.textContent = 'scroll a field · shift ×10 · alt ÷10';
    row.appendChild(hint);
    return row;
  };
  const check = (label: string, value: boolean, set: (v: boolean) => void): void => {
    const wrap = document.createElement('label');
    wrap.style.cssText = 'display:flex;gap:8px;align-items:center;text-transform:none;margin-top:8px';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = value;
    cb.style.width = 'auto';
    cb.onchange = () => {
      set(cb.checked);
      markDirty();
    };
    wrap.append(cb, document.createTextNode(label));
    host.appendChild(wrap);
  };

  const id = document.createElement('input');
  id.value = asset.id;
  id.oninput = () => {
    asset.id = id.value.trim();
    markDirty();
  };
  field('Id', id);

  if (asset.kind === 'character-item') {
    // A LIST of the rig's real bones, not a text box. Nobody should have to
    // know that the right hand is spelled `Hand_R`, and a typo in a free
    // field is an item that silently hangs off nothing.
    const attach = document.createElement('select');
    const bones = attachBody?.bones ?? [];
    const likely = ['Hand_R', 'Hand_L', 'spine_03', 'head', 'Pelvis'];
    for (const bone of [...likely.filter((b) => bones.includes(b)), ...bones.filter((b) => !likely.includes(b))]) {
      attach.add(new Option(bone, bone));
    }
    if (bones.length === 0) attach.add(new Option(asset.attach, asset.attach));
    attach.value = asset.attach;
    attach.onchange = () => {
      asset.attach = attach.value;
      markDirty();
      void showAsset(assetSel);
    };
    field('Attach to bone', attach);

    const stance = document.createElement('select');
    for (const s of STANCE_OPTIONS) stance.add(new Option(s, s));
    stance.value = asset.stance;
    stance.onchange = () => {
      asset.stance = stance.value as CharacterItem['stance'];
      markDirty();
    };
    field('Stance (chooses the animation set)', stance);

    // Play a clip while the item hangs there. This is the control that makes
    // the offset fields worth having: a grip that reads correctly in a T-pose
    // can pass through a thigh at the bottom of a walk.
    const play = document.createElement('select');
    play.add(new Option('— still (rest pose) —', ''));
    for (const clip of clipLibrary) play.add(new Option(clip.name, clip.name));
    play.value = playingClip;
    play.onchange = () => playOnBody(play.value);
    field('Play while fitting', play);
    if (clipLibrary.length === 0) {
      const none = document.createElement('div');
      none.className = 'hint';
      none.textContent = 'No clips built yet — run npm run build:characters.';
      host.appendChild(none);
    }

    const t = asset.transform;
    const posRow = document.createElement('div');
    posRow.className = 'row';
    posRow.append(
      num(t.position[0], (v) => (t.position[0] = v)),
      num(t.position[1], (v) => (t.position[1] = v)),
      num(t.position[2], (v) => (t.position[2] = v)),
    );
    field('Offset x / y / z (metres)', posRow);
    host.appendChild(steps('position', 'm'));

    const rotRow = document.createElement('div');
    rotRow.className = 'row';
    rotRow.append(
      num(t.rotation[0], (v) => (t.rotation[0] = v), 'rotation'),
      num(t.rotation[1], (v) => (t.rotation[1] = v), 'rotation'),
      num(t.rotation[2], (v) => (t.rotation[2] = v), 'rotation'),
    );
    field('Rotation x / y / z (degrees)', rotRow);
    host.appendChild(steps('rotation', '°'));

    field('Scale', num(t.scale, (v) => (t.scale = v), 'scale'));
    host.appendChild(steps('scale', '×'));

    const reset = document.createElement('button');
    reset.textContent = 'Back to the fitted default';
    reset.style.cssText = 'margin-top:6px';
    reset.title = 'clears your changes and lets `npm run fit:weapons` place it again';
    reset.onclick = () => {
      // Clearing the transform is what `fit:weapons` looks for, so this hands
      // the item back to the rule rather than guessing at the rule's numbers
      // here, where they would be a second copy waiting to drift.
      asset.transform = { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 };
      asset.tags = asset.tags.filter((t2) => t2 !== 'auto-fit');
      markDirty();
      void showAsset(assetSel);
    };
    host.appendChild(reset);

    const note = document.createElement('div');
    note.className = 'hint';
    note.id = 'placed-note';
    host.appendChild(note);
    refreshPlacedNote(asset);
  }

  if (asset.kind === 'environment') {
    check('Blocks movement', asset.solid, (v) => (asset.solid = v));
    check('Blocks line of sight', asset.opaque, (v) => (asset.opaque = v));
    check('Opens (a door, a chest)', asset.operable, (v) => (asset.operable = v));
    const fp = document.createElement('div');
    fp.className = 'row';
    fp.append(
      num(asset.footprint[0], (v) => (asset.footprint[0] = Math.max(1, Math.round(v)))),
      num(asset.footprint[1], (v) => (asset.footprint[1] = Math.max(1, Math.round(v)))),
    );
    field('Footprint in tiles (w × h)', fp);
    const note = document.createElement('div');
    note.className = 'hint';
    note.innerHTML =
      'Movement and sight are separate on purpose: a fence stops a body and ' +
      'not an eye, and conflating them is how a witness sees through a wall.';
    host.appendChild(note);
  }

  if (asset.kind === 'pickup') {
    const item = document.createElement('input');
    item.value = asset.item ?? '';
    item.placeholder = 'content/items id, once one exists';
    item.oninput = () => {
      asset.item = item.value.trim() || undefined;
      markDirty();
    };
    field('Item template', item);
    field('Scale', num(asset.transform.scale, (v) => (asset.transform.scale = v)));
  }

  const tags = document.createElement('input');
  tags.value = asset.tags.join(', ');
  tags.placeholder = 'keywords, comma separated';
  tags.oninput = () => {
    asset.tags = tags.value.split(',').map((t2) => t2.trim()).filter(Boolean);
    markDirty();
  };
  field('Tags', tags);
}

async function saveAssetFile(): Promise<void> {
  if (!assetFile) return;
  const result = await saveAssets(assetFile);
  if (!result.ok) {
    showProblems(result.problems, '');
    return;
  }
  dirty = false;
  status(`saved ${assetFile.assets.length}`, 'good');
  showProblems([], `Saved content/assets/${assetFile.pack}.${assetFile.kind}.json`);
}

/* ------------------------------------------------------------ animations */

/**
 * Binding clips to actions (D-564).
 *
 * The three layers are the whole design (D-561): a `rig` set is what everyone
 * does, a `race` set colours it, and a `stance` set overrides what holding a
 * weapon changes. Anything a layer is silent about falls through to the one
 * beneath, which is why `two-handed` can be seven rows long and still describe
 * a complete character.
 *
 * ⚠ So the editor has to show INHERITANCE, not just assignment. A row left
 * empty is not a hole — it is "whatever the rig does" — and an author who
 * cannot see the difference will fill all 62 rows in every set and undo the
 * layering by hand. Empty rows therefore print what they will actually play,
 * and say which clip it falls through to.
 */
let animSets: AnimationSet[] = [];
let builtClipNames: string[] = [];
let animSel = '';

async function loadAnimations(): Promise<void> {
  const data = (await (await fetch(`${API}/animations`)).json()) as {
    sets: AnimationSet[];
    clips: string[];
  };
  animSets = data.sets;
  builtClipNames = data.clips;
  if (!animSets.some((s) => s.id === animSel)) animSel = animSets[0]?.id ?? '';
}

function selectedSet(): AnimationSet | undefined {
  return animSets.find((s) => s.id === animSel);
}

/**
 * Put a plain body on the stage and leave it there.
 *
 * The same cached mannequin the worn-item tab attaches to, so a stance's
 * attacks are judged on the figure that will actually hold the sword rather
 * than on a second, differently-assembled one.
 */
async function showAnimationBody(): Promise<void> {
  const body = await bodyToAttachTo();
  if (!body) return;
  if (shown !== body.group.parent) {
    if (shown) scene.scene.remove(shown);
    const holder = new THREE.Group();
    holder.add(body.group);
    scene.scene.add(holder);
    shown = holder;
  }
  focusY = 0.05;
  orbitH = 1.0;
  zoom = 0.26;
  scene.setOrbitHeight(orbitH);
}

function renderAnimationsList(): void {
  const host = $('list');
  host.replaceChildren();

  const resolved = resolveAnimations(animSets);
  const missing = missingActions(resolved);
  const note = document.createElement('div');
  note.className = 'count';
  const total = Object.values(ACTION_GROUPS).flat().length;
  note.textContent = missing.length
    ? `nothing provides ${missing.join(' or ')}`
    : `${builtClipNames.length} clips built - ${Object.keys(resolved).length} of ${total} actions covered`;
  if (missing.length) note.style.color = '#c9736b';
  host.appendChild(note);

  for (const layer of ANIMATION_LAYERS) {
    const inLayer = animSets.filter((s) => s.layer === layer);
    if (inLayer.length === 0) continue;
    const head = document.createElement('div');
    head.className = 'count';
    head.style.marginTop = '10px';
    head.textContent = layerBlurb(layer);
    host.appendChild(head);
    for (const set of inLayer) {
      const row = document.createElement('div');
      row.className = `chip${set.id === animSel ? ' on' : ''}`;
      row.style.display = 'block';
      row.textContent = `${set.name}  (${Object.keys(set.clips).length})`;
      row.onclick = () => {
        animSel = set.id;
        void showAnimationBody();
        render();
      };
      host.appendChild(row);
    }
  }
}

function layerBlurb(layer: AnimationLayer): string {
  if (layer === 'rig') return 'RIG - the base everything falls through to';
  if (layer === 'race') return 'RACE - flavour over the base, per race and sex';
  if (layer === 'stance') return 'STANCE - how the thing is carried, and the draw';
  return 'WEAPON UP - what only plays in combat';
}

function renderAnimationsSide(): void {
  const host = $('side');
  host.replaceChildren();
  const set = selectedSet();
  if (!set) {
    const empty = document.createElement('div');
    empty.className = 'count';
    empty.textContent = 'No animation sets yet. Run npm run draft:animations.';
    host.appendChild(empty);
    return;
  }

  const title = document.createElement('h3');
  title.textContent = `${set.name}  -  ${set.layer} applies to ${set.applies}`;
  host.appendChild(title);
  if (set.note) {
    const n = document.createElement('div');
    n.className = 'count';
    n.textContent = set.note;
    host.appendChild(n);
  }

  const inherited = inheritedAnimations(animSets, set);

  for (const [group, actions] of Object.entries(ACTION_GROUPS)) {
    const head = document.createElement('div');
    head.className = 'count';
    head.style.marginTop = '10px';
    head.textContent = group.toUpperCase();
    host.appendChild(head);

    const table = document.createElement('table');
    for (const action of actions as readonly Action[]) {
      const tr = document.createElement('tr');

      const label = document.createElement('td');
      label.className = 'stem';
      label.textContent = action;
      tr.appendChild(label);

      const pick = document.createElement('td');
      const sel = document.createElement('select');
      const fallback = inherited[action];
      // The empty option is the important one: it says what the row WILL do
      // rather than reading as "nothing", which is the difference between
      // inheriting a walk and having none.
      sel.add(new Option(fallback ? `inherits ${fallback}` : 'nothing plays', ''));
      for (const clip of builtClipNames) sel.add(new Option(clip, clip));
      sel.value = set.clips[action] ?? '';
      sel.style.width = '100%';
      sel.onchange = () => {
        if (sel.value) set.clips[action] = sel.value;
        else delete set.clips[action];
        markDirty();
        render();
      };
      pick.appendChild(sel);
      tr.appendChild(pick);

      const playCell = document.createElement('td');
      const play = document.createElement('button');
      play.textContent = 'play';
      const clip = set.clips[action] ?? fallback;
      play.disabled = !clip;
      play.onclick = () => {
        void showAnimationBody().then(() => playOnBody(clip ?? ''));
        banner(`${set.applies} - ${action} - ${clip ?? 'nothing'}`);
      };
      playCell.appendChild(play);
      tr.appendChild(playCell);

      table.appendChild(tr);
    }
    host.appendChild(table);
  }

  const save = document.createElement('button');
  save.textContent = 'Save set';
  save.style.marginTop = '12px';
  save.onclick = () => void saveAnimationSet();
  host.appendChild(save);
}

async function saveAnimationSet(): Promise<void> {
  const set = selectedSet();
  if (!set) return;
  const res = await fetch(`${API}/animations/${encodeURIComponent(set.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(set),
  });
  const body = (await res.json()) as { saved?: string; problems?: string[]; error?: string };
  if (!res.ok) {
    showProblems(body.problems ?? [body.error ?? 'refused'], '');
    status('not saved', 'bad');
    return;
  }
  dirty = false;
  status(`saved ${body.saved}`, 'good');
}


/* --------------------------------------------------------- contact sheet */

/**
 * Twelve characters at a time, each holding a different item (D-564).
 *
 * 163 weapons were fitted by one rule (`npm run fit:weapons`), and a rule that
 * is right about 150 of them and wrong about 13 is worth far more than
 * positioning 163 by hand — but only if the 13 can be FOUND. One at a time
 * that is 163 loads and 163 looks; in a grid it is fourteen screens, and a
 * weapon through a thigh or held by its blade is obvious at a glance beside
 * eleven that are right.
 *
 * ⚠ The bodies are CLONES of the one assembled mannequin, not twelve
 * assemblies. `partMesh` caches its meshes and `assemble` binds them, so
 * assembling twice from the cache would rebind the same geometry to a second
 * skeleton and the first body would go with it. `SkeletonUtils.clone` is the
 * one that copies a rig properly.
 */
const SHEET_COLUMNS = 4;
const SHEET_SIZE = 8;
let sheetPage = 0;
let sheetOn = false;
/** The mixers driving the grid, one per body, so a clip can be judged in motion. */
let sheetMixers: THREE.AnimationMixer[] = [];

function sheetItems(): AssetDef[] {
  return (assetFile?.assets ?? []).filter((a) => a.kind === 'character-item');
}

async function showContactSheet(): Promise<void> {
  const items = sheetItems();
  if (items.length === 0) return;
  const pages = Math.max(1, Math.ceil(items.length / SHEET_SIZE));
  sheetPage = ((sheetPage % pages) + pages) % pages;
  const page = items.slice(sheetPage * SHEET_SIZE, sheetPage * SHEET_SIZE + SHEET_SIZE);

  const template = await bodyToAttachTo();
  if (!template) return;
  await loadAssetTexture();
  const bodyTexture = await characterAtlas();

  if (shown) scene.scene.remove(shown);
  sheetMixers = [];
  const grid = new THREE.Group();

  for (const [i, asset] of page.entries()) {
    if (asset.kind !== 'character-item') continue;
    const body = SkeletonUtils.clone(template.group);
    body.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && bodyTexture) {
        // Clone the material as well: the clone shares it with the template,
        // and one shared material means the last texture set wins for all
        // thirteen bodies at once.
        const mat = (mesh.material as THREE.MeshStandardMaterial).clone();
        mat.map = bodyTexture;
        mat.needsUpdate = true;
        mesh.material = mat;
      }
    });
    body.updateMatrixWorld(true);

    const bone = body.getObjectByName(asset.attach);
    if (bone) {
      try {
        const object = await assetMesh(assetPack, asset.mesh);
        object.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (mesh.isMesh && texture) {
            const mat = (mesh.material as THREE.MeshStandardMaterial).clone();
            mat.map = texture;
            mat.needsUpdate = true;
            mesh.material = mat;
          }
        });
        const boneScale = new THREE.Vector3();
        bone.getWorldScale(boneScale);
        const factor = boneScale.x || 1;
        const t = asset.transform;
        object.scale.setScalar(t.scale / factor);
        object.position.set(
          t.position[0] / factor,
          t.position[1] / factor,
          t.position[2] / factor,
        );
        object.rotation.set(
          (t.rotation[0] * Math.PI) / 180,
          (t.rotation[1] * Math.PI) / 180,
          (t.rotation[2] * Math.PI) / 180,
        );
        bone.add(object);
      } catch {
        // A mesh that will not load leaves an empty-handed body, which reads
        // as a missing weapon rather than as a silent skip.
      }
    }

    const holder = new THREE.Group();
    holder.add(body);
    // ⚠ Rows stack UPWARD, not backward. The camera orbits, so a grid laid out
    // in X and Z hides every row but the front one from most angles — the
    // first attempt showed four bodies out of twelve and looked like a bug in
    // the cloning. Floating rows read oddly for a second and then read as a
    // contact sheet, which is what this is.
    holder.position.set(
      ((i % SHEET_COLUMNS) - (SHEET_COLUMNS - 1) / 2) * 2.2,
      Math.floor(i / SHEET_COLUMNS) * 2.4,
      0,
    );
    grid.add(holder);

    if (clipLibrary.length) {
      const mixer = new THREE.AnimationMixer(body);
      sheetMixers.push(mixer);
      const clip = clipLibrary.find((c) => c.name === (playingClip || 'unarmed-idle'));
      if (clip) mixer.clipAction(clip).play();
    }
  }

  scene.scene.add(grid);
  shown = grid;
  // Frame what is actually there, the same way the single-item preview does.
  // A fixed zoom is wrong the moment a page holds two-metre polearms instead
  // of daggers, and wrong in the direction that hides the thing being checked.
  const bounds = new THREE.Box3().setFromObject(grid);
  const extent = new THREE.Vector3();
  bounds.getSize(extent);
  const centre = new THREE.Vector3();
  bounds.getCenter(centre);
  focusY = centre.y - 0.9;
  orbitH = centre.y;
  const perZoom = scene.camera.top / Math.max(1e-6, zoom);
  const aspect = scene.camera.right / Math.max(1e-6, scene.camera.top);
  const need = Math.max(extent.y / 2, extent.x / 2 / Math.max(0.1, aspect));
  zoom = Math.min(4, Math.max(0.05, (need / perZoom) * 1.15));
  scene.setOrbitHeight(orbitH);
  banner(
    `sheet ${sheetPage + 1}/${pages} — ${page.map((a) => a.name).join(', ')}`,
  );
}



/* ----------------------------------------------------------------- classes */

/**
 * The class editor (D-566).
 *
 * A calling is content (D-110) and this is where all of it is decided: who may
 * take it, what it starts with, what it gains per level, what it may wear and
 * wield, and which feats and spells are open to it.
 *
 * ⚠ Feats and spells are edited from the OTHER side. A feat declares
 * `classes: []` meaning open to everyone, or a list meaning only those — so
 * ticking a feat here writes into `content/feats/feats.json`, not into the
 * class. Two lists that have to agree eventually do not, and the feat's own
 * list is the one the server already reads.
 *
 * ⚠ And unticking a feat that is open to EVERYONE cannot just remove this
 * class from an empty list. It converts the list to every other class, which
 * preserves what the feat meant for everybody else. Getting that backwards
 * silently opens a restricted feat to the whole roster.
 */
// ⚠ NOT `Catalogue` — that is already the pack's part catalogue in this file,
// and the two collided silently until the compiler caught it. The same trap as
// `Posture` in D-565; one file, two vocabularies, one name each.
interface ClassCatalogue {
  // ⚠ The WHOLE skill. The class page only needed an id and a name, so that
  // is all this carried — and the progression editor cannot edit fields it
  // was never sent.
  skills: SkillDef[];
  feats: FeatDef[];
  spells: SpellDef[];
  items: { id: string; name: string; category: string; slots: string[] }[];
}

let classes: ClassDef[] = [];
let raceIds: string[] = [];
let cat: ClassCatalogue = { skills: [], feats: [], spells: [], items: [] };
let classSel = '';
let classTab: 'identity' | 'progression' | 'permissions' = 'identity';
/** Feats and spells live in their own files, so their dirt is tracked apart. */
let catDirty = false;

async function loadClasses(): Promise<void> {
  const data = (await (await fetch(`${API}/classes`)).json()) as {
    classes: ClassDef[];
    races: string[];
  };
  classes = data.classes;
  raceIds = data.races;
  cat = (await (await fetch(`${API}/catalogue`)).json()) as ClassCatalogue;
  if (!classes.some((c) => c.id === classSel)) classSel = classes[0]?.id ?? '';
}

function selectedClass(): ClassDef | undefined {
  return classes.find((c) => c.id === classSel);
}

/** Whether a calling may take this feat or spell, under the empty-means-all rule. */
function openTo(entry: { classes: string[] }, id: string): boolean {
  return entry.classes.length === 0 || entry.classes.includes(id);
}

/**
 * Flip one feat or spell for one class, preserving what it meant for the rest.
 *
 * ⚠ The `[]` case is the whole reason this is a function. Turning a feat OFF
 * for one class when it was open to all has to name every other class
 * explicitly, or the feat stays open to everybody and the click did nothing.
 * Turning it ON for the last missing class collapses back to `[]`, so the
 * files stay tidy and the meaning is unchanged.
 */
function setOpenTo(entry: { classes: string[] }, id: string, allow: boolean): void {
  const everyone = classes.map((c) => c.id);
  let list = entry.classes.length === 0 ? [...everyone] : [...entry.classes];
  list = allow ? [...new Set([...list, id])] : list.filter((c) => c !== id);
  entry.classes = everyone.every((c) => list.includes(c)) ? [] : list;
}

function renderClassList(): void {
  const host = $('list');
  host.replaceChildren();

  const add = document.createElement('button');
  add.textContent = '+ New calling';
  add.style.marginBottom = '10px';
  add.onclick = () => void createClass();
  host.appendChild(add);

  const note = document.createElement('div');
  note.className = 'count';
  note.textContent = `${classes.length} callings`;
  host.appendChild(note);

  for (const cls of classes) {
    const row = document.createElement('div');
    row.className = `chip${cls.id === classSel ? ' on' : ''}`;
    row.style.display = 'block';
    const gates = [
      cls.armour.length ? `${cls.armour.length} armour` : null,
      cls.weapons.length ? `${cls.weapons.length} stances` : null,
      cls.races.length ? `${cls.races.length} races` : null,
      cls.spellcasting ? 'caster' : null,
      cls.legacyLocked ? 'legacy' : null,
    ].filter(Boolean);
    row.textContent = `${cls.name}${gates.length ? `  —  ${gates.join(', ')}` : '  —  unrestricted'}`;
    row.onclick = () => {
      classSel = cls.id;
      render();
    };
    host.appendChild(row);
  }
}

async function createClass(): Promise<void> {
  const name = prompt('Name the calling');
  if (!name?.trim()) return;
  const id = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  creatureShown = id;
  if (!id) return;
  if (classes.some((c) => c.id === id)) {
    status(`there is already a calling called ${id}`, 'bad');
    return;
  }
  // A new calling starts UNRESTRICTED and empty. Everything on this page is a
  // narrowing of that, so a half-finished class is playable rather than broken.
  const fresh: ClassDef = {
    id,
    name: name.trim(),
    description: 'Not yet described.',
    role: 'melee',
    abilities: [],
    legacyLocked: false,
    affinities: [],
    spellcasting: false,
    progression: [],
    startingKit: [],
    armour: [],
    weapons: [],
    races: [],
    items: [],
    startingAttributes: {},
  };
  classes = [...classes, fresh].sort((a, b) => a.name.localeCompare(b.name));
  classSel = id;
  markDirty();
  render();
}

/* ------------------------------------------------------------- the panels */

function renderClassSide(): void {
  const host = $('side');
  host.replaceChildren();
  const cls = selectedClass();
  if (!cls) {
    const empty = document.createElement('div');
    empty.className = 'count';
    empty.textContent = 'No callings yet — make one.';
    host.appendChild(empty);
    return;
  }

  const title = document.createElement('h1');
  title.textContent = cls.name;
  host.appendChild(title);

  const tabs = document.createElement('div');
  tabs.style.marginBottom = '10px';
  for (const t of ['identity', 'progression', 'permissions'] as const) {
    const chip = document.createElement('span');
    chip.className = `chip${classTab === t ? ' on' : ''}`;
    chip.textContent = t;
    chip.onclick = () => {
      classTab = t;
      render();
    };
    tabs.appendChild(chip);
  }
  host.appendChild(tabs);

  if (classTab === 'identity') renderClassIdentity(host, cls);
  else if (classTab === 'progression') renderClassProgression(host, cls);
  else renderClassPermissions(host, cls);

  const save = document.createElement('button');
  save.textContent = 'Save calling';
  save.className = 'primary';
  save.style.marginTop = '14px';
  save.onclick = () => void saveClass();
  host.appendChild(save);

  const where = document.createElement('div');
  where.className = 'hint';
  where.style.marginTop = '8px';
  where.textContent = catDirty
    ? `Writes content/classes/${cls.id}.json, and the feat and spell files`
    : `Writes content/classes/${cls.id}.json`;
  host.appendChild(where);

  const problems = document.createElement('div');
  problems.id = 'problems';
  host.appendChild(problems);
}

/** Label + control, the same shape the asset panel uses. */
function classField(host: HTMLElement, label: string, el: HTMLElement): void {
  const l = document.createElement('label');
  l.textContent = label;
  host.append(l, el);
}

function renderClassIdentity(host: HTMLElement, cls: ClassDef): void {
  const text = (value: string, set: (v: string) => void, area = false): HTMLElement => {
    const el = document.createElement(area ? 'textarea' : 'input');
    el.value = value;
    if (area) (el as HTMLTextAreaElement).rows = 4;
    el.oninput = () => {
      set((el as HTMLInputElement).value);
      markDirty();
    };
    return el;
  };
  classField(host, 'Name', text(cls.name, (v) => (cls.name = v)));
  classField(host, 'Description', text(cls.description, (v) => (cls.description = v), true));
  classField(host, 'Role (grouping only)', text(cls.role, (v) => (cls.role = v)));

  const check = (label: string, value: boolean, set: (v: boolean) => void): void => {
    const wrap = document.createElement('label');
    wrap.style.cssText = 'display:flex;gap:8px;align-items:center;text-transform:none;margin-top:8px';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = value;
    cb.style.width = 'auto';
    cb.onchange = () => {
      set(cb.checked);
      markDirty();
      render();
    };
    wrap.append(cb, document.createTextNode(label));
    host.appendChild(wrap);
  };
  check('Casts spells', cls.spellcasting, (v) => (cls.spellcasting = v));
  check('Costs Legacy Points to take', cls.legacyLocked, (v) => (cls.legacyLocked = v));

  const ah = document.createElement('h2');
  ah.textContent = 'Class abilities';
  host.appendChild(ah);
  const arow = document.createElement('div');
  for (const ability of CLASS_ABILITIES) {
    const on = cls.abilities.includes(ability);
    const chip = document.createElement('span');
    chip.className = `chip${on ? ' on' : ''}`;
    chip.textContent = ability;
    chip.onclick = () => {
      cls.abilities = on ? cls.abilities.filter((a) => a !== ability) : [...cls.abilities, ability];
      markDirty();
      render();
    };
    arow.appendChild(chip);
  }
  host.appendChild(arow);

  /* ----------------------------------------------------- starting stats */
  const sh = document.createElement('h2');
  sh.textContent = 'Starting attributes';
  host.appendChild(sh);

  const warn = document.createElement('div');
  warn.className = 'hint';
  warn.style.cssText = 'color:var(--bad);line-height:1.5;margin-bottom:6px';
  warn.textContent =
    '⚠ D-546 gives every calling the SAME start — 10 apiece with 10 to place — ' +
    'because a class is access and options, not a stat block. Nothing reads ' +
    'this yet; the server still hands everyone the same start. Decide whether ' +
    'it is a suggestion the player may change, or a rule that supersedes D-546.';
  host.appendChild(warn);

  const spent = ATTRIBUTES.reduce((n, a) => n + (cls.startingAttributes[a] ?? 0), 0);
  const budget = document.createElement('div');
  budget.className = 'hint';
  budget.style.color = spent > ATTRIBUTE_CREATION_POINTS ? 'var(--bad)' : 'var(--dim)';
  budget.textContent = `${spent} of ${ATTRIBUTE_CREATION_POINTS} points placed (base ${ATTRIBUTE_BASE} in each)`;
  host.appendChild(budget);

  for (const attr of ATTRIBUTES) {
    const row = document.createElement('div');
    row.className = 'row';
    row.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:4px';
    const label = document.createElement('span');
    label.style.cssText = 'flex:1;color:var(--dim);font-size:11px';
    label.textContent = attr;
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.max = String(ATTRIBUTE_CREATION_POINTS);
    input.value = String(cls.startingAttributes[attr] ?? 0);
    input.style.width = '70px';
    input.oninput = () => {
      const n = Math.max(0, Math.min(ATTRIBUTE_CREATION_POINTS, Number(input.value) || 0));
      cls.startingAttributes = { ...cls.startingAttributes, [attr]: n };
      markDirty();
      render();
    };
    const total = document.createElement('span');
    total.className = 'hint';
    total.textContent = `→ ${ATTRIBUTE_BASE + (cls.startingAttributes[attr] ?? 0)}`;
    row.append(label, input, total);
    host.appendChild(row);
  }

  /* ------------------------------------------------------------ affinities */
  const fh = document.createElement('h2');
  fh.textContent = 'Skill affinities (advisory)';
  host.appendChild(fh);
  const frow = document.createElement('div');
  for (const skill of cat.skills) {
    const on = cls.affinities.includes(skill.id);
    const chip = document.createElement('span');
    chip.className = `chip${on ? ' on' : ''}`;
    chip.textContent = skill.name;
    if (skill.creationOnly) chip.title = 'creation-only — a level can never grant it (D-538)';
    chip.onclick = () => {
      cls.affinities = on
        ? cls.affinities.filter((a) => a !== skill.id)
        : [...cls.affinities, skill.id];
      markDirty();
      render();
    };
    frow.appendChild(chip);
  }
  host.appendChild(frow);
}

function renderClassProgression(host: HTMLElement, cls: ClassDef): void {
  const blurb = document.createElement('div');
  blurb.className = 'hint';
  blurb.style.cssText = 'line-height:1.5;margin-bottom:8px';
  blurb.textContent =
    'Grants are automatic and fixed (D-538) — there is no level-up wizard, so ' +
    '"a physician has field surgery by four" is something players can plan ' +
    'around. A level may never grant a creation-only skill.';
  host.appendChild(blurb);

  for (let level = 2; level <= MAX_LEVEL; level++) {
    const step = cls.progression.find((p) => p.level === level);
    const box = document.createElement('div');
    box.style.cssText =
      'border:1px solid var(--line);border-radius:2px;padding:8px;margin-bottom:6px';

    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:4px';
    const lv = document.createElement('b');
    lv.style.color = 'var(--warm)';
    lv.textContent = `Level ${level}`;
    head.appendChild(lv);
    if (!step) {
      const addBtn = document.createElement('button');
      addBtn.textContent = 'add a grant';
      addBtn.onclick = () => {
        cls.progression = [
          ...cls.progression,
          { level, skills: {}, feats: [], spells: [], abilities: [], note: 'Something changes.' },
        ].sort((a, b) => a.level - b.level);
        markDirty();
        render();
      };
      head.appendChild(addBtn);
    }
    box.appendChild(head);

    if (step) {
      const note = document.createElement('input');
      note.value = step.note;
      note.placeholder = 'what this level feels like';
      note.oninput = () => {
        step.note = note.value;
        markDirty();
      };
      box.appendChild(note);

      const skills = document.createElement('div');
      skills.className = 'hint';
      skills.style.marginTop = '4px';
      const chosen = Object.entries(step.skills).filter(([, n]) => n > 0);
      skills.textContent = chosen.length
        ? `skills: ${chosen.map(([k, n]) => `${k} +${n}`).join(', ')}`
        : 'no skill points';
      box.appendChild(skills);

      const pick = document.createElement('select');
      pick.add(new Option('+ skill…', ''));
      // ⚠ Creation-only skills are absent, not greyed: `arms` may never be
      // granted by a level (D-538) and CI fails the build over it, so offering
      // it here would be offering something that cannot be saved.
      for (const s of cat.skills.filter((s) => !s.creationOnly)) pick.add(new Option(s.name, s.id));
      pick.onchange = () => {
        if (!pick.value) return;
        step.skills = { ...step.skills, [pick.value]: (step.skills[pick.value] ?? 0) + 5 };
        markDirty();
        render();
      };
      box.appendChild(pick);

      const featRow = document.createElement('div');
      featRow.style.marginTop = '4px';
      for (const f of cat.feats.filter((f) => openTo(f, cls.id))) {
        const on = step.feats.includes(f.id);
        const chip = document.createElement('span');
        chip.className = `chip${on ? ' on' : ''}`;
        chip.textContent = f.name;
        chip.onclick = () => {
          step.feats = on ? step.feats.filter((x) => x !== f.id) : [...step.feats, f.id];
          markDirty();
          render();
        };
        featRow.appendChild(chip);
      }
      box.appendChild(featRow);

      const drop = document.createElement('span');
      drop.className = 'hint';
      drop.style.cssText = 'cursor:pointer;text-decoration:underline;margin-top:4px;display:inline-block';
      drop.textContent = 'remove this level';
      drop.onclick = () => {
        cls.progression = cls.progression.filter((p) => p.level !== level);
        markDirty();
        render();
      };
      box.appendChild(drop);
    }
    host.appendChild(box);
  }
}

function renderClassPermissions(host: HTMLElement, cls: ClassDef): void {
  const gate = (
    label: string,
    options: readonly string[],
    chosen: string[],
    counts: Record<string, number> | null,
    set: (next: string[]) => void,
  ): void => {
    const h = document.createElement('h2');
    h.textContent = label;
    host.appendChild(h);
    const state = document.createElement('div');
    state.className = 'hint';
    state.style.marginBottom = '4px';
    state.textContent = chosen.length
      ? `restricted to ${chosen.length} of ${options.length}`
      : 'unrestricted — every one of them';
    if (!chosen.length) state.style.color = 'var(--warm)';
    host.appendChild(state);
    const row = document.createElement('div');
    for (const opt of options) {
      const on = chosen.includes(opt);
      const chip = document.createElement('span');
      chip.className = `chip${on ? ' on' : ''}`;
      const n = counts?.[opt];
      chip.textContent = n === undefined ? opt : `${opt} ${n}`;
      if (counts && !n) {
        chip.style.opacity = '0.45';
        chip.title = 'nothing carries this tag yet';
      }
      chip.onclick = () => {
        set(on ? chosen.filter((c) => c !== opt) : [...chosen, opt]);
        markDirty();
        render();
      };
      row.appendChild(chip);
    }
    host.appendChild(row);
  };

  gate('Armour it may wear', ARMOUR_MATERIALS, cls.armour, partsByMaterial(), (v) => {
    cls.armour = v as typeof cls.armour;
  });
  gate('Weapon archetypes it may wield', STANCES, cls.weapons, itemsByStance(), (v) => {
    cls.weapons = v as typeof cls.weapons;
  });
  gate('Races it admits', raceIds, cls.races, null, (v) => {
    cls.races = v;
  });
  // ⚠ This gate was authorable from D-566 and enforced nothing until D-572,
  // because a character had no race to check. It now refuses a character at
  // CREATION — worth saying, because narrowing it is the one edit here that
  // can stop somebody making the character they wanted.
  const rnote = document.createElement('div');
  rnote.className = 'hint';
  rnote.style.cssText = 'line-height:1.5;margin:2px 0 10px';
  rnote.innerHTML = raceIds.length === 0
    ? '⚠ No races authored yet — define one on the <b>Races</b> tab before this '
      + 'can narrow anything.'
    : 'Enforced by the server at creation (D-572): a character sent with a race '
      + 'this calling does not admit is refused by name. ⚠ Leaving it empty '
      + 'means <b>every</b> race, which is what all nine callings do today.';
  host.appendChild(rnote);
  gate(
    'Specific items it may use',
    cat.items.map((i) => i.id),
    cls.items,
    null,
    (v) => {
      cls.items = v;
    },
  );
  if (cat.items.length === 0) {
    const none = document.createElement('div');
    none.className = 'hint';
    none.textContent = 'No items defined yet — that tool is still to be built.';
    host.appendChild(none);
  }

  /* --------------------------------------------------------- starting kit */
  const kh = document.createElement('h2');
  kh.textContent = 'What it starts with';
  host.appendChild(kh);
  const knote = document.createElement('div');
  knote.className = 'hint';
  knote.style.cssText = 'line-height:1.5;margin-bottom:4px';
  knote.innerHTML =
    'Granted once per character per round (D-547), and stripped between rounds. '
    + '⚠ CI refuses a kit the calling <b>cannot use</b> — gate it above and hand '
    + 'it plate here and the build fails, which is the one mistake a first pass '
    + 'at gating makes.';
  host.appendChild(knote);

  for (const [i, entry] of cls.startingKit.entries()) {
    const row = document.createElement('div');
    row.className = 'kitrow';

    const pick = document.createElement('select');
    for (const item of cat.items) {
      const o = document.createElement('option');
      o.value = item.id;
      o.textContent = item.name;
      pick.appendChild(o);
    }
    pick.value = entry.item;
    pick.onchange = () => {
      entry.item = pick.value;
      markDirty();
      renderClassSide();
    };

    const qty = document.createElement('input');
    qty.type = 'number';
    qty.min = '1';
    qty.max = '20';
    qty.value = String(entry.qty);
    qty.style.width = '4em';
    qty.onchange = () => {
      entry.qty = Math.min(20, Math.max(1, Number(qty.value) || 1));
      markDirty();
    };

    // ⚠ The slot is the ITEM's, not a free choice: a kit that equips a loaf is
    // a content error the build refuses. This offers only what the item says
    // it fills, plus "carried".
    const slot = document.createElement('select');
    const carried = document.createElement('option');
    carried.value = '';
    carried.textContent = 'carried';
    slot.appendChild(carried);
    const template = cat.items.find((it) => it.id === entry.item);
    for (const sl of template?.slots ?? []) {
      const o = document.createElement('option');
      o.value = sl;
      o.textContent = `worn: ${sl}`;
      slot.appendChild(o);
    }
    slot.value = entry.equip ?? '';
    slot.onchange = () => {
      entry.equip = (slot.value || undefined) as typeof entry.equip;
      markDirty();
    };

    const drop = document.createElement('span');
    drop.className = 'chip';
    drop.textContent = '−';
    drop.title = 'Remove from the kit';
    drop.onclick = () => {
      cls.startingKit.splice(i, 1);
      markDirty();
      renderClassSide();
    };

    row.append(pick, qty, slot, drop);
    host.appendChild(row);
  }

  const addKit = document.createElement('button');
  addKit.textContent = '+ Add to the kit';
  addKit.style.marginTop = '6px';
  addKit.disabled = cat.items.length === 0;
  addKit.onclick = () => {
    cls.startingKit.push({ item: cat.items[0]!.id, qty: 1 });
    markDirty();
    renderClassSide();
  };
  host.appendChild(addKit);

  /* ------------------------------------------------------ feats and spells */
  const fh = document.createElement('h2');
  fh.textContent = 'Feats open to it';
  host.appendChild(fh);
  const fnote = document.createElement('div');
  fnote.className = 'hint';
  fnote.style.cssText = 'line-height:1.5;margin-bottom:4px';
  fnote.textContent =
    'Stored on the FEAT, not the class. Unticking one that is open to everybody ' +
    'names every other calling explicitly, so it stays open for them.';
  host.appendChild(fnote);
  const featRow = document.createElement('div');
  for (const f of cat.feats) {
    const on = openTo(f, cls.id);
    const chip = document.createElement('span');
    chip.className = `chip${on ? ' on' : ''}`;
    chip.textContent = f.classes.length === 0 ? `${f.name} (all)` : f.name;
    chip.onclick = () => {
      setOpenTo(f, cls.id, !on);
      catDirty = true;
      markDirty();
      render();
    };
    featRow.appendChild(chip);
  }
  host.appendChild(featRow);

  if (cls.spellcasting) {
    const sh = document.createElement('h2');
    sh.textContent = 'Spells open to it';
    host.appendChild(sh);
    const spellRow = document.createElement('div');
    for (const s of cat.spells) {
      const on = openTo(s, cls.id);
      const chip = document.createElement('span');
      chip.className = `chip${on ? ' on' : ''}`;
      chip.textContent = s.classes.length === 0 ? `${s.name} (all)` : s.name;
      chip.onclick = () => {
        setOpenTo(s, cls.id, !on);
        catDirty = true;
        markDirty();
        render();
      };
      spellRow.appendChild(chip);
    }
    host.appendChild(spellRow);
  } else {
    const sh = document.createElement('div');
    sh.className = 'hint';
    sh.style.marginTop = '10px';
    sh.textContent = 'Not a caster — tick "Casts spells" on Identity to choose spells.';
    host.appendChild(sh);
  }
}

/** How many parts carry each material, so a gate shows what it will admit. */
function partsByMaterial(): Record<string, number> {
  const count: Record<string, number> = {};
  for (const tags of Object.values(names.tags)) {
    for (const t of tags) {
      if ((ARMOUR_MATERIALS as readonly string[]).includes(t)) count[t] = (count[t] ?? 0) + 1;
    }
  }
  return count;
}

/** How many worn items declare each stance. */
function itemsByStance(): Record<string, number> {
  const count: Record<string, number> = {};
  for (const a of assetFile?.assets ?? []) {
    if (a.kind === 'character-item' && a.stance) count[a.stance] = (count[a.stance] ?? 0) + 1;
  }
  return count;
}

async function saveClass(): Promise<void> {
  const cls = selectedClass();
  if (!cls) return;
  const res = await fetch(`${API}/classes/${encodeURIComponent(cls.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cls),
  });
  const body = (await res.json()) as { saved?: string; problems?: string[]; error?: string };
  if (!res.ok) {
    showProblems(body.problems ?? [body.error ?? 'refused'], '');
    status('not saved', 'bad');
    return;
  }
  // Skills, feats and spells are their own files. Only written when something
  // changed, so opening a class and saving it does not rewrite the catalogue.
  if (catDirty && !(await saveCatalogue())) return;
  dirty = false;
  status(`saved ${body.saved}`, 'good');
  showProblems([], `Saved content/classes/${cls.id}.json`);
}


/* ------------------------------------------------------------------- items */

/**
 * The in-game item library (D-566).
 *
 * ⚠ The split that makes this worth having: an item POINTS AT an asset rather
 * than owning one. The asset says how a thing is held, which bone, which
 * animation stance — decided once, for 163 weapons. The item says which asset,
 * what colour, what it weighs and what it is worth. So a rusted shortsword and
 * a fine one are one mesh, two colourways and two stat blocks, and the art
 * work is not repeated per item.
 *
 * Colours are exact substitutions against the pack's atlas — the same
 * mechanism `skinPalette` uses (D-560), safe for the same measured reason:
 * every UV island sits inside one flat region, so NEAREST filtering keeps a
 * substitution clean. A worn item samples three to seven colours, which the
 * server measures and hands over, so recolouring is a handful of swatches and
 * never a texture editor.
 */
let items: ItemTemplate[] = [];
let itemSel = '';
/** The colours the SELECTED item's mesh actually samples, biggest share first. */
let itemColours: { hex: string; share: number }[] = [];
let itemAssets: AssetDef[] = [];

async function loadItems(): Promise<void> {
  items = (await (await fetch(`${API}/items`)).json()) as ItemTemplate[];
  if (!items.some((i) => i.id === itemSel)) itemSel = items[0]?.id ?? '';
  await loadItemArt();
}

function selectedItem(): ItemTemplate | undefined {
  return items.find((i) => i.id === itemSel);
}

/** The worn items of whichever pack this item draws from. */
async function loadItemArt(): Promise<void> {
  const item = selectedItem();
  const pack = item?.art?.pack ?? assetPacks[0] ?? '';
  if (!pack) return;
  try {
    // ⚠ The CATALOGUE too, not just the asset file. `loadAssetTexture` paints
    // from `assetCat.textures`, so loading only the assets left the texture
    // list belonging to whichever pack was opened last — the sword came out
    // painted from the CHARACTER atlas, skin tones and all, and every colour
    // swatch named something that was not on it.
    assetPack = pack;
    assetCat = await loadAssetCatalogue(pack);
    loadedAssetTexture = '';
    const file = (await loadAssets(pack, 'character-item')) as AssetFile;
    assetFile = file;
    itemAssets = file.assets;
  } catch {
    itemAssets = [];
  }
  itemColours = [];
  const mesh = itemAssets.find((a) => a.id === item?.art?.asset)?.mesh;
  if (!mesh) return;
  try {
    const r = (await (
      await fetch(`${API}/assetcolours/${encodeURIComponent(pack)}/${encodeURIComponent(mesh)}`)
    ).json()) as { colours: { hex: string; share: number }[] };
    itemColours = r.colours;
  } catch {
    itemColours = [];
  }
}

/**
 * Show the item on the body, with its own colours.
 *
 * ⚠ Recolouring happens on the ATLAS, not the material: the swaps are exact
 * source-colour substitutions, so tinting the mesh would change every colour
 * on it including the ones the item does not claim. Same reason skin is done
 * this way (D-560).
 */
async function showItem(): Promise<void> {
  const item = selectedItem();
  if (!item?.art) {
    if (shown) scene.scene.remove(shown);
    shown = null;
    banner(item ? `${item.name} — no art assigned` : '');
    return;
  }
  const asset = itemAssets.find((a) => a.id === item.art!.asset);
  if (!asset) {
    banner(`${item.name} — asset '${item.art.asset}' is not in ${item.art.pack}`);
    return;
  }
  assetPack = item.art.pack;
  assetSel = asset.mesh;
  await showAsset(asset.mesh);
  applyItemSwaps(item);
  banner(`${item.name}  ·  ${asset.name}`);
}

/** Repaint the shown item's texture through this item's substitutions. */
function applyItemSwaps(item: ItemTemplate): void {
  const swaps = item.art?.swaps ?? [];
  // ⚠ Always from the ORIGINAL atlas, never from what is currently on the
  // mesh. Re-reading the mesh's texture would apply each swap on top of the
  // last, so changing a colour twice would look for a source colour that the
  // first change had already replaced.
  // `atlasImage` is the atlas as LOADED, kept by `loadTextureFrom` for exactly
  // this: re-reading the mesh's current texture would stack each swap on the
  // last, so changing a colour twice would hunt for a source the first change
  // had already replaced.
  const source = atlasImage;
  if (!swaps.length || !source) return;
  const img = source;
  const w = (img as HTMLImageElement).naturalWidth || img.width;
  const h = (img as HTMLImageElement).naturalHeight || img.height;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, w, h);
  const px = data.data;
  const table = new Map<number, [number, number, number]>();
  for (const { from, to } of swaps) {
    const f = parseInt(from.slice(1), 16);
    const t = parseInt(to.slice(1), 16);
    table.set(f, [(t >> 16) & 255, (t >> 8) & 255, t & 255]);
  }
  for (let i = 0; i < px.length; i += 4) {
    const hit = table.get((px[i]! << 16) | (px[i + 1]! << 8) | px[i + 2]!);
    if (!hit) continue;
    px[i] = hit[0];
    px[i + 1] = hit[1];
    px[i + 2] = hit[2];
  }
  ctx.putImageData(data, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  // Only the ITEM is recoloured — walking `shownAssetObject` rather than the
  // whole stage keeps a sword's palette off the body it is held by.
  shownAssetObject?.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mat = mesh.material as THREE.MeshStandardMaterial;
    mat.map = tex;
    mat.needsUpdate = true;
  });
}

function renderItemList(): void {
  const host = $('list');
  host.replaceChildren();

  const add = document.createElement('button');
  add.textContent = '+ New item';
  add.style.marginBottom = '10px';
  add.onclick = () => void createItem();
  host.appendChild(add);

  const note = document.createElement('div');
  note.className = 'count';
  const withArt = items.filter((i) => i.art).length;
  note.textContent = `${items.length} items · ${withArt} with art`;
  host.appendChild(note);

  const table = document.createElement('table');
  for (const item of items) {
    const tr = document.createElement('tr');
    if (item.id === itemSel) tr.className = 'on';
    const td = document.createElement('td');
    td.className = 'stem';
    td.textContent = item.id;
    td.onclick = () => {
      itemSel = item.id;
      void loadItemArt().then(() => {
        void showItem();
        render();
      });
    };
    const name = document.createElement('td');
    name.textContent = item.name;
    if (!item.art) {
      name.style.color = 'var(--dim)';
      name.title = 'no art assigned — it has no appearance yet';
    }
    tr.append(td, name);
    table.appendChild(tr);
  }
  host.appendChild(table);
}

async function createItem(): Promise<void> {
  const name = prompt('Name the item');
  if (!name?.trim()) return;
  const id = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!id || items.some((i) => i.id === id)) {
    status(id ? `there is already an item called ${id}` : 'not a usable name', 'bad');
    return;
  }
  items = [
    ...items,
    {
      id,
      name: name.trim(),
      description: 'Not yet described.',
      category: 'equipment',
      stackable: false,
      value: 1,
    } as ItemTemplate,
  ].sort((a, b) => a.name.localeCompare(b.name));
  itemSel = id;
  markDirty();
  render();
}

function renderItemSide(): void {
  const host = $('side');
  host.replaceChildren();
  const item = selectedItem();
  if (!item) {
    const empty = document.createElement('div');
    empty.className = 'count';
    empty.textContent = 'No items yet — make one.';
    host.appendChild(empty);
    return;
  }

  const title = document.createElement('h1');
  title.textContent = item.name;
  host.appendChild(title);

  const field = (label: string, el: HTMLElement): void => {
    const l = document.createElement('label');
    l.textContent = label;
    host.append(l, el);
  };
  const text = (value: string, set: (v: string) => void, area = false): HTMLElement => {
    const el = document.createElement(area ? 'textarea' : 'input');
    el.value = value;
    if (area) (el as HTMLTextAreaElement).rows = 3;
    el.oninput = () => {
      set((el as HTMLInputElement).value);
      markDirty();
    };
    return el;
  };

  field('Name', text(item.name, (v) => (item.name = v)));
  field('Description', text(item.description, (v) => (item.description = v), true));

  const cat = document.createElement('select');
  for (const c of ITEM_CATEGORIES) cat.add(new Option(c, c));
  cat.value = item.category;
  cat.onchange = () => {
    item.category = cat.value as typeof item.category;
    markDirty();
  };
  field('Category', cat);

  const value = document.createElement('input');
  value.type = 'number';
  value.min = '0';
  value.value = String(item.value);
  value.oninput = () => {
    item.value = Math.max(0, Number(value.value) || 0);
    markDirty();
  };
  field('Reference value (coin)', value);

  /* --------------------------------------------------------------- the art */
  const ah = document.createElement('h2');
  ah.textContent = 'Appearance';
  host.appendChild(ah);

  const packSel = document.createElement('select');
  packSel.add(new Option('— no art —', ''));
  for (const p of assetPacks) packSel.add(new Option(p, p));
  packSel.value = item.art?.pack ?? '';
  packSel.onchange = () => {
    item.art = packSel.value
      ? { pack: packSel.value, asset: '', swaps: [] }
      : undefined;
    markDirty();
    void loadItemArt().then(() => {
      void showItem();
      render();
    });
  };
  field('Pack', packSel);

  if (item.art) {
    const assetSelect = document.createElement('select');
    assetSelect.add(new Option('— pick an asset —', ''));
    for (const a of itemAssets) assetSelect.add(new Option(`${a.name}  (${a.mesh})`, a.id));
    assetSelect.value = item.art.asset;
    assetSelect.onchange = () => {
      // A new mesh has different colours, so the old substitutions would point
      // at colours it does not contain — dropped rather than carried over.
      item.art = { pack: item.art!.pack, asset: assetSelect.value, swaps: [] };
      markDirty();
      void loadItemArt().then(() => {
        void showItem();
        render();
      });
    };
    field('Asset', assetSelect);

    const asset = itemAssets.find((a) => a.id === item.art!.asset);
    if (asset && asset.kind === 'character-item') {
      const info = document.createElement('div');
      info.className = 'hint';
      info.style.marginTop = '4px';
      info.textContent = `Held at ${asset.attach} · stance ${asset.stance} — from the asset, not the item.`;
      host.appendChild(info);
    }

    /* ------------------------------------------------------------ colours */
    const ch = document.createElement('h2');
    ch.textContent = 'Colours';
    host.appendChild(ch);

    if (itemColours.length === 0) {
      const none = document.createElement('div');
      none.className = 'hint';
      none.textContent = item.art.asset
        ? 'No colours measured — the pack atlas could not be read.'
        : 'Pick an asset to see the colours it uses.';
      host.appendChild(none);
    }

    for (const c of itemColours) {
      const swap = item.art.swaps.find((s) => s.from === c.hex);
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:4px';

      const source = document.createElement('span');
      source.title = `${c.hex} — ${(c.share * 100).toFixed(0)}% of the mesh`;
      source.style.cssText =
        `width:22px;height:22px;border:1px solid var(--line);background:${c.hex};flex:none`;
      row.appendChild(source);

      const share = document.createElement('span');
      share.className = 'hint';
      share.style.cssText = 'flex:1';
      share.textContent = `${c.hex}  ${(c.share * 100).toFixed(0)}%`;
      row.appendChild(share);

      const pick = document.createElement('input');
      pick.type = 'color';
      pick.value = swap?.to ?? c.hex;
      pick.style.cssText = 'width:36px;height:24px;padding:0;flex:none';
      pick.oninput = () => {
        const rest = item.art!.swaps.filter((s) => s.from !== c.hex);
        // A swap back to the source colour is not a swap; dropping it keeps the
        // file honest about what has actually been changed.
        item.art!.swaps =
          pick.value.toLowerCase() === c.hex.toLowerCase()
            ? rest
            : [...rest, { from: c.hex, to: pick.value }];
        markDirty();
        applyItemSwaps(item);
        render();
      };
      row.appendChild(pick);
      host.appendChild(row);
    }

    if (item.art.swaps.length) {
      const reset = document.createElement('span');
      reset.className = 'hint';
      reset.style.cssText = 'cursor:pointer;text-decoration:underline;display:inline-block;margin-top:6px';
      reset.textContent = `clear ${item.art.swaps.length} colour change(s)`;
      reset.onclick = () => {
        item.art!.swaps = [];
        markDirty();
        void showItem().then(render);
      };
      host.appendChild(reset);
    }
  }

  /* -------------------------------------------------------------- the gear */
  const gh = document.createElement('h2');
  gh.textContent = 'Worn or wielded';
  host.appendChild(gh);

  const has = document.createElement('label');
  has.style.cssText = 'display:flex;gap:8px;align-items:center;text-transform:none';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = Boolean(item.equip);
  cb.style.width = 'auto';
  cb.onchange = () => {
    // ⚠ Every stat has a default in the schema and none of them are optional,
    // so a partial object does not type-check and would not parse. Zero is the
    // honest starting value: it means "no armour", not "unset".
    item.equip = cb.checked
      ? { slot: 'main-hand', armour: 0, damage: 0, mana: 0, weight: 1, range: 1 }
      : undefined;
    markDirty();
    render();
  };
  has.append(cb, document.createTextNode('This is gear'));
  host.appendChild(has);

  if (item.equip) {
    const slot = document.createElement('select');
    for (const s of EQUIP_SLOTS) slot.add(new Option(s, s));
    slot.value = item.equip.slot;
    slot.onchange = () => {
      item.equip!.slot = slot.value as typeof item.equip.slot;
      markDirty();
    };
    field('Slot', slot);

    const stat = (label: string, value: number, set: (v: number) => void): void => {
      const i = document.createElement('input');
      i.type = 'number';
      i.min = '0';
      i.value = String(value);
      i.oninput = () => {
        set(Math.max(0, Number(i.value) || 0));
        markDirty();
      };
      field(label, i);
    };
    stat('Damage', item.equip.damage, (v) => (item.equip!.damage = v));
    stat('Armour', item.equip.armour, (v) => (item.equip!.armour = v));
    stat('Weight', item.equip.weight, (v) => (item.equip!.weight = v));
    stat('Reach (tiles)', item.equip.range, (v) => (item.equip!.range = v));
    stat('Mana', item.equip.mana, (v) => (item.equip!.mana = v));
  }

  const save = document.createElement('button');
  save.textContent = 'Save item';
  save.className = 'primary';
  save.style.marginTop = '14px';
  save.onclick = () => void saveItem();
  host.appendChild(save);

  const where = document.createElement('div');
  where.className = 'hint';
  where.style.marginTop = '8px';
  where.textContent = `Written to content/items/${item.id}.json`;
  host.appendChild(where);

  const problems = document.createElement('div');
  problems.id = 'problems';
  host.appendChild(problems);
}

async function saveItem(): Promise<void> {
  const item = selectedItem();
  if (!item) return;
  const res = await fetch(`${API}/items/${encodeURIComponent(item.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(item),
  });
  const body = (await res.json()) as { saved?: string; problems?: string[]; error?: string };
  if (!res.ok) {
    showProblems(body.problems ?? [body.error ?? 'refused'], '');
    status('not saved', 'bad');
    return;
  }
  dirty = false;
  status(`saved ${body.saved}`, 'good');
  showProblems([], `Saved content/items/${item.id}.json`);
}

type Section = 'core' | 'map' | 'items' | 'classes' | 'progression' | 'round' | 'world'
  | 'garments'
  | 'interactive';
let section: Section = 'core';

interface Soon {
  title: string;
  blurb: string;
  /** What it will read — and therefore what must be finished before it. */
  needs: string[];
  writes: string;
  /** Something that exists TODAY and does part of the job. */
  today?: { text: string; href?: string };
}

/**
 * ⚠ EMPTY, and that is the point.
 *
 * Every section now has a real tool behind it. The map builder embeds the
 * editor that already exists (D-543/544) rather than growing a second one, and
 * `renderSoon` stays because the next unbuilt section should say so in plain
 * words rather than opening an empty editor — the lie D-538 refused for feats.
 */
const SOON: Partial<Record<Section, Soon>> = {};


function renderSoon(): void {
  const host = $('soon');
  host.replaceChildren();
  const spec = SOON[section];
  if (!spec) return;

  const wrap = document.createElement('div');
  wrap.style.cssText = 'max-width:640px;margin:28px auto;padding:0 20px';

  const h = document.createElement('h1');
  h.textContent = spec.title;
  wrap.appendChild(h);

  const flag = document.createElement('div');
  flag.className = 'chip on';
  flag.style.cssText = 'cursor:default;margin-bottom:14px';
  flag.textContent = 'not built yet';
  wrap.appendChild(flag);

  const blurb = document.createElement('p');
  blurb.style.cssText = 'line-height:1.6;margin:0 0 18px';
  blurb.textContent = spec.blurb;
  wrap.appendChild(blurb);

  const nh = document.createElement('h2');
  nh.textContent = 'what has to exist first';
  wrap.appendChild(nh);
  const list = document.createElement('ul');
  list.style.cssText = 'margin:0 0 18px;padding-left:18px;line-height:1.7';
  for (const n of spec.needs) {
    const li = document.createElement('li');
    li.textContent = n;
    list.appendChild(li);
  }
  wrap.appendChild(list);

  const wh = document.createElement('h2');
  wh.textContent = 'it will write';
  wrap.appendChild(wh);
  const writes = document.createElement('div');
  writes.className = 'hint';
  writes.style.cssText = 'font-family:ui-monospace,monospace;margin-bottom:18px';
  writes.textContent = spec.writes;
  wrap.appendChild(writes);

  if (spec.today) {
    const th = document.createElement('h2');
    th.textContent = 'what exists today';
    wrap.appendChild(th);
    const today = document.createElement('div');
    today.className = 'hint';
    today.style.lineHeight = '1.6';
    today.textContent = spec.today.text;
    wrap.appendChild(today);
    if (spec.today.href) {
      const a = document.createElement('a');
      a.href = spec.today.href;
      a.textContent = spec.today.href;
      a.style.cssText = 'color:var(--warm);display:inline-block;margin-top:8px';
      wrap.appendChild(a);
    }
  }
  host.appendChild(wrap);
}

/**
 * Write the three catalogue files, or report which one refused.
 *
 * ⚠ Separated from `saveClass` because the progression editor is not editing a
 * class. It was a side effect of saving a calling, which meant the only way to
 * persist a new feat was to open an unrelated class and save that.
 */
async function saveCatalogue(): Promise<boolean> {
  for (const [which, payload] of [
    ['skills', cat.skills],
    ['feats', cat.feats],
    ['spells', cat.spells],
  ] as const) {
    const r = await fetch(`${API}/catalogue/${which}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const body = (await r.json().catch(() => ({}))) as { issues?: { message: string }[] };
      showProblems(
        (body.issues ?? []).map((i) => i.message),
        '',
      );
      status(`${which} not saved`, 'bad');
      return false;
    }
  }
  catDirty = false;
  return true;
}

/* ------------------------------------------------------- progression ----- */

/**
 * Skills, feats and spells — the three things a player actually PICKS.
 *
 * ⚠ Until this existed they were the only content in the repository with no
 * way to author them. A calling could be gated and a race curated in the tool,
 * and then somebody had to hand-edit `feats.json` to add the feat the gate
 * referred to. The class page could tick WHICH callings may take a feat and
 * could not create one.
 *
 * ⚠ A feat's mechanics come from a CLOSED ENUM (D-538) and this offers exactly
 * that list — never a free-text field. The alternative, a feat whose
 * description implies a mechanic nobody wired, is the commonest way a
 * content-driven game lies to its players, and a dropdown is the difference
 * between an editor and a place to type a wish.
 */
type ProgKind = 'skills' | 'feats' | 'spells';

let progKind: ProgKind = 'skills';
let progPicked: string | null = null;

/** The mechanics a feat may declare. Mirrors `FeatSchema`'s enum exactly. */
const FEAT_EFFECTS = [
  ['carry', 'carrying capacity'],
  ['craft_speed', 'crafting time removed (0.15 = 15% faster)'],
  ['harvest_speed', 'gathering time removed'],
  ['hunger_rate', 'longer between hunger steps'],
  ['thirst_rate', 'longer between thirst steps'],
  ['treat_bonus', 'health restored when treating a wound'],
  ['zombie_cap', 'concurrent animated dead (hard cap 3)'],
  ['extra_attack', 'extra swings in a four-second round'],
] as const;

function progList(): { id: string; name: string }[] {
  if (progKind === 'skills') return cat.skills;
  if (progKind === 'feats') return cat.feats;
  return cat.spells;
}

function renderProgList(): void {
  const host = $('list');
  host.innerHTML = '';
  const tabs = document.createElement('div');
  tabs.className = 'chips';
  for (const k of ['skills', 'feats', 'spells'] as ProgKind[]) {
    const chip = document.createElement('span');
    chip.className = `chip${progKind === k ? ' on' : ''}`;
    chip.textContent = k;
    chip.onclick = () => {
      progKind = k;
      progPicked = null;
      renderProgList();
      renderProgSide();
    };
    tabs.appendChild(chip);
  }
  host.appendChild(tabs);

  const add = document.createElement('button');
  add.textContent = `+ New ${progKind.slice(0, -1)}`;
  add.style.margin = '8px 0';
  add.onclick = () => {
    const id = uniqueProgId();
    if (progKind === 'skills') {
      cat.skills.push({
        id, name: 'New skill', description: 'What it lets you do.',
        group: 'general', creationOnly: false,
      });
    } else if (progKind === 'feats') {
      cat.feats.push({
        id, name: 'New feat', description: 'What it means.',
        classes: [], requiresSkills: {}, minLevel: 1,
      });
    } else {
      cat.spells.push({
        id, name: 'New spell', description: 'What it does.', classes: [], school: 'general',
      });
    }
    progPicked = id;
    catDirty = true;
    markDirty();
    renderProgList();
    renderProgSide();
  };
  host.appendChild(add);

  const save = document.createElement('button');
  save.textContent = 'Save all three';
  save.style.margin = '0 0 8px 6px';
  save.title = 'Writes content/skills, content/feats and content/spells';
  save.onclick = () => {
    void saveCatalogue().then((ok) => {
      if (ok) {
        dirty = false;
        status('saved', 'good');
        showProblems([], 'Saved skills, feats and spells');
      }
    });
  };
  host.appendChild(save);

  for (const entry of progList()) {
    const row = document.createElement('div');
    row.className = `row${progPicked === entry.id ? ' on' : ''}`;
    row.textContent = entry.name;
    row.onclick = () => {
      progPicked = entry.id;
      renderProgList();
      renderProgSide();
    };
    host.appendChild(row);
  }
}

function uniqueProgId(): string {
  const taken = new Set(progList().map((e) => e.id));
  for (let n = 1; ; n++) {
    const id = `${progKind.slice(0, -1)}-${n}`;
    if (!taken.has(id)) return id;
  }
}

function renderProgSide(): void {
  const host = $('side');
  host.innerHTML = '';
  if (!progPicked) {
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent =
      'Skills are allocated at creation; feats and spells are picked there and '
      + 'granted by a class as it levels. Nothing here grants raw power — a '
      + 'level buys access and options (D-538).';
    host.appendChild(hint);
    return;
  }

  if (progKind === 'skills') return renderSkillForm(host);
  if (progKind === 'feats') return renderFeatForm(host);
  return renderSpellForm(host);
}

function progText(
  host: HTMLElement,
  label: string,
  value: string,
  set: (v: string) => void,
  long = false,
): void {
  const el = long ? document.createElement('textarea') : document.createElement('input');
  el.value = value;
  if (long) (el as HTMLTextAreaElement).rows = 3;
  el.style.width = '100%';
  el.onchange = () => {
    set((el as HTMLInputElement).value);
    catDirty = true;
    markDirty();
    renderProgList();
  };
  classField(host, label, el);
}

function deleteProg(host: HTMLElement): void {
  const del = document.createElement('button');
  del.textContent = `Delete this ${progKind.slice(0, -1)}`;
  del.style.marginTop = '12px';
  del.onclick = () => {
    if (progKind === 'skills') cat.skills = cat.skills.filter((s) => s.id !== progPicked);
    else if (progKind === 'feats') cat.feats = cat.feats.filter((f) => f.id !== progPicked);
    else cat.spells = cat.spells.filter((s) => s.id !== progPicked);
    progPicked = null;
    catDirty = true;
    markDirty();
    renderProgList();
    renderProgSide();
  };
  host.appendChild(del);
}

function renderSkillForm(host: HTMLElement): void {
  const skill = cat.skills.find((s) => s.id === progPicked);
  if (!skill) return;
  progText(host, 'Name', skill.name, (v) => { skill.name = v; });
  progText(host, 'Description', skill.description, (v) => { skill.description = v; }, true);
  progText(host, 'Group', skill.group, (v) => { skill.group = v; });

  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = skill.creationOnly;
  box.onchange = () => {
    skill.creationOnly = box.checked;
    catDirty = true;
    markDirty();
  };
  classField(host, 'Creation only', box);
  const note = document.createElement('div');
  note.className = 'hint';
  note.innerHTML =
    '⚠ <b>Creation only</b> is the fence around raw power (D-538): a skill '
    + 'marked this way may be bought at creation and can NEVER be granted by a '
    + 'level, so a hundred-round veteran swings no harder than a first-timer '
    + 'who spent the points. CI rejects any class progression that grants one.';
  host.appendChild(note);
  deleteProg(host);
}

function renderFeatForm(host: HTMLElement): void {
  const feat = cat.feats.find((f) => f.id === progPicked);
  if (!feat) return;
  progText(host, 'Name', feat.name, (v) => { feat.name = v; });
  progText(host, 'Description', feat.description, (v) => { feat.description = v; }, true);

  const lvl = document.createElement('input');
  lvl.type = 'number';
  lvl.min = '1';
  lvl.value = String(feat.minLevel);
  lvl.onchange = () => {
    feat.minLevel = Math.max(1, Number(lvl.value) || 1);
    catDirty = true;
    markDirty();
  };
  classField(host, 'Earliest level', lvl);

  /* ------------------------------------------------------------- effect */
  const eh = document.createElement('h2');
  eh.textContent = 'What it does';
  host.appendChild(eh);
  const enote = document.createElement('div');
  enote.className = 'hint';
  enote.innerHTML =
    '⚠ A CLOSED list (D-538). The server implements every kind here and CI '
    + 'asserts that it does. A feat with <b>no effect</b> is declaring itself '
    + 'flavour rather than hiding that it is — which is the honest option, not '
    + 'a gap.';
  host.appendChild(enote);

  const kind = document.createElement('select');
  const none = document.createElement('option');
  none.value = '';
  none.textContent = 'flavour — no mechanic';
  kind.appendChild(none);
  for (const [k, what] of FEAT_EFFECTS) {
    const o = document.createElement('option');
    o.value = k;
    o.textContent = `${k} — ${what}`;
    kind.appendChild(o);
  }
  kind.value = feat.effect?.kind ?? '';
  kind.style.width = '100%';
  kind.onchange = () => {
    feat.effect = kind.value
      ? { kind: kind.value as NonNullable<typeof feat.effect>['kind'], value: feat.effect?.value ?? 1 }
      : undefined;
    catDirty = true;
    markDirty();
    renderProgSide();
  };
  classField(host, 'Effect', kind);

  if (feat.effect) {
    const val = document.createElement('input');
    val.type = 'number';
    val.step = '0.05';
    val.value = String(feat.effect.value);
    val.onchange = () => {
      if (feat.effect) feat.effect.value = Number(val.value) || 0;
      catDirty = true;
      markDirty();
    };
    classField(host, 'Value', val);
  }

  /* ------------------------------------------------ required skill levels */
  const rh = document.createElement('h2');
  rh.textContent = 'Requires';
  host.appendChild(rh);
  for (const skill of cat.skills) {
    const have = feat.requiresSkills[skill.id] ?? 0;
    const n = document.createElement('input');
    n.type = 'number';
    n.min = '0';
    n.value = String(have);
    n.onchange = () => {
      const v = Math.max(0, Number(n.value) || 0);
      if (v === 0) delete feat.requiresSkills[skill.id];
      else feat.requiresSkills[skill.id] = v;
      catDirty = true;
      markDirty();
    };
    classField(host, skill.name, n);
  }

  const cnote = document.createElement('div');
  cnote.className = 'hint';
  cnote.textContent =
    feat.classes.length === 0
      ? 'Open to every calling. Which callings may take it is edited on the '
        + 'Class definitions page, not here.'
      : `Restricted to: ${feat.classes.join(', ')}. Edited on the class page.`;
  host.appendChild(cnote);
  deleteProg(host);
}

function renderSpellForm(host: HTMLElement): void {
  const spell = cat.spells.find((s) => s.id === progPicked);
  if (!spell) return;
  progText(host, 'Name', spell.name, (v) => { spell.name = v; });
  progText(host, 'Description', spell.description, (v) => { spell.description = v; }, true);
  progText(host, 'School', spell.school, (v) => { spell.school = v; });
  const note = document.createElement('div');
  note.className = 'hint';
  note.innerHTML =
    spell.classes.length === 0
      ? 'Open to every spellcasting calling. Which ones is edited on the Class page.'
      : `Restricted to: ${spell.classes.join(', ')}. Edited on the Class page.`;
  host.appendChild(note);
  const warn = document.createElement('div');
  warn.className = 'hint';
  warn.innerHTML =
    '⚠ Spells are not castable yet — the hotbar shows them greyed and '
    + 'labelled "no casting yet" (D-553). Defining one here is authoring the '
    + 'catalogue, not wiring a verb.';
  host.appendChild(warn);
  deleteProg(host);
}


/* ------------------------------------------------------ round content ---- */

/**
 * Recipes, roamers and objectives — what a round is made of, what walks
 * around in it, and what the antagonist is told to do (D-569).
 *
 * ⚠ These three were the last content with a schema, a validator and no way
 * to author them. A recipe in particular is the one document where hand
 * editing is genuinely dangerous: invariant 2 (D-210) says every item has a
 * consumer, and the commonest way to break it is to repoint the only recipe
 * that ate a material. The document you edited stays perfectly valid, and the
 * BUILD fails somewhere else entirely. So every save here is checked against
 * the graph as it would stand afterwards, and a delete is refused by name.
 *
 * ⚠ Every roamer number in the repository is UNRATIFIED (D-532, D-537). The
 * form puts hp, damage, reach, cadence and loot on one screen precisely so
 * they can be judged against each other rather than one file at a time, which
 * is the shape the stakeholder has to settle them in.
 */
type RoundKind = 'recipes' | 'roamers' | 'objectives';

interface RoundData {
  recipes: RecipeDef[];
  roamers: RoamerDef[];
  objectives: ObjectiveDef[];
  items: { id: string; name: string; category: string; slots: string[] }[];
  nodes: { id: string; yields: string }[];
  npcDescriptors: string[];
  /** Every authored character a creature may be drawn as (D-594). */
  characters: { id: string; name: string; pack: string; whole: boolean }[];
}

let roundKind: RoundKind = 'recipes';
let roundPicked: string | null = null;
let round: RoundData = {
  recipes: [], roamers: [], objectives: [], items: [], nodes: [], npcDescriptors: [],
  characters: [],
};

async function loadRound(): Promise<void> {
  const res = await fetch(`${API}/round`);
  if (!res.ok) {
    status('could not load round content', 'bad');
    return;
  }
  round = (await res.json()) as RoundData;
}

function roundList(): { id: string; name: string }[] {
  if (roundKind === 'recipes') return round.recipes.map((r) => ({ id: r.id, name: r.name }));
  if (roundKind === 'roamers') return round.roamers.map((r) => ({ id: r.id, name: r.descriptor }));
  return round.objectives.map((o) => ({ id: o.id, name: o.name }));
}

function itemName(id: string): string {
  return round.items.find((i) => i.id === id)?.name ?? id;
}

function renderRoundList(): void {
  const host = $('list');
  host.replaceChildren();

  const tabs = document.createElement('div');
  tabs.className = 'chips';
  for (const k of ['recipes', 'roamers', 'objectives'] as RoundKind[]) {
    const chip = document.createElement('span');
    chip.className = `chip${roundKind === k ? ' on' : ''}`;
    chip.textContent = k;
    chip.onclick = () => {
      roundKind = k;
      roundPicked = null;
      renderRoundList();
      renderRoundSide();
      // ⚠ The stage is shown for creatures and hidden for rules (D-594), and
      // that decision is made in `applySection` — so switching KIND has to
      // re-make it. Without this the layout is whatever the last section
      // change left, which is a creature editor with nowhere to look.
      applySection();
    };
    tabs.appendChild(chip);
  }
  host.appendChild(tabs);

  const add = document.createElement('button');
  add.textContent = `+ New ${roundKind.slice(0, -1)}`;
  add.style.margin = '8px 0';
  add.disabled = round.items.length === 0 && roundKind !== 'objectives';
  add.onclick = () => {
    const id = uniqueRoundId();
    if (roundKind === 'recipes') {
      const first = round.items[0]!.id;
      round.recipes.push({
        id, name: 'New recipe', output: first, outputQuantity: 1,
        inputs: [{ item: first, quantity: 1 }], station: 'anywhere', effortTicks: 40,
      });
    } else if (roundKind === 'roamers') {
      round.roamers.push({
        id, descriptor: 'something in the dark', hp: 12, damageMin: 1, damageMax: 3,
        aggroMetres: 9, attackCooldownTicks: 12, moveCooldownTicks: 4, perArea: 4,
        habitat: 'night', xp: 10, loot: [],
      });
    } else {
      round.objectives.push({
        id, name: 'New objective', brief: 'What you are told, in world voice.',
        kind: { type: 'survive' }, minCast: 3, maxCast: null, status: 'planned',
      });
    }
    roundPicked = id;
    renderRoundList();
    renderRoundSide();
  };
  host.appendChild(add);

  for (const entry of roundList()) {
    const row = document.createElement('div');
    row.className = `row${roundPicked === entry.id ? ' on' : ''}`;
    row.textContent = entry.name;
    row.onclick = () => {
      roundPicked = entry.id;
      renderRoundList();
      renderRoundSide();
    };
    host.appendChild(row);
  }
}

function uniqueRoundId(): string {
  const taken = new Set(roundList().map((e) => e.id));
  for (let n = 1; ; n++) {
    const id = `${roundKind.slice(0, -1)}-${n}`;
    if (!taken.has(id)) return id;
  }
}

/** A number field, with the range the schema will enforce anyway. */
function numField(
  host: HTMLElement,
  label: string,
  value: number,
  set: (v: number) => void,
  opts: { min?: number; max?: number; step?: number } = {},
): void {
  const el = document.createElement('input');
  el.type = 'number';
  if (opts.min !== undefined) el.min = String(opts.min);
  if (opts.max !== undefined) el.max = String(opts.max);
  el.step = String(opts.step ?? 1);
  el.value = String(value);
  el.onchange = () => {
    const n = Number(el.value);
    set(Number.isFinite(n) ? n : value);
    markDirty();
    renderRoundSide();
  };
  classField(host, label, el);
}

/**
 * A labelled text box that refreshes whichever list is showing.
 *
 * ⚠ `refresh` is a parameter and not a hard-coded `renderRoundList()`. It was
 * hard-coded, and the garment editor reuses this for its name field — so
 * renaming a garment redrew the LIST pane as the recipe list while the side
 * pane still showed the garment. Nothing threw; the tool simply displayed two
 * different editors at once, which reads as a rendering glitch rather than as
 * one function reaching into another screen.
 */
function textField(
  host: HTMLElement,
  label: string,
  value: string,
  set: (v: string) => void,
  long = false,
  refresh: () => void = renderRoundList,
): void {
  const el = long ? document.createElement('textarea') : document.createElement('input');
  el.value = value;
  if (long) (el as HTMLTextAreaElement).rows = 3;
  el.style.width = '100%';
  el.onchange = () => {
    set((el as HTMLInputElement).value);
    markDirty();
    refresh();
  };
  classField(host, label, el);
}

/** A dropdown over the item library, which is never a free-text box. */
function itemPicker(value: string, set: (v: string) => void): HTMLSelectElement {
  const el = document.createElement('select');
  for (const item of round.items) {
    const o = document.createElement('option');
    o.value = item.id;
    o.textContent = `${item.name} (${item.category})`;
    el.appendChild(o);
  }
  el.value = value;
  el.onchange = () => {
    set(el.value);
    markDirty();
    renderRoundSide();
  };
  return el;
}

function roundHint(host: HTMLElement, html: string): void {
  const el = document.createElement('div');
  el.className = 'hint';
  el.style.cssText = 'line-height:1.5;margin:4px 0 10px';
  el.innerHTML = html;
  host.appendChild(el);
}

function renderRoundSide(): void {
  const host = $('side');
  host.replaceChildren();
  if (!roundPicked) {
    roundHint(
      host,
      'A round is a crafting graph, a set of things that walk about in it, and '
      + 'an order for the antagonist. ⚠ Every number in a roamer is '
      + '<b>unratified</b> — they are on one screen so they can be judged '
      + 'against each other.',
    );
    return;
  }
  if (roundKind === 'recipes') return renderRecipeForm(host);
  if (roundKind === 'roamers') return renderRoamerForm(host);
  return renderObjectiveForm(host);
}

function renderRecipeForm(host: HTMLElement): void {
  const r = round.recipes.find((x) => x.id === roundPicked);
  if (!r) return;
  textField(host, 'Name', r.name, (v) => { r.name = v; });

  const oh = document.createElement('h2');
  oh.textContent = 'Makes';
  host.appendChild(oh);
  classField(host, 'Item', itemPicker(r.output, (v) => { r.output = v; }));
  numField(host, 'How many', r.outputQuantity, (v) => { r.outputQuantity = Math.max(1, Math.round(v)); }, { min: 1 });

  const ih = document.createElement('h2');
  ih.textContent = 'Out of';
  host.appendChild(ih);
  roundHint(
    host,
    '⚠ Being the only recipe that consumes a material is what keeps that '
    + 'material out of the orphan list (D-210, invariant 2). Repointing this '
    + 'is refused if it would strand one — with the name of the item.',
  );
  for (const [i, input] of r.inputs.entries()) {
    const row = document.createElement('div');
    row.className = 'kitrow';
    const pick = itemPicker(input.item, (v) => { input.item = v; });
    const qty = document.createElement('input');
    qty.type = 'number';
    qty.min = '1';
    qty.value = String(input.quantity);
    qty.style.width = '4em';
    qty.onchange = () => {
      input.quantity = Math.max(1, Number(qty.value) || 1);
      markDirty();
    };
    const drop = document.createElement('span');
    drop.className = 'chip';
    drop.textContent = '−';
    drop.title = r.inputs.length > 1 ? 'Remove' : 'A recipe must consume something';
    if (r.inputs.length > 1) {
      drop.onclick = () => {
        r.inputs.splice(i, 1);
        markDirty();
        renderRoundSide();
      };
    } else {
      drop.style.opacity = '0.4';
    }
    row.append(pick, qty, drop);
    host.appendChild(row);
  }
  const addIn = document.createElement('button');
  addIn.textContent = '+ Add an ingredient';
  addIn.style.margin = '6px 0 12px';
  addIn.onclick = () => {
    r.inputs.push({ item: round.items[0]!.id, quantity: 1 });
    markDirty();
    renderRoundSide();
  };
  host.appendChild(addIn);

  const wh = document.createElement('h2');
  wh.textContent = 'Work';
  host.appendChild(wh);
  const st = document.createElement('select');
  for (const station of CRAFT_STATIONS) {
    const o = document.createElement('option');
    o.value = station;
    o.textContent = station;
    st.appendChild(o);
  }
  st.value = r.station;
  st.onchange = () => {
    r.station = st.value as typeof r.station;
    markDirty();
  };
  classField(host, 'Where', st);
  numField(host, 'Effort (ticks)', r.effortTicks, (v) => { r.effortTicks = Math.max(1, Math.round(v)); }, { min: 1 });
  roundHint(
    host,
    `${(r.effortTicks / 10).toFixed(1)} seconds at 10Hz, before skills. `
    + '<code>craft</code> and <code>survival</code> shorten it, capped at half '
    + '(D-538). Work is interruptible: moving or being struck cancels it.',
  );
  textField(host, 'Notes', r.notes ?? '', (v) => { r.notes = v || undefined; }, true);
  roundButtons(host, r.id);
}

function renderRoamerForm(host: HTMLElement): void {
  const r = round.roamers.find((x) => x.id === roundPicked);
  if (!r) return;
  // ⚠ Shown on SELECT, not only when the picker changes. Choosing a creature
  // and being shown whatever was last on the stage is the defect D-570 hit in
  // the garment editor — "selecting a garment did not show it", in the one
  // editor whose whole premise is looking.
  if (creatureShown !== r.character) void previewCreature(r.character ?? null);
  textField(host, 'Descriptor', r.descriptor, (v) => { r.descriptor = v; });
  roundHint(host, 'What a player is told they are looking at. There is no other name.');

  const hh = document.createElement('h2');
  hh.textContent = 'Where it lives';
  host.appendChild(hh);
  const hab = document.createElement('select');
  for (const [value, label] of [
    ['night', 'night — outdoor wilderness, out at dusk, gone by dawn'],
    ['dungeon', 'dungeon — a named floor, all round, never leaves'],
    ['guard', 'guard — the town watch, day and night, hunts only what it saw'],
  ] as const) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    hab.appendChild(o);
  }
  hab.value = r.habitat;
  hab.style.width = '100%';
  hab.onchange = () => {
    r.habitat = hab.value as typeof r.habitat;
    if (r.habitat !== 'dungeon') r.floor = undefined;
    else r.floor ??= 1;
    // ⚠ A guard that pays is a farming strategy, not a watch (D-552). The
    // save refuses it; clearing it here means the form never shows a state
    // the server would reject.
    if (r.habitat === 'guard') {
      r.xp = 0;
      r.loot = [];
    }
    markDirty();
    renderRoundSide();
  };
  classField(host, 'Habitat', hab);

  if (r.habitat === 'dungeon') {
    numField(host, 'Floor', r.floor ?? 1, (v) => { r.floor = Math.max(1, Math.round(v)); }, { min: 1 });
    roundHint(host, 'Floors open on successive round-days (D-535). Deeper is worth more and hits harder.');
  }
  if (r.habitat === 'guard') {
    roundHint(
      host,
      '⚠ A guard is worth <b>zero xp and carries nothing</b>, and those fields '
      + 'are gone rather than greyed. Paying for a guard kill would make '
      + 'murdering the watch the safest income in the game (D-552).',
    );
  }

  const lh = document.createElement('h2');
  lh.textContent = 'What it looks like';
  host.appendChild(lh);

  const pick = document.createElement('select');
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '(no model — drawn from the appearance seed)';
  pick.appendChild(none);
  for (const c of round.characters) {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = `${c.name}${c.whole ? '' : '  (assembled)'}  ·  ${c.pack}`;
    pick.appendChild(o);
  }
  pick.value = r.character ?? '';
  pick.style.width = '100%';
  pick.onchange = () => {
    r.character = pick.value || undefined;
    if (r.character && r.heightMetres === undefined) r.heightMetres = 1.7;
    if (!r.character) r.heightMetres = undefined;
    markDirty();
    // ⚠ ONE call, not two. `renderRoundSide` redraws the form, and the form
    // asks for the preview itself — calling it here as well started two loads
    // of two different bodies, and BOTH were added to the stage.
    renderRoundSide();
  };
  classField(host, 'Drawn as', pick);

  if (r.character) {
    numField(host, 'Stands (metres)', r.heightMetres ?? 1.7,
      (v) => { r.heightMetres = Math.min(4, Math.max(0.3, v)); },
      { min: 0.3, max: 4, step: 0.05 });
    roundHint(
      host,
      'The art is authored at one size — the pack\'s goblin is as tall as its '
      + 'knight — so height is set HERE, per creature. It also reaches the '
      + 'descriptor pipeline, so a thing a player is told is towering is.',
    );
  } else {
    roundHint(
      host,
      '⚠ With no model this is drawn from its appearance seed, which is to say '
      + 'as a random townsman. That is what every roamer in the game did until '
      + 'D-594: "something man-shaped that does not walk like a man" rendered '
      + 'as a man. Leave it only when the art genuinely has nothing — the packs '
      + 'ship no four-legged anything, so the dog and the crawler still wait.',
    );
  }

  const fh = document.createElement('h2');
  fh.textContent = 'Fighting';
  host.appendChild(fh);
  numField(host, 'Health', r.hp, (v) => { r.hp = Math.max(1, Math.round(v)); }, { min: 1 });
  numField(host, 'Damage — least', r.damageMin, (v) => { r.damageMin = Math.max(0, Math.round(v)); }, { min: 0 });
  numField(host, 'Damage — most', r.damageMax, (v) => { r.damageMax = Math.max(1, Math.round(v)); }, { min: 1 });
  if (r.damageMax < r.damageMin) {
    roundHint(host, '⚠ The most must not be below the least — the save will refuse this.');
  }
  numField(host, 'Notices you at (metres)', r.aggroMetres, (v) => { r.aggroMetres = Math.max(1, v); }, { min: 1, step: 0.5 });
  numField(host, 'Swings every (ticks)', r.attackCooldownTicks, (v) => { r.attackCooldownTicks = Math.max(1, Math.round(v)); }, { min: 1 });
  numField(host, 'Steps every (ticks)', r.moveCooldownTicks, (v) => { r.moveCooldownTicks = Math.max(1, Math.round(v)); }, { min: 1 });
  roundHint(
    host,
    `Swings every ${(r.attackCooldownTicks / 10).toFixed(1)}s for `
    + `${r.damageMin}–${r.damageMax}, so about `
    + `<b>${(((r.damageMin + r.damageMax) / 2) * (10 / r.attackCooldownTicks)).toFixed(1)} a second</b> `
    + 'if it stays on you. ⚠ Every one of these is unratified — the number '
    + 'that matters is this one against a mid-round character, and only play '
    + 'settles it.',
  );
  numField(host, 'How many per area', r.perArea, (v) => { r.perArea = Math.max(0, Math.round(v)); }, { min: 0 });

  const rh = document.createElement('h2');
  rh.textContent = 'What killing it is worth';
  host.appendChild(rh);
  if (r.habitat === 'guard') {
    roundHint(host, 'Nothing, and that is a rule rather than a number.');
  } else {
    numField(host, 'Experience', r.xp, (v) => { r.xp = Math.max(0, Math.round(v)); }, { min: 0 });
    for (const [i, drop] of r.loot.entries()) {
      const row = document.createElement('div');
      row.className = 'kitrow';
      const pick = itemPicker(drop.item, (v) => { drop.item = v; });
      const qty = document.createElement('input');
      qty.type = 'number';
      qty.min = '1';
      qty.value = String(drop.quantity);
      qty.style.width = '3.5em';
      qty.onchange = () => {
        drop.quantity = Math.max(1, Number(qty.value) || 1);
        markDirty();
      };
      const chance = document.createElement('input');
      chance.type = 'number';
      chance.min = '0';
      chance.max = '1';
      chance.step = '0.05';
      chance.value = String(drop.chance);
      chance.style.width = '4.5em';
      chance.title = 'Chance, 0 to 1. Rolled once per kill.';
      chance.onchange = () => {
        drop.chance = Math.min(1, Math.max(0, Number(chance.value) || 0));
        markDirty();
      };
      const del = document.createElement('span');
      del.className = 'chip';
      del.textContent = '−';
      del.onclick = () => {
        r.loot.splice(i, 1);
        markDirty();
        renderRoundSide();
      };
      row.append(pick, qty, chance, del);
      host.appendChild(row);
    }
    const addLoot = document.createElement('button');
    addLoot.textContent = '+ Add to what it carries';
    addLoot.style.margin = '6px 0';
    addLoot.disabled = round.items.length === 0;
    addLoot.onclick = () => {
      r.loot.push({ item: round.items[0]!.id, quantity: 1, chance: 1 });
      markDirty();
      renderRoundSide();
    };
    host.appendChild(addLoot);
    roundHint(
      host,
      'It leaves a <b>body holding this</b>, where it fell (D-554) — not a '
      + 'payment to the killer. A corpse is evidence, and looting one where it '
      + 'dropped is a thing other people can watch you do.',
    );
  }
  textField(host, 'Notes', r.notes ?? '', (v) => { r.notes = v || undefined; }, true);
  roundButtons(host, r.id);
}

function renderObjectiveForm(host: HTMLElement): void {
  const o = round.objectives.find((x) => x.id === roundPicked);
  if (!o) return;
  textField(host, 'Name', o.name, (v) => { o.name = v; });
  textField(host, 'The briefing', o.brief, (v) => { o.brief = v; }, true);
  roundHint(
    host,
    'Read by the <b>antagonist alone</b>, at round start. It is the only '
    + 'briefing they get, so it carries the fiction as well as the '
    + 'instruction. ⚠ Nothing scores the cast for guessing right (D-303).',
  );

  const kh = document.createElement('h2');
  kh.textContent = 'What it takes to win';
  host.appendChild(kh);
  const kind = document.createElement('select');
  for (const [value, label] of [
    ['kill_npc', 'kill a named NPC — the strongest objective at a small cast'],
    ['kill_player', 'kill one of the cast, drawn at random'],
    ['survive', 'simply live to the end'],
    ['steal', 'take a specific item out of the round'],
    ['starve', 'deny the cast food and water'],
  ] as const) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    kind.appendChild(opt);
  }
  kind.value = o.kind.type;
  kind.style.width = '100%';
  kind.onchange = () => {
    const t = kind.value;
    o.kind = t === 'kill_npc'
      ? { type: 'kill_npc', descriptor: round.npcDescriptors[0] ?? 'the tavern keeper' }
      : t === 'steal'
        ? { type: 'steal', itemTemplate: round.items[0]?.id ?? 'tarnished-signet' }
        : { type: t as 'kill_player' | 'survive' | 'starve' };
    markDirty();
    renderRoundSide();
  };
  classField(host, 'Kind', kind);

  if (o.kind.type === 'kill_npc') {
    const kindRef = o.kind;
    const el = document.createElement('input');
    el.value = kindRef.descriptor;
    el.setAttribute('list', 'npc-descriptors');
    el.style.width = '100%';
    el.onchange = () => {
      kindRef.descriptor = el.value;
      markDirty();
    };
    classField(host, 'Target descriptor', el);
    let list = document.getElementById('npc-descriptors') as HTMLDataListElement | null;
    if (!list) {
      list = document.createElement('datalist');
      list.id = 'npc-descriptors';
      document.body.appendChild(list);
    }
    list.replaceChildren();
    for (const d of round.npcDescriptors) {
      const opt = document.createElement('option');
      opt.value = d;
      list.appendChild(opt);
    }
    roundHint(
      host,
      '⚠ Matched on this <b>exact string</b> and nothing else — the round engine '
      + 'does a set membership test on the descriptor of whatever died. The '
      + 'suggestions are descriptors found by reading the area scripts: a '
      + 'PARTIAL list, because NPCs are spawned by Lua rather than declared, '
      + 'so the save <b>cannot</b> verify this for you.',
    );
    // ⚠ A warning, never a refusal. The list of descriptors is incomplete by
    // construction, so refusing on it would reject every objective aimed at
    // an NPC spawned by a DM event or a code path this cannot read. But an
    // exact-match target that matches nothing anybody has written down is
    // worth saying out loud: it reads as good prose and can never complete,
    // and nothing downstream will ever mention it again.
    if (!round.npcDescriptors.includes(kindRef.descriptor)) {
      const warn = document.createElement('div');
      warn.className = 'hint';
      warn.style.cssText = 'line-height:1.5;margin:4px 0 10px;color:#c98f6a';
      warn.innerHTML =
        '⚠ <b>No area script spawns an NPC described exactly this way.</b> '
        + (round.npcDescriptors.length
          ? `The only one found is <i>${round.npcDescriptors.join('</i>, <i>')}</i>. `
          : 'No descriptors were found at all. ')
        + 'If nothing else spawns this target, an antagonist dealt this '
        + 'objective cannot win — check it before leaving the status on '
        + '<b>live</b>.';
      host.appendChild(warn);
    }
  }
  if (o.kind.type === 'steal') {
    const kindRef = o.kind;
    classField(host, 'Item', itemPicker(kindRef.itemTemplate, (v) => { kindRef.itemTemplate = v; }));
    roundHint(
      host,
      `Naming <b>${itemName(kindRef.itemTemplate)}</b> here is also what keeps `
      + 'it out of the orphan list — it is reached by being stolen rather than '
      + 'made (D-210).',
    );
  }

  const ch = document.createElement('h2');
  ch.textContent = 'Cast';
  host.appendChild(ch);
  numField(host, 'Smallest cast', o.minCast, (v) => { o.minCast = Math.max(2, Math.round(v)); }, { min: 2 });
  const cap = document.createElement('input');
  cap.type = 'number';
  cap.min = '2';
  cap.placeholder = 'no ceiling';
  cap.value = o.maxCast === null ? '' : String(o.maxCast);
  cap.onchange = () => {
    o.maxCast = cap.value === '' ? null : Math.max(2, Math.round(Number(cap.value) || 2));
    markDirty();
    renderRoundSide();
  };
  classField(host, 'Largest cast', cap);

  const sh = document.createElement('h2');
  sh.textContent = 'Status';
  host.appendChild(sh);
  const st = document.createElement('select');
  for (const [value, label] of [
    ['live', 'live — may be dealt to an antagonist'],
    ['planned', 'planned — authored ahead of the system that would resolve it'],
  ] as const) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    st.appendChild(opt);
  }
  st.value = o.status;
  st.style.width = '100%';
  st.onchange = () => {
    o.status = st.value as typeof o.status;
    markDirty();
    renderRoundSide();
  };
  classField(host, 'Status', st);
  roundHint(
    host,
    '⚠ A round cannot start without <b>one live objective playable at the '
    + 'minimum cast of three</b>. Narrowing or shelving the last one is a '
    + 'legal edit to a legal document that makes the lobby fill and never '
    + 'start, so the save refuses it.',
  );
  textField(host, 'Notes', o.notes ?? '', (v) => { o.notes = v || undefined; }, true);
  roundButtons(host, o.id);
}

/** Save and delete, and the place the server's refusal is shown. */
function roundButtons(host: HTMLElement, id: string): void {
  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;gap:8px;margin-top:16px';

  const save = document.createElement('button');
  save.textContent = 'Save';
  save.onclick = () => void saveRound(id);

  const del = document.createElement('button');
  del.textContent = 'Delete';
  del.onclick = () => void deleteRound(id);

  bar.append(save, del);
  host.appendChild(bar);
}

function roundDoc(id: string): unknown {
  if (roundKind === 'recipes') return round.recipes.find((r) => r.id === id);
  if (roundKind === 'roamers') return round.roamers.find((r) => r.id === id);
  return round.objectives.find((o) => o.id === id);
}

async function saveRound(id: string): Promise<void> {
  const doc = roundDoc(id);
  if (!doc) return;
  const res = await fetch(`${API}/round/${roundKind}/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(doc),
  });
  const body = (await res.json().catch(() => ({}))) as {
    saved?: string; problems?: string[]; issues?: { message: string }[]; error?: string;
  };
  if (!res.ok) {
    const lines = body.problems ?? (body.issues ?? []).map((i) => i.message);
    showProblems(lines.length ? lines : [body.error ?? 'refused'], '');
    status('not saved', 'bad');
    return;
  }
  dirty = false;
  status(`saved ${id}`, 'good');
  showProblems([], `Saved content/${roundKind}/${id}.json`);
}

async function deleteRound(id: string): Promise<void> {
  const res = await fetch(`${API}/round/${roundKind}/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  const body = (await res.json().catch(() => ({}))) as { problems?: string[]; error?: string };
  if (!res.ok) {
    // ⚠ This is the interesting failure, not an inconvenience: deleting the
    // one recipe that consumed a material is a clean delete and a broken
    // build, and the refusal names the item that would be stranded.
    showProblems(body.problems ?? [body.error ?? 'refused'], '');
    status('not deleted', 'bad');
    return;
  }
  roundPicked = null;
  await loadRound();
  renderRoundList();
  renderRoundSide();
  status(`deleted ${id}`, 'good');
}


/* ------------------------------------------ speech, sound and gesture ---- */

/**
 * Sound cues, the emote lexicon and the languages (D-569).
 *
 * Three array files that shape how the world is heard rather than how it is
 * fought, and the last content with no editor at all.
 *
 * ⚠ The split between sampled and synthesised sound is an INVARIANT, not a
 * preference (D-541): samples play for what you can SEE, the synthesised cue
 * plays for what you can only hear. A death cry that played as a sample
 * through a wall would hand back the identity D-531 deliberately withheld —
 * so the cue list is about what a thing sounds like, never about who made it.
 *
 * ⚠ The emote lexicon's KEYS are closed on both sides: a posture the client
 * cannot hold and a transient it cannot play are dropdowns, not text boxes.
 * The synonyms are the open half, and they are the half worth authoring —
 * "genuflects" reaching `kneeling` is the whole point of the system.
 */
type WorldKind = 'sounds' | 'emotes' | 'languages';

interface WorldData {
  sounds: SoundCueDef[];
  lexicon: EmoteLexicon;
  languages: Language[];
  audioFiles: string[];
  postures: string[];
  transients: string[];
  ambienceInUse: [string, string][];
}

let worldKind: WorldKind = 'sounds';
let worldPicked: string | null = null;
let world: WorldData = {
  sounds: [], lexicon: { negators: [], postures: {}, transients: {} }, languages: [],
  audioFiles: [], postures: [], transients: [], ambienceInUse: [],
};

async function loadWorld(): Promise<void> {
  const res = await fetch(`${API}/world`);
  if (!res.ok) {
    status('could not load world content', 'bad');
    return;
  }
  world = (await res.json()) as WorldData;
}

function renderWorldList(): void {
  const host = $('list');
  host.replaceChildren();

  const tabs = document.createElement('div');
  tabs.className = 'chips';
  for (const [k, label] of [
    ['sounds', 'sound cues'],
    ['emotes', 'emotes'],
    ['languages', 'languages'],
  ] as [WorldKind, string][]) {
    const chip = document.createElement('span');
    chip.className = `chip${worldKind === k ? ' on' : ''}`;
    chip.textContent = label;
    chip.onclick = () => {
      worldKind = k;
      worldPicked = null;
      renderWorldList();
      renderWorldSide();
    };
    tabs.appendChild(chip);
  }
  host.appendChild(tabs);

  // ⚠ The emote lexicon is ONE document, not a list of them. It gets no list
  // pane and no "new" button, because there is nothing to pick between.
  if (worldKind === 'emotes') {
    const note = document.createElement('div');
    note.className = 'hint';
    note.style.cssText = 'margin:10px 0;line-height:1.5';
    note.textContent =
      'One lexicon for the whole world. Postures persist until you move; '
      + 'transients play once. Text that matches nothing is not an error — it '
      + 'renders as plain emote prose.';
    host.appendChild(note);
    return;
  }

  const add = document.createElement('button');
  add.textContent = worldKind === 'sounds' ? '+ New cue' : '+ New language';
  add.style.margin = '8px 0';
  add.onclick = () => {
    if (worldKind === 'sounds') {
      const id = uniqueWorldId(world.sounds.map((c) => c.id), 'cue');
      world.sounds.push({
        id, kind: 'effect', files: [], split: false, trim: 1, status: 'planned',
        description: 'What it is for, in words.',
      });
      worldPicked = id;
    } else {
      const id = uniqueWorldId(world.languages.map((l) => l.id), 'tongue');
      world.languages.push({ id, name: 'New tongue', description: 'Who speaks it, and where.' });
      worldPicked = id;
    }
    markDirty();
    renderWorldList();
    renderWorldSide();
  };
  host.appendChild(add);

  const rows = worldKind === 'sounds'
    ? world.sounds.map((c) => ({ id: c.id, name: `${c.id}  ·  ${c.kind}` }))
    : world.languages.map((l) => ({ id: l.id, name: l.name }));
  for (const entry of rows) {
    const row = document.createElement('div');
    row.className = `row${worldPicked === entry.id ? ' on' : ''}`;
    row.textContent = entry.name;
    row.onclick = () => {
      worldPicked = entry.id;
      renderWorldList();
      renderWorldSide();
    };
    host.appendChild(row);
  }
}

function uniqueWorldId(taken: readonly string[], stem: string): string {
  const have = new Set(taken);
  for (let n = 1; ; n++) {
    const id = `${stem}-${n}`;
    if (!have.has(id)) return id;
  }
}

function renderWorldSide(): void {
  const host = $('side');
  host.replaceChildren();
  if (worldKind === 'emotes') return renderLexiconForm(host);
  if (!worldPicked) {
    roundHint(
      host,
      worldKind === 'sounds'
        ? 'Cues are content (D-541). A cue naming a file that is not on disk is '
          + '<b>silent in play</b> and looks exactly like a cue nobody wired, so '
          + 'the save refuses it rather than warning.'
        : 'Speech in a language a listener does not know arrives scrambled — '
          + 'deterministically per word, so recurring words stay recognisable '
          + 'and become roleplay material of their own.',
    );
    return;
  }
  if (worldKind === 'sounds') return renderSoundForm(host);
  return renderLanguageForm(host);
}

function renderSoundForm(host: HTMLElement): void {
  const cue = world.sounds.find((c) => c.id === worldPicked);
  if (!cue) return;

  const idField = document.createElement('input');
  idField.value = cue.id;
  idField.style.width = '100%';
  idField.onchange = () => {
    const next = idField.value.trim();
    if (!next || next === cue.id) return;
    // ⚠ Renaming a cue an area names breaks that area, and the area is not
    // open here. Say so before the save does.
    const users = world.ambienceInUse.filter(([, c]) => c === cue.id).map(([a]) => a);
    cue.id = next;
    if (users.length) {
      showProblems(
        users.map((a) => `area '${a}' still names the old cue — repoint it in the map builder`),
        '',
      );
    }
    if (worldPicked !== null) worldPicked = next;
    markDirty();
    renderWorldList();
    renderWorldSide();
  };
  classField(host, 'Id', idField);

  const desc = document.createElement('textarea');
  desc.rows = 2;
  desc.value = cue.description;
  desc.style.width = '100%';
  desc.onchange = () => {
    cue.description = desc.value;
    markDirty();
  };
  classField(host, 'What it is for', desc);

  const kind = document.createElement('select');
  for (const [value, label] of [
    ['effect', 'effect — must cut through'],
    ['ambience', 'ambience — a bed, must not compete with a death cry'],
    ['music', 'music'],
  ] as const) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    kind.appendChild(o);
  }
  kind.value = cue.kind;
  kind.style.width = '100%';
  kind.onchange = () => {
    cue.kind = kind.value as typeof cue.kind;
    markDirty();
    renderWorldList();
    renderWorldSide();
  };
  classField(host, 'Kind', kind);
  roundHint(
    host,
    'The kind sets the loudness target the client normalises to, in the '
    + 'browser at load — half the drop is ogg, mp3 and flac and nothing on the '
    + 'build machine decodes those (D-541).',
  );

  const fh = document.createElement('h2');
  fh.textContent = 'Files';
  host.appendChild(fh);
  for (const [i, file] of cue.files.entries()) {
    const row = document.createElement('div');
    row.className = 'kitrow';
    const pick = document.createElement('select');
    // The file currently named is offered even if it is missing, or changing
    // anything else about the cue would silently repoint it at whatever
    // happened to be first on disk.
    const options = world.audioFiles.includes(file)
      ? world.audioFiles
      : [file, ...world.audioFiles];
    for (const f of options) {
      const o = document.createElement('option');
      o.value = f;
      o.textContent = world.audioFiles.includes(f) ? f : `${f}  — NOT ON DISK`;
      pick.appendChild(o);
    }
    pick.value = file;
    pick.style.flex = '1';
    pick.onchange = () => {
      cue.files[i] = pick.value;
      markDirty();
      renderWorldSide();
    };
    const del = document.createElement('span');
    del.className = 'chip';
    del.textContent = '−';
    del.onclick = () => {
      cue.files.splice(i, 1);
      markDirty();
      renderWorldSide();
    };
    row.append(pick, del);
    host.appendChild(row);
  }
  const addFile = document.createElement('button');
  addFile.textContent = '+ Add a file';
  addFile.style.margin = '6px 0';
  addFile.disabled = world.audioFiles.length === 0;
  addFile.onclick = () => {
    cue.files.push(world.audioFiles[0]!);
    markDirty();
    renderWorldSide();
  };
  host.appendChild(addFile);
  const missing = cue.files.filter((f) => !world.audioFiles.includes(f));
  if (missing.length) {
    roundHint(host, `⚠ Not on disk: <b>${missing.join(', ')}</b>. The save will refuse this — run <code>tools/src/build-audio.py</code>.`);
  }
  if (cue.files.length === 0) {
    roundHint(host, '⚠ A cue with no files is refused by the schema. Give it one, or delete the cue.');
  }

  const split = document.createElement('input');
  split.type = 'checkbox';
  split.checked = cue.split;
  split.onchange = () => {
    cue.split = split.checked;
    markDirty();
    renderWorldSide();
  };
  classField(host, 'Several takes in one file', split);
  if (cue.split) {
    roundHint(
      host,
      'Takes are found by silence, in the browser at load. The stakeholder’s '
      + 'drop has 19 in one death file and 7 in a hurt ogg.',
    );
  }

  const trim = document.createElement('input');
  trim.type = 'number';
  trim.min = '0';
  trim.max = '4';
  trim.step = '0.05';
  trim.value = String(cue.trim);
  trim.onchange = () => {
    cue.trim = Math.min(4, Math.max(0, Number(trim.value) || 0));
    markDirty();
  };
  classField(host, 'Trim', trim);
  roundHint(host, 'Applied <b>after</b> normalisation. 1 is exactly the category target.');

  const st = document.createElement('select');
  for (const [value, label] of [
    ['live', 'live — plays'],
    ['planned', 'planned — the action it belongs to does not exist yet'],
  ] as const) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    st.appendChild(o);
  }
  st.value = cue.status;
  st.style.width = '100%';
  st.onchange = () => {
    cue.status = st.value as typeof cue.status;
    markDirty();
  };
  classField(host, 'Status', st);
  roundHint(
    host,
    '⚠ <b>planned</b> is the honest option, not a gap. Wiring a cue to a '
    + 'near-miss action is the audio version of a feat whose text implies a '
    + 'mechanic nobody built (D-538).',
  );

  const del = document.createElement('button');
  del.textContent = 'Delete this cue';
  del.style.marginTop = '14px';
  del.onclick = () => {
    world.sounds = world.sounds.filter((c) => c.id !== cue.id);
    worldPicked = null;
    markDirty();
    renderWorldList();
    renderWorldSide();
  };
  host.appendChild(del);
  worldSaveBar(host);
}

function renderLanguageForm(host: HTMLElement): void {
  const lang = world.languages.find((l) => l.id === worldPicked);
  if (!lang) return;
  const isCommon = lang.id === 'common';

  const idField = document.createElement('input');
  idField.value = lang.id;
  idField.disabled = isCommon;
  idField.style.width = '100%';
  idField.onchange = () => {
    lang.id = idField.value.trim() || lang.id;
    worldPicked = lang.id;
    markDirty();
    renderWorldList();
    renderWorldSide();
  };
  classField(host, 'Id', idField);

  const name = document.createElement('input');
  name.value = lang.name;
  name.style.width = '100%';
  name.onchange = () => {
    lang.name = name.value;
    markDirty();
    renderWorldList();
  };
  classField(host, 'Name', name);

  const desc = document.createElement('textarea');
  desc.rows = 3;
  desc.value = lang.description;
  desc.style.width = '100%';
  desc.onchange = () => {
    lang.description = desc.value;
    markDirty();
  };
  classField(host, 'Description', desc);

  if (isCommon) {
    roundHint(
      host,
      '⚠ <b>common</b> cannot be renamed or removed, and the save refuses a '
      + 'list without it. It is the tongue everybody is assumed to share — '
      + 'without it every line of speech in the world scrambles for every '
      + 'listener.',
    );
  } else {
    const del = document.createElement('button');
    del.textContent = 'Delete this language';
    del.style.marginTop = '14px';
    del.onclick = () => {
      world.languages = world.languages.filter((l) => l.id !== lang.id);
      worldPicked = null;
      markDirty();
      renderWorldList();
      renderWorldSide();
    };
    host.appendChild(del);
  }
  worldSaveBar(host);
}

function renderLexiconForm(host: HTMLElement): void {
  const lex = world.lexicon;

  const nh = document.createElement('h2');
  nh.textContent = 'Negators';
  host.appendChild(nh);
  roundHint(
    host,
    '⚠ Words that CANCEL a match that follows them: <i>*doesn’t flinch*</i> '
    + 'must not flinch. Without these the lexicon plays the opposite of what '
    + 'was written, which is worse than playing nothing.',
  );
  wordList(host, lex.negators, (next) => { lex.negators = next; });

  for (const [title, keys, table, note] of [
    [
      'Postures',
      world.postures,
      lex.postures as Record<string, string[]>,
      'Held until you move. The key is what the client can actually hold — a '
      + 'closed list, because a posture nobody implemented would be text that '
      + 'promises a body that never changes.',
    ],
    [
      'Gestures',
      world.transients,
      lex.transients as Record<string, string[]>,
      'Played once. Same closed list, same reason.',
    ],
  ] as [string, string[], Record<string, string[]>, string][]) {
    const h = document.createElement('h2');
    h.textContent = title;
    host.appendChild(h);
    roundHint(host, note);
    for (const key of keys) {
      const label = document.createElement('div');
      label.style.cssText = 'margin:10px 0 2px;color:var(--warm);font-size:12px';
      label.textContent = key;
      host.appendChild(label);
      wordList(host, table[key] ?? [], (next) => {
        if (next.length) table[key] = next;
        else delete table[key];
      });
    }
  }
  worldSaveBar(host);
}

/**
 * A comma-separated set of words, edited as text.
 *
 * ⚠ Deliberately one box rather than a row of chips with plus buttons. These
 * are lists of thirty synonyms typed in one sitting, and a control that costs
 * a click per word is a control nobody fills in — which shows up as a lexicon
 * that matches "kneels" and not "genuflects".
 */
function wordList(host: HTMLElement, words: readonly string[], set: (next: string[]) => void): void {
  const el = document.createElement('textarea');
  el.rows = 2;
  el.style.width = '100%';
  el.value = words.join(', ');
  el.placeholder = 'comma separated';
  el.onchange = () => {
    set(
      el.value
        .split(',')
        .map((w) => w.trim())
        .filter(Boolean),
    );
    markDirty();
  };
  host.appendChild(el);
}

function worldSaveBar(host: HTMLElement): void {
  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;gap:8px;margin-top:18px';
  const save = document.createElement('button');
  save.textContent = `Save ${worldKind}`;
  save.onclick = () => void saveWorld();
  bar.appendChild(save);
  host.appendChild(bar);
}

async function saveWorld(): Promise<void> {
  const payload = worldKind === 'sounds'
    ? world.sounds
    : worldKind === 'languages'
      ? world.languages
      : world.lexicon;
  const res = await fetch(`${API}/world/${worldKind}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = (await res.json().catch(() => ({}))) as {
    problems?: string[]; issues?: { message: string }[]; error?: string;
  };
  if (!res.ok) {
    const lines = body.problems ?? (body.issues ?? []).map((i) => i.message);
    showProblems(lines.length ? lines : [body.error ?? 'refused'], '');
    status('not saved', 'bad');
    return;
  }
  dirty = false;
  status(`saved ${worldKind}`, 'good');
  showProblems([], `Saved ${worldKind}`);
}


/* ----------------------------------------------------------- garments --- */

/**
 * The wardrobe editor (D-562's finding, built as D-570).
 *
 * ⚠ A "set" is a WARDROBE, not a costume — gloves from one set mix with a
 * torso from another, and some armours leave the arms bare. So what is
 * authored here is a list of slot SWAPS covering one slot or five, not a
 * numbered outfit.
 *
 * ⚠ It must be authored by LOOKING, and that is a measured conclusion rather
 * than a preference. D-562 tried twice to group parts into outfits
 * automatically: UV overlap across slots is void as a metric, and garment
 * colour overlap gives 0.34 within a number against 0.33 across — no signal,
 * because the pack dresses everything from one palette. A machine cannot tell
 * which torso goes with which gloves. So every slot previews on a body the
 * moment it changes.
 *
 * ⚠ The one thing a machine CAN do is the other body. The male/female pairing
 * is by number and was measured — 0.96 shared UV islands for a torso, 0.89 to
 * 0.97 across every twice-cut slot, against controls of 0.13 to 0.36 — so
 * "fill the other body" is one button and not a hundred more decisions.
 */
interface GarmentData {
  garments: GarmentDef[];
  slots: CharacterSlot[];
  materials: Record<string, string | null>;
  wornBy: Record<string, string[]>;
}

let garmentPicked: string | null = null;
let garmentSex: CharacterSex = 'male';
let garmentData: GarmentData = { garments: [], slots: [], materials: {}, wornBy: {} };

async function loadGarments(): Promise<void> {
  const res = await fetch(`${API}/garments`);
  if (!res.ok) {
    status('could not load garments', 'bad');
    return;
  }
  garmentData = (await res.json()) as GarmentData;
}

function currentGarment(): GarmentDef | undefined {
  return garmentData.garments.find((g) => g.id === garmentPicked);
}

function renderGarmentList(): void {
  const host = $('list');
  host.replaceChildren();

  const add = document.createElement('button');
  add.textContent = '+ New garment';
  add.style.margin = '8px 0';
  add.onclick = () => {
    const taken = new Set(garmentData.garments.map((g) => g.id));
    let id = '';
    for (let n = 1; ; n++) {
      id = `garment-${n}`;
      if (!taken.has(id)) break;
    }
    garmentData.garments.push({
      id, name: 'New garment', pack, parts: { male: {}, female: {} }, swaps: [],
    });
    garmentPicked = id;
    markDirty();
    renderGarmentList();
    renderGarmentSide();
    previewGarment();
  };
  host.appendChild(add);

  if (garmentData.garments.length === 0) {
    const none = document.createElement('div');
    none.className = 'hint';
    none.style.cssText = 'line-height:1.5;margin-top:8px';
    none.innerHTML =
      'Nothing authored yet. A garment is a set of slot swaps — a torso and '
      + 'two sleeves, or a single glove. ⚠ It <b>replaces</b> body meshes '
      + 'rather than layering over them, because this pack has essentially no '
      + 'bare body: of 720 parts, the torso has <b>no</b> bare option at all.';
    host.appendChild(none);
    return;
  }

  for (const g of garmentData.garments) {
    const row = document.createElement('div');
    row.className = `row${garmentPicked === g.id ? ' on' : ''}`;
    const material = garmentData.materials[g.id];
    const covered = Object.keys(g.parts.male).length || Object.keys(g.parts.female).length;
    row.textContent = `${g.name}  ·  ${covered} slot${covered === 1 ? '' : 's'}${material ? `  ·  ${material}` : ''}`;
    row.onclick = () => {
      garmentPicked = g.id;
      renderGarmentList();
      renderGarmentSide();
      // ⚠ And SHOW it. Without this, picking a garment left whatever was last
      // on the stage — a bare head from the boot sequence — beside a form
      // describing a suit of plate. The whole reason this editor exists is
      // that a garment can only be judged by looking at it (D-562).
      previewGarment();
    };
    host.appendChild(row);
  }
}

/**
 * Show the garment on a body: the plain mannequin with every dressed slot
 * swapped out for the garment's part.
 *
 * ⚠ SWAPPED, not added. A torso previewed inside another torso is two meshes
 * occupying one space and neither can be judged — the same correction
 * `showPart` needed.
 */
function previewGarment(): void {
  const g = currentGarment();
  if (!g) return;
  const worn = g.parts[garmentSex];
  const body = mannequin(garmentSex).filter((stem) => {
    const parsed = catalogueSlotOf(stem);
    return parsed === null || worn[parsed] === undefined;
  });
  // ⚠ The WHOLE body, always, and never the close face framing — a garment is
  // judged as a suit. `frameFor` picks its distance from one slot, which is
  // right when a single part is being named and wrong here: a garment that
  // covers the torso and both greaves would be inspected through a shot of
  // somebody's chin.
  frameFor('torso');
  previewed = '';
  void preview([...body, ...(Object.values(worn) as string[])]);
}

/** Which slot a stem fills, from the catalogue the pack reported. */
function catalogueSlotOf(stem: string): CharacterSlot | null {
  for (const [slot, entries] of Object.entries(catalogue.slots)) {
    if (entries.some((e) => e.stem === stem)) return slot as CharacterSlot;
  }
  return null;
}

function renderGarmentSide(): void {
  const host = $('side');
  host.replaceChildren();
  const g = currentGarment();
  if (!g) {
    roundHint(
      host,
      'Pick a garment, or make one. ⚠ The numbering means <b>nothing across '
      + 'slots</b> — that was measured, not assumed (0.34 colour overlap '
      + 'within a number against 0.33 across, which is no signal). Torso 12 '
      + 'and gloves 12 are not a matching pair; only looking will tell you.',
    );
    return;
  }

  textField(host, 'Name', g.name, (v) => { g.name = v; }, false, renderGarmentList);

  // ⚠ The pack is SHOWN, not chosen here. The slot menus below are built
  // from the catalogue this tool has loaded, which is one pack at a time
  // (`loadPack`), so a dropdown that changed `g.pack` without reloading that
  // catalogue would offer parts from the wrong pack under the right name —
  // a garment that saves cleanly and refers to meshes that are not there.
  const packLine = document.createElement('div');
  packLine.className = 'hint';
  packLine.style.cssText = 'margin:2px 0 10px';
  packLine.innerHTML = g.pack === pack
    ? `Built from <b>${g.pack}</b>.`
    : `⚠ This garment is from <b>${g.pack}</b> but <b>${pack}</b> is loaded. `
      + 'The slot menus below are showing the wrong pack — switch packs on the '
      + 'Core definitions tab before editing it.';
  host.appendChild(packLine);

  const material = garmentData.materials[g.id];
  roundHint(
    host,
    material
      ? `Counts as <b>${material}</b> for a class's armour gate — <b>derived</b> `
        + 'from the parts, which were tagged by measuring their pixels, not typed '
        + 'here. The heaviest part decides: a mail hauberk with leather gloves is '
        + 'plate, or a suit would be gateable by its least protected inch.'
      : '⚠ No part carries a material tag, so this garment is <b>ungated</b> — '
        + 'any calling may wear it. Empty means unrestricted everywhere else in '
        + 'this codebase and this is not the one place it should differ; tag the '
        + 'parts on the Core definitions tab if it should be gated.',
  );

  /* ------------------------------------------------------------- body */
  const bh = document.createElement('h2');
  bh.textContent = 'Body';
  host.appendChild(bh);
  const chips = document.createElement('div');
  chips.className = 'chips';
  for (const sex of ['male', 'female'] as CharacterSex[]) {
    const chip = document.createElement('span');
    chip.className = `chip${garmentSex === sex ? ' on' : ''}`;
    chip.textContent = sex;
    chip.onclick = () => {
      garmentSex = sex;
      renderGarmentSide();
      previewGarment();
    };
    chips.appendChild(chip);
  }
  host.appendChild(chips);

  const mirror = document.createElement('button');
  const other: CharacterSex = garmentSex === 'male' ? 'female' : 'male';
  mirror.textContent = `Fill the ${other} body from this one`;
  mirror.style.margin = '8px 0';
  mirror.onclick = () => {
    g.parts[other] = mirrorGarmentParts(g.parts[garmentSex], other) as typeof g.parts.male;
    markDirty();
    renderGarmentList();
    renderGarmentSide();
  };
  host.appendChild(mirror);
  roundHint(
    host,
    'Pairs by NUMBER, which is measured and not a hopeful convention: '
    + '<code>Torso_Female_12</code> shares <b>0.96</b> of its atlas islands '
    + 'with <code>Torso_Male_12</code> and 0.36 with any other female torso. '
    + 'Unisex parts — a cape, a pauldron — are carried across unchanged.',
  );

  /* ------------------------------------------------------------ slots */
  const sh = document.createElement('h2');
  sh.textContent = 'What it dresses';
  host.appendChild(sh);

  for (const slot of garmentData.slots) {
    const options = optionsFor(slot, garmentSex);
    if (options.length === 0) continue;
    const pick = document.createElement('select');
    const bare = document.createElement('option');
    bare.value = '';
    bare.textContent = '— not dressed —';
    pick.appendChild(bare);
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = o.stem;
      const label = names.names[o.stem];
      const tags = (names.tags[o.stem] ?? []).filter((t) => t !== 'base');
      opt.textContent = `${label ?? o.stem}${tags.length ? `  (${tags.join(', ')})` : ''}`;
      if (!label) opt.style.color = '#c98f6a';
      pick.appendChild(opt);
    }
    pick.value = g.parts[garmentSex][slot] ?? '';
    pick.style.width = '100%';
    pick.onchange = () => {
      if (pick.value) g.parts[garmentSex][slot] = pick.value;
      else delete g.parts[garmentSex][slot];
      markDirty();
      // ⚠ The LIST too, not just this pane. Its row carries the slot count,
      // so leaving it out left a row reading "0 slots" beside a body wearing
      // three — a summary that quietly disagrees with the thing it summarises.
      renderGarmentList();
      renderGarmentSide();
      previewGarment();
    };
    classField(host, slot, pick);

    // ⚠ Say which side is missing, here, beside the control that fixes it.
    // The save refuses a garment dressed on one body only, but a refusal
    // after the fact is a worse place to learn it than the row itself.
    const mine = g.parts[garmentSex][slot];
    const theirs = g.parts[other][slot];
    if (mine && !theirs) {
      const warn = document.createElement('div');
      warn.className = 'hint';
      warn.style.cssText = 'margin:-4px 0 8px;color:#c98f6a';
      warn.textContent = `⚠ not dressed on the ${other} body — half the cast cannot wear this`;
      host.appendChild(warn);
    }
  }

  /* ------------------------------------------------------------- who */
  const wearers = garmentData.wornBy[g.id] ?? [];
  const wh = document.createElement('h2');
  wh.textContent = 'Worn by';
  host.appendChild(wh);
  roundHint(
    host,
    wearers.length
      ? `<b>${wearers.join(', ')}</b>. Deleting this garment is refused while `
        + 'an item still names it.'
      : '⚠ Nothing wears this yet. Point an item at it on the <b>Item '
        + 'definitions</b> tab — a garment nothing wears is content with no '
        + 'consumer, which is invariant 2 one level up.',
  );

  textField(host, 'Notes', g.notes ?? '', (v) => { g.notes = v || undefined; }, true, renderGarmentList);

  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;gap:8px;margin-top:16px';
  const save = document.createElement('button');
  save.textContent = 'Save';
  save.onclick = () => void saveGarment(g);
  const del = document.createElement('button');
  del.textContent = 'Delete';
  del.onclick = () => void deleteGarment(g.id);
  bar.append(save, del);
  host.appendChild(bar);
}

async function saveGarment(g: GarmentDef): Promise<void> {
  const res = await fetch(`${API}/garments/${encodeURIComponent(g.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(g),
  });
  const body = (await res.json().catch(() => ({}))) as {
    saved?: string; material?: string | null; problems?: string[];
    issues?: { message: string }[]; error?: string;
  };
  if (!res.ok) {
    const lines = body.problems ?? (body.issues ?? []).map((i) => i.message);
    showProblems(lines.length ? lines : [body.error ?? 'refused'], '');
    status('not saved', 'bad');
    return;
  }
  dirty = false;
  garmentData.materials[g.id] = body.material ?? null;
  status(`saved ${g.id}`, 'good');
  showProblems([], `Saved content/garments/${g.id}.json`);
  renderGarmentList();
}

async function deleteGarment(id: string): Promise<void> {
  const res = await fetch(`${API}/garments/${encodeURIComponent(id)}`, { method: 'DELETE' });
  const body = (await res.json().catch(() => ({}))) as { problems?: string[]; error?: string };
  if (!res.ok) {
    showProblems(body.problems ?? [body.error ?? 'refused'], '');
    status('not deleted', 'bad');
    return;
  }
  garmentPicked = null;
  await loadGarments();
  renderGarmentList();
  renderGarmentSide();
  status(`deleted ${id}`, 'good');
}

/** Show the panes this section uses, and hide the rest. */
function applySection(): void {
  // Classes reuse the list/side panes but have no 3D preview to show, so the
  // stage is hidden rather than left displaying whatever was last previewed —
  // a character standing beside an armour rule reads as an example of it.
  const built =
    section === 'core' || section === 'classes' || section === 'items'
    || section === 'progression' || section === 'round' || section === 'world'
    || section === 'garments' || section === 'interactive';
  const map = section === 'map';
  $('tabs').classList.toggle('hidden', section !== 'core');
  $('body').classList.toggle('hidden', !built);
  $('editor').classList.toggle('hidden', !map);
  if (map) {
    // Loaded lazily and once: the editor boots its own scene, and paying for
    // that on every visit to a different tab would be a pause for nothing.
    const frame = $('editor') as HTMLIFrameElement;
    if (!frame.src) frame.src = '/editor.html';
  }
  // No 3D preview for rules: a character standing beside an armour rule reads
  // as an example of it.
  //
  // ⚠ EXCEPT the creature editor (D-594). That reasoning was written when
  // Round content was recipes and objectives, which are rules — a creature's
  // LOOK is the one thing on that screen you can only judge by eye, which is
  // exactly why the parts and garment tabs have a stage. Recipes and
  // objectives still do not.
  const creatures = section === 'round' && roundKind === 'roamers';
  const flat = (section === 'classes' || section === 'progression'
    || section === 'round' || section === 'world') && !creatures;
  $('stage').classList.toggle('hidden', flat);
  document.body.classList.toggle('classes', flat);
  $('soon').classList.toggle('hidden', built || map);
  for (const b of Array.from($('sections').querySelectorAll('button'))) {
    b.classList.toggle('on', (b as HTMLElement).dataset.section === section);
  }
  if (section === 'core') render();
  else if (map) {
    /* the embedded editor renders itself */
  } else if (section === 'classes') {
    void loadClasses().then(() => {
      renderClassList();
      renderClassSide();
    });
  } else if (section === 'items') {
    void loadItems().then(() => {
      render();
      void showItem();
    });
  } else if (section === 'progression') {
    void loadClasses().then(() => {
      renderProgList();
      renderProgSide();
    });
  } else if (section === 'round') {
    void loadRound().then(() => {
      renderRoundList();
      renderRoundSide();
    });
  } else if (section === 'world') {
    void loadWorld().then(() => {
      renderWorldList();
      renderWorldSide();
    });
  } else if (section === 'garments') {
    void loadGarments().then(() => {
      renderGarmentList();
      renderGarmentSide();
      previewGarment();
    });
  } else if (section === 'interactive') {
    void loadInteractive().then(() => {
      renderInteractiveList();
      renderInteractiveSide();
    });
  } else renderSoon();
}


/* ------------------------------------ interactive objects (D-583) ------- */

/**
 * Stations and resource nodes, authored together.
 *
 * ⚠ One tab, because they are the same kind of thing to the person making
 * them: an object standing in the world that a player walks up to and uses.
 * What differs is what they DO — a station gates a recipe, a node yields an
 * item and runs out — not how they are made, placed, or drawn. Splitting them
 * would teach the art picker twice and hide that a forge and an ore vein are
 * siblings.
 *
 * ⚠ Until now NEITHER had an editor. `content/stations/` was read by CI
 * alone — the gateway used a hardcoded table of four descriptors, so a fifth
 * station type spawned with its raw id — and both were drawn as built-in
 * geometry with no way to say otherwise (D-583 wired the art; this is where a
 * person chooses it).
 */
type InteractiveKind = 'stations' | 'nodes';

interface InteractiveArt {
  pack: string;
  asset: string;
  rotation: number;
  scale: number;
}
interface InteractiveDef {
  id: string;
  name?: string;
  descriptor: string;
  notes?: string;
  art?: InteractiveArt;
  yields?: string;
  quantity?: number;
  effortTicks?: number;
  charges?: number;
  respawnTicks?: number;
}

let interactive: {
  stations: InteractiveDef[];
  nodes: InteractiveDef[];
  coreStations: string[];
  usedBy: Record<string, string[]>;
} = { stations: [], nodes: [], coreStations: [], usedBy: {} };
let interKind: InteractiveKind = 'stations';
let interPicked: string | null = null;
/** The environment catalogue for the pack whose art is being chosen. */
let interAssets: { id: string; name: string; solid: boolean }[] = [];
let interAssetPack = '';
let interSearch = '';

async function loadInteractive(): Promise<void> {
  interactive = (await (await fetch(`${API}/interactive`)).json()) as typeof interactive;
  if (!interPicked) interPicked = interactive.stations[0]?.id ?? null;
}

function interList(): InteractiveDef[] {
  return interKind === 'stations' ? interactive.stations : interactive.nodes;
}

function renderInteractiveList(): void {
  const host = $('list');
  host.replaceChildren();

  const tabs = document.createElement('div');
  tabs.className = 'chips';
  for (const [k, label] of [
    ['stations', 'facilities'],
    ['nodes', 'resource nodes'],
  ] as [InteractiveKind, string][]) {
    const chip = document.createElement('span');
    chip.className = `chip${interKind === k ? ' on' : ''}`;
    chip.textContent = label;
    chip.onclick = () => {
      interKind = k;
      interPicked = interList()[0]?.id ?? null;
      renderInteractiveList();
      renderInteractiveSide();
    };
    tabs.appendChild(chip);
  }
  host.appendChild(tabs);

  for (const def of interList()) {
    const row = document.createElement('div');
    row.className = `listrow${interPicked === def.id ? ' on' : ''}`;
    const core = interactive.coreStations.includes(def.id);
    const used = interactive.usedBy[def.id]?.length ?? 0;
    row.innerHTML = `<b>${def.name ?? def.id}</b>`
      + `<span class="sub">${def.id}${core ? ' · named by the rules' : ''}`
      + `${def.art ? ` · ${def.art.asset}` : ' · <i>no art</i>'}`
      + `${used ? ` · ${used} recipe(s)` : ''}</span>`;
    row.onclick = () => {
      interPicked = def.id;
      renderInteractiveList();
      renderInteractiveSide();
    };
    host.appendChild(row);
  }
}

function renderInteractiveSide(): void {
  const host = $('side');
  host.replaceChildren();
  const def = interList().find((d) => d.id === interPicked);
  if (!def) {
    roundHint(
      host,
      'Facilities and resource nodes are the objects a player walks up to and '
      + 'uses. Pick one to give it a name, a description and — new — the mesh '
      + 'it is actually drawn as.',
    );
    return;
  }

  if (interactive.coreStations.includes(def.id)) {
    roundHint(
      host,
      `<b>${def.id}</b> is named by the server's own rules (D-530): recipes gate `
      + 'on it and the round places it. Renaming the <i>file</i> would break '
      + 'crafting — change what it is CALLED and what it looks like, not its id.',
    );
  }

  textField(host, 'name', def.name ?? '', (v) => { def.name = v; }, false, renderInteractiveList);
  textField(
    host, 'what a player sees', def.descriptor, (v) => { def.descriptor = v; },
    true, renderInteractiveList,
  );

  if (interKind === 'nodes') {
    numField(host, 'yields, per harvest', def.quantity ?? 1, (v) => { def.quantity = v; });
    numField(host, 'work per harvest (ticks)', def.effortTicks ?? 30, (v) => { def.effortTicks = v; });
    numField(host, 'harvests before it is spent', def.charges ?? 3, (v) => { def.charges = v; });
    numField(host, 'ticks to refill', def.respawnTicks ?? 1200, (v) => { def.respawnTicks = v; });
    roundHint(
      host,
      'Work takes TIME on purpose: gathering is dangerous because you are '
      + 'stationary, occupied and predictable for a known length of time — '
      + 'which is exactly when somebody would choose to be behind you.',
    );
  }

  renderArtPicker(host, def);

  const save = document.createElement('button');
  save.className = 'primary';
  save.textContent = 'Save';
  save.style.marginTop = '10px';
  save.onclick = () => void saveInteractive(def);
  host.appendChild(save);
}

/**
 * Choose the mesh this object is drawn as.
 *
 * ⚠ A picker over the INGESTED catalogue rather than a text box. The id has
 * to match an asset in `content/assets/<pack>.environment.json`, and a typed
 * one that does not simply falls back to the built-in shape — which looks
 * exactly like a texture failing to load rather than like a mistake.
 */
function renderArtPicker(host: HTMLElement, def: InteractiveDef): void {
  const head = document.createElement('h3');
  head.textContent = 'Drawn as';
  host.appendChild(head);

  const packs = document.createElement('div');
  packs.className = 'chips';
  for (const pack of assetPacks) {
    const chip = document.createElement('span');
    chip.className = `chip${(def.art?.pack ?? interAssetPack) === pack ? ' on' : ''}`;
    chip.textContent = pack;
    chip.onclick = () => void pickArtPack(pack, def);
    packs.appendChild(chip);
  }
  host.appendChild(packs);

  if (def.art) {
    const now = document.createElement('div');
    now.className = 'hint';
    now.innerHTML = `Currently <b>${def.art.pack}/${def.art.asset}</b> · `
      + `${Math.round(def.art.rotation)}° · ×${def.art.scale}`;
    host.appendChild(now);
    numField(host, 'rotation (degrees)', def.art.rotation, (v) => {
      if (def.art) def.art.rotation = v;
      renderInteractiveSide();
    });
    const clear = document.createElement('span');
    clear.className = 'chip';
    clear.textContent = 'use the built-in shape';
    clear.onclick = () => {
      delete def.art;
      markDirty();
      renderInteractiveSide();
      renderInteractiveList();
    };
    host.appendChild(clear);
  }

  if (interAssets.length === 0) return;
  const search = document.createElement('input');
  search.placeholder = 'search — well, anvil, barrel, rock…';
  search.value = interSearch;
  search.style.cssText = 'width:100%;margin:8px 0 4px';
  search.oninput = () => {
    interSearch = search.value;
    renderInteractiveSide();
  };
  host.appendChild(search);

  const q = interSearch.trim().toLowerCase();
  const matches = interAssets.filter((a) => !q || a.name.toLowerCase().includes(q)
    || a.id.toLowerCase().includes(q));
  const count = document.createElement('div');
  count.className = 'hint';
  count.textContent = `${matches.length} of ${interAssets.length}`
    + `${matches.length > 80 ? ' — showing the first 80' : ''}`;
  host.appendChild(count);

  const grid = document.createElement('div');
  grid.className = 'chips';
  for (const a of matches.slice(0, 80)) {
    const chip = document.createElement('span');
    chip.className = `chip${def.art?.asset === a.id ? ' on' : ''}`;
    chip.textContent = `${a.name}${a.solid ? ' ■' : ''}`;
    chip.onclick = () => {
      def.art = {
        pack: interAssetPack,
        asset: a.id,
        rotation: def.art?.rotation ?? 0,
        scale: def.art?.scale ?? 1,
      };
      markDirty();
      renderInteractiveSide();
      renderInteractiveList();
      void showAsset(a.id);
    };
    grid.appendChild(chip);
  }
  host.appendChild(grid);
}

async function pickArtPack(pack: string, def: InteractiveDef): Promise<void> {
  interAssetPack = pack;
  assetPack = pack;
  const got = (await (await fetch(`${API}/assets/${pack}/environment`)).json()) as {
    assets?: { id: string; name: string; solid?: boolean }[];
  };
  interAssets = (got.assets ?? []).map((a) => ({
    id: a.id, name: a.name, solid: a.solid !== false,
  }));
  renderInteractiveSide();
  void def;
}

async function saveInteractive(def: InteractiveDef): Promise<void> {
  const res = await fetch(`${API}/interactive/${interKind}/${encodeURIComponent(def.id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(def),
  });
  const body = (await res.json()) as { error?: string; problems?: string[] };
  if (!res.ok) {
    banner(`${body.error ?? 'save refused'}${body.problems ? `: ${body.problems.join('; ')}` : ''}`);
    return;
  }
  banner(`saved ${def.id}`);
  await loadInteractive();
  renderInteractiveList();
  renderInteractiveSide();
}

/* ------------------------------------------------------------ start here */

/**
 * ⚠ LAST LINES IN THE FILE, deliberately.
 *
 * `frame()` reads `bodyMixer` and `boot()` writes `assetPacks`, both declared
 * further down than these calls used to sit. `let` is hoisted but not
 * initialised, so calling either one before its declaration is evaluated
 * throws a ReferenceError that aborts the rest of module evaluation — the tab
 * simply never painted, and the only sign of it was one line in the console.
 * Keeping the two entry points at the very end makes that impossible rather
 * than making it a rule somebody has to remember.
 */
void boot();
frame();

/**
 * Show a creature's built body on the stage (D-594).
 *
 * ⚠ The BUILT `.glb`, not an assembly. A goblin is one finished mesh in the
 * pack (D-594), so there is nothing to assemble and the preview loads exactly
 * what the game loads — the reason D-558 gives for sharing the assembler
 * applies here by loading the same file rather than by sharing code.
 *
 * ⚠ A character the build has not produced yet shows a message rather than an
 * empty stage. The id is authored in `content/characters/` and the body only
 * exists after `npm run build:characters`, so "I picked it and nothing
 * happened" is the expected state in a fresh checkout and needs saying.
 */
let creaturePreview: THREE.Object3D | null = null;
/** What is on the stage, so re-rendering the form does not reload it. */
let creatureShown: string | null | undefined;
/**
 * Which request owns the stage.
 *
 * ⚠ Loading a body is asynchronous and clicking down a list is not, so without
 * this a slow creature lands on top of a fast one that was chosen later: two
 * bodies on the stage and a caption naming whichever finished last. The same
 * guard D-571 put on `setEquipment`, for the same reason — "a token guards the
 * constructor's own load, or `setEquipment` landing first would be undone by
 * the bare model arriving second."
 */
let creatureToken = 0;
let creatureMixer: THREE.AnimationMixer | null = null;

async function previewCreature(id: string | null): Promise<void> {
  const mine = ++creatureToken;
  if (creaturePreview) {
    scene.scene.remove(creaturePreview);
    creaturePreview = null;
    creatureMixer = null;
  }
  // ⚠ And whatever else the stage was showing. The tool keeps a bare-head
  // mannequin on `shown` from boot — it is what the body-parts tab is FOR —
  // and this only ever cleared its own object, so a goblin was drawn with a
  // player's head floating in the middle of it.
  //
  // ⚠ This is D-570's bug one editor later, and word for word: "selecting a
  // garment did not show it — the stage kept a bare head from boot, in the one
  // editor whose whole premise is looking." Worth knowing what it cost the
  // second time: the head was VISIBLE in a screenshot I took, two dark eyes on
  // a pale face, and I talked myself into it being a skeleton's ribcage and
  // measured UVs to prove it. The measurement was real and answered the wrong
  // question. The stakeholder said "why is the player head floating in the
  // middle of the roamers", which is what it was.
  if (shown) {
    scene.scene.remove(shown);
    shown = null;
  }
  if (!id) return;
  let file: string | undefined;
  let palette: string | null = null;
  let height = 1.7;
  try {
    const manifest = (await (await fetch('/models/manifest.json')).json()) as {
      outfits: { id: string; model: string; palette: string | null; height: number }[];
    };
    const outfit = manifest.outfits.find((o) => o.id === id);
    // ⚠ `model`, not `file`. The first cut guessed the field name and every
    // character reported itself as "not built yet" — a message that is exactly
    // what a fresh checkout legitimately shows, so it read as working.
    file = outfit?.model;
    palette = outfit?.palette ?? null;
    height = outfit?.height ?? 1.7;
  } catch {
    file = undefined;
  }
  if (!file) {
    banner(`${id} — not built yet. Run \`npm run build:characters\`.`);
    return;
  }
  const gltf = await new GLTFLoader().loadAsync(`/models/${file}`);
  if (mine !== creatureToken) return;
  const body = gltf.scene;
  const want = round.roamers.find((x) => x.id === roundPicked)?.heightMetres ?? height;
  // ⚠ Scaled the way the game scales it (D-577): MULTIPLY by the ratio of the
  // height wanted to the height the model measures. Setting the scale outright
  // is what once drew every garment a hundred times too large.
  body.scale.multiplyScalar(want / (height || 1));
  // ⚠ The character's OWN atlas, loaded separately onto FBX-exported UVs, so
  // `flipY` stays at the default — setting it false is what once made a
  // palette come out black and yellow and look like an artistic choice
  // (D-559).
  let skin: THREE.Texture | null = null;
  if (palette) {
    skin = await new THREE.TextureLoader().loadAsync(`/models/${palette}`);
    skin.magFilter = THREE.NearestFilter;
    skin.minFilter = THREE.NearestFilter;
    skin.generateMipmaps = false;
    skin.colorSpace = THREE.SRGBColorSpace;
  }
  body.traverse((o) => {
    o.castShadow = true;
    o.receiveShadow = true;
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && skin) {
      const mat = mesh.material as THREE.MeshStandardMaterial;
      mat.map = skin;
      mat.needsUpdate = true;
    }
  });
  if (mine !== creatureToken) return;
  scene.scene.add(body);
  creaturePreview = body;
  const clips = await loadClipLibrary();
  if (mine !== creatureToken) return;
  const idle = clips.find((c) => c.name === 'unarmed-idle') ?? clips[0];
  if (idle) {
    creatureMixer = new THREE.AnimationMixer(body);
    creatureMixer.clipAction(idle).play();
    sheetMixers.push(creatureMixer);
  }
  banner(`${id} — ${want.toFixed(2)}m`);
}
