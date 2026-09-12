import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AreaSchema, Nav, areaCollision, canStandAt, distance, stepTo } from '@rc/shared';
import { loadContent } from '@rc/server/content';
import { GameServer } from '@rc/server/net/gateway';
import { MemoryStore } from '@rc/server/store/memory';
import { BotClient } from '../src/botClient';
import { walkTo } from '../src/walk';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The proving ground: one map that exercises all four collision behaviours
 * (D-567) with an actor walking them.
 *
 * ⚠ This is the test that would have caught the whole class of failure this
 * milestone kept producing. Every piece of D-567 has unit tests and every one
 * of them passed while a character could not actually be sent through a door,
 * because the pieces were verified apart: the model, the index, the server,
 * the wire and the client each worked and none of them had been asked to work
 * TOGETHER on a real map. An actor walking a real area is the only assertion
 * that covers the joins.
 */

const contentDir = fileURLToPath(new URL('../../content', import.meta.url));
const AREA = 'proving-ground';

const area = AreaSchema.parse(
  JSON.parse(readFileSync(join(contentDir, 'areas', `${AREA}.json`), 'utf8')),
);

let store: MemoryStore;
let server: GameServer;

beforeAll(async () => {
  store = new MemoryStore();
  server = new GameServer({ store, content: loadContent(contentDir), port: 0 });
  await server.start();
});

afterAll(async () => {
  await server.stop();
});

describe('the map itself says what it should', () => {
  it('is built from pack assets and almost nothing else', () => {
    expect(area.assets.length).toBeGreaterThan(5);
    // ⚠ Every one of them carries an authored mask, OR SAYS IT MEANT NOT TO.
    // Nothing in this map is shaped by anything but a pack mesh — the 44
    // procedural prop types are gone from the schema entirely (D-567).
    //
    // ⚠ This used to demand a mask on every asset full stop, and that became
    // wrong when maps grew walk-through decoration (D-592): a tuft of grass
    // you cannot step past is worse than no tuft of grass. But an empty mask
    // is ALSO what a forgotten bake looks like, and that shipped a town full
    // of walk-through walls once (D-584). `overrideCollision` is exactly the
    // difference between the two, which is what it was added for.
    const unmasked = area.assets.filter(
      (a) => a.collision.length === 0 && !a.overrideCollision,
    );
    expect(unmasked).toEqual([]);
    // And the map is still mostly things you bump into, not a field of grass.
    expect(area.assets.some((a) => a.collision.length > 0)).toBe(true);
  });

  it('offers all four behaviours to walk', () => {
    const volumes = areaCollision(area).volumes;
    const ramps = volumes.filter((v) => v.ramp);
    const surfaces = volumes.filter((v) => v.walkable && !v.ramp && v.top > 0.1);
    const walls = volumes.filter((v) => !v.walkable && v.base === 0 && v.top > 2);
    const overhead = volumes.filter((v) => v.base >= 1.8);
    expect(ramps.length, 'nothing to walk up').toBeGreaterThan(0);
    expect(surfaces.length, 'nothing to stand on').toBeGreaterThan(0);
    expect(walls.length, 'nothing to be stopped by').toBeGreaterThan(0);
    expect(overhead.length, 'nothing to walk under').toBeGreaterThan(0);
  });
});

