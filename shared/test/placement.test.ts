import { describe, expect, it } from 'vitest';
import {
  AreaSchema,
  EnvironmentAssetSchema,
  PlacedAssetSchema,
  areaCollision,
  assetCovers,
  canStandAt,
  defaultMask,
  isTileWalkable,
  placedAssetDrift,
  placedVolumes,
  transformVolume,
  VolumeSchema,
  type PlacedAsset,
  type Volume,
} from '../src/index';

/**
 * Placing a pack mesh, and what it does to a body (D-567).
 *
 * ⚠ The pair that matters is `transformVolume` and the renderer's yaw. They
 * are two implementations of one rotation, in different libraries, and when
 * they disagree the mesh and its collision mirror about the placement point —
 * invisible on anything symmetrical, wrong for every door. The renderer's half
 * is measured in the browser (`__editor.placed()`); this is the other half.
 */

function vol(raw: unknown): Volume {
  return VolumeSchema.parse(raw);
}

const AT_ORIGIN = { x: 0, y: 0, z: 0, rotation: 0, scale: 1 };

describe('transforming an authored mask into the world', () => {
  const offCentre = vol({ shape: { kind: 'rect', x: 2, y: 0, w: 1, h: 1 }, top: 3 });

  it('moves with the placement', () => {
    const out = transformVolume(offCentre, { ...AT_ORIGIN, x: 10, y: 5 });
    expect(out.shape).toMatchObject({ x: 12, y: 5 });
  });

  it('⚠ turns about the PLACEMENT point, not the volume’s own centre', () => {
    // A jamb 2m to the asset's east must swing round to 2m south when the
    // asset is turned a quarter. Rotating each volume in place instead leaves
    // every door frame's jambs where they were and only spins the mesh.
    const out = transformVolume(offCentre, { ...AT_ORIGIN, rotation: 90 });
    const shape = out.shape as Extract<Volume['shape'], { kind: 'rect' }>;
    expect(shape.x).toBeCloseTo(0, 6);
    expect(shape.y).toBeCloseTo(2, 6);
    expect(shape.rotation).toBe(90);
  });

  it('scales the footprint and the heights together', () => {
    const out = transformVolume(vol({ shape: { kind: 'circle', x: 1, y: 0, r: 2 }, top: 3 }), {
      ...AT_ORIGIN,
      scale: 2,
    });
    expect(out.shape).toMatchObject({ x: 2, y: 0, r: 4 });
    expect(out.top).toBe(6);
  });

  it('lifts a whole volume by the placement height', () => {
    const out = transformVolume(vol({ shape: { kind: 'circle', x: 0, y: 0, r: 1 }, base: 0, top: 1 }), {
      ...AT_ORIGIN,
      z: 2.5,
    });
    expect(out.base).toBe(2.5);
    expect(out.top).toBe(3.5);
  });

  it('carries a ramp up with it, so a stair on a platform still climbs', () => {
    const out = transformVolume(
      vol({
        shape: { kind: 'rect', x: 0, y: 0, w: 2, h: 4 },
        top: 2,
        walkable: true,
        ramp: { along: 'y', low: 0, high: 2 },
      }),
      { ...AT_ORIGIN, z: 3 },
    );
    expect(out.ramp).toEqual({ along: 'y', low: 3, high: 5 });
  });
});

describe('the mask an unauthored asset gets', () => {
  function asset(over: Record<string, unknown>) {
    return EnvironmentAssetSchema.parse({
      id: 'x',
      name: 'X',
      pack: 'p',
      mesh: 'M',
      kind: 'environment',
      ...over,
    });
  }

  it('is nothing at all when the classifier measured it flat', () => {
    expect(defaultMask(asset({ solid: false }))).toEqual([]);
  });

  it('takes its height from the measured size, not a guess', () => {
    const m = defaultMask(asset({ solid: true, footprint: [4, 1], size: [4, 0.9, 1] }));
    expect(m).toHaveLength(1);
    expect(m[0]!.top).toBe(0.9);
    expect(m[0]!.shape).toMatchObject({ w: 4, h: 1 });
  });

  it('an authored mask always wins over the derived one', () => {
    const drawn = [vol({ shape: { kind: 'circle', x: 0, y: 0, r: 1 }, top: 1 })];
    expect(defaultMask(asset({ solid: true, collision: drawn }))).toEqual(drawn);
  });
});

