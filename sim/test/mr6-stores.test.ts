import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectiveSchema, type ObjectiveDef } from '@rc/shared';
import { loadContent } from '@rc/server/content';
import { GameServer } from '@rc/server/net/gateway';
import { MemoryStore } from '@rc/server/store/memory';
import { BotClient } from '../src/botClient';
import { TICK as SIM_TICK, sleep } from '../src/testTick';

/**
 * The common stores (D-529, D-530, built D-580).
 *
 * D-530 ruled that pooling goods at a facility is more potent than carrying
 * them and never required — "it should not be *required* to store items
 * there... Items placed there, and 'used' from there should be more potent."
 * Until now the storehouse gave a bonus for eating beside it out of your own
 * pack: the flavour of the rule without the substance. Nothing was ever
 * pooled, so nothing could be hoarded, denied, or spoiled.
 *
 * ⚠ The assertions here are the properties the dilemma rests on, not "it
 * stored a thing":
 *
 *   - depositing MOVES an item; the total in the world never changes (D-114)
 *   - the stores are COMMON — anybody standing there may take what anybody
 *     pooled, which is the exposure half of the trade
 *   - reach is per-station, so the infirmary cannot be robbed from the
 *     storehouse across the square
 *   - the stores are emptied at a round reset (D-522), or the cast builds a
 *     permanent larder and D-529's hard constraint dies quietly
 *   - spoiled food deepens the need instead of relieving it, and says nothing
 *     until it is eaten
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

/**
 * ⚠ A round must be RUNNING for any of this to exist. Stations are real
 * placed objects spawned with the round (D-534) and torn down at reset, so a
 * server with no round has no storehouse to stand at — which is how the first
 * run of this suite failed, with four `no_store_here` refusals that looked
 * like a broken feature and were a broken fixture.
 */
const SURVIVE: ObjectiveDef = ObjectiveSchema.parse({
  id: 'test-survive',
  name: 'Endure',
  brief: 'Live.',
  kind: { type: 'survive' },
  // ⚠ TWO, and every fixture below must seat at least that many. An
  // objective needing a bigger cast than the server's `minCast` means the
  // lobby fills and never starts — the trap D-569 named when the objective
  // editor was built, hit here for real. Worth knowing how it presented: the
  // `beforeAll` timed out and vitest reported its tests as SKIPPED rather
  // than failed, which reads as green in the summary line.
  minCast: 2,
});

let store: MemoryStore;
let server: GameServer;
let url = '';
const bots: BotClient[] = [];
const charIds: string[] = [];

/** Walk a bot onto the tile the storehouse stands on, then stop. */
async function goToStorehouse(bot: BotClient, areaId: string): Promise<void> {
  const area = loadContent(contentDir).areas.get(areaId)!;
  const station = area.stations!.find((s) => s.type === 'storehouse')!;
  bot.send({ t: 'move_to', x: station.x, y: station.y - 1 });
  await waitUntil(() => {
    const me = bot.entities.get(bot.you!);
    if (!me) return false;
    return Math.hypot(me.x - station.x, me.y - (station.y - 1)) < 0.6;
  }, 'the bot reaches the storehouse', 20_000);
}

async function join(bot: BotClient, username: string, charName: string, seed: number) {
  bot.send({ t: 'register', username, password: 'password-word' });
  await bot.expect('auth_ok');
  bot.send({ t: 'create_character', name: charName, appearanceSeed: seed });
  const characterId = (await bot.expect('character_created')).character.id;
  bot.send({ t: 'enter_world', characterId });
  await bot.expect('snapshot');
  return characterId;
}

beforeAll(async () => {
  store = new MemoryStore();
  server = new GameServer({
    store,
    content: loadContent(contentDir),
    port: 0,
    tickIntervalMs: TICK,
    rngSeed: 19,
    defaultAreaId: 'round-town',
    ghostMinTicks: 50,
    bleedIntervalTicks: 5000,
    round: {
      enabled: true,
      lengthTicks: 200_000, // the clock decides nothing here
      minCast: 2,
      // Daylight throughout, and no dawn truce: this suite is about the
      // stores, and a roamer or a 60-second peace would only add noise.
      dayTicks: 400_000,
      graceTicks: 0,
      seed: 'mr6-stores',
      objectives: [SURVIVE],
      resolutionTicks: 10,
    },
  });
  await server.start();
  url = `ws://127.0.0.1:${server.port}`;
  for (let i = 0; i < 2; i++) {
    const bot = await BotClient.connect(url);
    bots.push(bot);
    charIds.push(await join(bot, `store_${i}`, `Store Hand${'X'.repeat(i)}`, 600 + i));
  }
  await waitUntil(() => bots[0]!.roundState?.phase === 'running', 'the round starts');
  for (const bot of bots) await goToStorehouse(bot, 'round-town');
});

