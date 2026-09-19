import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  tileProblems,  AreaSchema,
  WALL_KINDS,
  isTileOpaque,
  isWallKind,
} from '@rc/shared';

/**
 * Wall materials, roofs and the lit/mounted props (D-544, D-545).
 *
 * The assertion that matters most here is the opacity one. `isTileOpaque`
 * used to test `kind === 'wall'`, so every wall material added after it —
 * timber, brick, cave, the treeline — would have been a wall you could see
 * straight through. Line of sight is what makes a witness (D-217), so that
 * would not have been a rendering bug: it would have been a hole in the
 * crime system, and an invisible one.
 */

const contentDir = fileURLToPath(new URL('../../content', import.meta.url));

function areas() {
  return readdirSync(`${contentDir}/areas`)
    .filter((f) => f.endsWith('.json'))
    .map((f) => AreaSchema.parse(JSON.parse(readFileSync(`${contentDir}/areas/${f}`, 'utf8'))));
}

describe('the wall family', () => {
  it('blocks sight for every material, not just stone', () => {
    for (const kind of WALL_KINDS) {
      expect(isWallKind(kind), kind).toBe(true);
      expect(isTileOpaque({ kind }), `${kind} must block line of sight`).toBe(true);
    }
    // And nothing else claims to be a wall.
    for (const kind of ['floor', 'grass', 'dirt', 'wood', 'chair', 'water']) {
      expect(isTileOpaque({ kind }), kind).toBe(false);
    }
  });

  it('lets a legend override opacity explicitly either way', () => {
    expect(isTileOpaque({ kind: 'wall', opaque: false })).toBe(false);
    expect(isTileOpaque({ kind: 'grass', opaque: true })).toBe(true);
  });

  it('⚠ describes no authored map at all: every tile is walkable ground (D-638)', () => {
    // The wall FAMILY is still the rule for a tile's opacity, so
    // `isTileOpaque` above still has to be right — but nothing draws a tile
    // any more. A wall is a placed mesh with a collision mask, the ground is
    // painted, and an unwalkable tile would be an obstacle nobody can see.
    // `validate:content` refuses one; this is the same rule from the tests.
    for (const area of areas()) {
      expect(tileProblems(area), area.id).toEqual([]);
      for (const def of Object.values(area.legend)) {
        expect(def.walkable, `${area.id}: '${def.kind}' is an unwalkable tile`).toBe(true);
      }
    }
  });

  it('paints every map, because an unpainted map has no floor (D-638)', () => {
    for (const area of areas()) {
      expect(area.groundPaint?.length ?? 0, `${area.id} is unpainted`).toBeGreaterThan(0);
    }
  });

  // Skipped from D-582 to D-638: the maps' scenery had been cleared to be
  // designed by hand. Every wall tile became a placed mesh in D-638, so the
  // rule holds again and the test is back.
  it('gives every map walls you can bump into', () => {
    for (const area of areas()) {
      const solid = area.assets.filter((a) =>
        a.collision.some((v) => !v.walkable && v.top > 1.5),
      );
      expect(solid.length, `${area.id} has no walls at all`).toBeGreaterThan(0);
    }
  });
});

describe('roofs', () => {
  it('are inside their area and never sit on nothing', () => {
    for (const area of areas()) {
      for (const roof of area.roofs) {
        expect(roof.x, area.id).toBeLessThan(area.width);
        expect(roof.y, area.id).toBeLessThan(area.height);
        expect(roof.x).toBeGreaterThanOrEqual(0);
        expect(roof.y).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('do not change what anybody can walk on or see through', () => {
    // Roofs are presentation (D-545). The check is that the schema keeps them
    // out of the tile grid entirely — there is no way to express "this roof
    // blocks" — so this asserts the shape of the data rather than behaviour.
    //
    // ⚠ Built HERE rather than found in an authored map. It used to pick the
    // first roofed area, which made a rule about the schema depend on somebody
    // having painted a roof — and it broke the moment the maps were cleared
    // for redesign (D-582), which says nothing about whether a roof can block.
    // A fixture also lets it assert the part that matters and cannot be
    // authored: that there is no field to express a blocking roof at all.
    const roofed = AreaSchema.parse({
      id: 'roof-fixture',
      name: 'Roof Fixture',
      // The schema floors an area at 8x8, which is the smallest honest fixture.
      width: 8,
      height: 8,
      tiles: Array.from({ length: 8 }, () => '........'),
      legend: { '.': { walkable: true, kind: 'floor' } },
      spawn: { x: 0, y: 0 },
      roofs: [{ x: 0, y: 0, style: 'thatch' }, { x: 1, y: 0, style: 'slate' }],
    });
    for (const roof of roofed.roofs) {
      const ch = roofed.tiles[roof.y]![roof.x]!;
      // A roof over a walkable tile is the normal case: you stand under it.
      expect(roofed.legend[ch]!.walkable).toBe(true);
      // And there is nowhere on a roof to say otherwise.
      expect(Object.keys(roof).sort()).toEqual(['style', 'x', 'y']);
    }
  });
});


describe('the tavern, at the size it was asked to be', () => {
  it('is an interior that connects to the yard AND the town, both ways', () => {
    const all = areas();
    const tavern = all.find((a) => a.id === 'hanged-ferryman')!;
    const yard = all.find((a) => a.id === 'broken-yard')!;
    // ⚠ A ROOM, not a plot with a building on it (D-604). It was 32x32 of
    // which most was outdoors: an approach, a yard and a treeline, painted
    // with grass and mud and scattered with 86 tufts of grass — inside what
    // the fiction calls a taproom.
    expect(tavern.width).toBeLessThan(32);
    expect(tavern.outdoor).toBe(false);
    expect(tavern.lighting).toBe('interior');
    // Nothing that grows outdoors may be standing in it.
    const outdoors = tavern.assets.filter((a) => /grass|flower|tree|bush|fern|reed/.test(a.asset));
    expect(outdoors).toEqual([]);
    // Its floor is boards and flags, not a field.
    expect(tavern.groundMaterials).not.toContain('grass');
    expect(tavern.groundMaterials).not.toContain('mud');
    // The town can reach it: the whole reason it was rebuilt.
    const town = all.find((a) => a.id === 'round-town')!;
    expect(town.transitions.some((t) => t.toArea === 'hanged-ferryman')).toBe(true);
    expect(tavern.transitions.some((t) => t.toArea === 'round-town')).toBe(true);

    // Out of the tavern...
    const out = tavern.transitions.find((t) => t.toArea === 'broken-yard')!;
    expect(out, 'the tavern needs a way out').toBeDefined();
    const landing = yard.tiles[out.toY]?.[out.toX];
    expect(landing, 'it must arrive somewhere that exists').toBeDefined();
    expect(yard.legend[landing!]!.walkable).toBe(true);

    // ...and back in. A door that only works one way is the classic bug.
    const back = yard.transitions.find((t) => t.toArea === 'hanged-ferryman')!;
    expect(back, 'the yard needs a way in').toBeDefined();
    const arrival = tavern.tiles[back.toY]?.[back.toX];
    expect(arrival, 'the yard door must arrive inside the resized tavern').toBeDefined();
    expect(tavern.legend[arrival!]!.walkable).toBe(true);
  });
});
