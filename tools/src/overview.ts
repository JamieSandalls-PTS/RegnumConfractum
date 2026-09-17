import fs from 'node:fs';
import path from 'node:path';
import {
  AreaSchema,
  AnimationSetSchema,
  CharacterDefSchema,
  GarmentSchema,
  ObjectiveSchema,
  ScenarioSchema,
  scenarioProblems,
  type ObjectiveDef,
} from '@rc/shared';
import { listJson } from './validate-content';

/**
 * What each STAGE of the production line has, and what it is missing (D-629).
 *
 * The authoring tool is one workflow read left to right — Art, Motion,
 * Bodies, Things, World, Rules, Scenario — with each stage using what the
 * ones before it defined. The stakeholder asked that a stage show what is
 * defined, unnamed, unbuilt or authored-and-dead, rather than opening onto an
 * empty editor. This is that report, computed from the files.
 *
 * ⚠ "Unbuilt" is the finding that matters most and the one nothing else
 * reports. A definition reaches the game through a BAKED artefact for
 * characters, garments and environment meshes (`build:characters`,
 * `build:environment`), and a save that was never built validates, floods and
 * draws nothing — which is how three of the taproom's four meshes sat
 * invisible for a session (D-625). So the report reads the manifests the
 * builds write and names what has no artefact behind it.
 *
 * Pure over the tree: no server, no packs, so it runs in a test and on every
 * request without a cost anybody notices.
 */

export const STAGE_IDS = ['art', 'motion', 'bodies', 'things', 'world', 'rules', 'scenario'] as const;
export type StageId = (typeof STAGE_IDS)[number];

export interface StageReport {
  /** How many things this stage has authored, summed across its types. */
  count: number;
  /** What is here, one line per type: "3 races", "14 animation sets". */
  notes: string[];
  /** What is missing or dead, in the author's words. */
  warnings: string[];
}

export type Overview = Record<StageId, StageReport>;

function readJsonSafe<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function countJson(contentDir: string, sub: string): number {
  return listJson(path.join(contentDir, sub)).length;
}

function arrayFileLength(contentDir: string, sub: string, file: string): number {
  const doc = readJsonSafe<unknown>(path.join(contentDir, sub, file));
  return Array.isArray(doc) ? doc.length : 0;
}

/** Things the build wrote, read off the manifests rather than the folders. */
interface Built {
  outfits: Set<string>;
  clips: Set<string>;
  envMeshes: Set<string>;
  partFiles: Set<string>;
}

function built(root: string): Built {
  const models = path.join(root, 'client', 'public', 'models');
  const manifest = readJsonSafe<{ clips?: string[]; outfits?: { id: string }[] }>(
    path.join(models, 'manifest.json'),
  );
  const env = readJsonSafe<{ meshes?: Record<string, string> }>(
    path.join(models, 'env', 'manifest.json'),
  );
  let partFiles: string[] = [];
  try {
    partFiles = fs.readdirSync(path.join(models, 'parts'));
  } catch {
    partFiles = [];
  }
  return {
    outfits: new Set((manifest?.outfits ?? []).map((o) => o.id)),
    clips: new Set(manifest?.clips ?? []),
    envMeshes: new Set(Object.keys(env?.meshes ?? {})),
    partFiles: new Set(partFiles),
  };
}

