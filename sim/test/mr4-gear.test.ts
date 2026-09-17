import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadContent } from '@rc/server/content';
import { GameServer } from '@rc/server/net/gateway';
import { MemoryStore } from '@rc/server/store/memory';
import {
  ATTRIBUTE_BASE,
  DEFAULT_MAX_HP,
  MAX_LEVEL,
  advancementBudget,
  maxHpFor,
  resolveAttributes,
  xpForLevel,
} from '@rc/shared';
import { BotClient } from '../src/botClient';
import { TICK as SIM_TICK, sleep } from '../src/testTick';

/**
 * Attributes, gear and the level-up screen, end to end (D-546, D-547).
 *
 * What is worth testing HERE rather than in the pure modules is everything
 * the server decides: that a character walks in wearing the kit its calling
 * was authored with, that equipping is refused when it should be, that
 * attributes actually move the health the server clamps against, and — most
 * of all — that the level-up submission is validated by the server rather
 * than trusted. Every rejection below is a message a hostile client can send
 * by hand.
 */

const contentDir = fileURLToPath(new URL('../../content', import.meta.url));
const TICK = SIM_TICK; // see sim/src/testTick.ts (D-633)

/** Poll an async predicate until it holds, or say what we were waiting for. */
async function waitUntil(pred: () => Promise<boolean>, what: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await sleep(TICK * 4);
  }
  throw new Error(`timed out waiting until ${what}`);
}

let store: MemoryStore;
let server: GameServer;
let content: ReturnType<typeof loadContent>;

beforeAll(async () => {
  content = loadContent(contentDir);
  store = new MemoryStore();
  server = new GameServer({
    store,
    content,
    port: 0,
    tickIntervalMs: TICK,
    rngSeed: 77,
    defaultAreaId: 'hanged-ferryman',
  });
  await server.start();
});

afterAll(async () => {
  await server.stop();
});

interface Player {
  bot: BotClient;
  characterId: string;
  /**
   * The pack as it arrived in the snapshot. The kit is granted BEFORE the
   * snapshot is built (D-547), so this is where it shows up — there is no
   * separate `inventory` message on entering, and waiting for one would hang.
   */
  items: { id: string; templateId: string; qty: number; equipped: string | null }[];
  /** This player's own entity, so a test can tell itself from everybody else. */
  entityId: number;
}

async function player(
  username: string,
  name: string,
  classId: string,
  build?: Record<string, unknown>,
): Promise<Player> {
  const bot = await BotClient.connect(`ws://127.0.0.1:${server.port}`);
  bot.send({ t: 'register', username, password: 'password-word' });
  await bot.expect('auth_ok');
  bot.send({
    t: 'create_character',
    name,
    appearanceSeed: 900 + username.length,
    classId,
    build: {
      attributes: {},
      skills: {},
      feats: [],
      spells: [],
      ...build,
    },
  } as never);
  const characterId = (await bot.expect('character_created')).character.id;
  bot.send({ t: 'enter_world', characterId });
  const snap = await bot.expect('snapshot');
  return { bot, characterId, items: snap.inventory, entityId: snap.you };
}

