import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectiveSchema, type ObjectiveDef } from '@rc/shared';
import { loadContent } from '@rc/server/content';
import { GameServer } from '@rc/server/net/gateway';
import { MemoryStore } from '@rc/server/store/memory';
import { BotClient } from '../src/botClient';

/**
 * A round played end to end by bots (D-521 – D-527). This is MR1's
 * definition of done, and the assertions are the properties the mode stands
 * on rather than "it ran":
 *
 *   - a round does not start below the minimum cast of three (D-522)
 *   - the antagonist is told; the rest are told nothing (D-521). The broadcast
 *     state must never carry the objective or the identity
 *   - the dead stay down — respawn is refused outright, which is THE
 *     difference between the Round and the persistent world (D-521)
 *   - dying forfeits the round's xp; surviving banks it (D-524)
 *   - ghosts still see only ghosts with a round running (invariant 4 — this
 *     is the one the whole mode would break most quietly)
 *   - reset wipes recognition and strips gear, and keeps names and levels
 *     (D-522, D-525)
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

/**
 * A fixed scenario. The suite must not depend on which objective content
 * happens to hold, so the server is handed exactly one: kill the keeper.
 * That also keeps the antagonist's win condition reachable by a bot.
 */
const KILL_KEEPER: ObjectiveDef = ObjectiveSchema.parse({
  id: 'test-kill-keeper',
  name: 'Silence the Keeper',
  brief: 'The keeper must not see morning.',
  kind: { type: 'kill_npc', descriptor: 'the keeper' },
  minCast: 3,
});

let store: MemoryStore;
let server: GameServer;
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

/** The bot the server made antagonist, and the rest of the cast. */
function antagonist(): BotClient {
  const found = bots.find((b) => b.roundRole?.antagonist);
  if (!found) throw new Error('no antagonist was assigned');
  return found;
}
function innocents(): BotClient[] {
  return bots.filter((b) => !b.roundRole?.antagonist);
}

beforeAll(async () => {
  store = new MemoryStore();
  server = new GameServer({
    store,
    content: loadContent(contentDir),
    port: 0,
    tickIntervalMs: TICK,
    rngSeed: 41,
    // The TOWN — a settled zone. In the persistent world an attack here
    // would need a declaration; in a round it must not (D-531).
    defaultAreaId: 'round-town',
    ghostMinTicks: 50,
    attackCooldownTicks: 2,
    bleedIntervalTicks: 5000,
    round: {
      enabled: true,
      // Long enough that the clock never decides anything here — every
      // assertion below is about the deed, not the deadline. Note the server
      // runs ~60 ticks/s under test load, not the nominal 200.
      lengthTicks: 60_000,
      minCast: 3,
      // No dawn truce here (D-536): this suite is not about it, and a
      // 60-second peace at the round's opening would only add dead time.
      graceTicks: 0,
      seed: 'mr1-test',
      objectives: [KILL_KEEPER],
      resolutionTicks: 10,
    },
  });
  await server.start();
});

afterAll(async () => {
  for (const b of bots) b.close();
  await server.stop();
});

describe('the lobby holds until there is a cast (D-522)', () => {
  it('two players wait; the third begins the round', async () => {
    const url = `ws://127.0.0.1:${server.port}`;
    for (let i = 0; i < 2; i++) {
      const bot = await BotClient.connect(url);
      bots.push(bot);
      charIds.push(await join(bot, `round_bot_${i}`, `Cast Member${'X'.repeat(i)}`, 900 + i));
    }
    await waitUntil(() => bots[0]!.roundState !== null, 'the lobby reports itself');
    expect(bots[0]!.roundState!.phase).toBe('lobby');
    expect(bots[0]!.roundState!.minCast).toBe(3);
    // Nobody has been given a role, because there is no round yet.
    expect(bots.every((b) => b.roundRole === null)).toBe(true);

    const third = await BotClient.connect(url);
    bots.push(third);
    charIds.push(await join(third, 'round_bot_2', 'Cast MemberXX', 902));
    await waitUntil(() => bots[0]!.roundState?.phase === 'running', 'the round begins');
  });
});

