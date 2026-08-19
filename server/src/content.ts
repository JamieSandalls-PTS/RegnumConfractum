import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  AreaSchema,
  ClassSchema,
  EMPTY_LEXICON,
  EmoteLexiconSchema,
  FeatsFileSchema,
  ItemTemplateSchema,
  LanguagesFileSchema,
  ObjectiveSchema,
  RecipeSchema,
  ResourceNodeSchema,
  RoamerSchema,
  SkillsFileSchema,
  SpellsFileSchema,
  type AreaDef,
  type ClassDef,
  type EmoteLexicon,
  type FeatDef,
  type ItemTemplate,
  type Language,
  type ObjectiveDef,
  type RecipeDef,
  type ResourceNodeDef,
  type RoamerDef,
  type SkillDef,
  type SpellDef,
} from '@rc/shared';

/**
 * Loads and validates world content (D-110). The server refuses to start on
 * invalid content — CI runs the same schemas via tools/validate-content.ts,
 * so a bad file should never get this far.
 */

export interface Content {
  areas: Map<string, AreaDef>;
  itemTemplates: Map<string, ItemTemplate>;
  emoteLexicon: EmoteLexicon;
  languages: Map<string, Language>;
  /** Playable classes (D-208/D-511); empty means class selection is closed. */
  classes: Map<string, ClassDef>;
  /** Creation content (D-208): what a build may allocate and pick. */
  skills: SkillDef[];
  feats: FeatDef[];
  spells: SpellDef[];
  /** The antagonist's possible orders (D-521). Empty means no round can
   * start — the lobby fills and waits rather than starting without one. */
  objectives: ObjectiveDef[];
  /** Resource node behaviour, keyed by id; areas place them (MR2). */
  nodes: Map<string, ResourceNodeDef>;
  /** What may be made, keyed by id. */
  recipes: Map<string, RecipeDef>;
  /** What walks the open ground after dusk (D-527/D-529). */
  roamers: RoamerDef[];
  /** Lua sources by script id (content/scripts/<id>.lua), D-109. */
  scripts: Map<string, string>;
}

function readJsonFiles(dir: string): { file: string; data: unknown }[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  return files.sort().map((f) => {
    const path = join(dir, f);
    try {
      return { file: path, data: JSON.parse(readFileSync(path, 'utf8')) };
    } catch (err) {
      throw new Error(`${path}: invalid JSON — ${(err as Error).message}`);
    }
  });
}

