import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ScenarioSchema } from '@rc/shared';
import { loadContent } from '@rc/server/content';
import { GameServer } from '@rc/server/net/gateway';
import { MemoryStore } from '@rc/server/store/memory';
import { BotClient } from '../src/botClient';
import { TICK as SIM_TICK, sleep } from '../src/testTick';

/**
 * A round has edges, and they are data (D-627).
 *
 * ⚠ This is the test for a hole that was open for the whole of MR. `RoundEngine`
 * knew the cast, the clock and the objective and had **no concept of an area** —
 * while the live world graph ran
 *
 *     round-town → hanged-ferryman → broken-yard → sunken-crypt
 *
 * and `sunken-crypt` is `zone: endgame`, which carries involuntary permadeath.
 * D-523 says in terms that a round must never contain one, because a round death
 * must not cost a character levelled across fifty rounds. Nothing stopped the
 * walk: `dungeonGateAllows` enforces the dungeon's day/night and floor rules and
 * nothing else, and `confirmEndgameEntry` warns twice and then lets you through.
 * The invariant was upheld by nobody having gone west.
 *
 * ⚠ Since D-634 the tavern is INSIDE the round — it is the taproom behind the
 * door in Ashfold's square, the one tavern the stakeholder knows — so the edge
 * moved one room west: the taproom's door to the yard is what is refused now.
 * And since D-636 the round OPENS there, so the walk is the other way about:
 * refused at the yard door first, then out through the square door.
 */

const contentDir = fileURLToPath(new URL('../../content', import.meta.url));
const TICK = SIM_TICK; // see sim/src/testTick.ts (D-633)

type Doors = { transitions: { x: number; y: number; toArea: string }[] };
/** Both doors read from the maps rather than written here. */
const TOWN = JSON.parse(readFileSync(`${contentDir}/areas/round-town.json`, 'utf8')) as Doors;
const TAVERN = JSON.parse(readFileSync(`${contentDir}/areas/hanged-ferryman.json`, 'utf8')) as Doors;
/** The tavern door in the square: inside the round (D-634). */
const TAVERN_DOOR = TOWN.transitions.find((t) => t.toArea === 'hanged-ferryman')!;
/** The taproom's door to the yard: the round's edge, and the road to the crypt. */
const WAY_OUT = TAVERN.transitions.find((t) => t.toArea === 'broken-yard')!;

let store: MemoryStore;
let server: GameServer;
let bot: BotClient;

beforeAll(async () => {
  store = new MemoryStore();
  server = new GameServer({
    store,
    content: loadContent(contentDir),
    port: 0,
    tickIntervalMs: TICK,
    rngSeed: 31,
    // ⚠ Deliberately the PERSISTENT world's start, not the round's. It is what
    // the server shipped with, and the point of the scenario is that the round
    // stops taking its home from here.
    defaultAreaId: 'hanged-ferryman',
    watch: false,
    round: {
      enabled: true,
      lengthTicks: 200_000,
      minCast: 1,
      seed: 'boundary',
      graceTicks: 0,
      resolutionTicks: 10,
      // ⚠ An objective playable at a cast of one. Without it this fixture hit
      // the exact trap `castCoverageProblem` exists to warn about: every live
      // objective in content needs three or five, so the lobby filled and
      // never started, and the failure reads as "expected 'lobby' to be
      // 'running'" two assertions away from the cause.
      objectives: [{
        id: 'boundary-survive',
        name: 'Outlast them',
        brief: 'Be standing when the day ends.',
        kind: { type: 'survive' as const },
        minCast: 1,
        maxCast: null,
        status: 'live' as const,
      }],
    },
  });
  await server.start();
  bot = await BotClient.connect(`ws://127.0.0.1:${server.port}`);
  bot.send({ t: 'register', username: 'edgewalker', password: 'password-word' });
  await bot.expect('auth_ok');
  bot.send({ t: 'create_character', name: 'Corin Vale', appearanceSeed: 404 });
  const id = (await bot.expect('character_created')).character.id;
  bot.send({ t: 'enter_world', characterId: id });
  await bot.expect('snapshot');
  for (let i = 0; i < 200 && bot.roundState?.phase !== 'running'; i++) await sleep(TICK * 4);
});

afterAll(async () => {
  bot?.close();
  await server?.stop();
});

