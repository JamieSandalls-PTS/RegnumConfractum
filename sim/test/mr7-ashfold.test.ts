import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { distance } from '@rc/shared';
import { loadContent } from '@rc/server/content';
import { GameServer } from '@rc/server/net/gateway';
import { MemoryStore } from '@rc/server/store/memory';
import { BotClient } from '../src/botClient';
import { walkTo } from '../src/walk';
import { TICK_INTERVAL_MS } from '../src/testTick';

/**
 * Ashfold, walked (D-584).
 *
 * ⚠ A designed map is not finished when it validates. CI's flood proves every
 * tile is reachable in principle; it says nothing about whether a body can get
 * through the gate it is looking at, because the flood tests tiles and a
 * player is a circle with a radius squeezing between two gateposts. The first
 * version of this town passed the flood with one of its two north road tiles
 * unusable — the gate looked open and was half shut.
 *
 * So this is the proving-ground treatment applied to the town people actually
 * play in: an actor walks the errands the round is made of, and the route the
 * SERVER finds is the assertion.
 */

const contentDir = fileURLToPath(new URL('../../content', import.meta.url));

let store: MemoryStore;
let server: GameServer;
let url = '';
const bots: BotClient[] = [];

async function arrive(bot: BotClient, x: number, y: number, what: string): Promise<void> {
  await walkTo(bot, x, y, { timeoutMs: 40_000 });
  const me = bot.entities.get(bot.you!)!;
  expect(distance(me, { x, y }), `could not reach ${what} at (${x},${y})`).toBeLessThan(1.6);
}

async function newBot(name: string): Promise<BotClient> {
  const bot = await BotClient.connect(url);
  bots.push(bot);
  bot.send({ t: 'register', username: name, password: 'password-word' });
  await bot.expect('auth_ok');
  bot.send({ t: 'create_character', name: `Walker ${name.slice(-3).toUpperCase()}`, appearanceSeed: 5 });
  const characterId = (await bot.expect('character_created')).character.id;
  bot.send({ t: 'enter_world', characterId });
  await bot.expect('snapshot');
  return bot;
}

beforeAll(async () => {
  store = new MemoryStore();
  server = new GameServer({
    store,
    content: loadContent(contentDir),
    port: 0,
    tickIntervalMs: TICK_INTERVAL_MS,
    rngSeed: 11,
    defaultAreaId: 'round-town',
  });
  await server.start();
  url = `ws://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  for (const b of bots) b.close();
  await server.stop();
});

describe('a body can walk Ashfold (D-584)', () => {
  it('reaches all four facilities from where the round opens', async () => {
    // ⚠ The errand the whole town exists for. Using a facility is never
    // required (D-530), so reaching one must never be awkward — and every
    // building here was placed BEHIND its station for exactly this reason.
    const bot = await newBot('ash_facilities');
    await arrive(bot, 24, 34, 'the well');
    await arrive(bot, 10, 8, 'the workshop');
    await arrive(bot, 40, 8, 'the storehouse');
    await arrive(bot, 10, 43, 'the infirmary');
    expect(bot.violations).toEqual([]);
  }, 120_000);

  it('⚠ gets out through every gate, on BOTH road tiles', async () => {
    // ⚠ Both tiles, deliberately. A gate's mesh has one box the size of its
    // footprint, so an archway blocks its own opening unless somebody masks it
    // by hand — and a mask that is nearly right leaves one of the two road
    // tiles unstandable. The map validates either way; only walking finds it.
    const bot = await newBot('ash_gates');
    for (const [x, y, what] of [
      [24, 1, 'the north gate, west tile'],
      [25, 1, 'the north gate, east tile'],
      [24, 48, 'the south gate, west tile'],
      [25, 48, 'the south gate, east tile'],
      [1, 24, 'the west gate, north tile'],
      [1, 25, 'the west gate, south tile'],
      [48, 24, 'the east gate, north tile'],
      [48, 25, 'the east gate, south tile'],
    ] as [number, number, string][]) {
      await arrive(bot, x, y, what);
    }
    expect(bot.violations).toEqual([]);
  }, 180_000);

  it('crosses the square corner to corner without being wedged', async () => {
    // The square is where the dawn truce happens (D-536) and where the market
    // stands. Furniture placed by hand is furniture that can box somebody in.
    const bot = await newBot('ash_square');
    await arrive(bot, 20, 20, 'the north-west corner of the square');
    await arrive(bot, 30, 30, 'the south-east corner of the square');
    await arrive(bot, 30, 20, 'the north-east corner of the square');
    await arrive(bot, 20, 30, 'the south-west corner of the square');
    expect(bot.violations).toEqual([]);
  }, 120_000);
});
