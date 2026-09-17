import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadContent } from '@rc/server/content';
import { GameServer } from '@rc/server/net/gateway';
import { MemoryStore } from '@rc/server/store/memory';
import { BotClient } from '../src/botClient';
import { TICK as SIM_TICK, sleep } from '../src/testTick';

/**
 * Filling the cast from inside the game (D-607).
 *
 * ⚠ The gap this closes is not a missing feature, it is a mode nobody could
 * reach. The Round needs three (D-522) and the go/no-go gate is one person
 * playing one (D-114) — so between "log in" and "play a round" sat a second
 * terminal and a command that is invisible from the lobby.
 *
 * ⚠ What is asserted here is deliberately the WIRE, not the stable. Bots being
 * ordinary clients is the property D-540 rests on: an in-process shortcut
 * would satisfy every assertion about cast size while quietly making bot
 * rounds evidence about the harness instead of about the game. So the test
 * watches the cast count a PLAYER's client is told about, and the round start
 * that follows from it.
 */

const contentDir = fileURLToPath(new URL('../../content', import.meta.url));
const TICK = SIM_TICK; // see sim/src/testTick.ts (D-633)

async function waitUntil(pred: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(20);
  }
  throw new Error(`timed out waiting until ${what}`);
}

let server: GameServer | null = null;
const opened: BotClient[] = [];

async function boot(allowBots: boolean): Promise<GameServer> {
  const s = new GameServer({
    store: new MemoryStore(),
    content: loadContent(contentDir),
    port: 0,
    tickIntervalMs: TICK,
    defaultAreaId: 'round-town',
    allowBots,
    round: {
      enabled: true,
      seed: 'lobby-bots',
      minCast: 3,
      lengthTicks: 4000,
      // No truce: this test is about getting a round STARTED, and sixty
      // seconds of enforced peace is sixty seconds of nothing to assert.
      graceTicks: 0,
      // ⚠ Two seconds rather than thirty: the wait exists so a dropped
      // connection does not end a round, and nothing here is reconnecting.
      thinCastTicks: 20,
      resolutionTicks: 20,
    },
  });
  await s.start();
  server = s;
  return s;
}

/** A human player: registers, makes a character, walks in. */
async function player(s: GameServer, name: string): Promise<BotClient> {
  const c = await BotClient.connect(`ws://127.0.0.1:${s.port}`);
  opened.push(c);
  c.send({ t: 'register', username: name.toLowerCase(), password: 'password-word' });
  await c.expect('auth_ok');
  c.send({ t: 'create_character', name, appearanceSeed: 7 });
  const made = await c.expect('character_created');
  c.send({ t: 'enter_world', characterId: made.character.id });
  await c.expect('snapshot');
  return c;
}

afterEach(async () => {
  for (const c of opened.splice(0)) c.close();
  await server?.stop();
  server = null;
});

describe('a lobby can fill its own cast', () => {
  it('brings bots in over the wire, and the round starts', async () => {
    const s = await boot(true);
    const me = await player(s, 'Aldric');
    // ⚠ Present ALREADY, without waiting. A lobby broadcasts every fifty
    // ticks, so before D-607 a player who had just logged in stood in a town
    // with no HUD for up to five seconds — and the lobby is where the controls
    // for filling the cast live, so the first thing a lone player needs was
    // the last thing to arrive.
    expect(me.roundState?.phase, 'the lobby is reported on arrival').toBe('lobby');

    // ⚠ One player is one short of nothing happening, and that is the state
    // the stakeholder was actually sitting in.
    expect(me.roundState!.cast).toBe(1);
    expect(me.roundState!.bots).toBe(0);
    expect(me.roundState!.botsAllowed).toBe(true);

    me.send({ t: 'add_bots', count: 2 });
    await waitUntil(() => (me.roundState?.bots ?? 0) >= 2, 'two bots have joined');
    expect(me.roundState!.cast).toBeGreaterThanOrEqual(3);

    // The whole point: a round that a person alone at a keyboard can play.
    await waitUntil(() => me.roundState?.phase === 'running', 'the round begins');
    // Everyone is dealt a role, only one carries an objective (D-521, D-579).
    await waitUntil(() => me.roundRole !== null, 'the player is told what they are');
    expect(me.violations).toEqual([]);
  }, 40_000);

  it('sends them home again, and says so in the state', async () => {
    const s = await boot(true);
    const me = await player(s, 'Bekka');
    await waitUntil(() => me.roundState?.phase === 'lobby', 'the lobby reports itself');
    me.send({ t: 'add_bots', count: 1 });
    await waitUntil(() => (me.roundState?.bots ?? 0) === 1, 'one bot joined');
    me.send({ t: 'remove_bots' });
    await waitUntil(() => (me.roundState?.bots ?? 0) === 0, 'the bot went home');
  }, 40_000);

  it('refuses out loud where bots are forbidden', async () => {
    // ⚠ The refusal is the test. A server that ignored the verb would leave
    // the client drawing a control that does nothing, which is indistinguish-
    // able from a broken one — and on a public server this verb registers
    // accounts on demand, so 'forbidden' has to be a real answer.
    const s = await boot(false);
    const me = await player(s, 'Corin');
    await waitUntil(() => me.roundState !== null, 'the round state arrives');
    expect(me.roundState!.botsAllowed).toBe(false);
    me.send({ t: 'add_bots', count: 2 });
    await waitUntil(() => me.errors.length > 0, 'the server refuses');
    expect(me.errors[0]!.code).toBe('not_allowed');
    await sleep(200);
    expect(me.roundState!.bots).toBe(0);
  }, 30_000);
});

describe('a round the players have left', () => {
  it('is abandoned, so the lobby comes back', async () => {
    // ⚠ The dead end this closes: `abandoned` has been a documented outcome
    // since D-521 ("too few players remained connected to continue") and
    // nothing ever produced one except the DM's restart button. A round whose
    // cast had all disconnected ran on to its full length with nobody in it —
    // and the next person to log in did not arrive in a lobby, they arrived as
    // a latecomer in a round that could not be won, with the bot controls
    // hidden because the controls are a LOBBY thing.
    const s = await boot(true);
    const me = await player(s, 'Delia');
    me.send({ t: 'add_bots', count: 2 });
    await waitUntil(() => me.roundState?.phase === 'running', 'a round is running');

    // Everybody leaves. ⚠ Not a death — dying is how a round is SUPPOSED to
    // shrink, and `cast_wiped` is a result rather than a desertion.
    me.send({ t: 'remove_bots' });
    await waitUntil(() => (me.roundState?.bots ?? 1) === 0, 'the bots have gone');
    await waitUntil(() => me.roundState?.phase !== 'running', 'the round gives up', 30_000);

    // And it is startable again from where the player is standing.
    await waitUntil(() => me.roundState?.phase === 'lobby', 'the lobby is back', 30_000);
    expect(me.roundState!.botsAllowed).toBe(true);
    expect(me.violations).toEqual([]);
  }, 60_000);
});
