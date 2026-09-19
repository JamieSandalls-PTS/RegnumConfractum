import * as THREE from 'three';
import { VfxDefSchema, type VfxDef } from '@rc/shared';
import { VfxSystem, pixelsPerMetre, setVfxDefinitions } from '../render/vfx';
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
  textInput,
} from './context';

/**
 * The Effects tab (D-639): ONE page to make a VFX, usable anywhere a VFX
 * can be applied — a fire in a fireplace on the map, a glow on a held weapon,
 * a fireball leaving a staff, the impact where it lands.
 *
 * What is authored is a `content/vfx/<id>.json`: particles, a light and a
 * glow, any of them absent, looping or one-shot. The stage runs the game's
 * own `VfxSystem` on the draft, on a small dark floor, so what is tuned here
 * is what the game draws (D-543's promise, kept for light). A one-shot is
 * replayed on a button and after every edit.
 *
 * ⚠ Colours are picked, not typed: an effect is judged by looking, and a hex
 * field is a way to look at the wrong thing.
 */

interface Data { vfx: VfxDef[]; usedBy: Record<string, string[]> }

let data: Data = { vfx: [], usedBy: {} };
let picked: string | null = null;
let draft: VfxDef | null = null;
let system: VfxSystem | null = null;
let burning: { stop(): void } | null = null;
let problemsBox: HTMLElement | null = null;
let clock = 0;

async function load(ctx: ToolContext): Promise<void> {
  const res = await fetch(`${ctx.api}/vfx`);
  if (!res.ok) {
    ctx.status('could not load effects', 'bad');
    return;
  }
  data = (await res.json()) as Data;
  // The editor and the item form read the same catalogue the game will.
  setVfxDefinitions(data.vfx);
}

function uniqueId(): string {
  const taken = new Set(data.vfx.map((v) => v.id));
  for (let n = 1; ; n++) {
    const id = `effect-${n}`;
    if (!taken.has(id)) return id;
  }
}

/** A fresh draft: a small fire, because a blank effect shows nothing to tune. */
function fresh(id: string): VfxDef {
  return VfxDefSchema.parse({
    id,
    name: 'New effect',
    loop: true,
    particles: {},
    light: {},
    glow: {},
  });
}

function pick(ctx: ToolContext, id: string | null): void {
  picked = id;
  const saved = data.vfx.find((v) => v.id === id);
  draft = saved ? VfxDefSchema.parse(JSON.parse(JSON.stringify(saved))) : null;
  renderList(ctx);
  renderSide(ctx);
  replay();
}

/* ----------------------------------------------------------------- stage */

