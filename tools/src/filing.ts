import fs from 'node:fs';
import path from 'node:path';
import {
  ASSET_KINDS,
  AssetFileSchema,
  CharacterDefSchema,
  CREATION_SLOTS,
  FILING_USES,
  PartNamesSchema,
  type AssetDef,
  type AssetFile,
  type AssetKind,
  type CharacterDef,
  type FilingRow,
  type FilingUse,
  type PartNames,
  kindForUse,
  meshShelf,
  parsePolygonPart,
  useForKind,
} from '@rc/shared';
import { listJson } from './validate-content';

/**
 * Asset filing (D-631): every mesh a pack ships, and what it is filed as.
 *
 * The stakeholder's brief: the Unfiled tab becomes a FILING tab, first on
 * the Art stage, where every asset is visible and filed from — as a body
 * part, clothing, a weapon, a pickup, an environment piece, a projectile —
 * with one mesh allowed several uses (an arrow is a pickup AND a projectile),
 * existing categories used to label what is already filed, and anything
 * unlabelled highlighted.
 *
 * ⚠ Filing is not a new document. It is READ off the files that already
 * decide it — the four asset kinds under `content/assets/`, the `base` tag
 * under `content/parts/`, the creature definitions under
 * `content/characters/` — and WRITTEN back into them. A separate filing file
 * would be a second source that drifts from the one the game reads, which
 * is D-576's mistake with a new name.
 *
 * ⚠ Unfiling refuses by name when something references the asset: an area
 * placing it, an item drawn as it, a station or node wearing it, a roamer
 * looking like it. The recipe graph made that rule for items (D-569); it
 * holds here for the same reason — a clean delete and a broken build are the
 * same act.
 */

const FACE = new Set<string>(CREATION_SLOTS);

export interface FilingWorld {
  contentDir: string;
  pack: string;
  /** Every mesh stem in the pack, from the ingested art. */
  stems: readonly string[];
  /**
   * The longest extent of a mesh in its own units, when the caller can see
   * the art. Packs disagree about units by a hundredfold (D-561), and a
   * fresh entry at scale 1 for a centimetre mesh is a 93-metre arrow — the
   * tool guesses the scale by measuring, and so should a filing.
   */
  measure?: (stem: string) => number | null;
  /**
   * The rig a mesh's skeleton is on, when the caller can read the art, or
   * null for a skeleton that matches no known rig. A creature on an unknown
   * rig stops `build:characters` by name (D-556), and the stakeholder hit
   * exactly that by filing the pack's whole-cast Godot export as a creature:
   * the refusal belongs here, before the definition exists.
   */
  rigOf?: (stem: string) => string | null;
}

function assetFile(contentDir: string, pack: string, kind: AssetKind): AssetFile {
  const file = path.join(contentDir, 'assets', `${pack}.${kind}.json`);
  if (!fs.existsSync(file)) return { pack, kind, assets: [] };
  return AssetFileSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
}

