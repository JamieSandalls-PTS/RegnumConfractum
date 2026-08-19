import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectiveSchema, type ObjectiveDef } from '@rc/shared';
import { loadContent } from '@rc/server/content';
import { GameServer } from '@rc/server/net/gateway';
import { MemoryStore } from '@rc/server/store/memory';
import { BotClient } from '../src/botClient';

/**
 * The dawn truce (D-536).
 *
 * Sixty seconds at the round's opening and every dawn where the day does not
 * begin: the clock stops, and nobody can strike, be struck, starve or leave.
 * It exists because the Round is a game about people talking to each other
 * and a mode that never stops moving never lets them.
 *
 * The assertions worth having are the PROHIBITIONS, because each one is a way
 * the truce could be quietly incomplete — and a truce with a hole in it is
 * worse than none, since players will have planned around it.
 */

const contentDir = fileURLToPath(new URL('../../content', import.meta.url));
const TICK = 5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(pred: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting until ${what}`);
}

const SURVIVE: ObjectiveDef = ObjectiveSchema.parse({
  id: 'test-survive', name: 'Endure', brief: 'Live.',
  kind: { type: 'survive' }, minCast: 2,
});

let store: MemoryStore;
let server: GameServer;
let a: BotClient;
let b: BotClient;

beforeAll(async () => {
  store = new MemoryStore();
  server = new GameServer({
    store,
    content: loadContent(contentDir),
    port: 0,
    tickIntervalMs: TICK,
    rngSeed: 41,
    defaultAreaId: 'round-town',
    attackCooldownTicks: 2,
    bleedIntervalTicks: 100_000,
    round: {
      enabled: true,
      lengthTicks: 200_000,
      minCast: 2,
      seed: 'grace-test',
      dayTicks: 2400,
      // Long enough to assert against, short enough to finish the suite.
      graceTicks: 900,
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
    // Beside each other, and beside the town's south gate.
    await store.saveCharacterPosition(id, 'round-town', x, 97);
    bot.send({ t: 'enter_world', characterId: id });
    await bot.expect('snapshot');
  };
  a = await BotClient.connect(url);
  b = await BotClient.connect(url);
  await join(a, 'grace_one', 'Odell Mard', 941, 50);
  await join(b, 'grace_two', 'Sennet Rike', 942, 51);
  await waitUntil(() => a.roundState?.phase === 'running', 'the round begins');
});

afterAll(async () => {
  a?.close();
  b?.close();
  await server.stop();
});

describe('the round opens with a truce', () => {
  it('announces itself and shows a countdown, rather than being invisible', async () => {
    await waitUntil(() => (a.roundState?.graceTicks ?? 0) > 0, 'the truce is declared');
    expect(a.roundState!.graceTicks).toBeGreaterThan(0);
    expect(a.narrations.join(' ')).toMatch(/woken in the same place/);
  });

  it('STOPS the clock rather than letting it run quietly', async () => {
    const before = a.roundState!.remainingTicks!;
    await sleep(1500);
    // The round is not counting down. A truce that merely suppressed damage
    // would still be spending the round's time, which is not what was asked.
    expect(a.roundState!.remainingTicks).toBe(before);
  });

  it('refuses attacks outright', async () => {
    b.send({ t: 'attack', targetEntityId: a.you! });
    const err = await b.expectError('grace_window');
    expect(err.message).toMatch(/day has not started/);
    expect(a.status!.hp).toBe(20);
  });

  it('refuses to let anyone leave the area', async () => {
    // Standing on the south gate: walking onto it would normally transfer.
    const before = a.area!.id;
    for (let i = 0; i < 6; i++) {
      a.send({ t: 'move', dir: 's' });
      await sleep(TICK * 5);
    }
    expect(a.area!.id).toBe(before);
    expect(a.narrations.join(' ')).toMatch(/Nobody is going anywhere/);
  });

  it('does not let needs deepen while it holds', () => {
    expect(a.status!.hunger).toBe('sated');
    expect(a.status!.thirst).toBe('sated');
  });
});

describe('and then the day starts', () => {
  it('says so, and hands the clock back', async () => {
    await waitUntil(() => (a.roundState?.graceTicks ?? 0) === 0, 'the truce lapses', 25_000);
    expect(a.narrations.join(' ')).toMatch(/The day begins/);
    const before = a.roundState!.remainingTicks!;
    await waitUntil(
      () => (a.roundState?.remainingTicks ?? before) < before,
      'the round starts counting again',
    );
  });

  it('lets violence happen again', async () => {
    b.send({ t: 'attack', targetEntityId: a.you! });
    await waitUntil(() => (a.status?.hp ?? 20) < 20, 'the blow lands');
  });
});