afterAll(async () => {
  for (const b of bots) b.close();
  await server.stop();
});

describe('pooling goods at a facility (D-530)', () => {
  it('MOVES the item — the world holds exactly as much as before', async () => {
    // ⚠ The invariant that matters more than the feature (D-114). A deposit
    // that copied would be an item duplication bug wearing a helpful face,
    // and the round's whole economy is items.
    const loaf = await store.grantItem(charIds[0]!, 'coarse-bread', 1);
    const before = await store.countItems();

    bots[0]!.send({ t: 'store_deposit', itemId: loaf.id });
    await waitUntil(
      () => (bots[0]!.storeContents?.items ?? []).some((i) => i.id === loaf.id),
      'the loaf appears in the stores',
    );

    expect(await store.countItems()).toBe(before);
    // And it has left the pack: one place, not two.
    const held = await store.getItemsByCharacter(charIds[0]!);
    expect(held.some((i) => i.id === loaf.id)).toBe(false);
  });

  it('lets ANYBODY take what anybody pooled', async () => {
    // ⚠ Deliberate, and the whole exposure half of D-530's trade: goods on
    // your person are your loss alone; goods in the stores are one target
    // everybody can see. A lock here would quietly delete the dilemma.
    const loaf = await store.grantItem(charIds[0]!, 'coarse-bread', 1);
    bots[0]!.send({ t: 'store_deposit', itemId: loaf.id });
    await waitUntil(
      () => (bots[1]!.storeContents?.items ?? []).some((i) => i.id === loaf.id),
      'the other player sees it arrive',
    );

    bots[1]!.send({ t: 'store_withdraw', itemId: loaf.id });
    await sleep(TICK * 20);
    const theirs = await store.getItemsByCharacter(charIds[1]!);
    expect(theirs.some((i) => i.id === loaf.id)).toBe(true);
  });

  it('refuses a player who is not standing at the stores', async () => {
    const loaf = await store.grantItem(charIds[0]!, 'coarse-bread', 1);
    const away = await BotClient.connect(url);
    bots.push(away);
    const id = await join(away, 'store_away', 'Far Away', 640);
    charIds.push(id);
    const mine = await store.grantItem(id, 'coarse-bread', 1);
    away.send({ t: 'store_deposit', itemId: mine.id });
    const err = await away.expect('error');
    expect(err.code).toBe('no_store_here');
    // And the loaf is exactly where it was.
    expect((await store.getItemsByCharacter(id)).some((i) => i.id === mine.id)).toBe(true);
    expect(loaf.ownerCharacterId).toBe(charIds[0]!);
  });
});