describe('the secret (D-521)', () => {
  it('tells exactly one player, and tells everyone something', async () => {
    await waitUntil(() => bots.every((b) => b.roundRole !== null), 'every player learns their role');
    const withObjective = bots.filter((b) => b.roundRole!.objective !== null);
    expect(withObjective).toHaveLength(1);
    expect(withObjective[0]!.roundRole!.antagonist).toBe(true);
    expect(withObjective[0]!.roundRole!.objective!.brief).toContain('keeper');
    // The innocents got a message too — so the arrival of one is not a tell.
    for (const b of innocents()) {
      expect(b.roundRole!.antagonist).toBe(false);
      expect(b.roundRole!.objective).toBeNull();
    }
  });

  it('never puts the objective or the identity in the broadcast state', () => {
    for (const b of bots) {
      const state = JSON.stringify(b.roundState);
      expect(state).not.toContain('keeper');
      expect(state).not.toContain('objective');
      expect(state).not.toContain('antagonist');
    }
  });

  it('runs its own compressed clock, starting at dawn (D-527)', () => {
    const state = bots[0]!.roundState!;
    expect(state.hour).toBeGreaterThanOrEqual(6);
    expect(state.night).toBe(false); // a round opens in daylight
    expect(state.remainingTicks).not.toBeNull();
  });
});

describe('death in a round (D-521, D-524)', () => {
  it('the dead may not respawn — they stay down until the round ends', async () => {
    const victim = innocents()[0]!;
    const killer = innocents()[1]!;
    const victimId = victim.you!;

    // No declaration, in a SETTLED zone: violence is free in a round.
    for (let i = 0; i < 80 && victim.status?.ghost !== true; i++) {
      killer.send({ t: 'attack', targetEntityId: victimId });
      await sleep(TICK * 6);
    }
    expect(victim.status?.ghost).toBe(true);

    // The persistent world would let them walk it off. A round does not.
    victim.send({ t: 'respawn' });
    const err = await victim.expectError('not_dead');
    expect(err.message).toMatch(/until the round ends/);
  });

  it('was heard — violence is free, but loud (D-531)', () => {
    // Somebody who was not in the fight heard it happen. This is what
    // replaces the hostility declaration: the restraint on murder is
    // informational, not procedural.
    const bystander = bots.find((b) => b.sounds.length > 0);
    expect(bystander, 'nobody heard the killing').toBeDefined();
    const heard = bystander!.sounds[0]!;
    expect(heard.kind).toBe('combat');
    expect(['near', 'far']).toContain(heard.distance);
    expect(heard.text).toBeTruthy();
  });

  it('never says WHO — a sound is a lead, not evidence (D-217)', () => {
    // The moment a sound names anyone, disguise, alibi and accusation all
    // stop mattering. Assert against every character name in the round.
    const names = ['Cast Member', 'Cast MemberX', 'Cast MemberXX'];
    for (const b of bots) {
      for (const sound of b.sounds) {
        const payload = JSON.stringify(sound);
        for (const name of names) expect(payload).not.toContain(name);
        expect(payload).not.toMatch(/entityId|characterId/);
      }
    }
  });

  it('the fighters are not told they heard themselves', () => {
    // The killer was in the fight; anything they "heard" would be their own
    // sword, which is noise in both senses.
    const killer = innocents()[1]!;
    expect(killer.sounds.length).toBe(0);
  });

  it('carries no death debt — the cost of dying is the round, not a tax', () => {
    const dead = bots.find((b) => b.status?.ghost)!;
    expect(dead.status!.deathDebt).toBe(0);
  });

  it('ghosts still see only ghosts with a round running (invariant 4)', async () => {
    const dead = bots.find((b) => b.status?.ghost)!;
    const living = bots.filter((b) => !b.status?.ghost);
    // The dead player's mirror must contain no living entity, and no living
    // player's mirror may contain the ghost. A round changes the rules of
    // death; it does not relax this one.
    for (const alive of living) {
      expect(dead.entities.has(alive.you!)).toBe(false);
      expect(alive.entities.has(dead.you!)).toBe(false);
    }
  });

  it('the dead do not HEAR the living either (invariant 4, D-531)', async () => {
    const dead = bots.find((b) => b.status?.ghost)!;
    const striker = bots.find((b) => !b.status?.ghost)!;
    const heardBefore = dead.sounds.length;
    const strikerHeardBefore = bots
      .filter((b) => b !== striker && !b.status?.ghost)
      .reduce((n, b) => n + b.sounds.length, 0);

    // A living player hits a straw NPC in earshot of the ghost. Deliberately
    // NOT a player-vs-player brawl: this test must not change who is alive,
    // or it decides the round the later tests are trying to observe.
    const me = striker.entities.get(striker.you!)!;
    const straw = server.spawnNpc(striker.area!.id, {
      x: me.x + 1, // ATTACK_RANGE is 1 — two tiles away is out of reach
      y: me.y,
      descriptor: 'a straw figure',
      appearanceSeed: 12345,
    });
    for (let i = 0; i < 4; i++) {
      striker.send({ t: 'attack', targetEntityId: straw });
      await sleep(TICK * 6);
    }

    // A dead player who could hear where fighting was happening would be a
    // live scout on a voice call — the same leak as seeing, by another route.
    expect(dead.sounds.length).toBe(heardBefore);
    // ...and the living DID hear it, so the silence above is the partition
    // rather than the noise simply failing to fire.
    const strikerHeardAfter = bots
      .filter((b) => b !== striker && !b.status?.ghost)
      .reduce((n, b) => n + b.sounds.length, 0);
    expect(strikerHeardAfter).toBeGreaterThan(strikerHeardBefore);
    server.despawnEntity(straw);
  });
});

