import * as THREE from 'three';
import { FILING_LABELS, FILING_USES, type FilingRow, type FilingUse, preferredAtlas } from '@rc/shared';
import { assetMesh, loadAssetCatalogue, loadAssetPacks, measure } from '../creation-assets';
import { type ToolContext, type ToolTab, chip, el, heading, hint, labelled, selectInput } from './context';

/**
 * The Filing tab (D-631): first on the Art stage, every mesh a pack ships,
 * and what each is filed as.
 *
 * It replaces the Unfiled tab, which showed only the leftovers. This shows
 * everything, because the question is not "what is left" but "what is this
 * for" — and one mesh may have several answers. An arrow is a pickup on the
 * ground and a projectile in the air; a hood is clothing; a rigged body is a
 * creature. Filing under a use CREATES the entry the game reads (an asset in
 * `content/assets/`, a `base` tag in `content/parts/`, a definition in
 * `content/characters/`), so this tab and the per-kind tabs beside it are
 * two views of one set of files.
 *
 * ⚠ Unfiled rows are highlighted, and that highlight is the tab's product: a
 * mesh nobody has filed is a mesh no tab lists and no map can place.
 */

let packs: string[] = [];
let pack = '';
let rows: FilingRow[] = [];
let textures: string[] = [];
let filter: 'all' | 'unfiled' | FilingUse = 'all';
let search = '';
let picked: string | null = null;
let previewToken = 0;
let atlas: THREE.Texture | null = null;
const texLoader = new THREE.TextureLoader();

const USE_HINTS: Record<FilingUse, string> = {
  'body-part': 'the bare body, offered at character creation (the base tag)',
  clothing: 'worn over the body — a garment swaps it in (D-570)',
  creature: 'a whole rigged body: a goblin, a golem (content/characters/)',
  weapon: 'held or worn on a bone, with a grip and a stance (content/assets/*.character-item)',
  environment: 'placed in the world, with collision (content/assets/*.environment)',
  pickup: 'something that goes in a pack (content/assets/*.pickup)',
  projectile: 'something that flies: an arrow, a bolt (content/assets/*.projectile)',
  helper: 'a collision hull or LOD the vendor shipped — filed by the pack',
};

async function load(ctx: ToolContext): Promise<void> {
  const res = await fetch(`${ctx.api}/filing/${encodeURIComponent(pack)}`);
  if (!res.ok) {
    ctx.status('could not load the filing', 'bad');
    return;
  }
  const body = (await res.json()) as { rows: FilingRow[]; textures: string[] };
  rows = body.rows;
  textures = body.textures;
}

function visible(): FilingRow[] {
  const q = search.toLowerCase();
  return rows.filter((r) => {
    if (filter === 'unfiled' && !r.unfiled) return false;
    if (filter !== 'all' && filter !== 'unfiled' && !r.uses.includes(filter)) return false;
    return !q || r.stem.toLowerCase().includes(q);
  });
}

function renderList(ctx: ToolContext): void {
  const host = ctx.list;
  host.replaceChildren();
  const unfiled = rows.filter((r) => r.unfiled).length;
  host.append(el('h1', { textContent: 'Filing' }));
  host.append(labelled('Pack', selectInput(
    packs.map((p) => ({ value: p, label: p })),
    pack,
    (v) => {
      pack = v;
      picked = null;
      void load(ctx).then(() => {
        renderList(ctx);
        renderSide(ctx);
      });
    },
  )));
  const count = el('div', { className: 'count' });
  count.innerHTML = unfiled
    ? `${rows.length} meshes · <span class="warn">${unfiled} unfiled</span>`
    : `${rows.length} meshes · all filed`;
  host.append(count);

  const chips = el('div', { className: 'chips' });
  chips.append(chip('all', filter === 'all', () => {
    filter = 'all';
    renderList(ctx);
  }));
  const un = chip(`unfiled (${unfiled})`, filter === 'unfiled', () => {
    filter = 'unfiled';
    renderList(ctx);
  });
  if (unfiled) un.classList.add('bad');
  chips.append(un);
  for (const use of FILING_USES) {
    const n = rows.filter((r) => r.uses.includes(use)).length;
    if (!n) continue;
    chips.append(chip(`${FILING_LABELS[use]} (${n})`, filter === use, () => {
      filter = use;
      renderList(ctx);
    }));
  }
  host.append(chips);

  const find = el('input');
  find.placeholder = 'find a mesh';
  find.value = search;
  find.oninput = () => {
    search = find.value;
    renderTable(ctx, table);
  };
  host.append(find);

  const table = el('table');
  host.append(table);
  renderTable(ctx, table);
}