describe('every calling walks in with a kit (D-547)', () => {
  it('hands the man-at-arms his mail and puts it on him', async () => {
    const p = await player('kit_maa', 'Ordric Vane', 'man-at-arms');
    const inv = { items: p.items };
    const worn = inv.items.filter((i) => i.equipped !== null);
    expect(worn.length).toBeGreaterThan(0);
    const templates = new Set(inv.items.map((i) => i.templateId));
    expect(templates.has('mail-hauberk')).toBe(true);
    expect(templates.has('arming-sword')).toBe(true);
    // Nobody starts hungry and unable to do anything about it (D-526).
    expect(templates.has('coarse-bread')).toBe(true);
    expect(inv.items.find((i) => i.templateId === 'mail-hauberk')!.equipped).toBe('chest');
    await p.bot.close();
  });

  /**
   * The kit is granted at most once per character per round, and tracked
   * rather than inferred from an empty pack — "holds nothing" is also true of
   * somebody who has just been robbed.
   */
  it('does not refill on re-entry', async () => {
    const p = await player('kit_once', 'Sella Kenn', 'shade');
    const before = p.items.length;
    expect(before).toBeGreaterThan(0);
    await p.bot.close();

    const again = await BotClient.connect(`ws://127.0.0.1:${server.port}`);
    again.send({ t: 'login', username: 'kit_once', password: 'password-word' });
    await again.expect('auth_ok');
    again.send({ t: 'enter_world', characterId: p.characterId });
    const second = await again.expect('snapshot');
    expect(second.inventory.length).toBe(before);
    await again.close();
  });

  /**
   * ⚠ The gap the "does not refill on re-entry" test above did NOT cover.
   *
   * That one reconnects to the SAME process, where an in-memory Set still
   * remembers. A real restart empties it, and the character was handed a
   * second kit — then a third — until two of them claimed the same equipment
   * slot and the login died on a constraint violation with "an error" as the
   * only symptom. A restart is a fresh gateway over the same store, which is
   * exactly what this builds.
   */
  it('⚠ does not refill after a SERVER RESTART', async () => {
    const p = await player('kit_restart', 'Corin Vale', 'man-at-arms');
    const before = p.items.length;
    expect(before).toBeGreaterThan(0);
    await p.bot.close();

    const restarted = new GameServer({
      store,
      content,
      port: 0,
      tickIntervalMs: TICK,
      rngSeed: 77,
      defaultAreaId: 'hanged-ferryman',
    });
    await restarted.start();
    try {
      const again = await BotClient.connect(`ws://127.0.0.1:${restarted.port}`);
      again.send({ t: 'login', username: 'kit_restart', password: 'password-word' });
      await again.expect('auth_ok');
      again.send({ t: 'enter_world', characterId: p.characterId });
      const second = await again.expect('snapshot');
      expect(second.inventory.length, 'a second kit was handed out').toBe(before);
      await again.close();
    } finally {
      await restarted.stop();
    }
  });

  it('gives the worn set real armour on the sheet', async () => {
    const p = await player('kit_armour', 'Brannoc Ill', 'man-at-arms');
    const status = await p.bot.expect('status');
    expect(status.loadout.armour).toBeGreaterThan(0);
    expect(status.loadout.damage).toBeGreaterThan(0);
    expect(status.loadout.weight).toBeGreaterThan(0);
    await p.bot.close();
  });
});

describe('attributes move the numbers the server clamps against (D-546)', () => {
  it('turns vigor into health', async () => {
    const p = await player('attr_vigor', 'Halda Roon', 'berserker', {
      attributes: { vigor: ATTRIBUTE_BASE + 10 },
    });
    const status = await p.bot.expect('status');
    expect(status.maxHp).toBe(maxHpFor(resolveAttributes({ vigor: ATTRIBUTE_BASE + 10 })));
    expect(status.maxHp).toBeGreaterThan(DEFAULT_MAX_HP);
    expect(status.attributes.vigor).toBe(ATTRIBUTE_BASE + 10);
    await p.bot.close();
  });

  it('turns will into a reserve that starts full', async () => {
    const p = await player('attr_will', 'Ysolt Vane', 'magus', {
      attributes: { will: ATTRIBUTE_BASE + 10 },
    });
    const status = await p.bot.expect('status');
    expect(status.maxMana).toBeGreaterThan(0);
    expect(status.mana).toBe(status.maxMana);
    await p.bot.close();
  });

  /**
   * D-102. The client's own check is a convenience; this is a build a hostile
   * client sends by hand.
   */
  it('refuses an overspent allocation', async () => {
    const bot = await BotClient.connect(`ws://127.0.0.1:${server.port}`);
    bot.send({ t: 'register', username: 'attr_cheat', password: 'password-word' });
    await bot.expect('auth_ok');
    bot.send({
      t: 'create_character',
      name: 'Greedy Marl',
      classId: 'berserker',
      build: { attributes: { strength: 20, vigor: 20 }, skills: {}, feats: [], spells: [] },
    } as never);
    const err = await bot.expect('error');
    expect(err.message).toContain('overspent');
    await bot.close();
  });

  it('reads a character with no allocation as the old character exactly', async () => {
    const p = await player('attr_none', 'Plain Adder', 'hunter');
    const status = await p.bot.expect('status');
    expect(status.attributes.strength).toBe(ATTRIBUTE_BASE);
    expect(status.maxHp).toBe(DEFAULT_MAX_HP);
    await p.bot.close();
  });
});

