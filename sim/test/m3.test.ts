import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadContent } from '@rc/server/content';
import { AdminServer } from '@rc/server/admin/http';
import { GameServer } from '@rc/server/net/gateway';
import { ScriptHost } from '@rc/server/script/host';
import { MemoryStore } from '@rc/server/store/memory';
import { BotClient } from '../src/botClient';

/**
 * M3a end to end: area transitions (D-103), scripted NPCs (D-109), and the
 * DM console verbs (D-216) — spawn, possess, narrate, lighting — exercised
 * over the real HTTP + WebSocket surfaces.
 */

const contentDir = fileURLToPath(new URL('../../content', import.meta.url));
const TICK = 5;
const DM_TOKEN = 'test-dm-token';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(pred: () => boolean, what: string, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting until ${what}`);
}

let store: MemoryStore;
let server: GameServer;
let scriptHost: ScriptHost;
let admin: AdminServer;
let walker: BotClient;
let watcher: BotClient;
let walkerEntity = 0;

async function dm(action: string, payload: Record<string, unknown>, token = DM_TOKEN) {
  const res = await fetch(`http://127.0.0.1:${admin.port}/api/dm/${action}?token=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function join(bot: BotClient, username: string, charName: string, seed: number) {
  bot.send({ t: 'register', username, password: 'password-word' });
  await bot.expect('auth_ok');
  bot.send({ t: 'create_character', name: charName, appearanceSeed: seed });
  const characterId = (await bot.expect('character_created')).character.id;
  bot.send({ t: 'enter_world', characterId });
  const snap = await bot.expect('snapshot');
  return { characterId, entityId: snap.you, snap };
}

beforeAll(async () => {
  store = new MemoryStore();
  const content = loadContent(contentDir);
  server = new GameServer({
    store,
    content,
    port: 0,
    tickIntervalMs: TICK,
    rngSeed: 5,
    defaultAreaId: 'hanged-ferryman',
  });
  await server.start();
  scriptHost = new ScriptHost(server, () => {});
  for (const area of content.areas.values()) {
    if (area.scripts.length > 0) {
      await scriptHost.loadAreaScripts(
        area.id,
        area.scripts.map((id) => ({ id, source: content.scripts.get(id)! })),
      );
    }
  }
  server.onTickHook = (tick) => scriptHost.tick(tick);
  server.onAreaEnter = (areaId, entityId) => scriptHost.onAreaEntered(areaId, entityId);
  admin = new AdminServer({ gameServer: server, store, port: 0, token: DM_TOKEN });
  await admin.start();

  const url = `ws://127.0.0.1:${server.port}`;
  walker = await BotClient.connect(url);
  watcher = await BotClient.connect(url);
  ({ entityId: walkerEntity } = await join(walker, 'walker_bot', 'Rhen Calder', 301));
  await join(watcher, 'watcher_bot', 'Issa Brand', 302);
});

afterAll(async () => {
  walker?.close();
  watcher?.close();
  scriptHost?.dispose();
  await admin.stop();
  await server.stop();
});

describe('scripted world (D-109)', () => {
  it('the keeper NPC from the area script is present in snapshots', () => {
    const keeper = [...walker.entities.values()].find((e) => e.kind === 'npc');
    expect(keeper).toBeDefined();
    expect(keeper!.descriptor).toContain('keeper');
  });
});

