import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadContent } from '@rc/server/content';
import { GameServer, corpseBurden } from '@rc/server/net/gateway';
import { MemoryStore } from '@rc/server/store/memory';
import { ATTACK_VARIANTS, CARRY_BASE_CAPACITY, generateAppearance } from '@rc/shared';
import { BotClient } from '../src/botClient';

/**
 * Combat state, attack variants, and carrying the dead (stakeholder,
 * 2026-08-18).
 *
 * Combat state is what drives every weapon animation — drawn or sheathed,
 * ready stance or true idle — so it has to be SERVER-owned and identical
 * for every observer. These tests pin the entry and exit rules, because
 * "my weapon is out and yours isn't" is the kind of disagreement players
 * notice immediately.
 */

const contentDir = fileURLToPath(new URL('../../content', import.meta.url));
const TICK = 5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let store: MemoryStore;
let server: GameServer;

/** Short windows so the exit rule is testable in real time. */
const COMBAT_LEAVE_TEST_TICKS = 6;

beforeAll(async () => {
  store = new MemoryStore();
  server = new GameServer({
    store,
    content: loadContent(contentDir),
    port: 0,
    tickIntervalMs: TICK,
    rngSeed: 77,
    defaultAreaId: 'broken-yard', // wilderness: no declaration needed to swing
    hostilityWindowTicks: 1,
    attackCooldownTicks: 1,
  });
  await server.start();
});

afterAll(async () => {
  await server.stop();
});

async function join(username: string, charName: string, seed: number) {
  const bot = await BotClient.connect(`ws://127.0.0.1:${server.port}`);
  bot.send({ t: 'register', username, password: 'password-word' });
  await bot.expect('auth_ok');
  bot.send({ t: 'create_character', name: charName, appearanceSeed: seed });
  const characterId = (await bot.expect('character_created')).character.id;
  bot.send({ t: 'enter_world', characterId });
  const snap = await bot.expect('snapshot');
  return { bot, characterId, entityId: snap.you };
}

/** Latest combat flag this bot believes about an entity. */
function combatOf(bot: BotClient, entityId: number): boolean {
  return bot.entities.get(entityId)?.combat ?? false;
}

describe('combat state (D-206 groundwork for weapon stance)', () => {
  it('an attack puts BOTH parties in combat, for every observer', async () => {
    const a = await join('cs_attacker', 'Hewer Stane', 101);
    const b = await join('cs_target', 'Wilby Fen', 202);
    // Snapshots start everyone at peace with weapons stowed.
    expect(combatOf(a.bot, a.entityId)).toBe(false);
    expect(combatOf(a.bot, b.entityId)).toBe(false);

    a.bot.send({ t: 'attack', targetEntityId: b.entityId });
    await a.bot.expect('delta');
    await sleep(TICK * 6);

    // Both clients agree about both bodies — the stance is not local.
    for (const observer of [a.bot, b.bot]) {
      expect(combatOf(observer, a.entityId), 'attacker in combat').toBe(true);
      expect(combatOf(observer, b.entityId), 'target in combat').toBe(true);
    }
    await a.bot.close();
    await b.bot.close();
  });

  it('an attack carries a variant inside the animation range', async () => {
    const a = await join('cs_var_a', 'Swinger Ord', 303);
    const b = await join('cs_var_b', 'Standing Post', 404);
    for (let i = 0; i < 6; i++) {
      a.bot.send({ t: 'attack', targetEntityId: b.entityId });
      await sleep(TICK * 4);
    }
    expect(a.bot.attacks.length).toBeGreaterThan(0);
    for (const blow of a.bot.attacks) {
      expect(blow.variant).toBeGreaterThanOrEqual(0);
      expect(blow.variant).toBeLessThan(ATTACK_VARIANTS);
    }
    // Both witnesses saw the SAME swings — the variant is not rolled locally.
    expect(b.bot.attacks.map((x) => x.variant)).toEqual(a.bot.attacks.map((x) => x.variant));
    await a.bot.close();
    await b.bot.close();
  });

  it('declaring hostility draws both blades without a blow landing', async () => {
    const a = await join('cs_decl_a', 'Loud Threat', 505);
    const b = await join('cs_decl_b', 'Quiet Mark', 606);
    a.bot.send({ t: 'hostile', targetEntityId: b.entityId, text: 'Draw, or die standing.' });
    await sleep(TICK * 6);
    expect(combatOf(b.bot, a.entityId)).toBe(true);
    expect(combatOf(b.bot, b.entityId)).toBe(true);
    await a.bot.close();
    await b.bot.close();
  });
});

