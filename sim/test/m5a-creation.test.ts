import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadContent } from '@rc/server/content';
import { GameServer } from '@rc/server/net/gateway';
import { MemoryStore } from '@rc/server/store/memory';
import { CREATION_SKILL_POINTS, validateBuild } from '@rc/shared';
import { BotClient } from '../src/botClient';
import { TICK as SIM_TICK } from '../src/testTick';

/**
 * Character creation (D-208): class, skill allocation, feats and spells.
 *
 * The point of these tests is the D-102 invariant. The creation UI is a
 * convenience; the SERVER decides what is legal. Every rejection below is
 * a build a hostile client could submit by hand — over-allocated points, a
 * feat without its prerequisite, a spell off the class list, magic on a
 * mundane class — and each must be refused before anything is persisted.
 */

const contentDir = fileURLToPath(new URL('../../content', import.meta.url));
const TICK = SIM_TICK; // see sim/src/testTick.ts (D-633)

let store: MemoryStore;
let server: GameServer;
let content: ReturnType<typeof loadContent>;

beforeAll(async () => {
  content = loadContent(contentDir);
  store = new MemoryStore();
  server = new GameServer({
    store,
    content,
    port: 0,
    tickIntervalMs: TICK,
    rngSeed: 31,
    defaultAreaId: 'hanged-ferryman',
  });
  await server.start();
});

afterAll(async () => {
  await server.stop();
});

async function account(bot: BotClient, username: string): Promise<void> {
  bot.send({ t: 'register', username, password: 'password-word' });
  await bot.expect('auth_ok');
}

describe('the creation catalogue comes from content (D-110)', () => {
  it('serves classes, skills, feats and spells with the budget', async () => {
    const bot = await BotClient.connect(`ws://127.0.0.1:${server.port}`);
    await account(bot, 'creator_catalogue');
    bot.send({ t: 'get_creation_content' });
    const cat = await bot.expect('creation_content');
    expect(cat.classes.length).toBe(content.classes.size);
    expect(cat.skills.length).toBeGreaterThan(0);
    expect(cat.feats.length).toBeGreaterThan(0);
    expect(cat.spells.length).toBeGreaterThan(0);
    expect(cat.budget.skillPoints).toBe(CREATION_SKILL_POINTS);
    // Every casting class must have something to learn, or its creation
    // step would be an empty list.
    for (const cls of cat.classes.filter((c) => c.spellcasting)) {
      const available = cat.spells.filter((s) => s.classes.length === 0 || s.classes.includes(cls.id));
      expect(available.length, `${cls.id} has no spells`).toBeGreaterThan(0);
    }
    await bot.close();
  });
});

describe('a legal build is accepted and persisted', () => {
  it('creates a physician with skills and a prerequisite-met feat', async () => {
    const bot = await BotClient.connect(`ws://127.0.0.1:${server.port}`);
    await account(bot, 'creator_legal');
    bot.send({
      t: 'create_character',
      name: 'Mercy Halloway',
      appearanceSeed: 4242,
      classId: 'physician',
      build: {
        attributes: { vigor: 14, will: 16 },
        skills: { medicine: 40, insight: 30, lore: 20, perception: 20 },
        feats: ['steady-hands', 'hard-to-read'],
        spells: [],
      },
    });
    const created = await bot.expect('character_created');
    expect(created.character.classId).toBe('physician');

    const record = await store.getCharacter(created.character.id);
    expect(record?.skills).toEqual({ medicine: 40, insight: 30, lore: 20, perception: 20 });
    expect(record?.feats).toEqual(['steady-hands', 'hard-to-read']);
    // The three pre-existing skill columns are mirrored out of the map so
    // every mechanic already written (D-218 contests, D-511 zombie cap)
    // keeps reading exactly one source of truth.
    expect(record?.insight).toBe(10 + 30);
    expect(record?.bluff).toBe(10); // unallocated: baseline only
    expect(record?.necromancy).toBe(0);
    await bot.close();
  });

  it('a build is optional — bots and old clients still create characters', async () => {
    const bot = await BotClient.connect(`ws://127.0.0.1:${server.port}`);
    await account(bot, 'creator_nobuild');
    bot.send({ t: 'create_character', name: 'Plain Jenkin', appearanceSeed: 7 });
    const created = await bot.expect('character_created');
    const record = await store.getCharacter(created.character.id);
    expect(record?.skills).toEqual({});
    expect(record?.bluff).toBe(10);
    await bot.close();
  });
});

