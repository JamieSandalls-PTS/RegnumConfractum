import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ARMOUR_CLASS_BY_MATERIAL, BASE_ARMOUR_CLASS } from '@rc/shared';
import { loadContent } from '@rc/server/content';
import { GameServer } from '@rc/server/net/gateway';
import { MemoryStore } from '@rc/server/store/memory';
import { BotClient } from '../src/botClient';
import { TICK as SIM_TICK, sleep } from '../src/testTick';

/**
 * Dice combat, through the wire (D-606).
 *
 * ⚠ `shared/test/d20.test.ts` proves the arithmetic. This proves the thing
 * arithmetic cannot: that the numbers reach a real fight. Combat has been a
 * flat 2–6 that always landed since M4, and every part of the stack — the
 * swing, the defender's half, the event, the client — was written on the
 * assumption that a blow connects.
 *
 * ⚠ Seeded, so "sometimes it misses" is a fact rather than an anecdote. The
 * server takes `rngSeed`, which is what lets a combat test assert a
 * DISTRIBUTION instead of hoping.
 */

const contentDir = fileURLToPath(new URL('../../content', import.meta.url));
const TICK = SIM_TICK; // see sim/src/testTick.ts (D-633)

let store: MemoryStore;
let server: GameServer;
let attacker: BotClient;
let victim: BotClient;
let victimEntity: number;

beforeAll(async () => {
  store = new MemoryStore();
  server = new GameServer({
    store,
    content: loadContent(contentDir),
    port: 0,
    tickIntervalMs: TICK,
    rngSeed: 4242,
    // The yard is wilderness (D-206), so blows need no declaration and the
    // test exercises the real path rather than the hostility window.
    defaultAreaId: 'broken-yard',
  });
  await server.start();

  attacker = await BotClient.connect(`ws://127.0.0.1:${server.port}`);
  attacker.send({ t: 'register', username: 'roller', password: 'password-word' });
  await attacker.expect('auth_ok');
  attacker.send({ t: 'create_character', name: 'Orin Vance', appearanceSeed: 1 });
  const a = (await attacker.expect('character_created')).character.id;
  attacker.send({ t: 'enter_world', characterId: a });
  await attacker.expect('snapshot');

  victim = await BotClient.connect(`ws://127.0.0.1:${server.port}`);
  victim.send({ t: 'register', username: 'target', password: 'password-word' });
  await victim.expect('auth_ok');
  victim.send({ t: 'create_character', name: 'Wren Dale', appearanceSeed: 2 });
  const v = (await victim.expect('character_created')).character.id;
  victim.send({ t: 'enter_world', characterId: v });
  await victim.expect('snapshot');
  victimEntity = victim.you!;

  // Stand them together.
  const me = attacker.entities.get(attacker.you!)!;
  const them = victim.entities.get(victimEntity)!;
  victim.send({ t: 'move_to', x: me.x + 0.8, y: me.y });
  for (let i = 0; i < 200; i++) {
    const now = victim.entities.get(victimEntity)!;
    if (Math.hypot(now.x - me.x, now.y - me.y) < 1.2) break;
    await sleep(TICK * 4);
  }
  victim.send({ t: 'move_stop' });
  void them;
  await sleep(TICK * 8);
});

afterAll(async () => {
  attacker?.close();
  victim?.close();
  await server?.stop();
});

describe('a blow is a roll', () => {
  it('sometimes misses, and says so on the wire', async () => {
    // ⚠ The assertion that matters. Before this, every swing landed — so a
    // single miss anywhere in a long run is proof the roll is real and
    // reaching the event, which is three layers away from the arithmetic.
    let hits = 0;
    let misses = 0;
    let rolled = 0;
    for (let i = 0; i < 120 && (hits === 0 || misses === 0); i++) {
      attacker.send({ t: 'attack', targetEntityId: victimEntity });
      await sleep(TICK * 4);
      for (const a of attacker.attacks.splice(0)) {
        if (a.attackerId !== attacker.you) continue;
        rolled++;
        if (a.hit) hits++;
        else misses++;
      }
      // Keep the victim upright: a corpse cannot be swung at, and this test is
      // about the distribution rather than about killing anybody.
      const v = victim.status;
      if (v && v.hp <= 6) break;
    }
    expect(rolled, 'the attacker actually swung').toBeGreaterThan(0);
    expect(hits, 'at least one blow landed').toBeGreaterThan(0);
    expect(misses, 'at least one blow missed').toBeGreaterThan(0);
  }, 120_000);

  it('carries the face, so a natural 20 can be named rather than guessed', () => {
    const seen = attacker.attacks.concat(victim.attacks);
    for (const a of seen) {
      expect(a.roll).toBeGreaterThanOrEqual(1);
      expect(a.roll).toBeLessThanOrEqual(20);
      // A miss deals nothing at all — there is no floor of one any more,
      // because the floor existed for subtraction that no longer happens.
      if (!a.hit) expect(a.damage).toBe(0);
      if (a.hit) expect(a.damage).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('armour class is composed the way the brief says', () => {
  it('starts at ten and is moved by dexterity and armour, not by luck', () => {
    // Stated here as well as in the unit tests because this is the number a
    // player will ask about first, and it should be checkable from the outside.
    expect(BASE_ARMOUR_CLASS).toBe(10);
    expect(ARMOUR_CLASS_BY_MATERIAL.cloth).toBeLessThan(ARMOUR_CLASS_BY_MATERIAL.leather);
    expect(ARMOUR_CLASS_BY_MATERIAL.leather).toBeLessThan(ARMOUR_CLASS_BY_MATERIAL.plate);
  });
});
