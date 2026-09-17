/**
 * The production line's dependency map (D-630).
 *
 * A change under `content/` reaches the running game by one of a few routes,
 * and until now which one was written down nowhere but `SYSTEM_INVENTORY.md`.
 * This is that knowledge as data, read by the authoring tool (to say what a
 * save still needs), by its Publish action (to run only the builds a save
 * invalidated), and by CI (to refuse a content type nothing reads).
 *
 * ⚠ Every content directory MUST appear here. A type with no entry is a type
 * whose route to the game nobody has stated, and the test in `shared/test`
 * lists `content/` and fails on the omission — D-210's principle applied to
 * the pipeline itself: authored implies reachable.
 */

/** A build the tool can run. Each is an npm script. */
export type BuildStep = 'characters' | 'environment';

/**
 * How a change reaches the RUNNING server.
 *
 * - `hot`: the server re-reads the directory and swaps it in place. The next
 *   verb that looks up a definition sees the new one.
 * - `warm`: re-read, but applied at the next round reset, because the live
 *   world was instantiated from it (areas are worlds full of entities, not
 *   lookups).
 * - `restart`: the process must be restarted. Scripts are loaded into the Lua
 *   host at boot and there is no unload.
 * - `client`: the server never reads it; the client loads it as presentation
 *   over the wire (D-630) or from a baked artefact.
 */
export type ReloadTier = 'hot' | 'warm' | 'restart' | 'client';

export interface ContentRoute {
  /** The directory under `content/`. */
  dir: string;
  tier: ReloadTier;
  /** Builds a save under this directory invalidates, in order. */
  builds: readonly BuildStep[];
  /** What reads it at runtime — one line, so the map is also the inventory. */
  reader: string;
}

export const CONTENT_ROUTES: readonly ContentRoute[] = [
  { dir: 'animations', tier: 'hot', builds: [], reader: 'server loads; client via render_content' },
  { dir: 'areas', tier: 'warm', builds: ['environment'], reader: 'server world; client draws placed meshes' },
  { dir: 'assets', tier: 'hot', builds: ['environment'], reader: 'server worn assets; client grips via render_content' },
  { dir: 'audio', tier: 'hot', builds: [], reader: 'server cues; client sound bank is a build-time import (the menu plays before a connection exists)' },
  { dir: 'bots', tier: 'hot', builds: [], reader: 'server bot stable' },
  { dir: 'characters', tier: 'hot', builds: ['characters'], reader: 'server looks; client baked .glb' },
  { dir: 'classes', tier: 'hot', builds: [], reader: 'server creation + progression' },
  { dir: 'cloth', tier: 'hot', builds: [], reader: 'server loads; client cloth via render_content' },
  { dir: 'emotes', tier: 'hot', builds: [], reader: 'server emote parser' },
  { dir: 'feats', tier: 'hot', builds: [], reader: 'server creation + progression' },
  { dir: 'garments', tier: 'client', builds: ['characters'], reader: 'client baked manifest' },
  { dir: 'ground', tier: 'hot', builds: [], reader: 'server ground; client via render_content' },
  { dir: 'items', tier: 'hot', builds: [], reader: 'server item templates' },
  { dir: 'languages', tier: 'hot', builds: [], reader: 'server language scrambler' },
  { dir: 'nodes', tier: 'hot', builds: ['environment'], reader: 'server resource nodes' },
  { dir: 'npcs', tier: 'hot', builds: ['environment'], reader: 'server declared cast' },
  { dir: 'objectives', tier: 'hot', builds: [], reader: 'server round engine' },
  { dir: 'parts', tier: 'hot', builds: [], reader: 'server part names; client hood via render_content' },
  { dir: 'races', tier: 'hot', builds: ['characters'], reader: 'server creation gate' },
  { dir: 'recipes', tier: 'hot', builds: [], reader: 'server crafting' },
  { dir: 'roamers', tier: 'hot', builds: [], reader: 'server roamer spawns' },
  { dir: 'scenarios', tier: 'hot', builds: [], reader: 'server round boundary' },
  { dir: 'scripts', tier: 'restart', builds: [], reader: 'server Lua host at boot' },
  { dir: 'skills', tier: 'hot', builds: [], reader: 'server creation + progression' },
  { dir: 'spells', tier: 'hot', builds: [], reader: 'server creation + progression' },
  { dir: 'stations', tier: 'hot', builds: ['environment'], reader: 'server facilities' },
];

export function routeFor(dir: string): ContentRoute | undefined {
  return CONTENT_ROUTES.find((r) => r.dir === dir);
}

/** The builds a set of saved directories needs, deduplicated, in build order. */
export function buildsFor(dirs: Iterable<string>): BuildStep[] {
  const wanted = new Set<BuildStep>();
  for (const dir of dirs) for (const b of routeFor(dir)?.builds ?? []) wanted.add(b);
  const order: BuildStep[] = ['characters', 'environment'];
  return order.filter((b) => wanted.has(b));
}

/** The strictest tier among the saved directories: what the server must do. */
export function reloadTierFor(dirs: Iterable<string>): ReloadTier {
  const rank: Record<ReloadTier, number> = { client: 0, hot: 1, warm: 2, restart: 3 };
  let worst: ReloadTier = 'client';
  for (const dir of dirs) {
    const tier = routeFor(dir)?.tier ?? 'restart';
    if (rank[tier] > rank[worst]) worst = tier;
  }
  return worst;
}