describe('leaving combat', () => {
  /**
   * The exit rule has two clauses and BOTH must hold: quiet for long
   * enough, and nobody hostile nearby. A test that only checked the timer
   * would pass while players sheathed mid-standoff.
   */
  it('stays in combat while a declared enemy is still close', async () => {
    const server2 = new GameServer({
      store: new MemoryStore(),
      content: loadContent(contentDir),
      port: 0,
      tickIntervalMs: TICK,
      rngSeed: 5,
      defaultAreaId: 'broken-yard',
      hostilityWindowTicks: 1,
      attackCooldownTicks: 1,
      combatLeaveTicks: COMBAT_LEAVE_TEST_TICKS,
    });
    await server2.start();
    const mk = async (u: string, n: string, seed: number) => {
      const bot = await BotClient.connect(`ws://127.0.0.1:${server2.port}`);
      bot.send({ t: 'register', username: u, password: 'password-word' });
      await bot.expect('auth_ok');
      bot.send({ t: 'create_character', name: n, appearanceSeed: seed });
      const id = (await bot.expect('character_created')).character.id;
      bot.send({ t: 'enter_world', characterId: id });
      return { bot, entityId: (await bot.expect('snapshot')).you };
    };
    const a = await mk('cs_near_a', 'Stubborn Foe', 707);
    const b = await mk('cs_near_b', 'Wary Sort', 808);
    a.bot.send({ t: 'hostile', targetEntityId: b.entityId, text: 'I have not finished.' });
    await sleep(TICK * 4);
    expect(combatOf(a.bot, a.entityId)).toBe(true);
    // Well past the cooldown, but they are still standing next to each other.
    await sleep(TICK * (COMBAT_LEAVE_TEST_TICKS + 10));
    expect(combatOf(a.bot, a.entityId), 'blades stay out in a standoff').toBe(true);
    expect(combatOf(a.bot, b.entityId)).toBe(true);
    await a.bot.close();
    await b.bot.close();
    await server2.stop();
  });

  it('sheathes once the quiet has lasted and nobody hostile is in reach', async () => {
    const store3 = new MemoryStore();
    const server3 = new GameServer({
      store: store3,
      content: loadContent(contentDir),
      port: 0,
      tickIntervalMs: TICK,
      rngSeed: 6,
      defaultAreaId: 'broken-yard',
      attackCooldownTicks: 1,
      combatLeaveTicks: COMBAT_LEAVE_TEST_TICKS,
      // A single tile of "proximity" so simply not being adjacent counts as
      // being away — the real 20 tiles is untestable in a small yard.
      combatProximityTiles: 1,
    });
    await server3.start();
    const bot = await BotClient.connect(`ws://127.0.0.1:${server3.port}`);
    bot.send({ t: 'register', username: 'cs_alone', password: 'password-word' });
    await bot.expect('auth_ok');
    bot.send({ t: 'create_character', name: 'Lonely Blade', appearanceSeed: 909 });
    const id = (await bot.expect('character_created')).character.id;
    bot.send({ t: 'enter_world', characterId: id });
    const me = (await bot.expect('snapshot')).you;

    // An NPC gives us something legal to swing at in an empty yard.
    const me2 = bot.entities.get(me)!;
    const npc = server3.spawnNpc('broken-yard', {
      x: me2.x + 1, y: me2.y, descriptor: 'a straw dummy',
    });
    await sleep(TICK * 3);
    bot.send({ t: 'attack', targetEntityId: npc });
    await sleep(TICK * 4);
    expect(combatOf(bot, me), 'a swing starts the fight').toBe(true);

    // Walk away and wait out the cooldown.
    for (let i = 0; i < 6; i++) {
      bot.send({ t: 'move', dir: 's' });
      await sleep(TICK * 4);
    }
    await sleep(TICK * (COMBAT_LEAVE_TEST_TICKS + 12));
    expect(combatOf(bot, me), 'the weapon goes away once it is quiet').toBe(false);
    await bot.close();
    await server3.stop();
  });
});

