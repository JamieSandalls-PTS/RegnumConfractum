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
</style>
<h1>Regnum Confractum — world state</h1>
<div id="meta" class="muted">connecting…</div>
<div id="areas"></div>
<h1>Recent events</h1>
<pre id="events">…</pre>
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
