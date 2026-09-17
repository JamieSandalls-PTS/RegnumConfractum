import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadContent } from '@rc/server/content';
import { GameServer } from '@rc/server/net/gateway';
import { MemoryStore } from '@rc/server/store/memory';
import { BARE_LOOK, EquipStatsSchema, lookOf, type EquippedItem } from '@rc/shared';
import { BotClient } from '../src/botClient';
import { TICK as SIM_TICK, sleep } from '../src/testTick';

/**
 * Bodies, heaps, and the verbs for using what you are carrying (D-554).
 *
 * Five things the stakeholder found broken by playing, and each one is a
 * promise the world was quietly failing to keep: that killing something
 * leaves evidence, that a body worth robbing looks like one, that what you
 * wear can be seen, and that a bandage in your pack is a bandage you can use.
 */

const contentDir = fileURLToPath(new URL('../../content', import.meta.url));
const TICK = SIM_TICK; // see sim/src/testTick.ts (D-633)

let store: MemoryStore;
let server: GameServer;

beforeAll(async () => {
  store = new MemoryStore();
  server = new GameServer({
    store,
    content: loadContent(contentDir),
    port: 0,
    tickIntervalMs: TICK,
    rngSeed: 606,
    defaultAreaId: 'round-town',
    combatRoundTicks: 2,
  });
  await server.start();
});

afterAll(async () => {
  await server.stop();
});


interface Player {
  bot: BotClient;
  characterId: string;
  items: { id: string; templateId: string; qty: number; equipped: string | null }[];
}

