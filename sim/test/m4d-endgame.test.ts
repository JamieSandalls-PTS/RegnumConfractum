import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadContent } from '@rc/server/content';
import { GameServer } from '@rc/server/net/gateway';
import { MemoryStore } from '@rc/server/store/memory';
import { BotClient } from '../src/botClient';

/**
 * D-206 endgame zones played by bots: the unmissable two-step entry warning,
 * the downed state (hp 0, no ghost, speech only), revival by another player,
 * and involuntary permadeath — no Legacy award, a corpse wearing everything,
 * the character gone for good.
 */

const contentDir = fileURLToPath(new URL('../../content', import.meta.url));
const TICK = 5;
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
let hero: BotClient; // walks in, falls, is saved, falls again, ends
let buddy: BotClient; // the other hand — and, this being Regnum, the blade
let heroChar: string;
let buddyChar: string;

async function join(bot: BotClient, username: string, charName: string, seed: number) {
  bot.send({ t: 'register', username, password: 'password-word' });
  await bot.expect('auth_ok');
  bot.send({ t: 'create_character', name: charName, appearanceSeed: seed });
  const characterId = (await bot.expect('character_created')).character.id;
  bot.send({ t: 'enter_world', characterId });
  const snap = await bot.expect('snapshot');
  return { characterId, entityId: snap.you };
}

/** Greedy-walks the bot's own entity to (x, y) in its current area. */
async function walkTo(bot: BotClient, x: number, y: number): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const me = bot.entities.get(bot.you!);
    if (!me) throw new Error('walker has no self');
    if (me.x === x && me.y === y) return;
    const dx = x - me.x;
    const dy = y - me.y;
    const dir = dy < 0 ? (dx > 0 ? 'ne' : dx < 0 ? 'nw' : 'n')
      : dy > 0 ? (dx > 0 ? 'se' : dx < 0 ? 'sw' : 's')
      : dx > 0 ? 'e' : 'w';
    bot.send({ t: 'move', dir });
    await sleep(TICK * 4);
  }
  throw new Error(`never reached (${x},${y})`);
}

/** Enters the crypt from the yard: warn on the marker, step off, step back. */
async function enterCrypt(bot: BotClient): Promise<void> {
  await walkTo(bot, 2, 28);
  const narrBefore = bot.narrations.length;
  bot.send({ t: 'move', dir: 's' }); // onto the marker (2,29)
  await waitUntil(
    () => bot.narrations.slice(narrBefore).some((n) => n.includes('FINAL DEATH')),
    'the warning sounds',
  );
  expect(bot.area?.id).toBe('broken-yard'); // warned, not moved
  await walkTo(bot, 2, 28); // step off
  bot.send({ t: 'move', dir: 's' }); // step back on: confirmed
  await waitUntil(() => bot.area?.id === 'sunken-crypt', 'the crypt swallows them');
}

async function attackUntilDowned(attacker: BotClient, victim: BotClient, targetId: number): Promise<void> {
  for (let i = 0; i < 60; i++) {
    if (victim.status?.hp === 0) return;
    attacker.send({ t: 'attack', targetEntityId: targetId });
    await sleep(TICK * 6);
  }
  throw new Error('victim never fell');
}

beforeAll(async () => {
  store = new MemoryStore();
  server = new GameServer({
    store,
    content: loadContent(contentDir),
    port: 0,
    tickIntervalMs: TICK,
    rngSeed: 41,
    defaultAreaId: 'broken-yard',
    ghostMinTicks: 300,
    attackCooldownTicks: 2,
    bleedIntervalTicks: 5000,
    corpseDecayTicks: 4000,
    groundLootTicks: 4000,
    zombieDurationTicks: 4000,
    reviveWindowTicks: 200, // 1s in test time
  });
  await server.start();
  const url = `ws://127.0.0.1:${server.port}`;
  hero = await BotClient.connect(url);
  buddy = await BotClient.connect(url);
  ({ characterId: heroChar } = await join(hero, 'hero_bot', 'Jori Lastlight', 701));
  ({ characterId: buddyChar } = await join(buddy, 'buddy_bot', 'Aldous Grim', 702));
  await store.grantItem(heroChar, 'iron-ore', 2);
});

