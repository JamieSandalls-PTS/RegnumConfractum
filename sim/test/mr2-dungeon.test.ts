import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectiveSchema, type ObjectiveDef } from '@rc/shared';
import { loadContent } from '@rc/server/content';
import { GameServer } from '@rc/server/net/gateway';
import { MemoryStore } from '@rc/server/store/memory';
import { BotClient } from '../src/botClient';

/**
 * The dungeon's contents (D-537).
 *
 * D-523 calls the dungeon the round's separation engine — the thing that
 * pulls the cast apart voluntarily so the antagonist can act. An empty
 * dungeon separates nobody, so what these assertions protect is that there
 * is a REASON to go down, and that the reason gets better the deeper you go.
 */

const contentDir = fileURLToPath(new URL('../../content', import.meta.url));
const TICK = 5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(pred: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(15);
  }
  throw new Error(`timed out waiting until ${what}`);
}

const SURVIVE: ObjectiveDef = ObjectiveSchema.parse({
  id: 'test-survive', name: 'Endure', brief: 'Live.',
  kind: { type: 'survive' }, minCast: 2,
});

let store: MemoryStore;
let server: GameServer;
let diver: BotClient;
let mate: BotClient;
let diverChar: string;

const content = loadContent(contentDir);

beforeAll(async () => {
  store = new MemoryStore();
  server = new GameServer({
    store,
    content,
    port: 0,
    tickIntervalMs: TICK,
    rngSeed: 41,
    defaultAreaId: 'round-dungeon-1',
    attackCooldownTicks: 2,
    bleedIntervalTicks: 100_000,
    round: {
      enabled: true,
      lengthTicks: 200_000,
      minCast: 2,
      graceTicks: 0,
      seed: 'dungeon-test',
      dayTicks: 100_000, // stay in day one: the stairs are not the subject here
      objectives: [SURVIVE],
      resolutionTicks: 10,
    },
  });
  await server.start();
  const url = `ws://127.0.0.1:${server.port}`;
  const join = async (bot: BotClient, user: string, name: string, seed: number, area: string) => {
    bot.send({ t: 'register', username: user, password: 'password-word' });
    await bot.expect('auth_ok');
    bot.send({ t: 'create_character', name, appearanceSeed: seed });
    const id = (await bot.expect('character_created')).character.id;
    await store.saveCharacterPosition(id, area, 50, 14);
    bot.send({ t: 'enter_world', characterId: id });
    await bot.expect('snapshot');
    return id;
  };
  diver = await BotClient.connect(url);
  mate = await BotClient.connect(url);
  diverChar = await join(diver, 'dung_one', 'Rensa Coyle', 951, 'round-dungeon-1');
  await join(mate, 'dung_two', 'Halvard Ossen', 952, 'round-town');
  await waitUntil(() => diver.roundState?.phase === 'running', 'the round begins');
});

afterAll(async () => {
  diver?.close();
  mate?.close();
  await server.stop();
});

const dwellersNear = (bot: BotClient): number =>
  [...bot.entities.values()].filter(
    (e) => e.kind === 'npc' && /many-legged|underwater|patient/.test(e.descriptor ?? ''),
  ).length;

describe('the dungeon is stocked when the round opens', () => {
  it('puts things on the floor the player is standing on', async () => {
    await waitUntil(() => dwellersNear(diver) > 0, 'something is down here');
    expect(dwellersNear(diver)).toBeGreaterThan(1);
  });

  it('stocks EVERY floor at once, including ones not yet open', () => {
    // The gate is on the stair (D-535), not on the inhabitants: a floor must
    // be fully alive the moment its stair gives way, rather than filling up
    // while somebody stands watching it.
    for (const floor of [1, 2, 3]) {
      const area = `round-dungeon-${floor}`;
      const here = server.world
        .entitiesIn(area)
        .filter((e) => e.characterId === null && e.objectKind !== 'node');
      expect(here.length, `floor ${floor} is populated`).toBeGreaterThan(0);
    }
  });

  it('leaves the town alone — the dungeon is not the surface', () => {
    expect(dwellersNear(mate)).toBe(0);
  });
});

