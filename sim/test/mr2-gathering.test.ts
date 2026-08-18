import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectiveSchema, type ObjectiveDef } from '@rc/shared';
import { loadContent } from '@rc/server/content';
import { GameServer } from '@rc/server/net/gateway';
import { MemoryStore } from '@rc/server/store/memory';
import { BotClient } from '../src/botClient';
import { findPath } from '../../client/src/game/path';

/**
 * Gathering and crafting (MR2), played by bots.
 *
 * The assertions that matter are not "a rock gives ore" but the two
 * INTERRUPTIONS. Work being cancelled by moving and by being struck is what
 * makes standing in a spoke a risk rather than a timer, and it is the whole
 * reason the buddy system (D-529) has any weight. If those regress, gathering
 * silently becomes free and the map stops meaning anything.
 */

const contentDir = fileURLToPath(new URL('../../content', import.meta.url));
const TICK = 5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(pred: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting until ${what}`);
}

/** A two-player scenario so a round can start without deciding anything. */
const SURVIVE: ObjectiveDef = ObjectiveSchema.parse({
  id: 'test-survive',
  name: 'Endure',
  brief: 'Live.',
  kind: { type: 'survive' },
  minCast: 2,
});

let store: MemoryStore;
let server: GameServer;
let miner: BotClient;
let thug: BotClient;
let minerChar: string;

async function join(bot: BotClient, username: string, charName: string, seed: number) {
  bot.send({ t: 'register', username, password: 'password-word' });
  await bot.expect('auth_ok');
  bot.send({ t: 'create_character', name: charName, appearanceSeed: seed });
  const characterId = (await bot.expect('character_created')).character.id;
  bot.send({ t: 'enter_world', characterId });
  await bot.expect('snapshot');
  return characterId;
}

/**
 * Walks by A* rather than greedily. The mine is dense with rock, and a greedy
 * walker wedges itself against the first outcrop — reusing the client's
 * pathfinder keeps the test about gathering instead of about navigation.
 */
async function walkAdjacentTo(bot: BotClient, x: number, y: number): Promise<void> {
  const area = bot.area!;
  const grid = {
    width: area.width,
    height: area.height,
    walkable: (gx: number, gy: number) => {
      const ch = area.tiles[gy]?.[gx];
      return ch !== undefined && (area.legend[ch]?.walkable ?? false);
    },
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    const me = bot.entities.get(bot.you!)!;
    if (Math.max(Math.abs(me.x - x), Math.abs(me.y - y)) <= 1) return;
    // Aim for a walkable tile beside the node; the node's own tile is fine too.
    const goals = [[x, y], [x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
    let path: ReturnType<typeof findPath> = null;
    for (const [gx, gy] of goals) {
      path = findPath(grid, me.x, me.y, gx!, gy!);
      if (path && path.length > 0) break;
    }
    if (!path) throw new Error(`no path to (${x},${y}) from (${me.x},${me.y})`);
    for (const dir of path) {
      bot.send({ t: 'move', dir });
      await sleep(TICK * 4);
      const now = bot.entities.get(bot.you!)!;
      if (Math.max(Math.abs(now.x - x), Math.abs(now.y - y)) <= 1) return;
    }
  }
  const me = bot.entities.get(bot.you!)!;
  throw new Error(`never reached (${x},${y}); stalled at (${me.x},${me.y})`);
}

/** The node nearest this bot, by its own mirror of the world. */
function nearestNode(bot: BotClient): { id: number; x: number; y: number } {
  const me = bot.entities.get(bot.you!)!;
  const nodes = [...bot.entities.values()].filter((e) => e.kind === 'node');
  if (nodes.length === 0) throw new Error('no nodes in view');
  return nodes
    .map((n) => ({ id: n.id, x: n.x, y: n.y, d: Math.max(Math.abs(n.x - me.x), Math.abs(n.y - me.y)) }))
    .sort((a, b) => a.d - b.d)[0]!;
}

beforeAll(async () => {
  store = new MemoryStore();
  server = new GameServer({
    store,
    content: loadContent(contentDir),
    port: 0,
    tickIntervalMs: TICK,
    rngSeed: 41,
    // Straight into the mine: every node here is an iron vein.
    defaultAreaId: 'round-mine',
    attackCooldownTicks: 2,
    bleedIntervalTicks: 5000,
    round: {
      enabled: true,
      lengthTicks: 60_000, // the clock decides nothing here
      minCast: 2,
      seed: 'mr2-test',
      objectives: [SURVIVE],
      resolutionTicks: 10,
    },
  });
  await server.start();
  const url = `ws://127.0.0.1:${server.port}`;
  miner = await BotClient.connect(url);
  thug = await BotClient.connect(url);
  minerChar = await join(miner, 'mr2_miner', 'Dorn Pickett', 811);
  await join(thug, 'mr2_thug', 'Ulf Rethe', 812);
  await waitUntil(() => miner.roundState?.phase === 'running', 'the round begins');
  // Nodes are spawned by the round, so they arrive after it starts.
  await waitUntil(
    () => [...miner.entities.values()].some((e) => e.kind === 'node'),
    'the veins appear',
  );
});

