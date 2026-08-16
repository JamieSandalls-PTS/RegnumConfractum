import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  AreaSchema,
  EMPTY_LEXICON,
  EmoteLexiconSchema,
  ItemTemplateSchema,
  type AreaDef,
  type EmoteLexicon,
  type ItemTemplate,
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

  if (areas.size === 0) throw new Error(`no areas found under ${contentDir}/areas`);
  return { areas, itemTemplates, emoteLexicon };
}
