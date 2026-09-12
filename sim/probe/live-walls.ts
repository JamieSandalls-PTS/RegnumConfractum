import { readFileSync } from 'node:fs';
import { AreaSchema, canStandAt, DIRECTIONS, DIRECTION_VECTORS } from '@rc/shared';
import { BotClient } from '../src/botClient';

/**
 * Walk a bot at a wall on the LIVE server (D-567).
 *
 * Not a test: a probe against whatever is actually running on :8095, because
 * "the server blocks in a fresh World" and "the server a player is connected
 * to blocks" are different claims and only one of them was checked.
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const bot = await BotClient.connect('ws://127.0.0.1:8095');
const user = `probe${Date.now() % 1000000}`;
const who = `Probe Wal${'abcdefghij'[Date.now() % 10]}`;
bot.send({ t: 'register', username: user, password: 'password-word' });
await bot.expect('auth_ok');
bot.send({
  t: 'create_character', name: who, appearanceSeed: 7,
  classId: 'man-at-arms', build: { attributes: {}, skills: {}, feats: [], spells: [] },
} as never);
let characterId: string;
try {
  characterId = (await bot.expect('character_created')).character.id;
} catch {
  console.log('create failed:', JSON.stringify(bot.errors.slice(-2)));
  process.exit(1);
}
bot.send({ t: 'enter_world', characterId });
const snap = await bot.expect('snapshot');
// ⚠ The area the bot is ACTUALLY in. The first version of this probe loaded
// broken-yard and measured a bot standing in the tavern against it, then
// reported the server letting people through walls. A diagnostic that lies is
// worse than none.
const area = AreaSchema.parse(
  JSON.parse(readFileSync(`content/areas/${snap.area.id}.json`, 'utf8')),
);
console.log('area          :', snap.area.id);
console.log('assets on wire:', snap.area.assets.length);

const me = () => bot.entities.get(bot.you!)!;
console.log('spawned at    :', me().x, me().y);

// The nearest tile a body cannot stand in.
let target: { x: number; y: number } | null = null;
for (let r = 1; r < 25 && !target; r++) {
  for (let dy = -r; dy <= r && !target; dy++) {
    for (let dx = -r; dx <= r && !target; dx++) {
      const p = { x: Math.round(me().x) + dx, y: Math.round(me().y) + dy };
      if (p.x < 1 || p.y < 1 || p.x >= area.width - 1 || p.y >= area.height - 1) continue;
      if (!canStandAt(area, p)) target = p;
    }
  }
}
console.log('walking at    :', target);

for (let i = 0; i < 120; i++) {
  const p = me();
  const dx = target!.x - p.x;
  const dy = target!.y - p.y;
  if (Math.hypot(dx, dy) < 0.1) break;
  let best = DIRECTIONS[0];
  let bestDot = -Infinity;
  for (const d of DIRECTIONS) {
    const v = DIRECTION_VECTORS[d];
    const dot = (dx * v.x + dy * v.y) / Math.hypot(v.x, v.y);
    if (dot > bestDot) { bestDot = dot; best = d; }
  }
  bot.send({ t: 'move', dir: best });
  await sleep(60);
}
const end = me();
console.log('ended at      :', end.x.toFixed(2), end.y.toFixed(2));
console.log('INSIDE A WALL :', !canStandAt(area, { x: end.x, y: end.y }));
await bot.close();
process.exit(0);
