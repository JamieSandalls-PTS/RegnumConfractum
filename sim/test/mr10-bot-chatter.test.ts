import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectiveSchema, type ObjectiveDef } from '@rc/shared';
import { loadContent } from '@rc/server/content';
import { GameServer } from '@rc/server/net/gateway';
import { MemoryStore } from '@rc/server/store/memory';
import { BotClient } from '../src/botClient';
import { BotAgent } from '../src/botAgent';
import { TICK as SIM_TICK, sleep } from '../src/testTick';

/**
 * What the companions say, and how often (D-610).
 *
 * ⚠ Reported as "the bots talk too much". Measured: the only speech they had
 * was a 6% roll per DECISION during the dawn truce, and a decision is every
 * 160ms — about one line every 2.7 seconds each. Three companions therefore
 * produced a line roughly every second, which buries anything a person says
 * in a mode whose whole point is people talking to each other (D-521).
 *
 * Three rules, and each is asserted rather than described:
 *   1. at most one line per agent per interval;
 *   2. never with nobody in earshot;
 *   3. what it says reports what the agent is actually doing.
 */

const contentDir = fileURLToPath(new URL('../../content', import.meta.url));
const TICK = SIM_TICK; // see sim/src/testTick.ts (D-633)

const SURVIVE: ObjectiveDef = ObjectiveSchema.parse({
  id: 'test-survive', name: 'Endure', brief: 'Live.', kind: { type: 'survive' }, minCast: 2,
});

let server: GameServer;
const opened: BotClient[] = [];
const agents: BotAgent[] = [];

async function join(username: string, name: string, seed: number): Promise<BotClient> {
  const bot = await BotClient.connect(`ws://127.0.0.1:${server.port}`);
  opened.push(bot);
  bot.send({ t: 'register', username, password: 'password-word' });
  await bot.expect('auth_ok');
  bot.send({ t: 'create_character', name, appearanceSeed: seed });
  const made = await bot.expect('character_created');
  bot.send({ t: 'enter_world', characterId: made.character.id });
  await bot.expect('snapshot');
  return bot;
}

beforeAll(async () => {
  server = new GameServer({
    store: new MemoryStore(),
    content: loadContent(contentDir),
    port: 0,
    tickIntervalMs: TICK,
    rngSeed: 19,
    defaultAreaId: 'hanged-ferryman',
    bleedIntervalTicks: 100_000,
    round: {
      enabled: true, minCast: 2, lengthTicks: 200_000, graceTicks: 0,
      seed: 'chatter', objectives: [SURVIVE], resolutionTicks: 10,
      dayTicks: 200_000, thinCastTicks: 0,
    },
  });
  await server.start();
}, 60_000);

afterAll(async () => {
  for (const a of agents) a.stop();
  for (const b of opened) b.close();
  await server.stop();
});

describe('companions keep their voices down', () => {
  it('⚠ says at most one thing per interval, however fast it thinks', async () => {
    const listener = await join('chat_ear', 'Quiet Listener', 11);
    const talker = await join('chat_one', 'Dorn Pickett', 12);
    const agent = new BotAgent(talker, {
      // ⚠ An IDLER, which keeps to the town. A gatherer walks to the mine
      // within a second and then has nobody in earshot — so the test measured
      // "the bot left the room" and passed with the throttle deleted. The
      // talker has to stay next to the listener for the gap to mean anything.
      role: 'idler',
      seed: 5,
      // 1s instead of 30s, so the shape is testable in a few seconds. The
      // cadence is what is under test, not the constant.
      speechIntervalMs: 1000,
      decisionMs: 20, // ⚠ deliberately FASTER than the real agent, because
                      // the old bug was exactly "speech rides on the decision
                      // rate". If the throttle is real, thinking 8x faster
                      // must not make it talk 8x more.
    });
    agents.push(agent);
    await sleep(300);
    listener.speeches.splice(0);
    agent.start();

    // ⚠ Timestamps, not a count. The first version of this test counted
    // lines in a window and PASSED with the throttle deleted — because the
    // "do not repeat yourself" check was quietly doing the work, and a count
    // cannot tell the two apart. What the stakeholder asked for is a minimum
    // GAP, so that is what is measured.
    const heard: { at: number; text: string }[] = [];
    const until = Date.now() + 4200;
    while (Date.now() < until) {
      for (const said of listener.speeches.splice(0)) {
        heard.push({ at: Date.now(), text: said.text });
      }
      await sleep(25);
    }
    agent.stop();

    expect(heard.length, 'it did speak at all').toBeGreaterThan(0);
    const gaps = heard.slice(1).map((h, i) => h.at - heard[i]!.at);
    // A little tolerance for the polling interval; nothing near the 20ms
    // decision rate the old behaviour spoke at.
    const tooSoon = gaps.filter((g) => g < 900);
    expect(
      tooSoon,
      `gaps were ${gaps.join(',')}ms for: ${heard.map((h) => h.text).join(' | ')}`,
    ).toEqual([]);
  }, 60_000);

  it('⚠ says nothing at all with nobody in earshot', async () => {
    // The half of "talks too much" that cannot be seen from inside the game:
    // lines spoken to an empty field still fill the transcript, and a
    // companion muttering to itself in the wood is not company.
    const alone = await join('chat_alone', 'Ulf Rethe', 13);
    // Take the only other body out of the room.
    for (const b of opened) if (b !== alone) b.close();
    await sleep(600);
    const agent = new BotAgent(alone, {
      role: 'woodsman', seed: 7, speechIntervalMs: 200, decisionMs: 20,
    });
    agents.push(agent);
    alone.speeches.splice(0);
    agent.start();
    await sleep(2500);
    agent.stop();
    expect(alone.speeches.map((s) => s.text)).toEqual([]);
  }, 60_000);
});

/**
 * What you are wearing survives the door (D-610).
 *
 * ⚠ Reported as "my character seems to lose all his clothing when
 * transitioning to a new area". `worn` (D-554, D-571, D-578) lives on the
 * ENTITY, and a transition despawns one entity and spawns another — carrying
 * `facing`, `ghost` and `presentation` across, but not this. The line above it
 * says "the hood survives the door", so the question had been asked once and
 * the answer was never revisited when equipment arrived three decisions later.
 *
 * ⚠ `publishWorn` could not repair it either: it compares against the previous
 * value and a fresh entity has none, so the wearer simply stood there
 * undressed until the next time they changed kit.
 */
describe('a door does not undress you', () => {
  it('⚠ keeps the silhouette across an area transition', async () => {
    const walker = await join('worn_walk', 'Corvin Ashe', 21);
    const mate = await join('worn_mate', 'Ilsabet Vane', 22);
    await sleep(300);
    // Everyone starts a round with a kit (D-547), so there is something to lose.
    await (async () => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && !walker.entities.get(walker.you!)?.worn) await sleep(50);
    })();
    const before = walker.entities.get(walker.you!)?.worn ?? null;
    expect(before, 'the walker is wearing something to begin with').toBeTruthy();

    // The tavern's door to the town is one tile south of the spawn.
    walker.send({ t: 'move_to', x: 12, y: 16 });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && walker.area?.id === 'hanged-ferryman') await sleep(50);
    expect(walker.area?.id, 'went through the door').toBe('round-town');
    await sleep(400);

    const after = walker.entities.get(walker.you!)?.worn ?? null;
    expect(after, 'still dressed on the other side').toBeTruthy();
    expect(after!.weapon).toBe(before!.weapon);
    expect(after!.garments).toEqual(before!.garments);
    void mate;
  }, 60_000);
});
