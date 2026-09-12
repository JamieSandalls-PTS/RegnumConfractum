import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectiveSchema, type ObjectiveDef } from '@rc/shared';
import { loadContent } from '@rc/server/content';
import { GameServer } from '@rc/server/net/gateway';
import { MemoryStore } from '@rc/server/store/memory';
import { BotClient } from '../src/botClient';

/**
 * Arriving in a round that is already running (D-521, fixed in D-579).
 *
 * ⚠ `round_role` was sent once, in a loop over the connections present when
 * the round STARTED. Two people it never reached:
 *
 *   1. Anyone who joins mid-round, who is told nothing at all.
 *   2. ⚠ **The antagonist who drops and reconnects** — and that is the severe
 *      one. `secretRole` is keyed on the CHARACTER, so the role survives the
 *      disconnect perfectly well on the server; the objective simply never
 *      got sent again. A round is one player having a secret task, and a
 *      dropped connection silently disarmed it while the round kept running.
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

const KILL_KEEPER: ObjectiveDef = ObjectiveSchema.parse({
  id: 'test-kill-keeper',
  name: 'Silence the Keeper',
  brief: 'The keeper must not see morning.',
  kind: { type: 'kill_npc', descriptor: 'the keeper' },
  minCast: 3,
});

let store: MemoryStore;
let server: GameServer;
let url = '';
const bots: BotClient[] = [];
const charIds: string[] = [];

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
    rngSeed: 41,
    defaultAreaId: 'round-town',
    ghostMinTicks: 50,
    attackCooldownTicks: 2,
    bleedIntervalTicks: 5000,
    round: {
      enabled: true,
      lengthTicks: 60_000,
      minCast: 3,
      graceTicks: 0,
      seed: 'mr5-rejoin',
      objectives: [KILL_KEEPER],
      resolutionTicks: 10,
    },
  });
  await server.start();
  url = `ws://127.0.0.1:${server.port}`;
  for (let i = 0; i < 3; i++) {
    const bot = await BotClient.connect(url);
    bots.push(bot);
    charIds.push(await join(bot, `rejoin_${i}`, `Rejoin Cast${'X'.repeat(i)}`, 700 + i));
  }
  await waitUntil(() => bots[0]!.roundState?.phase === 'running', 'the round starts');
  await waitUntil(() => bots.every((b) => b.roundRole !== null), 'everyone is told their role');
});

afterAll(async () => {
  for (const b of bots) b.close();
  await server.stop();
});

describe('joining a round already in progress (D-579)', () => {
  it('tells a late arrival their role, like everybody else', async () => {
    const late = await BotClient.connect(url);
    bots.push(late);
    charIds.push(await join(late, 'rejoin_late', 'Latecomer', 710));

    // ⚠ The message must ARRIVE, carrying `antagonist: false`. Silence is not
    // the same thing: a player with no role message cannot tell "you are not
    // the antagonist" from "the server has not told you yet", and the whole
    // mode rests on knowing which you are.
    await waitUntil(() => late.roundRole !== null, 'the latecomer is told their role');
    expect(late.roundRole!.antagonist).toBe(false);
    expect(late.roundRole!.objective).toBeNull();
  });

  it('knows there is a round on at all', async () => {
    // The HUD is driven by `round_state`; without it a latecomer stands in a
    // running round with a lobby clock.
    const late = bots[3]!;
    await waitUntil(() => late.roundState?.phase === 'running', 'the latecomer sees the round');
  });

  it('⚠ gives the antagonist their objective back when they reconnect', async () => {
    const index = bots.findIndex((b) => b.roundRole?.antagonist);
    expect(index).toBeGreaterThanOrEqual(0);
    const before = bots[index]!.roundRole!;
    expect(before.objective).not.toBeNull();

    bots[index]!.close();
    // Let the server notice the socket has gone, or `enter_world` is refused
    // with "character is already online".
    await sleep(TICK * 40);

    const again = await BotClient.connect(url);
    bots[index] = again;
    again.send({ t: 'login', username: `rejoin_${index}`, password: 'password-word' });
    await again.expect('auth_ok');
    again.send({ t: 'enter_world', characterId: charIds[index]! });
    await again.expect('snapshot');

    await waitUntil(() => again.roundRole !== null, 'the antagonist is told again');
    expect(again.roundRole!.antagonist).toBe(true);
    // ⚠ The same objective, not a fresh draw. Re-rolling it would change the
    // round's win condition halfway through because somebody's wifi dropped.
    expect(again.roundRole!.objective?.id).toBe(before.objective!.id);
  });
});
