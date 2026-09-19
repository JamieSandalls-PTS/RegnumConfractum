import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AreaSchema, type AreaDef } from '@rc/shared';
import { checkAreaForSave } from '../src/editor-check';

/**
 * The map editor's save guard (D-543).
 *
 * The editor is a tool, and a tool that writes content is only as safe as the
 * check standing in front of its save button. These assert the check refuses
 * the specific ways a person seals their own map shut — because the whole
 * argument for editing through a server rather than downloading a file is
 * that the validator guarding CI also guards the save.
 */

const contentDir = fileURLToPath(new URL('../../content', import.meta.url));

function load(id: string): AreaDef {
  return AreaSchema.parse(JSON.parse(readFileSync(`${contentDir}/areas/${id}.json`, 'utf8')));
}

describe('the editor refuses to write content that would fail the build', () => {
  it('accepts the areas that are already in the repository', () => {
    for (const id of ['broken-yard', 'hanged-ferryman', 'round-town', 'sunken-crypt']) {
      expect(checkAreaForSave(load(id)).errors, id).toEqual([]);
    }
  });

  it('refuses a wall that seals a corner off', () => {
    // A purpose-built room rather than a real area: the point is the ring of
    // crates, and hemming in a spawn that already hugs a wall would be caught
    // by the schema first and prove something else.
    const room = AreaSchema.parse({
      id: 'test-room',
      name: 'Test Room',
      width: 9,
      height: 9,
      // No wall tiles (D-638): the room is bounded by the area's own edge.
      legend: { '.': { walkable: true, kind: 'floor' } },
      tiles: [
        '.........', '.........', '.........', '.........', '.........',
        '.........', '.........', '.........', '.........',
      ],
      spawn: { x: 1, y: 1 },
    });
    expect(checkAreaForSave(room).errors).toEqual([]);
    // Now box the far corner off with two placed walls (D-567). The scenery
    // that used to do this was a procedural crate; a map is built from pack
    // meshes now, and what seals a corner is a collision mask.
    //
    // ⚠ The pocket has to be big enough to STAND in. The first version left a
    // corner a body could not occupy anyway, and the check correctly said
    // nothing — an unstandable tile is a tile with something on it, not an
    // unreachable one.
    const sealed: AreaDef = {
      ...room,
      assets: [
        {
          asset: 'wall', pack: 'test', x: 6.5, y: 5.5, z: 0, rotation: 0, scale: 1,
          overrideCollision: true,
    seat: false, dressed: false, fromTiles: false,
          collision: [{
            shape: { kind: 'rect', x: 0, y: 0, w: 4, h: 0.5, rotation: 0 },
            base: 0, top: 3, walkable: false, opaque: true,
          }],
        },
        {
          asset: 'wall', pack: 'test', x: 5.5, y: 6.5, z: 0, rotation: 90, scale: 1,
          overrideCollision: true,
    seat: false, dressed: false, fromTiles: false,
          collision: [{
            shape: { kind: 'rect', x: 0, y: 0, w: 4, h: 0.5, rotation: 0 },
            base: 0, top: 3, walkable: false, opaque: true,
          }],
        },
      ],
    };
    expect(checkAreaForSave(sealed).errors.join(' ')).toMatch(/cannot be reached/);
  });

  it('refuses something standing in a doorway', () => {
    const area = load('broken-yard');
    const exit = area.transitions[0]!;
    const blocked: AreaDef = {
      ...area,
      assets: [
        ...area.assets,
        {
          asset: 'boulder', pack: 'test', x: exit.x, y: exit.y, z: 0, rotation: 0, scale: 1,
          overrideCollision: true,
    seat: false, dressed: false, fromTiles: false,
          collision: [{
            shape: { kind: 'circle', x: 0, y: 0, r: 0.8 },
            base: 0, top: 2, walkable: false, opaque: true,
          }],
        },
      ],
    };
    expect(checkAreaForSave(blocked).errors.join(' ')).toMatch(/exit .* blocked by/);
  });

  it('refuses a facility with nowhere to stand', () => {
    const area = load('round-town');
    const station = area.stations[0]!;
    // ⚠ Buried under a placed ASSET, not under wall tiles (D-567). The maps are
    // built from pack meshes now and their legends hold one walkable kind, so
    // the old version looked for a wall character, found none, and threw on
    // `undefined[0]` — a test that had stopped testing anything.
    const buried: AreaDef = {
      ...area,
      assets: [
        ...area.assets,
        {
          asset: 'slab', pack: 'test',
          x: station.x, y: station.y, z: 0, rotation: 0, scale: 1,
          overrideCollision: true,
    seat: false, dressed: false, fromTiles: false,
          collision: [{
            shape: { kind: 'rect', x: 0, y: 0, w: 6, h: 6, rotation: 0 },
            base: 0, top: 3, walkable: false, opaque: true,
          }],
        },
      ],
    };
    const errors = checkAreaForSave(buried).errors.join(' ');
    expect(errors).toMatch(/nowhere to stand|cannot be reached/);
  });

  it('refuses a document that is not an area at all', () => {
    expect(checkAreaForSave({ id: 'nope' }).errors.length).toBeGreaterThan(0);
    expect(checkAreaForSave(null).errors.length).toBeGreaterThan(0);
  });

  it('returns the parsed area when it accepts one, defaults and all', () => {
    const { area, errors } = checkAreaForSave(
      JSON.parse(readFileSync(`${contentDir}/areas/sunken-crypt.json`, 'utf8')),
    );
    expect(errors).toEqual([]);
    // Defaults resolved: the editor and the game work on the same document.
    expect(area?.assets).toBeDefined();
    expect(area?.zone).toBeDefined();
    expect(area?.lighting).toBeDefined();
  });
});
