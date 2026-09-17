import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HUNGER_STEP_HOURS, ObjectiveSchema, type ObjectiveDef } from '@rc/shared';
import { loadContent } from '@rc/server/content';
import { GameServer } from '@rc/server/net/gateway';
import { MemoryStore } from '@rc/server/store/memory';
import { BotClient } from '../src/botClient';
import { TICK as SIM_TICK, sleep } from '../src/testTick';

/** The town, read from content so a map change cannot silently move a bot
 * into a wall — where an unwalkable spawn is relocated to the area spawn. */
const TOWN = loadContent(fileURLToPath(new URL('../../content', import.meta.url)))
  .areas.get('round-town')!;

/**
 * Starvation kills (D-534, amending D-526's plateau for hunger).
 *
 * This lives in its own file with its own server on purpose: a death ends the
 * round, which resets every need — so any assertion sharing a round with a
 * starving bot is measuring the reset rather than the need. That cost an
 * afternoon once already.
 *
 * What matters is that it is SLOW AND LOUD. A full day of neglect before the
 * damage starts, hours more before it is fatal, and a notice at every step.
 * Nobody should be surprised by it, and anybody can be fed by anybody.
 */

const contentDir = fileURLToPath(new URL('../../content', import.meta.url));
const TICK = SIM_TICK; // see sim/src/testTick.ts (D-633)

async function waitUntil(pred: () => boolean, what: string, timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(15);
  }
  throw new Error(`timed out waiting until ${what}`);
}

const SURVIVE: ObjectiveDef = ObjectiveSchema.parse({
  id: 'test-survive',
  name: 'Endure',
  brief: 'Live.',
  kind: { type: 'survive' },
  minCast: 2,
});

let store: MemoryStore;
let server: GameServer;
let faster: BotClient;
let other: BotClient;

beforeAll(async () => {
  store = new MemoryStore();
  server = new GameServer({
    store,
    content: loadContent(contentDir),
    port: 0,
    tickIntervalMs: TICK,
    rngSeed: 41,
    defaultAreaId: 'round-town',
    bleedIntervalTicks: 100_000,
    round: {
      enabled: true,
      // ⚠ This fixture stands characters in a chosen area with
      // `saveCharacterPosition` and asserts what they can see from there, so
      // it opts OUT of D-608's rule that an arrival is placed at the round's
      // opening point and reset. The rule is right for players joining a
      // game and wrong for a fixture whose whole question is 'what happens
      // to a body standing HERE'.
      placeArrivals: false,
      lengthTicks: 400_000,
      minCast: 2,
      // No dawn truce here (D-536): this suite is not about it, and a
      // 60-second peace at the round's opening would only add dead time.
      graceTicks: 0,
      seed: 'starve-test',
      dayTicks: 240, // a game hour every 10 ticks
      objectives: [SURVIVE],
      resolutionTicks: 10,
    },
  });
  await server.start();
  const url = `ws://127.0.0.1:${server.port}`;
  const join = async (bot: BotClient, user: string, name: string, seed: number, x: number) => {
    bot.send({ t: 'register', username: user, password: 'password-word' });
    await bot.expect('auth_ok');
    bot.send({ t: 'create_character', name, appearanceSeed: seed });
    const id = (await bot.expect('character_created')).character.id;
    // Clear of the storehouse and the well: standing at a facility stretches
    // the need clock, which is the opposite of what this test measures.
    await store.saveCharacterPosition(id, 'round-town', x, TOWN.height - 6);
    bot.send({ t: 'enter_world', characterId: id });
    await bot.expect('snapshot');
  };
  faster = await BotClient.connect(url);
  other = await BotClient.connect(url);
  await join(faster, 'starve_one', 'Wick Harrow', 931, Math.floor(TOWN.width / 2));
  await join(other, 'starve_two', 'Lome Fennick', 932, Math.floor(TOWN.width / 2) + 4);
  await waitUntil(() => faster.roundState?.phase === 'running', 'the round begins');
});

afterAll(async () => {
  faster?.close();
  other?.close();
  await server.stop();
});

describe('a full day empties it, and then it kills', () => {
  it('warns at every stage on the way down', async () => {
    await waitUntil(() => faster.status?.hunger === 'gnawing', 'the first pang');
    await waitUntil(() => faster.status?.hunger === 'severe', 'proper hunger');
    await waitUntil(() => faster.status?.hunger === 'starving', 'a full day without food');
    // Each step announced itself. Being killed by something silent would be
    // the failure here, not being killed.
    const said = faster.narrations.join(' | ');
    expect(said).toMatch(/stomach has started to complain/);
    expect(said).toMatch(/twice as long/);
    expect(said).toMatch(/full day without food/);
  });

  it('takes a full day of hours to get there, not a handful', () => {
    // Three stages at eight game hours each: sated at dawn, starving at the
    // next dawn (stakeholder ruling).
    expect(HUNGER_STEP_HOURS * 3).toBe(24);
  });

  it('only starts costing health AFTER it reaches starving', async () => {
    const hp = faster.status!.hp;
    expect(hp).toBeGreaterThan(0);
    await waitUntil(() => (faster.status?.hp ?? 99) < hp, 'the bleeding out begins');
  });

  it('finishes the job', async () => {
    await waitUntil(() => faster.status?.ghost === true, 'starvation kills', 40_000);
    expect(faster.status!.ghost).toBe(true);
  });
});
