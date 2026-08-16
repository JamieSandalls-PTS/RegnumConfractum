import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DIRECTIONS, Rng, type Direction } from '@rc/shared';
import { loadContent } from '@rc/server/content';
import { GameServer } from '@rc/server/net/gateway';
import { MemoryStore } from '@rc/server/store/memory';
import { BotClient } from '../src/botClient';

/**
 * Headless bots playing the real game over real WebSockets (D-114), asserting
 * the M0 invariants: server-authoritative movement produces no illegal state,
 * the delta stream never desyncs from server truth, items cannot be
 * duplicated, and coin is conserved.
 *
 * Runs on MemoryStore so it needs no infrastructure; the Postgres-specific
 * behaviours (restart survival, DB-level atomicity) live in persistence.pg.test.ts.
 */

const contentDir = fileURLToPath(new URL('../../content', import.meta.url));
const TICK = 5; // ms per tick — logic is tick-based, so fast wall-clock is safe
const MOVE_GAP = TICK * 4; // > MOVE_COOLDOWN_TICKS ticks between steps

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(pred: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting until ${what}`);
}

let store: MemoryStore;
let server: GameServer;
let botA: BotClient;
let botB: BotClient;
let charA: string;
let charB: string;
let entityA: number;
let entityB: number;

async function walk(bot: BotClient, dir: Direction, steps: number): Promise<void> {
  for (let i = 0; i < steps; i++) {
    bot.send({ t: 'move', dir });
    await sleep(MOVE_GAP);
  }
}

beforeAll(async () => {
  store = new MemoryStore();
  server = new GameServer({
    store,
    content: loadContent(contentDir),
    port: 0,
    tickIntervalMs: TICK,
  });
  await server.start();
});

afterAll(async () => {
  botA?.close();
  botB?.close();
  await server.stop();
});

describe('headless bots against a live server', () => {
  it('bots register, create characters, and enter the world', async () => {
    const url = `ws://127.0.0.1:${server.port}`;
    botA = await BotClient.connect(url);
    botB = await BotClient.connect(url);

    botA.send({ t: 'register', username: 'bot_alpha', password: 'password-alpha' });
    await botA.expect('auth_ok');
    botA.send({ t: 'create_character', name: 'Aldous Crane', appearanceSeed: 11 });
    charA = (await botA.expect('character_created')).character.id;
    botA.send({ t: 'enter_world', characterId: charA });
    const snapA = await botA.expect('snapshot');
    entityA = snapA.you;

    botB.send({ t: 'register', username: 'bot_beta', password: 'password-beta' });
    await botB.expect('auth_ok');
    botB.send({ t: 'create_character', name: 'Berta Mool', appearanceSeed: 22 });
    charB = (await botB.expect('character_created')).character.id;
    botB.send({ t: 'enter_world', characterId: charB });
    const snapB = await botB.expect('snapshot');
    entityB = snapB.you;

    // A learns of B's arrival through the delta stream.
    await waitUntil(() => botA.entities.has(entityB), 'A sees B enter');
    expect(botB.entities.has(entityA)).toBe(true);
  });

  it('rejects duplicate usernames, bad logins, and double character entry', async () => {
    const url = `ws://127.0.0.1:${server.port}`;
    const probe = await BotClient.connect(url);
    probe.send({ t: 'register', username: 'bot_alpha', password: 'whatever-else' });
    await probe.expectError('username_taken');
    probe.send({ t: 'login', username: 'bot_alpha', password: 'wrong-password' });
    await probe.expectError('auth_failed');
    probe.send({ t: 'login', username: 'bot_alpha', password: 'password-alpha' });
    await probe.expect('auth_ok');
    probe.send({ t: 'enter_world', characterId: charA });
    await probe.expectError('already_in_world');
    probe.close();
  });

  it('items cannot be duplicated: a second give of the same item fails', async () => {
    const ore = await store.grantItem(charA, 'iron-ore', 5);
    const sword = await store.grantItem(charA, 'rusted-shortsword', 1);
    expect(await store.countItems()).toBe(6);

    // Both characters spawned on the same tile — adjacent by definition.
    botA.send({ t: 'give', itemId: ore.id, toEntityId: entityB });
    await botA.expect('inventory');
    botA.send({ t: 'give', itemId: ore.id, toEntityId: entityB });
    await botA.expectError('no_such_item');

    expect(await store.countItems()).toBe(6);
    expect((await store.getItemsByCharacter(charB)).map((i) => i.id)).toEqual([ore.id]);
    expect((await store.getItemsByCharacter(charA)).map((i) => i.id)).toEqual([sword.id]);
  });

  it('coin is conserved and overdraw is rejected', async () => {
    await store.grantCoin(charA, 100);
    botA.send({ t: 'pay', toEntityId: entityB, amount: 60 });
    await botA.expect('inventory');
    expect(botA.coin).toBe(40);

    botA.send({ t: 'pay', toEntityId: entityB, amount: 60 }); // only 40 left
    await botA.expectError('insufficient_funds');

    expect(await store.getCoin(charA)).toBe(40);
    expect(await store.getCoin(charB)).toBe(60);
    expect(await store.totalCoin()).toBe(100);
  });

  it('interactions require adjacency', async () => {
    // March A east along the clear top row, well away from B at spawn (2,2).
    // (Not diagonally: the ruined hall's corner at (4,4) blocks 'se' from
    // (3,3), which would leave A still adjacent to B.)
    await walk(botA, 'e', 40);
    botA.send({ t: 'pay', toEntityId: entityB, amount: 10 });
    await botA.expectError('not_adjacent');
    expect(await store.totalCoin()).toBe(100);
  });

  it('random walking produces no illegal movement in any observer', async () => {
    const rng = new Rng('invariant-walk');
    for (let i = 0; i < 60; i++) {
      botA.send({ t: 'move', dir: rng.pick(DIRECTIONS) });
      botB.send({ t: 'move', dir: rng.pick(DIRECTIONS) });
      await sleep(MOVE_GAP);
    }
    await sleep(TICK * 10); // quiesce
    expect(botA.violations).toEqual([]);
    expect(botB.violations).toEqual([]);
  });

  it('no desync: each bot mirror matches a fresh server snapshot', async () => {
    botA.send({ t: 'resync' });
    await botA.expect('snapshot');
    botB.send({ t: 'resync' });
    await botB.expect('snapshot');
    expect(botA.lastResyncDiffs).toEqual([]);
    expect(botB.lastResyncDiffs).toEqual([]);
    expect(botA.violations).toEqual([]);
    expect(botB.violations).toEqual([]);
  });

  it('the event log recorded the economy-critical actions', async () => {
    const events = await store.listRecentEvents(1000);
    const types = events.map((e) => e.type);
    expect(types).toContain('account_created');
    expect(types).toContain('character_created');
    expect(types).toContain('enter_world');
    expect(types).toContain('item_transfer');
    expect(types).toContain('coin_transfer');
    // Exactly one successful transfer of each kind — the failed attempts
    // must not have logged anything.
    expect(types.filter((t) => t === 'item_transfer')).toHaveLength(1);
    expect(types.filter((t) => t === 'coin_transfer')).toHaveLength(1);
  });

  it('disconnect persists position immediately and notifies the area', async () => {
    const posB = botA.entities.get(entityB)!;
    botB.close();
    await waitUntil(() => !botA.entities.has(entityB), 'A sees B leave');
    const saved = await store.getCharacter(charB);
    expect(saved).not.toBeNull();
    expect({ x: saved!.x, y: saved!.y }).toEqual({ x: posB.x, y: posB.y });
    const events = await store.listRecentEvents(10);
    expect(events.map((e) => e.type)).toContain('logout');
  });
});
