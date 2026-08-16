import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadContent } from '@rc/server/content';
import { GameServer } from '@rc/server/net/gateway';
import { PgStore } from '@rc/server/store/postgres';
import { BotClient } from '../src/botClient';

/**
 * The M0 definition of done (BUILD_PLAN): positions and inventories survive a
 * server restart, verified by tests rather than by someone watching. Requires
 * Postgres — set DATABASE_URL (locally: `npm run db:up`, see .env.example).
 * CI always runs this against a Postgres service container.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const contentDir = fileURLToPath(new URL('../../content', import.meta.url));

// Unique per-run names: usernames allow digits; character names are letters
// only, so digits are mapped to letters.
const runTag = Date.now().toString();
const letterTag = runTag.replace(/\d/g, (d) => 'abcdefghij'[Number(d)]!);

let store: PgStore;

describe.skipIf(!DATABASE_URL)('persistence across server restart (Postgres)', () => {
  beforeAll(async () => {
    store = new PgStore(DATABASE_URL!);
    await store.init();
  });

  afterAll(async () => {
    await store?.close();
  });

  it('a character walks, logs out, and survives a full server restart', async () => {
    const content = loadContent(contentDir);
    const serverOne = new GameServer({ store, content, port: 0, tickIntervalMs: 5 });
    await serverOne.start();

    // --- First life of the server -----------------------------------------
    const bot = await BotClient.connect(`ws://127.0.0.1:${serverOne.port}`);
    bot.send({ t: 'register', username: `wanderer_${runTag}`, password: 'a-long-password' });
    await bot.expect('auth_ok');
    bot.send({ t: 'create_character', name: `Wanderer ${letterTag}`, appearanceSeed: 7 });
    const characterId = (await bot.expect('character_created')).character.id;
    bot.send({ t: 'enter_world', characterId });
    const snap = await bot.expect('snapshot');
    const spawned = bot.entities.get(snap.you)!;
    const start = { x: spawned.x, y: spawned.y }; // copy — the mirror entity mutates

    for (let i = 0; i < 4; i++) {
      bot.send({ t: 'move', dir: 'e' });
      await bot.expectMoveTo(snap.you, { x: start.x + i + 1, y: start.y });
    }
    const finalPos = { x: start.x + 4, y: start.y };

    await store.grantItem(characterId, 'iron-ore', 3);
    await store.grantItem(characterId, 'tarnished-signet', 1);
    await store.grantCoin(characterId, 55);

    bot.close();
    await serverOne.stop();

    // --- Restart: a brand-new process-equivalent against the same DB ------
    const serverTwo = new GameServer({ store, content, port: 0, tickIntervalMs: 5 });
    await serverTwo.start();
    const botTwo = await BotClient.connect(`ws://127.0.0.1:${serverTwo.port}`);
    botTwo.send({ t: 'login', username: `wanderer_${runTag}`, password: 'a-long-password' });
    const auth = await botTwo.expect('auth_ok');
    expect(auth.characters.map((c) => c.id)).toContain(characterId);

    botTwo.send({ t: 'enter_world', characterId });
    const snapTwo = await botTwo.expect('snapshot');
    const revived = botTwo.entities.get(snapTwo.you)!;

    expect({ x: revived.x, y: revived.y }).toEqual(finalPos);
    expect(snapTwo.coin).toBe(55);
    expect(snapTwo.inventory.map((i) => [i.templateId, i.qty]).sort()).toEqual([
      ['iron-ore', 3],
      ['tarnished-signet', 1],
    ]);

    botTwo.close();
    await serverTwo.stop();
  });

  it('item transfer is atomic at the database level', async () => {
    const account = await store.createAccount(`atomic_${runTag}`, 'hash');
    if (account === 'username_taken') throw new Error('unreachable');
    const a = await store.createCharacter({
      accountId: account.id, name: `Atomic Alice ${letterTag}`, appearanceSeed: 1,
      areaId: 'broken-yard', x: 2, y: 2,
    });
    const b = await store.createCharacter({
      accountId: account.id, name: `Atomic Bob ${letterTag}`, appearanceSeed: 2,
      areaId: 'broken-yard', x: 2, y: 2,
    });
    if (typeof a === 'string' || typeof b === 'string') throw new Error('unreachable');

    const item = await store.grantItem(a.id, 'iron-ore', 1);
    // Two racing transfers of the same item: exactly one may win.
    const results = await Promise.all([
      store.transferItem(item.id, a.id, b.id),
      store.transferItem(item.id, a.id, b.id),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await store.getItemsByCharacter(b.id)).map((i) => i.id)).toEqual([item.id]);

    // Coin: overdraw rejected atomically, totals conserved.
    await store.grantCoin(a.id, 30);
    expect(await store.transferCoin(a.id, b.id, 40)).toBe(false);
    expect(await store.transferCoin(a.id, b.id, 30)).toBe(true);
    expect(await store.getCoin(a.id)).toBe(0);
    expect(await store.getCoin(b.id)).toBe(30);
  });

  it('identity knowledge survives in the database (D-219)', async () => {
    const account = await store.createAccount(`knower_${runTag}`, 'hash');
    if (account === 'username_taken') throw new Error('unreachable');
    const observer = await store.createCharacter({
      accountId: account.id, name: `Observer Ode ${letterTag}`, appearanceSeed: 5,
      areaId: 'broken-yard', x: 2, y: 2,
    });
    const subject = await store.createCharacter({
      accountId: account.id, name: `Subject Sil ${letterTag}`, appearanceSeed: 6,
      areaId: 'broken-yard', x: 2, y: 2,
    });
    if (typeof observer === 'string' || typeof subject === 'string') throw new Error('unreachable');

    await store.upsertKnowledge({
      observerCharacterId: observer.id,
      subjectCharacterId: subject.id,
      presentation: 'normal',
      knownName: 'The Grey Pilgrim',
      provenance: 'self_claimed',
      impression: 'rings_false',
    });
    const known = await store.getKnowledge(observer.id, [subject.id]);
    expect(known.get(subject.id)).toMatchObject({
      knownName: 'The Grey Pilgrim',
      provenance: 'self_claimed',
      impression: 'rings_false',
    });
    // Upsert replaces: a later, better-supported claim overwrites.
    await store.upsertKnowledge({
      observerCharacterId: observer.id,
      subjectCharacterId: subject.id,
      presentation: 'normal',
      knownName: `Subject Sil ${letterTag}`,
      provenance: 'verified',
      impression: null,
    });
    const after = await store.getKnowledge(observer.id, [subject.id]);
    expect(after.get(subject.id)).toMatchObject({
      knownName: `Subject Sil ${letterTag}`,
      provenance: 'verified',
      impression: null,
    });
  });

  it('the event log is append-only at the database level (D-106)', async () => {
    await store.appendEvent('tamper_probe', { runTag });
    await expect(
      store.query(`update event_log set type = 'tampered' where type = 'tamper_probe'`),
    ).rejects.toThrow(/append-only/);
    await expect(
      store.query(`delete from event_log where type = 'tamper_probe'`),
    ).rejects.toThrow(/append-only/);
  });
});