export function overview(contentDir: string, root: string): Overview {
  const b = built(root);
  const report: Overview = {
    art: { count: 0, notes: [], warnings: [] },
    motion: { count: 0, notes: [], warnings: [] },
    bodies: { count: 0, notes: [], warnings: [] },
    things: { count: 0, notes: [], warnings: [] },
    world: { count: 0, notes: [], warnings: [] },
    rules: { count: 0, notes: [], warnings: [] },
    scenario: { count: 0, notes: [], warnings: [] },
  };

  /* ---- Art: names for meshes ------------------------------------------- */
  {
    let parts = 0;
    for (const file of listJson(path.join(contentDir, 'parts'))) {
      const doc = readJsonSafe<{ names?: Record<string, string> }>(file);
      parts += Object.keys(doc?.names ?? {}).length;
    }
    let assets = 0;
    const packs = new Set<string>();
    for (const file of listJson(path.join(contentDir, 'assets'))) {
      const doc = readJsonSafe<{ pack?: string; assets?: unknown[] }>(file);
      assets += doc?.assets?.length ?? 0;
      if (doc?.pack) packs.add(doc.pack);
    }
    report.art.count = parts + assets;
    report.art.notes.push(`${parts} named parts`, `${assets} named assets across ${packs.size} pack(s)`);
    if (parts === 0) report.art.warnings.push('no part has a name — the creation screen would show file stems');
  }

  /* ---- Motion: sets bound to built clips ---------------------------------- */
  {
    const sets = listJson(path.join(contentDir, 'animations'));
    report.motion.count = sets.length;
    report.motion.notes.push(`${sets.length} animation sets`, `${b.clips.size} clips built`);
    if (b.clips.size === 0) {
      report.motion.warnings.push('no clips built — run npm run build:characters');
    }
    for (const file of sets) {
      const parsed = AnimationSetSchema.safeParse(readJsonSafe(file));
      if (!parsed.success) continue;
      const missing = Object.entries(parsed.data.clips)
        .filter(([, clip]) => clip && b.clips.size > 0 && !b.clips.has(clip))
        .map(([action, clip]) => `${action} → ${clip}`);
      if (missing.length) {
        report.motion.warnings.push(`${parsed.data.id} names unbuilt clips: ${missing.join(', ')}`);
      }
    }
  }

  /* ---- Bodies: races and characters, built or not --------------------------- */
  {
    const races = countJson(contentDir, 'races');
    const chars = listJson(path.join(contentDir, 'characters'));
    report.bodies.count = races + chars.length;
    report.bodies.notes.push(`${races} races`, `${chars.length} characters`);
    if (races === 0) report.bodies.warnings.push('no race — creation cannot offer a face');
    const unbuilt: string[] = [];
    for (const file of chars) {
      const parsed = CharacterDefSchema.safeParse(readJsonSafe(file));
      if (parsed.success && !b.outfits.has(parsed.data.id)) unbuilt.push(parsed.data.id);
    }
    if (unbuilt.length) {
      report.bodies.warnings.push(
        `${unbuilt.length} character(s) not built — ${unbuilt.join(', ')} (npm run build:characters)`,
      );
    }
  }

  /* ---- Things: items, garments, interactive objects ------------------------- */
  {
    const items = countJson(contentDir, 'items');
    const garments = listJson(path.join(contentDir, 'garments'));
    const stations = countJson(contentDir, 'stations');
    const nodes = countJson(contentDir, 'nodes');
    const npcs = countJson(contentDir, 'npcs');
    report.things.count = items + garments.length + stations + nodes + npcs;
    report.things.notes.push(
      `${items} items`,
      `${garments.length} garments`,
      `${stations} stations, ${nodes} nodes, ${npcs} people`,
    );
    for (const file of garments) {
      const parsed = GarmentSchema.safeParse(readJsonSafe(file));
      if (!parsed.success) continue;
      const g = parsed.data;
      const missing: string[] = [];
      for (const body of Object.values(g.parts)) {
        for (const stem of Object.values(body as Record<string, string>)) {
          if (!b.partFiles.has(`${g.pack}__${stem}.glb`)) missing.push(stem);
        }
      }
      if (missing.length) {
        report.things.warnings.push(
          `garment ${g.id} has ${missing.length} unbuilt part(s) (npm run build:characters)`,
        );
      }
    }
  }

  /* ---- World: areas, ground, and the meshes they place ---------------------- */
  {
    const areas = listJson(path.join(contentDir, 'areas'));
    const ground = countJson(contentDir, 'ground');
    report.world.count = areas.length + ground;
    report.world.notes.push(`${areas.length} areas`, `${ground} ground materials`);
    for (const file of areas) {
      const parsed = AreaSchema.safeParse(readJsonSafe(file));
      if (!parsed.success) continue;
      const a = parsed.data;
      const missing = new Set<string>();
      for (const placed of a.assets) {
        const key = `${placed.pack}/${placed.asset}`;
        if (!b.envMeshes.has(key)) missing.add(key);
      }
      if (missing.size) {
        report.world.warnings.push(
          `${a.id} places ${missing.size} unbuilt mesh(es): ${[...missing].slice(0, 3).join(', ')}`
          + `${missing.size > 3 ? ', …' : ''} (npm run build:environment)`,
        );
      }
    }
  }

  /* ---- Rules: what the round is played by ----------------------------------- */
  {
    const classes = countJson(contentDir, 'classes');
    const skills = arrayFileLength(contentDir, 'skills', 'skills.json');
    const feats = arrayFileLength(contentDir, 'feats', 'feats.json');
    const spells = arrayFileLength(contentDir, 'spells', 'spells.json');
    const recipes = countJson(contentDir, 'recipes');
    const roamers = countJson(contentDir, 'roamers');
    const bots = countJson(contentDir, 'bots');
    const objectives = listJson(path.join(contentDir, 'objectives'));
    report.rules.count = classes + skills + feats + spells + recipes + roamers + bots + objectives.length;
    report.rules.notes.push(
      `${classes} callings; ${skills} skills, ${feats} feats, ${spells} spells`,
      `${recipes} recipes, ${roamers} roamers, ${bots} companions, ${objectives.length} objectives`,
    );
    const live = objectives
      .map((f) => ObjectiveSchema.safeParse(readJsonSafe(f)))
      .filter((p) => p.success && p.data.status === 'live').length;
    if (live === 0) report.rules.warnings.push('no live objective — no round can start');
  }

  /* ---- Scenario: the round's edges ------------------------------------------ */
  {
    const zones = new Map<string, string>();
    const exits = new Map<string, string[]>();
    for (const file of listJson(path.join(contentDir, 'areas'))) {
      const parsed = AreaSchema.safeParse(readJsonSafe(file));
      if (!parsed.success) continue;
      zones.set(parsed.data.id, parsed.data.zone);
      exits.set(parsed.data.id, parsed.data.transitions.map((t) => t.toArea));
    }
    const objectives: ObjectiveDef[] = [];
    for (const file of listJson(path.join(contentDir, 'objectives'))) {
      const parsed = ObjectiveSchema.safeParse(readJsonSafe(file));
      if (parsed.success) objectives.push(parsed.data);
    }
    const scenarios = listJson(path.join(contentDir, 'scenarios'));
    report.scenario.count = scenarios.length;
    let live = 0;
    for (const file of scenarios) {
      const parsed = ScenarioSchema.safeParse(readJsonSafe(file));
      if (!parsed.success) continue;
      if (parsed.data.status === 'live') live++;
      for (const p of scenarioProblems(parsed.data, { zones, exits, objectives })) {
        if (!p.startsWith('NOTE ')) report.scenario.warnings.push(`${parsed.data.id} ${p}`);
      }
    }
    report.scenario.notes.push(`${scenarios.length} scenarios, ${live} live`);
    if (live === 0) {
      report.scenario.warnings.push('no live scenario — the round has no edges (D-627)');
    }
  }

  return report;
}
