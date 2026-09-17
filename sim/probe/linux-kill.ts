import { fileURLToPath } from 'node:url';
import { loadContent } from '@rc/server/content';
import { GameServer } from '@rc/server/net/gateway';
import { MemoryStore } from '@rc/server/store/memory';
import { BotClient } from '../src/botClient';

/**
 * Why does a fight never end on Linux (CI) when it ends on Windows?
 * Attack, and print every word the server says back.
 */
const contentDir = fileURLToPath(new URL('../../content', import.meta.url));
const TICK = Number(process.env.PROBE_TICK ?? 5);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const store = new MemoryStore();
const server = new GameServer({
  store,
  content: loadContent(contentDir),
  port: 0,
  tickIntervalMs: TICK,
  rngSeed: 11,
  defaultAreaId: 'round-town',
  attackCooldownTicks: 2,
  ghostMinTicks: 50,
  watch: true,
  round: {
    enabled: true,
    lengthTicks: 200_000,
    minCast: 1,
    seed: 'probe',
    graceTicks: 0,
    resolutionTicks: 10,
    objectives: [{
      id: 'probe-survive', name: 'Survive', brief: 'live', kind: { type: 'survive' as const },
      minCast: 1, maxCast: null, status: 'live' as const,
    }],
  },
});
await server.start();
const url = `ws://127.0.0.1:${server.port}`;
async function join(name: string, seed: number): Promise<BotClient> {
  const bot = await BotClient.connect(url);
  bot.send({ t: 'register', username: name, password: 'password-word' });
  await bot.expect('auth_ok');
  bot.send({ t: 'create_character', name: `${name} Probe`, appearanceSeed: seed });
  const id = (await bot.expect('character_created')).character.id;
  bot.send({ t: 'enter_world', characterId: id });
  await bot.expect('snapshot');
  return bot;
}
const a = await join('probea', 1);
const b = await join('probeb', 2);
for (let i = 0; i < 300 && a.roundState?.phase !== 'running'; i++) await sleep(TICK * 4);
console.log('phase', a.roundState?.phase);
const posOf = (bot: BotClient, id: number) => { const e = bot.entities.get(id); return e ? `${e.x.toFixed(2)},${e.y.toFixed(2)}` : 'unseen'; };
console.log('a at', posOf(a, a.you!), 'b at', posOf(a, b.you!), 'b hp', b.status?.hp, 'a reach', a.status?.reach);
const errors = new Map<string, number>();
const t0 = Date.now();
const tick0 = a.lastTick;
let swings = 0;
for (; swings < 400 && b.status?.ghost !== true; swings++) {
  a.drain('error');
  a.send({ t: 'attack', targetEntityId: b.you! });
  await sleep(TICK * 6);
  const err = await a.expect('error', 10).catch(() => null);
  if (err) errors.set(`${err.code}: ${err.message}`, (errors.get(`${err.code}: ${err.message}`) ?? 0) + 1);
  if (swings % 50 === 49) {
    console.log(`swing ${swings + 1}: ${Date.now() - t0}ms, ticks ${a.lastTick - tick0}, attacks ${a.attacks.length}, hits ${a.attacks.filter((x) => x.hit).length}, b hp ${b.status?.hp}`);
  }
}
console.log(`end after ${swings} swings: ${Date.now() - t0}ms, ticks ${a.lastTick - tick0}, b hp`, b.status?.hp, 'ghost', b.status?.ghost, 'attacks', a.attacks.length, 'hits', a.attacks.filter((x) => x.hit).length);
console.log('errors', [...errors.entries()]);
console.log('a hp', a.status?.hp, 'a narrations', a.narrations.slice(-4));
console.log('ticks per second', Math.round((a.lastTick - tick0) / ((Date.now() - t0) / 1000)));
console.log('a violations', a.violations.slice(0, 3), 'b violations', b.violations.slice(0, 3));
a.close(); b.close();
await server.stop();
