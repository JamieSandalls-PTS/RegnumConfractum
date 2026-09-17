import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadContent } from '@rc/server/content';
import { GameServer } from '@rc/server/net/gateway';
import { MemoryStore } from '@rc/server/store/memory';
import { computeLegacyAward } from '@rc/server/game/legacy';
import { BotClient } from '../src/botClient';
import { TICK as SIM_TICK, sleep } from '../src/testTick';

/**
 * Deleting a character from the roster (D-600).
 *
 * ⚠ Retirement existed and could only be reached by a character STANDING
 * somewhere: `handleRetire` refuses unless you are in the world. So the one
 * irreversible act in the game, and the only route to Legacy Points, was
 * unreachable from the screen where a player decides who to keep.
 *
 * ⚠ These assertions are about the parts that are easy to get subtly wrong
 * and impossible to undo: that the account is actually PAID, that the price
 * is shown before the click rather than discovered after it, and that a
 * character cannot be deleted out from under somebody playing them.
 */

const contentDir = fileURLToPath(new URL('../../content', import.meta.url));
const TICK = SIM_TICK; // see sim/src/testTick.ts (D-633)

let store: MemoryStore;
let server: GameServer;
const open: BotClient[] = [];

beforeEach(async () => {
  store = new MemoryStore();
  server = new GameServer({
    store,
    content: loadContent(contentDir),
    port: 0,
    tickIntervalMs: TICK,
    rngSeed: 3,
    defaultAreaId: 'hanged-ferryman',
  });
  await server.start();
});

afterEach(async () => {
  for (const b of open.splice(0)) b.close();
  await server?.stop();
});

async function account(username: string): Promise<BotClient> {
  const bot = await BotClient.connect(`ws://127.0.0.1:${server.port}`);
  open.push(bot);
  bot.send({ t: 'register', username, password: 'password-word' });
  await bot.expect('auth_ok');
  return bot;
}

async function makeCharacter(bot: BotClient, name: string): Promise<string> {
  bot.send({ t: 'create_character', name, appearanceSeed: 99 });
  return (await bot.expect('character_created')).character.id;
}

describe('a character can be ended from the roster', () => {
  it('prices every character on the roster before anybody clicks', async () => {
    const bot = await account('ros_price');
    await makeCharacter(bot, 'Alda Renn');
    // The roster arrives with a login, so this asks for one: creating a
    // character walks straight into the world and never shows the list.
    const again = await BotClient.connect(`ws://127.0.0.1:${server.port}`);
    open.push(again);
    again.send({ t: 'login', username: 'ros_price', password: 'password-word' });
    const list = await again.expect('auth_ok');
    expect(list.characters).toHaveLength(1);
    // ⚠ A real number, computed by the server. The formula has diminishing
    // returns on repeat sacrifice (D-207) and depends on how many this
    // account has already spent — which the client cannot know, so a client
    // that guessed would be quoting a price the server will not honour.
    expect(list.characters[0]!.legacyIfRetired).toBe(
      computeLegacyAward({ xp: 0, deeds: 0, priorRetirements: 0 }),
    );
    expect(list.characters[0]!.legacyIfRetired).toBeGreaterThan(0);
  });

  it('ends the character, pays the account, and sends the roster back', async () => {
    const bot = await account('ros_delete');
    const keep = await makeCharacter(bot, 'Bern Holt');
    const go = await makeCharacter(bot, 'Cass Vire');
    bot.send({ t: 'retire_character', characterId: go });

    const paid = await bot.expect('retired');
    expect(paid.awarded).toBeGreaterThan(0);
    expect(paid.totalLegacyPoints).toBe(paid.awarded);

    const list = await bot.expect('character_list');
    expect(list.characters.map((c) => c.id)).toEqual([keep]);
    expect(list.legacyPoints).toBe(paid.awarded);

    // ⚠ RETIRED, not deleted. The event log keeps what happened (D-106): a
    // character who killed somebody must not be made never to have existed by
    // the person who did it.
    const record = await store.getCharacter(go);
    expect(record).not.toBeNull();
    expect(record!.retired).toBe(true);
  });

  it('refuses a character who is in the world', async () => {
    const bot = await account('ros_online');
    const id = await makeCharacter(bot, 'Dorn Mel');
    bot.send({ t: 'enter_world', characterId: id });
    await bot.expect('snapshot');

    // A second connection on the same account is the case that matters: the
    // one holding the character is not the one asking.
    const other = await BotClient.connect(`ws://127.0.0.1:${server.port}`);
    open.push(other);
    other.send({ t: 'login', username: 'ros_online', password: 'password-word' });
    await other.expect('auth_ok');
    other.send({ t: 'retire_character', characterId: id });
    const err = await other.expect('error');
    expect(err.code).toBe('character_online');

    await sleep(TICK * 4);
    expect((await store.getCharacter(id))!.retired).toBe(false);
  });

  it('refuses somebody else’s character, and says nothing about it', async () => {
    const mine = await account('ros_mine');
    const theirs = await account('ros_theirs');
    const id = await makeCharacter(theirs, 'Eska Vane');
    mine.send({ t: 'retire_character', characterId: id });
    const err = await mine.expect('error');
    // ⚠ The same answer as "no such character". Telling an account that
    // somebody else's id is real is a way to enumerate characters.
    expect(err.code).toBe('no_such_character');
    expect((await store.getCharacter(id))!.retired).toBe(false);
  });

  it('pays LESS the second time, and the roster says so before the click', async () => {
    // The diminishing-returns half of D-207, asserted where a player meets it.
    const bot = await account('ros_twice');
    const first = await makeCharacter(bot, 'Fen Arden');
    await makeCharacter(bot, 'Gerd Ilm');
    bot.send({ t: 'retire_character', characterId: first });
    const paid = await bot.expect('retired');
    const list = await bot.expect('character_list');
    expect(list.characters[0]!.legacyIfRetired).toBeLessThanOrEqual(paid.awarded);
  });
});
