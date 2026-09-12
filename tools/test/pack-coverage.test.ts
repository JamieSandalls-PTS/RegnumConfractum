import { describe, expect, it } from 'vitest';
import { meshShelf, kindOfMesh, type MeshShelf } from '@rc/shared';
import { allPacks, partStems } from '../src/packs';

/**
 * Every mesh in every ingested pack can be found in the creation tool (D-595).
 *
 * ⚠ Asked for directly: "ensure all assets from all packs are available in the
 * creation tool, in the proper categories." Three things were stopping that,
 * and none of them said anything:
 *
 *   - `allPacks` required a folder called `fbx`, and the generic pack keeps
 *     its meshes in `Models/`. The pack was skipped with a bare `continue` —
 *     467 meshes invisible to every tool in the project.
 *   - `partStems` read only the TOP LEVEL while `meshPath` beside it recursed,
 *     so the two disagreed about what a pack contains: 140 vikings snow
 *     variants were catalogued by a tool that could find them and reported as
 *     "not in the pack" by one that could not.
 *   - the tool filtered by `kindOfMesh`, which returns null for anything its
 *     prefixes do not cover — correct for a catalogue and fatal for a menu.
 *     A mesh with no kind appeared in NO tab.
 *
 * ⚠ Skipped when `assets/source/` is empty, which is every clean checkout: the
 * packs are licensed art and gitignored (D-555). This is a check on the art
 * that is present, not a reason CI cannot run without it.
 */

const packs = allPacks();

describe.skipIf(packs.length === 0)('what the packs offer the tool', () => {
  it('finds every ingested pack, whatever its mesh folder is called', () => {
    // ⚠ Named rather than counted. "at least five packs" passes while the one
    // you ingested this morning is missing.
    const ids = packs.map((p) => p.id).sort();
    expect(ids).toContain('generic');
    for (const p of packs) expect(partStems(p).size, `${p.id} ships no meshes`).toBeGreaterThan(0);
  });

  it('puts EVERY mesh on a shelf — nothing is invisible', () => {
    const shelves = new Map<MeshShelf, number>();
    let total = 0;
    for (const pack of packs) {
      for (const stem of partStems(pack)) {
        total++;
        const shelf = meshShelf(stem);
        shelves.set(shelf, (shelves.get(shelf) ?? 0) + 1);
      }
    }
    expect(total).toBeGreaterThan(3000);
    expect([...shelves.values()].reduce((a, b) => a + b, 0)).toBe(total);
  });

  it('leaves only a handful unfiled, and they are SHOWN rather than dropped', () => {
    // ⚠ A small number is expected and healthy: D-568 tried to file the last
    // few by matching English words and broke three meshes to fix three,
    // because "bolt" is a fastener as often as it is ammunition. The rule is
    // that a person files them — which they can only do if they can see them.
    const unfiled: string[] = [];
    for (const pack of packs) {
      for (const stem of partStems(pack)) {
        if (meshShelf(stem) === 'unfiled') unfiled.push(`${pack.id}/${stem}`);
      }
    }
    expect(unfiled.length, `unfiled: ${unfiled.join(', ')}`).toBeLessThan(20);
  });

  it('keeps collision hulls and FX helpers OFF the scenery shelf', () => {
    // ⚠ `SM_Bld_Base_Stairs_01_Collision` carries a real `Bld_` prefix, so
    // classifying by prefix alone offered 78 invisible physics boxes as
    // buildings. A helper is a helper whatever it is called.
    expect(meshShelf('SM_Bld_Base_Stairs_01_Collision')).toBe('helper');
    expect(meshShelf('SM_Gen_Beam_01_Convex')).toBe('helper');
    expect(meshShelf('FX_LightRay_Cube_01')).toBe('helper');
    // And the catalogue's own classifier is untouched by any of this: it still
    // says what a prefix says and nothing more.
    expect(kindOfMesh('SM_Bld_Base_Stairs_01_Collision')).toBe('environment');
  });

  it('files a whole rigged person as a character, not as a prop', () => {
    expect(meshShelf('Character_Goblin_Male')).toBe('character');
    expect(meshShelf('SK_Chr_Head_Male_00')).toBe('body-part');
    // ⚠ The knights pack misspells its own prefix on exactly one mesh.
    expect(meshShelf('SM_Prp_Brazier_01_Snow')).toBe('environment');
  });
});