describe('the paperdoll (D-547)', () => {
  it('takes a thing off and puts it back on', async () => {
    const p = await player('gear_swap', 'Wren Halloway', 'physician');
    const apron = p.items.find((i) => i.templateId === 'physicians-apron')!;
    expect(apron.equipped).toBe('chest');

    p.bot.send({ t: 'unequip', itemId: apron.id });
    const off = await p.bot.expect('inventory');
    expect(off.items.find((i) => i.id === apron.id)!.equipped).toBeNull();

    p.bot.send({ t: 'equip', itemId: apron.id });
    const on = await p.bot.expect('inventory');
    expect(on.items.find((i) => i.id === apron.id)!.equipped).toBe('chest');
    await p.bot.close();
  });

  it('refuses to wear a loaf of bread', async () => {
    const p = await player('gear_bread', 'Corm Ashwell', 'cantor');
    const bread = p.items.find((i) => i.templateId === 'coarse-bread')!;
    p.bot.send({ t: 'equip', itemId: bread.id });
    const err = await p.bot.expect('error');
    expect(err.code).toBe('not_equippable');
    await p.bot.close();
  });

  it('refuses a helm on the feet', async () => {
    const p = await player('gear_slot', 'Alric Penn', 'hunter');
    const cap = p.items.find((i) => i.templateId === 'leather-cap')!;
    p.bot.send({ t: 'equip', itemId: cap.id, slot: 'feet' });
    const err = await p.bot.expect('error');
    expect(err.code).toBe('wrong_slot');
    await p.bot.close();
  });

  /**
   * The contradiction a two-hander creates has to be owned somewhere. The
   * hunter's bow fills both hands; equipping the dagger takes the main hand
   * and must therefore knock the bow off entirely rather than leaving it
   * half-held.
   */
  it('drops a two-hander when something claims a hand it was using', async () => {
    const p = await player('gear_2h', 'Nessa Croft', 'hunter');
    const bow = p.items.find((i) => i.templateId === 'hunting-bow')!;
    const dagger = p.items.find((i) => i.templateId === 'narrow-dagger')!;
    expect(bow.equipped).toBe('main-hand');

    p.bot.send({ t: 'equip', itemId: dagger.id, slot: 'main-hand' });
    const after = await p.bot.expect('inventory');
    expect(after.items.find((i) => i.id === dagger.id)!.equipped).toBe('main-hand');
    expect(after.items.find((i) => i.id === bow.id)!.equipped).toBeNull();
    await p.bot.close();
  });

  it('refuses to equip somebody else’s gear', async () => {
    const a = await player('gear_mine', 'Owner Vell', 'shade');
    const b = await player('gear_theirs', 'Thief Vell', 'shade');
    const dagger = a.items.find((i) => i.templateId === 'narrow-dagger')!;
    b.bot.send({ t: 'equip', itemId: dagger.id });
    const err = await b.bot.expect('error');
    expect(err.code).toBe('no_such_item');
    await a.bot.close();
    await b.bot.close();
  });
});

