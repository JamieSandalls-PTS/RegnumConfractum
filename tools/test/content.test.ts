import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AreaSchema } from '@rc/shared';
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

const MINIMAL_AREA = {
  id: 'test-yard',
  name: 'Test Yard',
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
