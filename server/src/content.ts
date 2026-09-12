import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  AssetFileSchema,
  StationDefSchema,
  type StationDef,
  type CharacterItem,
  AreaSchema,
  ClassSchema,
  RaceSchema,
  PartNamesSchema,
  GroundMaterialSchema,
  type RaceDef,
  type GroundMaterial,
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
  SoundsFileSchema,
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
  type SoundCueDef,
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
  /** Worn-item assets by `pack/id` — where a weapon's stance lives (D-566). */
  wornAssets: Map<string, CharacterItem>;
  /** Facilities by id (D-530). */
  stations: Map<string, StationDef>;
  emoteLexicon: EmoteLexicon;
  languages: Map<string, Language>;
  /** Playable classes (D-208/D-511); empty means class selection is closed. */
  classes: Map<string, ClassDef>;
  /**
   * What a character may BE (D-560, wired in D-572).
   *
   * ⚠ Empty means race selection is closed, exactly as an empty `classes`
   * closes class selection — not that every race is allowed. A server whose
   * content has no races refuses a `raceId` rather than accepting any string,
   * because accepting one would write an id nothing can ever resolve.
   */
  races: Map<string, RaceDef>;
  /**
   * Part file stem → the name a player is told it is called (D-560).
   *
   * ⚠ Loaded here because it had never been loaded ANYWHERE the game could
   * see it. `content/parts/` was read by the authoring tools and by CI only,
   * so every name the stakeholder wrote reached the tool that wrote it and
   * nothing else, and the creation screen fell back to file stems (D-576).
   *
   * Merged across packs: a stem carries its pack's prefix, so two packs
   * cannot collide, and a name missing here is a part nobody has named yet
   * rather than an error.
   */
  partNames: Map<string, string>;
  /** What a patch of ground is made of (D-585), by id. */
  ground: Map<string, GroundMaterial>;
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
  /** Sound cues (D-541), keyed by id. The client asks for these on connect. */
  sounds: SoundCueDef[];
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

  /**
   * The worn-item catalogue, by `pack/id` (D-563).
   *
   * ⚠ Loaded because the ASSET owns how a thing is held and which animation
   * stance it puts a character in (D-566), and the server needs that to gate
   * a class's weapons. Repeating the stance on the item template would be two
   * places to say one thing, and they would eventually disagree.
   *
   * Only `character-item` files: the environment catalogue is 1,402 entries
   * the simulation never asks about, since a placed asset carries its own
   * collision (D-567).
   */
  const wornAssets = new Map<string, CharacterItem>();
  for (const { file, data } of readJsonFiles(join(contentDir, 'assets'))) {
    if (!file.endsWith('.character-item.json')) continue;
    const parsed = AssetFileSchema.safeParse(data);
    if (!parsed.success) {
      throw new Error(`${file}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    }
    for (const asset of parsed.data.assets) {
      if (asset.kind !== 'character-item') continue;
      wornAssets.set(`${asset.pack}/${asset.id}`, asset);
    }
  }

  /** The facilities a map may place (D-530). Content, not an enum. */
  const stations = new Map<string, StationDef>();
  for (const { file, data } of readJsonFiles(join(contentDir, 'stations'))) {
    const parsed = StationDefSchema.safeParse(data);
    if (!parsed.success) {
      throw new Error(`${file}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    }
    if (stations.has(parsed.data.id)) {
      throw new Error(`${file}: duplicate station id '${parsed.data.id}'`);
    }
    stations.set(parsed.data.id, parsed.data);
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

  const races = new Map<string, RaceDef>();
  for (const { file, data } of readJsonFiles(join(contentDir, 'races'))) {
    const parsed = RaceSchema.safeParse(data);
    if (!parsed.success) {
      throw new Error(`${file}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    }
    if (races.has(parsed.data.id)) {
      throw new Error(`${file}: duplicate race id '${parsed.data.id}'`);
    }
    races.set(parsed.data.id, parsed.data);
  }

  const ground = new Map<string, GroundMaterial>();
  for (const { file, data } of readJsonFiles(join(contentDir, 'ground'))) {
    const parsed = GroundMaterialSchema.safeParse(data);
    if (!parsed.success) {
      throw new Error(`${file}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    }
    if (ground.has(parsed.data.id)) {
      throw new Error(`${file}: duplicate ground material '${parsed.data.id}'`);
    }
    ground.set(parsed.data.id, parsed.data);
  }

  const partNames = new Map<string, string>();
  for (const { file, data } of readJsonFiles(join(contentDir, 'parts'))) {
    const parsed = PartNamesSchema.safeParse(data);
    if (!parsed.success) {
      throw new Error(`${file}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    }
    for (const [stem, name] of Object.entries(parsed.data.names)) partNames.set(stem, name);
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

  const sounds: SoundCueDef[] = [];
  const soundIds = new Set<string>();
  for (const { file, data } of readJsonFiles(join(contentDir, 'audio'))) {
    const parsed = SoundsFileSchema.safeParse(data);
    if (!parsed.success) {
      throw new Error(`${file}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    }
    for (const cue of parsed.data) {
      if (soundIds.has(cue.id)) throw new Error(`${file}: duplicate sound cue '${cue.id}'`);
      soundIds.add(cue.id);
      sounds.push(cue);
    }
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
    if (area.ambience !== undefined) {
      const cue = sounds.find((c) => c.id === area.ambience);
      if (!cue) {
        throw new Error(`area '${area.id}' references unknown sound cue '${area.ambience}'`);
      }
      if (cue.kind !== 'ambience') {
        throw new Error(`area '${area.id}' ambience '${cue.id}' is a ${cue.kind} cue`);
      }
    }
  }

  if (areas.size === 0) throw new Error(`no areas found under ${contentDir}/areas`);
  return {
    areas,
    itemTemplates,
    wornAssets,
    stations,
    emoteLexicon,
    languages,
    classes,
    races,
    partNames,
    ground,
    skills,
    feats,
    spells,
    objectives,
    nodes,
    recipes,
    roamers,
    sounds,
    scripts,
  };
}