async function waitUntil(check: () => boolean, what: string, ms = 6000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A legacy-locked calling (D-207) needs a life already given up. */
async function joinLocked(username: string, name: string, classId: string): Promise<Player> {
  const bot = await BotClient.connect(`ws://127.0.0.1:${server.port}`);
  bot.send({ t: 'register', username, password: 'password-word' });
  const auth = await bot.expect('auth_ok');
  await store.addLegacyPoints(auth.accountId, 5);
  bot.send({
    t: 'create_character',
    name,
    appearanceSeed: 4400 + username.length,
    classId,
    build: { attributes: {}, skills: {}, feats: [], spells: [] },
  } as never);
  const characterId = (await bot.expect('character_created')).character.id;
  bot.send({ t: 'enter_world', characterId });
  const snap = await bot.expect('snapshot');
  return { bot, characterId, items: snap.inventory };
}

async function join(username: string, name: string, classId: string): Promise<Player> {
  const bot = await BotClient.connect(`ws://127.0.0.1:${server.port}`);
  bot.send({ t: 'register', username, password: 'password-word' });
  await bot.expect('auth_ok');
  bot.send({
    t: 'create_character',
    name,
    appearanceSeed: 3300 + username.length,
    classId,
    build: { attributes: {}, skills: {}, feats: [], spells: [] },
  } as never);
  const characterId = (await bot.expect('character_created')).character.id;
  bot.send({ t: 'enter_world', characterId });
  const snap = await bot.expect('snapshot');
  return { bot, characterId, items: snap.inventory };
}

describe('what you are wearing is visible (D-554)', () => {
  /**
   * The silhouette is read off the SLOT and the stats, not off item ids, so a
   * new sword looks like a sword without being registered anywhere.
   */
  it('reads a harness, a robe and a blade out of a worn set', () => {
    const stats = (o: Parameters<typeof EquipStatsSchema.parse>[0]) => EquipStatsSchema.parse(o);
    const soldier: EquippedItem[] = [
      { slot: 'head', stats: stats({ slot: 'head', armour: 1, weight: 3 }) },
      { slot: 'chest', stats: stats({ slot: 'chest', armour: 4, weight: 12 }) },
      { slot: 'main-hand', stats: stats({ slot: 'main-hand', damage: 3 }) },
    ];
    const look = lookOf(soldier);
    expect(look.helm).toBe(true);
    expect(look.pauldrons).toBe(true);
    expect(look.weapon).toBe('sword');
    expect(look.robe).toBe(false);

    const magus: EquippedItem[] = [
      { slot: 'chest', stats: stats({ slot: 'chest', armour: 1, mana: 4, weight: 3 }) },
      { slot: 'main-hand', stats: stats({ slot: 'both-hands', damage: 2, mana: 6, weight: 4 }) },
    ];
    const robed = lookOf(magus);
    expect(robed.robe).toBe(true);
    expect(robed.pauldrons).toBe(false);
    expect(robed.weapon).toBe('staff');
  });

  it('leaves an empty set looking like the body underneath', () => {
    expect(lookOf([])).toEqual(BARE_LOOK);
  });

  /**
   * ⚠ The one thing this must never do. D-547 and D-539 both turn on gear
   * staying out of the recognition pipeline: a helm that changed what a
   * stranger was CALLED would be the permanent disguise creation refused.
   */
  it('never reaches the descriptor a stranger is known by', async () => {
    const a = await join('worn_seen', 'Ordric Mail', 'man-at-arms');
    const b = await join('worn_watcher', 'Quiet Watcher', 'physician');
    await sleep(300);
    const before = [...b.bot.entities.values()]
      .find((e) => e.kind === 'player' && e.id !== b.bot.you);
    expect(before, 'the watcher should see somebody').toBeDefined();
    expect(before!.worn).not.toBeNull();

    // Strip to the skin and put it all back on. The SILHOUETTE must change;
    // what the watcher CALLS them must not move an inch.
    //
    // (The descriptor may well mention a helm already — appearance seeds roll
    // one, and that has fed descriptors since D-201. What is forbidden is
    // EQUIPPING changing it, which is the disguise D-539 refused.)
    const worn = a.items.filter((i) => i.equipped !== null);
    expect(worn.length).toBeGreaterThan(0);
    for (const item of worn) a.bot.send({ t: 'unequip', itemId: item.id });
    await sleep(400);
    const stripped = [...b.bot.entities.values()].find((e) => e.id === before!.id)!;
    expect(stripped.descriptor).toBe(before!.descriptor);

    for (const item of worn) a.bot.send({ t: 'equip', itemId: item.id });
    await sleep(400);
    const redressed = [...b.bot.entities.values()].find((e) => e.id === before!.id)!;
    expect(redressed.descriptor).toBe(before!.descriptor);
    await a.bot.close();
    await b.bot.close();
  });

  it('shows the kit a calling walked in wearing', async () => {
    const p = await join('worn_kit', 'Brannoc Mail', 'man-at-arms');
    await sleep(200);
    const me = p.bot.entities.get(p.bot.you!)!;
    expect(me.worn).not.toBeNull();
    expect(me.worn!.helm).toBe(true);
    expect(me.worn!.weapon).toBe('sword');
    await p.bot.close();
  });
});

describe('a dead thing leaves a body, and the body holds what it carried (D-554)', () => {
  it('leaves a corpse where the roamer fell, instead of nothing at all', async () => {
    const p = await join('body_kill', 'Hunter Vale', 'man-at-arms');
    const me = p.bot.entities.get(p.bot.you!)!;
    // A roamer beside the player: spawned through the real path so it has a
    // kind, a loot table and an hp pool.
    const victim = server.spawnRoamerFor('round-town', { x: me.x + 1, y: me.y }, 'scavenger-dog');
    expect(victim).not.toBeNull();

    for (let i = 0; i < 40; i++) {
      p.bot.send({ t: 'attack', targetEntityId: victim! });
      await sleep(30);
      if (!p.bot.entities.has(victim!)) break;
    }
    await sleep(300);
    const corpse = [...p.bot.entities.values()].find((e) => e.kind === 'corpse');
    expect(corpse, 'a body should lie where it fell').toBeDefined();
    await p.bot.close();
  });

  /**
   * The rites reach for a person who was there. A dead dog has nothing to
   * say, and the refusal must be its own answer rather than 'beyond reach' —
   * one means "not a spirit", the other "a spirit you cannot get".
   */
  it('refuses Speak With Dead on something that was never a person', async () => {
    // The bonespeaker is legacy-locked (D-207); the harness buys the life.
    const p = await joinLocked('body_rite', 'Cass Vale', 'bonespeaker');
    const me = p.bot.entities.get(p.bot.you!)!;
    const victim = server.spawnRoamerFor('round-town', { x: me.x + 1, y: me.y }, 'scavenger-dog');
    for (let i = 0; i < 40; i++) {
      p.bot.send({ t: 'attack', targetEntityId: victim! });
      await sleep(30);
      if (!p.bot.entities.has(victim!)) break;
    }
    await sleep(300);
    const corpse = [...p.bot.entities.values()].find((e) => e.kind === 'corpse');
    expect(corpse).toBeDefined();
    p.bot.send({ t: 'speak_dead', targetEntityId: corpse!.id });
    const err = await p.bot.expect('error');
    expect(err.code).toBe('bad_target');
    expect(err.message).toContain('never a person');
    await p.bot.close();
  });
});

describe('using what you carry (D-554)', () => {
  it('eats a loaf through the same path the old verb used', async () => {
    const p = await join('use_bread', 'Hungry Vale', 'physician');
    await p.bot.expect('status');
    // Not hungry yet, so it refuses — and refusing BEFORE consuming is the
    // point: a loaf spent on a full stomach is a loaf gone.
    p.bot.send({ t: 'use_item', templateId: 'coarse-bread' } as never);
    const err = await p.bot.expect('error');
    expect(err.code).toBe('not_hungry');
    await p.bot.close();
  });

  it('refuses to bind a wound that is not there, without spending the linen', async () => {
    const p = await join('use_whole', 'Whole Vale', 'physician');
    await p.bot.expect('status');
    const before = p.items.filter((i) => i.templateId === 'bandage').length;
    p.bot.send({ t: 'use_item', templateId: 'bandage' } as never);
    const err = await p.bot.expect('error');
    expect(err.code).toBe('no_injury');
    const inv = await store.getItemsByCharacter(p.characterId);
    expect(inv.filter((i) => i.templateId === 'bandage').length).toBe(before);
    await p.bot.close();
  });

  it('binds a real wound, and spends the bandage doing it', async () => {
    const p = await join('use_hurt', 'Hurt Vale', 'physician');
    await p.bot.expect('status');
    const count = async (): Promise<number> =>
      (await store.getItemsByCharacter(p.characterId))
        .filter((i) => i.templateId === 'bandage')
        .reduce((n, i) => n + i.qty, 0);
    const before = await count();
    expect(before).toBeGreaterThan(0);
    // Wounded by hand: this test is about the bandage, not about combat.
    await server.adminSetHp(p.characterId, 5);
    await waitUntil(() => p.bot.status?.hp === 5, 'the wound lands');
    p.bot.send({ t: 'use_item', templateId: 'bandage' } as never);
    await waitUntil(() => (p.bot.status?.hp ?? 0) > 5, 'the bandage works');
    // Exactly one spent — not the stack.
    expect(await count()).toBe(before - 1);
    await p.bot.close();
  });

  it('refuses to use something that is not usable', async () => {
    const p = await join('use_sword', 'Blunt Vale', 'man-at-arms');
    await p.bot.expect('status');
    p.bot.send({ t: 'use_item', templateId: 'arming-sword' } as never);
    const err = await p.bot.expect('error');
    expect(err.code).toBe('not_food');
    await p.bot.close();
  });
});

describe('dropping (D-554)', () => {
  /**
   * A dropped thing is MOVED, never destroyed. The no-duplication and
   * no-creation invariants (D-114) are the reason this is a transfer with the
   * floor as the recipient rather than a delete.
   */
  it('puts it on the floor as a heap anybody could take', async () => {
    const p = await join('drop_one', 'Tidy Vale', 'physician');
    await p.bot.expect('status');
    const bread = p.items.find((i) => i.templateId === 'coarse-bread')!;
    const totalBefore = await store.countItems();

    p.bot.send({ t: 'drop_item', itemId: bread.id } as never);
    await p.bot.expect('inventory');
    await sleep(200);

    const mine = await store.getItemsByCharacter(p.characterId);
    expect(mine.some((i) => i.id === bread.id)).toBe(false);
    // Still exists — on the floor, not deleted.
    expect(await store.countItems()).toBe(totalBefore);
    const heap = [...p.bot.entities.values()].find((e) => e.kind === 'pile');
    expect(heap, 'a heap should be visible where it was dropped').toBeDefined();
    expect(heap!.lootable).toBe(true);
    await p.bot.close();
  });

  it('takes it back up again', async () => {
    const p = await join('drop_take', 'Second Vale', 'physician');
    await p.bot.expect('status');
    const bread = p.items.find((i) => i.templateId === 'coarse-bread')!;
    p.bot.send({ t: 'drop_item', itemId: bread.id } as never);
    await p.bot.expect('inventory');
    await sleep(200);
    const heap = [...p.bot.entities.values()].find((e) => e.kind === 'pile')!;
    p.bot.send({ t: 'loot', targetEntityId: heap.id });
    await p.bot.expect('inventory');
    const mine = await store.getItemsByCharacter(p.characterId);
    expect(mine.some((i) => i.templateId === 'coarse-bread')).toBe(true);
    await p.bot.close();
  });

  it('refuses to drop what somebody else is holding', async () => {
    const a = await join('drop_mine', 'Owner Vale', 'physician');
    const b = await join('drop_yours', 'Thief Vale', 'physician');
    const bread = a.items.find((i) => i.templateId === 'coarse-bread')!;
    b.bot.send({ t: 'drop_item', itemId: bread.id } as never);
    const err = await b.bot.expect('error');
    expect(err.code).toBe('no_such_item');
    await a.bot.close();
    await b.bot.close();
  });
});
