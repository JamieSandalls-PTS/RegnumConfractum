import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AssetFileSchema, type EnvironmentAsset } from '@rc/shared';
import { SIGHT_HEIGHT, classify, unitScale } from '../src/name-environment';

/**
 * What blocks a body, what blocks an eye, and how much room it takes (D-566).
 *
 * ⚠ `solid` and `opaque` are the two fields in this whole schema that change
 * the SIMULATION rather than the picture. Reachability is flooded in CI over
 * `solid` (D-542) — a barrel in the only doorway fails the build — and line of
 * sight over `opaque` is what makes a witness (D-217). A classifier that gets
 * either wrong does not look wrong: the map still renders, and a murder behind
 * a fence is simply seen or not seen by the wrong people.
 */

const root = fileURLToPath(new URL('../..', import.meta.url));
const assetsDir = join(root, 'content', 'assets');

function authored(): EnvironmentAsset[] {
  if (!existsSync(assetsDir)) return [];
  return readdirSync(assetsDir)
    .filter((f) => f.endsWith('.environment.json'))
    .flatMap((f) => AssetFileSchema.parse(JSON.parse(readFileSync(join(assetsDir, f), 'utf8'))).assets)
    .filter((a): a is EnvironmentAsset => a.kind === 'environment');
}

describe('classifying an environment mesh', () => {
  it('makes a wall stop both a body and an eye', () => {
    const wall = classify('SM_Bld_Wall_01', [1, 3, 0.4]);
    expect(wall.solid).toBe(true);
    expect(wall.opaque).toBe(true);
  });

  it('makes a fence stop a body and NOT an eye', () => {
    // ⚠ The case D-545 nearly shipped backwards: every new wall material would
    // have been see-through because opacity tested `kind === 'wall'`.
    const fence = classify('SM_Env_Fence_01', [3, 1.4, 0.2]);
    expect(fence.solid).toBe(true);
    expect(fence.opaque).toBe(false);
    const rail = classify('SM_Env_Railing_02', [5, 1.3, 0.2]);
    expect(rail.opaque).toBe(false);
  });

  it('lets a path be walked over and seen past', () => {
    const path = classify('SM_Env_Path_01', [4, 0.02, 4]);
    expect(path.solid).toBe(false);
    expect(path.opaque).toBe(false);
  });

  it('does not let anything knee-high block sight, whatever it is called', () => {
    // A "wall" 40cm tall is a garden border. Name alone would call it opaque.
    const low = classify('SM_Env_Mushroom_Wall_02', [1, 0.4, 1]);
    expect(low.opaque).toBe(false);
    expect(classify('SM_Env_Anything_01', [1, SIGHT_HEIGHT - 0.01, 1]).opaque).toBe(false);
    expect(classify('SM_Env_Anything_01', [1, SIGHT_HEIGHT + 0.01, 1]).opaque).toBe(true);
  });

  it('keeps a door solid even though it opens', () => {
    const door = classify('SM_Env_Door_01', [1, 2.2, 0.2]);
    expect(door.operable).toBe(true);
    // ⚠ An operable thing that defaulted to walkable would let anybody stroll
    // through a shut door — the state is the server's business, the geometry
    // still blocks.
    expect(door.solid).toBe(true);
  });

  it('measures a footprint in whole tiles, never zero', () => {
    expect(classify('x', [3.2, 2, 1.1]).footprint).toEqual([3, 1]);
    // A 20cm bottle still occupies the tile it stands on.
    expect(classify('SM_Prop_Bottle_01', [0.2, 0.3, 0.2]).footprint).toEqual([1, 1]);
  });

  it('reads a pack’s units from the middle of it, not the extremes', () => {
    expect(unitScale([1.2, 0.8, 2.4])).toBe(1); // metres
    expect(unitScale([80, 120, 240])).toBe(0.01); // centimetres
    // ⚠ One enormous castle piece must not decide it for six hundred props.
    expect(unitScale([1.2, 0.8, 2.4, 900])).toBe(1);
  });
});

describe.skipIf(authored().length === 0)('the authored environment', () => {
  const assets = authored();

  it('classified the whole library', () => {
    expect(assets.length).toBeGreaterThan(1000);
  });

  it('never claims a thing blocks sight but not movement', () => {
    // You cannot see through it but you can walk through it: that combination
    // has no physical reading and would let a player stand inside a wall.
    const impossible = assets
      .filter((a) => a.opaque && !a.solid)
      .map((a) => a.mesh);
    expect(impossible).toEqual([]);
  });

  it('gives every asset a footprint of at least one tile', () => {
    const bad = assets
      .filter((a) => a.footprint[0] < 1 || a.footprint[1] < 1)
      .map((a) => `${a.mesh} ${a.footprint.join('x')}`);
    expect(bad).toEqual([]);
  });

  it('keeps some of the library walkable', () => {
    // A pack where everything is solid is a pack nobody can build a room out
    // of — the floors and paths have to survive the classifier.
    const walkable = assets.filter((a) => !a.solid).length;
    expect(walkable / assets.length).toBeGreaterThan(0.05);
  });

  it('names everything exactly once per pack', () => {
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const a of assets) {
      const key = `${a.pack}/${a.name.toLowerCase()}`;
      if (seen.has(key)) clashes.push(`${a.name} (${a.mesh} and ${seen.get(key)})`);
      seen.set(key, a.mesh);
    }
    expect(clashes).toEqual([]);
  });
});
