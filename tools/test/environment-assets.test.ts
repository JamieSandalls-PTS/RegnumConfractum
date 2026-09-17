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

  it('knows how TALL every solid thing is', () => {
    // ⚠ The one number `defaultMask` cannot guess. Without `size` it falls
    // back to a flat 3m, so a barrel and a gatehouse were the same height to
    // walk into and the field the schema says decides whether a thing is
    // walked over, under or into was a constant. Measured before this was
    // fixed: 1,402 catalogued assets, 0 carrying a size.
    //
    // ⚠ Asserted on SOLID assets only. A floor tile's height changes
    // nothing, because `defaultMask` returns no volumes at all for something
    // that is not solid.
    const guessing = assets.filter((a) => a.solid && a.size === undefined).map((a) => a.mesh);
    expect(guessing).toEqual([]);
  });

  it('gives a solid thing a height a body could actually meet', () => {
    // A zero-height solid is a contradiction: `defaultMask` would bake a box
    // with top 0, which blocks nothing, and the asset would be a ghost that
    // the reachability flood still counts as scenery.
    const flat = assets
      .filter((a) => a.solid && a.size !== undefined && a.size[1] <= 0)
      .map((a) => `${a.mesh} ${a.size![1]}m`);
    expect(flat).toEqual([]);
  });

  it('measures heights to the millimetre, not to seventeen digits', () => {
    // ⚠ Rounding is not cosmetic here: an unrounded float makes every
    // re-run of `name:environment` a diff against itself, and a diff that is
    // always dirty is one nobody reads.
    const noisy = assets
      .filter((a) => a.size !== undefined
        && a.size.some((n) => Math.abs(n * 1000 - Math.round(n * 1000)) > 1e-6))
      .map((a) => a.mesh);
    expect(noisy).toEqual([]);
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

/**
 * ⚠ Every mesh an AREA places is actually built (D-625).
 *
 * This is the same check `held-weapons` makes for what a character holds, and
 * its absence is why the Hanged Ferryman was an empty room. `build:environment`
 * ships only what the world references, so changing which mesh a map places and
 * not re-running it leaves the map pointing at art that does not exist — and
 * the client's response is one `console.warn` and an object that is simply not
 * drawn. Three of the tavern's four meshes were in that state: the walls, the
 * tables and the fireplace. The taproom rendered as bare boards with chairs
 * standing on them, nothing threw, nothing failed, and the area file looked
 * completely correct.
 */
describe('the client is given the meshes the world places', () => {
  const manifestPath = join(root, 'client', 'public', 'models', 'env', 'manifest.json');
  const areasDir = join(root, 'content', 'areas');

  it('builds a mesh for every asset every area places', () => {
    if (!existsSync(manifestPath) || !existsSync(areasDir)) return;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      meshes: Record<string, string>;
    };
    const missing = new Map<string, string[]>();
    for (const file of readdirSync(areasDir).filter((f) => f.endsWith('.json'))) {
      const area = JSON.parse(readFileSync(join(areasDir, file), 'utf8')) as {
        id: string;
        assets?: { pack: string; asset: string }[];
      };
      for (const a of area.assets ?? []) {
        const key = `${a.pack}/${a.asset}`;
        if (manifest.meshes[key]) continue;
        const where = missing.get(key) ?? [];
        if (!where.includes(area.id)) where.push(area.id);
        missing.set(key, where);
      }
    }
    // ⚠ Named, with the areas that place them, because the fix is to run
    // `npm run build:environment` and the useful half of the message is which
    // map is about to render with holes in it.
    expect(
      [...missing].map(([key, areas]) => `${key} — placed by ${areas.join(', ')}`),
      'run `npm run build:environment`',
    ).toEqual([]);
  });
});

/**
 * ⚠ A mesh with no back is placed BACK TO BACK (D-626).
 *
 * `sm-env-basement-wallpanel-01` is an open shell: measured off the built
 * `.glb`, 94 of its 208 triangles face +z and **none** face -z. It is a plank
 * face with two end caps and a top and bottom, and nothing behind it. glTF
 * materials default to `doubleSided: false`, so the renderer culls what is not
 * modelled and you look straight through the tavern wall from outside — which
 * is what the stakeholder saw and reported as "the walls only have textures on
 * one side".
 *
 * The fix is a second placement turned half a turn, so the wall is planked on
 * both faces. This asserts the pairing, because the builder emits it in a loop
 * and a loop is one edit away from emitting half of it.
 *
 * ⚠ To re-measure, or to check a mesh this list does not name: bucket a
 * built glb's triangle normals by dominant axis and look for a direction with
 * a count of zero. Every other mesh the taproom places — hearth, table, stool,
 * barrel, candles — came back as a closed solid.
 */
describe('a one-sided mesh is placed twice, facing both ways', () => {
  const ONE_SIDED = new Set(['sm-env-basement-wallpanel-01']);
  const areasDir = join(root, 'content', 'areas');

  it('pairs every placement of a mesh that has no back', () => {
    if (!existsSync(areasDir)) return;
    const problems: string[] = [];
    for (const file of readdirSync(areasDir).filter((f) => f.endsWith('.json'))) {
      const area = JSON.parse(readFileSync(join(areasDir, file), 'utf8')) as {
        id: string;
        assets?: { asset: string; x: number; y: number; rotation: number; collision?: unknown[] }[];
      };
      const bySpot = new Map<string, typeof area.assets>();
      for (const a of area.assets ?? []) {
        if (!ONE_SIDED.has(a.asset)) continue;
        const key = `${a.asset}@${a.x},${a.y}`;
        const at = bySpot.get(key) ?? [];
        at.push(a);
        bySpot.set(key, at);
      }
      for (const [key, at] of bySpot) {
        const where = `${area.id} ${key}`;
        if (at!.length !== 2) {
          problems.push(`${where}: ${at!.length} placement(s), expected a back-to-back pair`);
          continue;
        }
        const [a, b] = at!;
        const turn = Math.abs(a!.rotation - b!.rotation) % 360;
        if (turn !== 180) {
          problems.push(`${where}: the pair is ${turn}° apart, not a half turn — one face is doubled and the other is still missing`);
        }
        // ⚠ Exactly ONE mask between them. The wall is one obstacle however
        // many times it is drawn, and duplicating it doubles the volumes the
        // pathfinder sweeps for no gain.
        const masks = at!.filter((p) => (p!.collision ?? []).length > 0).length;
        if (masks !== 1) {
          problems.push(`${where}: ${masks} of the pair carry collision, expected exactly 1`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
