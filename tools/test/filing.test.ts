import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AssetFileSchema } from '@rc/shared';
import { applyFiling, filingRows } from '../src/filing';

/**
 * Asset filing (D-631): every mesh visible, filed from one place, several
 * uses per mesh, existing categories used as labels, the unfiled highlighted.
 *
 * ⚠ Filing is read off the files the game reads and written back into them.
 * These tests drive the pure functions over a temporary content tree with a
 * made-up pack of stems, so what is asserted is the RULE: an arrow may be a
 * pickup and a projectile at once; a face is never clothing; unfiling what an
 * area places is refused by name.
 */

const root = mkdtempSync(join(tmpdir(), 'rc-filing-'));
const contentDir = join(root, 'content');
const PACK = 'testpack';
const STEMS = [
  'SM_Wep_Sword_01',
  'SM_Arrow_01',
  'SM_Prop_Barrel_01',
  'SM_Bld_Wall_01_Collision',
  'SK_Chr_Head_Male_01',
  'SK_Chr_Torso_Male_03',
  'SM_Character_Goblin_01',
  'SM_Oddity_01',
  // The dungeon pack's spelling of a whole creature: the part prefix, not a part.
  'SK_Chr_Ghost_01',
];
const world = { contentDir, pack: PACK, stems: STEMS };

function json(sub: string, file: string, body: unknown): void {
  mkdirSync(join(contentDir, sub), { recursive: true });
  writeFileSync(join(contentDir, sub, file), JSON.stringify(body));
}

// What is already filed: a sword as a weapon, a barrel as environment placed
// in an area, a goblin as a creature.
json('assets', `${PACK}.character-item.json`, {
  pack: PACK, kind: 'character-item',
  assets: [{ id: 'wep-sword-01', name: 'Sword', pack: PACK, mesh: 'SM_Wep_Sword_01', kind: 'character-item', attach: 'Hand_R' }],
});
json('assets', `${PACK}.environment.json`, {
  pack: PACK, kind: 'environment',
  assets: [{ id: 'prop-barrel-01', name: 'Barrel', pack: PACK, mesh: 'SM_Prop_Barrel_01', kind: 'environment' }],
});
json('areas', 'yard.json', {
  id: 'yard', name: 'Yard', width: 8, height: 8, legend: { '.': { walkable: true, kind: 'floor' } },
  tiles: Array.from({ length: 8 }, () => '........'), spawn: { x: 1, y: 1 }, zone: 'wilderness',
  assets: [{ asset: 'prop-barrel-01', pack: PACK, x: 2, y: 2, z: 0, rotation: 0, scale: 1 }],
});
json('characters', 'goblin.json', {
  id: 'goblin', name: 'Goblin', pack: PACK, sex: 'male', parts: {}, mesh: 'SM_Character_Goblin_01', kind: 'creature',
});
json('parts', `${PACK}.json`, { pack: PACK, names: {}, tags: { SK_Chr_Torso_Male_03: ['base'] } });

afterAll(() => rmSync(root, { recursive: true, force: true }));

const rowOf = (stem: string) => filingRows(world).find((r) => r.stem === stem)!;

describe('filing rows', () => {
  it('labels every mesh from the categories it is already in', () => {
    expect(rowOf('SM_Wep_Sword_01').uses).toEqual(['weapon']);
    expect(rowOf('SM_Prop_Barrel_01').uses).toEqual(['environment']);
    expect(rowOf('SM_Character_Goblin_01').uses).toEqual(['creature']);
    expect(rowOf('SM_Bld_Wall_01_Collision').uses).toEqual(['helper']);
    // A face is a body part whatever the tags say; a base-tagged torso too.
    expect(rowOf('SK_Chr_Head_Male_01').uses).toEqual(['body-part']);
    expect(rowOf('SK_Chr_Torso_Male_03').uses).toEqual(['body-part']);
  });

  it('⚠ highlights what nobody has filed', () => {
    const unfiled = filingRows(world).filter((r) => r.unfiled).map((r) => r.stem);
    expect(unfiled).toEqual(['SM_Arrow_01', 'SM_Oddity_01', 'SK_Chr_Ghost_01']);
  });

  it('says what a mesh may be filed as', () => {
    expect(rowOf('SK_Chr_Head_Male_01').allowed).toEqual(['body-part']);
    expect(rowOf('SK_Chr_Torso_Male_03').allowed).toEqual(['body-part', 'clothing']);
    expect(rowOf('SM_Character_Goblin_01').allowed[0]).toBe('creature');
    expect(rowOf('SM_Bld_Wall_01_Collision').allowed).toEqual([]);
    // ⚠ A `Chr_` that is not a modular part is a whole body, and may be a
    // creature; so may a mesh the prefixes could not place.
    expect(rowOf('SK_Chr_Ghost_01').shelf).toBe('character');
    expect(rowOf('SK_Chr_Ghost_01').allowed[0]).toBe('creature');
    expect(rowOf('SM_Oddity_01').allowed).toContain('creature');
  });
});

