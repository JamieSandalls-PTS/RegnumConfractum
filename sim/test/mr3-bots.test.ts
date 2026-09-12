import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectiveSchema, type ObjectiveDef, type ObjectiveKind } from '@rc/shared';
import { loadContent } from '@rc/server/content';
import { GameServer } from '@rc/server/net/gateway';
import { MemoryStore } from '@rc/server/store/memory';
import { BotClient } from '../src/botClient';
import { BotAgent, type BotRole } from '../src/botAgent';

/**
 * Bot AI (D-540): a round played end to end by nobody.
 *
 * What these tests are for is worth being precise about, because it is not
 * "the bots behave well". They assert that a cast which is only driven through
 * the wire can produce the round's PRECONDITIONS — the cast fragments across
 * the map, work gets done, the antagonist acts on its own trigger and the
 * server resolves the round — and that nothing about playing it violates the
 * protocol. Once that holds, the two dozen unratified numbers in MR2 can be
 * measured against a round that actually runs, which is the whole reason the
 * AI exists (see HANDOFF: the remaining risk is entirely in numbers nobody has
 * felt).
 *
 * Traps observed while writing these, all of them previously paid for:
 *   - a death ends the round and a reset clears everything, so the "cast at
 *     work" suite is deliberately violence-free and stays in daylight;
 *   - `status.xp` does not move mid-round (D-524), so nothing asserts on it;
 *   - the assertions are about SHAPE, never about tuning values, so the
 *     numbers can all be retuned without a single assertion going stale.
 */