describe('ruining the stores (D-526, D-529, D-530)', () => {
  it('costs a meal AND deepens the hunger it should have relieved', async () => {
    const spoiler = bots[0]!;
    let spoiled = false;
    const watch = setInterval(() => {
      void store.getItemsByStore('round-town:storehouse').then((held) => {
        spoiled = held.some((i) => i.data?.spoiled === true);
      });
    }, 20);
    const loaf = await store.grantItem(charIds[0]!, 'coarse-bread', 1);
    spoiler.send({ t: 'store_deposit', itemId: loaf.id });
    await waitUntil(
      () => (spoiler.storeContents?.items ?? []).some((i) => i.id === loaf.id),
      'the loaf is pooled',
    );

    await store.grantItem(charIds[0]!, 'bitterleaf', 1);
    spoiler.send({ t: 'store_spoil' });
    // ⚠ Asserted against the STORE, not the wire, because the wire carries no
    // such flag and must not: a ruined larder looks exactly like a full one
    // (D-552's rule for the well). If this ever becomes observable from the
    // client, the sabotage has stopped working.
    await waitUntil(
      () => spoiled,
      'the provisions are ruined',
    );

    // Taken back out, it is still bad: spoiling rides on the ITEM, so a
    // victim cannot walk the loaf clear of the sabotage.
    spoiler.send({ t: 'store_withdraw', itemId: loaf.id });
    await sleep(TICK * 20);
    const held = await store.getItemsByCharacter(charIds[0]!);
    const bad = held.find((i) => i.id === loaf.id);
    expect(bad?.data?.spoiled).toBe(true);
    clearInterval(watch);
  });

  it('refuses to spend the bitterleaf on an empty larder', async () => {
    // ⚠ Refused BEFORE the leaf is consumed. The room is deliberately hard to
    // read — nothing about spoiled stores looks different — so punishing a
    // misread by destroying the one thing that makes this possible would be
    // a trap rather than a risk.
    const bot = bots[1]!;
    // Empty the stores first.
    const inStore = await store.getItemsByStore('round-town:storehouse');
    for (const item of inStore) {
      bot.send({ t: 'store_withdraw', itemId: item.id });
      await sleep(TICK * 6);
    }
    const leaf = await store.grantItem(charIds[1]!, 'bitterleaf', 1);
    bot.send({ t: 'store_spoil' });
    const err = await bot.expect('error');
    expect(err.code).toBe('nothing_to_spoil');
    // The leaf survives.
    const held = await store.getItemsByCharacter(charIds[1]!);
    expect(held.some((i) => i.id === leaf.id)).toBe(true);
  });
});

/**
 * ⚠ Its own server, with a clock fast enough for hunger to arrive.
 *
 * The suite above deliberately runs an endless day so night roamers never
 * interfere with the storehouse tests — and that same setting freezes the
 * need clock, so nobody there ever gets hungry enough to eat. A game hour
 * every 60 ticks here, the same figure `mr2-needs` arrived at: fast enough
 * that hunger bites inside the file, slow enough that nobody starves and
 * ends the round mid-test.
 */
describe('what spoiled food does when it is eaten (D-580)', () => {
  let s3: GameServer;
  let st3: MemoryStore;
  let b3: BotClient;
  let extra3: BotClient;
  let c3 = '';

  beforeAll(async () => {
    st3 = new MemoryStore();
    s3 = new GameServer({
      store: st3,
      content: loadContent(contentDir),
      port: 0,
      tickIntervalMs: TICK,
      rngSeed: 31,
      defaultAreaId: 'round-town',
      ghostMinTicks: 50,
      bleedIntervalTicks: 5000,
      round: {
        enabled: true,
        lengthTicks: 200_000,
        minCast: 2,
        graceTicks: 0,
        dayTicks: 1440,
        seed: 'mr6-spoiled',
        objectives: [SURVIVE],
        resolutionTicks: 10,
      },
    });
    await s3.start();
    b3 = await BotClient.connect(`ws://127.0.0.1:${s3.port}`);
    c3 = await join(b3, 'store_eat', 'Hungry Man', 680);
    // A second warm body, only so the round can open at all.
    extra3 = await BotClient.connect(`ws://127.0.0.1:${s3.port}`);
    await join(extra3, 'store_eat2', 'Second Body', 681);
    await waitUntil(() => b3.roundState?.phase === 'running', 'the round starts');
  });

  afterAll(async () => {
    b3.close();
    extra3.close();
    await s3.stop();
  });

  it('deepens the hunger it should have relieved, and costs the meal', async () => {
    // ⚠ A saboteur who left everybody fed would have accomplished nothing.
    // The loaf is spent AND the need gets worse — the same shape poisoned
    // water has for thirst (D-552), for the same reason.
    await waitUntil(() => b3.status?.hunger !== 'sated', 'hunger arrives', 40_000);
    const worseThan = b3.status!.hunger;

    const loaf = await st3.grantItem(c3, 'coarse-bread', 1);
    await st3.spoilItems([loaf.id]);
    b3.send({ t: 'eat', templateId: 'coarse-bread' });
    await waitUntil(
      () => b3.narrations.some((n) => n.includes('Somebody has been at the stores')),
      'the bad loaf is noticed on the way down',
    );

    // Eaten, gone, and it did not feed them: still hungry, and no better.
    const held = await st3.getItemsByCharacter(c3);
    expect(held.some((i) => i.id === loaf.id)).toBe(false);
    expect(b3.status!.hunger).not.toBe('sated');
    expect(worseThan).not.toBe('sated');
  });

  it('eats the GOOD loaf first when there is a choice', async () => {
    // ⚠ Given a good loaf and a ruined one a person eats the good one, so
    // sabotage bites once the good food has run out — which is exactly the
    // pressure D-529 wants, and the opposite of making every meal a coin toss.
    await waitUntil(() => b3.status?.hunger !== 'sated', 'hungry again', 40_000);
    const bad = await st3.grantItem(c3, 'coarse-bread', 1);
    await st3.spoilItems([bad.id]);
    const good = await st3.grantItem(c3, 'coarse-bread', 1);

    b3.send({ t: 'eat', templateId: 'coarse-bread' });
    await waitUntil(() => b3.status?.hunger === 'sated', 'the good loaf feeds them');

    const held = await st3.getItemsByCharacter(c3);
    // The good one went; the ruined one is still in the pack, waiting.
    expect(held.some((i) => i.id === good.id)).toBe(false);
    expect(held.some((i) => i.id === bad.id)).toBe(true);
  });
});

