import type { ScenarioDef } from '@rc/shared';
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
 * The Scenario stage (D-627, D-629): where everything composes into a round.
 *
 * A scenario is the round's EDGES as data — the areas it is played in, where
 * it opens, which objectives may be dealt, and the cast it needs. It is the
 * right-most stage of the production line because it names things every
 * other stage made: areas from World, objectives from Rules. Before this
 * existed the round had no concept of an area at all, and a player could walk
 * out of it into permadeath (D-627).
 *
 * ⚠ The save is refused by the same function CI calls (`scenarioProblems`),
 * so a scenario that saves is one the build accepts. Its edge report — doors
 * leading out of the set — comes back as a NOTE, because an edge is legal and
 * the point is knowing where it is.
 */

interface AreaRow { id: string; name: string; zone: string; live: boolean; exits: string[] }
interface ObjectiveRow {
  id: string; name: string; status: string; minCast: number; maxCast: number | null;
}
interface Data { scenarios: ScenarioDef[]; areas: AreaRow[]; objectives: ObjectiveRow[] }

let data: Data = { scenarios: [], areas: [], objectives: [] };
let picked: string | null = null;

async function load(ctx: ToolContext): Promise<void> {
  const res = await fetch(`${ctx.api}/scenarios`);
  if (!res.ok) {
    ctx.status('could not load scenarios', 'bad');
    return;
  }
  data = (await res.json()) as Data;
}

function current(): ScenarioDef | undefined {
  return data.scenarios.find((s) => s.id === picked);
}

function uniqueId(): string {
  const taken = new Set(data.scenarios.map((s) => s.id));
  for (let n = 1; ; n++) {
    const id = `scenario-${n}`;
    if (!taken.has(id)) return id;
  }
}

function renderList(ctx: ToolContext): void {
  const host = ctx.list;
  host.replaceChildren();
  host.append(el('h1', { textContent: 'Scenarios' }));
  host.append(button('+ New scenario', () => {
    const first = data.areas.find((a) => a.zone !== 'endgame');
    const id = uniqueId();
    data.scenarios.push({
      id,
      name: 'New scenario',
      areas: first ? [first.id] : [],
      opensIn: first?.id ?? '',
      objectives: [],
      minCast: 3,
      maxCast: null,
      status: 'planned',
    });
    picked = id;
    ctx.markDirty();
    renderList(ctx);
    renderSide(ctx);
  }));
  for (const s of data.scenarios) {
    host.append(listRow(
      s.name,
      `${s.id} · ${s.areas.length} area(s) · ${s.status}`,
      picked === s.id,
      () => {
        picked = s.id;
        renderList(ctx);
        renderSide(ctx);
      },
    ));
  }
  host.append(hint(
    'A scenario is the round’s <b>edges</b>: a transition out of its area set '
    + 'is refused while the round runs. The engine deals a random <b>live</b> '
    + 'scenario; a <b>planned</b> one is a draft it never picks.',
  ));
}

