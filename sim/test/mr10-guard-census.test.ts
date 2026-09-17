import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectiveSchema, type ObjectiveDef } from '@rc/shared';
import { loadContent } from '@rc/server/content';
import { GameServer } from '@rc/server/net/gateway';
import { MemoryStore } from '@rc/server/store/memory';
import { BotClient } from '../src/botClient';

/**
 * The watch does not accumulate (D-610).
 *
 * ⚠ Reported as "the bots seem to be duplicating each round". They were not —
 * the CAST stayed at three every round. What grew was the town watch: four
 * more guards each round, never removed, 17 NPCs becoming 41 over four rounds.
 * At that rate an evening's play turns Ashfold's square into a wall of
 * watchmen, and every one of them is a witness (D-552).
 */

const contentDir = fileURLToPath(new URL('../../content', import.meta.url));
const TICK = 5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(pred: () => boolean, what: string, timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(15);
  }
  throw new Error(`timed out waiting until ${what}`);
}

const SURVIVE: ObjectiveDef = ObjectiveSchema.parse({
  id: 'test-survive', name: 'Endure', brief: 'Live.', kind: { type: 'survive' }, minCast: 2,
});

let server: GameServer;
const cast: BotClient[] = [];

const guardsSeenBy = (b: BotClient): number =>
  [...b.entities.values()].filter((e) => e.kind === 'npc' && /watchman/.test(e.descriptor ?? '')).length;

beforeAll(async () => {
  server = new GameServer({
    store: new MemoryStore(),
    content: loadContent(contentDir),
    port: 0,
    tickIntervalMs: TICK,
    rngSeed: 31,
    defaultAreaId: 'round-town', // the watch walks the town, so stand in it
    bleedIntervalTicks: 100_000,
    round: {
      enabled: true, minCast: 2, lengthTicks: 60_000, graceTicks: 0,
      seed: 'guards', objectives: [SURVIVE], resolutionTicks: 10,
      dayTicks: 100_000, // no dusk: night roamers are a different question
      placeArrivals: false,
      thinCastTicks: 0,
    },
  });
  await server.start();
  for (const [i, name] of [['g_one', 'Aldric Venn'], ['g_two', 'Bekka Thorne']].entries()) {
    const bot = await BotClient.connect(`ws://127.0.0.1:${server.port}`);
    cast.push(bot);
    bot.send({ t: 'register', username: name[0]!, password: 'password-word' });
    await bot.expect('auth_ok');
    bot.send({ t: 'create_character', name: name[1]!, appearanceSeed: 600 + i });
    const made = await bot.expect('character_created');
    bot.send({ t: 'enter_world', characterId: made.character.id });
    await bot.expect('snapshot');
  }
  await waitUntil(() => cast.every((b) => b.roundState?.phase === 'running'), 'the first round begins');
  await sleep(500);
}, 60_000);

afterAll(async () => {
  for (const b of cast) b.close();
  await server.stop();
});

describe('the town watch across rounds', () => {
  it('⚠ is the SAME size every round, not one more patrol each time', async () => {
    const bot = cast[0]!;
    const first = guardsSeenBy(bot);
    expect(first, 'the watch is on the map at all').toBeGreaterThan(0);

    const counts = [first];
    for (let round = 2; round <= 4; round++) {
      await server.adminRestartRound();
      await waitUntil(() => bot.roundState?.phase === 'running', `round ${round} begins`);
      await sleep(600);
      counts.push(guardsSeenBy(bot));
    }
    // ⚠ Asserted as EQUALITY across rounds rather than "below some ceiling".
    // A cap would pass while the leak was still there and merely slower, and
    // the number itself is unratified (D-552) so hard-coding it would break
    // the moment somebody tunes the patrol.
    expect(counts, `watch per round: ${counts.join(' → ')}`).toEqual(counts.map(() => first));
    for (const b of cast) expect(b.violations).toEqual([]);
  }, 120_000);
});

