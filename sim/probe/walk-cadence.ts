import { AreaSchema } from '@rc/shared';
import { BotClient } from '../src/botClient';

/**
 * Hold a direction the way the client does and watch the movement stream.
 *
 * The report is "the walk animation resets every 0.3 seconds", and 0.3s is
 * exactly one stride at the inherited walk speed. So the question is whether
 * `entity_moved` actually stops arriving at each stride boundary.
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const bot = await BotClient.connect('ws://127.0.0.1:8095');
const user = `cad${Date.now() % 1000000}`;
bot.send({ t: 'register', username: user, password: 'password-word' });
await bot.expect('auth_ok');
bot.send({
  t: 'create_character', name: `Cadence Pro${'abcdefghij'[Date.now() % 10]}`, appearanceSeed: 3,
  classId: 'man-at-arms', build: { attributes: {}, skills: {}, feats: [], spells: [] },
} as never);
const characterId = (await bot.expect('character_created')).character.id;
bot.send({ t: 'enter_world', characterId });
await bot.expect('snapshot');

const me = () => bot.entities.get(bot.you!)!;
const samples: { t: number; x: number; y: number }[] = [];
const t0 = Date.now();
let last = { x: me().x, y: me().y };

// ⚠ Pick a direction with ROOM first. The first run of this probe walked
// east into the tavern wall, stopped after 1.3m, and reported "movement
// stops" — which was true and had nothing to do with the cadence.
const DIRS = ['e', 'w', 'n', 's', 'ne', 'nw', 'se', 'sw'] as const;
let best: (typeof DIRS)[number] = 'e';
let bestRun = -1;
for (const d of DIRS) {
  const from = { x: me().x, y: me().y };
  for (let i = 0; i < 6; i++) {
    bot.send({ t: 'move', dir: d });
    await sleep(90);
  }
  const run = Math.hypot(me().x - from.x, me().y - from.y);
  if (run > bestRun) { bestRun = run; best = d; }
  bot.send({ t: 'move_stop' });
  await sleep(120);
}
console.log(`walking ${best} (clearest direction, ${bestRun.toFixed(2)}m in the trial)`);

// The client's own cadence: one `move` every 90ms while a key is held.
const send = setInterval(() => bot.send({ t: 'move', dir: best }), 90);
for (let i = 0; i < 120; i++) {
  const p = me();
  if (p.x !== last.x || p.y !== last.y) {
    samples.push({ t: Date.now() - t0, x: p.x, y: p.y });
    last = { x: p.x, y: p.y };
  }
  await sleep(10);
}
clearInterval(send);

console.log(`moved ${samples.length} times in ${Date.now() - t0}ms`);
let prev = 0;
const gaps: number[] = [];
for (const s of samples) {
  gaps.push(s.t - prev);
  prev = s.t;
}
const big = gaps.filter((g) => g > 150);
console.log('gaps >150ms:', big.length, big.slice(0, 12).map((g) => `${g}ms`).join(' '));
console.log('first 16 positions:', samples.slice(0, 16).map((s) => `${s.t}:${s.x.toFixed(2)}`).join(' '));
await bot.close();
process.exit(0);
