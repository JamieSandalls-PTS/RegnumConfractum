import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadContent } from '@rc/server/content';
import { GameServer } from '@rc/server/net/gateway';
import { MemoryStore } from '@rc/server/store/memory';
import { ScriptHost } from '@rc/server/script/host';
import { BotClient } from '../src/botClient';

/**
 * A scripted NPC is drawn as what its script says (D-596).
 *
 * ⚠ D-594 gave ROAMERS a look and left NPCs where they were: `spawn_npc` took
 * a position, a descriptor and a seed, so the tavern keeper — the target of
 * `silence-the-keeper`, which D-526 calls the low-cast workhorse — was drawn
 * as whatever the seed happened to produce. The cast is asked to keep one
 * particular man alive and he looked like a different stranger on every fresh
 * seed, while eleven authored characters sat in `content/characters/` that no
 * server had ever loaded.
 *
 * ⚠ The load-bearing assertion is the LIVE one. That a roamer names a
 * character is a fact about a JSON file and is already covered; that a
 * scripted NPC arrives on the wire carrying `model` is the join between the
 * Lua, the gateway and `toWireEntity`, and every one of those was a place the
 * field could be dropped in silence.
 */

const contentDir = fileURLToPath(new URL('../../content', import.meta.url));
const TICK = 5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let store: MemoryStore;
let server: GameServer;
let host: ScriptHost;
let bot: BotClient;

async function waitFor<T>(get: () => T | undefined, what: string, ms = 15_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const got = get();
    if (got !== undefined) return got;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

beforeAll(async () => {
  store = new MemoryStore();
  const content = loadContent(contentDir);
  server = new GameServer({
    store,
    content,
    port: 0,
    tickIntervalMs: TICK,
    rngSeed: 41,
    defaultAreaId: 'round-town',
  });
  await server.start();
  // Scripts do not run unless something hosts them: the real server does, the
  // sim harness does not, so a headless area has no scripted NPCs in it at all
  // unless a test says so.
  host = new ScriptHost(server, () => {});
  for (const area of content.areas.values()) {
    if (area.scripts.length > 0) {
      await host.loadAreaScripts(
        area.id,
        area.scripts.map((id) => ({ id, source: content.scripts.get(id)! })),
      );
    }
  }
  server.onTickHook = (tick) => host.tick(tick);
  server.onAreaEnter = (areaId, entityId) => host.onAreaEntered(areaId, entityId);

  bot = await BotClient.connect(`ws://127.0.0.1:${server.port}`);
  bot.send({ t: 'register', username: 'look_watch', password: 'password-word' });
  await bot.expect('auth_ok');
  bot.send({ t: 'create_character', name: 'Ilsa Bren', appearanceSeed: 903 });
  const id = (await bot.expect('character_created')).character.id;
  bot.send({ t: 'enter_world', characterId: id });
  await bot.expect('snapshot');
});

afterAll(async () => {
  bot?.close();
  host?.dispose();
  await server?.stop();
});

describe('the keeper has a face, and it is the same face every round', () => {
  it('arrives on the wire carrying the character its script names', async () => {
    // ⚠ Found by DESCRIPTOR, not by "the first npc carrying a model". The
    // watch now names a character too, so the loose version would pass on a
    // guard and say nothing whatever about the keeper.
    const keeper = await waitFor(
      () => [...bot.entities.values()].find(
        (e) => e.kind === 'npc' && e.descriptor === 'a rawboned keeper in a stained apron',
      ),
      'the keeper spawned by the area script',
    );
    // The id, not merely "something truthy". A model field carrying the
    // descriptor, or the area id, or the entity id would satisfy a loose
    // assertion and draw nothing.
    expect(keeper.model).toBe('ashfold-townsfolk');
    // ⚠ And the descriptor is UNTOUCHED. What a player is told they are
    // looking at is the objective's match key (D-593); a look is an extra
    // layer on top of it and must never become the name.
    expect(keeper.descriptor).toBe('a rawboned keeper in a stained apron');
  });

  it('names a character the server has actually loaded', () => {
    const content = loadContent(contentDir);
    // ⚠ This is the assertion D-576 earned. `content/characters/` was read by
    // the build and by all three authoring tools and by no server, which is
    // exactly how 720 authored part names reached no player. A look on the
    // wire that the server cannot resolve is the same failure one directory
    // later.
    expect(content.characters.has('ashfold-townsfolk')).toBe(true);
    expect(content.characters.size).toBeGreaterThan(0);
  });

  it('REFUSES a character the content cannot resolve, by name', () => {
    // ⚠ Refused rather than passed through. An unresolvable model is not a
    // fault the renderer can report — it falls back to the appearance seed and
    // draws a perfectly plausible stranger, so a typo would leave the keeper
    // standing at the door as somebody else with nothing in any log.
    expect(() =>
      server.spawnNpc('round-town', {
        x: 25,
        y: 19,
        descriptor: 'a man who does not exist',
        character: 'ashfold-townsfok',
      }),
    ).toThrow(/ashfold-townsfok/);
  });

  it('still lets an NPC be drawn from its seed, which is the common case', async () => {
    // The field is optional on purpose: almost every scripted NPC should go on
    // being a stranger. A spawn with no character must carry no model, or the
    // gateway would be inventing an appearance nobody authored.
    //
    // Asserted off the WIRE rather than off the entity, because the wire is
    // where it matters and `toWireEntity` is one of the places the field can
    // be dropped.
    const id = server.spawnNpc('round-town', {
      x: 25,
      y: 18,
      descriptor: 'somebody passing through',
    });
    const seen = await waitFor(() => bot.entities.get(id), 'the seed-drawn NPC');
    expect(seen.descriptor).toBe('somebody passing through');
    expect(seen.model).toBeUndefined();
  });
});
