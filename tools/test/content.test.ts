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
