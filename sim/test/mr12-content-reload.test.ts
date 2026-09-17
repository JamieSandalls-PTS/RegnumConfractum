import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadContent } from '@rc/server/content';
import { GameServer } from '@rc/server/net/gateway';
import { MemoryStore } from '@rc/server/store/memory';
import { BotClient } from '../src/botClient';

/**
 * A save reaches the running game (D-630).
 *
 * The production line ended one step short: the tool wrote a file, and the
 * game found out at the next restart, if somebody remembered. This is the
 * headless half of MR4's done-when — a definition that did not exist when a
 * player connected exists for them a moment later, with nobody reconnecting.
 *
 * ⚠ Judged by a VERB, not by a field. `reloadContent` returning "applied" is a
 * claim; a bot that was refused `use_item` on an unknown loaf and is then fed
 * by the same request is the proof that the swap reached the handler that
 * matters.
 */

const contentDir = fileURLToPath(new URL('../../content', import.meta.url));
const TICK = 5;

let store: MemoryStore;
let server: GameServer;
let bot: BotClient;
let characterId: string;

beforeAll(async () => {
  store = new MemoryStore();
  server = new GameServer({
    store,
    content: loadContent(contentDir),
    port: 0,
    tickIntervalMs: TICK,
    rngSeed: 7,
    watch: false,
  });
  await server.start();
  bot = await BotClient.connect(`ws://127.0.0.1:${server.port}`);
  bot.send({ t: 'register', username: 'reloader', password: 'password-word' });
  await bot.expect('auth_ok');
  bot.send({ t: 'create_character', name: 'Tam Reload', appearanceSeed: 9 });
  characterId = (await bot.expect('character_created')).character.id;
  bot.send({ t: 'enter_world', characterId });
  await bot.expect('snapshot');
});

afterAll(async () => {
  bot?.close();
  await server?.stop();
});

describe('content reload', () => {
  it('⚠ presentation content arrives on the wire before auth', async () => {
    // Sent the moment the socket opened, so it is already buffered.
    const rc = await bot.expect('render_content');
    expect(rc.animations.length).toBeGreaterThan(0);
    expect(rc.ground.length).toBeGreaterThan(0);
    expect(rc.grips.length).toBeGreaterThan(0);
    expect(rc.parts.length).toBeGreaterThan(0);
  });

  it('⚠ a template that did not exist at connect time feeds a player after a reload', async () => {
    // Before: the server has never heard of it, whatever the pack says.
    await store.grantItem(characterId, 'reload-loaf', 1);
    bot.send({ t: 'use_item', templateId: 'reload-loaf' });
    const refused = await bot.expectError('no_such_item');
    expect(refused.message).toBe('no such thing');

    // The "save": a new loaf, cut from the shipped bread.
    const next = loadContent(contentDir);
    const bread = next.itemTemplates.get('coarse-bread')!;
    next.itemTemplates.set('reload-loaf', { ...bread, id: 'reload-loaf', name: 'Reload Loaf' });

    const result = server.reloadContent(next);
    expect(result.applied).toContain('items');
    // Same areas and scripts, so nothing waits on a reset or a restart.
    expect(result.deferred).toEqual([]);

    // Everyone connected is told, so a client can drop its build caches.
    const told = await bot.expect('content_reloaded');
    expect(told.applied).toContain('items');
    // ...and the presentation content again, so open clients redraw from it.
    const again = await bot.expect('render_content');
    expect(again.animations.length).toBeGreaterThan(0);

    // After: the same request reaches the KITCHEN. A character fresh into
    // the world is sated, so the answer is "no appetite" — which is the food
    // rule speaking, two gates past "no such thing". The loaf exists.
    bot.send({ t: 'use_item', templateId: 'reload-loaf' });
    const known = await bot.expectError('not_hungry');
    expect(known.message).toBe('you have no appetite for it');
    expect(bot.violations).toEqual([]);
  });

  it('⚠ says what it could NOT apply, rather than claiming it did', () => {
    const next = loadContent(contentDir);
    const town = next.areas.get('round-town')!;
    next.areas.set('round-town', { ...town, name: 'Ashfold, renamed' });
    next.scripts.set('ashfold-keeper', `${next.scripts.get('ashfold-keeper')}\n-- edited`);
    const result = server.reloadContent(next);
    expect(result.deferred.join('\n')).toMatch(/areas: applied at the next round reset/);
    expect(result.deferred.join('\n')).toMatch(/scripts: restart the server/);
  });
});