const contentDir = fileURLToPath(new URL('../../content', import.meta.url));
const content = loadContent(contentDir);
const TICK = 5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(pred: () => boolean, what: string, timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting until ${what}`);
}

/**
 * Objective kinds by id — every authored one, plus whatever a suite defines
 * inline. An antagonist resolves its brief through this the way a player
 * resolves it by reading: the wire carries only id, name and prose.
 */
function objectiveKinds(...extra: ObjectiveDef[]): Map<string, ObjectiveKind> {
  return new Map<string, ObjectiveKind>(
    [...content.objectives, ...extra].map((o) => [o.id, o.kind]),
  );
}

async function join(bot: BotClient, username: string, charName: string, seed: number) {
  bot.send({ t: 'register', username, password: 'password-word' });
  await bot.expect('auth_ok');
  bot.send({ t: 'create_character', name: charName, appearanceSeed: seed });
  const characterId = (await bot.expect('character_created')).character.id;
  bot.send({ t: 'enter_world', characterId });
  await bot.expect('snapshot');
  return characterId;
}

interface Player {
  bot: BotClient;
  agent: BotAgent;
}

async function castOf(
  url: string,
  roster: { role: BotRole; user: string; name: string }[],
  agentOpts: Partial<ConstructorParameters<typeof BotAgent>[1]> = {},
): Promise<Player[]> {
  const out: Player[] = [];
  let seed = 900;
  for (const entry of roster) {
    const bot = await BotClient.connect(url);
    await join(bot, entry.user, entry.name, seed++);
    out.push({
      bot,
      agent: new BotAgent(bot, {
        role: entry.role,
        seed: seed * 31,
        decisionMs: 120,
        ...agentOpts,
      }),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------

describe('a cast of bots plays a round', () => {
  let store: MemoryStore;
  let server: GameServer;
  let cast: Player[] = [];

  const SURVIVE: ObjectiveDef = ObjectiveSchema.parse({
    id: 'test-survive',
    name: 'Endure',
    brief: 'Live.',
    kind: { type: 'survive' },
    minCast: 3,
  });

  beforeAll(async () => {
    store = new MemoryStore();
    server = new GameServer({
      store,
      content,
      port: 0,
      tickIntervalMs: TICK,
      rngSeed: 77,
      defaultAreaId: 'round-town',
      attackCooldownTicks: 2,
      bleedIntervalTicks: 5000,
      round: {
        enabled: true,
        lengthTicks: 200_000, // the clock decides nothing here
        // The cast size EXACTLY, so the round opens when the last bot is in
        // and this suite watches a full round rather than a partial one.
        // ⚠ This used to say that a bot joining a running round never
        // receives a `round_role` — that hole is closed (D-579): every
        // arrival is told, including an antagonist who reconnects.
        minCast: 4,
        // Daylight throughout: night spawns roamers, roamers kill bots, and a
        // death would end the round this suite is trying to observe.
        dayTicks: 400_000,
        graceTicks: 0,
        seed: 'mr3-bots',
        objectives: [SURVIVE],
        resolutionTicks: 10,
      },
    });
    await server.start();
    const url = `ws://127.0.0.1:${server.port}`;
    cast = await castOf(
      url,
      [
        { role: 'gatherer', user: 'mr3_gatherer', name: 'Dorn Pickett' },
        { role: 'forager', user: 'mr3_forager', name: 'Merrow Fenn' },
        { role: 'woodsman', user: 'mr3_woodsman', name: 'Ulf Rethe' },
        { role: 'physician', user: 'mr3_physician', name: 'Isolde Marr' },
      ],
      // Nobody turns in this suite. One of them still IS the antagonist —
      // the assignment is the server's and is asserted below — but a betrayal
      // mid-suite would end the round and this suite would be measuring the
      // reset rather than the work.
      { betrayChance: 0, objectiveKinds: objectiveKinds(SURVIVE) },
    );
    await waitUntil(
      () => cast.every((p) => p.bot.roundState?.phase === 'running'),
      'the round begins',
    );
    for (const p of cast) p.agent.start();
  }, 60_000);

  afterAll(async () => {
    for (const p of cast) {
      p.agent.stop();
      p.bot.close();
    }
    await server.stop();
  });

  it('every bot receives a role, and only one of them is the antagonist', async () => {
    await waitUntil(() => cast.every((p) => p.bot.roundRole !== null), 'roles arrive');
    // The message arrives for everyone, so its mere presence is not a tell
    // (D-521) — which is exactly why this is worth asserting.
    expect(cast.filter((p) => p.bot.roundRole!.antagonist)).toHaveLength(1);
    expect(cast.filter((p) => p.bot.roundRole!.objective !== null)).toHaveLength(1);
  });

  it('the cast fragments across the map without being told its shape', async () => {
    // Nothing here names an area. The agents learn the cross by walking it,
    // so this passes on a re-authored map and fails on a map that cannot be
    // traversed at all — which is the useful direction (D-529).
    await waitUntil(
      () => cast.some((p) => p.agent.visited.length >= 2),
      'somebody goes through a door',
      40_000,
    );
    const areas = new Set(cast.map((p) => p.bot.area?.id));
    expect(areas.size).toBeGreaterThan(1);
  }, 60_000);

  it('work actually gets done', async () => {
    await waitUntil(
      () => cast.some((p) => p.bot.work.some((w) => w.done && w.interrupted === null)),
      'a job finishes',
      40_000,
    );
    const worked = cast.filter((p) => p.bot.work.some((w) => w.done && w.interrupted === null));
    expect(worked.length).toBeGreaterThan(0);
    expect(worked.some((p) => p.bot.inventory.length > 0)).toBe(true);
  }, 60_000);

  it('nobody desyncs or violates the protocol while playing', () => {
    for (const p of cast) {
      expect(p.bot.violations, `${p.agent.role} violations`).toEqual([]);
      expect(p.bot.lastResyncDiffs ?? []).toEqual([]);
    }
  });

  it('status carries the level and the effective sheet (D-538)', () => {
    for (const p of cast) {
      const status = p.bot.status;
      expect(status).not.toBeNull();
      expect(status!.level).toBeGreaterThanOrEqual(1);
      // A fresh character allocated nothing, so the sheet is empty rather
      // than absent — the shape must be there from level one.
      expect(status!.skills).toBeDefined();
      expect(Array.isArray(status!.feats)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------

describe('the antagonist acts on its own trigger', () => {
  let store: MemoryStore;
  let server: GameServer;
  let cast: Player[] = [];

  /** The low-cast workhorse (D-526): a fixed, defenceless, known target. */
  const SILENCE: ObjectiveDef = ObjectiveSchema.parse({
    id: 'test-silence',
    name: 'Silence the Keeper',
    brief: 'The keeper must be dead before the round is out.',
    kind: { type: 'kill_npc', descriptor: 'the keeper' },
    minCast: 3,
  });

  beforeAll(async () => {
    store = new MemoryStore();
    server = new GameServer({
      store,
      content,
      port: 0,
      tickIntervalMs: TICK,
      rngSeed: 91,
      defaultAreaId: 'round-town',
      attackCooldownTicks: 2,
      bleedIntervalTicks: 5000,
      round: {
        enabled: true,
        lengthTicks: 200_000,
        minCast: 3,
        dayTicks: 400_000,
        graceTicks: 0,
        seed: 'mr3-antagonist',
        objectives: [SILENCE],
        resolutionTicks: 10,
      },
    });
    await server.start();
    const url = `ws://127.0.0.1:${server.port}`;
    // The trigger is forced here — its randomness is the subject of its own
    // test below, and a suite that waited on a 5% roll would be a coin flip
    // dressed as an assertion.
    cast = await castOf(
      url,
      [
        { role: 'gatherer', user: 'mr3a_one', name: 'Cass Vellin' },
        { role: 'idler', user: 'mr3a_two', name: 'Perrin Ostry' },
        { role: 'idler', user: 'mr3a_three', name: 'Hale Marrowby' },
      ],
      { betrayEarliestMs: 0, betrayChance: 1, objectiveKinds: objectiveKinds(SILENCE) },
    );
    await waitUntil(
      () => cast.every((p) => p.bot.roundState?.phase === 'running' && p.bot.roundRole !== null),
      'the round begins and roles land',
    );
  }, 60_000);

  afterAll(async () => {
    for (const p of cast) {
      p.agent.stop();
      p.bot.close();
    }
    await server.stop();
  });

  it('finds the keeper by walking to it, kills it, and wins the round', async () => {
    const villain = cast.find((p) => p.bot.roundRole!.antagonist)!;
    const innocents = cast.filter((p) => p !== villain);
    // The keeper stands in the town, not next to anybody: reaching it is the
    // agent's problem, which is what makes this a navigation test as well.
    const me = villain.bot.entities.get(villain.bot.you!)!;
    server.spawnNpc('round-town', { x: me.x + 4, y: me.y, descriptor: 'the keeper' });

    for (const p of cast) p.agent.start();
    await waitUntil(() => villain.agent.committedAtMs !== null, 'the antagonist commits');
    await waitUntil(
      () => villain.bot.roundsEnded.length > 0,
      'the round resolves',
      45_000,
    );
    const ended = villain.bot.roundsEnded[0]!;
    expect(ended.winner).toBe('antagonist');
    // The reveal names them, and it is the only message that ever does.
    expect(ended.antagonistName.length).toBeGreaterThan(0);
    // Nobody else was told anything: the innocents learn who it was in the
    // same breath as everyone else, never before.
    for (const p of innocents) {
      expect(p.bot.roundRole!.objective).toBeNull();
    }
  }, 90_000);
});

// ---------------------------------------------------------------------------

describe('the betrayal trigger', () => {
  /**
   * The trigger is a property of the AGENT, not of the server, so it is
   * tested as one: no sockets, no round, just the roll. What matters is that
   * it is (a) deterministic per seed and (b) not immediate — an antagonist
   * that turns at the first opportunity never gets to be anybody's friend,
   * and the whole mode is built on the interval before it does.
   */
  it('is deterministic for a seed, and different across seeds', () => {
    const rolls = (seed: number): number[] => {
      const fake = {
        roundRole: { t: 'round_role', antagonist: true, objective: null },
      } as unknown as BotClient;
      const agent = new BotAgent(fake, { role: 'idler', seed, betrayEarliestMs: 0 });
      // Reach into the same stream the agent would use, the same number of
      // times, and record where it would have fired at a 20% chance.
      const out: number[] = [];
      for (let i = 0; i < 40; i++) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        out.push((agent as any).rng() < 0.2 ? 1 : 0);
      }
      return out;
    };
    expect(rolls(1234)).toEqual(rolls(1234));
    expect(rolls(1234)).not.toEqual(rolls(4321));
    // And it does fire, eventually, rather than never.
    expect(rolls(1234).some((n) => n === 1)).toBe(true);
  });
});
