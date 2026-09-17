import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AreaSchema,
  DIRECTION_VECTORS,
  SEAT_REACH,
  sitterFacingFor,
} from '@rc/shared';
import { loadContent } from '@rc/server/content';
import { GameServer } from '@rc/server/net/gateway';
import { MemoryStore } from '@rc/server/store/memory';
import { BotClient } from '../src/botClient';

/**
 * Sitting on a chair (D-605).
 *
 * ⚠ Chairs were a TILE KIND drawn by the terrain as procedural geometry — an
 * instanced box whose angle was guessed from the neighbouring table. They were
 * the last furniture D-567 left behind, and they could not be sat on because
 * they were not things, only a kind of floor.
 *
 * ⚠ The assertion that matters is the FACING. Sitting used to be `*sits down*`
 * typed anywhere, so a character sat facing whatever way they walked in from —
 * and on a chair against a wall the sit-down animation plays into the
 * backrest. The seat's own rotation is the only thing that knows which way is
 * forward for it, which is why the server does the turning and not the client.
 */

const contentDir = fileURLToPath(new URL('../../content', import.meta.url));
const TICK = 5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let store: MemoryStore;
let server: GameServer;
let bot: BotClient;
let me: number;

const tavern = AreaSchema.parse(
  JSON.parse(readFileSync(`${contentDir}/areas/hanged-ferryman.json`, 'utf8')),
);
const seats = tavern.assets.filter((a) => a.seat);

/**
 * How big each placed mesh actually is, `pack/id` → its extent in metres.
 *
 * ⚠ Read from the asset catalogue rather than restated here. These numbers are
 * what the room is laid out against, and a second copy of them in a test is a
 * second copy that goes stale the first time somebody swaps a mesh.
 */
const measured = new Map<string, { length: number; depth: number }>();
for (const file of readdirSync(`${contentDir}/assets`)) {
  if (!file.endsWith('.environment.json')) continue;
  const doc = JSON.parse(readFileSync(`${contentDir}/assets/${file}`, 'utf8')) as {
    pack: string;
    assets: { id: string; size?: [number, number, number] }[];
  };
  for (const a of doc.assets) {
    if (a.size) measured.set(`${doc.pack}/${a.id}`, { length: a.size[0], depth: a.size[2] });
  }
}

beforeAll(async () => {
  store = new MemoryStore();
  server = new GameServer({
    store,
    content: loadContent(contentDir),
    port: 0,
    tickIntervalMs: TICK,
    rngSeed: 11,
    defaultAreaId: 'hanged-ferryman',
  });
  await server.start();
  bot = await BotClient.connect(`ws://127.0.0.1:${server.port}`);
  bot.send({ t: 'register', username: 'sitter', password: 'password-word' });
  await bot.expect('auth_ok');
  bot.send({ t: 'create_character', name: 'Hale Otwin', appearanceSeed: 5 });
  const id = (await bot.expect('character_created')).character.id;
  bot.send({ t: 'enter_world', characterId: id });
  await bot.expect('snapshot');
  me = bot.you!;
});

afterAll(async () => {
  bot?.close();
  await server?.stop();
});

async function walkTo(x: number, y: number, within = 0.35): Promise<void> {
  bot.send({ t: 'move_to', x, y });
  for (let i = 0; i < 300; i++) {
    const e = bot.entities.get(me);
    if (e && Math.hypot(e.x - x, e.y - y) <= within) break;
    await sleep(TICK * 4);
  }
  bot.send({ t: 'move_stop' });
  await sleep(TICK * 6);
}