describe('resolving and resetting', () => {
  it('the objective completes, the round ends, and the reveal names the antagonist', async () => {
    const traitor = antagonist();
    const me = traitor.entities.get(traitor.you!)!;
    // Put the keeper within reach of the antagonist. The scripted keeper
    // lives in the tavern; this test is about the win condition, not about
    // pathfinding across areas.
    const keeperId = server.spawnNpc(traitor.area!.id, {
      x: me.x + 1,
      y: me.y,
      descriptor: 'the keeper',
      appearanceSeed: 4242,
    });
    await waitUntil(() => traitor.entities.has(keeperId), 'the keeper is in view');

    for (let i = 0; i < 120 && traitor.roundsEnded.length === 0; i++) {
      traitor.send({ t: 'attack', targetEntityId: keeperId });
      await sleep(TICK * 6);
    }
    await waitUntil(() => bots.every((b) => b.roundsEnded.length > 0), 'the round resolves', 20_000);

    const ending = bots[0]!.roundsEnded[0]!;
    // The deed decided it — not the clock, which is nowhere near expiring.
    expect(ending.outcome).toBe('objective_complete');
    expect(ending.winner).toBe('antagonist');
    expect(ending.objectiveName).toBe('Silence the Keeper');
    // The reveal is the ONLY message that ever names the antagonist.
    expect(ending.antagonistName).toBeTruthy();
    // Everyone is told the same story.
    for (const b of bots) {
      expect(b.roundsEnded[0]!.outcome).toBe(ending.outcome);
      expect(b.roundsEnded[0]!.antagonistName).toBe(ending.antagonistName);
    }
  }, 40_000);

  it('the dead banked nothing; the living banked what they earned (D-524)', () => {
    const deadEnding = bots.find((b) => !b.roundsEnded[0]!.survived)?.roundsEnded[0];
    expect(deadEnding, 'a bot died during this round').toBeDefined();
    expect(deadEnding!.xpBanked).toBe(0);
    // The antagonist cut down an NPC and lived: that xp is real and banked.
    const traitorEnding = antagonist().roundsEnded[0]!;
    expect(traitorEnding.survived).toBe(true);
    expect(traitorEnding.xpBanked).toBeGreaterThan(0);
  });

  it('pays NOTHING for killing another player (D-522)', () => {
    // The innocent who cut down a fellow player survived the round and
    // banked nothing for it. This is the rule that stops the cast being paid
    // to lynch whoever they suspect — the D-303 violation MR must not commit,
    // and the persistent world's 25-xp kill reward would have done exactly
    // that if it had been left switched on.
    const killer = innocents().find((b) => b.roundsEnded[0]!.survived)!;
    expect(killer.roundsEnded[0]!.xpBanked).toBe(0);
  });

  it('reset wipes recognition and strips gear, and keeps the character', async () => {
    // Plant a memory and a possession to be cleared.
    await store.upsertKnowledge({
      observerCharacterId: charIds[0]!,
      subjectCharacterId: charIds[1]!,
      presentation: 'normal',
      knownName: 'Cast MemberX',
      provenance: 'self_claimed',
      impression: null,
    });
    await store.grantItem(charIds[0]!, 'iron-ore', 3);
    expect((await store.getItemsByCharacter(charIds[0]!)).length).toBeGreaterThan(0);

    await waitUntil(() => bots[0]!.roundState?.phase !== 'resolved', 'the round resets', 10_000);

    // Recognition is round-scoped (D-525): strangers again.
    const known = await store.getKnowledge(charIds[0]!, [charIds[1]!]);
    expect(known.size).toBe(0);
    // Gear does not cross the boundary (D-522).
    expect(await store.getItemsByCharacter(charIds[0]!)).toEqual([]);
    // But the character does — same name, same face, same account.
    const survivor = await store.getCharacter(charIds[0]!);
    expect(survivor?.name).toBe('Cast Member');
    expect(survivor?.retired).toBe(false);
  });
});