/**
 * ⚠ The half of the same bug that nothing would ever have reported.
 *
 * `witnessCrime` walks the SAME `roamers` map, so wiping it did not merely
 * leak guards — it made the watch blind. Every watchman on the map became
 * scenery: still standing there, still drawn, and incapable of seeing a
 * murder committed in front of them (D-552, D-217).
 *
 * ⚠ And it fired at every DAWN, not only at a reset (D-551), so the watch was
 * blind from the first morning of the first round. Nothing errors, nothing
 * looks wrong, and the only symptom is that the town is quietly lawless.
 */
describe('the watch can still see after a night has passed', () => {
  let s: GameServer;
  let store: MemoryStore;
  const bots: BotClient[] = [];

  afterAll(async () => {
    for (const b of bots) b.close();
    await s?.stop();
  });

  it('⚠ witnesses a killing in the square AFTER a dawn has cleared the night', async () => {
    store = new MemoryStore();
    s = new GameServer({
      store,
      content: loadContent(contentDir),
      port: 0,
      tickIntervalMs: TICK,
      rngSeed: 77,
      defaultAreaId: 'round-town',
      bleedIntervalTicks: 100_000,
      attackCooldownTicks: 2,
      round: {
        // ⚠ Two, not one: the fixture objective declares `minCast: 2` and a
        // round refuses an objective it cannot run — the lobby fills and
        // never starts, which presents as 'timed out waiting for the round'.
        enabled: true, minCast: 2, lengthTicks: 200_000, graceTicks: 0,
        seed: 'watch-after-dawn', objectives: [SURVIVE], resolutionTicks: 10,
        // A short cycle so dusk and dawn both pass inside the test. The rule
        // is tick-based, so this changes pacing and nothing else.
        dayTicks: 1200,
        placeArrivals: false,
        thinCastTicks: 0,
      },
    });
    await s.start();

    const killer = await BotClient.connect(`ws://127.0.0.1:${s.port}`);
    bots.push(killer);
    killer.send({ t: 'register', username: 'dawn_killer', password: 'password-word' });
    await killer.expect('auth_ok');
    killer.send({ t: 'create_character', name: 'Bloody Aldren', appearanceSeed: 41 });
    const made = await killer.expect('character_created');
    // In the open square beside the well, where the watch actually walks.
    await store.saveCharacterPosition(made.character.id, 'round-town', 25, 31);
    killer.send({ t: 'enter_world', characterId: made.character.id });
    await killer.expect('snapshot');
    // A second body, so the cast reaches the minimum. It stands well away and
    // does nothing — the round needs two, the crime needs one.
    const idler = await BotClient.connect(`ws://127.0.0.1:${s.port}`);
    bots.push(idler);
    idler.send({ t: 'register', username: 'dawn_idler', password: 'password-word' });
    await idler.expect('auth_ok');
    idler.send({ t: 'create_character', name: 'Quiet Aldren', appearanceSeed: 42 });
    const idle = await idler.expect('character_created');
    await store.saveCharacterPosition(idle.character.id, 'round-town', 25, 20);
    idler.send({ t: 'enter_world', characterId: idle.character.id });
    await idler.expect('snapshot');
    await waitUntil(() => killer.roundState?.phase === 'running', 'the round begins');

    // ⚠ Through a whole night and out the other side. Dawn is what calls
    // `despawnRoamers`, and that call is what used to blind the watch.
    await waitUntil(() => killer.roundState?.night === true, 'night falls', 40_000);
    await waitUntil(() => killer.roundState?.night === false, 'dawn comes', 40_000);
    await sleep(400);

    const seen = (): boolean => killer.narrations.join(' ').includes('watchman has seen you');
    for (let i = 0; i < 40 && !seen(); i++) {
      const victim = s.spawnNpc('round-town', { x: 26, y: 31, descriptor: 'a stranger' });
      killer.send({ t: 'attack', targetEntityId: victim });
      await sleep(TICK * 60);
    }
    expect(seen(), 'the watch is still watching after the sun came up').toBe(true);
  }, 140_000);
});