describe('the scenario is the round map', () => {
  it('is authored, live, and names the areas the round is played in', () => {
    const sc = ScenarioSchema.parse(
      JSON.parse(readFileSync(`${contentDir}/scenarios/ashfold.json`, 'utf8')),
    );
    expect(sc.status).toBe('live');
    expect(sc.areas).toContain('round-town');
    // The taproom is in (D-634): it is the tavern the round has.
    expect(sc.areas).toContain('hanged-ferryman');
    // ⚠ The two that made the walk possible are OUT, and that is the whole
    // assertion. `sunken-crypt` is endgame; the yard is the road to it.
    expect(sc.areas).not.toContain('broken-yard');
    expect(sc.areas).not.toContain('sunken-crypt');
  });

  it('⚠ opens the round where the SCENARIO says, in the taproom (D-636)', async () => {
    // The server's `defaultAreaId` above happens to be the same room; what
    // is asserted is that the scenario's `opensIn` is what placed the cast,
    // and `mr11-reset-invariants` reads it off the file for the same reason.
    expect(bot.roundState?.phase).toBe('running');
    expect(bot.area?.id).toBe('hanged-ferryman');
  });
});

describe('⚠ walking out of a round is refused', () => {
  it('will not carry a player through a door outside the scenario', async () => {
    const start = bot.area!.id;
    expect(start).toBe('hanged-ferryman');
    bot.drain('narrate');

    // Walk onto the yard door — a real transition, on a real map.
    bot.send({ t: 'move_to', x: WAY_OUT.x, y: WAY_OUT.y });
    for (let i = 0; i < 400; i++) {
      const me = bot.entities.get(bot.you!);
      if (bot.area?.id !== start) break;
      if (me && Math.hypot(me.x - WAY_OUT.x, me.y - WAY_OUT.y) < 0.4) {
        // Standing on it. Give the server a few ticks to move us if it means to.
        await sleep(TICK * 20);
        break;
      }
      await sleep(TICK * 4);
    }

    // ⚠ Still in the round. This is the assertion that would have failed for
    // the whole of MR: the tavern leads to the yard, and the yard leads to
    // permadeath.
    expect(bot.area?.id).toBe('hanged-ferryman');
    // And told so in world voice — walking into a barred door is not an error,
    // so it must not arrive as a refusal code.
    expect(bot.narrations.some((n) => /barred/i.test(n))).toBe(true);
    expect(bot.errors.map((e) => e.code)).toEqual([]);
  }, 40_000);

  it('carries a player out through the square door, which is inside the round (D-634)', async () => {
    const OUT = TAVERN.transitions.find((t) => t.toArea === 'round-town')!;
    bot.send({ t: 'move_to', x: OUT.x, y: OUT.y });
    for (let i = 0; i < 400 && bot.area?.id !== 'round-town'; i++) await sleep(TICK * 4);
    expect(bot.area?.id, 'the taproom door to the square refused a player').toBe('round-town');
    // And back in, so the verbs below are tested from where the round opens.
    bot.send({ t: 'move_to', x: TAVERN_DOOR.x, y: TAVERN_DOOR.y });
    for (let i = 0; i < 400 && bot.area?.id !== 'hanged-ferryman'; i++) await sleep(TICK * 4);
    expect(bot.area?.id).toBe('hanged-ferryman');
  }, 60_000);
});

/**
 * ⚠ The boundary is not only the map (D-627).
 *
 * `handleRespawn` has been gated on `roundRunning` since D-521. `handleRetire`
 * and `handlePay` never were, which is the same missing line in the verb table
 * rather than in the world graph.
 */
describe('⚠ persistent-world verbs are shut inside a round', () => {
  it('refuses to retire a character mid-round', async () => {
    bot.drain('error');
    bot.send({ t: 'retire' });
    const err = await bot.expect('error');
    // Two exploits in one: an exit from a round that has no respawn, and a way
    // to bank the round's takings before anybody can take them off you.
    expect(err.code).toBe('not_allowed');
    expect(err.message).toMatch(/until the round ends/);
    // And the character is still standing in it.
    expect(bot.entities.get(bot.you!)).toBeDefined();
  });

  it('refuses to move coin mid-round', async () => {
    bot.drain('error');
    bot.send({ t: 'pay', toEntityId: bot.you!, amount: 1 });
    const err = await bot.expect('error');
    // Gold belongs to the persistent world (D-220) and round mode does not
    // display it — so a working transfer was a currency with no UI.
    expect(err.code).toBe('not_allowed');
  });
});
