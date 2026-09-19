import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  tileProblems,
  unpaintedProblem,
  AreaSchema,
  ClassSchema,
  FeatsFileSchema,
  ItemTemplateSchema,
  BotDefSchema,
  NpcDefSchema,
  ObjectiveSchema,
  ROUND_MIN_CAST,
  canStandAt,
  Nav,
  areaCollision,
  placedAssetDrift,
  defaultMask,
  type Volume,
  RecipeSchema,
  ResourceNodeSchema,
  RoamerSchema,
  findOrphans,
  recipeProblems,
  roamerProblems,
  objectiveProblems,
  ScenarioSchema,
  scenarioProblems,
  ClothFileSchema,
  clothProblems,
  castCoverageProblem,
  SkillsFileSchema,
  SoundsFileSchema,
  SpellsFileSchema,
  type AreaDef,
  type ClassDef,
  type FeatDef,
  type ObjectiveDef,
  type RecipeDef,
  type ResourceNodeDef,
  type SkillDef,
  type SoundCueDef,
  type SpellDef,
  slotCandidates,
  slotsOccupied,
  type ItemTemplate,
  CharacterDefSchema,
  PartNamesSchema,
  GROUND_WEIGHTS_PER_MASK,
  GroundMaterialSchema,
  type GroundMaterial,
  GarmentSchema,
  type GarmentDef,
  garmentProblems,
  garmentMaterial,
  classGateProblems,
  CORE_STATION_TYPES,
  StationDefSchema,
  itemGateProblem,
  AnimationSetSchema,
  type AnimationSet,
  animationSetProblems,
  missingActions,
  resolveAnimations,
  AssetFileSchema,
  assetProblems,
  RaceSchema,
  raceProblems,
  missingBodySlots,
  parsePolygonPart,
  partProblems,
  type ParsedPart,
  VfxDefSchema,
  itemVfxRefs,
  vfxReferenceProblems,
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
  /** Things a human should look at that are not build failures. */
  warnings: string[];
  checked: number;
}

/**
 * Items that enter the world without being made, and are therefore not
 * orphans (D-210).
 *
 * ⚠ Exported because the authoring server runs the same graph check on save
 * (D-569). Two lists of exemptions would eventually disagree, and the
 * direction that hurts is the tool being the more permissive of the two: a
 * clean save, then a failed build.
 *
 * Objective targets are NOT listed here — they are derived from the
 * objectives themselves, so retargeting one cannot silently leave a stale
 * exemption behind.
 */
export const OTHERWISE_USED = ['written-note', 'parchment'] as const;

export function listJson(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/**
 * Flood the NAVIGATION index from the spawn; returns every authored walkable
 * tile a body cannot actually reach (D-567).
 *
 * WARNING: this used to flood TILES and ask "is this square marked walkable",
 * which is a different question and a weaker one. A doorway a body does not
 * fit through has two walkable tiles either side of it and passed happily;
 * so did a corridor pinched to 40cm by a placed asset, and a gap between two
 * buildings that looks open and is not. The check now asks what the server
 * will ask at runtime -- can a body of `BODY_RADIUS` get from the spawn to
 * here -- because a map that passes CI and cannot be walked is the failure
 * this check exists to prevent.
 *
 * Solid props and placed assets block here exactly as they block in play
 * (D-542, D-566): the scenery is part of the map's topology, not decoration
 * painted over it.
 *
 * The REPORT stays in tiles, because that is still the unit an area is
 * authored in and "unreachable at (37,42)" is something a person can go and
 * look at.
 */
export function unreachableTiles(area: AreaDef): { x: number; y: number }[] {
  const nav = new Nav(areaCollision(area));
  const start = nav.nearestOpen(area.spawn);
  if (!start) return [{ x: area.spawn.x, y: area.spawn.y }];

  // Flood the index once, then ask each authored tile whether its own cell was
  // reached. One flood for the whole area rather than a path per tile.
  const reached = new Uint8Array(nav.cols * nav.rows);
  const stack = [start.j * nav.cols + start.i];
  reached[stack[0]!] = 1;
  while (stack.length > 0) {
    const k = stack.pop()!;
    const i = k % nav.cols;
    const j = (k - i) / nav.cols;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (di === 0 && dj === 0) continue;
        if (!nav.canReach(i, j, i + di, j + dj)) continue;
        const nk = (j + dj) * nav.cols + (i + di);
        if (reached[nk]) continue;
        reached[nk] = 1;
        stack.push(nk);
      }
    }
  }

  const missing: { x: number; y: number }[] = [];
  for (let y = 0; y < area.height; y++) {
    for (let x = 0; x < area.width; x++) {
      if (!area.legend[area.tiles[y]![x]!]!.walkable) continue;
      // A tile nothing can stand on is not a reachability failure -- it is a
      // tile with something on it, which is legal and ordinary. Only a tile a
      // body COULD occupy and cannot get to is a fault.
      if (!canStandAt(area, { x, y })) continue;
      const cell = nav.cellOf({ x, y });
      if (!nav.passable(cell.i, cell.j) || !reached[cell.j * nav.cols + cell.i]) {
        missing.push({ x, y });
      }
    }
  }
  return missing;
}