describe('a doorway, which is the whole point (D-567)', () => {
  // Two jambs with 0.9m of air between them — the shape every door frame in
  // the packs actually is, and the thing a 3×1 solid rectangle could not say.
  const frame: Volume[] = [
    vol({ shape: { kind: 'rect', x: -1.3, y: 0, w: 1.1, h: 0.4 }, top: 3, opaque: true }),
    vol({ shape: { kind: 'rect', x: 1.3, y: 0, w: 1.1, h: 0.4 }, top: 3, opaque: true }),
  ];

  function placedAt(rotation: number): PlacedAsset {
    return PlacedAssetSchema.parse({
      asset: 'door-frame',
      pack: 'dungeon-pack',
      x: 10,
      y: 10,
      rotation,
      collision: frame,
    });
  }

  it('is open in the middle and shut either side', () => {
    const v = placedVolumes(placedAt(0));
    expect(v.some((x) => x.shape.kind === 'rect' && Math.abs(x.shape.x - 8.7) < 1e-6)).toBe(true);
    expect(assetCovers(placedAt(0), { x: 10, y: 10 })).toBe(false);
    expect(assetCovers(placedAt(0), { x: 8.7, y: 10 })).toBe(true);
    expect(assetCovers(placedAt(0), { x: 11.3, y: 10 })).toBe(true);
  });

  it('turns with the frame — the opening follows the door', () => {
    // Quartered, the jambs move to north and south and the gap runs east-west.
    expect(assetCovers(placedAt(90), { x: 10, y: 8.7 })).toBe(true);
    expect(assetCovers(placedAt(90), { x: 10, y: 11.3 })).toBe(true);
    expect(assetCovers(placedAt(90), { x: 8.7, y: 10 })).toBe(false);
  });
});

describe('an area with no collision block still has one', () => {
  const area = AreaSchema.parse({
    id: 'test-room',
    name: 'Test room',
    width: 8,
    height: 8,
    legend: {
      '.': { kind: 'stone', walkable: true },
      '#': { kind: 'wall', walkable: false },
    },
    tiles: [
      '########',
      '#......#',
      '#......#',
      '#......#',
      '#......#',
      '#......#',
      '#......#',
      '########',
    ],
    spawn: { x: 3, y: 2 },
  });

  it('derives bounds and walls from the tile grid', () => {
    const layer = areaCollision(area);
    expect(layer.bounds).toHaveLength(4);
    expect(layer.volumes.length).toBeGreaterThan(0);
  });

  it('⚠ merges blocked tiles into RUNS rather than one volume each', () => {
    // Eight blocked tiles across the top row are ONE volume. A 100×100 dungeon
    // holds about four thousand blocked tiles and `canOccupy` is linear in
    // volumes, so one-per-tile puts four thousand shape tests inside every
    // step of every path.
    const layer = areaCollision(area);
    const top = layer.volumes.filter((v) => v.shape.kind === 'rect' && v.shape.y === 0);
    expect(top).toHaveLength(1);
    expect(top[0]!.shape).toMatchObject({ w: 8 });
  });

  it('agrees with the tile answer it replaces', () => {
    expect(canStandAt(area, { x: 3, y: 2 })).toBe(true);
    expect(isTileWalkable(area, { x: 3, y: 2 })).toBe(true);
    expect(canStandAt(area, { x: 0, y: 0 })).toBe(false);
    expect(isTileWalkable(area, { x: 0, y: 0 })).toBe(false);
  });

  it('⚠ puts the map edge half a metre out, where the tiles actually end', () => {
    // A tile's integer coordinate is its CENTRE, so the grid reaches to -0.5.
    // Bounds drawn at 0 would make the whole first row unstandable and the
    // symptom is a one-tile border nobody can enter.
    const layer = areaCollision(area);
    expect(layer.bounds[0]).toEqual({ x: -0.5, y: -0.5 });
    expect(layer.bounds[2]).toEqual({ x: 7.5, y: 7.5 });
  });

  it('caches per area object, not per id — an edited area must not serve stale', () => {
    const again = AreaSchema.parse(JSON.parse(JSON.stringify(area)));
    expect(areaCollision(area)).toBe(areaCollision(area));
    expect(areaCollision(again)).not.toBe(areaCollision(area));
  });
});

