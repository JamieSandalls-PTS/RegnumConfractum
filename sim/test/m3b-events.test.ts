import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadContent } from '@rc/server/content';
import { AdminServer } from '@rc/server/admin/http';
import { EventEngine } from '@rc/server/dm/events';
import { GameServer } from '@rc/server/net/gateway';
import { MemoryStore } from '@rc/server/store/memory';
import { BotClient } from '../src/botClient';
import { walkTo as pathWalkTo } from '../src/walk';

/**
 * M3b: the DM event system runs the milestone's canonical chain, built as a
 * document and driven entirely through the admin HTTP API:
 *
 *   announce + spawn a new location
 *   → 2 players inside → spawn the warband, darken the sky
 *   → warlord killed → reward   (armed; fires from M4 via entityDied)
 *
 * ...then rolls the whole thing back.
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
let engine: EventEngine;
let admin: AdminServer;
let alpha: BotClient;
let beta: BotClient;

async function api(path: string, payload?: Record<string, unknown>) {
  const res = await fetch(`http://127.0.0.1:${admin.port}${path}?token=${DM_TOKEN}`, {
    method: payload ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json' },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  return (await res.json()) as Record<string, unknown>;
}

async function join(bot: BotClient, username: string, charName: string, seed: number) {
  bot.send({ t: 'register', username, password: 'password-word' });
  await bot.expect('auth_ok');
  bot.send({ t: 'create_character', name: charName, appearanceSeed: seed });
  const characterId = (await bot.expect('character_created')).character.id;
  bot.send({ t: 'enter_world', characterId });
  await bot.expect('snapshot');
}

/**
 * Walks by A*, and stops the moment the area changes (D-544). This was a
 * greedy walker until the tavern was rebuilt at half size and scenery
 * arrived: pressing a direction wedges on the first barrel, and a walker that
 * keeps going after a transition marches across the next map.
 */
async function walkTo(bot: BotClient, x: number, y: number): Promise<void> {
  await pathWalkTo(bot, x, y, { stepMs: TICK * 4, timeoutMs: 15_000 });
}

/**
 * A walkable tile in the bot's current area with nothing on it — no prop, no
 * existing exit, not the spawn.
 *
 * The war-camp used to be linked at a hard-coded (33,53) in the tavern, which
 * stopped existing the moment the tavern was resized. Content is editable now
 * (there is a map editor), so a test that pins a coordinate in it is a test
 * that breaks whenever somebody moves a wall — and reports it as a timeout
 * rather than as "that tile is gone".
 */
function freeTile(bot: BotClient): { x: number; y: number } {
  const area = bot.area!;
  const taken = new Set([
    ...area.transitions.map((t) => `${t.x}:${t.y}`),
    ...area.assets.map((a) => `${Math.round(a.x)}:${Math.round(a.y)}`),
  ]);
  const me = bot.entities.get(bot.you!)!;
  let best: { x: number; y: number; d: number } | null = null;
  for (let y = 1; y < area.height - 1; y++) {
    for (let x = 1; x < area.width - 1; x++) {
      const ch = area.tiles[y]![x]!;
      if (!area.legend[ch]!.walkable) continue;
      if (taken.has(`${x}:${y}`)) continue;
      const d = Math.hypot(x - me.x, y - me.y);
      // Not right on top of the player: the test walks to it deliberately.
      if (d < 3) continue;
      if (!best || d < best.d) best = { x, y, d };
    }
  }
  if (!best) throw new Error('no free tile in ' + area.id);
  return { x: best.x, y: best.y };
}

const WARCAMP_DOC = {
  name: "The Warlord's Landing",
  stages: [
    {
      trigger: { type: 'immediate' },
      actions: [
        { type: 'narrate', scope: 'global', text: 'Riders speak of fires on the old yard road.' },
        {
          type: 'spawn_area',
          from: 'broken-yard',
          alias: 'warcamp',
          name: 'The War-Camp',
          link: { area: 'hanged-ferryman', x: 0, y: 0 },
        },
      ],
    },
    {
      trigger: { type: 'player_count', area: '$warcamp', count: 2 },
      actions: [
        { type: 'set_lighting', area: '$warcamp', lighting: 'night' },
        { type: 'spawn_npc', area: '$warcamp', x: 3, y: 2, descriptor: 'a scarred warlord in blacked mail', alias: 'warlord' },
        { type: 'spawn_npc', area: '$warcamp', x: 4, y: 2, descriptor: 'a gaunt raider' },
        { type: 'spawn_npc', area: '$warcamp', x: 2, y: 3, descriptor: 'a torch-bearing raider' },
        { type: 'npc_say', alias: 'warlord', text: '*points* Uninvited guests. How brave.' },
      ],
    },
    {
      trigger: { type: 'entity_death', alias: 'warlord' },
      actions: [
        { type: 'narrate', scope: 'global', text: 'A warlord has fallen at the old yard road.' },
      ],
    },
  ],
};

