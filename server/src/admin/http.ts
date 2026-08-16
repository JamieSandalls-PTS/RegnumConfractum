import { createServer, type Server } from 'node:http';
import type { GameServer } from '../net/gateway';
import type { Store } from '../store/types';

/**
 * Admin inspection UI skeleton (D-114): lets the stakeholder see world state
 * without database access. Read-only. Grows into the moderation/DM surface in
 * later milestones.
 */

export interface AdminServerOptions {
  gameServer: GameServer;
  store: Store;
  port: number;
  /** When set, requests must carry it (?token= or X-Admin-Token). */
  token?: string;
  host?: string;
}

export class AdminServer {
  private server: Server | null = null;
  port = 0;

  constructor(private opts: AdminServerOptions) {}

  async start(): Promise<void> {
    const { gameServer, store, token } = this.opts;
    this.server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (token) {
          const provided = url.searchParams.get('token') ?? req.headers['x-admin-token'];
          if (provided !== token) {
            res.writeHead(403, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'forbidden' }));
            return;
          }
        }
        // ── DM console actions (D-216): POST, token-gated like everything here.
        if (req.method === 'POST' && url.pathname.startsWith('/api/dm/')) {
          const body = await readJsonBody(req);
          const result = await this.handleDmAction(url.pathname, body);
          res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json' });
          res.end(JSON.stringify(result));
          return;
        }
        if (url.pathname === '/api/state') {
          const world = gameServer.world;
          const state = {
            tick: world.tick,
            connections: gameServer.connectionCount(),
            areas: world.areaIds().map((areaId) => ({
              id: areaId,
              name: world.getAreaDef(areaId).name,
              entities: world.entitiesIn(areaId).map((e) => ({
                id: e.id,
                characterId: e.characterId,
                name: e.name,
                x: e.pos.x,
                y: e.pos.y,
                facing: e.facing,
              })),
            })),
          };
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(state));
        } else if (url.pathname === '/api/events') {
          const limit = Math.min(Number(url.searchParams.get('limit') ?? 100), 1000);
          const events = await store.listRecentEvents(limit);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(events));
        } else if (url.pathname === '/') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(PAGE);
        } else {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'not found' }));
        }
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
    });
    await new Promise<void>((resolve) =>
      this.server!.listen(this.opts.port, this.opts.host ?? '127.0.0.1', resolve),
    );
    const address = this.server.address();
    this.port = typeof address === 'object' && address ? address.port : this.opts.port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    this.server = null;
  }

  /** DM verbs (D-216): spawn, despawn, possess-speech, move, narrate,
   * lighting. Rehearsal mode and the form-based event editor are M3b. */
  private async handleDmAction(
    pathname: string,
    body: Record<string, unknown>,
  ): Promise<{ ok: boolean; [k: string]: unknown }> {
    const gs = this.opts.gameServer;
    try {
      switch (pathname) {
        case '/api/dm/spawn-npc': {
          const entityId = gs.spawnNpc(String(body.areaId), {
            x: Number(body.x),
            y: Number(body.y),
            descriptor: String(body.descriptor ?? 'a stranger'),
            ...(body.seed !== undefined ? { appearanceSeed: Number(body.seed) } : {}),
          });
          await this.opts.store.appendEvent('dm_spawn_npc', { entityId, ...body });
          return { ok: true, entityId };
        }
        case '/api/dm/despawn': {
          const ok = gs.despawnEntity(Number(body.entityId));
          if (ok) await this.opts.store.appendEvent('dm_despawn', { entityId: body.entityId });
          return { ok };
        }
        case '/api/dm/say': {
          const ok = await gs.speakAs(
            Number(body.entityId),
            String(body.text),
            (body.channel as 'say' | 'whisper' | 'shout') ?? 'say',
          );
          if (ok) await this.opts.store.appendEvent('dm_say', body);
          return { ok };
        }
        case '/api/dm/move': {
          gs.moveEntity(Number(body.entityId), body.dir as never);
          return { ok: true };
        }
        case '/api/dm/narrate': {
          const scope = body.scope === 'global' ? 'global' : 'area';
          gs.narrate(scope, String(body.text), body.areaId as string | undefined);
          await this.opts.store.appendEvent('dm_narrate', body);
          return { ok: true };
        }
        case '/api/dm/lighting': {
          gs.setAreaLighting(String(body.areaId), body.lighting as never);
          await this.opts.store.appendEvent('dm_lighting', body);
          return { ok: true };
        }
        default:
          return { ok: false, error: 'unknown dm action' };
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}

function readJsonBody(req: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 64 * 1024) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>Regnum Confractum — admin</title>
<style>
  body { font: 14px/1.5 system-ui, sans-serif; background: #17140f; color: #d8cdb8; margin: 2rem; }
  h1 { font-size: 1.1rem; color: #e8b25c; }
  table { border-collapse: collapse; margin: 0.5rem 0 1.5rem; }
  td, th { border: 1px solid #3a3427; padding: 0.25rem 0.75rem; text-align: left; }
  th { color: #e8b25c; font-weight: 600; }
  .muted { color: #7d7460; }
  pre { background: #100e0a; padding: 0.75rem; overflow-x: auto; }
  fieldset { border: 1px solid #3a3427; margin: 0 0 1rem; padding: 0.75rem; }
  legend { color: #e8b25c; font-size: 0.85rem; padding: 0 0.5rem; }
  input, select, button {
    background: #100e0a; color: #d8cdb8; border: 1px solid #3a3427;
    padding: 0.3rem 0.5rem; font: inherit; margin: 0.15rem 0.25rem 0.15rem 0;
  }
  button { cursor: pointer; }
  button:hover { border-color: #e8b25c; }
  #dm-result { color: #7d7460; font-size: 0.85rem; min-height: 1.2rem; }
</style>
<h1>Regnum Confractum — world state</h1>
<div id="meta" class="muted">connecting…</div>
<div id="areas"></div>

<h1>DM console</h1>
<div id="dm-result"></div>
<fieldset><legend>Spawn NPC</legend>
  <input id="sp-area" placeholder="areaId" size="16">
  <input id="sp-x" placeholder="x" size="3"> <input id="sp-y" placeholder="y" size="3">
  <input id="sp-desc" placeholder="descriptor (what players see)" size="34">
  <button onclick="dm('spawn-npc', {areaId: v('sp-area'), x: +v('sp-x'), y: +v('sp-y'), descriptor: v('sp-desc')})">Spawn</button>
</fieldset>
<fieldset><legend>Possess — speak as entity</legend>
  <input id="say-id" placeholder="entityId" size="6">
  <select id="say-ch"><option>say</option><option>whisper</option><option>shout</option></select>
  <input id="say-text" placeholder="words (asterisk emotes animate)" size="46">
  <button onclick="dm('say', {entityId: +v('say-id'), channel: v('say-ch'), text: v('say-text')})">Speak</button>
  <select id="mv-dir"><option>n</option><option>ne</option><option>e</option><option>se</option><option>s</option><option>sw</option><option>w</option><option>nw</option></select>
  <button onclick="dm('move', {entityId: +v('say-id'), dir: v('mv-dir')})">Step</button>
  <button onclick="dm('despawn', {entityId: +v('say-id')})">Despawn</button>
</fieldset>
<fieldset><legend>Narrate</legend>
  <select id="nar-scope"><option>area</option><option>global</option></select>
  <input id="nar-area" placeholder="areaId (for area scope)" size="16">
  <input id="nar-text" placeholder="scene text" size="46">
  <button onclick="dm('narrate', {scope: v('nar-scope'), areaId: v('nar-area'), text: v('nar-text')})">Narrate</button>
</fieldset>
<fieldset><legend>Lighting</legend>
  <input id="li-area" placeholder="areaId" size="16">
  <select id="li-prof"><option>overcast</option><option>night</option><option>underground</option><option>interior</option></select>
  <button onclick="dm('lighting', {areaId: v('li-area'), lighting: v('li-prof')})">Set</button>
</fieldset>

<h1>Recent events</h1>
<pre id="events">…</pre>
<script>
  const v = (id) => document.getElementById(id).value;
  async function dm(action, payload) {
    const r = await fetch('/api/dm/' + action + location.search, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const out = await r.json();
    document.getElementById('dm-result').textContent =
      action + ': ' + JSON.stringify(out);
    refresh();
  }
</script>
<script>
  const qs = location.search;
  async function refresh() {
    try {
      const state = await (await fetch('/api/state' + qs)).json();
      document.getElementById('meta').textContent =
        'tick ' + state.tick + ' · ' + state.connections + ' connection(s)';
      document.getElementById('areas').innerHTML = state.areas.map(a =>
        '<h2 style="font-size:1rem">' + a.name + ' <span class="muted">(' + a.id + ')</span></h2>' +
        (a.entities.length === 0 ? '<div class="muted">empty</div>' :
        '<table><tr><th>entity</th><th>name</th><th>pos</th><th>facing</th></tr>' +
        a.entities.map(e => '<tr><td>' + e.id + '</td><td>' + e.name + '</td><td>' +
          e.x + ',' + e.y + '</td><td>' + e.facing + '</td></tr>').join('') + '</table>')
      ).join('');
      const events = await (await fetch('/api/events' + qs)).json();
      document.getElementById('events').textContent =
        events.map(e => '#' + e.id + ' ' + e.type + ' ' + JSON.stringify(e.data)).join('\\n') || 'none';
    } catch (err) {
      document.getElementById('meta').textContent = 'error: ' + err;
    }
  }
  refresh();
  setInterval(refresh, 2000);
</script>`;
