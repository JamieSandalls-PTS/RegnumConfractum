import { loadConfig } from './config';
import { loadContent } from './content';
import { AdminServer } from './admin/http';
import { EventEngine } from './dm/events';
import { GameServer } from './net/gateway';
import { ScriptHost } from './script/host';
import { PgStore } from './store/postgres';

const config = loadConfig();
if (!config.databaseUrl) {
  console.error('DATABASE_URL is not set. Start the dev database with `npm run db:up` and see .env.example.');
  process.exit(1);
}

const content = loadContent(config.contentDir);
const store = new PgStore(config.databaseUrl);
const gameServer = new GameServer({
  store,
  content,
  port: config.port,
  defaultAreaId: config.defaultAreaId,
  log: (msg) => console.log(`[server] ${msg}`),
});
// DM event engine (D-216): interprets editor-authored event documents.
const eventEngine = new EventEngine(gameServer, store, (msg) => console.log(`[events] ${msg}`));
const adminServer = new AdminServer({
  gameServer,
  store,
  events: eventEngine,
  port: config.adminPort,
  host: config.adminHost,
  token: config.adminToken,
});

await gameServer.start();

// Sandboxed Lua (D-109): area scripts run behind the controlled API only.
const scriptHost = new ScriptHost(gameServer, (msg) => console.log(`[lua] ${msg}`));
for (const area of content.areas.values()) {
  if (area.scripts.length > 0) {
    await scriptHost.loadAreaScripts(
      area.id,
      area.scripts.map((id) => ({ id, source: content.scripts.get(id)! })),
    );
  }
}
gameServer.onTickHook = (tick) => {
  scriptHost.tick(tick);
  void eventEngine.tick(tick);
};
gameServer.onAreaEnter = (areaId, entityId) => scriptHost.onAreaEntered(areaId, entityId);

await adminServer.start();
console.log(`[server] game ws://localhost:${gameServer.port}  admin http://localhost:${adminServer.port}`);
console.log(`[server] areas: ${[...content.areas.keys()].join(', ')}`);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} — flushing and stopping`);
  scriptHost.dispose();
  await gameServer.stop();
  await adminServer.stop();
  await store.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
