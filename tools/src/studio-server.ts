// ⚠ FIRST. `FBXLoader` reaches for `document` and `Blob` at module load, so
// the stubs have to be installed before it is imported — without this the
// parse throws and the colour route silently returned an empty list.
import './node-dom';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {
  CHARACTER_SLOTS,
  CharacterDefSchema,
  BotDefSchema,
  NpcDefSchema,
  type CharacterDef,
  type CharacterSlot,
  type ParsedPart,
  missingBodySlots,
  parsePolygonPart,
  partProblems,
  PartNamesSchema,
  RaceSchema,
  type PartNames,
  type RaceDef,
  raceProblems,
  AssetFileSchema,
  assetProblems,
  kindOfMesh,
  meshShelf,
  ASSET_KINDS,
  type AssetKind,
  AnimationSetSchema,
  type AnimationSet,
  animationSetProblems,
  ClassSchema,
  type ClassDef,
  classGateProblems,
  FeatsFileSchema,
  SkillsFileSchema,
  slotsOccupied,
  type SkillDef,
  SpellsFileSchema,
  ItemTemplateSchema,
  type ItemTemplate,
  assetAtlas,
  preferredAtlas,
  type FeatDef,
  type SpellDef,
  RecipeSchema,
  type RecipeDef,
  recipeProblems,
  RoamerSchema,
  type BotDef,
  type RoamerDef,
  roamerProblems,
  ObjectiveSchema,
  type ObjectiveDef,
  objectiveProblems,
  castCoverageProblem,
  findOrphans,
  ResourceNodeSchema,
  StationDefSchema,
  CORE_STATION_TYPES,
  type ResourceNodeDef,
  SoundsFileSchema,
  type SoundCueDef,
  EmoteLexiconSchema,
  type EmoteLexicon,
  LanguagesFileSchema,
  type Language,
  POSTURES,
  TRANSIENT_ANIMS,
  GARMENT_SLOTS,
  GarmentSchema,
  type GarmentDef,
  garmentProblems,
  garmentMaterial,
  AreaSchema,
  ScenarioSchema,
  scenarioProblems,
} from '@rc/shared';
// Shared with `build:characters`, so the studio and the build resolve a pack
// name the same way. Two copies drift, and the failure is a character that
// previews here and then will not build.
import { type Pack, allMeshStems, allPacks, meshPath, packOf, packs, partStems, texturePaths, texturesIn } from './packs';
import { readPng, sampleUv, hex } from './png';
import { OTHERWISE_USED, listJson } from './validate-content';
import { editorRoutes } from './editor-routes';
import { overview } from './overview';
import { Publisher } from './publish';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import type { BufferAttribute, Mesh } from 'three';

/**
 * THE authoring server (D-558, D-560, one port since D-629).
 *
 * One process, because every tool reads the same art and a second port is a
 * second thing to remember — and a stale second server answering with a
 * schema it never heard of cost a session once. `/creation-tool.html` is the
 * one page: seven stages, Art to Scenario, with the character studio and the
 * cloth workbench as tabs of Bodies and the map builder embedded under World.
 *
 * The browser cannot read the art drop or write the repository, so the
 * page talks to this:
 *
 *   GET  /api/packs                    which ingested packs have parts
 *   GET  /api/packs/:pack              the part catalogue, grouped by slot
 *   GET  /api/packs/:pack/fbx/:stem    one part's mesh, for the live preview
 *   GET  /api/packs/:pack/tex/:stem    one colour atlas
 *   GET  /api/characters               saved definitions
 *   PUT  /api/characters/:id           validate, then write
 *   DELETE /api/characters/:id         refuse while a creature is it
 *   GET  /api/parts/:pack              in-game names for a pack's parts
 *   PUT  /api/parts/:pack              write them
 *   GET  /api/races                    every race
 *   PUT  /api/races/:id                validate, then write
 *   GET  /api/items                    the in-game item library
 *   PUT  /api/items/:id                validate, then write
 *   GET  /api/assetcolours/:pack/:mesh the flat colours that mesh samples
 *   GET  /api/catalogue                skills, feats, spells, items
 *   PUT  /api/catalogue/feats|spells   rewrite that file
 *   GET  /api/classes                  the callings, and the race ids
 *   PUT  /api/classes/:id              validate, then write
 *   GET  /api/animations               every animation set + the built clips
 *   PUT  /api/animations/:id           validate, then write
 *   GET  /api/round                    recipes, roamers, objectives + refs
 *   PUT  /api/round/:kind/:id          validate against the GRAPH, then write
 *   DELETE /api/round/:kind/:id        refuse if it would strand an item
 *   GET  /api/world                    sound cues, emote lexicon, languages
 *   PUT  /api/world/sounds|emotes|languages   rewrite that file
 *   GET  /api/garments                 every garment + derived material + wearers
 *   PUT  /api/garments/:id             validate against the PACK, then write
 *   DELETE /api/garments/:id           refuse while an item still wears it
 *   GET  /api/assetpacks                every pack that ships meshes
 *   GET  /api/assetpacks/:pack          its mesh stems, with a guessed kind
 *   GET  /api/assetpacks/:pack/fbx/:s   one mesh, found anywhere in the pack
 *   GET  /api/assetpacks/:pack/tex/:s   one atlas, found anywhere in the pack
 *   GET  /api/assets/:pack/:kind        named assets of that kind
 *   PUT  /api/assets/:pack/:kind        validate, then write
 *
 * It serves the SOURCE art (`assets/source/`, gitignored) for preview and
 * writes only the small definition document (`content/characters/`, in git).
 * That split is the point: the studio decides which art a character is made
 * of, and the decision is what gets versioned.
 *
 * Nothing invalid is written — a save is parsed against the real
 * `CharacterDefSchema`, every named part is confirmed to exist in the pack,
 * and a character missing a body slot is refused with the list. The build
 * reads the same files, so a definition that saves is a definition that
 * builds.
 *
 *   GET  /api/publish                  builds and reload a save still needs (D-630)
 *   POST /api/publish                  run them, streaming NDJSON progress
 *   GET  /api/overview                 what each stage of the line has and lacks (D-629)
 *   GET  /api/scenarios                the rounds + the areas and objectives they may name
 *   PUT  /api/scenarios/:id            validate exactly as CI does, then write
 *   DELETE /api/scenarios/:id          refuse if it is the last live one
 *   plus the map editor's routes — areas, ground, paint, palette — from
 *   `editor-routes.ts` (D-629: one server, one port)
 *
 *   npx tsx tools/src/studio-server.ts [port]
 */

const root = path.resolve(path.join(import.meta.dirname, '..', '..'));
const outDir = path.join(root, 'content', 'characters');

/** Every environment asset id an ingested pack ships, for validating art. */
function environmentIds(pack: string): Set<string> {
  const file = path.join(assetsDir, `${pack}.environment.json`);
  if (!fs.existsSync(file)) return new Set();
  const parsed = AssetFileSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (!parsed.success) return new Set();
  return new Set(parsed.data.assets.map((a) => a.id));
}

/**
 * What each interactive object is FOR, read off the rest of the content.
 *
 * A station nothing crafts at and a node whose yield nothing consumes are
 * both orphans in D-210's sense, and the tool should say so where the thing
 * is authored rather than leaving it to a CI failure about a different file.
 */
function interactiveUsage(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (fs.existsSync(recipesDir)) {
    for (const f of fs.readdirSync(recipesDir).filter((x) => x.endsWith('.json'))) {
      const raw = JSON.parse(fs.readFileSync(path.join(recipesDir, f), 'utf8')) as {
        id?: string; station?: string; inputs?: { item: string }[];
      };
      if (raw.station && raw.station !== 'anywhere') {
        (out[raw.station] ??= []).push(`crafted here: ${raw.id ?? f}`);
      }
      for (const input of raw.inputs ?? []) {
        (out[`item:${input.item}`] ??= []).push(`recipe ${raw.id ?? f}`);
      }
    }
  }
  return out;
}

const partsDir = path.join(root, 'content', 'parts');
const racesDir = path.join(root, 'content', 'races');
const assetsDir = path.join(root, 'content', 'assets');
const animationsDir = path.join(root, 'content', 'animations');
const classesDir = path.join(root, 'content', 'classes');
const contentDir = path.join(root, 'content');
const garmentsDir = path.join(contentDir, 'garments');
const recipesDir = path.join(contentDir, 'recipes');
const roamersDir = path.join(contentDir, 'roamers');
const botsDir = path.join(contentDir, 'bots');
const objectivesDir = path.join(contentDir, 'objectives');
const stationsDir = path.join(contentDir, 'stations');
const nodesDir = path.join(contentDir, 'nodes');
const npcsDir = path.join(contentDir, 'npcs');
const scenariosDir = path.join(contentDir, 'scenarios');

