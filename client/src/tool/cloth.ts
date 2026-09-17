import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import {
  BODY_SLOTS,
  CAPE_COLLIDERS,
  CHARACTER_SLOTS,
  ClothSettingsSchema,
  type CharacterSlot,
  type ClothCollider,
  type ClothFile,
  type ClothSettings,
  type PartNames,
  preferredAtlas,
} from '@rc/shared';
import { assemble } from '../render/assembly';
import { MeshCloth } from '../render/mesh-cloth';
import {
  type ToolContext,
  type ToolTab,
  button,
  chip,
  el,
  heading,
  hint,
  labelled,
  listRow,
  selectInput,
} from './context';

/**
 * The cloth workbench, rebuilt on the pack's own clothing (D-631).
 *
 * D-520's workbench tuned a GENERATED grid on a placeholder body and exported
 * the numbers for somebody to bake by hand; D-617 reduced its body to a
 * stand-in. This one does what the stakeholder asked: pick a clothing part —
 * a cape, a skirt, a hood — see it on a body that walks, and define the
 * physics for that mesh. The settings are content (`content/cloth/<pack>.json`),
 * keyed by part stem, and the game applies them to anybody wearing the part.
 *
 * ⚠ The body is the pack's, assembled through the same `assemble()` the game
 * uses, and the solver is the game's `MeshCloth`: what drapes here is what
 * drapes in play, on the same vertices.
 */

interface CatalogueEntry { stem: string; sex: string; conceals: CharacterSlot[] }
interface Catalogue { slots: Record<string, CatalogueEntry[]>; textures: string[] }

/** Slots the pack cuts cloth-like parts for. Others are offered on request. */
const CLOTH_SLOTS: CharacterSlot[] = ['back', 'hips', 'hipsAttachment', 'headCovering', 'shoulderL', 'shoulderR', 'torso'];
const BODY_BONES = [
  'pelvis', 'spine_01', 'spine_02', 'spine_03', 'neck_01', 'head',
  'clavicle_l', 'upperarm_l', 'lowerarm_l', 'hand_l', 'clavicle_r', 'upperarm_r', 'lowerarm_r', 'hand_r',
  'thigh_l', 'calf_l', 'foot_l', 'thigh_r', 'calf_r', 'foot_r',
];

const fbxLoader = new FBXLoader();
const texLoader = new THREE.TextureLoader();
const partBytes = new Map<string, ArrayBuffer>();

let packs: string[] = [];
let pack = '';
let catalogue: Catalogue = { slots: {}, textures: [] };
let names: PartNames = { pack: '', names: {}, tags: {} };
let file: ClothFile = { pack: '', cloth: {} };
let slotFilter: CharacterSlot | 'all' = 'back';
let picked: string | null = null;
let clips: THREE.AnimationClip[] = [];
let clipName = 'walking';
let windLevel = 0.5;
let texture: THREE.Texture | null = null;

/** The draft being edited: the saved settings, or a default for a new part. */
let draft: ClothSettings | null = null;
let saved = false;
/** Bones the picked part is weighted to, with how much — the free-bone choice. */
let partBones: { name: string; weight: number }[] = [];

let shown: { root: THREE.Object3D; mixer: THREE.AnimationMixer; cloth: MeshCloth | null } | null = null;
let buildToken = 0;
let problemsBox: HTMLElement | null = null;

