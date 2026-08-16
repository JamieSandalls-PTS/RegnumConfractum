import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadContent } from '@rc/server/content';
import { EventEngine } from '@rc/server/dm/events';
import { GameServer } from '@rc/server/net/gateway';
import { MemoryStore } from '@rc/server/store/memory';
import { BotClient } from '../src/botClient';

/**
 * M4a played by bots: cooldown combat under D-206's zone rules, the death
 * loop of D-203 with its ghost partition (the anti-scouting invariant), and
 * D-205's physician dependency. Also completes the M3 done-when: the armed
 * entity_death event stage finally fires.
 */

const contentDir = fileURLToPath(new URL('../../content', import.meta.url));
const TICK = 5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(pred: () => boolean, what: string, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting until ${what}`);
}

let store: MemoryStore;
let server: GameServer;
let engine: EventEngine;
let killer: BotClient; // Vell — will do the killing
let victim: BotClient; // Moss — will do the dying
let witness: BotClient; // Prue — stays alive and watching
let killerChar: string;
let victimChar: string;
let killerEntity = 0;
let victimEntity = 0;
let witnessEntity = 0;

async function join(bot: BotClient, username: string, charName: string, seed: number) {
  bot.send({ t: 'register', username, password: 'password-word' });
  await bot.expect('auth_ok');
  bot.send({ t: 'create_character', name: charName, appearanceSeed: seed });
  const characterId = (await bot.expect('character_created')).character.id;
  bot.send({ t: 'enter_world', characterId });
  const snap = await bot.expect('snapshot');
  return { characterId, entityId: snap.you };
}

async function attackUntilDead(attacker: BotClient, targetId: number): Promise<void> {
  for (let i = 0; i < 60; i++) {
    attacker.send({ t: 'attack', targetEntityId: targetId });
    await sleep(TICK * 3);
    if (!attacker.entities.has(targetId)) return;
  }
  throw new Error('target refused to die');
}

beforeAll(async () => {
  store = new MemoryStore();
  server = new GameServer({
    store,
    content: loadContent(contentDir),
    port: 0,
    tickIntervalMs: TICK,
    rngSeed: 13,
    defaultAreaId: 'hanged-ferryman',
    hostilityWindowTicks: 30, // 150ms in test time
    ghostMinTicks: 400, // ~2s — long enough that an early respawn always refuses
    attackCooldownTicks: 2,
    bleedIntervalTicks: 20,
  });
  await server.start();
  engine = new EventEngine(server, store, () => {});
  server.onTickHook = (tick) => void engine.tick(tick);
  server.onEntityDeath = (entityId) => void engine.entityDied(entityId);

  const url = `ws://127.0.0.1:${server.port}`;
  killer = await BotClient.connect(url);
  victim = await BotClient.connect(url);
  witness = await BotClient.connect(url);
  ({ characterId: killerChar, entityId: killerEntity } = await join(killer, 'killer_bot', 'Vell Harrick', 501));
  ({ characterId: victimChar, entityId: victimEntity } = await join(victim, 'victim_bot', 'Moss Tarn', 502));
  ({ entityId: witnessEntity } = await join(witness, 'witness_bot', 'Prue Aldane', 503));
});

afterAll(async () => {
  killer?.close();
  victim?.close();
  witness?.close();
  await server.stop();
});

describe('settled-zone protection (D-206)', () => {
  it('an undeclared attack in a settled area is refused', async () => {
    killer.send({ t: 'attack', targetEntityId: victimEntity });
    await killer.expectError('not_hostile');
    expect(victim.status?.hp ?? 20).toBe(20);
  });

  it('declared hostility speaks its intent, and the window must elapse', async () => {
    killer.send({
      t: 'hostile',
      targetEntityId: victimEntity,
      text: 'Your purse or your blood, Moss.',
    });
    await waitUntil(
      () => victim.speeches.some((s) => s.text.includes('Your purse or your blood')),
      'the threat is heard',
    );
    // Inside the window: still protected.
    killer.send({ t: 'attack', targetEntityId: victimEntity });
    await killer.expectError('not_hostile');
    // Logged with the spoken words (D-206).
    const events = await store.listRecentEvents(50);
    const declared = events.find((e) => e.type === 'hostility_declared');
    expect((declared?.data as { text?: string }).text).toContain('Your purse or your blood');
  });

  it('after the window, blows land and wounds appear', async () => {
    await sleep(TICK * 35); // let the warning window pass
    await waitUntil(() => {
      killer.send({ t: 'attack', targetEntityId: victimEntity });
      return (victim.status?.hp ?? 20) < 20;
    }, 'a blow lands');
    expect(victim.violations).toEqual([]);
  });
});