export function validateContent(contentDir: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
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
    for (const problem of tileProblems(parsed.data)) errors.push(`${file}: ${problem}`);
    const unpainted = unpaintedProblem(parsed.data);
    if (unpainted) warnings.push(`${file}: ${unpainted}`);
    const missing = unreachableTiles(parsed.data);
    if (missing.length > 0) {
      const sample = missing.slice(0, 5).map((p) => `(${p.x},${p.y})`).join(' ');
      errors.push(
        `${file}: ${missing.length} walkable tile(s) unreachable from spawn, e.g. ${sample}`,
      );
    }
  }

  const itemIds = new Set<string>();
  /** Items with their categories, for the D-210 orphan graph. */
  const itemsForGraph: { id: string; category: string }[] = [];
  /** Full templates, for the starting-kit slot check below. */
  const itemsById = new Map<string, ItemTemplate>();
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
    itemsById.set(parsed.data.id, parsed.data);
    itemsForGraph.push({ id: parsed.data.id, category: parsed.data.category });
  }

  /*
   * Visual effects (D-639) — presentation the client draws; the build's only
   * question is whether what an item or an area names EXISTS. A renamed
   * effect is otherwise a hearth that stops burning with no error anywhere.
   */
  const vfxIds = new Set<string>();
  for (const file of listJson(join(contentDir, 'vfx'))) {
    checked++;
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      errors.push(`${file}: invalid JSON — ${(err as Error).message}`);
      continue;
    }
    const parsed = VfxDefSchema.safeParse(data);
    if (!parsed.success) {
      errors.push(`${file}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
      continue;
    }
    if (vfxIds.has(parsed.data.id)) {
      errors.push(`${file}: duplicate vfx id '${parsed.data.id}'`);
      continue;
    }
    if (!parsed.data.particles && !parsed.data.light && !parsed.data.glow) {
      errors.push(`${file}: an effect with no particles, light or glow draws nothing`);
    }
    vfxIds.add(parsed.data.id);
  }
  for (const [id, item] of itemsById) {
    for (const problem of vfxReferenceProblems(vfxIds, itemVfxRefs(id, item.vfx))) {
      errors.push(`items/${id}.json: ${problem}`);
    }
  }
  for (const [id, area] of parsedAreas) {
    const refs = area.vfx.map((v, i) => ({ where: `vfx[${i}]`, vfx: v.vfx }));
    for (const problem of vfxReferenceProblems(vfxIds, refs)) errors.push(`areas/${id}.json: ${problem}`);
  }

  /*
   * Garments (D-562, D-570) — the slot swaps that dress a body.
   *
   * ⚠ Validated for SHAPE here and not against the art: `assets/source/` is
   * gitignored, so CI cannot see whether a mesh exists. `garmentProblems`
   * takes `null` for that and skips the check rather than faking it; the
   * authoring server passes the real set, because it has the pack in front of
   * it. This is the same division `partProblems` and `assetProblems` make.
   */
  const garments = new Map<string, GarmentDef>();
  /** Part tags per pack, so a garment's material can be derived. */
  const partTags = new Map<string, Record<string, string[]>>();
  for (const file of listJson(join(contentDir, 'parts'))) {
    try {
      const raw = PartNamesSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
      partTags.set(raw.pack, raw.tags as Record<string, string[]>);
    } catch {
      /* reported properly in the parts pass below */
    }
  }
  for (const file of listJson(join(contentDir, 'garments'))) {
    checked++;
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      errors.push(`${file}: invalid JSON — ${(err as Error).message}`);
      continue;
    }
    const parsed = GarmentSchema.safeParse(data);
    if (!parsed.success) {
      errors.push(`${file}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
      continue;
    }
    if (garments.has(parsed.data.id)) {
      errors.push(`${file}: duplicate garment id '${parsed.data.id}'`);
      continue;
    }
    garments.set(parsed.data.id, parsed.data);
    for (const problem of garmentProblems(parsed.data, null)) {
      errors.push(`garment '${parsed.data.id}': ${problem}`);
    }
  }

  /*
   * An item that names a garment must name one that exists, and must not
   * disagree with it about what it is made of.
   *
   * ⚠ The disagreement check is the one worth having. D-566 put `material` on
   * the item as an admitted compromise because there was nowhere else for it;
   * the garment's parts carry it by measurement. Two sources that can differ
   * will differ, and the failure is silent — a class gate that lets a magus
   * wear plate because the item said cloth.
   */
  for (const item of itemsById.values()) {
    if (item.garment === undefined) continue;
    const garment = garments.get(item.garment);
    if (!garment) {
      errors.push(`item '${item.id}' wears unknown garment '${item.garment}'`);
      continue;
    }
    const derived = garmentMaterial(garment, partTags.get(garment.pack) ?? {});
    const declared = item.equip?.material;
    if (derived && declared && derived !== declared) {
      errors.push(
        `item '${item.id}' declares ${declared} but its garment '${garment.id}' is ${derived}`,
      );
    }
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
  /**
   * Every public descriptor a shipped script spawns an NPC with.
   *
   * ⚠ Scraped from the Lua, because that is where NPCs come from (D-507) and
   * there is nowhere else to look. Deliberately a loose pattern: a descriptor
   * built by concatenation would be missed, which is why what it feeds is a
   * check on LIVE objectives only.
   */
  /**
   * The declared cast (D-598), and every descriptor they wear.
   *
   * ⚠ This is what finally makes a `kill_npc` objective CHECKABLE. D-569
   * had to scrape descriptors out of Lua with a regular expression and said so
   * at length: NPCs came only from scripts, a descriptor built by
   * concatenation would be missed, and a partial scan treated as complete
   * would reject every DM-spawned target. A declared NPC is a document, so for
   * the ones that are declared the answer is exact rather than approximate.
   *
   * ⚠ The Lua scrape STAYS beside it. Scripts and DM events can still spawn
   * an NPC directly and should be able to — an event that conjures somebody
   * for one scene should not need a permanent entry in the world's cast.
   */
  const npcIds = new Set<string>();
  const npcPlacements = new Map<string, Set<string>>();
  const npcDefDescriptors = new Map<string, string>();
  for (const file of listJson(join(contentDir, 'npcs'))) {
    checked++;
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      errors.push(`${file}: invalid JSON — ${(err as Error).message}`);
      continue;
    }
    const parsed = NpcDefSchema.safeParse(data);
    if (!parsed.success) {
      errors.push(`${file}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
      continue;
    }
    const def = parsed.data;
    if (npcIds.has(def.id)) {
      errors.push(`${file}: duplicate npc id '${def.id}'`);
      continue;
    }
    npcIds.add(def.id);
    npcDefDescriptors.set(def.id, def.descriptor);
    if (!file.replace(/\\/g, '/').endsWith(`/${def.id}.json`)) {
      errors.push(`${file}: npc id '${def.id}' does not match its filename`);
    }
  }

  const npcDescriptors = new Set<string>(npcDefDescriptors.values());
  /**
   * Every character a shipped script says an NPC LOOKS like (D-596).
   *
   * ⚠ Checked as a LITERAL, which is the half of this that a build can be
   * sure about. The server refuses an unresolvable id at spawn with the list
   * of what exists, so nothing gets through either way — but a scripted NPC
   * spawns when its area first loads, which in the round map is the moment a
   * round starts, and finding a typo then means the keeper is missing from a
   * round somebody is playing. This finds it at build time instead.
   */
  const scriptCharacters: { file: string; id: string }[] = [];
  const scriptNpcs: { file: string; id: string }[] = [];
  try {
    const dir = join(contentDir, 'scripts');
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.lua'))) {
      const src = readFileSync(join(dir, f), 'utf8');
      for (const m of src.matchAll(/descriptor\s*=\s*"([^"]+)"/g)) {
        npcDescriptors.add(m[1]!);
      }
      for (const m of src.matchAll(/\bcharacter\s*=\s*"([^"]+)"/g)) {
        scriptCharacters.push({ file: f, id: m[1]! });
      }
      // Who this script expects the world to have put somewhere (D-598).
      for (const m of src.matchAll(/\bnpc\(\s*"([^"]+)"\s*\)/g)) {
        scriptNpcs.push({ file: f.replace(/\.lua$/, ''), id: m[1]! });
      }
    }
  } catch {
    // No scripts directory is legal; it just means no scripted NPCs.
  }

  for (const o of objectives) {
    // ⚠ Shared with the authoring tool (D-569). The tool refuses a save that
    // would fail the build, which is only true while both read one function.
    //
    // ⚠ Checked for LIVE objectives ONLY, and that is the whole of why this
    // can be checked at all. D-569 passed `null` here and said why: NPCs are
    // spawned by Lua and by DM events, so a build-time scan is partial, and
    // treating a partial scan as complete would reject every DM-spawned
    // target. That reasoning holds for a draft. It does not hold for a LIVE
    // one: the round engine deals those at random with nobody watching, so a
    // live objective has to be satisfiable out of shipped content or it is
    // simply a way to lose a round.
    //
    // ⚠ This is not hypothetical. `silence-the-keeper` shipped live, naming
    // the keeper of the Hanged Ferryman — who stands in the persistent
    // world's tavern, while `round-town` ran no scripts and did not link
    // there. D-526 calls it the low-cast workhorse. An antagonist dealt it
    // could not win, and nothing said so.
    const refs = { itemIds, npcDescriptors: o.status === 'live' ? npcDescriptors : null };
    for (const problem of objectiveProblems(o, refs)) {
      errors.push(`objective '${o.id}': ${problem}`);
    }
  }
  // A round cannot start without something to give the antagonist. If any
  // objective exists at all, at least one must be live and playable at the
  // minimum cast — otherwise the lobby would fill and never start.
  const coverage = castCoverageProblem(objectives);
  if (coverage) errors.push(coverage);

  // --- Gathering and crafting (MR2) ---------------------------------------
  const nodes: ResourceNodeDef[] = [];
  const nodeIds = new Set<string>();
  for (const file of listJson(join(contentDir, 'nodes'))) {
    checked++;
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      errors.push(`${file}: invalid JSON — ${(err as Error).message}`);
      continue;
    }
    const parsed = ResourceNodeSchema.safeParse(data);
    if (!parsed.success) {
      errors.push(`${file}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
      continue;
    }
    if (nodeIds.has(parsed.data.id)) {
      errors.push(`${file}: duplicate node id '${parsed.data.id}'`);
      continue;
    }
    nodeIds.add(parsed.data.id);
    nodes.push(parsed.data);
  }

  const recipes: RecipeDef[] = [];
  const recipeIds = new Set<string>();
  for (const file of listJson(join(contentDir, 'recipes'))) {
    checked++;
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      errors.push(`${file}: invalid JSON — ${(err as Error).message}`);
      continue;
    }
    const parsed = RecipeSchema.safeParse(data);
    if (!parsed.success) {
      errors.push(`${file}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
      continue;
    }
    if (recipeIds.has(parsed.data.id)) {
      errors.push(`${file}: duplicate recipe id '${parsed.data.id}'`);
      continue;
    }
    recipeIds.add(parsed.data.id);
    recipes.push(parsed.data);
  }

  for (const n of nodes) {
    if (!itemIds.has(n.yields)) {
      errors.push(`node '${n.id}' yields unknown item '${n.yields}'`);
    }
  }
  for (const r of recipes) {
    for (const problem of recipeProblems(r, { itemIds })) {
      errors.push(`recipe '${r.id}' ${problem}`);
    }
  }

  const roamerIds = new Set<string>();
  /** Everything the world's inhabitants carry, for the D-210 graph. */
  /**
   * Every authored character id (D-594) — what a creature may be drawn as.
   *
   * ⚠ The AUTHORED list, not what happens to be built: `client/public/models`
   * is a build output, and validating content against one means a clean
   * checkout fails until somebody runs the character build.
   *
   * ⚠ A PRE-SCAN, and deliberately separate from the characters pass further
   * down, which is the authoritative one (it schema-checks, refuses duplicate
   * ids and checks the slots). This exists only because roamers are validated
   * before characters are read, and reordering the passes to share one set
   * would make the duplicate-id check see these ids already present and
   * report every character in the game as a duplicate of itself.
   */
  const authoredCharacterIds = new Set(
    listJson(join(contentDir, 'characters')).map(
      (f) => (JSON.parse(readFileSync(f, 'utf8')) as { id: string }).id,
    ),
  );

  const roamerLoot: { item: string }[] = [];
  for (const file of listJson(join(contentDir, 'roamers'))) {
    checked++;
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      errors.push(`${file}: invalid JSON — ${(err as Error).message}`);
      continue;
    }
    const parsed = RoamerSchema.safeParse(data);
    if (!parsed.success) {
      errors.push(`${file}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
      continue;
    }
    if (roamerIds.has(parsed.data.id)) {
      errors.push(`${file}: duplicate roamer id '${parsed.data.id}'`);
      continue;
    }
    roamerIds.add(parsed.data.id);
    for (const drop of parsed.data.loot) roamerLoot.push({ item: drop.item });
    for (const problem of roamerProblems(parsed.data, { itemIds, characterIds: authoredCharacterIds })) {
      errors.push(`roamer '${parsed.data.id}' ${problem}`);
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

  // Starting kits (D-547). Read BEFORE the orphan check, because a kit is a
  // CONSUMER: a sword every man-at-arms walks in holding is not an orphan, and
  // hoisting the class load is what lets the graph know that.
  /**
   * A worn item's animation stance comes from the ASSET, not the item (D-566).
   *
   * ⚠ Built here rather than threaded in, because the asset catalogue is not
   * part of the simulation's content — the server loads it only to answer this
   * one question, and CI has to answer it the same way or the two disagree.
   */
  const stanceByAsset = new Map<string, string>();
  for (const file of listJson(join(contentDir, 'assets'))) {
    if (!file.endsWith('.character-item.json')) continue;
    try {
      const parsed = AssetFileSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
      for (const a of parsed.assets) {
        if (a.kind === 'character-item') stanceByAsset.set(`${a.pack}/${a.id}`, a.stance);
      }
    } catch {
      /* the schema pass reports a malformed asset file */
    }
  }
  const stanceOf = (t: { art?: { pack: string; asset: string } }): string | undefined =>
    t.art ? stanceByAsset.get(`${t.art.pack}/${t.art.asset}`) : undefined;

  const kitItems: { item: string }[] = [];
  for (const cls of classes) {
    const usedSlots = new Set<string>();
    for (const entry of cls.startingKit) {
      kitItems.push({ item: entry.item });
      const template = itemsById.get(entry.item);
      if (!template) {
        errors.push(`class '${cls.id}' starting kit names unknown item '${entry.item}'`);
        continue;
      }
      // ⚠ A calling must be able to use its OWN kit (D-566). Handing a magus
      // a breastplate it may not wear is a character who walks in carrying
      // gear it cannot equip — legal data, silently broken play, and exactly
      // the mistake a first pass at gating makes. Checked on every kit entry,
      // equipped or merely carried: being handed a thing you can never use is
      // the same fault either way.
      const barred = itemGateProblem(cls, {
        id: template.id,
        material: template.equip?.material,
        stance: stanceOf(template),
      });
      if (barred) {
        errors.push(
          `class '${cls.id}' starts with '${entry.item}' and ${barred} — `
          + 'widen the gate or change the kit',
        );
      }
      if (!entry.equip) continue;
      // A kit that tries to WEAR something with no slot, or to put a helm on a
      // foot, is a content error. Left unchecked it would present as a
      // character who silently starts holding nothing.
      if (!template.equip) {
        errors.push(
          `class '${cls.id}' starting kit equips '${entry.item}', which is not wearable`,
        );
        continue;
      }
      if (!slotCandidates(template.equip.slot).includes(entry.equip)) {
        errors.push(
          `class '${cls.id}' starting kit puts '${entry.item}' in '${entry.equip}', ` +
          `which is not a slot it fits`,
        );
        continue;
      }
      for (const slot of slotsOccupied(template.equip.slot, entry.equip)) {
        if (usedSlots.has(slot)) {
          errors.push(
            `class '${cls.id}' starting kit fills '${slot}' twice — ` +
            `a two-handed weapon takes the off hand as well`,
          );
        }
        usedSlots.add(slot);
      }
    }
  }

  // INVARIANT 2 (D-210): every item has a consumer. This has been declared
  // since Phase 2 and could not be checked until recipes existed. It can now.
  // ⚠ DERIVED, not listed. `tarnished-signet` used to sit in the exemption
  // list as a literal; it is exempt because an objective steals it, and
  // retargeting that objective would have left the signet exempt for no
  // reason and quietly stopped the orphan check from covering it.
  const objectiveTargets = objectives
    .map((o) => (o.kind.type === 'steal' ? o.kind.itemTemplate : null))
    .filter((v): v is string => v !== null);
  if (recipes.length > 0 || nodes.length > 0) {
    errors.push(
      ...findOrphans({
        items: itemsForGraph,
        recipes: recipes.map((r) => ({ output: r.output, inputs: r.inputs })),
        nodes: nodes.map((n) => ({ yields: n.yields })),
        loot: [...roamerLoot, ...kitItems],
        // Authored into the world by hand or by scenario rather than made:
        // the signet is an objective target, the note and parchment are the
        // writing system's own, and bread is also baked.
        // Authored into the world by hand or by scenario rather than made or
        // worn: the signet is an objective target and the note and parchment
        // belong to the writing system. `rusted-shortsword` used to sit here
        // and no longer needs to — it has a slot and a wearer now.
        otherwiseUsed: [...OTHERWISE_USED, ...objectiveTargets],
      }),
    );
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
  const skills = readArray<SkillDef>('skills', SkillsFileSchema);
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
  // Class progression (D-538). These four rules are the whole reason the
  // table is content rather than code: they make "levels buy access, never
  // raw power" a build failure instead of a good intention.
  const featById = new Map(feats.map((f) => [f.id, f]));
  const spellById = new Map(spells.map((s) => [s.id, s]));
  const creationOnly = new Set(skills.filter((s) => s.creationOnly).map((s) => s.id));
  const grantedFeats = new Set<string>();
  for (const cls of classes) {
    const levels = new Set<number>();
    for (const step of cls.progression) {
      if (levels.has(step.level)) {
        errors.push(`class '${cls.id}': two progression entries for level ${step.level}`);
      }
      levels.add(step.level);
      for (const [id, points] of Object.entries(step.skills)) {
        if (!skillIds.has(id)) {
          errors.push(`class '${cls.id}' level ${step.level}: unknown skill '${id}'`);
        } else if (creationOnly.has(id)) {
          // The fence around raw power (D-538). If this ever fires, the fix
          // is to delete the grant, not to unset creationOnly.
          errors.push(
            `class '${cls.id}' level ${step.level}: '${id}' is creation-only and may not be `
            + 'granted by a level (D-522: levels buy access, never raw power)',
          );
        }
        if (points <= 0) {
          errors.push(`class '${cls.id}' level ${step.level}: '${id}' grants nothing`);
        }
      }
      for (const id of step.feats) {
        const feat = featById.get(id);
        if (!feat) {
          errors.push(`class '${cls.id}' level ${step.level}: unknown feat '${id}'`);
          continue;
        }
        grantedFeats.add(id);
        if (feat.classes.length > 0 && !feat.classes.includes(cls.id)) {
          errors.push(`class '${cls.id}' level ${step.level}: '${id}' is not open to it`);
        }
        if (step.level < feat.minLevel) {
          errors.push(
            `class '${cls.id}' level ${step.level}: '${id}' is a level ${feat.minLevel} feat`,
          );
        }
      }
      for (const id of step.spells) {
        const spell = spellById.get(id);
        if (!spell) {
          errors.push(`class '${cls.id}' level ${step.level}: unknown spell '${id}'`);
        } else if (!cls.spellcasting) {
          errors.push(`class '${cls.id}' level ${step.level}: grants a spell but does not cast`);
        } else if (spell.classes.length > 0 && !spell.classes.includes(cls.id)) {
          errors.push(`class '${cls.id}' level ${step.level}: cannot learn '${id}'`);
        }
      }
    }
  }
  // Invariant 2's principle (D-210) applied to feats: a levelled feat that no
  // class ever grants is unreachable content — nobody can pick it at creation
  // either, so it exists only in the file.
  for (const feat of feats) {
    if (feat.minLevel > 1 && !grantedFeats.has(feat.id)) {
      errors.push(
        `feat '${feat.id}': level ${feat.minLevel} and granted by no class — unreachable`,
      );
    }
  }

  // Every casting class must have something to learn, or its creation step
  // would present an empty list.
  for (const cls of classes.filter((c) => c.spellcasting)) {
    const available = spells.filter((s) => s.classes.length === 0 || s.classes.includes(cls.id));
    if (available.length === 0) errors.push(`class '${cls.id}' casts but has no available spells`);
  }

  // Sound cues (D-541). The check that earns its keep is the LAST one: a cue
  // pointing at a file that is not there is silent in play and looks exactly
  // like a cue nobody wired, so it must fail the build instead.
  // ----------------------------------------------- ground materials (D-585)
  const ground = new Map<string, GroundMaterial>();
  for (const file of listJson(join(contentDir, 'ground'))) {
    checked++;
    const parsed = GroundMaterialSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    if (!parsed.success) {
      errors.push(`${file}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
      continue;
    }
    const mat = parsed.data;
    if (ground.has(mat.id)) errors.push(`${file}: duplicate ground material '${mat.id}'`);
    ground.set(mat.id, mat);
    // ⚠ The same rule a sound cue follows (D-541), for the same reason: a
    // texture that is not on disk renders as the material's flat tint and
    // looks exactly like a material nobody has finished. A material with NO
    // texture is legal and means "just the tint" -- that is the honest state
    // before any art exists, and it is not what this is catching.
    if (mat.texture) {
      const path = join(contentDir, '..', 'client', 'public', 'textures', 'ground', mat.texture);
      if (!existsSync(path)) {
        errors.push(
          `ground material '${mat.id}': missing texture '${mat.texture}' — `
          + 'put it in client/public/textures/ground/',
        );
      }
    }
  }
  // An area may only name painted masks that are on disk. A missing one
  // renders as bare ground and looks exactly like an area nobody painted.
  for (const file of listJson(join(contentDir, 'areas'))) {
    const parsed = AreaSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    if (!parsed.success) continue;
    const paint = parsed.data.groundPaint ?? [];
    for (const name of paint) {
      const path = join(contentDir, '..', 'client', 'public', 'textures', 'painted', name);
      if (!existsSync(path)) {
        errors.push(
          `${file}: paints its ground with '${name}', which is not in `
          + 'client/public/textures/painted/',
        );
      }
    }
    // ⚠ The masks and the material list are ONE fact split across two fields
    // (D-588). A second mask with no materials behind it draws nothing, and
    // six materials with one mask loses the last three silently — the map
    // renders, and half its ground is missing.
    const needed = Math.ceil(parsed.data.groundMaterials.length / GROUND_WEIGHTS_PER_MASK);
    if (paint.length > 0 && paint.length !== needed) {
      errors.push(
        `${file}: has ${paint.length} painted mask(s) but `
        + `${parsed.data.groundMaterials.length} ground material(s), which needs `
        + `${needed} — repaint it in the editor rather than editing this by hand`,
      );
    }
    for (const id of parsed.data.groundMaterials) {
      if (!ground.has(id)) {
        errors.push(`${file}: painted with unknown ground material '${id}'`);
      }
    }
  }

  /**
   * Scenarios: does this round have edges, and can it be won (D-627)?
   *
   * ⚠ Checked HERE, at the end, because it needs the whole area graph and
   * every objective, and those are read in two different passes. The same
   * reason the class gates are checked down here.
   *
   * ⚠ The check that matters is the ENDGAME one. A scenario naming an
   * endgame area is a round where death is permanent, which D-523 forbids in
   * terms -- and before scenarios existed there was no boundary at all, so the
   * live map let a player walk `round-town -> hanged-ferryman -> broken-yard
   * -> sunken-crypt` and out of the round into permadeath entirely.
   */
  const zones = new Map<string, string>();
  const exits = new Map<string, string[]>();
  for (const file of listJson(join(contentDir, 'areas'))) {
    const parsed = AreaSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    if (!parsed.success) continue;
    zones.set(parsed.data.id, parsed.data.zone);
    exits.set(parsed.data.id, parsed.data.transitions.map((t) => t.toArea));
  }
  const scenarioIds = new Set<string>();
  for (const file of listJson(join(contentDir, 'scenarios'))) {
    checked++;
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      errors.push(`${file}: invalid JSON \u2014 ${(err as Error).message}`);
      continue;
    }
    const parsed = ScenarioSchema.safeParse(data);
    if (!parsed.success) {
      errors.push(`${file}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
      continue;
    }
    const sc = parsed.data;
    if (scenarioIds.has(sc.id)) {
      errors.push(`${file}: duplicate scenario id '${sc.id}'`);
      continue;
    }
    scenarioIds.add(sc.id);
    if (!file.replace(/\\/g, '/').endsWith(`/${sc.id}.json`)) {
      errors.push(`${file}: scenario id '${sc.id}' does not match its filename`);
    }
    for (const problem of scenarioProblems(sc, { zones, exits, objectives })) {
      // ⚠ An edge report is a NOTE, not a fault. A door out of the set is
      // legal and expected -- the tavern's west door belongs to the persistent
      // world and is simply shut for the round's duration. What is not
      // acceptable is not knowing where the edges are.
      if (problem.startsWith('NOTE ')) warnings.push(`scenario '${sc.id}' ${problem.slice(5)}`);
      else errors.push(`scenario '${sc.id}' ${problem}`);
    }
  }

  /*
   * Cloth (D-631): a physics file names parts by stem, and the art it names
   * is gitignored — so the check is against the NAMED parts, which is what a
   * person filing a cape has already done.
   */
  for (const file of listJson(join(contentDir, 'cloth'))) {
    checked++;
    const parsed = ClothFileSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    if (!parsed.success) {
      errors.push(`${file}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
      continue;
    }
    const named = new Set<string>();
    for (const pf of listJson(join(contentDir, 'parts'))) {
      const p = PartNamesSchema.safeParse(JSON.parse(readFileSync(pf, 'utf8')));
      if (p.success && p.data.pack === parsed.data.pack) for (const stem of Object.keys(p.data.names)) named.add(stem);
    }
    for (const problem of clothProblems(parsed.data, named.size ? named : null)) {
      errors.push(`${file}: ${problem}`);
    }
  }

  const sounds = readArray<SoundCueDef>('audio', SoundsFileSchema);
  dupes(sounds.map((c) => c.id), 'sound cue');
  const audioRoot = resolve(contentDir, '..', 'client', 'public', 'audio');
  for (const cue of sounds) {
    for (const file of cue.files) {
      const path = join(audioRoot, file);
      if (!existsSync(path)) {
        errors.push(
          `sound cue '${cue.id}': missing file '${file}' — run tools/src/build-audio.py`,
        );
      }
    }
  }
  const ambienceIds = new Set(sounds.filter((c) => c.kind === 'ambience').map((c) => c.id));
  for (const area of parsedAreas.values()) {
    if (area.ambience !== undefined && !ambienceIds.has(area.ambience)) {
      errors.push(`area '${area.id}': unknown ambience cue '${area.ambience}'`);
    }
  }
  // An area with no bed is a decision (silence is allowed), but an area that
  // nobody ever gave one to is almost certainly an oversight — say so without
  // failing, since only the author can tell the difference.
  const silent = [...parsedAreas.values()].filter((a) => a.ambience === undefined);
  if (silent.length > 0) {
    warnings.push(`areas with no ambience: ${silent.map((a) => a.id).join(', ')}`);
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
    // Who this area says stands here (D-598).
    for (const placed of area.npcs ?? []) {
      if (!npcIds.has(placed.type)) {
        errors.push(`area '${area.id}': places an npc '${placed.type}' that is not in content/npcs`);
        continue;
      }
      if (!npcPlacements.has(area.id)) npcPlacements.set(area.id, new Set());
      npcPlacements.get(area.id)!.add(placed.type);
      // ⚠ SOMEWHERE TO STAND, checked with the same rule the game uses. The
      // Ashfold keeper is at the tavern DOOR and not behind a bar precisely
      // because every tile of that tavern's footprint fails this (D-593) — a
      // person placed inside a solid mesh is silently moved to the area's
      // spawn, so the keeper an objective names would be standing somewhere
      // nobody thought to look for him.
      if (!canStandAt(area, { x: placed.x, y: placed.y })) {
        errors.push(
          `area '${area.id}': npc '${placed.type}' at (${placed.x},${placed.y}) `
          + 'has nowhere to stand',
        );
      }
    }
  }

  // ⚠ A script's `npc("<id>")` must be placed in an area that RUNS that
  // script. The handle throws at runtime when it is not, and a script that
  // throws on its first line leaves an area with no keeper and a line in a log
  // nobody is reading — which is the shape of the failure D-593 was about.
  for (const ref of scriptNpcs) {
    const runners = [...parsedAreas.values()].filter((a) => a.scripts.includes(ref.file));
    if (runners.length === 0) {
      errors.push(`scripts/${ref.file}.lua: asks for npc '${ref.id}' but no area runs this script`);
      continue;
    }
    const placed = runners.some((a) => (npcPlacements.get(a.id) ?? new Set()).has(ref.id));
    if (!placed) {
      errors.push(
        `scripts/${ref.file}.lua: asks for npc '${ref.id}', which `
        + `${runners.map((a) => `'${a.id}'`).join(' / ')} does not place`,
      );
    }
  }

  /**
   * Characters authored in the studio (D-558).
   *
   * Schema-checked here rather than only at save time, because a definition
   * can also be hand-edited or arrive in a merge, and the build turns each
   * one into a `.glb`. What CANNOT be checked here is whether the named
   * parts exist: `assets/source/` is somebody else's art and is gitignored,
   * so it is absent in CI. The build does that check, with the pack in front
   * of it, and stops by name.
   *
   * What is checkable without the art is everything that is a decision
   * rather than a file: unique ids, a complete body, and combinations that
   * would build something nobody can see.
   */
  const characterIds = new Set<string>();
  for (const file of listJson(join(contentDir, 'characters'))) {
    checked++;
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      errors.push(`${file}: invalid JSON — ${(err as Error).message}`);
      continue;
    }
    const parsed = CharacterDefSchema.safeParse(data);
    if (!parsed.success) {
      errors.push(`${file}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
      continue;
    }
    const def = parsed.data;
    if (characterIds.has(def.id)) {
      errors.push(`${file}: duplicate character id '${def.id}'`);
      continue;
    }
    characterIds.add(def.id);
    if (!file.replace(/\\/g, '/').endsWith(`/${def.id}.json`)) {
      // The build writes `<id>.glb`, so a file whose name disagrees with its
      // id is a rename waiting to lose track of which is which.
      errors.push(`${file}: character id '${def.id}' does not match its filename`);
    }

    const missing = missingBodySlots(def);
    if (missing.length > 0) {
      errors.push(`character '${def.id}': no part for ${missing.join(', ')}`);
    }

    const chosen: ParsedPart[] = [];
    for (const stem of Object.values(def.parts)) {
      const part = parsePolygonPart(stem);
      if (part) chosen.push(part);
    }
    for (const problem of partProblems(chosen, def.sex)) {
      errors.push(`character '${def.id}': ${problem}`);
    }
  }

  // The literals scraped out of the Lua above, now that there is something to
  // check them against.
  for (const ref of scriptCharacters) {
    if (!characterIds.has(ref.id)) {
      errors.push(
        `scripts/${ref.file}: spawns a character '${ref.id}' that is not in content/characters`,
      );
    }
  }

  /**
   * What a pack's parts are CALLED, and what a player may be (D-560).
   *
   * As with characters, the art itself is absent in CI, so what is checked is
   * the DECISION: that the document parses, that a race is coherent, and that
   * no two races claim one id. Whether the named parts exist is the authoring
   * server's job, with the pack in front of it.
   */
  for (const file of listJson(join(contentDir, 'parts'))) {
    checked++;
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      errors.push(`${file}: invalid JSON — ${(err as Error).message}`);
      continue;
    }
    const parsed = PartNamesSchema.safeParse(data);
    if (!parsed.success) {
      errors.push(`${file}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
      continue;
    }
    if (!file.replace(/\\/g, '/').endsWith(`/${parsed.data.pack}.json`)) {
      errors.push(`${file}: names are for pack '${parsed.data.pack}' but the file is named otherwise`);
    }
    // Two parts sharing a name is not an error in data but it is a defect in
    // a menu: a player choosing between two identical words is not choosing.
    //
    // Only where the two could ever appear in ONE list: same slot, and
    // bodies that overlap. A "Normal" head and "Normal" eyebrows are not
    // ambiguous, and neither is a male "Angry" brow beside a female one —
    // the lists are filtered by body. Warning about those teaches people to
    // ignore the warning that matters.
    // ⚠ Exactly one part may be the hood (D-623). `hoodStem()` scans the
    // tags and returns the FIRST match, so two tagged parts is an
    // ordering-dependent answer -- stable until somebody renames a part, and
    // then the whole cast changes hood with nothing in any log. The creation
    // tool moves the tag rather than adding one; this is the guard for a hand
    // edit and a merge.
    const hooded = Object.entries(parsed.data.tags)
      .filter(([, tags]) => tags.includes('hood'))
      .map(([stem]) => stem);
    if (hooded.length > 1) {
      errors.push(
        `${file}: ${hooded.length} parts are tagged 'hood' (${hooded.join(', ')}) `
        + '— exactly one is the hood D-219 describes, and which one must not '
        + 'depend on key order',
      );
    }
    const named = Object.entries(parsed.data.names).map(([stem, name]) => ({
      stem,
      name,
      part: parsePolygonPart(stem),
    }));
    for (let i = 0; i < named.length; i++) {
      for (let j = i + 1; j < named.length; j++) {
        const a = named[i]!;
        const b = named[j]!;
        if (a.name.toLowerCase() !== b.name.toLowerCase()) continue;
        if (!a.part || !b.part || a.part.slot !== b.part.slot) continue;
        const overlap =
          a.part.sex === b.part.sex || a.part.sex === 'any' || b.part.sex === 'any';
        if (!overlap) continue;
        warnings.push(
          `${file}: '${a.name}' names both ${a.stem} and ${b.stem}, in the same ${a.part.slot} list`,
        );
      }
    }
  }

  const raceIds = new Set<string>();
  for (const file of listJson(join(contentDir, 'races'))) {
    checked++;
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      errors.push(`${file}: invalid JSON — ${(err as Error).message}`);
      continue;
    }
    const parsed = RaceSchema.safeParse(data);
    if (!parsed.success) {
      errors.push(`${file}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
      continue;
    }
    const race = parsed.data;
    if (raceIds.has(race.id)) {
      errors.push(`${file}: duplicate race id '${race.id}'`);
      continue;
    }
    raceIds.add(race.id);
    if (!file.replace(/\\/g, '/').endsWith(`/${race.id}.json`)) {
      errors.push(`${file}: race id '${race.id}' does not match its filename`);
    }
    // `null`: the art is gitignored, so only the half that needs no pack runs.
    const characterIds = new Set(
      listJson(join(contentDir, 'characters')).map((f) => {
        try { return (JSON.parse(readFileSync(f, 'utf8')) as { id?: string }).id ?? ''; } catch { return ''; }
      }),
    );
    for (const problem of raceProblems(race, null, characterIds)) errors.push(`${file}: ${problem}`);
  }

  /**
   * Named assets — worn items, environment, pickups (D-561).
   *
   * Same split as everywhere else: the art is gitignored so whether a mesh
   * exists is the authoring server's job, and what is checked here is the
   * DECISION. Two things sharing a name is the one that matters most: it is
   * legal data and a broken menu.
   */
  for (const file of listJson(join(contentDir, 'assets'))) {
    checked++;
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      errors.push(`${file}: invalid JSON — ${(err as Error).message}`);
      continue;
    }
    const parsed = AssetFileSchema.safeParse(data);
    if (!parsed.success) {
      errors.push(`${file}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
      continue;
    }
    const expected = `/${parsed.data.pack}.${parsed.data.kind}.json`;
    if (!file.replace(/\\/g, '/').endsWith(expected)) {
      errors.push(`${file}: should be named ${parsed.data.pack}.${parsed.data.kind}.json`);
    }
    for (const problem of assetProblems(parsed.data, null)) {
      errors.push(`${file}: ${problem}`);
    }
  }

  /**
   * Placed pack meshes still agree with the asset catalogue (D-566).
   *
   * ⚠ An area bakes the asset's COLLISION MASK in at placement so the server
   * can read one file to know what blocks (D-567). The cost of that is drift:
   * redraw a mask and every map already holding it keeps the old shape. This
   * is what makes drift loud — a wall that quietly became walkable months after
   * somebody edited it is exactly the failure nobody would look for.
   */
  const envCatalogue = new Map<string, { collision: Volume[] }>();
  for (const file of listJson(join(contentDir, 'assets'))) {
    try {
      const parsed = AssetFileSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
      for (const a of parsed.assets) {
        if (a.kind !== 'environment') continue;
        envCatalogue.set(`${a.pack}/${a.id}`, { collision: defaultMask(a) });
      }
    } catch {
      /* the schema pass below reports a malformed asset file */
    }
  }
  for (const [id, area] of parsedAreas) {
    for (const problem of placedAssetDrift(area.assets, envCatalogue)) {
      errors.push(`content/areas/${id}.json: ${problem}`);
    }
  }

  /**
   * Every placed facility is DEFINED (D-530).
   *
   * ⚠ A station's type used to be a four-value enum, so the schema itself
   * refused a typo. It is a content id now, which is what lets a forge or a
   * loom be a JSON file instead of an edit in four TypeScript files — and it
   * means a misspelled station is legal data that places an object nothing can
   * draw or use. This is the check that replaces the enum.
   */
  const stationIds = new Set<string>();
  for (const file of listJson(join(contentDir, 'stations'))) {
    checked++;
    try {
      const def = StationDefSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
      if (stationIds.has(def.id)) errors.push(`${file}: duplicate station id '${def.id}'`);
      stationIds.add(def.id);
    } catch (err) {
      errors.push(`${file}: ${(err as Error).message}`);
    }
  }
  // ⚠ Only once the directory EXISTS. Demanding the core four unconditionally
  // failed every isolated fixture in the test suite — a temp directory holding
  // one objective is not a repository missing its well. The check that matters
  // is that a station somebody placed is defined, and that a real station
  // directory still has the four the rules name.
  if (stationIds.size > 0) {
    for (const core of CORE_STATION_TYPES) {
      if (!stationIds.has(core)) {
        errors.push(
          `content/stations: '${core}' is missing, and server rules name it by id `
          + '— removing it breaks a rule, not a model',
        );
      }
    }
  }
  for (const [id, area] of parsedAreas) {
    for (const st of area.stations) {
      if (!stationIds.has(st.type)) {
        errors.push(
          `content/areas/${id}.json: places station '${st.type}' at (${st.x},${st.y}), `
          + 'which no content/stations file defines',
        );
      }
    }
  }

  /**
   * The companions a lobby can summon (D-624).
   *
   * ⚠ Checked HERE rather than where they are read, because it needs the
   * classes AND the races, which are read in two different passes. A companion
   * naming a calling that no longer exists parses cleanly and fails at the
   * moment somebody presses the button to fill a lobby -- which is the one
   * moment the mode has to work, because it is how a round starts at all
   * (D-607).
   *
   * ⚠ The roster may be EMPTY without being an error. A checkout with no
   * companions authored is a game with no lobby fill, which is a decision
   * somebody might make; the gateway refuses the button out loud rather than
   * pretending. What is an error is a companion that cannot be created.
   */
  const botIds = new Set<string>();
  for (const file of listJson(join(contentDir, 'bots'))) {
    checked++;
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      errors.push(`${file}: invalid JSON \u2014 ${(err as Error).message}`);
      continue;
    }
    const parsed = BotDefSchema.safeParse(data);
    if (!parsed.success) {
      errors.push(`${file}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
      continue;
    }
    const bot = parsed.data;
    if (botIds.has(bot.id)) {
      errors.push(`${file}: duplicate bot id '${bot.id}'`);
      continue;
    }
    botIds.add(bot.id);
    if (!file.replace(/\\/g, '/').endsWith(`/${bot.id}.json`)) {
      errors.push(`${file}: bot id '${bot.id}' does not match its filename`);
    }
    if (bot.classId && !classIds.has(bot.classId)) {
      errors.push(`bot '${bot.id}': unknown calling '${bot.classId}'`);
    }
    if (bot.raceId && !raceIds.has(bot.raceId)) {
      errors.push(`bot '${bot.id}': unknown race '${bot.raceId}'`);
    }
  }

  /**
   * What each calling may wear, wield and be (D-566).
   *
   * ⚠ Checked HERE rather than beside the classes, because it needs the races
   * and they are read further down. A class admitting a race that no longer
   * exists is legal JSON, parses cleanly, and silently offers a calling nobody
   * can take — the failure is at the creation screen, months later.
   */
  for (const cls of classes) {
    for (const problem of classGateProblems(cls, { races: raceIds })) {
      errors.push(`content/classes/${cls.id}.json: ${problem}`);
    }
  }

  /**
   * Animation sets (D-564).
   *
   * The built clips are not in CI — `client/public/models/animations.glb` is a
   * build product and `assets/` is gitignored — so what is checked is the
   * DECISION again: that a set parses, that its id is unique and matches its
   * filename, and that what it applies to means something for its layer.
   *
   * The one check that is more than schema is the last: RESOLVE every set
   * together and make sure the result has an idle and a walk (D-561). A
   * complete-looking pile of stance sets with no rig set beneath them is legal
   * data, parses cleanly, and renders a statue that slides.
   */
  const animationSets: AnimationSet[] = [];
  const setIds = new Set<string>();
  for (const file of listJson(join(contentDir, 'animations'))) {
    checked++;
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      errors.push(`${file}: invalid JSON — ${(err as Error).message}`);
      continue;
    }
    const parsed = AnimationSetSchema.safeParse(data);
    if (!parsed.success) {
      errors.push(`${file}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
      continue;
    }
    const set = parsed.data;
    if (setIds.has(set.id)) {
      errors.push(`${file}: duplicate animation set id '${set.id}'`);
      continue;
    }
    setIds.add(set.id);
    if (!file.replace(/\\/g, '/').endsWith(`/${set.id}.json`)) {
      errors.push(`${file}: set id '${set.id}' does not match its filename`);
    }
    // `null`: the clips are a build product and are not here.
    for (const problem of animationSetProblems(set, null)) errors.push(`${file}: ${problem}`);
    animationSets.push(set);
  }
  if (animationSets.length > 0) {
    const missing = missingActions(resolveAnimations(animationSets));
    if (missing.length) {
      errors.push(
        `content/animations: nothing anywhere provides ${missing.join(' or ')} — ` +
          'a character with neither an idle nor a walk is a statue that slides',
      );
    }
  }

  if (checked === 0) errors.push(`no content files found under ${contentDir}`);
  return { errors, warnings, checked };
}

// CLI entry: `npm run validate:content [dir]`
const isCli = process.argv[1]?.replace(/\\/g, '/').endsWith('tools/src/validate-content.ts');
if (isCli) {
  const dir = resolve(process.argv[2] ?? 'content');
  const { errors, warnings, checked } = validateContent(dir);
  for (const w of warnings) console.warn(`  ! ${w}`);
  if (errors.length > 0) {
    console.error(`content INVALID (${checked} file(s) checked):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(`content OK — ${checked} file(s) validated in ${dir}`);
}