afterAll(async () => {
  hero?.close();
  buddy?.close();
  await server.stop();
});

describe('the way down (D-206: unmissable warning)', () => {
  it('the first step warns and does not cross; the second step commits', async () => {
    await enterCrypt(hero);
    await enterCrypt(buddy);
    expect(hero.area?.id).toBe('sunken-crypt');
    expect(buddy.area?.id).toBe('sunken-crypt');
  });
});

describe('the downed state and the saving hand', () => {
  it('falling in the crypt downs you: no ghost, no acting, but last words work', async () => {
    // Endgame is open PvP — no declaration needed (D-206).
    await attackUntilDowned(buddy, hero, hero.you!);
    expect(hero.status!.hp).toBe(0);
    expect(hero.status!.ghost).toBe(false); // no grey country here
    await waitUntil(
      () => hero.narrations.some((n) => n.includes('bleeding out')),
      'the hero knows they are dying',
    );
    // Locked out of action, retirement included…
    hero.send({ t: 'move', dir: 'n' });
    await hero.expectError('dead');
    hero.send({ t: 'retire' });
    await hero.expectError('dead');
    // …but not out of speech.
    const heard = buddy.speeches.length;
    hero.send({ t: 'say', channel: 'say', text: 'Tell them it was quick.' });
    await waitUntil(
      () => buddy.speeches.slice(heard).some((s) => s.text.includes('it was quick')),
      'last words carry',
    );
  });

  it('a companion pulls you back inside the window', async () => {
    buddy.send({ t: 'revive', targetEntityId: hero.you! });
    await waitUntil(() => (hero.status?.hp ?? 0) > 0, 'the life catches');
    expect(hero.status!.hp).toBe(Math.ceil(hero.status!.maxHp / 4));
    expect(hero.status!.ghost).toBe(false);
    // Alive again: acting works.
    hero.send({ t: 'move', dir: 'e' });
    await sleep(TICK * 8);
    expect(hero.violations).toEqual([]);
  });
});

describe('the end that is an end (involuntary permadeath, no award)', () => {
  it('bleeding out unaided retires the character with nothing', async () => {
    const itemsBefore = await store.countItems();
    await attackUntilDowned(buddy, hero, hero.you!);
    // Nobody helps. The window is 200 ticks — one second here.
    const retired = await hero.expect('retired', 8000);
    expect(retired.awarded).toBe(0);
    const record = await store.getCharacter(heroChar);
    expect(record!.retired).toBe(true);
    // The living watched the end and see what remains, wearing the gear.
    await waitUntil(
      () => [...buddy.entities.values()].some((e) => e.kind === 'corpse'),
      'the corpse lies in the crypt',
    );
    const corpse = [...buddy.entities.values()].find((e) => e.kind === 'corpse')!;
    buddy.send({ t: 'loot', targetEntityId: corpse.id });
    await waitUntil(
      () => buddy.inventory.some((i) => i.templateId === 'iron-ore'),
      'the spoils change hands',
    );
    expect(await store.countItems()).toBe(itemsBefore);
    // The event log recorded an involuntary ending.
    const ev = (await store.listRecentEvents(30)).find(
      (e) => e.type === 'retired' && (e.data as { voluntary?: boolean }).voluntary === false,
    );
    expect(ev).toBeDefined();
    expect((ev!.data as { awarded?: number }).awarded).toBe(0);
  });

  it('the ended character can never be entered again', async () => {
    const revenant = await BotClient.connect(`ws://127.0.0.1:${server.port}`);
    revenant.send({ t: 'login', username: 'hero_bot', password: 'password-word' });
    const auth = await revenant.expect('auth_ok');
    // Retired characters vanish from the list entirely (D-510)…
    expect(auth.characters.find((c) => c.id === heroChar)).toBeUndefined();
    // …and cannot be entered by id.
    revenant.send({ t: 'enter_world', characterId: heroChar });
    await revenant.expectError('no_such_character');
    revenant.close();
  });

  it('no partition leaks, no violations', () => {
    expect(hero.violations).toEqual([]);
    expect(buddy.violations).toEqual([]);
  });
});
