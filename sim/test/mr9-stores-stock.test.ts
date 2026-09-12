import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectiveSchema, type ObjectiveDef } from '@rc/shared';
import { loadContent } from '@rc/server/content';
import { GameServer } from '@rc/server/net/gateway';
import { MemoryStore } from '@rc/server/store/memory';
import { BotClient } from '../src/botClient';

/**
 * The town opens stocked, and the stock RUNS OUT (D-529, built D-593).
 *
 * ⚠ This is the constraint D-529 identified and D-533 recorded as still
 * unmet: **hiding in town beats the clock unless the storehouse runs out.**
 * Bread is craftable from grain and grain is on the farm, so the pressure
 * existed in principle — but nothing stocked the town with a starting supply,
 * so a cast that began with full bellies felt no pressure until the first
 * hunger step, and what it felt then was pressure to CRAFT rather than to
 * leave. A larder that starts full and empties is what makes the back half of
 * a round a reason to go outside.
 *
 * ⚠ The properties are SUPPLY and DEPLETION, not "there is food in it":
 * it starts stocked in proportion to the cast, nothing refills it, and taking
 * it out leaves less. Its own file with its own fixture because all three are
 * properties of a round's OPENING — appended to the end of `mr6-stores` they
 * ran after a sibling had already reset the round, and two of them passed
 * against an empty larder, which is the shape of a test that proves nothing.
 */

const contentDir = fileURLToPath(new URL('../../content', import.meta.url));
const TICK = 5;
const CAST = 3;
const STORE = 'round-town:storehouse';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SURVIVE: ObjectiveDef = ObjectiveSchema.parse({
  id: 'test-survive', name: 'Endure', brief: 'Live.',
  kind: { type: 'survive' }, minCast: CAST,
});

let store: MemoryStore;
let server: GameServer;
const bots: BotClient[] = [];

async function waitUntil(pred: () => boolean, what: string, ms = 15_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (pred()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting until ${what}`);
}

beforeAll(async () => {
  store = new MemoryStore();
  server = new GameServer({
    store,
    content: loadContent(contentDir),
    port: 0,
    tickIntervalMs: TICK,
    rngSeed: 31,
    defaultAreaId: 'round-town',
    round: {
      enabled: true,
      lengthTicks: 200_000,
      minCast: CAST,
      dayTicks: 400_000,   // daylight throughout; roamers are not the subject
      graceTicks: 0,
      seed: 'mr9-stock',
      objectives: [SURVIVE],
      resolutionTicks: 10,
    },
  });
  await server.start();
  const url = `ws://127.0.0.1:${server.port}`;
  for (let i = 0; i < CAST; i++) {
    const bot = await BotClient.connect(url);
    bots.push(bot);
    bot.send({ t: 'register', username: `stock_${i}`, password: 'password-word' });
    await bot.expect('auth_ok');
    bot.send({ t: 'create_character', name: `Larder Hand${'X'.repeat(i)}`, appearanceSeed: 810 + i });
    const id = (await bot.expect('character_created')).character.id;
    bot.send({ t: 'enter_world', characterId: id });
    await bot.expect('snapshot');
  }
  await waitUntil(() => bots[0]!.roundState?.phase === 'running', 'the round starts');
});

afterAll(async () => {
  for (const b of bots) b.close();
  await server?.stop();
});

describe('a town that starts with a larder', () => {
  it('opens the round with food already pooled, scaled to the cast', async () => {
    const food = (await store.getItemsByStore(STORE))
      .filter((i) => i.templateId === 'coarse-bread');
    // Two meals a head (D-593): enough to carry the first day of two and a
    // half, and gone before the end.
    expect(food.length).toBe(CAST * 2);
  });

  it('is not refilled by the round going on', async () => {
    // ⚠ The half that makes it a constraint rather than a larder. A stock that
    // quietly replenished would look identical for the first minute and undo
    // the whole ruling.
    const before = (await store.getItemsByStore(STORE)).length;
    await sleep(TICK * 150);
    expect((await store.getItemsByStore(STORE)).length).toBe(before);
  });

  it('runs out when the cast takes it, and stays out', async () => {
    const bot = bots[0]!;
    const station = loadContent(contentDir).areas.get('round-town')!
      .stations!.find((s) => s.type === 'storehouse')!;
    bot.send({ t: 'move_to', x: station.x, y: station.y - 1 });
    await waitUntil(() => {
      const me = bot.entities.get(bot.you!);
      return !!me && Math.hypot(me.x - station.x, me.y - (station.y - 1)) < 1.2;
    }, 'the bot reaches the storehouse', 25_000);

    for (let guard = 0; guard < 40; guard++) {
      const loaf = (await store.getItemsByStore(STORE))
        .find((i) => i.templateId === 'coarse-bread');
      if (!loaf) break;
      bot.send({ t: 'store_withdraw', itemId: loaf.id });
      await sleep(TICK * 8);
      if ((await store.getItemsByStore(STORE)).some((i) => i.id === loaf.id)) {
        throw new Error(`the stores refused to give up ${loaf.id}: ${
          JSON.stringify(bot.errors.slice(-1))}`);
      }
    }
    expect((await store.getItemsByStore(STORE))
      .filter((i) => i.templateId === 'coarse-bread')).toEqual([]);
    await sleep(TICK * 80);
    expect((await store.getItemsByStore(STORE))
      .filter((i) => i.templateId === 'coarse-bread')).toEqual([]);
  }, 60_000);
});