describe('the reward gets better the deeper you go', () => {
  it('pays more xp per floor, or the schedule is decoration', () => {
    const xpFor = (floor: number) =>
      content.roamers.filter((r) => r.habitat === 'dungeon' && r.floor === floor)
        .reduce((best, r) => Math.max(best, r.xp), 0);
    expect(xpFor(2)).toBeGreaterThan(xpFor(1));
    expect(xpFor(3)).toBeGreaterThan(xpFor(2));
  });

  it('keeps its own material to the deep floors', () => {
    // Descending must not be merely faster mining. Gravebright is the reason
    // floor two is worth the second day, and nothing above it carries any.
    const dropsFrom = (floor: number) =>
      content.roamers
        .filter((r) => r.habitat === 'dungeon' && r.floor === floor)
        .flatMap((r) => r.loot.map((l) => l.item));
    expect(dropsFrom(1)).not.toContain('gravebright');
    expect(dropsFrom(2)).toContain('gravebright');
    expect(dropsFrom(3)).toContain('gravebright');
  });

  it('hits harder as it goes down', () => {
    const worst = (floor: number) =>
      content.roamers.filter((r) => r.habitat === 'dungeon' && r.floor === floor)
        .reduce((best, r) => Math.max(best, r.damageMax), 0);
    expect(worst(2)).toBeGreaterThan(worst(1));
    expect(worst(3)).toBeGreaterThan(worst(2));
  });
});

/** Closes on the nearest crawler and kills it. Returns false if none is left. */
async function killNearestCrawler(bot: BotClient): Promise<boolean> {
  const me = bot.entities.get(bot.you!)!;
  const target = [...bot.entities.values()]
    .filter((e) => e.kind === 'npc' && /many-legged/.test(e.descriptor ?? ''))
    .map((e) => ({ e, d: Math.max(Math.abs(e.x - me.x), Math.abs(e.y - me.y)) }))
    .sort((a, b) => a.d - b.d)[0]?.e;
  if (!target) return false;
  // CLOSE ON IT rather than waiting for it to arrive: a test that depends on
  // how fast the machine runs the hunt is measuring the machine, and the
  // first version passed alone and timed out under full-suite load.
  for (let i = 0; i < 220 && bot.entities.has(target.id); i++) {
    const now = bot.entities.get(target.id)!;
    const self = bot.entities.get(bot.you!)!;
    const dx = now.x - self.x;
    const dy = now.y - self.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) <= 1) {
      bot.send({ t: 'attack', targetEntityId: target.id });
    } else {
      const dir = dy < 0 ? (dx > 0 ? 'ne' : dx < 0 ? 'nw' : 'n')
        : dy > 0 ? (dx > 0 ? 'se' : dx < 0 ? 'sw' : 's')
        : dx > 0 ? 'e' : 'w';
      bot.send({ t: 'move', dir });
    }
    await sleep(TICK * 6);
  }
  return !bot.entities.has(target.id);
}

describe('killing them pays', () => {
  it('can be put down, and hands over what they carried', async () => {
    await waitUntil(() => dwellersNear(diver) > 0, 'a target presents itself');

    // Several kills, because loot is a CHANCE (half, for a crawler) and one
    // kill proving nothing dropped would prove nothing at all.
    let killed = 0;
    for (let i = 0; i < 5; i++) {
      if (diver.status?.ghost) break;
      if (await killNearestCrawler(diver)) killed++;
      if (diver.inventory.some((it) => it.templateId === 'iron-ore')) break;
      await sleep(200);
    }
    expect(killed, 'the diver put at least one down').toBeGreaterThan(0);

    // NOTE: `status.xp` deliberately does NOT move here. Round earnings go to
    // a pot banked only if you live to the end (D-524), so a mid-round kill
    // shows up in the pack and in the log, never on the character. Asserting
    // against status.xp would be asserting the wrong invariant.
    expect(diver.inventory.some((it) => it.templateId === 'iron-ore')).toBe(true);
  }, 60_000);
});