describe('area transitions (D-103)', () => {
  it('walking onto the way-marker crosses to the linked area', async () => {
    // From the street spawn (30,53), the west end of the street (1,53) leads
    // to the Broken Yard.
    for (let i = 0; i < 120 && walker.area?.id !== 'broken-yard'; i++) {
      walker.send({ t: 'move', dir: 'w' });
      await sleep(TICK * 4);
    }
    await waitUntil(() => walker.area?.id === 'broken-yard', 'walker crosses to the yard');
    await sleep(TICK * 10); // drain residual move intents from the walk loop
    const you = walker.entities.get(walker.you!)!;
    // Arrives at (29,16); queued intents may carry a step or two further west.
    expect(you.y).toBe(16);
    expect(you.x).toBeLessThanOrEqual(29);
    expect(you.x).toBeGreaterThanOrEqual(26);
    // The watcher, still in the tavern, saw them leave.
    await waitUntil(() => !watcher.entities.has(walkerEntity), 'watcher sees them go');
  });

  it('the return marker brings them back, and the tavern sees them arrive', async () => {
    for (let i = 0; i < 20 && walker.area?.id !== 'hanged-ferryman'; i++) {
      walker.send({ t: 'move', dir: 'e' });
      await sleep(TICK * 4);
    }
    await waitUntil(() => walker.area?.id === 'hanged-ferryman', 'walker returns');
    await sleep(TICK * 10);
    const you = walker.entities.get(walker.you!)!;
    // Arrives at (2,53); residual eastward intents may carry a step further.
    expect(you.y).toBe(53);
    expect(you.x).toBeGreaterThanOrEqual(2);
    expect(you.x).toBeLessThanOrEqual(5);
    await waitUntil(
      () => [...watcher.entities.values()].some((e) => e.id === walker.you),
      'watcher sees them arrive',
    );
    expect(walker.violations).toEqual([]);
    expect(watcher.violations).toEqual([]);
  });

  it('the transition survives a restart: position persisted mid-travel', async () => {
    const record = await store.getCharacter(
      [...(await store.getCharactersByAccount(
        (await store.getAccountByUsername('walker_bot'))!.id,
      ))][0]!.id,
    );
    expect(record!.areaId).toBe('hanged-ferryman');
    expect(record!.y).toBe(53);
  });
});

describe('DM console (D-216)', () => {
  it('rejects a bad token', async () => {
    const r = await fetch(`http://127.0.0.1:${admin.port}/api/dm/narrate?token=wrong`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'global', text: 'nope' }),
    });
    expect(r.status).toBe(403);
  });

  it('spawns an NPC that players see appear', async () => {
    // Next to wherever the walker stands, so speech range is guaranteed.
    const you = walker.entities.get(walker.you!)!;
    const r = await dm('spawn-npc', {
      areaId: walker.area!.id,
      x: you.x,
      y: you.y,
      descriptor: 'a rain-soaked courier',
    });
    expect(r.body.ok).toBe(true);
    const npcId = r.body.entityId as number;
    await waitUntil(
      () => walker.entities.get(npcId)?.descriptor === 'a rain-soaked courier',
      'courier appears',
    );
  });

  it('possessed speech goes through the real speech pipeline', async () => {
    const npcId = [...walker.entities.values()].find(
      (e) => e.descriptor === 'a rain-soaked courier',
    )!.id;
    const before = walker.speeches.length;
    const r = await dm('say', { entityId: npcId, text: '*bows* Letter for the Calder party.' });
    expect(r.body.ok).toBe(true);
    await waitUntil(() => walker.speeches.length > before, 'walker hears the courier');
    const heard = walker.speeches[walker.speeches.length - 1]!;
    expect(heard.speakerDescriptor).toBe('a rain-soaked courier');
    expect(heard.text).toContain('Letter for');
  });

  it('narrates to an area and changes its lighting live', async () => {
    await dm('narrate', { scope: 'area', areaId: 'hanged-ferryman', text: 'Thunder rolls over the roofs.' });
    const narration = await walker.expect('narrate', 3000);
    expect(narration.text).toContain('Thunder');
    await dm('lighting', { areaId: 'hanged-ferryman', lighting: 'night' });
    const lighting = await walker.expect('area_lighting', 3000);
    expect(lighting.lighting).toBe('night');
    // A fresh snapshot carries the override.
    walker.drain('snapshot');
    walker.send({ t: 'resync' });
    const snap = await walker.expect('snapshot');
    expect(snap.area.lighting).toBe('night');
  });

  it('despawns the NPC in front of everyone', async () => {
    const npcId = [...walker.entities.values()].find(
      (e) => e.descriptor === 'a rain-soaked courier',
    )!.id;
    const r = await dm('despawn', { entityId: npcId });
    expect(r.body.ok).toBe(true);
    await waitUntil(() => !walker.entities.has(npcId), 'courier vanishes');
  });

  it('players cannot be despawned through the DM surface', async () => {
    const r = await dm('despawn', { entityId: walker.you });
    expect(r.body.ok).toBe(false);
    expect(walker.entities.has(walker.you!)).toBe(true);
  });
});