describe('the level-up screen is the server’s decision (D-546)', () => {
  /**
   * Level is derived from banked xp (D-538), so the only honest way to reach
   * one in a test is to bank the xp — which also exercises the path a real
   * character takes.
   */
  async function levelled(username: string, name: string, level: number): Promise<Player> {
    const p = await player(username, name, 'physician');
    p.bot.close();
    // The logout flush is QUEUED behind the socket close (D-106), so writing
    // the xp immediately has it overwritten with zero moments later — which
    // is how this test spent its first run asserting that a level-4
    // character was level 1. Write, then confirm it stuck.
    const target = xpForLevel(level);
    for (let attempt = 0; attempt < 40; attempt++) {
      await store.saveCharacterVitals(p.characterId, { xp: target });
      await new Promise((r) => setTimeout(r, 25));
      if ((await store.getCharacter(p.characterId))?.xp === target) break;
    }
    expect((await store.getCharacter(p.characterId))?.xp).toBe(target);

    const again = await BotClient.connect(`ws://127.0.0.1:${server.port}`);
    again.send({ t: 'login', username, password: 'password-word' });
    await again.expect('auth_ok');
    again.send({ t: 'enter_world', characterId: p.characterId });
    const snap = await again.expect('snapshot');
    return { bot: again, characterId: p.characterId, items: snap.inventory, entityId: snap.you };
  }

  it('offers exactly what the level is worth, and nothing before it', async () => {
    const p = await levelled('lvl_budget', 'Mercy Dunn', 4);
    const status = await p.bot.expect('status');
    expect(status.level).toBe(4);
    const expected = advancementBudget(4, false);
    expect(status.unspent.skillPoints).toBe(expected.skillPoints);
    expect(status.unspent.attributePoints).toBe(expected.attributePoints);
    expect(status.unspent.feats).toBe(expected.feats);
    await p.bot.close();
  });

  it('accepts a legal spend and reflects it on the sheet', async () => {
    const p = await levelled('lvl_spend', 'Ivo Dunn', 5);
    const before = await p.bot.expect('status');
    const budget = advancementBudget(5, false);
    p.bot.send({
      t: 'advance',
      advances: {
        attributes: { vigor: budget.attributePoints },
        skills: { medicine: budget.skillPoints },
        feats: [],
        spells: [],
      },
    } as never);
    const after = await p.bot.expect('status');
    expect(after.skills.medicine).toBe((before.skills.medicine ?? 0) + budget.skillPoints);
    expect(after.attributes.vigor).toBe(ATTRIBUTE_BASE + budget.attributePoints);
    // The health ceiling moved with the vigor that produced it.
    expect(after.maxHp).toBeGreaterThan(before.maxHp);
    expect(after.unspent.attributePoints).toBe(0);
    expect(after.unspent.skillPoints).toBe(0);
    await p.bot.close();
  });

  it('refuses to spend more than the level is worth', async () => {
    const p = await levelled('lvl_over', 'Greed Dunn', 3);
    await p.bot.expect('status');
    p.bot.send({
      t: 'advance',
      advances: { attributes: { strength: 99 }, skills: {}, feats: [], spells: [] },
    } as never);
    const err = await p.bot.expect('error');
    expect(err.code).toBe('illegal_advance');
    await p.bot.close();
  });

  /**
   * D-538's fence, and the reason it is worth a live test rather than a unit
   * one: `arms` is where raw combat power lives, and a level must never buy
   * it. Every character swings with what it bought at creation.
   */
  it('refuses to buy martial skill with a level', async () => {
    const p = await levelled('lvl_arms', 'Sharp Dunn', 6);
    await p.bot.expect('status');
    p.bot.send({
      t: 'advance',
      advances: { attributes: {}, skills: { arms: 10 }, feats: [], spells: [] },
    } as never);
    const err = await p.bot.expect('error');
    expect(err.code).toBe('illegal_advance');
    expect(err.message).toContain('creation');
    await p.bot.close();
  });

  it('refuses a feat the character has not reached', async () => {
    const p = await levelled('lvl_early', 'Hasty Dunn', 2);
    await p.bot.expect('status');
    const tooHigh = content.feats.find((f) => f.minLevel > 2);
    if (!tooHigh) return; // no levelled feats authored yet
    p.bot.send({
      t: 'advance',
      advances: { attributes: {}, skills: {}, feats: [tooHigh.id], spells: [] },
    } as never);
    const err = await p.bot.expect('error');
    expect(err.code).toBe('illegal_advance');
    await p.bot.close();
  });

  it('refuses spells on a calling that does not cast', async () => {
    const p = await levelled('lvl_nocast', 'Mundane Dunn', MAX_LEVEL);
    await p.bot.expect('status');
    const spell = content.spells[0]!;
    p.bot.send({
      t: 'advance',
      advances: { attributes: {}, skills: {}, feats: [], spells: [spell.id] },
    } as never);
    const err = await p.bot.expect('error');
    expect(err.code).toBe('illegal_advance');
    await p.bot.close();
  });

  /**
   * The submission is the WHOLE record, so a resend after a dropped
   * connection has to be harmless — which matters because the screen appears
   * exactly when a round is tearing its sockets down.
   */
  it('is idempotent under a resend', async () => {
    const p = await levelled('lvl_replay', 'Echo Dunn', 3);
    await p.bot.expect('status');
    const advances = { attributes: { vigor: 1 }, skills: {}, feats: [], spells: [] };
    p.bot.send({ t: 'advance', advances } as never);
    const first = await p.bot.expect('status');
    p.bot.send({ t: 'advance', advances } as never);
    const second = await p.bot.expect('status');
    expect(second.attributes.vigor).toBe(first.attributes.vigor);
    expect(second.unspent.attributePoints).toBe(first.unspent.attributePoints);
    await p.bot.close();
  });
});

