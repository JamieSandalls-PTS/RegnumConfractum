import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONTENT_ROUTES, buildsFor, reloadTierFor, routeFor } from '../src/pipeline';

/**
 * Authored implies reachable (D-630).
 *
 * ⚠ Every directory under `content/` must declare how it reaches the game.
 * Two of them — animations and garments — were authored, schema-checked in
 * CI, editable in the tool, and read by NOTHING the game runs for months
 * (D-576, D-578 found them one at a time). A type with no route here is the
 * next one of those, and this test is the build refusing to let it be quiet.
 */

const contentDir = fileURLToPath(new URL('../../content', import.meta.url));

describe('the content pipeline', () => {
  it('⚠ names a route for every directory under content/', () => {
    const dirs = readdirSync(contentDir)
      .filter((d) => !d.startsWith('.') && statSync(join(contentDir, d)).isDirectory())
      .sort();
    const unrouted = dirs.filter((d) => !routeFor(d));
    expect(unrouted, 'content directories with no declared route to the game').toEqual([]);
    // And no route for a directory that does not exist — a stale entry looks
    // like coverage.
    const ghosts = CONTENT_ROUTES.map((r) => r.dir).filter((d) => !dirs.includes(d));
    expect(ghosts, 'routes for directories that are not there').toEqual([]);
  });

  it('every route says what reads it', () => {
    for (const r of CONTENT_ROUTES) expect(r.reader.length, r.dir).toBeGreaterThan(8);
  });

  it('collects the builds a set of saves needs, in build order, once each', () => {
    expect(buildsFor(['items', 'classes'])).toEqual([]);
    expect(buildsFor(['areas', 'stations', 'npcs'])).toEqual(['environment']);
    expect(buildsFor(['areas', 'garments'])).toEqual(['characters', 'environment']);
  });

  it('reports the strictest reload tier among the saves', () => {
    expect(reloadTierFor(['items'])).toBe('hot');
    expect(reloadTierFor(['items', 'areas'])).toBe('warm');
    expect(reloadTierFor(['scripts', 'items'])).toBe('restart');
    expect(reloadTierFor(['garments'])).toBe('client');
    // Animations were client-only until D-630 put them on the wire.
    expect(reloadTierFor(['animations'])).toBe('hot');
    // Unknown means "nobody said", which is the strictest answer.
    expect(reloadTierFor(['no-such-dir'])).toBe('restart');
  });
});