function renderTable(ctx: ToolContext, table: HTMLTableElement): void {
  table.replaceChildren();
  const shown = visible();
  for (const r of shown.slice(0, 600)) {
    const tr = el('tr', { className: `${r.stem === picked ? 'on' : ''}${r.unfiled ? ' unfiled' : ''}` });
    const stem = el('td', { className: 'stem', textContent: r.stem.replace(/^S[MK]_/, ''), title: r.stem });
    const uses = el('td');
    if (r.unfiled) uses.append(el('span', { className: 'bad', textContent: '⚠ unfiled' }));
    for (const u of r.uses) {
      const c = el('span', { className: 'chip on', textContent: FILING_LABELS[u] });
      if (u === 'helper') c.className = 'chip';
      uses.append(c);
    }
    tr.append(stem, uses);
    tr.onclick = () => {
      picked = r.stem;
      renderTable(ctx, table);
      renderSide(ctx);
      void preview(ctx, r.stem);
    };
    table.append(tr);
  }
  if (shown.length > 600) {
    const more = el('tr');
    more.append(el('td', { textContent: `… and ${shown.length - 600} more — narrow the filter` }));
    table.append(more);
  }
  if (shown.length === 0) {
    const none = el('tr');
    none.append(el('td', { textContent: 'nothing matches' }));
    table.append(none);
  }
}

function renderSide(ctx: ToolContext): void {
  const host = ctx.side;
  host.replaceChildren();
  const r = rows.find((x) => x.stem === picked);
  if (!r) {
    host.append(el('h1', { textContent: 'Filing' }), hint(
      'Pick a mesh. Its uses are toggles: filing it as a weapon creates the '
      + 'weapon entry the Weapon assets tab edits; unfiling removes it, and is '
      + 'refused by name while anything still references it.',
    ));
    return;
  }
  host.append(el('h1', { textContent: r.stem.replace(/^S[MK]_/, '') }));
  const meta = el('div', { className: 'count' });
  meta.textContent = `${r.shelf.replace('-', ' ')}${r.slot ? ` · slot ${r.slot}` : ''}`;
  host.append(meta);
  if (r.unfiled) host.append(el('div', { className: 'bad', textContent: '⚠ Unfiled — no tab lists it and nothing can place it.' }));

  host.append(heading('Filed as'));
  if (r.allowed.length === 0 && r.uses.length) {
    host.append(hint(`Filed by the pack as a <b>${FILING_LABELS[r.uses[0]!]}</b>: ${USE_HINTS[r.uses[0]!]}.`));
  }
  const problems = el('div', { id: 'problems' });
  for (const use of r.allowed) {
    const on = r.uses.includes(use);
    const row = el('div', { className: 'check' });
    const input = el('input');
    input.type = 'checkbox';
    input.checked = on;
    input.onchange = () => void toggle(ctx, r, use, input.checked, problems);
    const text = el('span');
    text.append(el('b', { textContent: FILING_LABELS[use] }), ` — ${USE_HINTS[use]}`);
    row.append(input, text);
    host.append(row);
  }
  host.append(problems);
  host.append(hint(
    'A mesh may have several uses. Filing writes the file the game reads and '
    + 'nothing else; set the properties on the use’s own tab.',
  ));
}

