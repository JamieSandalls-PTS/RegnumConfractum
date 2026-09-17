import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
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
import { assemble } from '../render/assembly';
import {
  type ToolContext,
  type ToolTab,
  button,
  el,
  heading,
  hint,
  labelled,
  listRow,
  selectInput,
  textInput,
} from './context';

/**
 * The character studio (D-558), as a tab of the Bodies stage (D-629).
 *
 * Pick one part per slot, watch it walk, save the choice as content. What is
 * written is a small JSON document naming parts, not a folder of copied
 * meshes: the art is somebody else's and stays out of git; the decision is
 * ours and goes in. The preview assembles through the same `assemble()` the
 * build uses, so approving something here is approving what ships.
 *
 * ⚠ It was `/studio.html`, a page of its own on the same server, and the
 * Enemies tab beside it also wrote `content/characters/` — two editors for one
 * type with no way to see both. It is one stage now: a modular PERSON is made
 * here, a whole-mesh CREATURE next door, and both land in the same folder
 * the build reads.
 */

interface CatalogueEntry { stem: string; sex: string; conceals: CharacterSlot[] }
interface Catalogue { slots: Record<string, CatalogueEntry[]>; textures: string[] }

const fbxLoader = new FBXLoader();
const texLoader = new THREE.TextureLoader();

/**
 * Fetched BYTES are cached, not parsed meshes. Caching the mesh and handing
 * `.clone()` to the assembler shares one skeleton across every copy, and the
 * skinned result comes out degenerate while the bounding box still measures
 * correctly — visible only as a character that does not draw.
 */
const partBytes = new Map<string, ArrayBuffer>();

let packs: string[] = [];
let pack = '';
let catalogue: Catalogue = { slots: {}, textures: [] };
let saved: CharacterDef[] = [];
let chosen = new Map<CharacterSlot, string>();
let sex: CharacterSex = 'male';
let id = '';
let name = '';
let note = '';
let textureStem = '';
let texture: THREE.Texture | null = null;
let clips: THREE.AnimationClip[] = [];
let clipName = 'walking';
let speed = 1;
let shown: { root: THREE.Object3D; mixer: THREE.AnimationMixer } | null = null;
let rebuildToken = 0;
let problemsBox: HTMLElement | null = null;
let slotHost: HTMLElement | null = null;

function optionsFor(slot: CharacterSlot): CatalogueEntry[] {
  return (catalogue.slots[slot] ?? []).filter((o) => o.sex === 'any' || o.sex === sex);
}

function chosenIn(slot: CharacterSlot): CatalogueEntry | undefined {
  const stem = chosen.get(slot);
  return stem ? (catalogue.slots[slot] ?? []).find((o) => o.stem === stem) : undefined;
}

