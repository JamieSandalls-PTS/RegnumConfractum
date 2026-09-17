import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectiveSchema, ScenarioSchema, type ObjectiveDef } from '@rc/shared';
import { loadContent } from '@rc/server/content';
import { GameServer } from '@rc/server/net/gateway';
import { MemoryStore } from '@rc/server/store/memory';
import { BotClient } from '../src/botClient';
import { TICK as SIM_TICK, sleep } from '../src/testTick';

/**
 * A round can be played TWICE (D-607).
 *
 * ⚠ Everything MR1 asserts is about one round. Two things were carried across
 * the reset that made the next one unplayable, and neither is visible from
 * inside a single round:
 *
 *   1. **The dead stayed dead.** Round death is not permadeath (D-522) and
 *      `respawn` is refused outright while a round runs — correctly. Nothing
 *      stood anybody up at the reset, so a killed player spent every
 *      subsequent round as a ghost. That reads as a bug in death, which is
 *      where I would have looked, and it is a missing line in reset.
 *   2. **The living stood where they stopped.** D-536's opening truce says
 *      'you have all woken in the same place'. From the second round on that
 *      was simply false — the cast opened scattered across six areas with a
 *      minute of enforced peace to spend walking back to each other.
 *
 * The round is driven to its end by killing the cast rather than by waiting
 * out the clock, because a wipe is the outcome that leaves ghosts to stand up.
 */

const contentDir = fileURLToPath(new URL('../../content', import.meta.url));

/**
 * Where a round opens, read from the SCENARIO (D-627).
 *
 * ⚠ This used to be the string `'hanged-ferryman'`, which was never the
 * property under test -- it was whatever this fixture's `defaultAreaId`
 * happened to be. A round's home is the scenario's opening area now, and the
 * persistent world's starting room is no longer allowed to decide it. Read
 * rather than restated so the two cannot drift.
 */
const HOME = ScenarioSchema.parse(
  JSON.parse(readFileSync(`${contentDir}/scenarios/ashfold.json`, 'utf8')),
).opensIn;
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
const cast: BotClient[] = [];
/** Character ids by username — the fixture needs them to plant a state. */
const ids = new Map<string, string>();

async function join(username: string, name: string, seed: number): Promise<BotClient> {
  const bot = await BotClient.connect(`ws://127.0.0.1:${server.port}`);
  cast.push(bot);
  bot.send({ t: 'register', username, password: 'password-word' });
  await bot.expect('auth_ok');
  bot.send({ t: 'create_character', name, appearanceSeed: seed });
  const made = await bot.expect('character_created');
  ids.set(username, made.character.id);
  bot.send({ t: 'enter_world', characterId: made.character.id });
  await bot.expect('snapshot');
  return bot;
}

beforeAll(async () => {
  store = new MemoryStore();
  server = new GameServer({
    store,
    content: loadContent(contentDir),
    port: 0,
    tickIntervalMs: TICK,
    rngSeed: 77,
    defaultAreaId: 'hanged-ferryman',
    bleedIntervalTicks: 100_000,
    // ⚠ A swing every two ticks rather than every four seconds (D-550).
    // Not pacing taste: the fight happens in the SQUARE, the watch answers a
    // crime in the square (D-552), and at the real cadence the guards killed
    // the attacker about as often as the attacker killed the victim — so the
    // suite failed at 'nobody died' roughly half the time, for a reason that
    // has nothing to do with what it is testing.
    attackCooldownTicks: 2,
    round: {
      enabled: true,
      minCast: 2,
      // ⚠ Long enough that the CLOCK never ends the first round. The first
      // version set 900 ticks — 4.5 real seconds at this tick interval — and
      // the round resolved while the kill loop was still swinging, so the
      // test failed reporting 'nobody died' when what had happened was
      // 'everybody ran out of time'.
      lengthTicks: 60_000,
      graceTicks: 0,
      seed: 'second-round',
      objectives: [SURVIVE],
      resolutionTicks: 20,
      dayTicks: 100_000, // no dusk: roamers are somebody else's suite
    },
  });
  await server.start();
  await join('sr_one', 'Aldric Venn', 501);
  await join('sr_two', 'Bekka Thorne', 502);
  await waitUntil(() => cast.every((b) => b.roundState?.phase === 'running'), 'the first round begins');
}, 60_000);

afterAll(async () => {
  for (const b of cast) b.close();
  await server.stop();
});

