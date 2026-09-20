import { describe, expect, it } from 'vitest';
import {
  AreaSchema,
  allTransitions,
  derivedTransitions,
  landingBeside,
  markerProblems,
  type AreaDef,
} from '../src/content';

/**
 * Way-markers (D-641): named, placed, linked in pairs — and derived into the
 * one-way doors the server walks, landing BESIDE the partner so nobody
 * bounces straight back.
 */

function room(id: string, markers: AreaDef['markers'] = []): AreaDef {
  return AreaSchema.parse({
    id,
    name: id.toUpperCase(),
    width: 8,
    height: 8,
    legend: { '.': { walkable: true, kind: 'floor' } },
    tiles: Array.from({ length: 8 }, () => '........'),
    spawn: { x: 4, y: 4 },
    markers,
  });
}

const A = room('a', [{ id: 'east', name: 'East door', x: 7, y: 4, to: { area: 'b', marker: 'west' } }]);
const B = room('b', [{ id: 'west', name: 'West door', x: 0, y: 4, to: { area: 'a', marker: 'east' } }]);
const lookup = (id: string): AreaDef | null => ({ a: A, b: B } as Record<string, AreaDef>)[id] ?? null;

describe('a linked pair of markers', () => {
  it('derives a door each way, landing beside the partner and towards the room', () => {
    const fromA = derivedTransitions(A, lookup);
    expect(fromA).toHaveLength(1);
    expect(fromA[0]).toMatchObject({ x: 7, y: 4, toArea: 'b', name: 'East door' });
    // B's marker is at (0,4); the landing is the standable neighbour nearest B's spawn: (1,4).
    expect([fromA[0]!.toX, fromA[0]!.toY]).toEqual([1, 4]);
    const fromB = derivedTransitions(B, lookup);
    expect([fromB[0]!.toX, fromB[0]!.toY]).toEqual([6, 4]);
  });

  it('⚠ never lands ON a marker', () => {
    const landing = landingBeside(B, B.markers[0]!);
    expect(landing).not.toEqual({ x: 0, y: 4 });
  });

  it('passes the checks, and so does an unlinked marker', () => {
    expect(markerProblems(A, lookup)).toEqual([]);
    const loose = room('c', [{ id: 'well', name: 'The well', x: 2, y: 2 }]);
    expect(markerProblems(loose, lookup)).toEqual([]);
    expect(allTransitions(loose, lookup)).toEqual([]);
  });
});

describe('what the checks refuse', () => {
  it('⚠ a one-sided link — the exact defect the rework removes', () => {
    const oneWay = room('b', [{ id: 'west', name: 'West door', x: 0, y: 4 }]);
    const problems = markerProblems(A, (id) => (id === 'b' ? oneWay : lookup(id)));
    expect(problems.some((p) => p.includes('does not link back'))).toBe(true);
    // And the derived door still exists from A — the check is what stops it shipping.
    expect(derivedTransitions(A, (id) => (id === 'b' ? oneWay : lookup(id)))).toHaveLength(1);
  });

  it('a link to an area or a marker that does not exist', () => {
    const bad = room('a', [{ id: 'east', name: 'E', x: 7, y: 4, to: { area: 'nowhere', marker: 'x' } }]);
    expect(markerProblems(bad, lookup).some((p) => p.includes("unknown area 'nowhere'"))).toBe(true);
    const bad2 = room('a', [{ id: 'east', name: 'E', x: 7, y: 4, to: { area: 'b', marker: 'north' } }]);
    expect(markerProblems(bad2, lookup).some((p) => p.includes("'north', which is not in 'b'"))).toBe(true);
  });

  it('two markers with one id, and a marker nobody can stand on', () => {
    const dup = room('a', [
      { id: 'east', name: 'E', x: 7, y: 4 },
      { id: 'east', name: 'E2', x: 6, y: 4 },
    ]);
    expect(markerProblems(dup, lookup).some((p) => p.includes('appears twice'))).toBe(true);
    const walled = AreaSchema.parse({
      ...room('w'),
      legend: { '.': { walkable: true, kind: 'floor' }, '#': { walkable: false, kind: 'wall' } },
      tiles: ['#.......', ...Array.from({ length: 7 }, () => '........')],
      markers: [{ id: 'm', name: 'M', x: 0, y: 0 }],
    });
    expect(markerProblems(walled, lookup).some((p) => p.includes('not somewhere a body can stand'))).toBe(true);
  });
});
