import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DIRECTIONS, Rng } from '@rc/shared';
import { loadContent } from '@rc/server/content';
import { World, hashWorld } from '@rc/server/game/world';

/**
 * The deterministic harness (D-114): the same seed and intent script must
 * produce bit-identical world state, headlessly, with no server running.
 * This is what makes any reported bug reproducible from a seed.
 */

const contentDir = fileURLToPath(new URL('../../content', import.meta.url));
const areaDef = loadContent(contentDir).areas.get('broken-yard')!;

function scriptedRun(seed: number, ticks: number): string[] {
  const world = new World();
  world.addArea(areaDef);
  const rng = new Rng(seed);
  const ids: number[] = [];
  for (let i = 0; i < 4; i++) {
    ids.push(world.spawn('broken-yard', `char-${i}`, 'Scripted Bot', { x: 2 + i, y: 2 }).entity.id);
  }
  const hashes: string[] = [];
  for (let t = 1; t <= ticks; t++) {
    for (const id of ids) {
      if (rng.float() < 0.6) world.setMoveIntent(id, rng.pick(DIRECTIONS));
    }
    world.step();
    if (t % 100 === 0) hashes.push(hashWorld(world));
  }
  return hashes;
}

describe('deterministic simulation harness', () => {
  it('same seed, same script → identical state hashes at every checkpoint', () => {
    const a = scriptedRun(0xdecafbad, 600);
    const b = scriptedRun(0xdecafbad, 600);
    expect(a).toEqual(b);
    expect(a).toHaveLength(6);
  });

  it('a different seed diverges', () => {
    expect(scriptedRun(1, 600)).not.toEqual(scriptedRun(2, 600));
  });

  it('entities remain on walkable tiles for the whole run', () => {
    const world = new World();
    world.addArea(areaDef);
    const rng = new Rng('walkability-sweep');
    const ids = [1, 2, 3, 4].map(
      (i) => world.spawn('broken-yard', `c${i}`, 'Sweeper Bot', { x: 2, y: 2 + i }).entity.id,
    );
    const walkable = (x: number, y: number) => {
      const ch = areaDef.tiles[y]?.[x];
      return ch !== undefined && areaDef.legend[ch]!.walkable;
    };
    for (let t = 0; t < 2000; t++) {
      for (const id of ids) world.setMoveIntent(id, rng.pick(DIRECTIONS));
      world.step();
      for (const id of ids) {
        const e = world.getEntity(id)!;
        expect(walkable(e.pos.x, e.pos.y), `entity ${id} at (${e.pos.x},${e.pos.y}) tick ${t}`).toBe(true);
      }
    }
  });
});
