import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectiveSchema, canStandAt, type ObjectiveDef } from '@rc/shared';
import { loadContent } from '@rc/server/content';
import { GameServer } from '@rc/server/net/gateway';
import { MemoryStore } from '@rc/server/store/memory';
import { BotClient } from '../src/botClient';

/** The town, read from content so a map change cannot silently move a bot
 * into a wall — where an unwalkable spawn is relocated to the area spawn. */
const TOWN = loadContent(fileURLToPath(new URL('../../content', import.meta.url)))
  .areas.get('round-town')!;

/**
 * The two tiles of the south gate's road, found by ASKING THE MAP.
 *
 * ⚠ This was `width / 2` and `width / 2 + 1`, and the second one stopped being
 * road: Ashfold's gate opening is two tiles wide and centred on x=24.5, so the
 * right-hand bot was standing in the palisade. Its TILE is walkable grass — the
 * wall is an asset with a collision volume (D-584), not a wall kind — so
 * nothing in the map data looked wrong, the bot was quietly relocated to the
 * area spawn twenty-two tiles away, and the truce test failed claiming the
 * server had allowed an attack it had actually refused for being out of reach.
 *
 * ⚠ So the tiles are DERIVED, with `canStandAt` — the same question the spawn
 * asks. A coordinate typed in here is a copy of the map that the map cannot
 * update.
 */
const GATE_ROAD = (() => {
  const y = TOWN.height - 3;
  const xs: number[] = [];
  for (let x = 0; x < TOWN.width; x++) if (canStandAt(TOWN, { x, y })) xs.push(x);
  if (xs.length < 2) throw new Error(`round-town has no south gate to stand in at y=${y}`);
  // The rightmost adjacent pair: the gate is the only opening on this row.
  const right = xs[xs.length - 1]!;
  const left = xs[xs.length - 2]!;
  if (right - left !== 1) throw new Error('the south gate road is not two adjacent tiles');
  return { y, left, right };
})();

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
    // Beside each other on the town's south road. Derived from the map
    // rather than typed in: D-549 halved the town and y=97 fell off it.
    // Two tiles from the south gate, so the six move attempts below reach it
    // even with the movement cooldown between them.
    await store.saveCharacterPosition(id, 'round-town', x, GATE_ROAD.y);
    bot.send({ t: 'enter_world', characterId: id });
    await bot.expect('snapshot');
  };
  a = await BotClient.connect(url);
  b = await BotClient.connect(url);
  await join(a, 'grace_one', 'Odell Mard', 941, GATE_ROAD.right);
  await join(b, 'grace_two', 'Sennet Rike', 942, GATE_ROAD.left);
  await waitUntil(() => a.roundState?.phase === 'running', 'the round begins');
  // ⚠ Asserted, not assumed. Every prohibition below is about two people
  // standing next to each other, and a bot relocated to the area spawn makes
  // the whole file pass or fail for the wrong reason — 'out of reach' reads
  // exactly like 'the truce let it through' from the outside.
  const where = (bot: BotClient) => bot.entities.get(bot.you!)!;
  expect(where(a).y).toBe(GATE_ROAD.y);
  expect(where(b).y).toBe(GATE_ROAD.y);
  expect(Math.abs(where(a).x - where(b).x)).toBe(1);
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