async function partMesh(ctx: ToolContext, stem: string): Promise<THREE.SkinnedMesh> {
  const key = `${pack}/${stem}`;
  let buf = partBytes.get(key);
  if (!buf) {
    buf = await (await fetch(`${ctx.api}/packs/${pack}/fbx/${encodeURIComponent(stem)}`)).arrayBuffer();
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

async function loadTexture(ctx: ToolContext, stem: string): Promise<void> {
  textureStem = stem;
  if (!stem) {
    texture = null;
    return;
  }
  const tex = await texLoader.loadAsync(`${ctx.api}/packs/${pack}/tex/${encodeURIComponent(stem)}`);
  // The atlas is small and every UV island lands on one region; a bilinear
  // tap between two of them invents a colour the artist never chose.
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  texture = tex;
}

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

function playClip(): void {
  if (!shown) return;
  const clip = clips.find((c) => c.name === clipName);
  shown.mixer.stopAllAction();
  if (clip) shown.mixer.clipAction(clip).reset().play();
}

/**
 * Which slots the current choice rules out, and why. Enforced by GREYING OUT
 * rather than by refusing to save: a crest with nothing to mount on and hair
 * under a closed helm both build perfectly well — they are simply never seen.
 */
function slotBlocks(): Map<CharacterSlot, string> {
  const blocked = new Map<CharacterSlot, string>();
  for (const slot of CHARACTER_SLOTS) {
    const part = chosenIn(slot);
    if (!part) continue;
    for (const hidden of part.conceals) blocked.set(hidden, `hidden by ${part.stem}`);
  }
  for (const [slot, needs] of Object.entries(SLOT_REQUIRES) as [CharacterSlot, CharacterSlot][]) {
    if (!chosenIn(needs)) blocked.set(slot, `needs a ${needs}`);
  }
  return blocked;
}

function missingSlots(): CharacterSlot[] {
  return (BODY_SLOTS as readonly CharacterSlot[]).filter((s) => {
    if (chosen.get(s)) return false;
    // A helmed head IS the head, so it fills the slot.
    const instead = SLOT_ALTERNATIVES[s as keyof typeof SLOT_ALTERNATIVES];
    return !instead || !chosen.get(instead as CharacterSlot);
  });
}

/** Rebuild the preview, guarded by a token so the last CHOICE wins, not the last fetch. */
async function refresh(ctx: ToolContext): Promise<void> {
  const token = ++rebuildToken;
  // Drop anything a concealing part just made invisible, so the preview and
  // the saved definition agree with the pickers.
  const blocked = slotBlocks();
  for (const slot of blocked.keys()) chosen.delete(slot);
  renderSlots(ctx);
  const parts = CHARACTER_SLOTS.flatMap((slot) => {
    const stem = chosen.get(slot);
    return stem ? [{ slot, stem }] : [];
  });
  if (parts.length === 0) {
    ctx.mount.clear();
    shown = null;
    ctx.banner('nothing chosen');
    return;
  }
  ctx.banner('loading…');
  let meshes;
  try {
    meshes = await Promise.all(parts.map(async (p) => ({ slot: p.slot, mesh: await partMesh(ctx, p.stem) })));
  } catch (e) {
    ctx.banner((e as Error).message);
    return;
  }
  if (token !== rebuildToken) return;
  let built;
  try {
    built = assemble(meshes);
  } catch (e) {
    ctx.banner(`cannot assemble: ${(e as Error).message}`);
    return;
  }
  ctx.mount.clear();
  // Source art is in centimetres. `assemble` leaves the hierarchy with fresh
  // world matrices, so the new scale has to be forced through.
  built.group.scale.setScalar(0.01);
  built.group.updateMatrixWorld(true);
  built.group.traverse((o) => {
    o.castShadow = true;
    o.receiveShadow = true;
  });
  applyTexture(built.group);
  ctx.mount.add(built.group);
  shown = { root: built.group, mixer: new THREE.AnimationMixer(built.group) };
  playClip();
  const box = new THREE.Box3().setFromObject(built.group);
  const verts = built.meshes.reduce((n, m) => n + m.geometry.attributes.position!.count, 0);
  // Say when a part had to be corrected: a silent fix is a silent claim that
  // the art was fine.
  const repaired = built.repairs.length ? ` · repaired ${built.repairs.length} part` : '';
  ctx.banner(`${meshes.length} parts · ${verts} verts · ${(box.max.y - box.min.y).toFixed(2)}m${repaired}`);
  if (built.repairs.length) console.warn(built.repairs.join('; '));
  (window as unknown as { __studio: unknown }).__studio = { built, box };
}

function renderSlots(ctx: ToolContext): void {
  if (!slotHost) return;
  slotHost.replaceChildren();
  const blocked = slotBlocks();
  for (const slot of CHARACTER_SLOTS) {
    const required = (BODY_SLOTS as readonly string[]).includes(slot);
    const options = optionsFor(slot);
    const why = blocked.get(slot);
    const row = el('div', { className: `slot${required ? ' required' : ''}${why ? ' blocked' : ''}${chosen.get(slot) ? '' : ' empty'}` });
    const head = el('span');
    head.innerHTML = `${slot}${required ? ' <b>*</b>' : ''}<i>${options.length}</i>`;
    const sel = el('select');
    sel.add(new Option('— none —', ''));
    for (const o of options) sel.add(new Option(o.stem, o.stem));
    sel.value = chosen.get(slot) ?? '';
    sel.disabled = Boolean(why);
    sel.onchange = () => {
      if (sel.value) chosen.set(slot, sel.value);
      else chosen.delete(slot);
      ctx.markDirty();
      void refresh(ctx);
    };
    row.append(head, sel, el('em', { textContent: why ?? '' }));
    slotHost.append(row);
  }
  const missing = missingSlots();
  if (problemsBox) {
    problemsBox.innerHTML = missing.length
      ? `<div class="bad">Missing: ${missing.join(', ')}</div>`
      : '<div class="good">Complete — every body slot filled.</div>';
  }
}

/** A complete, plausible character, for getting started or shaking out slots. */
function randomise(ctx: ToolContext): void {
  sex = Math.random() < 0.5 ? 'male' : 'female';
  chosen = new Map();
  // Decide the head first — bare or helmed — because everything above the
  // neck depends on the answer.
  const helmed = Math.random() < 0.3;
  for (const slot of CHARACTER_SLOTS) {
    const pool = optionsFor(slot);
    if (pool.length === 0) continue;
    const required = (BODY_SLOTS as readonly string[]).includes(slot);
    if (slot === 'head' && helmed) continue;
    if (slot === 'helmet' && !helmed) continue;
    // Attachments are mostly absent on a real person; filling every one
    // produces a walking armoury rather than a character.
    if (!required && slot !== 'helmet' && Math.random() > 0.35) continue;
    chosen.set(slot, pool[Math.floor(Math.random() * pool.length)]!.stem);
  }
  renderSide(ctx);
  void refresh(ctx);
}

function currentDef(): CharacterDef {
  const parts: Record<string, string> = {};
  for (const [slot, stem] of chosen) parts[slot] = stem;
  return {
    id: id.trim(),
    name: name.trim(),
    pack,
    sex,
    // ⚠ This tab assembles PEOPLE (D-618): a creature in these packs is a
    // finished mesh with no slots to pick, and is named on the Enemies tab.
    kind: 'person' as const,
    parts: parts as CharacterDef['parts'],
    ...(textureStem ? { texture: textureStem } : {}),
    ...(note.trim() ? { note: note.trim() } : {}),
  };
}

async function save(ctx: ToolContext): Promise<void> {
  const def = currentDef();
  const box = problemsBox!;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(def.id)) {
    ctx.problems(box, ['Id must be lower-case letters, digits and dashes.'], '');
    return;
  }
  if (!def.name) {
    ctx.problems(box, ['Give it a name.'], '');
    return;
  }
  const missing = missingSlots();
  if (missing.length) {
    ctx.problems(box, [`Missing: ${missing.join(', ')}`], '');
    return;
  }
  const res = await fetch(`${ctx.api}/characters/${def.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(def),
  });
  const body = (await res.json()) as { problems?: string[]; error?: string };
  if (!res.ok) {
    ctx.problems(box, body.problems ?? [body.error ?? 'refused'], '');
    ctx.status('not saved', 'bad');
    return;
  }
  ctx.clearDirty();
  ctx.status(`saved ${def.id}`, 'good');
  ctx.problems(box, [], `Saved content/characters/${def.id}.json — then npm run build:characters`);
  await loadSaved(ctx);
  renderList(ctx);
}

async function loadSaved(ctx: ToolContext): Promise<void> {
  saved = ((await (await fetch(`${ctx.api}/characters`)).json()) as CharacterDef[])
    // Whole-mesh creatures belong to the Enemies tab; this one builds people.
    .filter((c) => c.mesh === undefined);
}

async function open(ctx: ToolContext, def: CharacterDef): Promise<void> {
  if (def.pack !== pack) await loadPack(ctx, def.pack);
  id = def.id;
  name = def.name;
  sex = def.sex;
  note = def.note ?? '';
  chosen = new Map();
  for (const slot of CHARACTER_SLOTS) {
    const stem = def.parts[slot];
    if (stem) chosen.set(slot, stem);
  }
  await loadTexture(ctx, def.texture ?? preferredAtlas(catalogue.textures));
  renderList(ctx);
  renderSide(ctx);
  await refresh(ctx);
}

async function loadPack(ctx: ToolContext, packId: string): Promise<void> {
  pack = packId;
  partBytes.clear();
  catalogue = (await (await fetch(`${ctx.api}/packs/${packId}`)).json()) as Catalogue;
  // ⚠ NOT the unlettered atlas: it is the markings-free cut, and against it
  // every head that carries war paint renders as a plain face (D-560).
  await loadTexture(ctx, preferredAtlas(catalogue.textures));
}

function renderList(ctx: ToolContext): void {
  const host = ctx.list;
  host.replaceChildren(el('h1', { textContent: 'Characters' }));
  const bar = el('div', { className: 'row' });
  bar.append(
    button('+ New', () => {
      id = '';
      name = '';
      note = '';
      chosen = new Map();
      renderList(ctx);
      renderSide(ctx);
      void refresh(ctx);
    }),
    button('Randomise', () => {
      ctx.markDirty();
      randomise(ctx);
    }),
  );
  host.append(bar);
  for (const c of saved) {
    host.append(listRow(c.name, `${c.id} · ${c.pack} · ${c.sex}`, id === c.id, () => void open(ctx, c)));
  }
  host.append(hint(
    'Saving writes a small definition to <code>content/characters/</code> — '
    + 'the art stays out of git, the choice goes in. Then '
    + '<code>npm run build:characters</code>. Whole-mesh creatures are on the '
    + '<b>Enemies</b> tab.',
  ));
}

function renderSide(ctx: ToolContext): void {
  const host = ctx.side;
  host.replaceChildren(el('h1', { textContent: name || 'New character' }));
  host.append(labelled('Pack', selectInput(
    packs.map((p) => ({ value: p, label: p })),
    pack,
    (v) => void loadPack(ctx, v).then(() => {
      chosen = new Map();
      renderSide(ctx);
      void refresh(ctx);
    }),
  )));
  // ⚠ The body is chosen BEFORE the slots are read: most parts are cut twice
  // and a female forearm on a male upper arm meets it at the wrong diameter
  // (D-558). Switching keeps what still fits — hair, pauldrons and capes are
  // cut once — and drops only the other body's parts.
  host.append(labelled('Body', selectInput(
    [{ value: 'male', label: 'male' }, { value: 'female', label: 'female' }],
    sex,
    (v) => {
      sex = v as CharacterSex;
      for (const slot of CHARACTER_SLOTS) {
        const stem = chosen.get(slot);
        if (stem && !optionsFor(slot).some((o) => o.stem === stem)) chosen.delete(slot);
      }
      ctx.markDirty();
      void refresh(ctx);
    },
  )));
  host.append(labelled('Id', textInput(id, (v) => {
    id = v;
    ctx.markDirty();
  }, 'knight-male')));
  host.append(labelled('Name', textInput(name, (v) => {
    name = v;
    ctx.markDirty();
  }, 'Knight')));
  host.append(labelled('Colour atlas', selectInput(
    [{ value: '', label: '— none —' }, ...catalogue.textures.map((t) => ({ value: t, label: t }))],
    textureStem,
    (v) => void loadTexture(ctx, v).then(() => {
      ctx.markDirty();
      if (shown) applyTexture(shown.root);
    }),
  )));
  const noteIn = el('textarea');
  noteIn.rows = 2;
  noteIn.value = note;
  noteIn.placeholder = 'what this is for';
  noteIn.oninput = () => {
    note = noteIn.value;
    ctx.markDirty();
  };
  host.append(labelled('Note', noteIn));

  host.append(heading('Parts — one per slot'));
  slotHost = el('div');
  host.append(slotHost);

  host.append(heading('Preview'));
  host.append(labelled('Animation', selectInput(
    clips.length
      ? clips.map((c) => ({ value: c.name, label: c.name }))
      : [{ value: '', label: 'none built yet' }],
    clipName,
    (v) => {
      clipName = v;
      playClip();
    },
  )));
  const speedIn = el('input');
  speedIn.type = 'range';
  speedIn.min = '0';
  speedIn.max = '1.5';
  speedIn.step = '0.05';
  speedIn.value = String(speed);
  speedIn.oninput = () => {
    speed = Number(speedIn.value);
  };
  host.append(labelled('Speed (0 holds a frame)', speedIn));

  host.append(heading('Save'));
  host.append(button('Save to content', () => void save(ctx), true));
  problemsBox = el('div', { id: 'problems' });
  host.append(problemsBox);
  renderSlots(ctx);
}

export const charactersTab: ToolTab = {
  async enter(ctx) {
    ctx.view(0.05, 1.0, 0.22);
    let found: { id: string }[];
    try {
      found = (await (await fetch(`${ctx.api}/packs`)).json()) as { id: string }[];
    } catch {
      ctx.banner('authoring api not running — npm run dev:tools');
      return;
    }
    packs = found.map((p) => p.id);
    if (packs.length === 0) {
      ctx.banner('no ingested packs with character parts in assets/source');
      return;
    }
    if (!pack || !packs.includes(pack)) await loadPack(ctx, packs[0]!);
    clips = await ctx.clips();
    if (!clips.some((c) => c.name === clipName)) clipName = clips[0]?.name ?? '';
    await loadSaved(ctx);
    renderList(ctx);
    renderSide(ctx);
    if (chosen.size === 0) randomise(ctx);
    else await refresh(ctx);
    ctx.onFrame((dt) => shown?.mixer.update(dt * speed));
  },
};
