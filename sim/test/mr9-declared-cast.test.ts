import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadContent } from '@rc/server/content';
import { GameServer } from '@rc/server/net/gateway';
import { MemoryStore } from '@rc/server/store/memory';
import { ScriptHost } from '@rc/server/script/host';
import { BotClient } from '../src/botClient';
import { TICK as SIM_TICK, sleep } from '../src/testTick';

/**
 * A person who stands somewhere is CONTENT (D-598).
 *
 * ⚠ Until now an NPC could only be born inside a Lua script. That made every
 * question about the world's cast a question about source code: `kill_npc`
 * objectives were checked against descriptors scraped out of Lua with a
 * regular expression and could only be half-checked (D-569); nothing could
 * list who was in the world; and putting anybody anywhere meant writing a
 * script. The split here is the one facilities already use — the DEFINITION is
 * content, the PLACEMENT is map data, and what they DO is still a script.
 *
 * ⚠ The assertions that matter are the two nobody would write by reading the
 * code: that a declared person is standing there with nothing hosting scripts
 * at all, and that a round which killed them does not delete them from the
 * next round. The second is the one `silence-the-keeper` depends on: the
 * engine deals it at random, so an antagonist who won it once would otherwise
 * have removed the objective for everybody until the server restarted.
 */

const contentDir = fileURLToPath(new URL('../../content', import.meta.url));
const TICK = SIM_TICK; // see sim/src/testTick.ts (D-633)
const KEEPER = 'a rawboned keeper in a stained apron';

let server: GameServer | undefined;
let host: ScriptHost | undefined;
let bot: BotClient | undefined;

afterEach(async () => {
  bot?.close();
  host?.dispose();
  await server?.stop();
  bot = undefined;
  host = undefined;
  server = undefined;
});

async function boot(opts: { scripts: boolean }): Promise<BotClient> {
  const content = loadContent(contentDir);
  server = new GameServer({
    store: new MemoryStore(),
    content,
    port: 0,
    tickIntervalMs: TICK,
    rngSeed: 7,
    defaultAreaId: 'round-town',
  });
  await server.start();
  if (opts.scripts) {
    host = new ScriptHost(server, () => {});
    for (const area of content.areas.values()) {
      if (area.scripts.length > 0) {
        await host.loadAreaScripts(
          area.id,
          area.scripts.map((id) => ({ id, source: content.scripts.get(id)! })),
        );
      }
    }
    server.onTickHook = (tick) => host!.tick(tick);
    server.onAreaEnter = (areaId, entityId) => host!.onAreaEntered(areaId, entityId);
  }
  const client = await BotClient.connect(`ws://127.0.0.1:${server.port}`);
  client.send({ t: 'register', username: `cast_${Date.now() % 100000}`, password: 'password-word' });
  await client.expect('auth_ok');
  client.send({ t: 'create_character', name: 'Mera Cowl', appearanceSeed: 55 });
  const id = (await client.expect('character_created')).character.id;
  client.send({ t: 'enter_world', characterId: id });
  await client.expect('snapshot');
  bot = client;
  return client;
}

describe('the cast is declared, not scripted', () => {
  it('stands somebody there with NO script host running at all', async () => {
    // ⚠ The load-bearing one. Every earlier NPC test had to start a ScriptHost
    // because the NPC did not exist until Lua created it. If this passes, who
    // is in the world no longer depends on anything executing.
    const client = await boot({ scripts: false });
    const keeper = [...client.entities.values()].find((e) => e.descriptor === KEEPER);
    expect(keeper).toBeDefined();
    expect(keeper!.kind).toBe('npc');
    // And he arrives wearing the look his definition names (D-596).
    expect(keeper!.model).toBe('ashfold-townsfolk');
  });

  it('is reachable from a script by id, and it is the same person', async () => {
    const client = await boot({ scripts: true });
    const wearing = [...client.entities.values()].filter((e) => e.descriptor === KEEPER);
    // ⚠ Exactly ONE. The script used to spawn him and now looks him up; if the
    // migration had left both paths in, this would be two keepers standing in
    // each other, which reads on screen as one keeper and plays as an
    // objective that completes when you kill either.
    expect(wearing).toHaveLength(1);
  });

  it('puts them back after a round that killed them', async () => {
    const client = await boot({ scripts: false });
    const keeper = [...client.entities.values()].find((e) => e.descriptor === KEEPER)!;
    // Remove him the way a death does, then run the spawner as a round start
    // does. A round is not allowed to be the reason the next round has no
    // keeper.
    expect(server!.despawnEntity(keeper.id)).toBe(true);
    await sleep(TICK * 4);
    expect([...client.entities.values()].some((e) => e.descriptor === KEEPER)).toBe(false);
    (server as unknown as { syncDeclaredNpcs: () => void }).syncDeclaredNpcs();
    await sleep(TICK * 4);
    const back = [...client.entities.values()].filter((e) => e.descriptor === KEEPER);
    expect(back).toHaveLength(1);
    expect(back[0]!.id).not.toBe(keeper.id);
  });

  it('does not spawn a second one when it runs again', async () => {
    // Idempotence stated as a test, because it is called from two places and
    // "runs at every round start" is only safe while this holds.
    const client = await boot({ scripts: false });
    const sync = (server as unknown as { syncDeclaredNpcs: () => void }).syncDeclaredNpcs
      .bind(server);
    sync();
    sync();
    await sleep(TICK * 4);
    expect([...client.entities.values()].filter((e) => e.descriptor === KEEPER)).toHaveLength(1);
  });

  it('REFUSES to start when an area places somebody nothing declares', () => {
    const content = loadContent(contentDir);
    const town = content.areas.get('round-town')!;
    content.areas.set('round-town', {
      ...town,
      npcs: [...(town.npcs ?? []), { x: 24, y: 21, type: 'nobody-at-all' }],
    });
    // ⚠ At CONSTRUCTION. Left to spawn time it would fail when that area first
    // loads, which for the round map is the moment somebody starts a round.
    expect(() => new GameServer({
      store: new MemoryStore(),
      content,
      port: 0,
      tickIntervalMs: TICK,
      rngSeed: 7,
      defaultAreaId: 'round-town',
    })).toThrow(/nobody-at-all/);
  });
});