/**
 * What a calling may wear and wield, enforced by the SERVER (D-566).
 *
 * ⚠ The gate is ACCESS, never power (D-207 → D-522). Refusing a magus plate
 * removes an option; nothing here makes anybody stronger, and a test that
 * ever asserts otherwise is asserting the thing D-303 forbids.
 */
describe('a calling cannot wear what it may not (D-566)', () => {
  it('refuses plate to a caster, and names the calling in the refusal', async () => {
    const p = await player('gate_magus', 'Ilsa Wender', 'magus');
    const hauberk = await store.grantItem(p.characterId, 'mail-hauberk', 1);
    p.bot.send({ t: 'equip', itemId: hauberk.id });
    const err = await p.bot.expect('error');
    expect(err.code).toBe('not_for_your_calling');
    expect(err.message).toMatch(/plate/);
    // ⚠ And it is still in the pack — refused, not confiscated.
    const held = await store.getItemsByCharacter(p.characterId);
    expect(held.find((i) => i.id === hauberk.id)?.equippedSlot ?? null).toBeNull();
    await p.bot.close();
  });

  it('refuses a greataxe to a caster, by the stance the ASSET declares', async () => {
    // The item carries no stance of its own: it points at an asset, and the
    // asset says `two-handed` (D-566). Repeating it on the item would be two
    // places to say one thing.
    const p = await player('gate_staff', 'Oren Bask', 'magus');
    const axe = await store.grantItem(p.characterId, 'notched-greataxe', 1);
    p.bot.send({ t: 'equip', itemId: axe.id });
    const err = await p.bot.expect('error');
    expect(err.code).toBe('not_for_your_calling');
    expect(err.message).toMatch(/two-handed/);
    await p.bot.close();
  });

  it('lets the unrestricted calling wear the same plate', async () => {
    // `man-at-arms` declares neither list, which under D-566 means
    // unrestricted — the property every class authored before the gate
    // existed relies on.
    const p = await player('gate_maa', 'Brannoc Vane', 'man-at-arms');
    const hauberk = await store.grantItem(p.characterId, 'mail-hauberk', 1);
    p.bot.send({ t: 'equip', itemId: hauberk.id });
    await waitUntil(async () => {
      const held = await store.getItemsByCharacter(p.characterId);
      return held.some((i) => i.id === hauberk.id && i.equippedSlot !== null);
    }, 'the hauberk goes on');
    await p.bot.close();
  });

  it('and every calling can equip its own kit', async () => {
    // The one mistake a first pass at gating makes. CI checks the content;
    // this checks the server agrees with CI.
    for (const [i, classId] of ['berserker', 'shade', 'physician'].entries()) {
      const p = await player(`gate_kit${i}`, `Kitted Aldre${'abc'[i]}`, classId);
      const held = await store.getItemsByCharacter(p.characterId);
      for (const item of held.filter((h) => h.equippedSlot !== null)) {
        p.bot.send({ t: 'equip', itemId: item.id });
      }
      await sleep(TICK * 20);
      expect(
        p.bot.errors.filter((e) => e.code === 'not_for_your_calling'),
        `${classId} cannot use its own kit`,
      ).toEqual([]);
      await p.bot.close();
    }
  });
});

/**
 * A garment reaches the people who can see you (D-570, D-571).
 *
 * ⚠ Asserted through a SECOND player's eyes, not through the wearer's own
 * inventory. What you are wearing is public — that is what wearing it means
 * (D-554) — and the renderer that re-assembles a body out of a garment's
 * slots reads the wire entity, not the pack. A test that only checked the
 * wearer's inventory would pass with the broadcast half missing entirely, and
 * the symptom in play is armour that everybody can see except the people
 * around you.
 */