function writeAssetFile(contentDir: string, file: AssetFile): void {
  const dir = path.join(contentDir, 'assets');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${file.pack}.${file.kind}.json`),
    `${JSON.stringify(file, null, 2)}\n`,
  );
}

function partsFile(contentDir: string, pack: string): PartNames {
  const file = path.join(contentDir, 'parts', `${pack}.json`);
  if (!fs.existsSync(file)) return { pack, names: {}, tags: {} };
  return PartNamesSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
}

function characters(contentDir: string): CharacterDef[] {
  return listJson(path.join(contentDir, 'characters')).flatMap((f) => {
    const parsed = CharacterDefSchema.safeParse(JSON.parse(fs.readFileSync(f, 'utf8')));
    return parsed.success ? [parsed.data] : [];
  });
}

/** Is this part the bare body, or something worn over it? */
function partUse(part: { slot: string }, tags: readonly string[]): FilingUse {
  return FACE.has(part.slot) || tags.includes('base') ? 'body-part' : 'clothing';
}

export function filingRows(world: FilingWorld): FilingRow[] {
  const { contentDir, pack, stems } = world;
  const byKind = new Map<AssetKind, Set<string>>();
  for (const kind of ASSET_KINDS) {
    byKind.set(kind, new Set(assetFile(contentDir, pack, kind).assets.map((a) => a.mesh)));
  }
  const parts = partsFile(contentDir, pack);
  const creatures = new Set(
    characters(contentDir).filter((c) => c.pack === pack && c.mesh).map((c) => c.mesh!),
  );

  return stems.map((stem) => {
    const shelf = meshShelf(stem);
    const uses: FilingUse[] = [];
    let allowed: FilingUse[];
    let slot: string | undefined;
    if (shelf === 'helper') {
      uses.push('helper');
      allowed = [];
    } else if (shelf === 'body-part') {
      const parsed = parsePolygonPart(`${stem}.fbx`);
      if (parsed) {
        slot = parsed.slot;
        uses.push(partUse(parsed, parts.tags[stem] ?? []));
        // A face is never clothing; anything else may be either.
        allowed = FACE.has(parsed.slot) ? ['body-part'] : ['body-part', 'clothing'];
      } else {
        allowed = [];
      }
    } else {
      // Whole bodies and everything else: the asset kinds, and creature for a
      // rigged body.
      for (const kind of ASSET_KINDS) if (byKind.get(kind)!.has(stem)) uses.push(useForKind(kind));
      if (creatures.has(stem)) uses.push('creature');
      allowed = ['weapon', 'environment', 'pickup', 'projectile'];
      // A whole body may be a creature — and so may something the prefixes
      // could not place, because a person filing it knows what it is.
      if (shelf === 'character' || shelf === 'unfiled') allowed.unshift('creature');
    }
    return { stem, shelf, uses, allowed, ...(slot ? { slot } : {}), unfiled: uses.length === 0 };
  });
}

/** Where an asset id is referenced, by document, so unfiling can say what breaks. */
function referencesTo(contentDir: string, pack: string, kind: AssetKind, id: string): string[] {
  const out: string[] = [];
  const key = `${pack}/${id}`;
  if (kind === 'environment') {
    for (const f of listJson(path.join(contentDir, 'areas'))) {
      const doc = JSON.parse(fs.readFileSync(f, 'utf8')) as
        { id?: string; assets?: { pack: string; asset: string }[] };
      const n = (doc.assets ?? []).filter((a) => a.pack === pack && a.asset === id).length;
      if (n) out.push(`area ${doc.id ?? path.basename(f)} places it ${n} time(s)`);
    }
    for (const sub of ['stations', 'nodes']) {
      for (const f of listJson(path.join(contentDir, sub))) {
        const doc = JSON.parse(fs.readFileSync(f, 'utf8')) as
          { id?: string; art?: { pack: string; asset: string } };
        if (doc.art && doc.art.pack === pack && doc.art.asset === id) {
          out.push(`${sub.slice(0, -1)} ${doc.id ?? path.basename(f)} is drawn as it`);
        }
      }
    }
  }
  if (kind === 'character-item' || kind === 'pickup' || kind === 'projectile') {
    for (const f of listJson(path.join(contentDir, 'items'))) {
      const doc = JSON.parse(fs.readFileSync(f, 'utf8')) as
        { id?: string; art?: { pack: string; asset: string } };
      if (doc.art && `${doc.art.pack}/${doc.art.asset}` === key) {
        out.push(`item ${doc.id ?? path.basename(f)} is drawn as it`);
      }
    }
  }
  return out;
}

function idFrom(stem: string): string {
  return stem.replace(/^S[MK]_/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function nameFrom(stem: string): string {
  return stem
    .replace(/^S[MK]_/i, '')
    .replace(/^(Wep|Bld|Env|Prop|Gen|Item|Veh)_/i, '')
    .replace(/_(\d+)$/, '')
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
}

/**
 * A fresh entry for a mesh filed under a kind. The same defaults the tool's
 * `blankAsset` uses, and the same scale guess when the caller can measure
 * the mesh; the property panel's centimetre reading is where a wrong unit
 * gets caught either way (D-561).
 */
function blankFor(kind: AssetKind, pack: string, mesh: string, taken: Set<string>, longest: number | null): AssetDef {
  let id = idFrom(mesh);
  for (let n = 2; taken.has(id); n++) id = `${idFrom(mesh)}-${n}`;
  const core = { id, name: nameFrom(mesh), pack, mesh, tags: [] as string[] };
  // The tool's own rule (`guessScale`): over 20 units long is centimetres.
  const scale = longest !== null && longest > 20 ? 0.01 : 1;
  const transform = { position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale };
  if (kind === 'character-item') {
    return { ...core, kind, attach: 'Hand_R', transform, stance: 'one-handed', clips: {} };
  }
  if (kind === 'environment') {
    return { ...core, kind, solid: true, opaque: true, footprint: [1, 1], operable: false, seat: false, clips: {}, collision: [] };
  }
  if (kind === 'projectile') return { ...core, kind, transform, speed: 30 };
  return { ...core, kind, transform };
}

export interface FilingResult {
  ok: boolean;
  problems: string[];
  /** Content directories written, for the publisher. */
  changed: string[];
  row?: FilingRow;
}

/**
 * Make a mesh's uses exactly `wanted`. Adds and removes across the files
 * that own each use; refuses the whole change if any removal is referenced.
 */
export function applyFiling(world: FilingWorld, stem: string, wanted: readonly FilingUse[]): FilingResult {
  const { contentDir, pack } = world;
  if (!world.stems.includes(stem)) return { ok: false, problems: [`${stem} is not in ${pack}`], changed: [] };
  const row = filingRows({ ...world, stems: [stem] })[0]!;
  const bad = wanted.filter((u) => !(FILING_USES as readonly string[]).includes(u));
  if (bad.length) return { ok: false, problems: [`not a use: ${bad.join(', ')}`], changed: [] };
  if (wanted.includes('creature') && !row.uses.includes('creature') && world.rigOf) {
    const rig = world.rigOf(stem);
    if (rig === null) {
      return {
        ok: false,
        problems: [
          `${stem}: its skeleton matches no known rig, so it cannot be a creature — `
          + 'the build would stop on it. If it is a whole cast exported as one file, it is not a character at all.',
        ],
        changed: [],
      };
    }
  }
  const disallowed = wanted.filter((u) => !row.allowed.includes(u));
  if (disallowed.length) {
    return {
      ok: false,
      problems: [`${stem} cannot be filed as ${disallowed.join(', ')} — it is a ${row.shelf.replace('-', ' ')}`],
      changed: [],
    };
  }
  const changed = new Set<string>();
  const problems: string[] = [];
  const adding = wanted.filter((u) => !row.uses.includes(u));
  const removing = row.uses.filter((u) => !wanted.includes(u));

  // Refuse BEFORE writing anything: a half-applied filing is two files that
  // disagree about what a mesh is.
  for (const use of removing) {
    const kind = kindForUse(use);
    if (kind) {
      const file = assetFile(contentDir, pack, kind);
      for (const a of file.assets.filter((x) => x.mesh === stem)) {
        for (const ref of referencesTo(contentDir, pack, kind, a.id)) problems.push(`${a.id}: ${ref}`);
      }
    }
    if (use === 'creature') {
      const def = characters(contentDir).find((c) => c.pack === pack && c.mesh === stem);
      if (def) {
        for (const f of listJson(path.join(contentDir, 'roamers'))) {
          const doc = JSON.parse(fs.readFileSync(f, 'utf8')) as { id?: string; character?: string };
          if (doc.character === def.id) problems.push(`${def.id}: roamer ${doc.id} is drawn as it`);
        }
      }
    }
  }
  if (problems.length) return { ok: false, problems, changed: [] };

  // The body-part / clothing pair is one tag: clothing means NOT base.
  if (row.shelf === 'body-part' && (adding.length || removing.length)) {
    const parts = partsFile(contentDir, pack);
    const tags = new Set(parts.tags[stem] ?? []);
    if (wanted.includes('body-part')) tags.add('base');
    else tags.delete('base');
    if (tags.size) parts.tags[stem] = [...tags].sort();
    else delete parts.tags[stem];
    const dir = path.join(contentDir, 'parts');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${pack}.json`), `${JSON.stringify(parts, null, 2)}\n`);
    changed.add('parts');
  }

  for (const use of adding) {
    const kind = kindForUse(use);
    if (kind) {
      const file = assetFile(contentDir, pack, kind);
      const taken = new Set(file.assets.map((a) => a.id));
      file.assets.push(blankFor(kind, pack, stem, taken, world.measure?.(stem) ?? null));
      writeAssetFile(contentDir, file);
      changed.add('assets');
    } else if (use === 'creature') {
      const dir = path.join(contentDir, 'characters');
      const taken = new Set(characters(contentDir).map((c) => c.id));
      let id = idFrom(stem);
      for (let n = 2; taken.has(id); n++) id = `${idFrom(stem)}-${n}`;
      const def: CharacterDef = {
        id,
        name: nameFrom(stem),
        pack,
        sex: /_female\b/i.test(stem) ? 'female' : 'male',
        parts: {},
        mesh: stem,
        // A CREATURE, so it stays out of the pool that draws anybody who
        // never chose a face (D-618).
        kind: 'creature',
      };
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${id}.json`), `${JSON.stringify(def, null, 2)}\n`);
      changed.add('characters');
    }
  }
  for (const use of removing) {
    const kind = kindForUse(use);
    if (kind) {
      const file = assetFile(contentDir, pack, kind);
      file.assets = file.assets.filter((a) => a.mesh !== stem);
      writeAssetFile(contentDir, file);
      changed.add('assets');
    } else if (use === 'creature') {
      const def = characters(contentDir).find((c) => c.pack === pack && c.mesh === stem);
      if (def) {
        fs.unlinkSync(path.join(contentDir, 'characters', `${def.id}.json`));
        changed.add('characters');
      }
    }
  }
  return {
    ok: true,
    problems: [],
    changed: [...changed],
    row: filingRows({ ...world, stems: [stem] })[0]!,
  };
}
