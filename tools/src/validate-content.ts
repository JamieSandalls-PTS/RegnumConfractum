import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  AreaSchema,
  ClassSchema,
  FeatsFileSchema,
  ItemTemplateSchema,
  ObjectiveSchema,
  ROUND_MIN_CAST,
  SkillsFileSchema,
  SpellsFileSchema,
  type AreaDef,
  type ClassDef,
  type FeatDef,
  type ObjectiveDef,
  type SpellDef,
} from '@rc/shared';

/**
 * Content validator (D-110, D-114). Run in CI on every build; exits non-zero
 * on any failure. Checks:
 *  - every content file parses against its schema
 *  - no duplicate ids
 *  - every walkable tile in every area is reachable from its spawn point
 *    (the "no unreachable areas" invariant, M0 form)
 *
 * The orphan-item graph validator (D-210) joins this file in M5 when recipes
 * exist; the category schema it depends on is already enforced here.
 */

export interface ValidationResult {
  errors: string[];
  checked: number;
}

function listJson(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/** Flood fill (8-way, matching movement rules) from spawn; returns unreachable walkable tiles. */
export function unreachableTiles(area: AreaDef): { x: number; y: number }[] {
  const walkable = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= area.width || y >= area.height) return false;
    return area.legend[area.tiles[y]![x]!]!.walkable;
  };
  const seen = new Set<number>();
  const key = (x: number, y: number) => y * area.width + x;
  const queue: [number, number][] = [[area.spawn.x, area.spawn.y]];
  seen.add(key(area.spawn.x, area.spawn.y));
  while (queue.length > 0) {
    const [x, y] = queue.pop()!;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (!walkable(nx, ny) || seen.has(key(nx, ny))) continue;
        // Diagonals may not cut corners, matching World.moveTarget.
        if (dx !== 0 && dy !== 0 && (!walkable(x + dx, y) || !walkable(x, y + dy))) continue;
        seen.add(key(nx, ny));
        queue.push([nx, ny]);
      }
    }
  }
  const missing: { x: number; y: number }[] = [];
  for (let y = 0; y < area.height; y++) {
    for (let x = 0; x < area.width; x++) {
      if (walkable(x, y) && !seen.has(key(x, y))) missing.push({ x, y });
    }
  }
  return missing;
}