describe('carrying the dead', () => {
  it('a body weighs what its build says it weighs', () => {
    // The burden is a pure function of the corpse's own generated build, so
    // two clients (and the server) always agree about what can be lifted.
    const slight = corpseBurden(1);
    const same = corpseBurden(1);
    expect(slight).toBe(same);
    // Across many seeds the range must straddle the default capacity, or
    // the mechanic is either trivial or impossible.
    const burdens = Array.from({ length: 200 }, (_, i) => corpseBurden(i + 1));
    expect(Math.min(...burdens)).toBeLessThan(CARRY_BASE_CAPACITY);
    expect(Math.max(...burdens)).toBeGreaterThan(CARRY_BASE_CAPACITY);
  });

  it('lifts a light body, refuses a heavy one, and carries it along', async () => {
    // Pick seeds either side of what an untrained back can manage.
    let light = 1;
    let heavy = 1;
    for (let seed = 1; seed < 400; seed++) {
      if (corpseBurden(seed) < corpseBurden(light)) light = seed;
      if (corpseBurden(seed) > corpseBurden(heavy)) heavy = seed;
    }
    expect(corpseBurden(light)).toBeLessThanOrEqual(CARRY_BASE_CAPACITY);
    expect(corpseBurden(heavy)).toBeGreaterThan(CARRY_BASE_CAPACITY);

    const carrier = await join('carry_bearer', 'Strong Arms', 4242);
    // Two victims die where the bearer stands; their bodies stay behind.
    const victims: number[] = [];
    // Character names are letters only (D-201's naming rules), so index
    // these by word rather than by number.
    for (const [i, seed] of [light, heavy].entries()) {
      const v = await join(`carry_victim_${i}`, `Doomed Soul the ${i === 0 ? 'Slight' : 'Heavy'}`, seed);
      const me = v.bot.entities.get(v.entityId)!;
      // Walk the victim next to the bearer so the corpse lands in reach.
      const bearer = carrier.bot.entities.get(carrier.entityId)!;
      for (let step = 0; step < 40 && (me.x !== bearer.x || me.y !== bearer.y); step++) {
        const dx = Math.sign(bearer.x - me.x);
        const dy = Math.sign(bearer.y - me.y);
        const dir = dy < 0 ? (dx > 0 ? 'ne' : dx < 0 ? 'nw' : 'n')
          : dy > 0 ? (dx > 0 ? 'se' : dx < 0 ? 'sw' : 's')
            : dx > 0 ? 'e' : 'w';
        v.bot.send({ t: 'move', dir });
        await sleep(TICK * 5);
        Object.assign(me, v.bot.entities.get(v.entityId)!);
      }
      // The yard is wilderness (D-206), so the bearer may simply cut them
      // down — no declaration needed, and it exercises the real death path.
      for (let blow = 0; blow < 14; blow++) {
        carrier.bot.send({ t: 'attack', targetEntityId: v.entityId });
        await sleep(TICK * 4);
        if (!carrier.bot.entities.has(v.entityId)) break;
      }
      await sleep(TICK * 6);
      victims.push(v.entityId);
      await v.bot.close();
    }
    await sleep(TICK * 8);

    // Find the corpses the bearer can see.
    const corpses = [...carrier.bot.entities.values()].filter((e) => e.kind === 'corpse');
    expect(corpses.length, 'both bodies are on the ground').toBeGreaterThanOrEqual(2);
    const lightCorpse = corpses.find((c) => corpseBurden(c.appearanceSeed) <= CARRY_BASE_CAPACITY);
    const heavyCorpse = corpses.find((c) => corpseBurden(c.appearanceSeed) > CARRY_BASE_CAPACITY);
    expect(lightCorpse, 'a liftable body').toBeDefined();
    expect(heavyCorpse, 'an unliftable body').toBeDefined();

    // The heavy one refuses.
    carrier.bot.send({ t: 'carry_body', targetEntityId: heavyCorpse!.id });
    const refusal = await carrier.bot.expect('error');
    expect(refusal.message).toMatch(/too heavy/i);

    // The light one comes up, and then travels with its bearer.
    carrier.bot.send({ t: 'carry_body', targetEntityId: lightCorpse!.id });
    await sleep(TICK * 6);
    expect(carrier.bot.entities.get(lightCorpse!.id)?.carriedBy).toBe(carrier.entityId);
    const before = { ...carrier.bot.entities.get(lightCorpse!.id)! };
    carrier.bot.send({ t: 'move', dir: 'n' });
    await sleep(TICK * 8);
    const after = carrier.bot.entities.get(lightCorpse!.id)!;
    const bearerNow = carrier.bot.entities.get(carrier.entityId)!;
    expect({ x: after.x, y: after.y }, 'the body follows its bearer')
      .toEqual({ x: bearerNow.x, y: bearerNow.y });
    expect(after.y).not.toBe(before.y);

    // Setting it down leaves it behind.
    carrier.bot.send({ t: 'drop_body' });
    await sleep(TICK * 6);
    expect(carrier.bot.entities.get(lightCorpse!.id)?.carriedBy).toBeNull();
    const dropped = { ...carrier.bot.entities.get(lightCorpse!.id)! };
    carrier.bot.send({ t: 'move', dir: 's' });
    await sleep(TICK * 8);
    const stillThere = carrier.bot.entities.get(lightCorpse!.id)!;
    expect({ x: stillThere.x, y: stillThere.y }, 'a set-down body stays put')
      .toEqual({ x: dropped.x, y: dropped.y });
    await carrier.bot.close();
  });

  it('scales with the dead character bulk, not at random', () => {
    // Find a heavy seed and a slight one and check the ordering holds.
    let heaviest = 1;
    let lightest = 1;
    for (let seed = 1; seed < 300; seed++) {
      if (generateAppearance(seed).bulk > generateAppearance(heaviest).bulk) heaviest = seed;
      if (generateAppearance(seed).bulk < generateAppearance(lightest).bulk) lightest = seed;
    }
    expect(corpseBurden(heaviest)).toBeGreaterThan(corpseBurden(lightest));
  });
});
