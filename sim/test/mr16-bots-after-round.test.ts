import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadContent } from '@rc/server/content';
import { GameServer } from '@rc/server/net/gateway';
import { MemoryStore } from '@rc/server/store/memory';
import { BotClient } from '../src/botClient';
import { TICK as SIM_TICK, sleep } from '../src/testTick';

/**
 * The lobby's bots are still there when the round ends (D-643).
 *
 * The stakeholder's note: "at the end of the round, the bots did not respawn
 * in the tavern — it was just me alone." mr10-second-round proves two REAL
 * clients are gathered at the reset; this proves it for the companions the
 * lobby summoned (D-607), which are the cast a person actually plays with,
 * and it proves it from the person's own mirror: what THEY see standing in
 * the taproom after the reset, not what the server believes.
 */

const contentDir = fileURLToPath(new URL('../../content', import.meta.url));
const TICK = SIM_TICK;
const HOME = 'hanged-ferryman';

async function waitUntil(pred: () => boolean, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(TICK * 4);
  }
  throw new Error(`timed out waiting until ${what}`);
}

let server: GameServer;
let me: BotClient;

beforeAll(async () => {
  server = new GameServer({
    store: new MemoryStore(),
    content: loadContent(contentDir),
    port: 0,
    tickIntervalMs: TICK,
    defaultAreaId: HOME,
    allowBots: true,
    round: {
      enabled: true,
      seed: 'bots-after-round',
      minCast: 3,
      // Short enough to run out on the clock: the round ends 'survived'.
      lengthTicks: 600,
      graceTicks: 0,
      thinCastTicks: 20,
      resolutionTicks: 20,
    },
  });
  await server.start();
  me = await BotClient.connect(`ws://127.0.0.1:${server.port}`);
  me.send({ t: 'register', username: 'lonely', password: 'password-word' });
  await me.expect('auth_ok');
  me.send({ t: 'create_character', name: 'Aldric Vane', appearanceSeed: 7 });
  const made = await me.expect('character_created');
  me.send({ t: 'enter_world', characterId: made.character.id });
  await me.expect('snapshot');
});

afterAll(async () => {
  me?.close();
  await server?.stop();
});

describe('the companions after the round (D-643)', () => {
  it('⚠ are standing in the taproom with the player once the round has reset', async () => {
    me.send({ t: 'add_bots', count: 2 });
    await waitUntil(() => (me.roundState?.bots ?? 0) >= 2, 'two bots have joined');
    await waitUntil(() => me.roundState?.phase === 'running', 'the round begins');
    const others = () => [...me.entities.values()].filter((e) => e.id !== me.you && e.kind === 'player');
    await waitUntil(() => others().length >= 2, 'the player sees both companions at the start');

    // The round runs out on the clock, resolves, and resets.
    await waitUntil(() => me.roundState?.phase === 'resolved', 'the round resolves', 120_000);
    await waitUntil(
      () => me.roundState?.phase !== 'resolved' && me.area?.id === HOME,
      'the reset has gathered everybody home',
      60_000,
    );
    // ⚠ The bots are still counted, and still SEEN — from the player's own
    // mirror, after the fresh snapshot the reset sends.
    expect(me.roundState?.bots, 'the companions are still in the lobby').toBe(2);
    await waitUntil(() => others().length >= 2, 'the player sees both companions after the reset', 30_000);
    // Seen at all means alive: the living never see a ghost (D-203).
    expect(me.violations).toEqual([]);
  }, 240_000);
});
