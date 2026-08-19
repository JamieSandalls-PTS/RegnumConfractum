import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectiveSchema, type ObjectiveDef } from '@rc/shared';
import { loadContent } from '@rc/server/content';
import { GameServer } from '@rc/server/net/gateway';
import { MemoryStore } from '@rc/server/store/memory';
import { BotClient } from '../src/botClient';

/**
 * Hunger and thirst (D-526), played by bots.
 *
 * The assertions are about SHAPE, because the numbers are unratified:
 *
 *   - they step coarsely on the round clock, not continuously
 *   - they PLATEAU. Nothing here may kill: a round decided by an unattended
 *     need instead of by a person is a failed round
 *   - they fail DIFFERENTLY — hunger slows work, thirst makes you frail —
 *     or one of them is decoration
 *   - water is not carried, so thirst is a leash back to the well
 *   - needs are round-scoped, like everything else the round holds
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
  id: 'test-survive',
  name: 'Endure',
  brief: 'Live.',
  kind: { type: 'survive' },
  minCast: 2,
});

let store: MemoryStore;
let server: GameServer;
let townie: BotClient; // stands by the well
let other: BotClient;
let townieChar: string;

async function join(bot: BotClient, username: string, charName: string, seed: number, area: string, x = 50, y = 53) {
  bot.send({ t: 'register', username, password: 'password-word' });
  await bot.expect('auth_ok');
  bot.send({ t: 'create_character', name: charName, appearanceSeed: seed });
  const characterId = (await bot.expect('character_created')).character.id;
  await store.saveCharacterPosition(characterId, area, x, y);
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
    bleedIntervalTicks: 100_000,
    round: {
      enabled: true,
      lengthTicks: 200_000,
      minCast: 2,
      seed: 'needs-test',
      // A game hour every 10 ticks, so the needs clock is reachable. The
      // rules are hour-based, so only the pacing moves (D-114).
      dayTicks: 240,
      objectives: [SURVIVE],
      resolutionTicks: 10,
    },
  });
  await server.start();
  const url = `ws://127.0.0.1:${server.port}`;
  townie = await BotClient.connect(url);
  other = await BotClient.connect(url);
  // Right beside the well at the town's centre (100x100 → centre 50,50).
  townieChar = await join(townie, 'needs_one', 'Bram Ottel', 921, 'round-town', 50, 52);
  // BOTH in town, deliberately. The first version left this one alone in the
  // mine, where the roamers found and killed it at dusk — which ended the
  // round, reset every need, and made the plateau assertion fail for a reason
  // that had nothing to do with needs. The thirst leash is about standing AT
  // THE WELL, not about being outside the town, so a far corner tests it just
  // as well and nothing else can decide the round.
  await join(other, 'needs_two', 'Kesia Ward', 922, 'round-town', 12, 12);
  await waitUntil(() => townie.roundState?.phase === 'running', 'the round begins');
});

afterAll(async () => {
  townie?.close();
  other?.close();
  await server.stop();
});

describe('needs arrive on the round clock (D-526)', () => {
  it('starts everyone sated', () => {
    expect(townie.status?.hunger).toBe('sated');
    expect(townie.status?.thirst).toBe('sated');
  });

  it('bites, and bites thirst first — thirst is the shorter leash', async () => {
    await waitUntil(() => townie.status?.thirst !== 'sated', 'thirst arrives');
    expect(townie.status!.thirst).toBe('gnawing');
  });

  it('thirst makes you FRAIL rather than hurting you (a different failure)', async () => {
    await waitUntil(() => (townie.status?.maxHp ?? 20) < 20, 'the frame thins');
    // Maximum health drops, so fights go worse — but current health is never
    // driven to nothing by the need itself.
    expect(townie.status!.maxHp).toBeLessThan(20);
    expect(townie.status!.hp).toBeGreaterThan(0);
  });

  it('PLATEAUS instead of spiralling, and never kills', async () => {
    // This is the assertion that matters most. A need that keeps deepening
    // eventually decides rounds on its own, and a round decided by a bar
    // rather than by a person is a failed round.
    await waitUntil(() => townie.status?.thirst === 'severe', 'thirst bottoms out');
    const floorHp = townie.status!.maxHp;
    await sleep(3000); // several more need steps at this pacing
    expect(townie.status!.thirst).toBe('severe'); // no fourth stage
    expect(townie.status!.maxHp).toBe(floorHp); // no further erosion
    expect(townie.status!.ghost).toBe(false); // and nobody starved to death
    expect(townie.status!.hp).toBeGreaterThan(0);
  });
});

describe('relief', () => {
  it('is refused away from the well — thirst is a leash to one spot', async () => {
    // Being in the town is not enough: you have to be AT the well. That is
    // what pulls people to a known place at a known time, and what makes the
    // well worth poisoning (D-529).
    other.send({ t: 'drink' });
    const err = await other.expectError('no_water_here');
    expect(err.message).toBeTruthy();
  });

  it('the well clears thirst for someone standing at it', async () => {
    expect(townie.status!.thirst).not.toBe('sated');
    townie.send({ t: 'drink' });
    await waitUntil(() => townie.status?.thirst === 'sated', 'the thirst is quenched');
    // And the frame fills back out.
    expect(townie.status!.maxHp).toBe(20);
  });

  it('refuses food that is not food, and food nobody wants', async () => {
    await store.grantItem(townieChar, 'iron-ore', 1);
    townie.send({ t: 'eat', templateId: 'iron-ore' });
    expect((await townie.expectError('not_food')).message).toBeTruthy();
    // Bread while already sated: no appetite, and the loaf is not spent.
    await store.grantItem(townieChar, 'coarse-bread', 1);
    if (townie.status!.hunger === 'sated') {
      townie.send({ t: 'eat', templateId: 'coarse-bread' });
      expect((await townie.expectError('not_hungry')).message).toBeTruthy();
      const held = await store.getItemsByCharacter(townieChar);
      expect(held.filter((i) => i.templateId === 'coarse-bread').length).toBeGreaterThan(0);
    }
  });

  it('eating clears hunger and spends exactly one loaf', async () => {
    await waitUntil(() => townie.status?.hunger !== 'sated', 'hunger arrives', 30_000);
    const before = (await store.getItemsByCharacter(townieChar))
      .filter((i) => i.templateId === 'coarse-bread')
      .reduce((n, i) => n + i.qty, 0);
    townie.send({ t: 'eat', templateId: 'coarse-bread' });
    await waitUntil(() => townie.status?.hunger === 'sated', 'the hunger passes');
    const after = (await store.getItemsByCharacter(townieChar))
      .filter((i) => i.templateId === 'coarse-bread')
      .reduce((n, i) => n + i.qty, 0);
    expect(after).toBe(before - 1);
  });
});