describe('the taproom has chairs, and they are objects', () => {
  it('places real seats rather than a kind of floor', () => {
    expect(seats.length).toBeGreaterThan(0);
    // ⚠ No `chair` tile kind survives. Two chairs — one drawn by the terrain
    // from a tile and one standing there as a mesh — is what a half-done
    // migration looks like on screen.
    const kinds = new Set(Object.values(tavern.legend).map((d) => d.kind));
    expect(kinds.has('chair')).toBe(false);
  });

  it('lets a body occupy the seat, or nobody could sit in one', () => {
    // ⚠ An empty mask, set deliberately. The catalogue calls a chair solid,
    // which is true of a chair and wrong for a taproom: CI floods every map
    // and fails the build on a tile nobody can reach.
    for (const seat of seats) {
      expect(seat.collision).toEqual([]);
      expect(seat.overrideCollision).toBe(true);
    }
  });

  it('faces the sitter the way the CHAIR faces, whichever chair it is', async () => {
    // ⚠ Two chairs that face DIFFERENT ways, each sat in from wherever the
    // path happens to arrive. One chair proves nothing -- the approach could
    // agree with the seat by luck -- and two that disagree with each other
    // cannot both be a coincidence.
    //
    // ⚠ Walked ONTO the seat rather than up to it. The first cut of this
    // test stood "one tile south" of a chair whose table is south of it, so
    // the route ran into the table and stopped 1.88m away; the server refused
    // at 1.6m and the test failed on its own geometry rather than on the code.
    const byFacing = new Map<number, typeof seats[number]>();
    for (const s2 of seats) if (!byFacing.has(s2.rotation)) byFacing.set(s2.rotation, s2);
    const chosen = [...byFacing.values()].slice(0, 2);
    expect(chosen.length).toBe(2);
    expect(chosen[0]!.rotation).not.toBe(chosen[1]!.rotation);

    for (const seat of chosen) {
      await walkTo(seat.x, seat.y, 0.4);
      bot.drain('error');
      bot.send({ t: 'sit', x: seat.x, y: seat.y });
      await sleep(TICK * 12);
      const after = bot.entities.get(me)!;
      expect(bot.errors.map((e) => e.code)).toEqual([]);
      expect(after.posture).toBe('sitting');
      expect(after.facing).toBe(sitterFacingFor(seat.rotation));
      // And put down ON the seat, not beside it.
      expect(Math.hypot(after.x - seat.x, after.y - seat.y)).toBeLessThan(0.01);
    }
  }, 60_000);

  it('REFUSES a chair across the room', async () => {
    const seat = seats[0]!;
    const far = seats.reduce((f, s) => (
      Math.hypot(s.x - seat.x, s.y - seat.y) > Math.hypot(f.x - seat.x, f.y - seat.y) ? s : f
    ), seat);
    await walkTo(seat.x, seat.y);
    bot.drain('error');
    bot.send({ t: 'sit', x: far.x, y: far.y });
    const err = await bot.expect('error');
    // ⚠ Without this, "sit on that chair over there" is a teleport with a
    // nicer name — the one movement exploit every click-to-move game ships at
    // least once.
    expect(err.code).toBe('not_adjacent');
    expect(Math.hypot(far.x - seat.x, far.y - seat.y)).toBeGreaterThan(SEAT_REACH);
  }, 30_000);

  it('refuses a point with nothing to sit on', async () => {
    bot.drain('error');
    bot.send({ t: 'sit', x: tavern.spawn.x, y: tavern.spawn.y });
    const err = await bot.expect('error');
    expect(err.code).toBe('bad_target');
  });
});

describe('a chair is not backwards (D-609)', () => {
  it('⚠ seats every sitter LOOKING AT THE TABLE', () => {
    // ⚠ This is the assertion that was missing, and its absence is why the
    // whole taproom could be wrong with the suite green. The test above checks
    // the SERVER against the convention ("facing matches the seat's rotation")
    // — which stays true no matter which way round the convention is. It
    // cannot see that the convention itself disagrees with the art.
    //
    // This checks the convention against the ROOM: a chair is drawn at its
    // `rotation` like every other placed object (D-567), so the person in it
    // must end up looking at the thing the chair is drawn up to. Turn either
    // the mesh or the sitter alone and this fails; turn both and it is
    // genuinely still a chair at a table.
    expect(seats.length).toBeGreaterThan(0);
    const notAtATable: string[] = [];
    for (const seat of seats) {
      const look = DIRECTION_VECTORS[sitterFacingFor(seat.rotation)];
      const tx = Math.round(seat.x + look.x);
      const ty = Math.round(seat.y + look.y);
      // ⚠: a table is an OBJECT now, not a tile kind (D-618). The tile
      // under it is plain board, so asking the legend what is there answers
      // "wood" for every chair in the room. The property under test has not
      // changed -- a sitter faces the table -- only what a table IS.
      //
      // ⚠ And a table is THREE TILES LONG, which is why this asks about its
      // FOOTPRINT rather than its placement point (D-625). The pack's trestle
      // measures 2.95m; the first version of this assertion compared the
      // looked-at tile against the single coordinate the table is placed at,
      // so a stool drawn up to either END of one was judged to be looking at
      // nothing. Thirty of thirty-three seats failed a room that was right.
      // The size comes from the same measured catalogue the room is authored
      // against, so the two cannot drift apart.
      const table = tavern.assets.some((a) => {
        if (!/table/.test(a.asset)) return false;
        const size = measured.get(`${a.pack}/${a.asset}`);
        if (!size) return Math.round(a.x) === tx && Math.round(a.y) === ty;
        // Rotated placements swap the axes, exactly as `transformVolume` does.
        const turned = Math.round(a.rotation / 90) % 2 !== 0;
        const halfX = ((turned ? size.depth : size.length) * a.scale) / 2;
        const halfY = ((turned ? size.length : size.depth) * a.scale) / 2;
        return Math.abs(a.x - tx) <= halfX && Math.abs(a.y - ty) <= halfY;
      });
      if (!table) {
        notAtATable.push(`(${seat.x},${seat.y}) yaw ${seat.rotation} looks at nothing`);
      }
    }
    expect(notAtATable, 'every chair is drawn up to its table').toEqual([]);
  });
});