describe('the server refuses illegal builds (D-102)', () => {
  /** Submits a build and expects a rejection rather than a character. */
  async function reject(username: string, name: string, msg: Record<string, unknown>): Promise<string> {
    const bot = await BotClient.connect(`ws://127.0.0.1:${server.port}`);
    await account(bot, username);
    bot.send({ t: 'create_character', name, ...msg } as Parameters<BotClient['send']>[0]);
    const err = await bot.expect('error');
    await bot.close();
    return err.message;
  }

  it('rejects overspent skill points', async () => {
    const message = await reject('creator_overspend', 'Greedy Sod', {
      classId: 'man-at-arms',
      build: { skills: { arms: 40, athletics: 40, intimidation: 40, perception: 40 }, feats: [], spells: [] },
    });
    expect(message).toMatch(/overspent/);
    expect(await store.getCharactersByAccount('nobody')).toEqual([]);
  });

  it('rejects a skill above the per-skill creation cap', async () => {
    const message = await reject('creator_cap', 'Spiky Sam', {
      classId: 'man-at-arms',
      build: { skills: { arms: 100 }, feats: [], spells: [] },
    });
    expect(message).toMatch(/cap/);
  });

  it('rejects a feat whose skill prerequisite is unmet', async () => {
    const message = await reject('creator_feat_req', 'Unsteady Ned', {
      classId: 'physician',
      build: { skills: {}, feats: ['steady-hands'], spells: [] },
    });
    expect(message).toMatch(/requires/i);
  });

  it('rejects a feat restricted to another class', async () => {
    const message = await reject('creator_feat_class', 'Wrong Path', {
      classId: 'physician',
      build: { skills: { necromancy: 20 }, feats: ['grave-touched'], spells: [] },
    });
    expect(message).toMatch(/cannot take/i);
  });

  it('rejects spells on a class that does not cast', async () => {
    const message = await reject('creator_nocast', 'Hopeful Brute', {
      classId: 'berserker',
      build: { skills: {}, feats: [], spells: ['guttering-light'] },
    });
    expect(message).toMatch(/does not cast/i);
  });

  it('rejects a spell that is not on the class list', async () => {
    const message = await reject('creator_wrongspell', 'Overreacher', {
      classId: 'cantor',
      build: { skills: {}, feats: [], spells: ['false-face'] },
    });
    expect(message).toMatch(/cannot learn/i);
  });

  it('rejects too many feats', async () => {
    const message = await reject('creator_manyfeats', 'Greedy Gus', {
      classId: 'hunter',
      build: { skills: {}, feats: ['hard-to-read', 'night-eyes', 'quiet-footed'], spells: [] },
    });
    expect(message).toMatch(/too many feats/i);
  });

  it('rejects an unknown class and an unknown skill', async () => {
    expect(await reject('creator_badclass', 'Nobody Much', {
      classId: 'dragon-knight',
      build: { skills: {}, feats: [], spells: [] },
    })).toMatch(/no such class/i);
    expect(await reject('creator_badskill', 'Odd Sort', {
      classId: 'hunter',
      build: { skills: { flying: 10 }, feats: [], spells: [] },
    })).toMatch(/unknown skill/i);
  });
});

describe('validateBuild is the single rule set (used by both sides)', () => {
  const catalogue = () => ({
    classes: [...content.classes.values()],
    skills: content.skills,
    feats: content.feats,
    spells: content.spells,
  });

  it('accepts an empty build for any real class', () => {
    for (const cls of content.classes.values()) {
      expect(
        validateBuild(catalogue(), cls.id, { skills: {}, feats: [], spells: [] }),
        cls.id,
      ).toEqual([]);
    }
  });

  it('spends exactly the budget without complaint, and one point over fails', () => {
    const exact = { skills: { arms: 40, athletics: 40, intimidation: 40 }, feats: [], spells: [] };
    expect(validateBuild(catalogue(), 'man-at-arms', exact)).toEqual([]);
    const over = { skills: { arms: 40, athletics: 40, intimidation: 40, lore: 5 }, feats: [], spells: [] };
    expect(validateBuild(catalogue(), 'man-at-arms', over).join()).toMatch(/overspent/);
  });

  it('rejects allocations off the step grid', () => {
    const odd = { skills: { arms: 7 }, feats: [], spells: [] };
    expect(validateBuild(catalogue(), 'man-at-arms', odd).join()).toMatch(/steps of/);
  });

  it('rejects duplicate picks', () => {
    const dupe = { skills: {}, feats: ['hard-to-read', 'hard-to-read'], spells: [] };
    expect(validateBuild(catalogue(), 'hunter', dupe).join()).toMatch(/duplicate feat/);
  });
});