describe('drift between a map and the catalogue', () => {
  const mask = [vol({ shape: { kind: 'rect', x: 0, y: 0, w: 4, h: 1 }, top: 3 })];
  const placed = PlacedAssetSchema.parse({
    asset: 'wall',
    pack: 'dungeon-pack',
    x: 3,
    y: 4,
    collision: mask,
  });

  it('says nothing when they agree', () => {
    expect(placedAssetDrift([placed], new Map([['dungeon-pack/wall', { collision: mask }]]))).toEqual(
      [],
    );
  });

  it('⚠ catches a mask redrawn to the same COUNT in a different place', () => {
    // A length check passes this, and it is the drift most worth catching: a
    // wall whose gap moved is a map that silently changed shape.
    const moved = [vol({ shape: { kind: 'rect', x: 2, y: 0, w: 4, h: 1 }, top: 3 })];
    const out = placedAssetDrift([placed], new Map([['dungeon-pack/wall', { collision: moved }]]));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/re-place it/);
  });

  it('names an asset the catalogue has never heard of', () => {
    expect(placedAssetDrift([placed], new Map())[0]).toMatch(/does not define/);
  });
});

/**
 * The map edge, authored (D-567).
 *
 * ⚠ This is what lets an area stop being a rectangle. Every area was one
 * because its extent was `width × height` enforced by arithmetic — a cave
 * mouth, a river bank and a road leaving town at an angle were unexpressible.
 */
describe('an area may have a shape', () => {
  const base = {
    id: 'wedge',
    name: 'Wedge',
    width: 12,
    height: 12,
    legend: { '.': { walkable: true, kind: 'dirt' } },
    tiles: Array.from({ length: 12 }, () => '.'.repeat(12)),
    spawn: { x: 2, y: 2 },
  };

  it('keeps the rectangle when nothing is authored', () => {
    const area = AreaSchema.parse(base);
    expect(areaCollision(area).bounds).toHaveLength(4);
    expect(canStandAt(area, { x: 10, y: 10 })).toBe(true);
  });

  it('takes the authored polygon instead', () => {
    // A triangle cutting off the south-east.
    const area = AreaSchema.parse({
      ...base,
      bounds: [
        { x: -0.5, y: -0.5 },
        { x: 11.5, y: -0.5 },
        { x: -0.5, y: 11.5 },
      ],
    });
    expect(canStandAt(area, { x: 2, y: 2 })).toBe(true);
    expect(canStandAt(area, { x: 10, y: 10 }), 'outside the wedge').toBe(false);
  });

  it('⚠ does not change the tile grid, only where a body may be', () => {
    const area = AreaSchema.parse({
      ...base,
      bounds: [
        { x: -0.5, y: -0.5 },
        { x: 5.5, y: -0.5 },
        { x: 5.5, y: 5.5 },
        { x: -0.5, y: 5.5 },
      ],
    });
    // The grid is still 12×12 — shrinking the bounds inside it is legal and is
    // how an area gets a shape without being re-cut.
    expect(area.width).toBe(12);
    expect(canStandAt(area, { x: 8, y: 8 })).toBe(false);
  });
});