function renderSide(ctx: ToolContext): void {
  const host = ctx.side;
  host.replaceChildren();
  const s = current();
  if (!s) {
    host.append(el('h1', { textContent: 'Scenario' }), hint('Pick a scenario, or make one.'));
    return;
  }
  host.append(el('h1', { textContent: s.name }));
  host.append(labelled('Id', textInput(s.id, (v) => {
    s.id = v.trim();
    ctx.markDirty();
  }, 'ashfold')));
  host.append(labelled('Name', textInput(s.name, (v) => {
    s.name = v;
    ctx.markDirty();
    renderList(ctx);
  })));
  host.append(labelled('Status', selectInput(
    [{ value: 'live', label: 'live — may be dealt' }, { value: 'planned', label: 'planned — a draft' }],
    s.status,
    (v) => {
      s.status = v as ScenarioDef['status'];
      ctx.markDirty();
      renderList(ctx);
    },
  )));

  host.append(heading('Areas — the round’s edges'));
  const areaChips = el('div', { className: 'chips' });
  for (const a of data.areas) {
    const on = s.areas.includes(a.id);
    const endgame = a.zone === 'endgame';
    const c = chip(
      `${a.id}${endgame ? ' ⚠' : ''}`,
      on,
      () => {
        if (endgame && !on) {
          ctx.problems(problemsBox, [
            `${a.id} is an ENDGAME area — a round death there is permanent, and a round `
            + 'must never contain one (D-523)',
          ], '');
          return;
        }
        s.areas = on ? s.areas.filter((x) => x !== a.id) : [...s.areas, a.id];
        if (!s.areas.includes(s.opensIn)) s.opensIn = s.areas[0] ?? '';
        ctx.markDirty();
        renderSide(ctx);
        renderList(ctx);
      },
      `${a.name} · zone ${a.zone}${a.live ? '' : ' · not live'}\nexits: ${a.exits.join(', ') || 'none'}`,
    );
    if (endgame) c.classList.add('bad');
    areaChips.append(c);
  }
  host.append(areaChips);

  // The edges, computed here as the server will report them, so an author
  // sees a door out of the set BEFORE saving rather than in the response.
  const set = new Set(s.areas);
  const leaks: string[] = [];
  for (const id of s.areas) {
    const a = data.areas.find((x) => x.id === id);
    for (const to of a?.exits ?? []) if (!set.has(to)) leaks.push(`${id} → ${to}`);
  }
  host.append(hint(
    leaks.length
      ? `<span class="warn">Edges:</span> ${leaks.join(', ')} lead out of the set and will be refused while the round runs.`
      : 'No door leads out of the set.',
  ));

  host.append(labelled('Opens in', selectInput(
    s.areas.map((id) => ({ value: id, label: id })),
    s.opensIn,
    (v) => {
      s.opensIn = v;
      ctx.markDirty();
    },
  )));

  host.append(heading('Objectives it may deal'));
  host.append(hint('None selected means <b>every live objective</b> — the engine’s behaviour before scenarios existed.'));
  const objChips = el('div', { className: 'chips' });
  for (const o of data.objectives) {
    const on = s.objectives.includes(o.id);
    objChips.append(chip(
      `${o.name}${o.status !== 'live' ? ' (planned)' : ''}`,
      on,
      () => {
        s.objectives = on ? s.objectives.filter((x) => x !== o.id) : [...s.objectives, o.id];
        ctx.markDirty();
        renderSide(ctx);
      },
      `${o.id} · cast ${o.minCast}${o.maxCast === null ? '+' : `–${o.maxCast}`}`,
    ));
  }
  host.append(objChips);

  host.append(heading('Cast'));
  const minIn = el('input');
  minIn.type = 'number';
  minIn.min = '2';
  minIn.value = String(s.minCast);
  minIn.oninput = () => {
    s.minCast = Math.max(2, Number(minIn.value) || 2);
    ctx.markDirty();
  };
  host.append(labelled('Smallest cast', minIn));
  const maxIn = el('input');
  maxIn.type = 'number';
  maxIn.min = '2';
  maxIn.placeholder = 'no ceiling';
  maxIn.value = s.maxCast === null ? '' : String(s.maxCast);
  maxIn.oninput = () => {
    s.maxCast = maxIn.value === '' ? null : Math.max(2, Number(maxIn.value) || 2);
    ctx.markDirty();
  };
  host.append(labelled('Largest cast (blank = none)', maxIn));

  const notes = el('textarea');
  notes.rows = 4;
  notes.value = s.notes ?? '';
  notes.oninput = () => {
    s.notes = notes.value || undefined;
    ctx.markDirty();
  };
  host.append(labelled('Notes', notes));

  const bar = el('div', { className: 'row' });
  bar.style.marginTop = '16px';
  bar.append(
    button('Save', () => void save(ctx, s), true),
    button('Delete', () => void remove(ctx, s.id)),
  );
  host.append(bar);
  const problemsBox = el('div', { id: 'problems' });
  host.append(problemsBox);
}

async function save(ctx: ToolContext, s: ScenarioDef): Promise<void> {
  const box = ctx.side.querySelector('#problems') as HTMLElement;
  const res = await fetch(`${ctx.api}/scenarios/${encodeURIComponent(s.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(s),
  });
  const body = (await res.json().catch(() => ({}))) as {
    saved?: string; problems?: string[]; warnings?: string[];
    issues?: { message: string }[]; error?: string;
  };
  if (!res.ok) {
    const lines = body.problems ?? (body.issues ?? []).map((i) => i.message);
    ctx.problems(box, lines.length ? lines : [body.error ?? 'refused'], '');
    ctx.status('not saved', 'bad');
    return;
  }
  ctx.clearDirty();
  picked = s.id;
  ctx.status(`saved ${s.id}`, 'good');
  const warn = (body.warnings ?? []).map((w) => `⚠ ${w}`);
  box.innerHTML = `<div class="good">Saved content/scenarios/${s.id}.json</div>`
    + warn.map((w) => `<div class="warn">${w}</div>`).join('');
  await load(ctx);
  renderList(ctx);
}

async function remove(ctx: ToolContext, id: string): Promise<void> {
  const box = ctx.side.querySelector('#problems') as HTMLElement;
  const res = await fetch(`${ctx.api}/scenarios/${encodeURIComponent(id)}`, { method: 'DELETE' });
  const body = (await res.json().catch(() => ({}))) as { problems?: string[]; error?: string };
  if (!res.ok) {
    ctx.problems(box, body.problems ?? [body.error ?? 'refused'], '');
    ctx.status('not deleted', 'bad');
    return;
  }
  picked = null;
  await load(ctx);
  renderList(ctx);
  renderSide(ctx);
  ctx.status(`deleted ${id}`, 'good');
}

export const scenariosTab: ToolTab = {
  async enter(ctx) {
    await load(ctx);
    renderList(ctx);
    renderSide(ctx);
  },
};
