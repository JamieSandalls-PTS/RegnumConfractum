import { loadConfig } from './config';
import { loadContent } from './content';
import { AdminServer } from './admin/http';
import { GameServer } from './net/gateway';
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
  log: (msg) => console.log(`[server] ${msg}`),
});
const adminServer = new AdminServer({
  gameServer,
  store,
  port: config.adminPort,
  host: config.adminHost,
  token: config.adminToken,
});

await gameServer.start();
await adminServer.start();
console.log(`[server] game ws://localhost:${gameServer.port}  admin http://localhost:${adminServer.port}`);
console.log(`[server] areas: ${[...content.areas.keys()].join(', ')}`);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} — flushing and stopping`);
  await gameServer.stop();
  await adminServer.stop();
  await store.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