describe('applying a filing', () => {
  it('⚠ one mesh, several uses: an arrow is a pickup AND a projectile', () => {
    const r = applyFiling(world, 'SM_Arrow_01', ['pickup', 'projectile']);
    expect(r.ok, r.problems.join('; ')).toBe(true);
    expect(r.row?.uses.sort()).toEqual(['pickup', 'projectile']);
    expect(r.changed).toEqual(['assets']);
    const pickups = AssetFileSchema.parse(JSON.parse(readFileSync(join(contentDir, 'assets', `${PACK}.pickup.json`), 'utf8')));
    const projectiles = AssetFileSchema.parse(JSON.parse(readFileSync(join(contentDir, 'assets', `${PACK}.projectile.json`), 'utf8')));
    expect(pickups.assets.map((a) => a.mesh)).toEqual(['SM_Arrow_01']);
    expect(projectiles.assets.map((a) => a.mesh)).toEqual(['SM_Arrow_01']);
    expect(rowOf('SM_Arrow_01').unfiled).toBe(false);
  });

  it('removes one use and keeps the other', () => {
    const r = applyFiling(world, 'SM_Arrow_01', ['projectile']);
    expect(r.ok).toBe(true);
    expect(rowOf('SM_Arrow_01').uses).toEqual(['projectile']);
    const pickups = AssetFileSchema.parse(JSON.parse(readFileSync(join(contentDir, 'assets', `${PACK}.pickup.json`), 'utf8')));
    expect(pickups.assets).toEqual([]);
  });

  it('⚠ refuses to unfile what an area still places, by name', () => {
    const r = applyFiling(world, 'SM_Prop_Barrel_01', []);
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/prop-barrel-01: area yard places it 1 time/);
    // Nothing was written.
    expect(rowOf('SM_Prop_Barrel_01').uses).toEqual(['environment']);
  });

  it('⚠ a face is never clothing', () => {
    const r = applyFiling(world, 'SK_Chr_Head_Male_01', ['clothing']);
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/cannot be filed as clothing/);
  });

  it('body part and clothing are one tag with two faces', () => {
    expect(applyFiling(world, 'SK_Chr_Torso_Male_03', ['clothing']).ok).toBe(true);
    let parts = JSON.parse(readFileSync(join(contentDir, 'parts', `${PACK}.json`), 'utf8')) as { tags: Record<string, string[]> };
    expect(parts.tags['SK_Chr_Torso_Male_03']).toBeUndefined();
    expect(rowOf('SK_Chr_Torso_Male_03').uses).toEqual(['clothing']);
    expect(applyFiling(world, 'SK_Chr_Torso_Male_03', ['body-part']).ok).toBe(true);
    parts = JSON.parse(readFileSync(join(contentDir, 'parts', `${PACK}.json`), 'utf8'));
    expect(parts.tags['SK_Chr_Torso_Male_03']).toEqual(['base']);
  });

  it('files a rigged body as a creature, and unfiles it', () => {
    const on = applyFiling(world, 'SM_Oddity_01', ['environment']);
    expect(on.ok).toBe(true);
    expect(rowOf('SM_Oddity_01').uses).toEqual(['environment']);
    // The goblin goes: nothing is drawn as it.
    const off = applyFiling(world, 'SM_Character_Goblin_01', []);
    expect(off.ok).toBe(true);
    expect(existsSync(join(contentDir, 'characters', 'goblin.json'))).toBe(false);
    expect(rowOf('SM_Character_Goblin_01').unfiled).toBe(true);
    const back = applyFiling(world, 'SM_Character_Goblin_01', ['creature']);
    expect(back.ok).toBe(true);
    expect(back.changed).toEqual(['characters']);
  });

  it('refuses a mesh the pack does not have', () => {
    expect(applyFiling(world, 'SM_Nope', ['pickup']).ok).toBe(false);
  });
});