export function loadContent(contentDir: string): Content {
  const areas = new Map<string, AreaDef>();
  for (const { file, data } of readJsonFiles(join(contentDir, 'areas'))) {
    const parsed = AreaSchema.safeParse(data);
    if (!parsed.success) {
      throw new Error(`${file}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    }
    if (areas.has(parsed.data.id)) throw new Error(`${file}: duplicate area id '${parsed.data.id}'`);
    areas.set(parsed.data.id, parsed.data);
  }

  const itemTemplates = new Map<string, ItemTemplate>();
  for (const { file, data } of readJsonFiles(join(contentDir, 'items'))) {
    const parsed = ItemTemplateSchema.safeParse(data);
    if (!parsed.success) {
      throw new Error(`${file}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    }
    if (itemTemplates.has(parsed.data.id)) {
      throw new Error(`${file}: duplicate item id '${parsed.data.id}'`);
    }
    itemTemplates.set(parsed.data.id, parsed.data);
  }

  let emoteLexicon: EmoteLexicon = EMPTY_LEXICON;
  const lexiconPath = join(contentDir, 'emotes', 'lexicon.json');
  try {
    const raw = JSON.parse(readFileSync(lexiconPath, 'utf8'));
    const parsed = EmoteLexiconSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`${lexiconPath}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    }
    emoteLexicon = parsed.data;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    // No lexicon file: emotes render as plain text, nothing animates (D-202).
  }

  const languages = new Map<string, Language>();
  const languagesPath = join(contentDir, 'languages', 'languages.json');
  try {
    const raw = JSON.parse(readFileSync(languagesPath, 'utf8'));
    const parsed = LanguagesFileSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`${languagesPath}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    }
    for (const lang of parsed.data) languages.set(lang.id, lang);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    languages.set('common', {
      id: 'common',
      name: 'Common',
      description: 'The default trade tongue.',
    });
  }

  const classes = new Map<string, ClassDef>();
  for (const { file, data } of readJsonFiles(join(contentDir, 'classes'))) {
    const parsed = ClassSchema.safeParse(data);
    if (!parsed.success) {
      throw new Error(`${file}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    }
    if (classes.has(parsed.data.id)) {
      throw new Error(`${file}: duplicate class id '${parsed.data.id}'`);
    }
    classes.set(parsed.data.id, parsed.data);
  }

  // Creation content: array files, each validated whole. Missing directories
  // simply mean that creation step has nothing to offer yet.
  const readArrayFile = <T>(
    dir: string,
    schema: { safeParse: (v: unknown) => { success: boolean; data?: T[]; error?: { issues: { message: string }[] } } },
  ): T[] => {
    const out: T[] = [];
    for (const { file, data } of readJsonFiles(join(contentDir, dir))) {
      const parsed = schema.safeParse(data);
      if (!parsed.success) {
        throw new Error(`${file}: ${parsed.error!.issues.map((i) => i.message).join('; ')}`);
      }
      out.push(...parsed.data!);
    }
    return out;
  };
  const skills = readArrayFile<SkillDef>('skills', SkillsFileSchema);
  const feats = readArrayFile<FeatDef>('feats', FeatsFileSchema);
  const spells = readArrayFile<SpellDef>('spells', SpellsFileSchema);

  const objectives: ObjectiveDef[] = [];
  const objectiveIds = new Set<string>();
  for (const { file, data } of readJsonFiles(join(contentDir, 'objectives'))) {
    const parsed = ObjectiveSchema.safeParse(data);
    if (!parsed.success) {
      throw new Error(`${file}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    }
    if (objectiveIds.has(parsed.data.id)) {
      throw new Error(`${file}: duplicate objective id '${parsed.data.id}'`);
    }
    objectiveIds.add(parsed.data.id);
    objectives.push(parsed.data);
  }

  const nodes = new Map<string, ResourceNodeDef>();
  for (const { file, data } of readJsonFiles(join(contentDir, 'nodes'))) {
    const parsed = ResourceNodeSchema.safeParse(data);
    if (!parsed.success) {
      throw new Error(`${file}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    }
    if (nodes.has(parsed.data.id)) throw new Error(`${file}: duplicate node id '${parsed.data.id}'`);
    nodes.set(parsed.data.id, parsed.data);
  }

  const recipes = new Map<string, RecipeDef>();
  for (const { file, data } of readJsonFiles(join(contentDir, 'recipes'))) {
    const parsed = RecipeSchema.safeParse(data);
    if (!parsed.success) {
      throw new Error(`${file}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    }
    if (recipes.has(parsed.data.id)) {
      throw new Error(`${file}: duplicate recipe id '${parsed.data.id}'`);
    }
    recipes.set(parsed.data.id, parsed.data);
  }

  const roamers: RoamerDef[] = [];
  const roamerIds = new Set<string>();
  for (const { file, data } of readJsonFiles(join(contentDir, 'roamers'))) {
    const parsed = RoamerSchema.safeParse(data);
    if (!parsed.success) {
      throw new Error(`${file}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    }
    if (roamerIds.has(parsed.data.id)) {
      throw new Error(`${file}: duplicate roamer id '${parsed.data.id}'`);
    }
    roamerIds.add(parsed.data.id);
    roamers.push(parsed.data);
  }

  const scripts = new Map<string, string>();
  try {
    for (const f of readdirSync(join(contentDir, 'scripts')).filter((f) => f.endsWith('.lua'))) {
      scripts.set(f.replace(/\.lua$/, ''), readFileSync(join(contentDir, 'scripts', f), 'utf8'));
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  for (const area of areas.values()) {
    for (const scriptId of area.scripts) {
      if (!scripts.has(scriptId)) {
        throw new Error(`area '${area.id}' references missing script '${scriptId}'`);
      }
    }
    for (const tr of area.transitions) {
      if (!areas.has(tr.toArea)) {
        throw new Error(`area '${area.id}' transition targets unknown area '${tr.toArea}'`);
      }
    }
    for (const placed of area.nodes) {
      if (!nodes.has(placed.type)) {
        throw new Error(`area '${area.id}' places unknown node type '${placed.type}'`);
      }
    }
  }

  if (areas.size === 0) throw new Error(`no areas found under ${contentDir}/areas`);
  return {
    areas,
    itemTemplates,
    emoteLexicon,
    languages,
    classes,
    skills,
    feats,
    spells,
    objectives,
    nodes,
    recipes,
    roamers,
    scripts,
  };
}
