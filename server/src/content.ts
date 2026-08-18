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
  SkillsFileSchema,
  SpellsFileSchema,
  type AreaDef,
  type ClassDef,
  type EmoteLexicon,
  type FeatDef,
  type ItemTemplate,
  type Language,
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
  }

  if (areas.size === 0) throw new Error(`no areas found under ${contentDir}/areas`);
  return { areas, itemTemplates, emoteLexicon, languages, classes, skills, feats, spells, scripts };
}
