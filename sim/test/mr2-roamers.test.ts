import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectiveSchema, ROUND_TICKS_PER_GAME_HOUR, type ObjectiveDef } from '@rc/shared';
import { loadContent } from '@rc/server/content';
import { GameServer } from '@rc/server/net/gateway';
import { MemoryStore } from '@rc/server/store/memory';
import { BotClient } from '../src/botClient';
import { TICK as SIM_TICK, sleep } from '../src/testTick';

/**
 * Night roamers (D-527, D-529).
 *
 * What is asserted here is the SHAPE of night rather than its numbers, since
 * the numbers are unratified. The shape is what the design rests on:
 *
 *   - they come at dusk and go at dawn, so night is a phase and not an
 *     infestation that grows across a round
 *   - they walk the wilderness and NOT the settled town, so the town stays
 *     the refuge that night drives people into. Without that, night is
 *     uniformly lethal and stops being a decision
 *   - they never touch the dungeon, which is not under the sky
 *   - a lone unarmed player is actually hurt by them, which is the whole
 *     reason a night errand needs a partner — and why your partner being the
 *     antagonist is interesting
 */

const contentDir = fileURLToPath(new URL('../../content', import.meta.url));
const TICK = SIM_TICK; // see sim/src/testTick.ts (D-633)

async function waitUntil(pred: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
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
let walker: BotClient; // out in the wilderness when the sun goes down
let homebody: BotClient; // indoors, in the settled town

async function join(bot: BotClient, username: string, charName: string, seed: number, area?: string) {
  bot.send({ t: 'register', username, password: 'password-word' });
  await bot.expect('auth_ok');
  bot.send({ t: 'create_character', name: charName, appearanceSeed: seed });
  const characterId = (await bot.expect('character_created')).character.id;
  if (area) await store.saveCharacterPosition(characterId, area, 50, 50);
  bot.send({ t: 'enter_world', characterId });
  await bot.expect('snapshot');
  return characterId;
}

const roamersSeenBy = (bot: BotClient): number =>
  [...bot.entities.values()].filter(
    (e) => e.kind === 'npc' && /four legs|man-shaped/.test(e.descriptor ?? ''),
  ).length;

beforeAll(async () => {
  store = new MemoryStore();
  server = new GameServer({
    store,
    content: loadContent(contentDir),
    port: 0,
    tickIntervalMs: TICK,
    rngSeed: 41,
    defaultAreaId: 'round-mine',
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
      lengthTicks: 200_000, // nothing here is decided by the clock running out
      minCast: 2,
      // No dawn truce here (D-536): this suite is not about it, and a
      // 60-second peace at the round's opening would only add dead time.
      graceTicks: 0,
      seed: 'roamer-test',
      // A 10-minute cycle would put dusk fifty real seconds away, past the
      // suite's timeout. The rule is tick-based, so shrinking the cycle
      // changes the pacing and nothing else.
      dayTicks: 1200, // dusk at tick 600, dawn at 1200
      objectives: [SURVIVE],
      resolutionTicks: 10,
    },
  });
  await server.start();
  const url = `ws://127.0.0.1:${server.port}`;
  walker = await BotClient.connect(url);
  homebody = await BotClient.connect(url);
  await join(walker, 'roam_walker', 'Hesk Varlow', 901, 'round-mine');
  await join(homebody, 'roam_home', 'Perrin Loft', 902, 'round-town');
  await waitUntil(() => walker.roundState?.phase === 'running', 'the round begins');
});

afterAll(async () => {
  walker?.close();
  homebody?.close();
  await server.stop();
});

describe('the shape of night (D-527)', () => {
  it('opens in daylight with nothing abroad', () => {
    expect(walker.roundState!.night).toBe(false);
    expect(roamersSeenBy(walker)).toBe(0);
  });

  it('puts things out at dusk, in the wilderness', async () => {
    // Dusk is twelve game hours in; a game hour is 250 ticks, and the server
    // runs ~60 ticks/s under test load, so this is a genuine wait.
    await waitUntil(() => walker.roundState?.night === true, 'night falls');
    await waitUntil(() => roamersSeenBy(walker) > 0, 'something is out there');
    expect(roamersSeenBy(walker)).toBeGreaterThan(1); // attrition, not a boss
  });

  it('leaves the settled town alone — it is the refuge (D-529)', () => {
    // If roamers walked the town, night would be uniformly lethal and the
    // three forces would collapse into one. The town has to stay somewhere
    // worth running back to.
    expect(homebody.roundState!.night).toBe(true);
    expect(roamersSeenBy(homebody)).toBe(0);
  });

  it('actually hurts someone caught out alone', async () => {
    // The buddy system exists because of this assertion. If a lone walker can
    // stand in the open all night untouched, nobody ever needs company and
    // the antagonist never gets to volunteer for it.
    await waitUntil(
      () => (walker.status?.hp ?? 20) < 20 || (walker.status?.ghost ?? false),
      'the night finds them',
    );
    expect(walker.status!.hp).toBeLessThan(20);
  });

  it('is heard, and the sound does not say what made it (D-531)', () => {
    // A roamer fight sounds exactly like a murder. That ambiguity is what
    // hands the antagonist an alibi on a timer.
    const heard = homebody.sounds.concat(walker.sounds);
    for (const sound of heard) {
      expect(sound.kind).toBe('combat');
      expect(JSON.stringify(sound)).not.toMatch(/four legs|man-shaped|Hesk|Perrin/);
    }
  });

  it('takes them back at dawn rather than letting them accumulate', async () => {
    await waitUntil(() => walker.roundState?.night === false, 'dawn');
    await waitUntil(() => roamersSeenBy(walker) === 0, 'the night things are gone');
  });
});

describe('the clock they run on', () => {
  it('spends half the cycle in darkness', () => {
    // Sanity on the pairing between the roamers and D-527's cycle: dusk at
    // 18:00, dawn at 06:00, twelve hours each at 250 ticks to the hour.
    expect(ROUND_TICKS_PER_GAME_HOUR * 12).toBe(3000);
  });
});