async function partMesh(ctx: ToolContext, stem: string): Promise<THREE.SkinnedMesh> {
  const key = `${pack}/${stem}`;
  let buf = partBytes.get(key);
  if (!buf) {
    buf = await (await fetch(`${ctx.api}/packs/${pack}/fbx/${encodeURIComponent(stem)}`)).arrayBuffer();
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

function sexOf(stem: string): 'male' | 'female' {
  return /_Female_/i.test(stem) ? 'female' : 'male';
}

function slotOf(stem: string): CharacterSlot | null {
  for (const [slot, entries] of Object.entries(catalogue.slots)) {
    if (entries.some((e) => e.stem === stem)) return slot as CharacterSlot;
  }
  return null;
}

/** A bare body of the right cut to hang the part on: the first option per body slot. */
function mannequin(sex: 'male' | 'female', except: CharacterSlot): { slot: CharacterSlot; stem: string }[] {
  return BODY_SLOTS.flatMap((slot) => {
    if (slot === except) return [];
    const options = (catalogue.slots[slot] ?? []).filter((o) => o.sex === 'any' || o.sex === sex);
    // Prefer a part tagged base: the bare body, not somebody's armour.
    const base = options.find((o) => (names.tags[o.stem] ?? []).includes('base'));
    const first = base ?? options[0];
    return first ? [{ slot, stem: first.stem }] : [];
  });
}

/** Which bones a part is weighted to, and how much — read off the mesh. */
function weightedBones(mesh: THREE.SkinnedMesh): { name: string; weight: number }[] {
  const si = mesh.geometry.getAttribute('skinIndex');
  const sw = mesh.geometry.getAttribute('skinWeight');
  const byName = new Map<string, number>();
  const bones = mesh.skeleton.bones.map((b) => b.name);
  for (let v = 0; v < si.count; v++) {
    for (let k = 0; k < 4; k++) {
      const w = sw.getComponent(v, k);
      if (w <= 0) continue;
      const n = bones[si.getComponent(v, k)];
      if (n) byName.set(n, (byName.get(n) ?? 0) + w);
    }
  }
  return [...byName.entries()].map(([name, weight]) => ({ name, weight })).sort((a, b) => b.weight - a.weight);
}

/**
 * A first guess at what hangs free: every bone the part is weighted to that
 * the BODY does not have. For this pack's capes that is the `back_0N` chain
 * under `Capes_01`; for a hood it is nothing, and the tab says so.
 */
function guessFree(bones: readonly { name: string }[]): string[] {
  const body = new Set(BODY_BONES);
  return bones.map((b) => b.name).filter((n) => !body.has(n) && !/^Capes_0[01]$/.test(n));
}

async function loadTexture(ctx: ToolContext): Promise<void> {
  const stem = preferredAtlas(catalogue.textures);
  if (!stem) return;
  try {
    const tex = await texLoader.loadAsync(`${ctx.api}/packs/${pack}/tex/${encodeURIComponent(stem)}`);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    texture = tex;
  } catch {
    texture = null;
  }
}

/** Assemble the body with the picked part, and hang the solver on the part. */
async function rebuild(ctx: ToolContext): Promise<void> {
  const token = ++buildToken;
  const stem = picked;
  if (!stem) {
    ctx.mount.clear();
    shown = null;
    ctx.banner('pick a part');
    return;
  }
  const slot = slotOf(stem);
  if (!slot) {
    ctx.banner(`${stem} is in no slot of ${pack}`);
    return;
  }
  ctx.banner('loading…');
  const wanted = [...mannequin(sexOf(stem), slot), { slot, stem }];
  let meshes;
  try {
    meshes = await Promise.all(wanted.map(async (p) => ({ slot: p.slot, mesh: await partMesh(ctx, p.stem) })));
  } catch (e) {
    ctx.banner((e as Error).message);
    return;
  }
  if (token !== buildToken) return;
  const part = meshes.find((m) => m.slot === slot)!.mesh;
  partBones = weightedBones(part);
  if (!draft) {
    draft = ClothSettingsSchema.parse({ freeBones: guessFree(partBones).length ? guessFree(partBones) : [partBones[0]?.name ?? 'none'], colliders: [...CAPE_COLLIDERS] });
  }

  let built;
  try {
    built = assemble(meshes);
  } catch (e) {
    ctx.banner(`cannot assemble: ${(e as Error).message}`);
    return;
  }
  shown?.cloth?.dispose();
  ctx.mount.clear();
  built.group.scale.setScalar(0.01);
  built.group.updateMatrixWorld(true);
  built.group.traverse((o) => {
    o.castShadow = true;
    o.receiveShadow = true;
    const m = o as THREE.Mesh;
    if (m.isMesh && texture) {
      const mat = m.material as THREE.MeshStandardMaterial;
      mat.map = texture;
      mat.needsUpdate = true;
    }
  });
  ctx.mount.add(built.group);
  const mixer = new THREE.AnimationMixer(built.group);
  const clip = clips.find((c) => c.name === clipName);
  if (clip) mixer.clipAction(clip).play();
  // One frame of animation before the solver reads its rest pose, or the
  // T-pose's edge lengths are what the walk is held to.
  mixer.update(0);
  built.skeleton.update();
  built.group.updateMatrixWorld(true);

  const clothMesh = built.meshes.find((m) => m.name === slot);
  let cloth: MeshCloth | null = null;
  if (clothMesh && draft) {
    try {
      cloth = new MeshCloth(clothMesh, draft, built.group);
      ctx.mount.add(cloth.proxy);
    } catch (e) {
      ctx.banner(`no cloth: ${(e as Error).message}`);
    }
  }
  shown = { root: built.group, mixer, cloth };
  const free = cloth?.freeCount ?? 0;
  ctx.banner(
    `${names.names[stem] ?? stem} · ${cloth?.particleCount ?? 0} particles, ${free} free`
    + (free === 0 ? ' — ⚠ nothing hangs: choose free bones' : ''),
  );
  renderSide(ctx);
}

function renderList(ctx: ToolContext): void {
  const host = ctx.list;
  host.replaceChildren(el('h1', { textContent: 'Cloth workbench' }));
  host.append(labelled('Pack', selectInput(
    packs.map((p) => ({ value: p, label: p })),
    pack,
    (v) => void enterPack(ctx, v),
  )));
  const chips = el('div', { className: 'chips' });
  for (const slot of [...CLOTH_SLOTS, 'all'] as (CharacterSlot | 'all')[]) {
    const n = slot === 'all'
      ? Object.values(catalogue.slots).reduce((s, e) => s + e.length, 0)
      : (catalogue.slots[slot] ?? []).length;
    if (!n) continue;
    chips.append(chip(`${slot} (${n})`, slotFilter === slot, () => {
      slotFilter = slot;
      renderList(ctx);
    }));
  }
  host.append(chips);
  const stems = slotFilter === 'all'
    ? CHARACTER_SLOTS.flatMap((s) => (catalogue.slots[s] ?? []).map((e) => e.stem))
    : (catalogue.slots[slotFilter] ?? []).map((e) => e.stem);
  const withCloth = stems.filter((s) => s in file.cloth).length;
  host.append(el('div', { className: 'count', textContent: `${stems.length} parts · ${withCloth} with physics` }));
  for (const stem of stems) {
    const has = stem in file.cloth;
    host.append(listRow(
      names.names[stem] ?? stem.replace(/^SK_Chr_/, ''),
      `${stem}${has ? ' · physics' : ''}`,
      picked === stem,
      () => {
        picked = stem;
        draft = file.cloth[stem] ? ClothSettingsSchema.parse(file.cloth[stem]) : null;
        saved = Boolean(file.cloth[stem]);
        renderList(ctx);
        void rebuild(ctx);
      },
    ));
  }
  host.append(hint(
    'Capes and skirts hang; a hood is weighted to the head and has nothing to '
    + 'swing. Physics is saved per PART to <code>content/cloth/</code> and '
    + 'applies to anybody wearing it.',
  ));
}

function numberRow(
  label: string, value: number, min: number, max: number, step: number,
  set: (v: number) => void, digits = 2,
): DocumentFragment {
  const row = el('div', { className: 'sl' });
  const input = el('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  const out = el('b', { textContent: value.toFixed(digits) });
  input.oninput = () => {
    const v = Number(input.value);
    out.textContent = v.toFixed(digits);
    set(v);
  };
  row.append(input, out);
  return labelled(label, row);
}

function renderSide(ctx: ToolContext): void {
  const host = ctx.side;
  host.replaceChildren();
  if (!picked || !draft) {
    host.append(el('h1', { textContent: 'Cloth' }), hint('Pick a clothing part on the left.'));
    return;
  }
  const d = draft;
  host.append(el('h1', { textContent: names.names[picked] ?? picked }));
  host.append(el('div', { className: 'count', textContent: `${picked}${saved ? ' · saved' : ' · not saved yet'}` }));

  host.append(heading('Preview'));
  host.append(labelled('Animation', selectInput(
    clips.length ? clips.map((c) => ({ value: c.name, label: c.name })) : [{ value: '', label: 'none built yet' }],
    clipName,
    (v) => {
      clipName = v;
      void rebuild(ctx);
    },
  )));
  host.append(numberRow('Wind', windLevel, 0, 1, 0.05, (v) => {
    windLevel = v;
  }));

  // Live changes go straight into the running solver; structural ones
  // (which bones hang, which bodies collide) rebuild it.
  const live = (): void => {
    ctx.markDirty();
    if (shown?.cloth) shown.cloth.settings = d;
  };
  const structural = (): void => {
    ctx.markDirty();
    void rebuild(ctx);
  };

  host.append(heading('What hangs free'));
  host.append(hint('Bones the part is weighted to. Ticked bones are simulated; the rest follow the animation.'));
  for (const b of partBones) {
    const row = el('div', { className: 'check' });
    const input = el('input');
    input.type = 'checkbox';
    input.checked = d.freeBones.includes(b.name);
    input.onchange = () => {
      d.freeBones = input.checked ? [...d.freeBones, b.name] : d.freeBones.filter((n) => n !== b.name);
      structural();
    };
    row.append(input, el('span', { textContent: `${b.name} (${Math.round(b.weight)} weight)` }));
    host.append(row);
  }
  host.append(numberRow('Free when weighted at least', d.freeWeight, 0, 1, 0.05, (v) => {
    d.freeWeight = v;
    structural();
  }));

  host.append(heading('Physics'));
  host.append(numberRow('Gravity (m/s²)', d.gravity, 0, 30, 0.5, (v) => { d.gravity = v; live(); }, 1));
  host.append(numberRow('Damping (lower = deader)', d.damping, 0.9, 1, 0.005, (v) => { d.damping = v; live(); }, 3));
  host.append(numberRow('Stiffness', d.stiffness, 0.1, 1, 0.05, (v) => { d.stiffness = v; live(); }));
  host.append(numberRow('Resist folding', d.bend, 0, 1, 0.05, (v) => { d.bend = v; live(); }));
  host.append(numberRow('Solver passes', d.iterations, 1, 20, 1, (v) => { d.iterations = v; live(); }, 0));
  host.append(numberRow('Wind strength (m/s²)', d.windStrength, 0, 30, 0.5, (v) => { d.windStrength = v; live(); }, 1));
  host.append(numberRow('Wind response', d.windScale, 0, 5, 0.1, (v) => { d.windScale = v; live(); }, 1));
  host.append(numberRow('Thickness (m)', d.thickness, 0, 0.1, 0.005, (v) => { d.thickness = v; live(); }, 3));
  host.append(numberRow('Floor (m above feet)', d.floor, 0, 0.5, 0.01, (v) => { d.floor = v; live(); }));

  host.append(heading('Body it drapes over'));
  host.append(hint('Capsules between two bones, or a sphere on one. Radii in metres on a 1.0-scale figure.'));
  const list = el('div');
  const renderColliders = (): void => {
    list.replaceChildren();
    d.colliders.forEach((c, i) => {
      const row = el('div', { className: 'row' });
      row.style.margin = '3px 0';
      const label = el('span', { textContent: `${c.bone}${c.to ? ` → ${c.to}` : ''}` });
      label.style.flex = '1';
      label.style.fontSize = '11px';
      const r = el('input');
      r.type = 'number';
      r.step = '0.01';
      r.min = '0.01';
      r.max = '1';
      r.value = String(c.radius);
      r.style.width = '64px';
      r.oninput = () => {
        c.radius = Math.max(0.01, Number(r.value) || 0.01);
        structural();
      };
      const x = button('×', () => {
        d.colliders.splice(i, 1);
        renderColliders();
        structural();
      });
      x.style.width = 'auto';
      x.style.marginTop = '0';
      row.append(label, r, x);
      list.append(row);
    });
  };
  renderColliders();
  host.append(list);
  const add = el('div', { className: 'row' });
  const from = selectInput(BODY_BONES.map((b) => ({ value: b, label: b })), 'spine_02', () => {});
  const to = selectInput([{ value: '', label: '(sphere)' }, ...BODY_BONES.map((b) => ({ value: b, label: b }))], 'neck_01', () => {});
  add.append(from, to, button('+', () => {
    const c: ClothCollider = { bone: from.value, radius: 0.1, ...(to.value ? { to: to.value } : {}) };
    d.colliders.push(c);
    renderColliders();
    structural();
  }));
  host.append(add);
  host.append(button('Reset to the cape defaults', () => {
    d.colliders = [...CAPE_COLLIDERS];
    renderColliders();
    structural();
  }));

  const bar = el('div', { className: 'row' });
  bar.style.marginTop = '16px';
  bar.append(button('Save physics', () => void save(ctx), true));
  if (saved) bar.append(button('Remove', () => void remove(ctx)));
  host.append(bar);
  problemsBox = el('div', { id: 'problems' });
  host.append(problemsBox);
  host.append(hint('Saving writes <code>content/cloth/' + pack + '.json</code>; Publish carries it to a running game.'));
}

async function save(ctx: ToolContext): Promise<void> {
  if (!picked || !draft) return;
  const res = await fetch(`${ctx.api}/cloth/${encodeURIComponent(pack)}/${encodeURIComponent(picked)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(draft),
  });
  const body = (await res.json().catch(() => ({}))) as { problems?: string[]; issues?: { message: string }[]; error?: string };
  if (!res.ok) {
    const lines = body.problems ?? (body.issues ?? []).map((i) => i.message);
    ctx.problems(problemsBox!, lines.length ? lines : [body.error ?? 'refused'], '');
    ctx.status('not saved', 'bad');
    return;
  }
  file.cloth[picked] = draft;
  saved = true;
  ctx.clearDirty();
  ctx.status(`saved cloth for ${picked}`, 'good');
  ctx.problems(problemsBox!, [], `Saved content/cloth/${pack}.json`);
  renderList(ctx);
}

async function remove(ctx: ToolContext): Promise<void> {
  if (!picked) return;
  const res = await fetch(`${ctx.api}/cloth/${encodeURIComponent(pack)}/${encodeURIComponent(picked)}`, { method: 'DELETE' });
  if (!res.ok) {
    ctx.status('not removed', 'bad');
    return;
  }
  delete file.cloth[picked];
  saved = false;
  ctx.status(`removed cloth for ${picked}`, 'good');
  renderList(ctx);
  renderSide(ctx);
}

async function enterPack(ctx: ToolContext, id: string): Promise<void> {
  pack = id;
  partBytes.clear();
  picked = null;
  draft = null;
  catalogue = (await (await fetch(`${ctx.api}/packs/${pack}`)).json()) as Catalogue;
  names = (await (await fetch(`${ctx.api}/parts/${pack}`)).json()) as PartNames;
  file = (await (await fetch(`${ctx.api}/cloth/${pack}`)).json()) as ClothFile;
  await loadTexture(ctx);
  if (!(catalogue.slots[slotFilter] ?? []).length) slotFilter = 'all';
  renderList(ctx);
  renderSide(ctx);
  ctx.mount.clear();
  shown = null;
  ctx.banner('pick a part');
}

export const clothTab: ToolTab = {
  async enter(ctx) {
    ctx.view(0.05, 1.0, 0.24);
    let found: { id: string }[];
    try {
      found = (await (await fetch(`${ctx.api}/packs`)).json()) as { id: string }[];
    } catch {
      ctx.banner('authoring api not running — npm run dev:tools');
      return;
    }
    packs = found.map((p) => p.id);
    if (packs.length === 0) {
      ctx.banner('no ingested packs with character parts');
      return;
    }
    clips = await ctx.clips();
    if (!clips.some((c) => c.name === clipName)) clipName = clips[0]?.name ?? '';
    if (!pack || !packs.includes(pack)) await enterPack(ctx, packs[0]!);
    else {
      renderList(ctx);
      renderSide(ctx);
      if (picked) void rebuild(ctx);
    }
    let t = 0;
    ctx.onFrame((dt) => {
      t += dt;
      shown?.mixer.update(dt);
      shown?.cloth?.step(dt, windLevel, t);
    });
    // The verification hook this tab carries (D-114).
    (window as unknown as { __cloth: unknown }).__cloth = {
      particles: () => shown?.cloth?.particleCount ?? 0,
      free: () => shown?.cloth?.freeCount ?? 0,
      hem: () => {
        const c = shown?.cloth;
        if (!c) return null;
        let low: THREE.Vector3 | null = null;
        for (let p = 0; p < c.particleCount; p++) {
          const v = c.particle(p);
          if (!low || v.y < low.y) low = v;
        }
        return low ? [low.x, low.y, low.z] : null;
      },
      draft: () => draft,
      /**
       * Advance the preview by hand, for a check that does not depend on the
       * browser pane's frame loop (which throttles when it is not fronted).
       */
      step: (seconds: number) => {
        for (let i = 0; i < seconds * 60; i++) {
          t += 1 / 60;
          shown?.mixer.update(1 / 60);
          shown?.cloth?.step(1 / 60, windLevel, t);
        }
      },
    };
  },
};