/** What has been saved since the last publish, and how to publish it (D-630). */
const publisher = new Publisher(root);
/** The content directory a path is under: what the dependency map is keyed on. */
function contentTypeOf(p: string): string {
  return path.relative(contentDir, p).split(/[\\/]/)[0]!;
}

/**
 * What a scenario is checked against: every area's zone and exits, and every
 * objective (D-627). The same three things CI hands `scenarioProblems`.
 */
function scenarioWorld(): {
  zones: Map<string, string>;
  exits: Map<string, string[]>;
  objectives: ObjectiveDef[];
  areas: { id: string; name: string; zone: string; live: boolean; exits: string[] }[];
} {
  const zones = new Map<string, string>();
  const exits = new Map<string, string[]>();
  const areas: { id: string; name: string; zone: string; live: boolean; exits: string[] }[] = [];
  for (const file of listJson(path.join(contentDir, 'areas'))) {
    const parsed = AreaSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (!parsed.success) continue;
    const a = parsed.data;
    const to = a.transitions.map((t) => t.toArea);
    zones.set(a.id, a.zone);
    exits.set(a.id, to);
    areas.push({ id: a.id, name: a.name, zone: a.zone, live: a.live === true, exits: to });
  }
  return { zones, exits, objectives: savedDocs(objectivesDir, (r) => ObjectiveSchema.parse(r)), areas };
}
/**
 * Where the build leaves the clips. The tool needs the LIST, not the file: an
 * author picking a clip for an action should be choosing from what exists,
 * because a set naming a clip that was never built resolves to nothing and
 * looks exactly like one that works.
 */
const manifestFile = path.join(root, 'client', 'public', 'models', 'manifest.json');
const port = Number(process.env.STUDIO_PORT ?? process.argv[2] ?? 8150);

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(json);
}

function sendBinary(res: http.ServerResponse, file: string, type: string): void {
  if (!fs.existsSync(file)) return send(res, 404, { error: `no such file: ${path.basename(file)}` });
  const data = fs.readFileSync(file);
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': data.byteLength,
    'Access-Control-Allow-Origin': '*',
  });
  res.end(data);
}

/** The catalogue: every part in the pack, grouped by the slot it fills. */
function catalogue(pack: Pack): {
  slots: Record<string, { stem: string; sex: string; conceals: readonly CharacterSlot[] }[]>;
  textures: string[];
} {
  const slots: Record<string, { stem: string; sex: string; conceals: readonly CharacterSlot[] }[]> =
    {};
  for (const slot of CHARACTER_SLOTS) slots[slot] = [];
  for (const file of fs.readdirSync(pack.meshDir).sort()) {
    const parsed = parsePolygonPart(file);
    if (!parsed) continue;
    // What a part hides travels with it: two hoods in the same slot differ
    // on whether hair shows, so the rule cannot live on the slot.
    slots[parsed.slot]!.push({
      stem: parsed.stem,
      sex: parsed.sex,
      conceals: parsed.conceals,
    });
  }
  const textures = pack.textureDir
    ? fs
        .readdirSync(pack.textureDir)
        .filter((f) => /\.png$/i.test(f))
        .map((f) => f.replace(/\.png$/i, ''))
        .sort()
    : [];
  return { slots, textures };
}

function savedCharacters(): CharacterDef[] {
  if (!fs.existsSync(outDir)) return [];
  return fs
    .readdirSync(outDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => CharacterDefSchema.parse(JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8'))))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Every reason this definition would not build, in one list. */
function problemsWith(def: CharacterDef): string[] {
  const problems: string[] = [];
  const pack = packOf(def.pack);
  if (!pack) return [`no ingested pack called "${def.pack}"`];

  const have = partStems(pack);
  for (const [slot, stem] of Object.entries(def.parts)) {
    if (!have.has(stem)) problems.push(`${slot}: "${stem}" is not in ${def.pack}`);
  }
  const missing = missingBodySlots(def);
  if (missing.length) problems.push(`no part for ${missing.join(', ')}`);

  // The same rule the studio greys slots out with. A crest with no helm to
  // sit on, or hair under a closed helmet, builds perfectly well and is
  // simply never seen — so it is refused here rather than shipped.
  const chosen: ParsedPart[] = [];
  for (const stem of Object.values(def.parts)) {
    const parsed = parsePolygonPart(stem);
    if (parsed) chosen.push(parsed);
  }
  problems.push(...partProblems(chosen, def.sex));
  if (def.texture && pack.textureDir) {
    if (!fs.existsSync(path.join(pack.textureDir, `${def.texture}.png`))) {
      problems.push(`texture "${def.texture}" is not in ${def.pack}`);
    }
  }
  return problems;
}

/** What a pack ships, for validating a race against reality. */
function knownIn(packId: string): { partsInPack: Set<string>; texturesInPack: Set<string> } | null {
  const pack = packOf(packId);
  if (!pack) return null;
  const textures = pack.textureDir
    ? new Set(
        fs
          .readdirSync(pack.textureDir)
          .filter((f) => /\.png$/i.test(f))
          .map((f) => f.replace(/\.png$/i, '')),
      )
    : new Set<string>();
  return { partsInPack: partStems(pack), texturesInPack: textures };
}

function readJson<T>(dir: string, file: string, parse: (raw: unknown) => T): T | null {
  const full = path.join(dir, file);
  if (!fs.existsSync(full)) return null;
  return parse(JSON.parse(fs.readFileSync(full, 'utf8')));
}

function writeJson(dir: string, file: string, body: unknown): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), `${JSON.stringify(body, null, 2)}\n`);
  publisher.note(contentTypeOf(dir));
}

function savedRaces(): RaceDef[] {
  if (!fs.existsSync(racesDir)) return [];
  return fs
    .readdirSync(racesDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => RaceSchema.parse(JSON.parse(fs.readFileSync(path.join(racesDir, f), 'utf8'))))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function savedAnimationSets(): AnimationSet[] {
  if (!fs.existsSync(animationsDir)) return [];
  return fs
    .readdirSync(animationsDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) =>
      AnimationSetSchema.parse(JSON.parse(fs.readFileSync(path.join(animationsDir, f), 'utf8'))),
    )
    .sort((a, b) => a.layer.localeCompare(b.layer) || a.id.localeCompare(b.id));
}