function ensureStage(ctx: ToolContext): void {
  if (system) return;
  ctx.mount.clear();
  // A dark disc to burn on: an effect is light, and light is judged against
  // something for it to fall on.
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(2.2, 40),
    new THREE.MeshStandardMaterial({ color: 0x2a2622, roughness: 0.95 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  ctx.mount.add(floor);
  const post = new THREE.Mesh(
    new THREE.BoxGeometry(0.3, 1.0, 0.3),
    new THREE.MeshStandardMaterial({ color: 0x4a423a, roughness: 0.9 }),
  );
  post.position.set(1.1, 0.5, 0);
  ctx.mount.add(post);
  system = new VfxSystem(ctx.scene.scene);
  ctx.view(0.6, 1.4, 0.3);
  ctx.onFrame((dt) => {
    if (!system) return;
    clock += dt;
    const size = ctx.scene.renderer.getDrawingBufferSize(new THREE.Vector2());
    system.update(dt, clock, null, pixelsPerMetre(ctx.scene.camera, size.y));
    system.lights.update(new THREE.Vector3(0, 0, 0), clock);
  });
}

/** Start (or restart) the draft on the stage. */
function replay(): void {
  burning?.stop();
  burning = null;
  if (!system || !draft) return;
  const parsed = VfxDefSchema.safeParse(draft);
  if (!parsed.success) return;
  burning = system.spawn(parsed.data, new THREE.Vector3(0, 0, 0));
}

/* ------------------------------------------------------------------ panes */

function renderList(ctx: ToolContext): void {
  const host = ctx.list;
  host.replaceChildren();
  host.append(heading('Effects'));
  host.append(button('New effect', () => {
    const id = uniqueId();
    draft = fresh(id);
    picked = id;
    data.vfx.push(draft);
    renderList(ctx);
    renderSide(ctx);
    replay();
    ctx.markDirty();
  }, true));
  for (const v of data.vfx) {
    const uses = data.usedBy[v.id]?.length ?? 0;
    const parts = [v.particles && 'particles', v.light && 'light', v.glow && 'glow'].filter(Boolean).join(' · ');
    host.append(listRow(
      v.name,
      `${v.loop ? 'loops' : `one-shot ${v.duration}s`} · ${parts || 'nothing'}${uses ? ` · used ${uses}×` : ' · unused'}`,
      picked === v.id,
      () => pick(ctx, v.id),
    ));
  }
  host.append(hint(
    'An effect is usable anywhere one can be applied: placed on a map (World → Map builder, '
    + 'the <b>vfx</b> tool), on an item as its held glow, attack, projectile trail or impact '
    + '(Things → Items), and by scripts later. Unused effects still build; a deleted one is refused '
    + 'while anything names it.',
  ));
}

type Num = { get(): number; set(v: number): void; min?: number; max?: number; step?: number };

function numberField(label: string, n: Num, onChange: () => void): DocumentFragment {
  const input = el('input');
  input.type = 'number';
  input.value = String(n.get());
  if (n.min !== undefined) input.min = String(n.min);
  if (n.max !== undefined) input.max = String(n.max);
  input.step = String(n.step ?? 0.1);
  input.oninput = () => {
    const v = Number(input.value);
    if (Number.isFinite(v)) {
      n.set(v);
      onChange();
    }
  };
  return labelled(label, input);
}

function colourField(label: string, get: () => string, set: (v: string) => void, onChange: () => void): DocumentFragment {
  const input = el('input');
  input.type = 'color';
  input.value = get();
  input.style.cssText = 'width:48px;height:26px;padding:0';
  input.oninput = () => {
    set(input.value);
    onChange();
  };
  return labelled(label, input);
}

function rangeField(
  label: string,
  get: () => [number, number],
  set: (v: [number, number]) => void,
  step: number,
  onChange: () => void,
): DocumentFragment {
  const row = el('div');
  row.style.cssText = 'display:flex;gap:6px';
  const mk = (i: 0 | 1): HTMLInputElement => {
    const input = el('input');
    input.type = 'number';
    input.step = String(step);
    input.value = String(get()[i]);
    input.oninput = () => {
      const v = Number(input.value);
      if (!Number.isFinite(v)) return;
      const cur = get();
      const next: [number, number] = i === 0 ? [v, cur[1]] : [cur[0], v];
      set(next);
      onChange();
    };
    return input;
  };
  row.append(mk(0), mk(1));
  return labelled(label, row);
}

function renderSide(ctx: ToolContext): void {
  const host = ctx.side;
  host.replaceChildren();
  if (!draft) {
    host.append(el('div', { className: 'count', textContent: 'Pick an effect, or make one.' }));
    ctx.banner('');
    return;
  }
  const d = draft;
  const changed = (): void => {
    ctx.markDirty();
    replay();
    ctx.banner(`${d.name} — ${d.loop ? 'burning' : 'one-shot, replayed on each edit'}`);
  };

  host.append(el('h1', { textContent: d.name }));
  host.append(labelled('Id', textInput(d.id, () => { /* ids are fixed once made */ })));
  (host.lastElementChild as HTMLInputElement).disabled = true;
  host.append(labelled('Name', textInput(d.name, (v) => { d.name = v; changed(); })));
  host.append(labelled('Notes (never shown to players)', textInput(d.notes, (v) => { d.notes = v; ctx.markDirty(); })));

  const loopRow = el('div');
  loopRow.className = 'chips';
  loopRow.append(
    chip('loops', d.loop, () => { d.loop = true; changed(); renderSide(ctx); }, 'burns until removed — a hearth, a glowing blade, a trail'),
    chip('one-shot', !d.loop, () => { d.loop = false; changed(); renderSide(ctx); }, 'plays once — an impact, a flash'),
  );
  host.append(labelled('Life', loopRow));
  if (!d.loop) {
    host.append(numberField('Duration (s)', { get: () => d.duration, set: (v) => { d.duration = v; }, min: 0.05, max: 10, step: 0.05 }, changed));
  }

  /* particles */
  const pOn = Boolean(d.particles);
  const pHead = el('div');
  pHead.className = 'chips';
  pHead.append(chip(pOn ? 'particles: on' : 'particles: off', pOn, () => {
    d.particles = pOn ? undefined : VfxDefSchema.shape.particles.unwrap().parse({});
    changed();
    renderSide(ctx);
  }));
  host.append(heading('Particles'), pHead);
  if (d.particles) {
    const p = d.particles;
    host.append(numberField(d.loop ? 'Motes per second' : 'Motes in the burst', { get: () => p.rate, set: (v) => { p.rate = v; }, min: 0, max: 400, step: 1 }, changed));
    host.append(rangeField('Life (s) from → to', () => p.life, (v) => { p.life = v; }, 0.05, changed));
    host.append(rangeField('Speed (m/s) low → high', () => p.speed, (v) => { p.speed = v; }, 0.05, changed));
    host.append(labelled('Direction', selectInput(
      [
        { value: 'up', label: 'up — fire, smoke' },
        { value: 'out', label: 'out — a burst' },
        { value: 'down', label: 'down — a dissolve' },
        { value: 'none', label: 'none — they only drift' },
      ],
      p.direction,
      (v) => { p.direction = v as typeof p.direction; changed(); },
    )));
    host.append(numberField('Spread (0 beam → 1 anywhere)', { get: () => p.spread, set: (v) => { p.spread = v; }, min: 0, max: 1, step: 0.05 }, changed));
    host.append(numberField('Gravity (m/s², negative rises)', { get: () => p.gravity, set: (v) => { p.gravity = v; }, min: -10, max: 20, step: 0.1 }, changed));
    host.append(numberField('Drift (m/s)', { get: () => p.drift, set: (v) => { p.drift = v; }, min: 0, max: 3, step: 0.01 }, changed));
    host.append(rangeField('Size (m) birth → death', () => p.size, (v) => { p.size = v; }, 0.01, changed));
    host.append(colourField('Colour at birth', () => p.colour[0], (v) => { p.colour = [v, p.colour[1]]; }, changed));
    host.append(colourField('Colour at death', () => p.colour[1], (v) => { p.colour = [p.colour[0], v]; }, changed));
    host.append(numberField('Birth radius (m)', { get: () => p.radius, set: (v) => { p.radius = v; }, min: 0, max: 5, step: 0.01 }, changed));
    const blend = el('div');
    blend.className = 'chips';
    blend.append(
      chip('additive (light)', p.additive, () => { p.additive = true; changed(); renderSide(ctx); }),
      chip('plain (matter)', !p.additive, () => { p.additive = false; changed(); renderSide(ctx); }),
    );
    host.append(labelled('Blending', blend));
  }

  /* light */
  const lOn = Boolean(d.light);
  const lHead = el('div');
  lHead.className = 'chips';
  lHead.append(chip(lOn ? 'light: on' : 'light: off', lOn, () => {
    d.light = lOn ? undefined : VfxDefSchema.shape.light.unwrap().parse({});
    changed();
    renderSide(ctx);
  }));
  host.append(heading('Light'), lHead);
  if (d.light) {
    const l = d.light;
    host.append(colourField('Colour', () => l.colour, (v) => { l.colour = v; }, changed));
    host.append(numberField('Intensity', { get: () => l.intensity, set: (v) => { l.intensity = v; }, min: 0, max: 200, step: 0.5 }, changed));
    host.append(numberField('Reach (m)', { get: () => l.distance, set: (v) => { l.distance = v; }, min: 0, max: 60, step: 0.5 }, changed));
    host.append(numberField('Height above origin (m)', { get: () => l.height, set: (v) => { l.height = v; }, min: -2, max: 5, step: 0.05 }, changed));
    host.append(numberField('Flicker amount', { get: () => l.flicker.amount, set: (v) => { l.flicker.amount = v; }, min: 0, max: 1, step: 0.05 }, changed));
    host.append(hint('Lights share the game\'s pool of eight (D-544): the nearest eight sources are real, the rest wait their turn.'));
  }

  /* glow */
  const gOn = Boolean(d.glow);
  const gHead = el('div');
  gHead.className = 'chips';
  gHead.append(chip(gOn ? 'glow: on' : 'glow: off', gOn, () => {
    d.glow = gOn ? undefined : VfxDefSchema.shape.glow.unwrap().parse({});
    changed();
    renderSide(ctx);
  }));
  host.append(heading('Glow'), gHead);
  if (d.glow) {
    const g = d.glow;
    host.append(colourField('Colour', () => g.colour, (v) => { g.colour = v; }, changed));
    host.append(numberField('Radius (m)', { get: () => g.radius, set: (v) => { g.radius = v; }, min: 0.01, max: 5, step: 0.01 }, changed));
    host.append(numberField('Opacity', { get: () => g.opacity, set: (v) => { g.opacity = v; }, min: 0, max: 1, step: 0.05 }, changed));
    host.append(numberField('Height above origin (m)', { get: () => g.height, set: (v) => { g.height = v; }, min: -2, max: 5, step: 0.05 }, changed));
    host.append(numberField('Pulse amount', { get: () => g.pulse.amount, set: (v) => { g.pulse.amount = v; }, min: 0, max: 1, step: 0.05 }, changed));
    host.append(numberField('Pulse speed (Hz)', { get: () => g.pulse.speed, set: (v) => { g.pulse.speed = v; }, min: 0, max: 30, step: 0.1 }, changed));
  }

  /* actions */
  const actions = el('div');
  actions.style.cssText = 'display:flex;gap:8px;margin-top:14px;flex-wrap:wrap';
  actions.append(
    button('Replay', () => replay()),
    button('Save effect', () => void save(ctx), true),
    button('Delete', () => void remove(ctx)),
  );
  host.append(actions);
  const uses = data.usedBy[d.id] ?? [];
  host.append(hint(uses.length
    ? `Used by: ${uses.map((u) => `<code>${u}</code>`).join(', ')}`
    : 'Nothing uses this effect yet. Place it on a map or name it on an item.'));
  problemsBox = el('div', { id: 'problems' });
  host.append(problemsBox);
  host.append(hint(`Written to <code>content/vfx/${d.id}.json</code>. Publish sends it to a running game (hot).`));
  ctx.banner(`${d.name} — ${d.loop ? 'burning' : 'one-shot: Replay to see it again'}`);
}

async function save(ctx: ToolContext): Promise<void> {
  if (!draft) return;
  const parsed = VfxDefSchema.safeParse(draft);
  if (!parsed.success) {
    ctx.problems(problemsBox!, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`), '');
    return;
  }
  const res = await fetch(`${ctx.api}/vfx/${encodeURIComponent(parsed.data.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(parsed.data),
  });
  const body = (await res.json()) as { saved?: string; problems?: string[]; error?: string; issues?: { path: (string | number)[]; message: string }[] };
  if (!res.ok) {
    const lines = body.problems ?? body.issues?.map((i) => `${i.path.join('.')}: ${i.message}`) ?? [body.error ?? 'refused'];
    ctx.problems(problemsBox!, lines, '');
    ctx.status('not saved', 'bad');
    return;
  }
  ctx.clearDirty();
  ctx.status(`saved ${body.saved}`, 'good');
  await load(ctx);
  pick(ctx, parsed.data.id);
  ctx.problems(problemsBox!, [], `Saved content/vfx/${parsed.data.id}.json`);
}

async function remove(ctx: ToolContext): Promise<void> {
  if (!draft) return;
  const res = await fetch(`${ctx.api}/vfx/${encodeURIComponent(draft.id)}`, { method: 'DELETE' });
  const body = (await res.json()) as { deleted?: string; problems?: string[]; error?: string };
  if (!res.ok) {
    ctx.problems(problemsBox!, body.problems ?? [body.error ?? 'refused'], '');
    ctx.status('not deleted', 'bad');
    return;
  }
  ctx.status(`deleted ${body.deleted}`, 'good');
  await load(ctx);
  pick(ctx, data.vfx[0]?.id ?? null);
}

export const vfxTab: ToolTab = {
  async enter(ctx) {
    // ⚠ The stage was cleared by the tab switch, so the system is rebuilt:
    // a `VfxSystem` holding a group in a scene that emptied it draws nothing.
    system?.dispose();
    system = null;
    burning = null;
    await load(ctx);
    ensureStage(ctx);
    pick(ctx, picked && data.vfx.some((v) => v.id === picked) ? picked : (data.vfx[0]?.id ?? null));
  },
};

/** For the verification hook: what the stage is burning. */
export function vfxStageStats(): { live: number; motes: number } | null {
  if (!system) return null;
  const s = system.stats();
  return { live: s.live, motes: s.motes };
}