describe('the round after the round', () => {
  it('stands the dead back up and opens the next one where it says it does', async () => {
    const [a, b] = cast as [BotClient, BotClient];

    // Kill one of them outright, so there is a ghost to carry across.
    await waitUntil(() => a.entities.get(b.you!) !== undefined, 'they can see each other');
    // ⚠ Swings until it lands, rather than a fixed number of attempts. A
    // blow is a d20 roll now (D-606) and does 1–6, so twenty hit points is
    // twenty-odd CONNECTED blows at one swing per four-second round (D-550).
    // The first version budgeted 600 attempts and got the victim to 3hp, then
    // reported 'nobody died' — a pacing accident wearing the face of a broken
    // feature, which is exactly the reading that wastes an afternoon.
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline && !a.status?.ghost && !b.status?.ghost) {
      a.send({ t: 'attack', targetEntityId: b.you! });
      await sleep(TICK * 8);
    }
    // ⚠ Whoever FELL, not whoever was swung at. The fight is in the square
    // and the watch answers a crime in the square (D-552), so the attacker
    // going down is a perfectly ordinary outcome — and a test that insisted on
    // its chosen victim failed intermittently reporting 'nobody died', which
    // is both untrue and the most misleading sentence it could have printed.
    // What this suite needs is a death, not a particular one.
    const fallen = b.status?.ghost ? b : a;
    expect(fallen.status?.ghost, 'somebody is dead').toBe(true);

    // ⚠ Nothing here asks to respawn, deliberately. `respawn` is refused
    // while a round runs (mr1 asserts that) and a round death is not the
    // player's to undo — so if standing back up is going to happen at all it
    // has to happen at the reset, which is the thing under test. Sending the
    // verb would let a successful respawn satisfy every assertion below and
    // leave the actual defect in place.
    //
    // Killing one of a cast of two ends it either way: if they were carrying
    // the objective it is 'antagonist_dead', and if they were not there is
    // nobody left on the good side. The clock is not involved.
    await waitUntil(() => a.roundState?.phase === 'resolved', 'the round resolves', 40_000);
    // Still down when the round ends — which is what makes the next line
    // evidence rather than a coincidence.
    expect(fallen.status?.ghost, 'still a ghost when the round ended').toBe(true);

    // ⚠ Waits for the CONSEQUENCE, never for the lobby phase. Between the
    // reset and the next round starting there is about one tick, and which
    // side of it a poll lands on is a coin flip — a test that watched for
    // 'lobby' failed two runs in three for a reason that had nothing to do
    // with what it was checking.
    await waitUntil(() => fallen.status?.ghost === false, 'the dead are standing again', 60_000);
    expect(fallen.status!.hp).toBeGreaterThan(0);

    // Everyone is in the same place, which is what the truce claims.
    await waitUntil(
      () => a.area?.id === HOME && b.area?.id === HOME,
      'the cast is gathered where the round opens',
      60_000,
    );
    expect(a.entities.get(b.you!), 'they can see each other again').toBeTruthy();

    // And the next round actually begins, rather than waiting on a cast that
    // is technically present and mechanically dead.
    await waitUntil(() => a.roundState?.phase === 'running', 'a second round begins', 60_000);
    for (const bot of cast) expect(bot.violations).toEqual([]);
  }, 240_000);
});

describe('arriving for a round (D-608)', () => {
  it('puts a battered character in the tavern, whole', async () => {
    // ⚠ The state the stakeholder reported, planted exactly: a character
    // saved out in an area the round never opens in, carrying the health they
    // logged out with. Both halves were broken and only one of them LOOKED
    // like a bug — the wrong room is visible immediately, while seven hit
    // points out of twenty is invisible until the first thing that touches
    // you kills you, which reads as "I log in and I am dead".
    const joiner = await join('sr_three', 'Cass Weir', 503);
    const id = ids.get('sr_three')!;
    joiner.close();
    await sleep(400);
    // Planted AFTER the disconnect, so nothing flushes over it on the way out.
    await store.saveCharacterPosition(id, 'round-south', 20, 20);
    await store.saveCharacterVitals(id, { hp: 3 });

    const back = await BotClient.connect(`ws://127.0.0.1:${server.port}`);
    cast.push(back);
    back.send({ t: 'login', username: 'sr_three', password: 'password-word' });
    await back.expect('auth_ok');
    back.send({ t: 'enter_world', characterId: id });
    await back.expect('snapshot');
    await waitUntil(() => back.status !== null, 'the status arrives');

    expect(back.area?.id, 'placed where the round opens').toBe(HOME);
    expect(back.status!.ghost).toBe(false);
    expect(back.status!.hp, 'whole, not merely alive').toBe(back.status!.maxHp);
    expect(back.status!.hunger).toBe('sated');
    expect(back.status!.thirst).toBe('sated');
    expect(back.status!.injuries.filter((i) => i.severity === 'major')).toEqual([]);
    expect(back.violations).toEqual([]);
  }, 90_000);

  it('⚠ leaves somebody REJOINING a running round exactly where they were', async () => {
    // ⚠ The one carve-out, and it protects two separate things. Moving a
    // reconnecting player would undo whatever they had walked into, and for
    // the antagonist it would be a public relocation in the middle of their
    // own plan (D-579). It also keeps the mode's central rule intact: the dead
    // stay down until the round ends (D-521), and a "complete reset" applied
    // to a reconnecting corpse would be a respawn button made of wifi.
    const inCast = cast[1]!;
    const id = ids.get('sr_two')!;
    await waitUntil(() => inCast.roundState?.phase === 'running', 'a round is running');
    inCast.close();
    await sleep(400);
    await store.saveCharacterPosition(id, 'round-south', 21, 21);

    const back = await BotClient.connect(`ws://127.0.0.1:${server.port}`);
    cast.push(back);
    back.send({ t: 'login', username: 'sr_two', password: 'password-word' });
    await back.expect('auth_ok');
    back.send({ t: 'enter_world', characterId: id });
    await back.expect('snapshot');
    await waitUntil(() => back.status !== null, 'the status arrives');
    expect(back.area?.id, 'not moved out of the round they are in').toBe('round-south');
  }, 90_000);
});