describe('a body can walk it', () => {
  const nav = new Nav(areaCollision(area));

  /** Walk a route with the collision model and report the first refusal. */
  function walk(route: readonly { x: number; y: number }[]): string | null {
    let at = { pos: route[0]!, z: 0 };
    for (let i = 1; i < route.length; i++) {
      const steps = Math.max(1, Math.ceil(distance(route[i - 1]!, route[i]!) / 0.1));
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const to = {
          x: route[i - 1]!.x + (route[i]!.x - route[i - 1]!.x) * t,
          y: route[i - 1]!.y + (route[i]!.y - route[i - 1]!.y) * t,
        };
        const next = stepTo(areaCollision(area), at, to);
        if (!next) return `blocked at (${to.x.toFixed(1)}, ${to.y.toFixed(1)})`;
        at = next;
      }
    }
    return null;
  }

  it('gets into the walled room, which means through its doorway', () => {
    // The room is north of the wall run at y=12; the doorway is its only way in.
    const route = nav.path({ x: 10, y: 20 }, { x: 10, y: 8 });
    expect(route, 'no way into the room at all').not.toBeNull();
    expect(walk([{ x: 10, y: 20 }, ...route!])).toBeNull();
    // ⚠ And it really did pass between the JAMBS rather than round the outside.
    // Tested on where the route CROSSES the wall line, not on its waypoints: a
    // pulled path has no waypoint in the doorway at all, because it can see
    // straight through it (D-567). Looking for a waypoint there fails on a
    // perfectly good route and says nothing about where it went.
    const full = [{ x: 10, y: 20 }, ...route!];
    let crossing: number | null = null;
    for (let i = 1; i < full.length; i++) {
      const a = full[i - 1]!;
      const b = full[i]!;
      if (a.y > 12 !== b.y > 12) crossing = a.x + ((b.x - a.x) * (12 - a.y)) / (b.y - a.y);
    }
    expect(crossing, 'the route never crossed the wall line').not.toBeNull();
    expect(Math.abs(crossing! - 10), `crossed at x=${crossing?.toFixed(2)}`).toBeLessThan(0.5);
  });

  it('is stopped by the wall either side of that doorway', () => {
    expect(canStandAt(area, { x: 6, y: 12 })).toBe(false);
    expect(canStandAt(area, { x: 14, y: 12 })).toBe(false);
  });

  it('walks UNDER the arch without going round it', () => {
    const route = nav.path({ x: 23, y: 5 }, { x: 23, y: 11 })!;
    expect(route).not.toBeNull();
    expect(walk([{ x: 23, y: 5 }, ...route])).toBeNull();
    // A detour would be far longer than the 6m straight line.
    let length = distance({ x: 23, y: 5 }, route[0]!);
    for (let i = 1; i < route.length; i++) length += distance(route[i - 1]!, route[i]!);
    expect(length, 'it went round rather than under').toBeLessThan(8);
  });

  it('⚠ reaches the platform ONLY by the stair', () => {
    // The platform top is 2m; nothing else touches it. If this ever passes
    // with the stair removed, the step rule has stopped biting.
    const onto = nav.path({ x: 23, y: 25 }, { x: 23, y: 15 });
    expect(onto, 'the stair was not used').not.toBeNull();
    const climbed = walk([{ x: 23, y: 25 }, ...onto!]);
    expect(climbed).toBeNull();

    const bare = { ...area, assets: area.assets.filter((a) => !a.asset.includes('stairs')) };
    const strandedNav = new Nav(areaCollision(AreaSchema.parse(bare)));
    expect(strandedNav.path({ x: 23, y: 25 }, { x: 23, y: 15 })).toBeNull();
  });

  it('walks OVER the kerb and ends up standing on it', () => {
    const after = stepTo(areaCollision(area), { pos: { x: 10, y: 22 }, z: 0 }, { x: 10, y: 24 });
    expect(after).not.toBeNull();
    expect(after!.z).toBeGreaterThan(0.1);
  });
});

describe('the wire carries what the client needs to draw it', () => {
  it('sends every placed asset with the snapshot', async () => {
    const bot = await BotClient.connect(`ws://127.0.0.1:${server.port}`);
    bot.send({ t: 'register', username: 'prove_walker', password: 'password-word' });
    await bot.expect('auth_ok');
    bot.send({
      t: 'create_character',
      name: 'Wen Aldren',
      appearanceSeed: 4242,
      classId: 'man-at-arms',
      build: { attributes: {}, skills: {}, feats: [], spells: [] },
    } as never);
    const characterId = (await bot.expect('character_created')).character.id;
    await store.saveCharacterPosition(characterId, AREA, 10, 20);
    bot.send({ t: 'enter_world', characterId });
    const snap = await bot.expect('snapshot');

    expect(snap.area.id).toBe(AREA);
    expect(snap.area.assets).toHaveLength(area.assets.length);
    const wall = snap.area.assets.find((a) => a.asset === 'sm-env-wall-01-alt');
    expect(wall, 'the walls did not reach the client').toBeDefined();
    expect(wall).toMatchObject({ pack: 'dungeon-pack' });
    // ⚠ The mask is NOT on the wire. The client has no pathfinder any more and
    // shipping a few hundred volumes per area would be paying bandwidth for a
    // question it is no longer allowed to answer.
    expect(wall).not.toHaveProperty('collision');
    await bot.close();
  });

  it('⚠ walks an ACTOR through the doorway, server-pathed end to end', async () => {
    const bot = await BotClient.connect(`ws://127.0.0.1:${server.port}`);
    bot.send({ t: 'register', username: 'prove_door', password: 'password-word' });
    await bot.expect('auth_ok');
    bot.send({
      t: 'create_character',
      name: 'Ordo Kell',
      appearanceSeed: 99,
      classId: 'man-at-arms',
      build: { attributes: {}, skills: {}, feats: [], spells: [] },
    } as never);
    const characterId = (await bot.expect('character_created')).character.id;
    await store.saveCharacterPosition(characterId, AREA, 10, 20);
    bot.send({ t: 'enter_world', characterId });
    await bot.expect('snapshot');

    // Into the room, which is only possible through the doorway.
    await walkTo(bot, 10, 8, { timeoutMs: 25_000 });
    const me = bot.entities.get(bot.you!)!;
    expect(distance(me, { x: 10, y: 8 })).toBeLessThan(1.5);
    // And nothing the server reported ever put the body inside a jamb.
    expect(bot.violations).toEqual([]);
    await bot.close();
  });
});