function savedClasses(): ClassDef[] {
  if (!fs.existsSync(classesDir)) return [];
  return fs
    .readdirSync(classesDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ClassSchema.parse(JSON.parse(fs.readFileSync(path.join(classesDir, f), 'utf8'))))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/* ------------------------------------------------ round content (D-569) --- */

/** Every JSON file in a content directory, parsed, sorted by id. */
function savedDocs<T extends { id: string }>(dir: string, parse: (raw: unknown) => T): T[] {
  if (!fs.existsSync(dir)) return [];
  const out: T[] = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    try {
      out.push(parse(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))));
    } catch {
      // ⚠ SKIPPED, not thrown. One hand-edited file that no longer parses
      // would otherwise take the whole editor down, and the editor is the
      // thing you would use to fix it. `validate:content` is what fails the
      // build; this only has to stay usable.
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

const savedRecipes = (): RecipeDef[] => savedDocs(recipesDir, (r) => RecipeSchema.parse(r));
const savedRoamers = (): RoamerDef[] => savedDocs(roamersDir, (r) => RoamerSchema.parse(r));
const savedBots = (): BotDef[] =>
  savedDocs(botsDir, (r) => BotDefSchema.parse(r))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
const savedObjectives = (): ObjectiveDef[] =>
  savedDocs(objectivesDir, (r) => ObjectiveSchema.parse(r));
const savedNodes = (): ResourceNodeDef[] =>
  savedDocs(path.join(contentDir, 'nodes'), (r) => ResourceNodeSchema.parse(r));

/** Every item id, for the reference checks. */
function itemIdSet(): Set<string> {
  return new Set(buildCatalogue().items.map((i) => i.id));
}

/**
 * Descriptors that appear in area scripts, as a HINT and never as a check.
 *
 * ⚠ `kill_npc` matches an NPC by its descriptor string and nothing else, so
 * an objective naming a target nobody wears reads as good prose and can never
 * complete. That is exactly the check this cannot make: NPCs are not declared
 * on an area, they are spawned by `spawn_npc{...}` inside sandboxed Lua
 * (D-507), so the only way to know every descriptor is to run the scripts.
 *
 * What is offered instead is honest about itself — the strings found by
 * reading the Lua, shown to the author as suggestions so the common case is
 * a click rather than a retype. `objectiveProblems` is passed `null` for the
 * descriptor set, so nothing here ever refuses a save. A validator that
 * treated this partial scan as complete would reject every objective aimed at
 * an NPC spawned by a DM event or by a code path it cannot read.
 */
function npcDescriptorHints(): string[] {
  const out = new Set<string>();
  const dir = path.join(contentDir, 'scripts');
  if (!fs.existsSync(dir)) return [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.lua'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/descriptor\s*=\s*"([^"]+)"/g)) out.add(m[1]!);
  }
  return [...out].sort();
}

/**
 * The D-210 orphan graph, as it would stand after a proposed change.
 *
 * ⚠ This is the check a per-entity validator CANNOT make, and the reason
 * recipes get an editor rather than being left to hand-editing. Invariant 2
 * says every item has a consumer; deleting or repointing a recipe is the
 * commonest way to break that, and it breaks somewhere else in the graph —
 * the material is still fine, the recipe that ate it is simply gone. The
 * author would see a clean save and a failed build an hour later.
 *
 * It deliberately does NOT run the full `validateContent`: that floods every
 * area for reachability and takes 3-6 seconds, which is not a save button.
 * This is the part of the build that a round-content edit can actually break.
 */
function graphProblems(over: { recipes?: RecipeDef[]; roamers?: RoamerDef[] }): string[] {
  const recipes = over.recipes ?? savedRecipes();
  const roamers = over.roamers ?? savedRoamers();
  const catalogue = buildCatalogue();
  const kitItems: { item: string }[] = [];
  for (const cls of savedClasses()) {
    for (const entry of cls.startingKit) kitItems.push({ item: entry.item });
  }
  return findOrphans({
    items: catalogue.items.map((i) => ({ id: i.id, category: i.category })),
    recipes: recipes.map((r) => ({ output: r.output, inputs: r.inputs })),
    nodes: savedNodes().map((n) => ({ yields: n.yields })),
    loot: [...roamers.flatMap((r) => r.loot.map((l) => ({ item: l.item }))), ...kitItems],
    // ⚠ CI's own list, imported rather than retyped. If the tool exempted a
    // different set the two would disagree about what an orphan is, and the
    // direction that hurts is the tool being more permissive: a clean save
    // and a failed build an hour later, which is the exact failure this whole
    // check exists to prevent.
    otherwiseUsed: [...OTHERWISE_USED, ...objectiveTargets()],
  });
}

/* ----------------------------------------- garment helpers (D-570) ------- */

const savedGarments = (): GarmentDef[] => savedDocs(garmentsDir, (r) => GarmentSchema.parse(r));

/** A pack's part tags, for deriving a garment's material. */
function partTagsFor(pack: string): Record<string, string[]> {
  const file = path.join(partsDir, `${pack}.json`);
  if (!fs.existsSync(file)) return {};
  try {
    return PartNamesSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8'))).tags as Record<
      string,
      string[]
    >;
  } catch {
    return {};
  }
}

/**
 * Which items wear which garment.
 *
 * ⚠ A garment nothing wears is content with no consumer, which is D-210's
 * complaint about items applied one level up. It is shown rather than
 * refused — authoring the garment before the item that wears it is the
 * natural order — but deleting one that IS worn is refused, because the item
 * is not open in this editor and nothing else would catch it until the build.
 */
function wornByGarment(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const dir = path.join(contentDir, 'items');
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    try {
      const t = ItemTemplateSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
      if (t.garment) (out[t.garment] ??= []).push(t.id);
    } catch {
      /* a malformed item is the content validator's problem */
    }
  }
  return out;
}

/* ------------------------- speech, sound and gesture helpers (D-569) ------ */

const audioRoot = path.join(root, 'client', 'public', 'audio');

function savedSounds(): SoundCueDef[] {
  const f = path.join(contentDir, 'audio', 'sounds.json');
  if (!fs.existsSync(f)) return [];
  return SoundsFileSchema.parse(JSON.parse(fs.readFileSync(f, 'utf8')));
}

function savedLexicon(): EmoteLexicon {
  const f = path.join(contentDir, 'emotes', 'lexicon.json');
  if (!fs.existsSync(f)) return { negators: [], postures: {}, transients: {} };
  return EmoteLexiconSchema.parse(JSON.parse(fs.readFileSync(f, 'utf8')));
}

function savedLanguages(): Language[] {
  const f = path.join(contentDir, 'languages', 'languages.json');
  if (!fs.existsSync(f)) return [];
  return LanguagesFileSchema.parse(JSON.parse(fs.readFileSync(f, 'utf8')));
}

/**
 * Every audio file actually on disk, relative to `client/public/audio`.
 *
 * ⚠ Offered so a cue is pointed at a file by PICKING. A typed path that is
 * one character wrong is silent in play and indistinguishable from a cue
 * nobody wired (D-541) — the save refuses it, but not typing it at all is
 * better than being told off afterwards.
 */
function audioFilesOnDisk(): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), rel);
      else if (/\.(wav|ogg|mp3|flac|webm|m4a)$/i.test(e.name)) out.push(rel);
    }
  };
  walk(audioRoot, '');
  return out.sort();
}

/** Which areas name which ambience cue, so removing one can say what breaks. */
function ambienceInUse(): [string, string][] {
  const out: [string, string][] = [];
  const dir = path.join(contentDir, 'areas');
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as {
        id?: string;
        ambience?: string;
      };
      if (raw.id && raw.ambience) out.push([raw.id, raw.ambience]);
    } catch {
      /* a malformed area is the content validator's problem */
    }
  }
  return out;
}

/** Items an objective names, which counts as a consumer in the D-210 graph. */
function objectiveTargets(): string[] {
  return savedObjectives()
    .map((o) => (o.kind.type === 'steal' ? o.kind.itemTemplate : null))
    .filter((v): v is string => v !== null);
}

/**
 * Everything a calling can be built out of.
 *
 * ⚠ Feats and spells declare which classes may take them, not the other way
 * round (`classes: []` means open to all). The class editor writes back into
 * THOSE files rather than keeping a second list on the class, because two
 * lists that must agree eventually do not.
 */