describe('what a garment puts on the wire (D-571)', () => {
  it('names the garment to everyone who can see the wearer', async () => {
    const watcher = await player('gm_watch', 'Sela Quist', 'man-at-arms');
    const wearer = await player('gm_wear', 'Torvald Reik', 'man-at-arms');

    // Both are in the same area, so the watcher has the wearer as an entity.
    // ⚠ The WEARER, by id. This used to take "the first entity that is not
    // me", which was only ever the other player because the tavern happened to
    // be empty of anybody else — and the moment the Hanged Ferryman gained a
    // declared keeper (D-598) the watcher started watching him instead and
    // waited five seconds for a keeper to put on plate armour.
    let seen = 0;
    await waitUntil(async () => {
      const e = watcher.bot.entities.get(wearer.entityId);
      if (e) seen = e.id;
      return e !== undefined;
    }, 'the watcher sees the wearer');

    // ⚠ No equipping needed: `man-at-arms` walks in wearing the hauberk as
    // part of its kit (D-547), so this is the path the game actually takes
    // rather than one the test set up for itself.
    await waitUntil(
      async () => (watcher.bot.entities.get(seen)?.worn?.garments ?? []).includes('gothic-plate'),
      'the watcher sees the garment',
    );

    // ⚠ And the silhouette still arrives beside it. The two are for different
    // casts — the procedural one generates armour from the flags, the
    // imported one wears the actual mesh (D-571) — so losing either would
    // half-undress somebody on one of them and nothing would say so.
    const worn = watcher.bot.entities.get(seen)!.worn!;
    expect(worn.pauldrons).toBe(true);

    await watcher.bot.close();
    await wearer.bot.close();
  });

  it('takes the garment off again', async () => {
    // ⚠ The delta has to go BOTH ways. `entity_worn` is a delta rather than a
    // resync (D-554), so an unequip that published nothing would leave every
    // observer looking at plate that is back in the pack — and the wearer's
    // own client, which reads the same field, would agree with them.
    const watcher = await player('gm_watch2', 'Bran Holt', 'man-at-arms');
    const wearer = await player('gm_wear2', 'Alix Dorn', 'man-at-arms');
    // ⚠ The WEARER, by id. This used to take "the first entity that is not
    // me", which was only ever the other player because the tavern happened to
    // be empty of anybody else — and the moment the Hanged Ferryman gained a
    // declared keeper (D-598) the watcher started watching him instead and
    // waited five seconds for a keeper to put on plate armour.
    let seen = 0;
    await waitUntil(async () => {
      const e = watcher.bot.entities.get(wearer.entityId);
      if (e) seen = e.id;
      return e !== undefined;
    }, 'the watcher sees the wearer');

    await waitUntil(
      async () => (watcher.bot.entities.get(seen)?.worn?.garments ?? []).includes('gothic-plate'),
      'the garment is on to start with',
    );

    const held = await store.getItemsByCharacter(wearer.characterId);
    const hauberk = held.find((i) => i.templateId === 'mail-hauberk')!;
    wearer.bot.send({ t: 'unequip', itemId: hauberk.id });
    await waitUntil(
      async () => !(watcher.bot.entities.get(seen)?.worn?.garments ?? []).includes('gothic-plate'),
      'the garment comes off',
    );

    await watcher.bot.close();
    await wearer.bot.close();
  });

  it('lists nothing when what is worn names no garment', async () => {
    // Most gear names none — a sword points at an `art` asset instead, a ring
    // at neither — and an EMPTY list is the honest answer rather than a
    // placeholder the renderer would have to learn to ignore.
    //
    // ⚠ The hauberk comes off first, and that is the point of the test rather
    // than setup for it: a man-at-arms walks in wearing one, so asserting
    // against a fresh character would have been asserting that equipping a
    // sword does not REMOVE a garment — which is true, and not the question.
    const p = await player('gm_plain', 'Mira Lend', 'man-at-arms');
    const held = await store.getItemsByCharacter(p.characterId);
    for (const item of held.filter((i) => i.equippedSlot !== null)) {
      p.bot.send({ t: 'unequip', itemId: item.id });
    }
    await waitUntil(
      async () => (p.bot.entities.get(p.entityId)?.worn?.garments ?? []).length === 0,
      'everything is off',
    );

    const sword = held.find((i) => i.templateId === 'arming-sword')!;
    p.bot.send({ t: 'equip', itemId: sword.id });
    await waitUntil(async () => {
      const now = await store.getItemsByCharacter(p.characterId);
      return now.some((i) => i.id === sword.id && i.equippedSlot !== null);
    }, 'the sword goes in hand');
    await sleep(TICK * 10);

    const worn = p.bot.entities.get(p.entityId)?.worn;
    expect(worn?.garments ?? []).toEqual([]);
    // The sword is still SEEN — it is the silhouette that carries it, not a
    // garment, and losing that distinction is how a blade becomes invisible.
    expect(worn?.weapon).toBe('sword');
    await p.bot.close();
  });
});

