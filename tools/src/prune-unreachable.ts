/**
 * Remove SCATTER until every walkable tile is reachable again (D-592).
 *
 *     npx tsx tools/src/prune-unreachable.ts round-farm round-wood ...
 *     npx tsx tools/src/prune-unreachable.ts --all
 *
 * ⚠ This exists because the guard and the authority cannot be the same code.
 * The dressing script is Python and the reachability rule is TypeScript
 * (`unreachableTiles`, sweeping a body through a navigation index finer than
 * the tile grid), so the placer can only ever approximate it — it grows each
 * blocker by `BODY_RADIUS` and floods tile centres, which catches gross
 * pockets and passed eight areas the build then refused. Four rounds of
 * tightening the approximation on Ashfold's copses (D-591) did not close the
 * gap and is not going to.
 *
 * So the authority gets the last word: place generously, then let the real
 * check delete what it objects to.
 *
 * ⚠ It removes ONLY placements marked `dressed` — scatter a tool owns. A gate,
 * a wall, a market stall or anything a person put down is never touched, and
 * an area whose pocket is made of hand-placed things is reported rather than
 * quietly taken apart.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { AreaSchema, type AreaDef, type PlacedAsset } from '@rc/shared';
import { unreachableTiles } from './validate-content';

const AREAS = join(process.cwd(), 'content', 'areas');

/** A placement that remembers where it was in the file it came from. */
type Placed = AreaDef['assets'][number] & { at: number };

/**
 * The dressed solid nearest a tile, which is the thing most likely to pen it.
 *
 * ⚠ Returns the asset's index in the ORIGINAL file, carried on `at`, not its
 * position in whatever list is being flooded this round. The first cut
 * returned the live index and recorded it against the original array: from the
 * second round onwards it deleted a different asset from the one it had
 * blamed, and the only symptom was one tile still unreachable on the one map
 * that needed two rounds.
 */
function culprit(assets: Placed[], t: { x: number; y: number }): number {
  let best = -1;
  let bestD = Infinity;
  for (const a of assets) {
    if (!a.dressed || a.collision.length === 0) continue;
    const d = Math.hypot(a.x - t.x, a.y - t.y);
    if (d < bestD) {
      bestD = d;
      best = a.at;
    }
  }
  return best;
}

function prune(id: string): void {
  const file = join(AREAS, `${id}.json`);
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { assets?: PlacedAsset[] };
  let area = AreaSchema.parse(raw);
  if (area.assets.every((a) => !a.dressed)) {
    const cut = unreachableTiles(area);
    console.log(`  ${id.padEnd(17)} nothing dressed here`
      + (cut.length ? ` — ⚠ ${cut.length} tile(s) still unreachable` : ''));
    return;
  }

  const dropped = new Set<number>();
  let live: Placed[] = area.assets.map((a, at) => ({ ...a, at }));
  let rounds = 0;
  for (;;) {
    const cut = unreachableTiles(area);
    if (cut.length === 0) break;
    rounds++;
    // ⚠ One pass removes the nearest dressed solid to EVERY unreachable tile,
    // not one and then re-flood: a pocket is usually made of two or three
    // things, and re-flooding after each removal on a 100x100 map is a flood
    // per prop. The loop still re-checks, so nothing is assumed.
    const kill = new Set<number>();
    for (const t of cut) {
      const i = culprit(live, t);
      if (i >= 0) kill.add(i);
    }
    if (kill.size === 0) {
      console.log(`  ${id.padEnd(17)} ⚠ ${cut.length} tile(s) unreachable and NOTHING`
        + ' dressed is near them — this is hand-placed geometry, left alone');
      break;
    }
    for (const i of kill) dropped.add(i);
    live = live.filter((a) => !dropped.has(a.at));
    area = { ...area, assets: live.map(({ at: _at, ...a }) => a) };
    if (rounds > 40) {
      console.log(`  ${id.padEnd(17)} ⚠ gave up after ${rounds} rounds`);
      break;
    }
  }

  if (dropped.size === 0) {
    console.log(`  ${id.padEnd(17)} clean, nothing removed`);
    return;
  }
  // ⚠ Written back by INDEX against the raw file, not from the parsed area:
  // zod fills defaults and reorders keys, so writing the parsed document back
  // would rewrite every placement in the map as a side effect of deleting six.
  const kept = (raw.assets ?? []).filter((_, i) => !dropped.has(i));
  raw.assets = kept;
  writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  console.log(`  ${id.padEnd(17)} removed ${dropped.size} scattered thing(s)`
    + ` in ${rounds} round(s) — ${kept.length} left`);
}

const argv = process.argv.slice(2);
const ids = argv.includes('--all')
  ? readdirSync(AREAS).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5))
  : argv;
for (const id of ids) prune(id);
