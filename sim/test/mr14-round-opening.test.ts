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
 * How a round OPENS (D-636): everyone in the tavern, on their feet, whole,
 * and not standing inside one another — and no body from before the round
 * lying in the room.
 *
 * ⚠ The first round after a boot never went through a reset, which is where
 * all of that used to be guaranteed. A corpse restored from the store, and a
 * character stored dead, both opened the round on the floor.
 */

const contentDir = fileURLToPath(new URL('../../content', import.meta.url));
const TICK = SIM_TICK; // see sim/src/testTick.ts (D-633)
const scenario = ScenarioSchema.parse(
  JSON.parse(readFileSync(`${contentDir}/scenarios/ashfold.json`, 'utf8')),
);
const HOME = scenario.opensIn!;
const tavern = loadContent(contentDir).areas.get(HOME)!;

let store: MemoryStore;
let server: GameServer;
const cast: BotClient[] = [];

async function join(name: string, who: string, seed: number): Promise<BotClient> {
  const bot = await BotClient.connect(`ws://127.0.0.1:${server.port}`);
  cast.push(bot);
  bot.send({ t: 'register', username: name, password: 'password-word' });
  await bot.expect('auth_ok');
  bot.send({ t: 'create_character', name: who, appearanceSeed: seed });
  const id = (await bot.expect('character_created')).character.id;
  bot.send({ t: 'enter_world', characterId: id });
  await bot.expect('snapshot');
  return bot;
}

function allEntities() {
  return server.world.areaIds().flatMap((id) => server.world.entitiesIn(id));
}

beforeAll(async () => {
  store = new MemoryStore();
  // A body from a round that ended with the last process.
  await store.createCorpse({
    characterId: null, areaId: HOME, x: tavern.spawn.x + 1, y: tavern.spawn.y,
    state: 'corpse', ticksLeft: 1_000_000,
  });
  server = new GameServer({
    store,
    content: loadContent(contentDir),
    port: 0,
    tickIntervalMs: TICK,
    rngSeed: 5,
    defaultAreaId: 'round-town',
    watch: false,
    round: {
      enabled: true,
      lengthTicks: 200_000,
      minCast: 3,
      graceTicks: 0,
      seed: 'opening',
      resolutionTicks: 10,
      objectives: [{
        id: 'opening-survive', name: 'Outlast them', brief: 'Be standing when the day ends.',
        kind: { type: 'survive' as const }, minCast: 1, maxCast: null, status: 'live' as const,
      }],
    },
  });
  await server.start();
  const a = await join('open_a', 'Idony Marsh', 701);
  await join('open_b', 'Piers Hollow', 702);
  await join('open_c', 'Gudrun Vane', 703);
  for (let i = 0; i < 300 && a.roundState?.phase !== 'running'; i++) await sleep(TICK * 4);
  expect(a.roundState?.phase).toBe('running');
});

afterAll(async () => {
  for (const b of cast) b.close();
  await server?.stop();
});

describe('⚠ the round opens in the tavern, with everyone whole and apart', () => {
  it('names the taproom as where the round opens', () => {
    expect(HOME).toBe('hanged-ferryman');
  });

  it('put every arrival in the taproom, alive, at full health', () => {
    for (const bot of cast) {
      expect(bot.area?.id).toBe(HOME);
      expect(bot.status?.ghost).toBe(false);
      expect(bot.status!.hp).toBe(bot.status!.maxHp);
    }
  });

  it('⚠ stands nobody on top of anybody, and nobody on the door', () => {
    const doors = new Set(tavern.transitions.map((t) => `${t.x},${t.y}`));
    const seen = new Set<string>();
    for (const bot of cast) {
      const me = bot.entities.get(bot.you!)!;
      const tile = `${Math.round(me.x)},${Math.round(me.y)}`;
      expect(seen.has(tile), `two people on ${tile}`).toBe(false);
      seen.add(tile);
      expect(doors.has(tile), `${tile} is a door`).toBe(false);
      // Near the spawn, not scattered across the room.
      expect(Math.hypot(me.x - tavern.spawn.x, me.y - tavern.spawn.y)).toBeLessThanOrEqual(2);
    }
  });

  it('⚠ swept the body the store restored, and closed its record', async () => {
    expect(allEntities().filter((e) => e.objectKind === 'corpse' || e.objectKind === 'pile')).toEqual([]);
    expect(await store.listActiveCorpses()).toEqual([]);
    for (const bot of cast) expect(bot.violations).toEqual([]);
  });
});
