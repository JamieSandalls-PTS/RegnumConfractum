import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AreaDef } from '@rc/shared';
import { loadContent } from '@rc/server/content';
import { GameServer } from '@rc/server/net/gateway';
import { MemoryStore } from '@rc/server/store/memory';
import { BotClient } from '../src/botClient';
import { TICK_INTERVAL_MS } from '../src/testTick';

/**
 * The painted ground reaches a player (D-588).
 *
 * ⚠ D-585 built the painter, D-587 and D-588 made it a splat, and for three
 * decisions the wire carried NOTHING: the editor painted a floor the game had
 * no way to be told about. `buildPaintedGround` sat with no caller. This is
 * the half that closes it, and the assertions are about the PAIR — a mask
 * without its material list is six unlabelled numbers per texel, and the list
 * without the mask is a set of materials covering nothing.
 *
 * ⚠ The painted area is SYNTHESISED here rather than read from `content/`.
 * Pinning the test to whichever map somebody happened to paint makes it fail
 * the day they repaint it, and it would be testing the map rather than the
 * wire.
 */

const contentDir = fileURLToPath(new URL('../../content', import.meta.url));
const source = loadContent(contentDir).areas.get('proving-ground')!;

/**
 * ⚠ BOTH maps are synthesised, the bare one included. The first cut used
 * `proving-ground` itself as the unpainted case and failed the moment somebody
 * painted it — which is the point: what is painted in `content/` is a
 * decision somebody may remake any day, and a test that reads it is testing
 * the map rather than the wire. The two below differ in exactly one thing.
 */
const BARE: AreaDef = {
  ...source,
  id: 'unpainted-ground-test',
  groundPaint: undefined,
  groundMaterials: [],
  // Nothing may point into them, and they point nowhere — the reachability
  // rules are not what is under test.
  transitions: [],
};

const PAINTED: AreaDef = {
  ...BARE,
  id: 'painted-ground-test',
  groundPaint: ['painted-ground-test-0.png', 'painted-ground-test-1.png'],
  groundMaterials: ['grass', 'dirt', 'cobble', 'gravel', 'sand', 'mud'],
};

let store: MemoryStore;
let server: GameServer;

async function enter(bot: BotClient, username: string, name: string, areaId: string) {
  bot.send({ t: 'register', username, password: 'password-word' });
  await bot.expect('auth_ok');
  bot.send({ t: 'create_character', name, appearanceSeed: 4242 });
  const id = (await bot.expect('character_created')).character.id;
  await store.saveCharacterPosition(id, areaId, BARE.spawn.x, BARE.spawn.y);
  bot.send({ t: 'enter_world', characterId: id });
  return bot.expect('snapshot');
}

beforeAll(async () => {
  store = new MemoryStore();
  const content = loadContent(contentDir);
  content.areas.set(PAINTED.id, PAINTED);
  content.areas.set(BARE.id, BARE);
  server = new GameServer({
    store,
    content,
    port: 0,
    tickIntervalMs: TICK_INTERVAL_MS,
    rngSeed: 9,
    defaultAreaId: PAINTED.id,
  });
  await server.start();
});

afterAll(async () => {
  await server?.stop();
});

describe('a painted floor on the wire', () => {
  it('sends the masks and the material list together', async () => {
    const bot = await BotClient.connect(`ws://127.0.0.1:${server.port}`);
    const snap = await enter(bot, 'painter_one', 'Aldis Werrin', PAINTED.id);
    expect(snap.area.groundPaint).toEqual([
      'painted-ground-test-0.png',
      'painted-ground-test-1.png',
    ]);
    expect(snap.area.groundMaterials).toEqual([
      'grass', 'dirt', 'cobble', 'gravel', 'sand', 'mud',
    ]);
    bot.close();
  });

  it('names as many masks as its materials need, three to a mask', () => {
    // ⚠ The pairing is the whole contract. Two masks with six materials is
    // right; one mask with six loses the last three and renders a map that
    // looks finished, which is why `validate:content` refuses it too.
    const masks = PAINTED.groundPaint!.length;
    expect(Math.ceil(PAINTED.groundMaterials.length / 3)).toBe(masks);
  });

  it('sends an empty pair for an area nobody has painted', async () => {
    const bot = await BotClient.connect(`ws://127.0.0.1:${server.port}`);
    const snap = await enter(bot, 'painter_two', 'Reth Calloway', BARE.id);
    // ⚠ Empty, never absent — the client asks for a length, and the common
    // case is every map in the game.
    expect(snap.area.groundPaint).toEqual([]);
    expect(snap.area.groundMaterials).toEqual([]);
    bot.close();
  });

  it('changes NOTHING about where a body may stand', async () => {
    // ⚠ A ground material carries `walkable`, and the server does not read it
    // — where you may stand is the tile grid and the collision volumes
    // (D-542, D-584). If painting could re-cut a map, laying a patch of mud
    // would silently move a wall, and the person painting would have no way
    // to know. The two maps differ only in their paint.
    const a = await BotClient.connect(`ws://127.0.0.1:${server.port}`);
    const b = await BotClient.connect(`ws://127.0.0.1:${server.port}`);
    const painted = await enter(a, 'painter_three', 'Sabe Orrow', PAINTED.id);
    const bare = await enter(b, 'painter_four', 'Hest Dunmar', BARE.id);
    expect(painted.area.tiles).toEqual(bare.area.tiles);
    expect(painted.area.legend).toEqual(bare.area.legend);
    expect(painted.area.width).toBe(bare.area.width);
    expect(painted.area.height).toBe(bare.area.height);
    a.close();
    b.close();
  });
});
