import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HAIR_COLORS, SKIN_COLORS, xpForLevel } from '@rc/shared';
import { loadContent } from '@rc/server/content';
import { GameServer } from '@rc/server/net/gateway';
import { MemoryStore } from '@rc/server/store/memory';
import { BotClient } from '../src/botClient';
import { TICK_INTERVAL_MS, sleep } from '../src/testTick';

/**
 * Authored appearance and levels over the wire (D-538, D-539).
 *
 * Two things are being defended here. The first is D-102: the client proposes
 * a body and the SERVER decides whether it is one, so a hand-rolled client
 * cannot walk in as a three-metre figure. The second is subtler and is the
 * reason the override goes on the wire at all — a player who builds a
 * towering figure must be DESCRIBED as one. Stranger-descriptors are the
 * whole of D-201/D-219 identity, and a descriptor computed from the raw seed
 * would quietly describe somebody else.
 */

const contentDir = fileURLToPath(new URL('../../content', import.meta.url));
const content = loadContent(contentDir);

let store: MemoryStore;
let server: GameServer;

async function account(bot: BotClient, username: string): Promise<void> {
  bot.send({ t: 'register', username, password: 'password-word' });
  await bot.expect('auth_ok');
}

beforeAll(async () => {
  store = new MemoryStore();
  server = new GameServer({
    store,
    content: loadContent(contentDir),
    port: 0,
    tickIntervalMs: TICK_INTERVAL_MS,
    rngSeed: 12,
    defaultAreaId: 'hanged-ferryman',
  });
  await server.start();
});

afterAll(async () => {
  await server.stop();
});

const url = (): string => `ws://127.0.0.1:${server.port}`;

/** A deliberately extreme but legal body: unmistakable in a descriptor. */
const TOWERING = {
  archetype: 'brute' as const,
  sex: 'female' as const,
  height: 2.0,
  bulk: 0.7,
  hairColor: HAIR_COLORS[2]!,
  skin: SKIN_COLORS[4]!,
};

describe('a player-authored appearance', () => {
  it('is persisted, and comes back on the character summary', async () => {
    const bot = await BotClient.connect(url());
    await account(bot, 'app_author');
    bot.send({
      t: 'create_character',
      name: 'Wrenna Coldhouse',
      appearanceSeed: 5150,
      classId: 'berserker',
      appearance: TOWERING,
    });
    const created = await bot.expect('character_created');
    expect(created.character.appearance).toMatchObject(TOWERING);
    expect(created.character.level).toBe(1);
    const record = (await store.getCharactersByAccount((await store.getAccountByUsername('app_author'))!.id))[0]!;
    expect(record.appearance).toMatchObject(TOWERING);
    bot.close();
  });

  it('is what strangers see — the descriptor follows the body, not the seed', async () => {
    const author = await BotClient.connect(url());
    const onlooker = await BotClient.connect(url());
    await account(author, 'app_seen');
    await account(onlooker, 'app_watcher');
    // The seed alone would roll some other build entirely; the override is
    // what must reach the observer.
    author.send({
      t: 'create_character',
      name: 'Halda Vance',
      appearanceSeed: 991,
      appearance: TOWERING,
    });
    const authorChar = (await author.expect('character_created')).character.id;
    onlooker.send({ t: 'create_character', name: 'Tolm Reddy', appearanceSeed: 992 });
    const watcherChar = (await onlooker.expect('character_created')).character.id;
    onlooker.send({ t: 'enter_world', characterId: watcherChar });
    await onlooker.expect('snapshot');
    author.send({ t: 'enter_world', characterId: authorChar });
    await author.expect('snapshot');
    await sleep(120);

    const seen = [...onlooker.entities.values()].find((e) => e.kind === 'player' && e.id !== onlooker.you);
    expect(seen, 'the author should be visible').toBeDefined();
    // 'brute' at two metres reads as towering; no seed-rolled body would be
    // described this way by accident often enough to make this a coincidence.
    expect(seen!.descriptor).toContain('towering');
    expect(seen!.appearance).toMatchObject({ archetype: 'brute' });
    author.close();
    onlooker.close();
  });

  it('is refused when it is not a body this world contains (D-102)', async () => {
    const bot = await BotClient.connect(url());
    await account(bot, 'app_cheat');
    // Off-palette hair: legal JSON, illegal world. The schema catches this
    // one before the handler does, which is the belt to the handler's braces.
    bot.send({
      t: 'create_character',
      name: 'Gaudy Sim',
      appearanceSeed: 4,
      appearance: { hairColor: 0x00ff00 } as never,
    });
    const err = await bot.expect('error');
    expect(err.code).toMatch(/invalid_message|protocol_error/);
    bot.close();
  });

  it('is optional — a bot with no opinion looks exactly as it always did', async () => {
    const bot = await BotClient.connect(url());
    await account(bot, 'app_plain');
    bot.send({ t: 'create_character', name: 'Plain Jorrit', appearanceSeed: 777 });
    const created = await bot.expect('character_created');
    expect(created.character.appearance).toBeNull();
    bot.close();
  });
});