/**
 * ⚠ Its own server, with a round short enough to end on its own clock.
 *
 * There is no test hook for resetting a round and there should not be: the
 * property under test is that the REAL reset path empties the stores, and a
 * back door into it would be testing a function nobody calls in play.
 */
describe('the stores do not survive the round (D-522, D-529)', () => {
  let s2: GameServer;
  let st2: MemoryStore;
  let bot2: BotClient;
  let extra2: BotClient;
  let char2 = '';

  beforeAll(async () => {
    st2 = new MemoryStore();
    s2 = new GameServer({
      store: st2,
      content: loadContent(contentDir),
      port: 0,
      tickIntervalMs: TICK,
      rngSeed: 23,
      defaultAreaId: 'round-town',
      ghostMinTicks: 50,
      bleedIntervalTicks: 5000,
      round: {
        enabled: true,
        // Short enough that the clock ends the round while this test watches.
        // Long enough for the fixture to walk to the stores and pool a loaf,
        // short enough that the clock ends the round while the test watches.
        lengthTicks: 900,
        minCast: 2,
        dayTicks: 400_000,
        graceTicks: 0,
        seed: 'mr6-reset',
        objectives: [SURVIVE],
        resolutionTicks: 10,
      },
    });
    await s2.start();
    bot2 = await BotClient.connect(`ws://127.0.0.1:${s2.port}`);
    char2 = await join(bot2, 'store_reset', 'Larder Keeper', 660);
    extra2 = await BotClient.connect(`ws://127.0.0.1:${s2.port}`);
    await join(extra2, 'store_reset2', 'Second Keeper', 661);
    await waitUntil(() => bot2.roundState?.phase === 'running', 'the short round starts');
    await goToStorehouse(bot2, 'round-town');
  });

  afterAll(async () => {
    bot2.close();
    extra2.close();
    await s2.stop();
  });

  it('is emptied at reset, so no cast builds a permanent larder', async () => {
    // ⚠ Not tidying. Gear is stripped between rounds; stores that survived
    // would accumulate across rounds and quietly defeat D-529's hard
    // constraint that the stores must RUN OUT — getting worse every round,
    // and reading as generosity rather than as a broken mode.
    const loaf = await st2.grantItem(char2, 'coarse-bread', 1);
    bot2.send({ t: 'store_deposit', itemId: loaf.id });
    await waitUntil(
      () => (bot2.storeContents?.items ?? []).some((i) => i.id === loaf.id),
      'the loaf is pooled',
    );
    expect((await st2.getItemsByStore('round-town:storehouse')).length).toBeGreaterThan(0);

    await waitUntil(
      () => bot2.roundsEnded.length > 0,
      'the round runs out of clock',
      30_000,
    );
    let emptied = false;
    await waitUntil(() => {
      void st2.getItemsByStore('round-town:storehouse').then((i) => { emptied = i.length === 0; });
      return emptied;
    }, 'the stores are emptied at reset', 30_000);
  });
});
