import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectiveSchema, type ObjectiveDef } from '@rc/shared';
import { loadContent } from '@rc/server/content';
import { GameServer } from '@rc/server/net/gateway';
import { MemoryStore } from '@rc/server/store/memory';
import { ScriptHost } from '@rc/server/script/host';
import { BotClient } from '../src/botClient';

/**
 * `silence-the-keeper` can be won (D-593).
 *
 * ⚠ It could not. The objective shipped `status: live`, so the round engine
 * deals it at random with nobody watching, and it named the keeper of the
 * Hanged Ferryman — who stands in the persistent world's tavern, while
 * `round-town` ran no scripts and did not link there. D-526 calls this the
 * low-cast workhorse. An antagonist dealt it could not win, and nothing in the
 * build said so.
 *
 * The assertions here are the two halves of "winnable": the target EXISTS in
 * the map the round is played in, wearing the exact descriptor the objective
 * names, and killing it SATISFIES the objective. Neither is implied by the
 * other — the engine matches by public descriptor rather than by id, so a
 * keeper who is there under a slightly better-sounding name is a keeper who
 * cannot be silenced.
 */

const contentDir = fileURLToPath(new URL('../../content', import.meta.url));
const OBJECTIVE: ObjectiveDef = ObjectiveSchema.parse(
  JSON.parse(readFileSync(`${contentDir}/objectives/silence-the-keeper.json`, 'utf8')),
);
const TICK = 5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let store: MemoryStore;
let server: GameServer;
let host: ScriptHost;
let bot: BotClient;
let characterId: string;

async function waitFor<T>(get: () => T | undefined, what: string, ms = 15_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const got = get();
    if (got !== undefined) return got;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

beforeAll(async () => {
  store = new MemoryStore();
  const content = loadContent(contentDir);
  server = new GameServer({
    store,
    content,
    port: 0,
    tickIntervalMs: TICK,
    rngSeed: 21,
    defaultAreaId: 'round-town',
    // ⚠ The ONE objective, so the antagonist cannot be dealt anything else.
    // A test that hopes for a particular random draw is a test that passes
    // four times in five.
    round: {
      enabled: true,
      lengthTicks: 200_000,
      minCast: 1,
      seed: 'keeper-test',
      dayTicks: 2400,
      graceTicks: 0,
      objectives: [{ ...OBJECTIVE, minCast: 1 }],
      resolutionTicks: 10,
    },
  });
  await server.start();
  // ⚠ Scripts do not run unless something hosts them. The real server does
  // (`server/src/index.ts`); the sim harness does not, so a round played
  // headlessly has no scripted NPCs in it at all unless a test says so.
  host = new ScriptHost(server, () => {});
  for (const area of content.areas.values()) {
    if (area.scripts.length > 0) {
      await host.loadAreaScripts(
        area.id,
        area.scripts.map((id) => ({ id, source: content.scripts.get(id)! })),
      );
    }
  }
  server.onTickHook = (tick) => host.tick(tick);
  server.onAreaEnter = (areaId, entityId) => host.onAreaEntered(areaId, entityId);

  bot = await BotClient.connect(`ws://127.0.0.1:${server.port}`);
  bot.send({ t: 'register', username: 'keeper_watch', password: 'password-word' });
  await bot.expect('auth_ok');
  bot.send({ t: 'create_character', name: 'Vell Ardry', appearanceSeed: 771 });
  const id = (await bot.expect('character_created')).character.id;
  bot.send({ t: 'enter_world', characterId: id });
  await bot.expect('snapshot');
  characterId = id;
});

afterAll(async () => {
  bot?.close();
  host?.dispose();
  await server?.stop();
});

describe('the keeper the round can actually reach', () => {
  it('stands in the town the round is played in', async () => {
    const descriptor = (OBJECTIVE.kind as { descriptor: string }).descriptor;
    const keeper = await waitFor(
      () => [...bot.entities.values()].find(
        (e) => e.kind === 'npc' && e.descriptor === descriptor,
      ),
      'the keeper to be spawned by the area script',
    );
    expect(keeper.kind).toBe('npc');
  });

  it('wears the EXACT descriptor the objective names', () => {
    // ⚠ The engine matches a kill with `npcsKilled.has(descriptor)` — an exact
    // string, not a substring and not an id. This assertion is the one that
    // would have failed before D-593, and it is the one a reworded line of
    // prose in either file will fail again.
    const descriptor = (OBJECTIVE.kind as { descriptor: string }).descriptor;
    const wearing = [...bot.entities.values()].filter((e) => e.descriptor === descriptor);
    expect(wearing).toHaveLength(1);
  });

  it('can be killed, and that finishes the round', async () => {
    const descriptor = (OBJECTIVE.kind as { descriptor: string }).descriptor;
    const keeper = [...bot.entities.values()].find((e) => e.descriptor === descriptor)!;
    await waitFor(() => (bot.roundState?.phase === 'running' ? true : undefined),
      'the round to start');

    // ⚠ ARMED, and that is not a convenience. The keeper has 40 hit points
    // now (D-619) and this bot was fighting BARE-HANDED -- measured off this
    // very fixture: 27 swings for 13 damage, about half a point a swing. An
    // antagonist dealt `silence-the-keeper` is carrying the kit its calling
    // granted (D-547), so a fixture that punches him is not a harder version
    // of the real thing, it is a different thing, and tuning the objective
    // against it would tune it against nobody.
    const sword = await store.grantItem(characterId, 'arming-sword', 1);
    bot.send({ t: 'equip', itemId: sword.id });
    await waitFor(
      () => (bot.inventory.some((i) => i.templateId === 'arming-sword' && i.equipped)
        ? true
        : undefined),
      'the sword to be in hand',
    );

    // ⚠ `move_to`, not a greedy step. The first cut walked whichever axis was
    // furthest and stopped dead at (25, 22): the square's statue stands at
    // (25, 21), directly between the tavern door and everybody crossing the
    // square, so the straight line in is blocked. The server owns routes
    // (D-567) and this is the message a real player's click sends — a test
    // that reimplements pathfinding is testing its own pathfinding.
    bot.send({ t: 'move_to', x: keeper.x, y: keeper.y });
    for (let i = 0; i < 900; i++) {
      if (bot.roundsEnded.length > 0) break;
      const me = bot.entities.get(bot.you!);
      if (me && Math.hypot(keeper.x - me.x, keeper.y - me.y) <= 1.2) {
        bot.send({ t: 'move_stop' });
        // He is defenceless by design (D-526) — what makes this objective hard
        // is being SEEN doing it, not the fight.
        bot.send({ t: 'attack', targetEntityId: keeper.id });
      }
      await sleep(TICK * 8);
    }
    const ended = await waitFor(() => bot.roundsEnded[0], 'the round to end');
    // ⚠ The OUTCOME, not the objective's name. `round_ended` carries prose for
    // the player; what has to be true is that the engine judged the objective
    // complete — which is exactly what `npcsKilled.has(descriptor)` decides.
    expect(ended.outcome).toBe('objective_complete');
    expect(ended.winner).toBe('antagonist');
  }, 60_000);
});