async function toggle(
  ctx: ToolContext, r: FilingRow, use: FilingUse, on: boolean, problems: HTMLElement,
): Promise<void> {
  let wanted = r.uses.filter((u) => u !== use);
  if (on) wanted.push(use);
  // Body part and clothing are one tag with two faces.
  if (on && use === 'body-part') wanted = wanted.filter((u) => u !== 'clothing');
  if (on && use === 'clothing') wanted = wanted.filter((u) => u !== 'body-part');
  const res = await fetch(`${ctx.api}/filing/${encodeURIComponent(pack)}/${encodeURIComponent(r.stem)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uses: wanted }),
  });
  const body = (await res.json().catch(() => ({}))) as { problems?: string[]; error?: string; row?: FilingRow };
  if (!res.ok) {
    ctx.problems(problems, body.problems ?? [body.error ?? 'refused'], '');
    ctx.status('not filed', 'bad');
    renderSide(ctx);
    return;
  }
  if (body.row) {
    const i = rows.findIndex((x) => x.stem === r.stem);
    if (i >= 0) rows[i] = body.row;
  }
  ctx.status(`filed ${r.stem}`, 'good');
  renderList(ctx);
  renderSide(ctx);
}

/** The raw pack mesh on the stage, in the pack's own atlas, at a sane size. */
async function preview(ctx: ToolContext, stem: string): Promise<void> {
  const token = ++previewToken;
  ctx.banner('loading…');
  let object: THREE.Object3D;
  try {
    object = await assetMesh(pack, stem);
  } catch (e) {
    ctx.banner((e as Error).message);
    return;
  }
  if (token !== previewToken) return;
  if (!atlas && textures.length) {
    const tex = preferredAtlas(textures);
    try {
      atlas = await texLoader.loadAsync(`${ctx.api}/assetpacks/${encodeURIComponent(pack)}/tex/${encodeURIComponent(tex)}`);
      atlas.magFilter = THREE.NearestFilter;
      atlas.minFilter = THREE.NearestFilter;
      atlas.colorSpace = THREE.SRGBColorSpace;
    } catch {
      atlas = null;
    }
  }
  object.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !atlas) return;
    const mat = m.material as THREE.MeshStandardMaterial;
    mat.map = atlas;
    mat.needsUpdate = true;
  });
  // Measured, not assumed: packs disagree about units by 100x (D-561).
  const size = measure(object);
  const extent = Math.max(size.x, size.y, size.z) || 1;
  const scale = extent > 20 ? 0.01 : 1;
  object.scale.setScalar(scale);
  const box = new THREE.Box3().setFromObject(object);
  object.position.y -= box.min.y;
  ctx.mount.clear();
  ctx.mount.add(object);
  const h = (box.max.y - box.min.y) || 1;
  ctx.view(h / 2, Math.max(0.9, h / 2), Math.min(1.2, Math.max(0.08, h * 0.13)));
  ctx.banner(`${stem} · ${(size.x * scale).toFixed(2)} × ${(size.y * scale).toFixed(2)} × ${(size.z * scale).toFixed(2)} m`);
}

export const filingTab: ToolTab = {
  async enter(ctx) {
    packs = await loadAssetPacks();
    if (!pack || !packs.includes(pack)) pack = packs[0] ?? '';
    atlas = null;
    if (!pack) {
      ctx.list.replaceChildren(el('h1', { textContent: 'Filing' }), hint('No ingested packs in assets/source.'));
      return;
    }
    // Textures come from the catalogue the per-kind tabs already use.
    const cat = await loadAssetCatalogue(pack);
    textures = cat.textures;
    await load(ctx);
    renderList(ctx);
    renderSide(ctx);
    if (picked) void preview(ctx, picked);
  },
};