beforeAll(async () => {
  store = new MemoryStore();
  server = new GameServer({
    store,
    content: loadContent(contentDir),
    port: 0,
    tickIntervalMs: TICK,
    rngSeed: 9,
    defaultAreaId: 'hanged-ferryman',
  });
  await server.start();
  engine = new EventEngine(server, store, () => {});
  server.onTickHook = (tick) => void engine.tick(tick);
  admin = new AdminServer({ gameServer: server, store, events: engine, port: 0, token: DM_TOKEN });
  await admin.start();

  const url = `ws://127.0.0.1:${server.port}`;
  alpha = await BotClient.connect(url);
  beta = await BotClient.connect(url);
  await join(alpha, 'alpha_bot', 'Aldous Reeve', 401);
  await join(beta, 'beta_bot', 'Berta Swann', 402);
});

afterAll(async () => {
  alpha?.close();
  beta?.close();
  await admin.stop();
  await server.stop();
});

describe('the DM event chain (M3 done-when, D-216)', () => {
  let eventId: string;
  let runId: string;
  let warcampId: string;
  /** Chosen from the live map, not hard-coded (see `freeTile`). */
  let link: { x: number; y: number };

  it('the editor document validates and saves; garbage is refused', async () => {
    const bad = await api('/api/dm/events/create', { doc: { name: 'x', stages: [] } });
    expect(bad.ok).toBe(false);
    // The camp is linked to a tile that actually exists in whatever the
    // tavern currently is, rather than to a coordinate frozen when it was
    // twice the size.
    link = freeTile(alpha);
    const doc = structuredClone(WARCAMP_DOC);
    const spawnArea = doc.stages[0]!.actions.find((a) => a.type === 'spawn_area')!;
    (spawnArea as { link: { x: number; y: number } }).link.x = link.x;
    (spawnArea as { link: { x: number; y: number } }).link.y = link.y;
    const good = await api('/api/dm/events/create', { doc });
    expect(good.ok).toBe(true);
    eventId = good.id as string;
  });

  it('stage 1 fires on run: global announcement and a new location on the map', async () => {
    const r = await api('/api/dm/events/run', { id: eventId });
    expect(r.ok).toBe(true);
    runId = r.runId as string;
    warcampId = `ev-${runId.slice(0, 8)}-warcamp`;
    const heard = await alpha.expect('narrate', 3000);
    expect(heard.text).toContain('fires on the old yard road');
    // The host area re-snapshots with the new way-marker where the event
    // put it.
    await waitUntil(
      () => (alpha.area?.transitions ?? []).some((t) => t.x === link.x && t.y === link.y),
      'way-marker appears',
    );
  });

  it('two players entering the camp springs the ambush (chained player_count)', async () => {
    await walkTo(alpha, link.x, link.y);
    await waitUntil(() => alpha.area?.id === warcampId, 'alpha crosses into the camp');
    expect(alpha.area?.name).toBe('The War-Camp');
    // One player is not enough — the stage waits.
    await sleep(300);
    expect([...alpha.entities.values()].filter((e) => e.kind === 'npc')).toHaveLength(0);

    await walkTo(beta, link.x, link.y);
    await waitUntil(() => beta.area?.id === warcampId, 'beta crosses into the camp');
    await waitUntil(
      () => [...alpha.entities.values()].filter((e) => e.kind === 'npc').length === 3,
      'the warband appears',
    );
    const lighting = await alpha.expect('area_lighting', 3000);
    expect(lighting.lighting).toBe('night');
    await waitUntil(
      () => alpha.speeches.some((s) => s.speakerDescriptor.includes('warlord')),
      'the warlord speaks',
    );
  });

  it('the death stage stays armed — it fires from M4, not before', async () => {
    const runs = engine.listRuns();
    const run = runs.find((r) => r.runId === runId)!;
    expect(run.stageIndex).toBe(2);
    expect(run.done).toBe(false);
  });

  it('rollback evacuates the camp, despawns the warband, removes the area', async () => {
    const r = await api('/api/dm/events/rollback', { runId });
    expect(r.ok).toBe(true);
    await waitUntil(() => alpha.area?.id === 'hanged-ferryman', 'alpha evacuated');
    await waitUntil(() => beta.area?.id === 'hanged-ferryman', 'beta evacuated');
    expect([...alpha.entities.values()].filter((e) => e.kind === 'npc')).toHaveLength(0);
    alpha.drain('snapshot');
    alpha.send({ t: 'resync' });
    const snap = await alpha.expect('snapshot');
    expect(snap.area.transitions.some((t) => t.x === 33 && t.y === 53)).toBe(false);
  });

  it('rehearsal announces itself and rolls back cleanly', async () => {
    const r = await api('/api/dm/events/run', { id: eventId, rehearse: true });
    expect(r.ok).toBe(true);
    const heard = await alpha.expect('narrate', 3000);
    expect(heard.text).toContain('[rehearsal]');
    const rb = await api('/api/dm/events/rollback', { runId: r.runId as string });
    expect(rb.ok).toBe(true);
  });

  it('duplicate-as-template and delete round-trip', async () => {
    const list1 = await api('/api/dm/events');
    const count = (list1.events as unknown[]).length;
    const dup = await api('/api/dm/events/create', {
      doc: { ...WARCAMP_DOC, name: 'The Warlord Returns (copy)' },
    });
    expect(dup.ok).toBe(true);
    await api('/api/dm/events/delete', { id: dup.id });
    const list2 = await api('/api/dm/events');
    expect((list2.events as unknown[]).length).toBe(count);
  });
});