describe('levels arrive with the character, not with a level-up screen', () => {
  it('pays out the class progression as banked xp crosses each threshold', async () => {
    const bot = await BotClient.connect(url());
    await account(bot, 'lvl_physician');
    bot.send({
      t: 'create_character',
      name: 'Isolde Marr',
      appearanceSeed: 31,
      classId: 'physician',
      build: { attributes: {}, skills: { medicine: 40, insight: 20 }, feats: ['steady-hands'], spells: [] },
    });
    const id = (await bot.expect('character_created')).character.id;
    bot.send({ t: 'enter_world', characterId: id });
    await bot.expect('snapshot');
    const first = await bot.expect('status');
    expect(first.level).toBe(1);
    expect(first.skills.medicine).toBe(40);
    expect(first.feats).toEqual(['steady-hands']);

    // Bank enough for level five and come back — which is exactly what
    // surviving a handful of rounds does (D-524).
    //
    // Order matters: a disconnect flushes the live vitals cache, so writing
    // the xp before closing has it overwritten by the logout with a zero.
    bot.close();
    await sleep(200);
    await store.saveCharacterVitals(id, { xp: xpForLevel(5) });

    const again = await BotClient.connect(url());
    again.send({ t: 'login', username: 'lvl_physician', password: 'password-word' });
    await again.expect('auth_ok');
    again.send({ t: 'enter_world', characterId: id });
    await again.expect('snapshot');
    const status = await again.expect('status');
    expect(status.level).toBe(5);
    // The physician's table: medicine at two and five, and the kit at five.
    expect(status.skills.medicine).toBeGreaterThan(40);
    expect(status.feats).toContain('field-kit');
    expect(status.feats).toContain('steady-hands');
    // And the level has NOT bought hit points — that is the whole rule.
    expect(status.maxHp).toBe(first.maxHp);
    again.close();
  });

  it('opens a rite at the level its calling says, and not before', async () => {
    const bot = await BotClient.connect(url());
    await account(bot, 'lvl_vessel');
    // The vessel is legacy-locked, so give the account the point it needs.
    await store.addLegacyPoints((await store.getAccountByUsername('lvl_vessel'))!.id, 3);
    bot.send({
      t: 'create_character',
      name: 'Corrin Ash',
      appearanceSeed: 32,
      classId: 'vessel',
    });
    const id = (await bot.expect('character_created')).character.id;
    bot.send({ t: 'enter_world', characterId: id });
    await bot.expect('snapshot');
    const level1 = await bot.expect('status');
    expect(level1.abilities).toContain('plane-shift');
    expect(level1.abilities).not.toContain('speak-with-dead');
    bot.close();
    await sleep(200); // let the logout flush land before overwriting the xp
    await store.saveCharacterVitals(id, { xp: xpForLevel(3) });
    const again = await BotClient.connect(url());
    again.send({ t: 'login', username: 'lvl_vessel', password: 'password-word' });
    await again.expect('auth_ok');
    again.send({ t: 'enter_world', characterId: id });
    await again.expect('snapshot');
    const level3 = await again.expect('status');
    expect(level3.abilities).toContain('speak-with-dead');
    again.close();
  });
});
