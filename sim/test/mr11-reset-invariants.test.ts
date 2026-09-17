import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ScenarioSchema } from '@rc/shared';
import { loadContent } from '@rc/server/content';
import { GameServer } from '@rc/server/net/gateway';
import { MemoryStore } from '@rc/server/store/memory';
import { BotClient } from '../src/botClient';

/**
 * What a round reset must leave behind: nothing.
 *
 * ⚠ The reset has been repaired four times, once per thing somebody noticed
 * while playing — the dead stayed dead (D-607), the living stood where they
 * stopped (D-608), corpses littered the floor replaying their deaths (D-618).
 * Each was found by eye, and each was a missing line rather than a broken
 * system. This asserts the whole floor at once so the fifth one fails here
 * instead of in front of the stakeholder.
 *
 * ⚠ It reads the WORLD, not the wire. A client is told what it can see; the
 * question here is what still exists, which is a different and stricter one —
 * a corpse in an area nobody is standing in is exactly the kind that survived.
 */

const contentDir = fileURLToPath(new URL('../../content', import.meta.url));
const TICK = 5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const HOME = ScenarioSchema.parse(
  JSON.parse(readFileSync(`${contentDir}/scenarios/ashfold.json`, 'utf8')),
).opensIn;

const SURVIVE = {
  id: 'reset-survive',
  name: 'Outlast them',
  brief: 'Be standing when the day ends.',
  kind: { type: 'survive' as const },
  minCast: 1,
  maxCast: null,
  status: 'live' as const,
};

let store: MemoryStore;
let server: GameServer;
let stockedBefore = 0;
const cast: BotClient[] = [];

/** Every entity in the world, across every area — not merely the visible ones. */
function allEntities() {
  return server.world.areaIds().flatMap((id) => server.world.entitiesIn(id));
}

function countStocked(): number {
  return allEntities().filter(
    (e) => e.objectKind === 'node' || e.objectKind === 'station',
  ).length;
}

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

beforeAll(async () => {
  store = new MemoryStore();
  server = new GameServer({
    store,
    content: loadContent(contentDir),
    port: 0,
    tickIntervalMs: TICK,
    rngSeed: 77,
    defaultAreaId: HOME,
    attackCooldownTicks: 2,
    ghostMinTicks: 50,
    round: {
      enabled: true,
      lengthTicks: 200_000,
      minCast: 2,
      graceTicks: 0,
      seed: 'reset-test',
      objectives: [SURVIVE],
      resolutionTicks: 10,
    },
  });
  await server.start();
  const a = await join('reset_a', 'Mara Fenn', 501);
  const b = await join('reset_b', 'Oswin Clay', 502);
  for (let i = 0; i < 300 && a.roundState?.phase !== 'running'; i++) await sleep(TICK * 4);
  expect(a.roundState?.phase).toBe('running');

  // Make a mess: kill one of them, so there is a body, a ghost and a grudge.
  const victim = b.you!;
  for (let i = 0; i < 400 && b.status?.ghost !== true; i++) {
    a.send({ t: 'attack', targetEntityId: victim });
    await sleep(TICK * 6);
  }
  expect(b.status?.ghost, 'the fixture needs a death to clean up after').toBe(true);

  stockedBefore = countStocked();
  expect(stockedBefore, 'the round stocked something to compare against').toBeGreaterThan(0);
  await server.adminRestartRound();
  await sleep(TICK * 40);
});

afterAll(async () => {
  for (const b of cast) b.close();
  await server?.stop();
});

describe('⚠ a reset leaves the world empty of the last round', () => {
  it('sweeps every corpse and dropped heap', () => {
    // D-618's fix, asserted against the WORLD rather than a client's mirror.
    const litter = allEntities().filter(
      (e) => e.objectKind === 'corpse' || e.objectKind === 'pile' || e.objectKind === 'zombie',
    );
    expect(litter.map((e) => `${e.objectKind} ${e.npcDescriptor ?? e.name}`)).toEqual([]);
  });

  it('stands everyone back up, whole, where the round opens', () => {
    for (const bot of cast) {
      expect(bot.status?.ghost, 'still a ghost after the reset').toBe(false);
      expect(bot.status!.hp).toBe(bot.status!.maxHp);
      expect(bot.status!.hunger).toBe('sated');
      expect(bot.status!.thirst).toBe('sated');
      expect(bot.area?.id).toBe(HOME);
    }
  });

  it('⚠ leaves nobody with their weapon still up', () => {
    // A live `combat` flag survives as a drawn weapon, a running stance and —
    // since D-619 — a character who moves at fighting speed for no reason.
    const fighting = allEntities().filter((e) => e.combat);
    expect(fighting.map((e) => e.name)).toEqual([]);
  });

  it('⚠ re-stocks the world rather than stocking it TWICE', () => {
    // ⚠ Not "zero". With a full cast present the lobby starts the next round
    // immediately, so by the time anybody can look the world is stocked again
    // — the first cut of this asserted an empty world and was measuring the
    // new round's nodes. What must hold is that the count did not GROW: nodes
    // and stations exist only while a round runs, and a reset that despawned
    // nothing would leave two of everything, which is exactly the shape of the
    // guard bug D-618 records.
    expect(countStocked()).toBe(stockedBefore);
  });
});