/**
 * A character HAS a race, and the server decides whether it may (D-572).
 *
 * ⚠ `content/races/` has been authored since D-560 and curated in the creation
 * tool; until now nothing in the game had a field to put one in, so the
 * `races` list D-566 put on every calling could never fire and the authored
 * height ranges bounded nothing. These assert the join.
 */
describe('choosing a race (D-572)', () => {
  /** Create without the `player` helper, so the message can be malformed. */
  async function creating(username: string, msg: Record<string, unknown>) {
    const bot = await BotClient.connect(`ws://127.0.0.1:${server.port}`);
    bot.send({ t: 'register', username, password: 'password-word' });
    await bot.expect('auth_ok');
    bot.send({ t: 'create_character', ...msg } as never);
    return bot;
  }

  it('records the race and hands it back on the summary', async () => {
    const bot = await creating('race_ok', {
      name: 'Aerith Solene',
      appearanceSeed: 4242,
      raceId: 'elven',
    });
    const made = await bot.expect('character_created');
    expect(made.character.raceId).toBe('elven');
    // ⚠ And it is PERSISTED, not just echoed. A summary built from the
    // message rather than from the record would pass this test and lose the
    // race on the next login.
    const stored = await store.getCharacter(made.character.id);
    expect(stored?.raceId).toBe('elven');
    await bot.close();
  });

  it('still creates a character with no race at all', async () => {
    // Every bot does this, and so does every character made before D-572.
    const bot = await creating('race_none', { name: 'Plain Wick', appearanceSeed: 11 });
    const made = await bot.expect('character_created');
    expect(made.character.raceId).toBeUndefined();
    await bot.close();
  });

  it('refuses a race content does not have', async () => {
    const bot = await creating('race_bogus', {
      name: 'Grum Stonefist',
      appearanceSeed: 12,
      raceId: 'dwarven',
    });
    const err = await bot.expect('error');
    expect(err.message).toMatch(/no such race/);
    await bot.close();
  });

  it('refuses a height the race cannot be', async () => {
    // ⚠ The server's limit, not the UI's (D-102). `APPEARANCE_LIMITS` allows
    // 2.1m for anybody; the race is what says an elf is not that.
    const bot = await creating('race_tall', {
      name: 'Loft Vanser',
      appearanceSeed: 13,
      raceId: 'elven',
      appearance: { height: 2.05 },
    });
    const err = await bot.expect('error');
    expect(err.message).toMatch(/stands between/);
    await bot.close();
  });

  it('accepts a height the race can be', async () => {
    const bot = await creating('race_fine', {
      name: 'Serel Anwen',
      appearanceSeed: 14,
      raceId: 'elven',
      appearance: { height: 1.8 },
    });
    const made = await bot.expect('character_created');
    expect(made.character.raceId).toBe('elven');
    await bot.close();
  });
});

/**
 * The face a player chose, decided by the SERVER (D-574).
 *
 * ⚠ Curation is a rule, not a menu. `content/races/` says which parts each
 * race offers per slot (D-560); a hand-rolled client that could send any stem
 * in the pack would have made that decorative. These assert the server refuses
 * what the race does not offer — the creation screen's own filtering is
 * convenience (D-102).
 */
