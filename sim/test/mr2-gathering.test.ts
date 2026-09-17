import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectiveSchema, type ObjectiveDef } from '@rc/shared';
import { loadContent } from '@rc/server/content';
import { GameServer } from '@rc/server/net/gateway';
import { MemoryStore } from '@rc/server/store/memory';
import { closeOn, walkAdjacentTo as sharedWalkAdjacentTo } from '../src/walk';
import { BotClient } from '../src/botClient';
import { TICK as SIM_TICK, sleep } from '../src/testTick';

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
const TICK = SIM_TICK; // see sim/src/testTick.ts (D-633)

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
 * Walks to the node, by the SERVER's route (D-567).
 *
 * ⚠ This test used to carry its own copy of the client's A*, because the mine
 * is dense with rock and a greedy walker wedges against the first outcrop. The
 * copy is gone: it indexed the tile grid with metre positions, found nothing
 * walkable, and reported the whole mine impassable. One walker, in `sim/src`,
 * asking the server — which is the only thing that knows where a body fits.
 */
async function walkAdjacentTo(bot: BotClient, x: number, y: number): Promise<void> {
  await sharedWalkAdjacentTo(bot, x, y, { timeoutMs: 25_000 });
}

/** Wait until the bot has actually stopped moving. */
async function settle(bot: BotClient, timeoutMs = 4000): Promise<void> {
  bot.send({ t: 'move_stop' });
  const deadline = Date.now() + timeoutMs;
  let last = { x: NaN, y: NaN };
  let still = 0;
  while (Date.now() < deadline && still < 4) {
    const me = bot.entities.get(bot.you!)!;
    still = me.x === last.x && me.y === last.y ? still + 1 : 0;
    last = { x: me.x, y: me.y };
    await sleep(TICK * 4);
  }
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
      // No dawn truce here (D-536): this suite is not about it, and a
      // 60-second peace at the round's opening would only add dead time.
      graceTicks: 0,
      seed: 'mr2-test',
      objectives: [SURVIVE],
      resolutionTicks: 10,
      // ⚠ Arrivals stay where they are put (D-608's opt-out, which seven other
      // fixtures already use). This suite needs its miners IN THE MINE, and a
      // round's opening area is the scenario's now rather than the server's
      // `defaultAreaId` (D-627) — so without this the cast joins in the town
      // and waits forever for veins that are two areas away.
      placeArrivals: false,
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
    // ⚠ Settled, started, and MOVED — each one observed, not assumed (D-633).
    // On CI's slower runner the old version sent the harvest during the
    // glide, pressed north one wait later whether or not the job had begun
    // and whether or not north was open, and then waited eight seconds for a
    // cancellation that had nothing to cancel.
    await settle(miner);
    const jobsBefore = miner.work.length;
    miner.send({ t: 'harvest', targetEntityId: node.id });
    await waitUntil(() => miner.work.length > jobsBefore && !miner.work[miner.work.length - 1]!.done, 'the work starts');
    const from = { ...miner.entities.get(miner.you!)! };
    const moved = (): boolean => {
      const me = miner.entities.get(miner.you!)!;
      return Math.hypot(me.x - from.x, me.y - from.y) > 0.3;
    };
    for (const dir of ['n', 'e', 's', 'w'] as const) {
      miner.send({ t: 'move', dir });
      for (let i = 0; i < 12 && !moved(); i++) await sleep(TICK * 4);
      if (moved()) break;
    }
    expect(moved(), 'the miner could not step in any direction').toBe(true);
    await waitUntil(
      () => miner.work.some((w) => w.interrupted === 'you moved'),
      'the work is abandoned',
    );
    miner.send({ t: 'move_stop' });
  });

  it('CANCELS when the worker is struck — the buddy system in one assertion', async () => {
    const node = nearestNode(miner);
    await walkAdjacentTo(miner, node.x, node.y);
    // ⚠ The thug closes on the MINER, not on the node, and the difference was
    // a one-in-three flake. Both walking to the same point leaves each of them
    // within a metre of IT and therefore up to two metres from each other —
    // outside a 1.5m reach (D-567) about a third of the time. The old version
    // waited for adjacency and swallowed the timeout with `.catch`, so when it
    // never came the attack went out anyway and failed silently as "out of
    // reach"; the report was "timed out waiting until the blow ends the work",
    // which points at harvesting and not at where anybody is standing.
    // ⚠ BESIDE the miner, never onto them (D-633). `closeOn` steered the
    // thug at the miner's own position and returned within a metre, but the
    // server finished the route: the thug walked into the miner's body and
    // shoved them more than a metre off the seam, which cancelled the job
    // with "you moved" and put the next harvest out of reach — so every blow
    // after that landed on a worker who was not working. Measured by tick:
    // the last job died at 131, the first blow landed at 218.
    const m = thug.entities.get(miner.you!)!;
    await walkAdjacentTo(thug, m.x, m.y);
    await settle(thug);
    const closed = await closeOn(thug, miner.you!, 1.6);
    expect(closed, 'the thug never got within reach of the miner').toBe(true);

    // ⚠ Wait until the miner is genuinely STILL before starting work. A walk
    // ends when the caller is close enough, and the server keeps moving for a
    // tick or two after the stop reaches it — so the work began mid-glide and
    // cancelled itself with "you moved" before the blow ever landed. The
    // failure named harvesting and the cause was the walker.
    await settle(miner);
    // ⚠ And say so to the SERVER. `settle` waits until the miner has stopped
    // moving, which is not the same as the server having stopped steering
    // them: a stale intent or the tail of a route makes the first drift read
    // as walking away, and the job cancels itself with "you moved" before the
    // blow lands. This is the third time that string has been the reported
    // cause of a failure about harvesting.
    miner.send({ t: 'move_stop' });
    thug.send({ t: 'move_stop' });
    await sleep(TICK * 6);
    miner.send({ t: 'harvest', targetEntityId: node.id });
    await sleep(TICK * 2);
    // ⚠ What this asserts is a CONSEQUENCE, not a coincidence of timing:
    // when a blow actually lands on a worker, the work ends. Every earlier
    // version asserted that a particular swing, issued at a particular moment,
    // interrupted a particular job -- and then chased the three different ways
    // that can fail to line up:
    //
    //   * `iron-vein` takes 40 ticks and a combat round is 40 ticks (D-550),
    //     so whether the swing was even ALLOWED before the job finished was a
    //     coin flip on the global beat;
    //   * a blow can miss now (D-606), so a swing that was allowed still lands
    //     only rather over half the time;
    //   * and a job that completed untouched is not evidence either way.
    //
    // So: keep the miner working and the thug swinging until the thug is seen
    // to CONNECT, then assert the work ended because of it. The loop stops the
    // moment either happens, and stops early if the miner is getting hurt --
    // the point is that work is interrupted, not that the worker dies, and
    // every test after this one needs them alive.
    const struck = (): boolean => miner.work.some((w) => w.interrupted === 'you were struck');
    const landed = (): boolean =>
      thug.attacks.some((at) => at.targetId === miner.you && at.hit);
    const healthy = (): boolean => (miner.status?.hp ?? 0) > 8;
    try {
      for (let swing = 0; swing < 40 && !struck() && healthy(); swing++) {
        // Keep a job running for the blow to land on.
        //
        // ⚠ The LATEST work record decides, not any record (D-633). Every
        // progress update is its own message with `done: false`, so once a
        // job had reported progress and then been cancelled by the thug's
        // shove, `some(!done)` stayed true forever, no new job was started,
        // and every blow after that landed on a worker who was not working —
        // reported as "a blow landed and the work carried on".
        const latest = miner.work[miner.work.length - 1];
        if (!latest || latest.done) {
          miner.send({ t: 'harvest', targetEntityId: node.id });
          await sleep(TICK * 2);
          // A refused restart is out of reach: walk back to the seam first.
          const after = miner.work[miner.work.length - 1];
          if (after === latest) {
            await walkAdjacentTo(miner, node.x, node.y);
            await settle(miner);
          }
        }
        thug.send({ t: 'attack', targetEntityId: miner.you! });
        await sleep(TICK * 10);
      }
      if (!struck()) {
        throw new Error(
          landed()
            ? 'a blow landed on the worker and the work carried on'
            : 'the thug never connected in 40 swings',
        );
      }
    } catch (err) {
      const a = miner.entities.get(miner.you!)!;
      const b = thug.entities.get(thug.you!)!;
      throw new Error(
        `${String(err)} | gap=${Math.hypot(a.x - b.x, a.y - b.y).toFixed(2)}m` +
          ` | thugErrors=${JSON.stringify(thug.errors.slice(-3))}` +
          ` | minerErrors=${JSON.stringify(miner.errors.slice(-3).map((e) => e.code))}` +
          ` | attacks=${JSON.stringify(thug.attacks.map((x) => [(x as { tick?: number }).tick, x.hit]))}` +
          ` | work=${JSON.stringify(miner.work.map((w) => [(w as { tick?: number }).tick, w.progress, w.done, w.interrupted]))}`,
      );
    }
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