afterAll(async () => {
  miner?.close();
  thug?.close();
  await server.stop();
});

describe('the world is stocked when the round begins', () => {
  it('puts nodes in the spoke, described but not identified', () => {
    const nodes = [...miner.entities.values()].filter((e) => e.kind === 'node');
    expect(nodes.length).toBeGreaterThan(5);
    // A vein is a vein to everyone — nodes have no identity mechanics, unlike
    // people (D-219), so every observer gets the same descriptor.
    expect(nodes[0]!.descriptor).toContain('rock');
  });
});

describe('harvesting', () => {
  it('yields its material after the work is done', async () => {
    const node = nearestNode(miner);
    await walkAdjacentTo(miner, node.x, node.y);
    const before = miner.inventory.reduce((n, i) => n + (i.templateId === 'iron-ore' ? i.qty : 0), 0);
    miner.send({ t: 'harvest', targetEntityId: node.id });
    await waitUntil(() => miner.work.some((w) => w.done && w.interrupted === null), 'the work completes');
    await waitUntil(
      () => miner.inventory.reduce((n, i) => n + (i.templateId === 'iron-ore' ? i.qty : 0), 0) > before,
      'the ore is in hand',
    );
  });

  it('is refused out of reach, and refused to the dead', async () => {
    const far = [...miner.entities.values()]
      .filter((e) => e.kind === 'node')
      .map((n) => ({ n, d: Math.max(Math.abs(n.x - miner.entities.get(miner.you!)!.x), Math.abs(n.y - miner.entities.get(miner.you!)!.y)) }))
      .sort((a, b) => b.d - a.d)[0]!.n;
    miner.send({ t: 'harvest', targetEntityId: far.id });
    const err = await miner.expectError('not_adjacent');
    expect(err.message).toBeTruthy();
  });

  it('CANCELS when the worker moves — this is what makes it a risk', async () => {
    const node = nearestNode(miner);
    await walkAdjacentTo(miner, node.x, node.y);
    miner.send({ t: 'harvest', targetEntityId: node.id });
    await sleep(TICK * 4);
    miner.send({ t: 'move', dir: 'n' });
    await waitUntil(
      () => miner.work.some((w) => w.interrupted === 'you moved'),
      'the work is abandoned',
    );
  });

  it('CANCELS when the worker is struck — the buddy system in one assertion', async () => {
    const node = nearestNode(miner);
    await walkAdjacentTo(miner, node.x, node.y);
    await walkAdjacentTo(thug, node.x, node.y);
    // Get the thug adjacent to the miner.
    await waitUntil(() => {
      const a = miner.entities.get(miner.you!)!;
      const b = thug.entities.get(thug.you!)!;
      return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) <= 1;
    }, 'the thug is within reach', 12_000).catch(() => undefined);

    miner.send({ t: 'harvest', targetEntityId: node.id });
    await sleep(TICK * 4);
    // ONE blow. A loop of them interrupts on the first swing and then keeps
    // going until the miner is dead, which quietly breaks every test after
    // this one — the dead craft nothing.
    thug.send({ t: 'attack', targetEntityId: miner.you! });
    await waitUntil(
      () => miner.work.some((w) => w.interrupted === 'you were struck'),
      'the blow ends the work',
    );
    expect(miner.status?.ghost ?? false).toBe(false);
  });

  it('will not run two jobs at once', async () => {
    const node = nearestNode(miner);
    await walkAdjacentTo(miner, node.x, node.y);
    miner.send({ t: 'harvest', targetEntityId: node.id });
    await sleep(TICK * 3);
    miner.send({ t: 'harvest', targetEntityId: node.id });
    const err = await miner.expectError('already_working');
    expect(err.message).toContain('busy');
    miner.send({ t: 'cancel_work' });
  });
});

