import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CharacterDefSchema, meshShelf } from '@rc/shared';
import { allPacks, allMeshStems } from '../src/packs';

/**
 * Enemies can be authored from the creation tool (D-613).
 *
 * ⚠ Reported as "there is no proper way to create enemies in the character
 * creator; the Goblin meshes do not show up in that tool". Every piece was
 * already in place except the one that lets a person see it:
 *
 *   - `CharacterDefSchema.mesh` has said "this is how enemies get in" since
 *     D-594, and it is what `goblin.json` and the skeletons already use;
 *   - `meshShelf` has classified whole rigged bodies as `'character'` since
 *     D-595, and is TOTAL by construction so nothing can fall out of it;
 *   - the studio server has validated and written these definitions all along.
 *
 * The creation tool simply had no tab for that shelf, so seventeen finished
 * people sat in the packs where nobody could reach them. The classifier was
 * right; the menu was one entry short.
 */

const packs = allPacks();
const toolSrc = readFileSync(
  fileURLToPath(new URL('../../client/src/creation-tool.ts', import.meta.url)),
  'utf8',
);

describe('the tool has somewhere to put a whole body', () => {
  it('⚠ offers an Enemies tab, and points it at the character shelf', () => {
    // ⚠ Both halves. A tab whose shelf name does not exist matches no meshes
    // and renders an empty list — which is indistinguishable from a pack that
    // genuinely ships no bodies, and is exactly how this would regress.
    // The tab bar is a REGISTRY since D-629 (the seven-stage production
    // line), so the tab is asserted where it is declared, on the Bodies stage.
    expect(toolSrc).toMatch(/core\('enemies', 'Enemies'\)/);
    expect(toolSrc).toMatch(/tab === 'enemies'\) return 'character'/);
  });

  it('writes a definition the schema accepts, with no parts', () => {
    // What the tab builds for a newly named mesh. ⚠ `parts` empty and `mesh`
    // set is not a special case — the schema refuses a document that has both
    // or neither, because an assembler and a finished body disagreeing about
    // what a character is would let the build silently pick one (D-594).
    const made = CharacterDefSchema.safeParse({
      id: 'goblin-matron',
      name: 'Goblin matron',
      pack: 'dungeon-pack',
      sex: 'female',
      parts: {},
      mesh: 'Character_Goblin_Female',
    });
    expect(made.success, JSON.stringify(made.error?.issues)).toBe(true);

    const both = CharacterDefSchema.safeParse({
      id: 'confused', name: 'x', pack: 'p', sex: 'male',
      parts: { head: 'SK_Chr_Head_Male_01' }, mesh: 'Character_Goblin_Male',
    });
    expect(both.success, 'a character cannot be an assembly AND a mesh').toBe(false);
  });
});

describe.skipIf(packs.length === 0)('what the tab can actually reach', () => {
  const characterMeshes = packs.flatMap((pack) =>
    [...allMeshStems(pack)]
      .filter((stem) => meshShelf(stem) === 'character')
      .map((stem) => `${pack.id}/${stem}`),
  );

  it('⚠ finds the goblins', () => {
    // The literal report. If this ever returns nothing again, the tab is
    // showing an empty list for a reason that is not "no art here".
    const goblins = characterMeshes.filter((m) => /goblin/i.test(m));
    expect(goblins.length, `character meshes seen: ${characterMeshes.length}`)
      .toBeGreaterThan(0);
  });

  it('keeps whole bodies off the modular shelf', () => {
    // ⚠ A goblin appearing under Body parts would offer it as a head, and the
    // assembler would try to graft a whole person onto a neck bone.
    for (const entry of characterMeshes) {
      const stem = entry.split('/')[1]!;
      expect(meshShelf(stem), `${entry} is a body, not a part`).toBe('character');
    }
  });
});

describe('a look cannot be deleted out from under a creature', () => {
  it('⚠ refuses while a roamer is drawn as it', () => {
    // A roamer names its look by id (D-594). Deleting the definition leaves
    // content that parses, validates against its own schema, and fails the
    // build somewhere else about a different document — the shape of failure
    // D-569 built the graph check for. Verified live against the running
    // server: DELETE skeleton-soldier answers "skeleton-soldier is what
    // night-walker is drawn as"; an unused one deletes.
    const server = readFileSync(
      fileURLToPath(new URL('../src/studio-server.ts', import.meta.url)),
      'utf8',
    );
    expect(server).toMatch(/DELETE.*api\/characters/s);
    expect(server).toMatch(/savedRoamers\(\)[\s\S]{0,200}r\.character === id/);
  });
});