function buildCatalogue(): {
  skills: SkillDef[];
  feats: FeatDef[];
  spells: SpellDef[];
  /**
   * ⚠ `slots` is carried because the starting-kit editor must offer only the
   * slots an item actually declares. A kit that equips a loaf is a content
   * error the build refuses, and a free-text slot box would make it easy to
   * author one.
   */
  items: { id: string; name: string; category: string; slots: string[] }[];
} {
  const read = <T>(file: string, parse: (raw: unknown) => T, fallback: T): T => {
    const full = path.join(contentDir, file);
    if (!fs.existsSync(full)) return fallback;
    try {
      return parse(JSON.parse(fs.readFileSync(full, 'utf8')));
    } catch {
      return fallback;
    }
  };
  const skills = read('skills/skills.json', (r) => SkillsFileSchema.parse(r), []);
  const items: { id: string; name: string; category: string; slots: string[] }[] = [];
  const itemDir = path.join(contentDir, 'items');
  if (fs.existsSync(itemDir)) {
    for (const f of fs.readdirSync(itemDir).filter((x) => x.endsWith('.json'))) {
      try {
        const t = ItemTemplateSchema.parse(JSON.parse(fs.readFileSync(path.join(itemDir, f), 'utf8')));
        items.push({
          id: t.id,
          name: t.name,
          category: t.category,
          // What the item says it fills — `both-hands` is not a slot a
          // character has, it is what an item declares (D-547).
          slots: t.equip ? slotsOccupied(t.equip.slot) : [],
        });
      } catch {
        /* a malformed item is the content validator's problem, not this one's */
      }
    }
  }
  return {
    // ⚠ The WHOLE skill, not a summary. The class page only ever needed an id
    // and a name, so that is all this sent — and an editor cannot edit fields
    // it was never given.
    skills,
    feats: read('feats/feats.json', (r) => FeatsFileSchema.parse(r), []),
    spells: read('spells/spells.json', (r) => SpellsFileSchema.parse(r), []),
    items: items.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

const meshLoader = new FBXLoader();
/** Atlases are 4 MB decoded; a fitting pass asks for the same one repeatedly. */
const atlasCache = new Map<string, ReturnType<typeof readPng> | null>();

/**
 * Which colours a mesh actually samples, biggest share first (D-566).
 *
 * ⚠ This is what makes recolouring an item a handful of swatches rather than a
 * texture editor. A worn item samples three to seven flat colours out of a
 * 1024² atlas (measured), so the tool can show exactly those and nothing else
 * — and an author never has to know which corner of the sheet a sword is on.
 */
function meshColours(pack: Pack, stem: string): { hex: string; share: number }[] {
  const file = meshPath(pack, stem);
  if (!file) return [];
  // The SHARED resolver — the client paints the preview from the same choice.
  const atlasName = assetAtlas(texturesIn(pack));
  if (!atlasName) return [];
  const key = `${pack.id}/${atlasName}`;
  if (!atlasCache.has(key)) {
    const atlasPath = texturePaths(pack).get(atlasName);
    try {
      atlasCache.set(key, atlasPath ? readPng(fs.readFileSync(atlasPath)) : null);
    } catch {
      atlasCache.set(key, null);
    }
  }
  const atlas = atlasCache.get(key);
  if (!atlas) return [];
  let uvs: BufferAttribute | null = null;
  try {
    const group = meshLoader.parse(fs.readFileSync(file).buffer as ArrayBuffer, '');
    group.traverse((o) => {
      const mesh = o as Mesh;
      const a = mesh.isMesh ? (mesh.geometry?.getAttribute('uv') as BufferAttribute) : null;
      if (a && !uvs) uvs = a;
    });
  } catch {
    return [];
  }
  if (!uvs) return [];
  const at = uvs as BufferAttribute;
  const count = new Map<string, number>();
  for (let i = 0; i < at.count; i++) {
    const h = hex(sampleUv(atlas, at.getX(i), at.getY(i)));
    count.set(h, (count.get(h) ?? 0) + 1);
  }
  const total = at.count || 1;
  return [...count]
    .map(([h, n]) => ({ hex: h, share: n / total }))
    // Below a percent it is a seam or a stray vertex, not a material anybody
    // would want to recolour. Showing them makes the real colours hard to find.
    .filter((c) => c.share >= 0.01)
    .sort((a, b) => b.share - a.share);
}

function savedItems(): ItemTemplate[] {
  const dir = path.join(contentDir, 'items');
  if (!fs.existsSync(dir)) return [];
  const out: ItemTemplate[] = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    try {
      out.push(ItemTemplateSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))));
    } catch {
      /* the content validator reports a malformed item; this list skips it */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The clips the last `build:characters` produced, or none if it never ran. */
function builtClips(): string[] {
  if (!fs.existsSync(manifestFile)) return [];
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as { clips?: string[] };
  return (manifest.clips ?? []).slice().sort();
}

/** Collect the body of a PUT, then hand it to a handler. */
function withBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  handle: (raw: unknown) => void,
): void {
  let body = '';
  req.on('data', (c: Buffer) => (body += c.toString()));
  req.on('end', () => {
    try {
      handle(JSON.parse(body || '{}'));
    } catch (e) {
      send(res, 400, { error: `bad JSON: ${(e as Error).message}` });
    }
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  const parts = url.pathname.split('/').filter(Boolean);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  if (parts[0] !== 'api') return send(res, 404, { error: 'not found' });

  // The map editor's routes (areas, ground, paint, palette) — D-629 put them
  // on this server so the tools have one port and one origin. Answered here
  // first; anything they do not own falls through.
  if (editorRoutes(req, res, url, parts, { contentDir, send, onChanged: (dir) => publisher.note(dir) })) return;

  // /api/publish — what a save still needs, and the button that does it (D-630).
  if (parts[1] === 'publish' && parts.length === 2) {
    if (req.method === 'GET') return send(res, 200, publisher.pending());
    if (req.method === 'POST') return void publisher.run(res);
  }

  // /api/overview — what each stage of the production line has and lacks.
  if (req.method === 'GET' && parts[1] === 'overview' && parts.length === 2) {
    try {
      return send(res, 200, overview(contentDir, root));
    } catch (e) {
      return send(res, 500, { error: `could not read the tree: ${(e as Error).message}` });
    }
  }

  // /api/scenarios — the rounds, and what a round may be made of (D-627).
  if (req.method === 'GET' && parts[1] === 'scenarios' && parts.length === 2) {
    try {
      const w = scenarioWorld();
      return send(res, 200, {
        scenarios: savedDocs(scenariosDir, (r) => ScenarioSchema.parse(r)),
        areas: w.areas,
        objectives: w.objectives.map((o) => ({
          id: o.id, name: o.name, status: o.status, minCast: o.minCast, maxCast: o.maxCast,
        })),
      });
    } catch (e) {
      return send(res, 500, { error: `a saved document is invalid: ${(e as Error).message}` });
    }
  }

  // PUT /api/scenarios/:id — refused exactly where CI would refuse it.
  //
  // ⚠ Same rule as every other save here (D-543): `scenarioProblems` is the
  // function CI calls, so a scenario that saves is a scenario the build
  // accepts. Its NOTE lines (doors leading out of the set) come back as
  // warnings rather than refusals, because an edge is legal and the point is
  // to know where it is.
  if (req.method === 'PUT' && parts[1] === 'scenarios' && parts.length === 3) {
    const id = decodeURIComponent(parts[2]!);
    return withBody(req, res, (raw) => {
      const parsed = ScenarioSchema.safeParse(raw);
      if (!parsed.success) {
        return send(res, 400, { error: 'schema', issues: parsed.error.issues });
      }
      if (parsed.data.id !== id) return send(res, 400, { error: 'id does not match the url' });
      const w = scenarioWorld();
      const all = scenarioProblems(parsed.data, w);
      const problems = all.filter((p) => !p.startsWith('NOTE '));
      const warnings = all.filter((p) => p.startsWith('NOTE ')).map((p) => p.slice(5));
      if (problems.length) return send(res, 400, { error: 'would not build', problems, warnings });
      writeJson(scenariosDir, `${id}.json`, parsed.data);
      return send(res, 200, { saved: `scenarios/${id}.json`, warnings });
    });
  }

  // DELETE /api/scenarios/:id — refused if it is the last LIVE one.
  //
  // ⚠ The lobby fills and never starts with no live scenario, and that is
  // D-569's trap wearing a new face: nothing errors, the round simply never
  // begins. So the last live scenario cannot be deleted; mark it planned and
  // author another first.
  if (req.method === 'DELETE' && parts[1] === 'scenarios' && parts.length === 3) {
    const id = decodeURIComponent(parts[2]!);
    const file = path.join(scenariosDir, `${id}.json`);
    if (!fs.existsSync(file)) return send(res, 404, { error: 'no such scenario' });
    const live = savedDocs(scenariosDir, (r) => ScenarioSchema.parse(r))
      .filter((sc) => sc.status === 'live');
    if (live.length === 1 && live[0]!.id === id) {
      return send(res, 400, {
        error: 'would not build',
        problems: [`${id} is the only live scenario — with none, the lobby fills and never starts`],
      });
    }
    fs.unlinkSync(file);
    publisher.note(contentTypeOf(path.dirname(file)));
    return send(res, 200, { deleted: id });
  }

  // /api/packs
  if (req.method === 'GET' && parts[1] === 'packs' && parts.length === 2) {
    return send(
      res,
      200,
      packs().map((p) => ({ id: p.id, textures: p.textureDir !== null })),
    );
  }

  // /api/packs/:pack
  if (req.method === 'GET' && parts[1] === 'packs' && parts.length === 3) {
    const pack = packOf(parts[2]!);
    if (!pack) return send(res, 404, { error: 'no such pack' });
    return send(res, 200, catalogue(pack));
  }

  // /api/packs/:pack/fbx/:stem  and  /tex/:stem
  if (req.method === 'GET' && parts[1] === 'packs' && parts.length === 5) {
    const pack = packOf(parts[2]!);
    if (!pack) return send(res, 404, { error: 'no such pack' });
    const stem = path.basename(decodeURIComponent(parts[4]!));
    if (parts[3] === 'fbx') {
      return sendBinary(res, path.join(pack.meshDir, `${stem}.fbx`), 'application/octet-stream');
    }
    if (parts[3] === 'tex' && pack.textureDir) {
      return sendBinary(res, path.join(pack.textureDir, `${stem}.png`), 'image/png');
    }
    return send(res, 404, { error: 'not found' });
  }

  // /api/characters
  if (req.method === 'GET' && parts[1] === 'characters' && parts.length === 2) {
    try {
      return send(res, 200, savedCharacters());
    } catch (e) {
      return send(res, 500, { error: `a saved character is invalid: ${(e as Error).message}` });
    }
  }

/**
 * Every authored character definition (D-594), for the creature editor's
 * "what it looks like" picker.
 */
/** Where each declared person stands, by area (D-598). */
function npcPlacements(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const dir = path.join(contentDir, 'areas');
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    let doc: { id?: string; npcs?: { type: string }[] };
    try {
      doc = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch {
      continue;
    }
    for (const placed of doc.npcs ?? []) {
      (out[placed.type] ??= []).push(doc.id ?? f.replace(/\.json$/, ''));
    }
  }
  return out;
}

/** Every descriptor a LIVE objective is decided by (D-593). */
function objectiveDescriptors(): Set<string> {
  const out = new Set<string>();
  const dir = path.join(contentDir, 'objectives');
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as
        { status?: string; kind?: { descriptor?: string } };
      if (doc.status === 'live' && doc.kind?.descriptor) out.add(doc.kind.descriptor);
    } catch {
      continue;
    }
  }
  return out;
}

function savedCharacterDefs(): CharacterDef[] {
  const dir = path.join(contentDir, 'characters');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => CharacterDefSchema.parse(
      JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')),
    ));
}

  // PUT /api/characters/:id
  if (req.method === 'PUT' && parts[1] === 'characters' && parts.length === 3) {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      const parsed = CharacterDefSchema.safeParse(JSON.parse(body || '{}'));
      if (!parsed.success) {
        return send(res, 400, { error: 'schema', issues: parsed.error.issues });
      }
      const def = parsed.data;
      if (def.id !== parts[2]) return send(res, 400, { error: 'id does not match the url' });
      const problems = problemsWith(def);
      if (problems.length) return send(res, 400, { error: 'would not build', problems });

      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, `${def.id}.json`), `${JSON.stringify(def, null, 2)}\n`);
      publisher.note('characters');
      return send(res, 200, { saved: def.id });
    });
    return;
  }

  // DELETE /api/characters/:id
  //
  // ⚠ Refused while a creature is still drawn as it (D-613). A roamer names
  // its look by id (D-594), and deleting the definition out from under one
  // leaves content that parses, validates against its own schema, and fails
  // the build somewhere else about a different document -- the exact shape of
  // failure the recipe graph check exists to prevent (D-569).
  if (req.method === 'DELETE' && parts[1] === 'characters' && parts.length === 3) {
    const id = decodeURIComponent(parts[2]!);
    const file = path.join(outDir, `${id}.json`);
    if (!fs.existsSync(file)) return send(res, 404, { error: 'no such character' });
    const used = savedRoamers()
      .filter((r) => r.character === id)
      .map((r) => r.id);
    if (used.length > 0) {
      return send(res, 400, {
        error: 'would not build',
        problems: [`${id} is what ${used.join(', ')} ${used.length === 1 ? 'is' : 'are'} drawn as`],
      });
    }
    fs.unlinkSync(file);
    publisher.note(contentTypeOf(path.dirname(file)));
    return send(res, 200, { deleted: id });
  }

  // /api/parts/:pack — what a pack's parts are CALLED in the game.
  if (parts[1] === 'parts' && parts.length === 3) {
    const packId = decodeURIComponent(parts[2]!);
    const file = `${packId}.json`;
    if (req.method === 'GET') {
      const existing = readJson(partsDir, file, (raw) => PartNamesSchema.parse(raw));
      return send(res, 200, existing ?? { pack: packId, names: {}, tags: {} });
    }
    if (req.method === 'PUT') {
      return withBody(req, res, (raw) => {
        const parsed = PartNamesSchema.safeParse(raw);
        if (!parsed.success) {
          return send(res, 400, { error: 'schema', issues: parsed.error.issues });
        }
        if (parsed.data.pack !== packId) {
          return send(res, 400, { error: 'pack does not match the url' });
        }
        // A name for a part the pack does not ship is a rename waiting to be
        // lost; it is refused here rather than written and puzzled over.
        const known = knownIn(packId);
        const strays = known
          ? Object.keys(parsed.data.names).filter((stem) => !known.partsInPack.has(stem))
          : [];
        if (strays.length) {
          return send(res, 400, {
            error: 'would not build',
            problems: strays.map((s2) => `"${s2}" is not in ${packId}`),
          });
        }
        writeJson(partsDir, file, parsed.data satisfies PartNames);
        return send(res, 200, { saved: packId, named: Object.keys(parsed.data.names).length });
      });
    }
  }

  // /api/races
  if (req.method === 'GET' && parts[1] === 'races' && parts.length === 2) {
    try {
      return send(res, 200, savedRaces());
    } catch (e) {
      return send(res, 500, { error: `a saved race is invalid: ${(e as Error).message}` });
    }
  }

  // PUT /api/races/:id
  if (req.method === 'PUT' && parts[1] === 'races' && parts.length === 3) {
    return withBody(req, res, (raw) => {
      const parsed = RaceSchema.safeParse(raw);
      if (!parsed.success) {
        return send(res, 400, { error: 'schema', issues: parsed.error.issues });
      }
      const race = parsed.data;
      if (race.id !== parts[2]) return send(res, 400, { error: 'id does not match the url' });
      const problems = raceProblems(race, knownIn(race.pack));
      if (problems.length) return send(res, 400, { error: 'would not build', problems });
      writeJson(racesDir, `${race.id}.json`, race);
      return send(res, 200, { saved: race.id });
    });
  }

  // /api/items — the in-game item library.
  if (req.method === 'GET' && parts[1] === 'items' && parts.length === 2) {
    return send(res, 200, savedItems());
  }

  // PUT /api/items/:id
  if (req.method === 'PUT' && parts[1] === 'items' && parts.length === 3) {
    return withBody(req, res, (raw) => {
      const parsed = ItemTemplateSchema.safeParse(raw);
      if (!parsed.success) {
        return send(res, 400, { error: 'schema', issues: parsed.error.issues });
      }
      const item = parsed.data;
      if (item.id !== parts[2]) return send(res, 400, { error: 'id does not match the url' });
      // ⚠ An item pointing at art that does not exist renders as nothing and
      // reads as a missing model. Refused here, the same guarantee the studio
      // gives a character and the editor gives a map.
      if (item.art) {
        const pack = packOf(item.art.pack);
        if (!pack) return send(res, 400, { error: `no pack '${item.art.pack}'` });
        const file = path.join(assetsDir, `${item.art.pack}.character-item.json`);
        const assets = readJson(assetsDir, path.basename(file), (r) => AssetFileSchema.parse(r));
        if (!assets?.assets.some((a) => a.id === item.art!.asset)) {
          return send(res, 400, {
            error: 'would not build',
            problems: [`no asset '${item.art.asset}' in ${item.art.pack}`],
          });
        }
      }
      writeJson(path.join(contentDir, 'items'), `${item.id}.json`, item);
      return send(res, 200, { saved: item.id });
    });
  }

  // /api/assetcolours/:pack/:mesh — the flat colours one mesh samples.
  if (req.method === 'GET' && parts[1] === 'assetcolours' && parts.length === 4) {
    const pack = packOf(decodeURIComponent(parts[2]!));
    if (!pack) return send(res, 404, { error: 'no such pack' });
    return send(res, 200, { colours: meshColours(pack, path.basename(decodeURIComponent(parts[3]!))) });
  }

  // /api/catalogue — skills, feats, spells and items, for the class editor.
  if (req.method === 'GET' && parts[1] === 'catalogue' && parts.length === 2) {
    return send(res, 200, buildCatalogue());
  }

  // PUT /api/catalogue/feats | /spells | /skills — the whole array, rewritten.
  //
  // ⚠ `skills` joined the other two because until it did, the three things a
  // player actually PICKS at creation were the only content in the repository
  // with no way to author them. A class could be gated and a race curated in
  // the tool, and then somebody had to hand-edit JSON to add the skill the
  // gate referred to.
  if (req.method === 'PUT' && parts[1] === 'catalogue' && parts.length === 3) {
    const which = parts[2];
    if (which !== 'feats' && which !== 'spells' && which !== 'skills') {
      return send(res, 404, { error: 'not found' });
    }
    return withBody(req, res, (raw) => {
      const parsed =
        which === 'feats'
          ? FeatsFileSchema.safeParse(raw)
          : which === 'spells'
            ? SpellsFileSchema.safeParse(raw)
            : SkillsFileSchema.safeParse(raw);
      if (!parsed.success) {
        return send(res, 400, { error: 'schema', issues: parsed.error.issues });
      }
      const dir = path.join(contentDir, which);
      fs.mkdirSync(dir, { recursive: true });
      publisher.note(which);
      fs.writeFileSync(path.join(dir, `${which}.json`), `${JSON.stringify(parsed.data, null, 2)}
`);
      return send(res, 200, { saved: which, count: parsed.data.length });
    });
  }


  /* ------------------------------------ interactive objects (D-583) ----- */

  /**
   * ⚠ Stations and resource nodes are served TOGETHER because they are the
   * same kind of thing to the person authoring them: an object in the world
   * that a player walks up to and uses. They differ in what they do — one
   * gates a recipe, the other yields an item and runs out — and not in how
   * they are made, placed or drawn. Two tabs would mean learning the art
   * picker twice and would hide that a forge and a vein are siblings.
   */
  if (req.method === 'GET' && parts[1] === 'interactive' && parts.length === 2) {
    try {
      const stations = fs.existsSync(stationsDir)
        ? fs.readdirSync(stationsDir).filter((f) => f.endsWith('.json'))
          .map((f) => StationDefSchema.parse(readJson(stationsDir, f, (r) => r)))
        : [];
      const nodes = fs.existsSync(nodesDir)
        ? fs.readdirSync(nodesDir).filter((f) => f.endsWith('.json'))
          .map((f) => ResourceNodeSchema.parse(readJson(nodesDir, f, (r) => r)))
        : [];
      const npcs = fs.existsSync(npcsDir)
        ? fs.readdirSync(npcsDir).filter((f) => f.endsWith('.json'))
          .map((f) => NpcDefSchema.parse(readJson(npcsDir, f, (r) => r)))
        : [];
      return send(res, 200, {
        stations,
        nodes,
        npcs,
        // ⚠ Where each of them STANDS, and how many places. A person defined
        // and placed nowhere is content nobody will ever meet — D-210's
        // complaint about orphans, applied to the cast — and the list says so
        // rather than looking finished.
        npcPlaces: npcPlacements(),
        // What they may be drawn as (D-596), so the look is picked from a
        // list. An id the content cannot resolve is refused at spawn.
        characterIds: savedCharacterDefs().map((c) => c.id),
        // ⚠ Which station types the RULES name by id (D-530). A definition
        // can be deleted, and deleting one of these breaks crafting rather
        // than removing a building, so the tool has to be able to say so.
        coreStations: CORE_STATION_TYPES,
        // Which recipes gate on each station, and which items each node
        // yields: a station nothing crafts at and a node yielding an item
        // nothing consumes are both orphans (D-210).
        usedBy: interactiveUsage(),
      });
    } catch (e) {
      return send(res, 500, { error: `a saved definition is invalid: ${(e as Error).message}` });
    }
  }

  // PUT /api/interactive/npcs/:id — who stands in the world (D-598).
  if (req.method === 'PUT' && parts[1] === 'interactive' && parts[2] === 'npcs'
      && parts.length === 4) {
    return withBody(req, res, (raw) => {
      const parsed = NpcDefSchema.safeParse(raw);
      if (!parsed.success) return send(res, 400, { error: 'schema', issues: parsed.error.issues });
      const def = parsed.data;
      if (def.id !== decodeURIComponent(parts[3]!)) {
        return send(res, 400, { error: 'id does not match the url' });
      }
      // ⚠ The look has to resolve. The server refuses an unknown one at
      // spawn (D-596) and the client would fall back to the appearance seed
      // and draw a plausible stranger, so a typo here is invisible in play.
      if (def.character && !savedCharacterDefs().some((c) => c.id === def.character)) {
        return send(res, 400, {
          error: 'would not build',
          problems: [`no character '${def.character}' in content/characters`],
        });
      }
      // ⚠ A descriptor is a MATCH KEY as well as prose: a live `kill_npc`
      // objective is decided by comparing it exactly (D-593). Renaming one out
      // from under an objective makes that objective unwinnable, and the round
      // engine deals objectives at random with nobody watching — so this is a
      // refusal, not a warning.
      const claimed = objectiveDescriptors();
      const previous = fs.existsSync(path.join(npcsDir, `${def.id}.json`))
        ? NpcDefSchema.parse(readJson(npcsDir, `${def.id}.json`, (r) => r)).descriptor
        : null;
      if (previous && previous !== def.descriptor && claimed.has(previous)) {
        return send(res, 400, {
          error: 'would not build',
          problems: [
            `a live objective targets "${previous}" — rewording it here would `
            + 'make that objective unwinnable. Change the objective first.',
          ],
        });
      }
      writeJson(npcsDir, `${def.id}.json`, def);
      return send(res, 200, { saved: def.id });
    });
  }

  if (req.method === 'PUT' && parts[1] === 'interactive' && parts.length === 4) {
    const kind = parts[2];
    if (kind !== 'stations' && kind !== 'nodes') {
      return send(res, 404, { error: 'interactive objects are stations, nodes or npcs' });
    }
    return withBody(req, res, (raw) => {
      const schema = kind === 'stations' ? StationDefSchema : ResourceNodeSchema;
      const parsed = schema.safeParse(raw);
      if (!parsed.success) return send(res, 400, { error: 'schema', issues: parsed.error.issues });
      const def = parsed.data;
      if (def.id !== decodeURIComponent(parts[3]!)) {
        return send(res, 400, { error: 'id does not match the url' });
      }
      // ⚠ The art is checked against the INGESTED catalogue, which CI cannot
      // see (`assets/source/` is gitignored). A definition naming a mesh
      // nobody has ingested saves fine and then draws the built-in shape —
      // the silent fallback that looks like a texture failing to load.
      const art = (def as { art?: { pack: string; asset: string } }).art;
      if (art) {
        const known = environmentIds(art.pack);
        if (!known.has(art.asset)) {
          return send(res, 400, {
            error: 'would not draw',
            problems: [`${art.pack} has no environment asset '${art.asset}'`],
          });
        }
      }
      const dir = kind === 'stations' ? stationsDir : nodesDir;
      writeJson(dir, `${def.id}.json`, def);
      return send(res, 200, { saved: def.id });
    });
  }

  /* ----------------------------------------------- garments (D-570) ----- */

  // /api/garments — every garment, plus what a pack offers to build one from.
  if (req.method === 'GET' && parts[1] === 'garments' && parts.length === 2) {
    try {
      const list = savedGarments();
      return send(res, 200, {
        garments: list,
        slots: GARMENT_SLOTS,
        // The derived material per garment, so the tool shows what the class
        // gate will actually read rather than asking somebody to type it.
        materials: Object.fromEntries(
          list.map((g) => [g.id, garmentMaterial(g, partTagsFor(g.pack))]),
        ),
        // Which items already wear each one — a garment nothing wears is
        // content with no consumer, which is D-210's whole complaint.
        wornBy: wornByGarment(),
      });
    } catch (e) {
      return send(res, 500, { error: `a saved garment is invalid: ${(e as Error).message}` });
    }
  }

  // PUT /api/garments/:id — validated against the PACK, which CI cannot see.
  if (req.method === 'PUT' && parts[1] === 'garments' && parts.length === 3) {
    return withBody(req, res, (raw) => {
      const parsed = GarmentSchema.safeParse(raw);
      if (!parsed.success) return send(res, 400, { error: 'schema', issues: parsed.error.issues });
      const garment = parsed.data;
      if (garment.id !== decodeURIComponent(parts[2]!)) {
        return send(res, 400, { error: 'id does not match the url' });
      }
      // ⚠ The real mesh set, not null. This is the half CI structurally
      // cannot do — `assets/source/` is gitignored — and it is the half that
      // catches a part the pack does not ship.
      const pack = packOf(garment.pack);
      const meshes = pack ? new Set(partStems(pack)) : null;
      const problems = garmentProblems(garment, meshes);
      if (problems.length) return send(res, 400, { error: 'would not build', problems });
      writeJson(garmentsDir, `${garment.id}.json`, garment);
      return send(res, 200, {
        saved: garment.id,
        material: garmentMaterial(garment, partTagsFor(garment.pack)),
      });
    });
  }

  // DELETE /api/garments/:id — refused while an item still wears it.
  if (req.method === 'DELETE' && parts[1] === 'garments' && parts.length === 3) {
    const id = decodeURIComponent(parts[2]!);
    const file = path.join(garmentsDir, `${id}.json`);
    if (!fs.existsSync(file)) return send(res, 404, { error: 'no such garment' });
    const wearers = wornByGarment()[id] ?? [];
    if (wearers.length) {
      return send(res, 400, {
        error: 'would not build',
        problems: wearers.map((i) => `item '${i}' wears this garment`),
      });
    }
    fs.unlinkSync(file);
    publisher.note(contentTypeOf(path.dirname(file)));
    return send(res, 200, { deleted: id });
  }

  /* ------------------------------------------- round content (D-569) --- */

  // /api/round — recipes, roamers and objectives, with what they may refer to.
  if (req.method === 'GET' && parts[1] === 'round' && parts.length === 2) {
    try {
      return send(res, 200, {
        recipes: savedRecipes(),
        roamers: savedRoamers(),
        // ⚠ The roster, in DRAW ORDER (D-624). Sorted here rather than in
        // the tool, so the list somebody edits is the list the lobby summons.
        bots: savedBots(),
        objectives: savedObjectives(),
        items: buildCatalogue().items,
        nodes: savedNodes().map((n) => ({ id: n.id, yields: n.yields })),
        npcDescriptors: npcDescriptorHints(),
        // ⚠ What a creature may be drawn AS (D-594). The authored list, not
        // what happens to be built — the tool must be able to pick a character
        // in a checkout where nobody has run `build:characters` yet, and the
        // build is what turns an id into a body.
        characters: savedCharacterDefs().map((c) => ({
          id: c.id,
          name: c.name,
          pack: c.pack,
          whole: c.mesh !== undefined,
        })),
        // What a companion may be given (D-624). Ids only: the forms are
        // pickers, and a free-text calling is a companion the lobby refuses.
        callings: savedClasses().map((c) => ({ id: c.id, name: c.name })),
        races: savedRaces().map((r) => ({ id: r.id, name: r.name })),
      });
    } catch (e) {
      return send(res, 500, { error: `a saved document is invalid: ${(e as Error).message}` });
    }
  }

  // PUT /api/round/recipes|roamers|objectives/:id
  //
  // ⚠ Each refuses a save that would fail the build, which is D-543's rule for
  // the map editor applied to the round's content. For recipes and roamers
  // that means the D-210 orphan GRAPH as it would stand after the change, not
  // just the document: the commonest way to break invariant 2 is to repoint
  // the only recipe that consumed a material, and the document you are
  // editing stays perfectly valid while you do it.
  if (req.method === 'PUT' && parts[1] === 'round' && parts.length === 4) {
    const which = parts[2];
    const id = decodeURIComponent(parts[3]!);
    if (which === 'recipes') {
      return withBody(req, res, (raw) => {
        const parsed = RecipeSchema.safeParse(raw);
        if (!parsed.success) return send(res, 400, { error: 'schema', issues: parsed.error.issues });
        if (parsed.data.id !== id) return send(res, 400, { error: 'id does not match the url' });
        const problems = recipeProblems(parsed.data, { itemIds: itemIdSet() });
        const after = [...savedRecipes().filter((r) => r.id !== id), parsed.data];
        problems.push(...graphProblems({ recipes: after }));
        if (problems.length) return send(res, 400, { error: 'would not build', problems });
        writeJson(recipesDir, `${id}.json`, parsed.data);
        return send(res, 200, { saved: id });
      });
    }
    if (which === 'roamers') {
      return withBody(req, res, (raw) => {
        const parsed = RoamerSchema.safeParse(raw);
        if (!parsed.success) return send(res, 400, { error: 'schema', issues: parsed.error.issues });
        if (parsed.data.id !== id) return send(res, 400, { error: 'id does not match the url' });
        const problems = roamerProblems(parsed.data, { itemIds: itemIdSet() });
        const after = [...savedRoamers().filter((r) => r.id !== id), parsed.data];
        problems.push(...graphProblems({ roamers: after }));
        if (problems.length) return send(res, 400, { error: 'would not build', problems });
        writeJson(roamersDir, `${id}.json`, parsed.data);
        return send(res, 200, { saved: id });
      });
    }
    if (which === 'bots') {
      return withBody(req, res, (raw) => {
        const parsed = BotDefSchema.safeParse(raw);
        if (!parsed.success) return send(res, 400, { error: 'schema', issues: parsed.error.issues });
        if (parsed.data.id !== id) return send(res, 400, { error: 'id does not match the url' });
        // ⚠ Refused here for the same reason every other save is (D-543):
        // a companion naming a calling that does not exist parses cleanly and
        // fails at the moment somebody presses the button to fill a lobby,
        // which is how a round starts at all (D-607).
        const problems: string[] = [];
        if (parsed.data.classId && !savedClasses().some((c) => c.id === parsed.data.classId)) {
          problems.push(`unknown calling '${parsed.data.classId}'`);
        }
        if (parsed.data.raceId && !savedRaces().some((r) => r.id === parsed.data.raceId)) {
          problems.push(`unknown race '${parsed.data.raceId}'`);
        }
        // ⚠ The three ARMS, checked on the roster as it would stand. A cast
        // of three is the floor (D-522), and if the first three summoned leave
        // the farm unworked, hunger looks broken when it is merely unattended
        // (D-529) -- a bug report about the wrong system, from a save that
        // looked fine.
        const after = [...savedBots().filter((b) => b.id !== id), parsed.data]
          .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
        const arms = new Set(after.slice(0, 3).map((b) => b.role));
        if (after.length >= 3 && !(['gatherer', 'forager', 'woodsman'] as const).every((r) => arms.has(r))) {
          problems.push(
            'the first three summoned must cover the mine, the farm and the wood '
            + `(they are now ${[...arms].join(', ')}) — a cast of three with an arm `
            + 'unworked makes hunger look broken',
          );
        }
        if (problems.length) return send(res, 400, { error: 'would not build', problems });
        writeJson(botsDir, `${id}.json`, parsed.data);
        return send(res, 200, { saved: id });
      });
    }
    if (which === 'objectives') {
      return withBody(req, res, (raw) => {
        const parsed = ObjectiveSchema.safeParse(raw);
        if (!parsed.success) return send(res, 400, { error: 'schema', issues: parsed.error.issues });
        if (parsed.data.id !== id) return send(res, 400, { error: 'id does not match the url' });
        // ⚠ `npcDescriptors: null` on purpose — see `npcDescriptorHints`.
        const problems = objectiveProblems(parsed.data, {
          itemIds: itemIdSet(),
          npcDescriptors: null,
        });
        const after = [...savedObjectives().filter((o) => o.id !== id), parsed.data];
        const coverage = castCoverageProblem(after);
        if (coverage) problems.push(coverage);
        if (problems.length) return send(res, 400, { error: 'would not build', problems });
        writeJson(objectivesDir, `${id}.json`, parsed.data);
        return send(res, 200, { saved: id });
      });
    }
    return send(res, 404, { error: 'not found' });
  }

  // DELETE /api/round/recipes|roamers|objectives/:id
  //
  // ⚠ Deleting is the operation the orphan check exists for. Removing the one
  // recipe that consumed a material leaves that material gatherable and
  // useless — a clean delete, a broken build. Refused here with the name of
  // the item that would be stranded.
  if (req.method === 'DELETE' && parts[1] === 'round' && parts.length === 4) {
    const which = parts[2];
    const id = decodeURIComponent(parts[3]!);
    const dir =
      which === 'recipes' ? recipesDir
        : which === 'roamers' ? roamersDir
          : which === 'bots' ? botsDir
            : which === 'objectives' ? objectivesDir : null;
    if (!dir) return send(res, 404, { error: 'not found' });
    const file = path.join(dir, `${id}.json`);
    if (!fs.existsSync(file)) return send(res, 404, { error: 'no such document' });
    const problems =
      which === 'recipes' ? graphProblems({ recipes: savedRecipes().filter((r) => r.id !== id) })
        : which === 'bots' ? (() => {
          // ⚠ Deleting is how the arms get uncovered. Removing the only
          // forager leaves a roster that parses, saves and starves a cast of
          // three, so it is refused by name here as well as on save.
          const left = savedBots().filter((b) => b.id !== id);
          if (left.length < 3) return [];
          const arms = new Set(left.slice(0, 3).map((b) => b.role));
          return (['gatherer', 'forager', 'woodsman'] as const).every((r) => arms.has(r))
            ? []
            : [`without '${id}' the first three summoned are ${[...arms].join(', ')} `
              + '— the mine, the farm and the wood must all be covered'];
        })()
          : which === 'roamers' ? graphProblems({ roamers: savedRoamers().filter((r) => r.id !== id) })
          : (() => {
            const c = castCoverageProblem(savedObjectives().filter((o) => o.id !== id));
            return c ? [c] : [];
          })();
    if (problems.length) return send(res, 400, { error: 'would not build', problems });
    fs.unlinkSync(file);
    publisher.note(contentTypeOf(path.dirname(file)));
    return send(res, 200, { deleted: id });
  }

  /* --------------------------- speech, sound and gesture (D-569) -------- */

  // /api/world — the three array files the world speaks and sounds through.
  if (req.method === 'GET' && parts[1] === 'world' && parts.length === 2) {
    try {
      return send(res, 200, {
        sounds: savedSounds(),
        lexicon: savedLexicon(),
        languages: savedLanguages(),
        // What is actually on disk under client/public/audio, so a cue is
        // pointed at a file by picking rather than by typing a path.
        audioFiles: audioFilesOnDisk(),
        postures: POSTURES,
        transients: TRANSIENT_ANIMS,
        // Which cues an area already names, so removing one says what breaks.
        ambienceInUse: ambienceInUse(),
      });
    } catch (e) {
      return send(res, 500, { error: `a saved document is invalid: ${(e as Error).message}` });
    }
  }

  // PUT /api/world/sounds | /emotes | /languages — the whole file, rewritten.
  if (req.method === 'PUT' && parts[1] === 'world' && parts.length === 3) {
    const which = parts[2];
    if (which === 'sounds') {
      return withBody(req, res, (raw) => {
        const parsed = SoundsFileSchema.safeParse(raw);
        if (!parsed.success) return send(res, 400, { error: 'schema', issues: parsed.error.issues });
        const problems: string[] = [];
        const ids = new Set<string>();
        for (const cue of parsed.data) {
          if (ids.has(cue.id)) problems.push(`'${cue.id}' is defined twice`);
          ids.add(cue.id);
          // ⚠ The check that earns its keep (D-541). A cue pointing at a file
          // that is not there is SILENT in play and looks exactly like a cue
          // nobody wired, so it has to be refused rather than warned about.
          for (const file of cue.files) {
            if (!fs.existsSync(path.join(audioRoot, file))) {
              problems.push(`'${cue.id}': missing file '${file}' — run tools/src/build-audio.py`);
            }
          }
        }
        // ⚠ Removing a cue an area names is how you make an area throw on
        // load. The area is not open in this editor, so nothing else would
        // catch it until the build.
        for (const [areaId, cue] of ambienceInUse()) {
          if (!ids.has(cue)) problems.push(`area '${areaId}' names ambience '${cue}', which this would remove`);
        }
        if (problems.length) return send(res, 400, { error: 'would not build', problems });
        writeJson(path.join(contentDir, 'audio'), 'sounds.json', parsed.data);
        return send(res, 200, { saved: 'sounds', count: parsed.data.length });
      });
    }
    if (which === 'emotes') {
      return withBody(req, res, (raw) => {
        const parsed = EmoteLexiconSchema.safeParse(raw);
        if (!parsed.success) return send(res, 400, { error: 'schema', issues: parsed.error.issues });
        writeJson(path.join(contentDir, 'emotes'), 'lexicon.json', parsed.data);
        return send(res, 200, { saved: 'emotes' });
      });
    }
    if (which === 'languages') {
      return withBody(req, res, (raw) => {
        // ⚠ `LanguagesFileSchema` is what refuses to drop `common` — the
        // language everybody is assumed to share. Without it every line of
        // speech in the world scrambles for every listener.
        const parsed = LanguagesFileSchema.safeParse(raw);
        if (!parsed.success) return send(res, 400, { error: 'schema', issues: parsed.error.issues });
        writeJson(path.join(contentDir, 'languages'), 'languages.json', parsed.data);
        return send(res, 200, { saved: 'languages', count: parsed.data.length });
      });
    }
    return send(res, 404, { error: 'not found' });
  }

  // /api/classes — the callings, and the races they could admit.
  if (req.method === 'GET' && parts[1] === 'classes' && parts.length === 2) {
    try {
      return send(res, 200, { classes: savedClasses(), races: savedRaces().map((r) => r.id) });
    } catch (e) {
      return send(res, 500, { error: `a saved class is invalid: ${(e as Error).message}` });
    }
  }

  // PUT /api/classes/:id
  if (req.method === 'PUT' && parts[1] === 'classes' && parts.length === 3) {
    return withBody(req, res, (raw) => {
      const parsed = ClassSchema.safeParse(raw);
      if (!parsed.success) {
        return send(res, 400, { error: 'schema', issues: parsed.error.issues });
      }
      const cls = parsed.data;
      if (cls.id !== parts[2]) return send(res, 400, { error: 'id does not match the url' });
      const races = new Set(savedRaces().map((r) => r.id));
      const problems = classGateProblems(cls, { races });
      if (problems.length) return send(res, 400, { error: 'would not build', problems });
      writeJson(classesDir, `${cls.id}.json`, cls);
      return send(res, 200, { saved: cls.id });
    });
  }

  // /api/animations — every authored set, and what there is to choose from.
  if (req.method === 'GET' && parts[1] === 'animations' && parts.length === 2) {
    try {
      return send(res, 200, { sets: savedAnimationSets(), clips: builtClips() });
    } catch (e) {
      return send(res, 500, { error: `a saved animation set is invalid: ${(e as Error).message}` });
    }
  }

  // PUT /api/animations/:id — validated against the clips that actually built.
  if (req.method === 'PUT' && parts[1] === 'animations' && parts.length === 3) {
    return withBody(req, res, (raw) => {
      const parsed = AnimationSetSchema.safeParse(raw);
      if (!parsed.success) {
        return send(res, 400, { error: 'schema', issues: parsed.error.issues });
      }
      const set = parsed.data;
      if (set.id !== parts[2]) return send(res, 400, { error: 'id does not match the url' });
      const clips = builtClips();
      const problems = animationSetProblems(set, clips.length ? new Set(clips) : null);
      if (problems.length) return send(res, 400, { error: 'would not build', problems });
      writeJson(animationsDir, `${set.id}.json`, set);
      return send(res, 200, { saved: set.id, clips: Object.keys(set.clips).length });
    });
  }

  // /api/assetpacks — every pack with meshes, not only character packs.
  if (req.method === 'GET' && parts[1] === 'assetpacks' && parts.length === 2) {
    return send(res, 200, allPacks().map((p) => ({ id: p.id })));
  }

  // /api/assetpacks/:pack — its meshes, each with the kind its prefix suggests.
  if (req.method === 'GET' && parts[1] === 'assetpacks' && parts.length === 3) {
    const pack = packOf(decodeURIComponent(parts[2]!));
    if (!pack) return send(res, 404, { error: 'no such pack' });
    // ⚠ `shelf` as well as `kind`. The kind is what a catalogue may claim and
    // is null for anything unrecognised; the shelf is where the tool SHOWS it,
    // and is never null — a mesh with no kind used to appear in no tab at all.
    const meshes = allMeshStems(pack).map((stem) => ({
      stem,
      kind: kindOfMesh(stem),
      shelf: meshShelf(stem),
    }));
    return send(res, 200, { meshes, textures: texturesIn(pack) });
  }

  // /api/assetpacks/:pack/tex/:stem — an ATLAS from any pack, not only the
  // character ones.
  //
  // ⚠ `/api/packs/:pack/tex` serves `packs()`, which is packs with character
  // PARTS — so the knights weapon atlas could not be fetched by the client at
  // all. The request 404'd, the loader's catch swallowed it, and the preview
  // silently kept whatever texture was last loaded: a sword painted from the
  // character sheet, skin tones and all.
  if (req.method === 'GET' && parts[1] === 'assetpacks' && parts.length === 5 && parts[3] === 'tex') {
    const pack = packOf(decodeURIComponent(parts[2]!));
    if (!pack) return send(res, 404, { error: 'no such pack' });
    const file = texturePaths(pack).get(path.basename(decodeURIComponent(parts[4]!)));
    if (!file) return send(res, 404, { error: 'no such texture' });
    return sendBinary(res, file, 'image/png');
  }

  // /api/assetpacks/:pack/fbx/:stem — found anywhere under the pack.
  if (req.method === 'GET' && parts[1] === 'assetpacks' && parts.length === 5 && parts[3] === 'fbx') {
    const pack = packOf(decodeURIComponent(parts[2]!));
    if (!pack) return send(res, 404, { error: 'no such pack' });
    const file = meshPath(pack, path.basename(decodeURIComponent(parts[4]!)));
    if (!file) return send(res, 404, { error: 'no such mesh' });
    return sendBinary(res, file, 'application/octet-stream');
  }

  // /api/assets/:pack/:kind
  if (parts[1] === 'assets' && parts.length === 4) {
    const packId = decodeURIComponent(parts[2]!);
    const kind = decodeURIComponent(parts[3]!) as AssetKind;
    if (!(ASSET_KINDS as readonly string[]).includes(kind)) {
      return send(res, 400, { error: `not an asset kind: ${kind}` });
    }
    const file = `${packId}.${kind}.json`;
    if (req.method === 'GET') {
      const existing = readJson(assetsDir, file, (raw) => AssetFileSchema.parse(raw));
      return send(res, 200, existing ?? { pack: packId, kind, assets: [] });
    }
    if (req.method === 'PUT') {
      return withBody(req, res, (raw) => {
        const parsed = AssetFileSchema.safeParse(raw);
        if (!parsed.success) {
          return send(res, 400, { error: 'schema', issues: parsed.error.issues });
        }
        if (parsed.data.pack !== packId || parsed.data.kind !== kind) {
          return send(res, 400, { error: 'pack or kind does not match the url' });
        }
        const pack = packOf(packId);
        const problems = assetProblems(
          parsed.data,
          pack ? new Set(allMeshStems(pack)) : null,
        );
        if (problems.length) return send(res, 400, { error: 'would not build', problems });
        writeJson(assetsDir, file, parsed.data);
        return send(res, 200, { saved: file, named: parsed.data.assets.length });
      });
    }
  }

  return send(res, 404, { error: 'not found' });
});

server.listen(port, () => {
  const found = packs();
  console.log(`authoring api on http://localhost:${port} (studio, creation tool, map editor)`);
  console.log(
    found.length
      ? `  packs: ${found.map((p) => p.id).join(', ')}`
      : '  no packs with character parts in assets/source',
  );
  console.log(`  writing definitions to ${outDir}`);
});

export { catalogue, packs, problemsWith };
export type { Pack };