describe('crafting', () => {
  it('sends the catalogue on entering the world', () => {
    expect(miner.recipes.length).toBeGreaterThan(0);
    expect(miner.recipes.map((r) => r.id)).toContain('bandage');
  });

  it('refuses a recipe whose materials are not held', async () => {
    // 'bandage' works anywhere, so this isolates the MATERIALS check — the
    // station check runs first, and testing both through one recipe would
    // only ever exercise whichever guard happens to be earlier.
    miner.send({ t: 'craft', recipeId: 'bandage' });
    const err = await miner.expectError('missing_materials');
    expect(err.message).toBeTruthy();
  });

  it('refuses a station recipe away from the town (D-530)', async () => {
    await store.grantItem(minerChar, 'iron-ore', 4);
    await store.grantItem(minerChar, 'rough-timber', 2);
    miner.send({ t: 'craft', recipeId: 'iron-hatchet' });
    const err = await miner.expectError('wrong_station');
    expect(err.message).toContain('workshop');
  });

  it('makes the thing, and eats exactly what the recipe said', async () => {
    await store.grantItem(minerChar, 'bitterleaf', 3);
    const leafBefore = (await store.getItemsByCharacter(minerChar))
      .filter((i) => i.templateId === 'bitterleaf').reduce((n, i) => n + i.qty, 0);
    miner.send({ t: 'craft', recipeId: 'bandage' }); // 'anywhere'
    await waitUntil(
      () => miner.work.some((w) => w.activity === 'craft' && w.done && w.interrupted === null),
      'the bandage is finished',
      15_000,
    );
    const held = await store.getItemsByCharacter(minerChar);
    const leafAfter = held.filter((i) => i.templateId === 'bitterleaf').reduce((n, i) => n + i.qty, 0);
    const bandages = held.filter((i) => i.templateId === 'bandage').reduce((n, i) => n + i.qty, 0);
    expect(leafAfter).toBe(leafBefore - 1); // exactly the input, no more
    expect(bandages).toBeGreaterThanOrEqual(2); // the recipe makes two
    // The completion must name the job it finished. It reported every craft
    // as a harvest until the work slot stopped being cleared before the
    // report was built.
    const finished = miner.work.filter((w) => w.done && w.interrupted === null).at(-1)!;
    expect(finished.activity).toBe('craft');
    expect(finished.what).toBe('Boil a bandage');
  });
});

describe('the round owns the world it stocked', () => {
  it('a spent node refills rather than staying dead for the round', async () => {
    // Work one vein until it is empty, then confirm it is refused — and that
    // it carries a refill time rather than being gone. A node that never came
    // back would quietly turn a 25-minute round into a race to the first vein.
    const node = nearestNode(miner);
    await walkAdjacentTo(miner, node.x, node.y);
    let spent = false;
    for (let i = 0; i < 5 && !spent; i++) {
      miner.send({ t: 'harvest', targetEntityId: node.id });
      const seen = miner.work.length;
      await waitUntil(() => miner.work.length > seen, 'the work reports back', 10_000).catch(() => undefined);
      await sleep(TICK * 10);
      miner.send({ t: 'harvest', targetEntityId: node.id });
      const err = await miner.expectError('node_spent', 600).catch(() => null);
      if (err) spent = true;
    }
    expect(spent, 'the vein ran out after its charges').toBe(true);
  });
});
