import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { STAGE_IDS, overview } from '../src/overview';

/**
 * The stage report says what is UNBUILT (D-629).
 *
 * ⚠ The finding it exists for: a definition that reaches the game through a
 * baked artefact and was never baked validates, floods and draws nothing.
 * Three of the taproom's four meshes did exactly that for a whole session
 * (D-625). A report that only counted files would have called that stage
 * finished.
 */

const realContent = fileURLToPath(new URL('../../content', import.meta.url));
const realRoot = fileURLToPath(new URL('../..', import.meta.url));

function json(dir: string, file: string, body: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), JSON.stringify(body));
}

/** A tiny tree: one of everything that can be unbuilt, and nothing built. */
function unbuiltTree(): { content: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'rc-overview-'));
  const content = join(root, 'content');
  // A REAL definition with a new id, so the fixture cannot drift from the
  // schema and silently test "an invalid character is not reported".
  const real = JSON.parse(
    readFileSync(join(realContent, 'characters', 'ashfold-townsfolk.json'), 'utf8'),
  ) as { id: string };
  json(join(content, 'characters'), 'ghost.json', { ...real, id: 'ghost' });
  json(join(content, 'animations'), 'walk.json', {
    id: 'walk', name: 'Walk', layer: 'rig', applies: 'unreal', clips: { idle: 'no-such-clip', walk: 'walking' },
  });
  json(join(content, 'garments'), 'coat.json', {
    id: 'coat', name: 'Coat', pack: 'p',
    parts: { male: { torso: 'Tm' }, female: { torso: 'Tf' } }, swaps: [],
  });
  json(join(content, 'areas'), 'yard.json', {
    id: 'yard', name: 'Yard', width: 8, height: 8, legend: { '.': { walkable: true, kind: 'floor' } },
    tiles: Array.from({ length: 8 }, () => '........'), spawn: { x: 1, y: 1 }, zone: 'wilderness',
    assets: [{ asset: 'sm-thing', pack: 'p', x: 2, y: 2, z: 0, rotation: 0, scale: 1 }],
  });
  // A build that produced ONE clip and no characters: enough for the motion
  // check to know what "built" means, and nothing else made.
  json(join(root, 'client', 'public', 'models'), 'manifest.json', {
    animations: 'animations.glb', clips: ['walking'], outfits: [], garments: [],
  });
  return { content, root };
}

const tree = unbuiltTree();
afterAll(() => rmSync(tree.root, { recursive: true, force: true }));

describe('the stage overview', () => {
  it('reports every stage of the production line, over the real tree', () => {
    const rep = overview(realContent, realRoot);
    for (const id of STAGE_IDS) {
      expect(rep[id], id).toBeDefined();
      expect(rep[id].notes.length, `${id} says what it has`).toBeGreaterThan(0);
    }
    // The shipped tree is built: a warning here is either a real gap or a
    // false alarm, and both are worth a look rather than a green tick.
    expect(rep.scenario.count).toBeGreaterThan(0);
  });

  it('⚠ names what is authored and not built, stage by stage', () => {
    const rep = overview(tree.content, tree.root);
    expect(rep.bodies.warnings.join('\n')).toMatch(/not built.*ghost/);
    expect(rep.motion.warnings.join('\n')).toMatch(/walk names unbuilt clips.*no-such-clip/);
    expect(rep.things.warnings.join('\n')).toMatch(/garment coat has 2 unbuilt part/);
    expect(rep.world.warnings.join('\n')).toMatch(/yard places 1 unbuilt mesh.*p\/sm-thing/);
  });

  it('⚠ says when the round has no edges and no way to start', () => {
    const rep = overview(tree.content, tree.root);
    expect(rep.scenario.warnings.join('\n')).toMatch(/no live scenario/);
    expect(rep.rules.warnings.join('\n')).toMatch(/no live objective/);
  });

  it('does not cry unbuilt about a clip that IS built', () => {
    // `walking` is in the fixture's manifest; only `no-such-clip` is named.
    const rep = overview(tree.content, tree.root);
    expect(rep.motion.warnings.filter((w) => w.includes('walking'))).toHaveLength(0);
  });
});