export function validateContent(contentDir: string): ValidationResult {
  const errors: string[] = [];
  let checked = 0;

  const parsedAreas = new Map<string, AreaDef>();
  const areaIds = new Set<string>();
  for (const file of listJson(join(contentDir, 'areas'))) {
    checked++;
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      errors.push(`${file}: invalid JSON — ${(err as Error).message}`);
      continue;
    }
    const parsed = AreaSchema.safeParse(data);
    if (!parsed.success) {
      errors.push(`${file}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
      continue;
    }
    if (areaIds.has(parsed.data.id)) {
      errors.push(`${file}: duplicate area id '${parsed.data.id}'`);
      continue;
    }
    areaIds.add(parsed.data.id);
    parsedAreas.set(parsed.data.id, parsed.data);
    const missing = unreachableTiles(parsed.data);
    if (missing.length > 0) {
      const sample = missing.slice(0, 5).map((p) => `(${p.x},${p.y})`).join(' ');
      errors.push(
        `${file}: ${missing.length} walkable tile(s) unreachable from spawn, e.g. ${sample}`,
      );
    }
  }

  const itemIds = new Set<string>();
  for (const file of listJson(join(contentDir, 'items'))) {
    checked++;
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      errors.push(`${file}: invalid JSON — ${(err as Error).message}`);
      continue;
    }
    const parsed = ItemTemplateSchema.safeParse(data);
    if (!parsed.success) {
      errors.push(`${file}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
      continue;
    }
    if (itemIds.has(parsed.data.id)) {
      errors.push(`${file}: duplicate item id '${parsed.data.id}'`);
      continue;
    }
    itemIds.add(parsed.data.id);
  }

  // Objectives (D-521): the antagonist's possible orders. Validated for
  // shape here; the round engine additionally refuses to SELECT any whose
  // status is 'planned', so an objective authored ahead of the system that
  // would resolve it is content, not a broken round.
  const objectiveIds = new Set<string>();
  const objectives: ObjectiveDef[] = [];
  for (const file of listJson(join(contentDir, 'objectives'))) {
    checked++;
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      errors.push(`${file}: invalid JSON — ${(err as Error).message}`);
      continue;
    }
    const parsed = ObjectiveSchema.safeParse(data);
    if (!parsed.success) {
      errors.push(`${file}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
      continue;
    }
    if (objectiveIds.has(parsed.data.id)) {
      errors.push(`${file}: duplicate objective id '${parsed.data.id}'`);
      continue;
    }
    objectiveIds.add(parsed.data.id);
    objectives.push(parsed.data);
  }
  for (const o of objectives) {
    if (o.maxCast !== null && o.maxCast < o.minCast) {
      errors.push(`objective '${o.id}': maxCast ${o.maxCast} is below minCast ${o.minCast}`);
    }
    if (o.kind.type === 'steal' && !itemIds.has(o.kind.itemTemplate)) {
      errors.push(`objective '${o.id}': steals unknown item '${o.kind.itemTemplate}'`);
    }
  }
  // A round cannot start without something to give the antagonist. If any
  // objective exists at all, at least one must be live and playable at the
  // minimum cast — otherwise the lobby would fill and never start.
  if (objectives.length > 0) {
    const playable = objectives.filter(
      (o) =>
        o.status === 'live' &&
        o.minCast <= ROUND_MIN_CAST &&
        (o.maxCast === null || o.maxCast >= ROUND_MIN_CAST),
    );
    if (playable.length === 0) {
      errors.push(
        `no live objective is playable at the minimum cast of ${ROUND_MIN_CAST} — a round could never start`,
      );
    }
  }

  const classIds = new Set<string>();
  const classes: ClassDef[] = [];
  for (const file of listJson(join(contentDir, 'classes'))) {
    checked++;
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      errors.push(`${file}: invalid JSON — ${(err as Error).message}`);
      continue;
    }
    const parsed = ClassSchema.safeParse(data);
    if (!parsed.success) {
      errors.push(`${file}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
      continue;
    }
    if (classIds.has(parsed.data.id)) {
      errors.push(`${file}: duplicate class id '${parsed.data.id}'`);
      continue;
    }
    classIds.add(parsed.data.id);
    classes.push(parsed.data);
  }

  // Skills, feats and spells (D-208): array files, cross-checked against each
  // other and against the class roster so the creation screen can never offer
  // a pick that references content which does not exist.
  const readArray = <T>(
    dir: string,
    schema: { safeParse: (v: unknown) => { success: boolean; data?: T[]; error?: { issues: { message: string }[] } } },
  ): T[] => {
    const out: T[] = [];
    for (const file of listJson(join(contentDir, dir))) {
      checked++;
      let data: unknown;
      try {
        data = JSON.parse(readFileSync(file, 'utf8'));
      } catch (err) {
        errors.push(`${file}: invalid JSON — ${(err as Error).message}`);
        continue;
      }
      const parsed = schema.safeParse(data);
      if (!parsed.success) {
        errors.push(`${file}: ${parsed.error!.issues.map((i) => i.message).join('; ')}`);
        continue;
      }
      out.push(...parsed.data!);
    }
    return out;
  };
  const skills = readArray<{ id: string }>('skills', SkillsFileSchema);
  const feats = readArray<FeatDef>('feats', FeatsFileSchema);
  const spells = readArray<SpellDef>('spells', SpellsFileSchema);
  const dupes = (ids: string[], what: string): void => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) errors.push(`duplicate ${what} id '${id}'`);
      seen.add(id);
    }
  };
  const skillIds = new Set(skills.map((s) => s.id));
  dupes(skills.map((s) => s.id), 'skill');
  dupes(feats.map((f) => f.id), 'feat');
  dupes(spells.map((s) => s.id), 'spell');
  for (const cls of classes) {
    for (const id of cls.affinities) {
      if (!skillIds.has(id)) errors.push(`class '${cls.id}': unknown affinity skill '${id}'`);
    }
  }
  for (const feat of feats) {
    for (const id of feat.classes) {
      if (!classIds.has(id)) errors.push(`feat '${feat.id}': unknown class '${id}'`);
    }
    for (const id of Object.keys(feat.requiresSkills)) {
      if (!skillIds.has(id)) errors.push(`feat '${feat.id}': unknown required skill '${id}'`);
    }
  }
  for (const spell of spells) {
    for (const id of spell.classes) {
      if (!classIds.has(id)) errors.push(`spell '${spell.id}': unknown class '${id}'`);
      else if (!classes.find((c) => c.id === id)!.spellcasting) {
        errors.push(`spell '${spell.id}': class '${id}' does not cast spells`);
      }
    }
  }
  // Every casting class must have something to learn, or its creation step
  // would present an empty list.
  for (const cls of classes.filter((c) => c.spellcasting)) {
    const available = spells.filter((s) => s.classes.length === 0 || s.classes.includes(cls.id));
    if (available.length === 0) errors.push(`class '${cls.id}' casts but has no available spells`);
  }

  // Cross-area checks: transitions must land on walkable tiles in areas that
  // exist (D-103), and referenced scripts must exist (D-109).
  const walkableAt = (area: AreaDef, x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < area.width && y < area.height &&
    area.legend[area.tiles[y]![x]!]!.walkable;
  let scriptIds = new Set<string>();
  try {
    scriptIds = new Set(
      readdirSync(join(contentDir, 'scripts'))
        .filter((f) => f.endsWith('.lua'))
        .map((f) => f.replace(/\.lua$/, '')),
    );
  } catch {
    // no scripts directory — fine unless something references one
  }
  for (const area of parsedAreas.values()) {
    for (const tr of area.transitions) {
      const target = parsedAreas.get(tr.toArea);
      if (!target) {
        errors.push(`area '${area.id}': transition targets unknown area '${tr.toArea}'`);
      } else if (!walkableAt(target, tr.toX, tr.toY)) {
        errors.push(
          `area '${area.id}': transition lands on unwalkable (${tr.toX},${tr.toY}) in '${tr.toArea}'`,
        );
      }
      if (!walkableAt(area, tr.x, tr.y)) {
        errors.push(`area '${area.id}': transition source (${tr.x},${tr.y}) is not walkable`);
      }
    }
    for (const scriptId of area.scripts) {
      if (!scriptIds.has(scriptId)) {
        errors.push(`area '${area.id}': references missing script '${scriptId}'`);
      }
    }
  }

  if (checked === 0) errors.push(`no content files found under ${contentDir}`);
  return { errors, checked };
}

// CLI entry: `npm run validate:content [dir]`
const isCli = process.argv[1]?.replace(/\\/g, '/').endsWith('tools/src/validate-content.ts');
if (isCli) {
  const dir = resolve(process.argv[2] ?? 'content');
  const { errors, checked } = validateContent(dir);
  if (errors.length > 0) {
    console.error(`content INVALID (${checked} file(s) checked):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(`content OK — ${checked} file(s) validated in ${dir}`);
}
