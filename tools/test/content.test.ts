import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AreaSchema, canStandAt, type AreaDef } from '@rc/shared';
import { unreachableTiles, validateContent } from '../src/validate-content';

describe('repository content', () => {
  it('every checked-in content file validates, with no unreachable tiles', () => {
    const result = validateContent(fileURLToPath(new URL('../../content', import.meta.url)));
    expect(result.errors).toEqual([]);
    expect(result.checked).toBeGreaterThan(0);
  });
});

describe('reachability validator', () => {
  it('flags walkable tiles sealed off from spawn', () => {
    const area = AreaSchema.parse({
      id: 'sealed-room',
      name: 'Sealed Room',
      width: 8,
      height: 8,
      legend: {
        '#': { walkable: false, kind: 'wall' },
        '.': { walkable: true, kind: 'floor' },
      },
      tiles: [
        '########',
        '#..#...#',
        '#..#...#',
        '#..#####',
        '#......#',
        '#......#',
        '#......#',
        '########',
      ],
      spawn: { x: 1, y: 1 },
    });
    // The 3×3 pocket at top-right is walled off.
    const missing = unreachableTiles(area);
    expect(missing.length).toBe(6);
    expect(missing).toContainEqual({ x: 4, y: 1 });
  });

  it('accepts a fully connected area', () => {
    const area = AreaSchema.parse({
      id: 'open-floor',
      name: 'Open Floor',
      width: 8,
      height: 8,
      legend: {
        '#': { walkable: false, kind: 'wall' },
        '.': { walkable: true, kind: 'floor' },
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
      spawn: { x: 1, y: 1 },
    });
    expect(unreachableTiles(area)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Objectives (D-521). These guards matter because a bad objective does not
// crash anything — it produces a lobby that fills and never starts, or a
// running round with no reachable resolution. Both are silent failures, so
// the validator has to be the thing that catches them.
// ---------------------------------------------------------------------------

// ⚠ No wall TILES (D-638): a tile is walkable ground and nothing else now,
// and the validator refuses one that is not. The yard is bounded by the
// area's own edge.
const MINIMAL_AREA = {
  id: 'test-yard',
  name: 'Test Yard',
  width: 8,
  height: 8,
  legend: {
    '.': { walkable: true, kind: 'floor' },
  },
  tiles: [
    '........',
    '........',
    '........',
    '........',
    '........',
    '........',
    '........',
    '........',
  ],
  spawn: { x: 1, y: 1 },
};

/** Builds a throwaway content tree and validates it. */
function validateWith(objectives: unknown[], items: unknown[] = []): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'rc-objectives-'));
  mkdirSync(join(dir, 'areas'), { recursive: true });
  mkdirSync(join(dir, 'objectives'), { recursive: true });
  writeFileSync(join(dir, 'areas', 'yard.json'), JSON.stringify(MINIMAL_AREA));
  objectives.forEach((o, i) =>
    writeFileSync(join(dir, 'objectives', `o${i}.json`), JSON.stringify(o)),
  );
  if (items.length > 0) {
    mkdirSync(join(dir, 'items'), { recursive: true });
    items.forEach((it, i) =>
      writeFileSync(join(dir, 'items', `i${i}.json`), JSON.stringify(it)),
    );
  }
  try {
    return validateContent(dir).errors;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const LIVE_SURVIVE = {
  id: 'live-one',
  name: 'Live One',
  brief: 'Live to the end.',
  kind: { type: 'survive' },
  minCast: 3,
};

describe('objective validator', () => {
  it('accepts a well-formed objective', () => {
    expect(validateWith([LIVE_SURVIVE])).toEqual([]);
  });

  it('rejects an unknown objective kind', () => {
    const errors = validateWith([{ ...LIVE_SURVIVE, kind: { type: 'befriend' } }]);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a maxCast below minCast', () => {
    const errors = validateWith([{ ...LIVE_SURVIVE, minCast: 6, maxCast: 4 }]);
    expect(errors.join(' ')).toMatch(/maxCast 4 is below minCast 6/);
  });

  it('rejects a steal objective naming an item that does not exist', () => {
    const errors = validateWith([
      LIVE_SURVIVE,
      {
        id: 'thief',
        name: 'Thief',
        brief: 'Take it.',
        kind: { type: 'steal', itemTemplate: 'no-such-item' },
      },
    ]);
    expect(errors.join(' ')).toMatch(/steals unknown item 'no-such-item'/);
  });

  it('rejects duplicate objective ids', () => {
    const errors = validateWith([LIVE_SURVIVE, { ...LIVE_SURVIVE }]);
    expect(errors.join(' ')).toMatch(/duplicate objective id/);
  });

  it('fails the build if nothing is playable at the minimum cast', () => {
    // Every objective planned: the lobby would fill and never start.
    const errors = validateWith([{ ...LIVE_SURVIVE, status: 'planned' }]);
    expect(errors.join(' ')).toMatch(/no live objective is playable at the minimum cast/);
  });

  it('fails the build if every live objective demands a bigger cast', () => {
    const errors = validateWith([{ ...LIVE_SURVIVE, minCast: 8 }]);
    expect(errors.join(' ')).toMatch(/no live objective is playable at the minimum cast/);
  });
});


/**
 * Characters authored in the studio are content, and CI checks them (D-558).
 *
 * The studio's save endpoint refuses a bad character, but the endpoint is not
 * the only writer: a definition can be hand-edited or arrive in a merge, and
 * the build turns each one into a `.glb` that the game will load. What CI
 * cannot check is whether the named parts exist — `assets/source/` is
 * somebody else's art, gitignored, and absent here — so it checks everything
 * that is a decision rather than a file.
 */
const BODY: Record<string, string> = {
  torso: 'SK_Chr_Torso_Male_00',
  hips: 'SK_Chr_Hips_Male_00',
  armUpperL: 'SK_Chr_ArmUpperLeft_Male_00',
  armUpperR: 'SK_Chr_ArmUpperRight_Male_00',
  armLowerL: 'SK_Chr_ArmLowerLeft_Male_00',
  armLowerR: 'SK_Chr_ArmLowerRight_Male_00',
  handL: 'SK_Chr_HandLeft_Male_00',
  handR: 'SK_Chr_HandRight_Male_00',
  legL: 'SK_Chr_LegLeft_Male_00',
  legR: 'SK_Chr_LegRight_Male_00',
};

function withCharacters(files: Record<string, unknown>): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'rc-characters-'));
  mkdirSync(join(dir, 'areas'), { recursive: true });
  mkdirSync(join(dir, 'characters'), { recursive: true });
  writeFileSync(join(dir, 'areas', 'yard.json'), JSON.stringify(MINIMAL_AREA));
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, 'characters', name), JSON.stringify(body));
  }
  try {
    return validateContent(dir).errors;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('character definitions (D-558)', () => {
  /** Everything but the named slot, so a test can knock one part out. */
  const without = (parts: Record<string, string>, drop: string): Record<string, string> => {
    const out = { ...parts };
    delete out[drop];
    return out;
  };

  const complete = {
    id: 'good',
    name: 'Good',
    pack: 'modular-fantasy-hero',
    sex: 'male',
    parts: { head: 'SK_Chr_Head_Male_00', ...BODY } as Record<string, string>,
  };
  const helmed = (extra: Record<string, string> = {}) => ({
    ...complete,
    id: 'helmed',
    parts: {
      ...without(complete.parts, 'head'),
      helmet: 'SK_Chr_Head_No_Elements_Male_04',
      ...extra,
    },
  });

  it('accepts a complete character', () => {
    expect(withCharacters({ 'good.json': complete })).toEqual([]);
  });

  it('accepts a helmed head in place of a head', () => {
    expect(withCharacters({ 'helmed.json': helmed() })).toEqual([]);
  });

  it('refuses a character with a limb missing', () => {
    const errors = withCharacters({
      'good.json': { ...complete, parts: without(complete.parts, 'legL') },
    });
    expect(errors.join(' ')).toMatch(/no part for legL/);
  });

  it('refuses hair worn under a closed helm', () => {
    const errors = withCharacters({ 'helmed.json': helmed({ hair: 'SK_Chr_Hair_04' }) });
    expect(errors.join(' ')).toMatch(/hair is hidden/);
  });

  it('refuses a hood worn over a helm', () => {
    // A hood is cut to sit on a skull, not over a great helm; the two
    // intersect rather than stack.
    const errors = withCharacters({
      'helmed.json': helmed({ headCovering: 'SK_Chr_HeadCoverings_No_Hair_01' }),
    });
    expect(errors.join(' ')).toMatch(/headCovering is hidden/);
  });

  it('refuses a crest with no helm to sit on', () => {
    const errors = withCharacters({
      'good.json': {
        ...complete,
        parts: { ...complete.parts, helmetCrest: 'SK_Chr_HelmetAttachment_03' },
      },
    });
    expect(errors.join(' ')).toMatch(/helmetCrest needs a helmet/);
  });

  it('refuses a part cut for the other body', () => {
    // Most parts in this pack are cut twice, and the two do not meet: a
    // female forearm on a male upper arm leaves a seam at the elbow.
    const errors = withCharacters({
      'good.json': { ...complete, parts: { ...complete.parts, torso: 'SK_Chr_Torso_Female_04' } },
    });
    expect(errors.join(' ')).toMatch(/female part on a male character/);
  });

  it('allows a part the pack only cuts once', () => {
    // Hair, pauldrons and capes are unisex and belong to both.
    expect(
      withCharacters({
        'good.json': {
          ...complete,
          parts: { ...complete.parts, hair: 'SK_Chr_Hair_04', back: 'SK_Chr_BackAttachment_03' },
        },
      }),
    ).toEqual([]);
  });

  it('refuses a character with no sex at all', () => {
    const { sex: _sex, ...noSex } = complete;
    expect(withCharacters({ 'good.json': noSex }).length).toBeGreaterThan(0);
  });

  it('refuses two characters with the same id', () => {
    const errors = withCharacters({
      'good.json': complete,
      'other.json': { ...complete, name: 'Other' },
    });
    // Both would be written to the same `.glb`, and the second wins.
    expect(errors.join(' ')).toMatch(/duplicate character id/);
  });

  it('refuses a file whose name disagrees with its id', () => {
    const errors = withCharacters({ 'elsewhere.json': complete });
    expect(errors.join(' ')).toMatch(/does not match its filename/);
  });

  it('refuses a malformed id rather than writing that filename', () => {
    const errors = withCharacters({ 'Bad Id.json': { ...complete, id: 'Bad Id' } });
    expect(errors.length).toBeGreaterThan(0);
  });
});

/**
 * Reachability is measured against a BODY now, not a tile (D-567).
 *
 * ⚠ Worth being precise about what changed, because the obvious claim is
 * wrong. The tile flood already asked `canStandAt` at each tile CENTRE, so a
 * doorway narrow enough to block a tile centre was caught either way. What the
 * navigation flood adds is routes that do not run through tile centres at all:
 * a passage between two buildings at an angle, a gap offset half a metre from
 * the lattice, anything rotated. The tile flood declared those unreachable —
 * a FALSE failure — because no chain of tile centres connected them.
 *
 * So the strengthening is in both directions: it refuses what a body cannot
 * fit through, and it stops refusing what a body plainly can.
 */
describe('reachability is measured against a BODY, not a tile', () => {
  /** Two rooms joined only by whatever the placed asset leaves open. */
  function twoRooms(collision: unknown[]): AreaDef {
    return AreaSchema.parse({
      id: 'two-rooms',
      name: 'Two Rooms',
      width: 12,
      height: 12,
      legend: {
        '#': { walkable: false, kind: 'wall' },
        '.': { walkable: true, kind: 'floor' },
      },
      tiles: [
        '############',
        '#..........#',
        '#..........#',
        '#..........#',
        '#..........#',
        '#####..#####',
        '#..........#',
        '#..........#',
        '#..........#',
        '#..........#',
        '#..........#',
        '############',
      ],
      spawn: { x: 2, y: 2 },
      assets: [
        {
          asset: 'gate',
          pack: 'test',
          x: 5.5,
          y: 5,
          collision,
        },
      ],
    });
  }

  const jamb = (x: number, w: number) => ({
    shape: { kind: 'rect', x, y: 0, w, h: 0.6, rotation: 0 },
    base: 0,
    top: 3,
    walkable: false,
    opaque: true,
  });

  it('lets a body through a doorway wide enough for one', () => {
    // Jambs leaving 1.0m clear, against a 0.6m body.
    const area = twoRooms([jamb(-1, 1), jamb(1, 1)]);
    expect(unreachableTiles(area)).toEqual([]);
  });

  it('refuses a gap a body does not fit through', () => {
    // Jambs leaving 0.4m clear against a 0.6m body. Both tiles either side are
    // still marked walkable in the legend — the geometry is the only thing
    // that knows.
    const area = twoRooms([jamb(-0.8, 1.2), jamb(0.8, 1.2)]);
    const missing = unreachableTiles(area);
    expect(missing.length).toBeGreaterThan(20);
    expect(missing).toContainEqual({ x: 2, y: 9 });
  });


  it('⚠ threads a doorway that does not line up with the lattice', () => {
    // The case the tile flood got WRONG. The jambs leave a 0.9m opening
    // centred at x=5.5 — on the BOUNDARY between two tiles, not on either
    // centre — so both tile centres sit 5cm inside a jamb and a flood that
    // walks centre to centre finds no way through. A 0.6m body walks it
    // comfortably.
    const area = twoRooms([jamb(-1.175, 1.45), jamb(1.175, 1.45)]);
    // ⚠ Asserted, not asserted in a comment: BOTH tile centres in the doorway
    // are unstandable, which is exactly what made the old flood declare the
    // far room sealed.
    expect(canStandAt(area, { x: 5, y: 5 })).toBe(false);
    expect(canStandAt(area, { x: 6, y: 5 })).toBe(false);
    // And yet a body walks straight through.
    expect(unreachableTiles(area)).toEqual([]);
  });

  it('and says nothing when the gate is open', () => {
    expect(unreachableTiles(twoRooms([]))).toEqual([]);
  });
});

/* ----------------------------------------------------- effects (D-639) --- */

/** A throwaway tree with one area, the given effects, and the given items. */
function validateVfx(vfx: unknown[], items: unknown[] = [], areaVfx: unknown[] = []): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'rc-vfx-'));
  mkdirSync(join(dir, 'areas'), { recursive: true });
  mkdirSync(join(dir, 'vfx'), { recursive: true });
  mkdirSync(join(dir, 'items'), { recursive: true });
  writeFileSync(join(dir, 'areas', 'yard.json'), JSON.stringify({ ...MINIMAL_AREA, vfx: areaVfx }));
  vfx.forEach((v, i) => writeFileSync(join(dir, 'vfx', `v${i}.json`), JSON.stringify(v)));
  items.forEach((it, i) => writeFileSync(join(dir, 'items', `i${i}.json`), JSON.stringify(it)));
  try {
    return validateContent(dir).errors;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const FIRE = { id: 'fire', name: 'Fire', particles: {}, light: {} };
const STAFF = {
  id: 'staff', name: 'Staff', description: 'a stick', category: 'equipment', stackable: false, value: 1,
  equip: { slot: 'both-hands', damage: 1 },
};

describe('effects validator (D-639)', () => {
  it('accepts an effect, an item that shows it and an area that places it', () => {
    const errors = validateVfx([FIRE], [{ ...STAFF, vfx: { held: 'fire' } }], [{ vfx: 'fire', x: 2, y: 2 }]);
    expect(errors.filter((e) => /vfx/.test(e))).toEqual([]);
  });

  it('⚠ refuses an item naming an effect that does not exist — a glow nobody defined is an ordinary sword', () => {
    const errors = validateVfx([FIRE], [{ ...STAFF, vfx: { projectile: { vfx: 'bolt' }, impact: 'burst' } }]);
    expect(errors.some((e) => e.includes("'bolt'"))).toBe(true);
    expect(errors.some((e) => e.includes("'burst'"))).toBe(true);
  });

  it('⚠ refuses an area placing an effect that does not exist — a dark hearth with no error anywhere', () => {
    const errors = validateVfx([FIRE], [], [{ vfx: 'hearth', x: 2, y: 2 }]);
    expect(errors.some((e) => e.includes("'hearth'") && e.includes('vfx[0]'))).toBe(true);
  });

  it('refuses an effect that would draw nothing, and two with one id', () => {
    expect(validateVfx([{ id: 'ghost', name: 'Ghost' }]).some((e) => e.includes('draws nothing'))).toBe(true);
    expect(validateVfx([FIRE, FIRE]).some((e) => e.includes('duplicate vfx id'))).toBe(true);
  });
});