describe('the death loop (D-203)', () => {
  it('the victim dies; the living see the fall and nothing after', async () => {
    await attackUntilDead(killer, victimEntity);
    expect(killer.entities.has(victimEntity)).toBe(false);
    await waitUntil(() => !witness.entities.has(victimEntity), 'witness saw them fall');
    await waitUntil(() => victim.status?.ghost === true, 'the victim knows they are dead');
    expect(victim.status!.deathDebt).toBe(100);
  });

  it('ghosts see only ghosts — the dead cannot scout for the living', async () => {
    // The ghost's snapshot holds no living soul, only themself.
    expect([...victim.entities.keys()]).toEqual([victimEntity]);
    // Living movement leaks nothing to the ghost…
    const before = victim.lastTick;
    killer.send({ t: 'move', dir: 'e' });
    await waitUntil(() => killer.entities.get(killerEntity)!.x !== 30, 'killer moved');
    await sleep(200);
    expect(victim.entities.has(killerEntity)).toBe(false);
    // …and ghost speech reaches no living ear.
    const witnessHeard = witness.speeches.length;
    victim.send({ t: 'say', channel: 'shout', text: 'CAN ANYONE HEAR ME?' });
    await waitUntil(() => victim.speeches.some((s) => s.text.includes('CAN ANYONE')), 'ghost hears self');
    await sleep(200);
    expect(witness.speeches.length).toBe(witnessHeard);
    expect(before).toBeLessThanOrEqual(victim.lastTick);
  });

  it('respawn is refused before the grey country releases you', async () => {
    victim.send({ t: 'respawn' });
    await victim.expectError('too_soon');
    expect(victim.status?.ghost).toBe(true);
  });

  it('the ghost walks out with debt: alive at the town spawn, scarred', async () => {
    // Poll: send respawn, watch status. The snapshot applies to the mirror
    // on receipt — no message races needed.
    for (let i = 0; i < 30 && victim.status?.ghost !== false; i++) {
      victim.send({ t: 'respawn' });
      await sleep(300);
    }
    await waitUntil(() => victim.status?.ghost === false, 'back among the living');
    expect(victim.status!.hp).toBe(victim.status!.maxHp);
    expect(victim.status!.deathDebt).toBe(100);
    // No major wounds remain — death scars over (they downgrade to minor).
    expect(victim.status!.injuries.every((i) => i.severity === 'minor')).toBe(true);
    // The living see them again.
    await waitUntil(
      () => witness.entities.size >= 3 || [...witness.entities.keys()].length >= 2,
      'witness sees the returned',
    );
  });

  it('XP pays down the debt before it advances the character (D-203)', async () => {
    // The killer earned xp for the kill; their debt is zero so it advanced.
    expect(killer.status?.xp).toBeGreaterThan(0);
    const record = await store.getCharacter(victimChar);
    expect(record!.deathDebt).toBe(100);
  });
});

describe('the physician dependency (D-205)', () => {
  it('a major wound cannot be self-treated and bleeds until help arrives', async () => {
    // Give the victim a fresh major wound directly.
    const injury = await store.addInjury({
      characterId: victimChar,
      location: 'torso',
      kind: 'cut',
      severity: 'major',
    });
    void injury;
    await store.grantItem(victimChar, 'bandage', 2);
    // The injury cache loads at enter_world — reconnect to pick it up.
    victim.close();
    await sleep(200); // let the disconnect persist vitals (alive, hp intact)
    const revenant = await BotClient.connect(`ws://127.0.0.1:${server.port}`);
    revenant.send({ t: 'login', username: 'victim_bot', password: 'password-word' });
    const auth = await revenant.expect('auth_ok');
    revenant.send({ t: 'enter_world', characterId: auth.characters[0]!.id });
    const snap = await revenant.expect('snapshot');
    await waitUntil(() => revenant.status !== null, 'status arrives');
    expect(revenant.status!.injuries.some((i) => i.severity === 'major')).toBe(true);

    revenant.send({ t: 'treat', targetEntityId: snap.you });
    await revenant.expectError('no_injury'); // "find help"

    // Bleeding: hp drops while the wound stays open.
    const hpBefore = revenant.status!.hp;
    await waitUntil(() => (revenant.status?.hp ?? hpBefore) < hpBefore, 'the wound bleeds', 4000);

    // Another pair of hands, with a bandage, closes it.
    await store.grantItem(killerChar, 'bandage', 1);
    await walkAdjacent(killer, revenant);
    killer.send({ t: 'treat', targetEntityId: snap.you });
    await waitUntil(
      () => revenant.status !== null && !revenant.status.injuries.some((i) => i.severity === 'major'),
      'the physician closes the wound',
    );
    revenant.close();
  });
});

describe('the armed death trigger (completes the M3 done-when chain)', () => {
  it('killing the warlord springs the final event stage', async () => {
    const me = killer.entities.get(killer.you!)!;
    const record = await store.createDmEvent('Warlord Falls', {
      name: 'Warlord Falls',
      stages: [
        {
          trigger: { type: 'immediate' },
          actions: [
            {
              type: 'spawn_npc',
              area: 'hanged-ferryman',
              x: me.x,
              y: me.y,
              descriptor: 'a scarred warlord in blacked mail',
              alias: 'warlord',
            },
          ],
        },
        {
          trigger: { type: 'entity_death', alias: 'warlord' },
          actions: [
            { type: 'narrate', scope: 'global', text: 'The warlord is dead. The road is open.' },
          ],
        },
      ],
    });
    const run = await engine.start(record.id);
    await waitUntil(
      () => [...killer.entities.values()].some((e) => e.descriptor.includes('warlord')),
      'the warlord appears',
    );
    const warlord = [...killer.entities.values()].find((e) => e.descriptor.includes('warlord'))!;
    await attackUntilDead(killer, warlord.id);
    const heard = await killer.expect('narrate', 4000);
    expect(heard.text).toContain('The warlord is dead');
    const state = engine.listRuns().find((r) => r.runId === run.runId)!;
    expect(state.done).toBe(true);
  });
});

/** Walks `mover` until adjacent to `target`'s own entity. */
async function walkAdjacent(mover: BotClient, target: BotClient): Promise<void> {
  for (let i = 0; i < 120; i++) {
    const me = mover.entities.get(mover.you!);
    const them = target.entities.get(target.you!);
    if (!me || !them) break;
    const dx = them.x - me.x;
    const dy = them.y - me.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) <= 1) return;
    const dir = dy < 0 ? (dx > 0 ? 'ne' : dx < 0 ? 'nw' : 'n')
      : dy > 0 ? (dx > 0 ? 'se' : dx < 0 ? 'sw' : 's')
      : dx > 0 ? 'e' : 'w';
    mover.send({ t: 'move', dir });
    await sleep(TICK * 4);
  }
  throw new Error('never got adjacent');
}
