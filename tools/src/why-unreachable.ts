/**
 * Name the assets that seal a tile off (D-591).
 *
 * ⚠ Exists because the reachability rule lives in TypeScript
 * (`canOccupy`/`canStandAt`, sweeping a body of `BODY_RADIUS` against real
 * shapes) and the town is placed by a Python script, so the placer's guard can
 * only ever approximate it. The approximation catches gross pockets; it passed
 * five tiles pinched between a tree and a fence that the build then refused,
 * and "5 walkable tiles unreachable, e.g. (7,14)" is not an answer you can act
 * on. This turns a coordinate into a list of things standing near it.
 *
 *     npx tsx tools/src/why-unreachable.ts round-town
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AreaSchema } from '@rc/shared';
import { unreachableTiles } from './validate-content';

const id = process.argv[2] ?? 'round-town';
const file = join(process.cwd(), 'content', 'areas', `${id}.json`);
const area = AreaSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
// ⚠ The BUILD'S OWN function, imported rather than re-implemented. The first
// cut of this file wrote its own flood — tile centres, four directions — and
// cheerfully reported that every tile was reachable while `validate:content`
// refused the same map. A diagnostic that disagrees with the thing it is
// diagnosing is worse than none.
const cut = unreachableTiles(area);
if (cut.length === 0) {
  console.log(`${id}: every walkable tile is reachable from the spawn`);
} else {
  console.log(`${id}: ${cut.length} walkable tile(s) unreachable from the spawn
`);
  for (const t of cut) {
    const near = area.assets
      .filter((a) => a.collision.length > 0 && Math.hypot(a.x - t.x, a.y - t.y) < 3.5)
      .sort((a, b) => Math.hypot(a.x - t.x, a.y - t.y) - Math.hypot(b.x - t.x, b.y - t.y))
      .map((a) => `${a.asset} @ ${a.x.toFixed(1)},${a.y.toFixed(1)}`);
    console.log(`  (${t.x},${t.y})  penned in by: ${near.slice(0, 5).join(' | ') || '(nothing within 3.5m)'}`);
  }
}