describe('choosing a face (D-574)', () => {
  async function creating(username: string, msg: Record<string, unknown>) {
    const bot = await BotClient.connect(`ws://127.0.0.1:${server.port}`);
    bot.send({ t: 'register', username, password: 'password-word' });
    await bot.expect('auth_ok');
    bot.send({ t: 'create_character', ...msg } as never);
    return bot;
  }

  it('records the chosen parts and hands them back', async () => {
    const bot = await creating('look_ok', {
      name: 'Faen Ilroth',
      appearanceSeed: 21,
      raceId: 'elven',
      look: { parts: { head: 'SK_Chr_Head_Male_00' }, skin: '#efe3d1' },
    });
    const made = await bot.expect('character_created');
    expect(made.character.look?.parts.head).toBe('SK_Chr_Head_Male_00');
    // ⚠ PERSISTED, not echoed. A summary built from the message would pass
    // this and lose the face on the next login.
    const stored = await store.getCharacter(made.character.id);
    expect(stored?.look?.skin).toBe('#efe3d1');
    await bot.close();
  });

  it('refuses a part the race does not offer', async () => {
    const bot = await creating('look_bogus', {
      name: 'Wrong Face',
      appearanceSeed: 22,
      raceId: 'elven',
      look: { parts: { head: 'SK_Chr_Head_Male_99' } },
    });
    const err = await bot.expect('error');
    expect(err.message).toMatch(/does not offer/);
    await bot.close();
  });

  it('refuses a face chosen with no race to have chosen it from', async () => {
    // ⚠ Not a smaller version of a valid look: there is nothing to check it
    // against, so accepting it would let a raceless character wear any part.
    const bot = await creating('look_raceless', {
      name: 'No Kin',
      appearanceSeed: 23,
      look: { parts: { head: 'SK_Chr_Head_Male_00' } },
    });
    const err = await bot.expect('error');
    expect(err.message).toMatch(/needs a race/);
    await bot.close();
  });

  it('refuses a skin the race does not have', async () => {
    const bot = await creating('look_skin', {
      name: 'Off Palette',
      appearanceSeed: 24,
      raceId: 'elven',
      look: { parts: {}, skin: '#00ff00' },
    });
    const err = await bot.expect('error');
    expect(err.message).toMatch(/does not have that skin/);
    await bot.close();
  });

  it('still creates a character with no face at all', async () => {
    // Every bot, and every character made before the face step.
    const bot = await creating('look_none', { name: 'Plain Kemp', appearanceSeed: 25 });
    const made = await bot.expect('character_created');
    expect(made.character.look).toBeNull();
    await bot.close();
  });
});

/**
 * What a character is HOLDING reaches the people watching (D-578).
 *
 * ⚠ Asserted through a second player's eyes, like the garment above. The
 * stance drives which clips everybody else's renderer plays, so a stance the
 * wearer knows and observers do not is a man who aims a bow while the room
 * watches him swing a sword.
 */
describe('what a stance puts on the wire (D-578)', () => {
  it('names the stance of the weapon actually in hand', async () => {
    const watcher = await player('st_watch', 'Ivo Marsh', 'man-at-arms');
    const wearer = await player('st_wear', 'Rolf Dane', 'man-at-arms');
    // ⚠ The WEARER, by id. This used to take "the first entity that is not
    // me", which was only ever the other player because the tavern happened to
    // be empty of anybody else — and the moment the Hanged Ferryman gained a
    // declared keeper (D-598) the watcher started watching him instead and
    // waited five seconds for a keeper to put on plate armour.
    let seen = 0;
    await waitUntil(async () => {
      const e = watcher.bot.entities.get(wearer.entityId);
      if (e) seen = e.id;
      return e !== undefined;
    }, 'the watcher sees the wearer');

    // The man-at-arms kit arms him with a sword, so this is the real path.
    await waitUntil(
      async () => watcher.bot.entities.get(seen)?.worn?.stance === 'one-handed',
      'the watcher sees a one-handed stance',
    );

    // ⚠ Swapping to a bow changes NO mesh — a bow and a sword are both `art`,
    // never garments — so this is the case that would be missed by anything
    // keyed off the silhouette. The stance must still change.
    const bow = await store.grantItem(wearer.characterId, 'hunting-bow', 1);
    wearer.bot.send({ t: 'equip', itemId: bow.id });
    await waitUntil(
      async () => watcher.bot.entities.get(seen)?.worn?.stance === 'bow',
      'the watcher sees the bow stance',
    );

    await watcher.bot.close();
    await wearer.bot.close();
  });

  it('says nothing for a character holding something with no art', async () => {
    // ⚠ Absent means empty-handed, which resolves to the RIG's own clips
    // (D-564) — `unarmed` is the base layer and never a stance. Defaulting
    // here instead would put a character holding a loaf into a guard.
    const p = await player('st_plain', 'Nell Ward', 'physician');
    const bread = await store.grantItem(p.characterId, 'ration-bread', 1);
    p.bot.send({ t: 'equip', itemId: bread.id });
    await sleep(TICK * 10);
    const me = p.bot.entities.get(p.entityId);
    expect(me?.worn?.stance).not.toBe('one-handed');
    await p.bot.close();
  });
});
