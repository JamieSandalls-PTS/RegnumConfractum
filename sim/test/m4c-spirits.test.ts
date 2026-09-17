import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadContent } from '@rc/server/content';
import { GameServer } from '@rc/server/net/gateway';
import { MemoryStore } from '@rc/server/store/memory';
import { BotClient } from '../src/botClient';

/**
 * M4b spirit interactions played by bots (D-204, D-224, D-511): corpses as
 * world objects with zone-dependent gear rules, looting, Speak With Dead with
 * its distinct beyond-reach result, Animate Dead with the skill-scaled cap,
 * riding the body, gear dropping when the zombie falls, and decay/cleanup.
 * Item conservation is asserted throughout — the corpse is the first non-
 * character item owner, exactly where a duplication bug would hide.
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

async function join(
  bot: BotClient,
  username: string,
  charName: string,
  seed: number,
  opts: { classId?: string; store?: MemoryStore; legacyPoints?: number } = {},
) {
  bot.send({ t: 'register', username, password: 'password-word' });
  const auth = await bot.expect('auth_ok');
  if (opts.legacyPoints && opts.store) {
    await opts.store.addLegacyPoints(auth.accountId, opts.legacyPoints);
  }
  bot.send({
    t: 'create_character',
    name: charName,
    appearanceSeed: seed,
    ...(opts.classId ? { classId: opts.classId } : {}),
  });
  const characterId = (await bot.expect('character_created')).character.id;
  bot.send({ t: 'enter_world', characterId });
  const snap = await bot.expect('snapshot');
  return { characterId, entityId: snap.you, accountId: auth.accountId };
}

async function attackUntilDead(attacker: BotClient, targetId: number): Promise<void> {
  // ⚠ Generous, because a blow can MISS now (D-606). Combat used to be a
  // flat 2-6 that always landed, so a fixed handful of swings was certain
  // to kill; a d20 against Armour Class lands rather over half the time,
  // and a run of bad rolls is a normal thing rather than a broken server.
  // This budget is the number of SWINGS, not of seconds: the spacing is
  // the combat round's (D-550), and the loop simply keeps asking.
  for (let i = 0; i < 400; i++) {
    attacker.send({ t: 'attack', targetEntityId: targetId });
    await sleep(TICK * 3);
    if (!attacker.entities.has(targetId)) return;
  }
  throw new Error('target refused to die');
}

/** Walks `mover` until adjacent to the entity `targetId` (in mover's mirror). */
async function walkAdjacentTo(mover: BotClient, targetId: number): Promise<void> {
  for (let i = 0; i < 160; i++) {
    const me = mover.entities.get(mover.you!);
    const them = mover.entities.get(targetId);
    if (!me || !them) break;
    const dx = them.x - me.x;
    const dy = them.y - me.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) <= 1) return;
    const dir = dy < 0 ? (dx > 0 ? 'ne' : dx < 0 ? 'nw' : 'n')
      : dy > 0 ? (dx > 0 ? 'se' : dx < 0 ? 'sw' : 's')
      : dx > 0 ? 'e' : 'w';
    mover.send({ t: 'move', dir });
    await sleep(TICK * 4);
  }
  throw new Error(`never got adjacent to entity ${targetId}`);
}

const findKind = (bot: BotClient, kind: string) =>
  [...bot.entities.values()].find((e) => e.kind === kind);

// ---------------------------------------------------------------------------
// The wilderness: gear moves to the corpse, séances, animation, the hunt.
// ---------------------------------------------------------------------------

describe('spirits in the wilderness (broken-yard)', () => {
  let store: MemoryStore;
  let server: GameServer;
  let necro: BotClient; // Bonespeaker — knows the rites
  let prey: BotClient; // dies, repeatedly, for science
  let mook: BotClient; // classless hands: kills, loots, fails ability gates
  let preyChar: string;
  let mookChar: string;
  let itemBaseline = 0;

  beforeAll(async () => {
    store = new MemoryStore();
    server = new GameServer({
      store,
      content: loadContent(contentDir),
      port: 0,
      tickIntervalMs: TICK,
      rngSeed: 29,
      defaultAreaId: 'broken-yard', // wilderness (D-206)
      ghostMinTicks: 300,
      attackCooldownTicks: 2,
      bleedIntervalTicks: 5000,
      corpseDecayTicks: 4000,
      groundLootTicks: 4000,
      zombieDurationTicks: 4000,
    });
    await server.start();
    const url = `ws://127.0.0.1:${server.port}`;
    necro = await BotClient.connect(url);
    prey = await BotClient.connect(url);
    mook = await BotClient.connect(url);
    await join(necro, 'necro_bot', 'Hollis Grave', 601, {
      classId: 'bonespeaker',
      store,
      legacyPoints: 1,
    });
    ({ characterId: preyChar } = await join(prey, 'prey_bot', 'Tam Reedy', 602));
    ({ characterId: mookChar } = await join(mook, 'mook_bot', 'Bors Hackle', 603));
    await store.grantItem(preyChar, 'iron-ore', 2);
    await store.grantItem(preyChar, 'bandage', 1);
    itemBaseline = await store.countItems();
  });

  afterAll(async () => {
    necro?.close();
    prey?.close();
    mook?.close();
    await server.stop();
  });

  it('death leaves a corpse the living see, wearing the gear (D-224)', async () => {
    const preyEntity = prey.you!;
    await walkAdjacentTo(mook, preyEntity);
    await attackUntilDead(mook, preyEntity);
    await waitUntil(() => prey.status?.ghost === true, 'prey is a ghost');
    await waitUntil(() => findKind(mook, 'corpse') !== undefined, 'the living see the corpse');
    const corpse = findKind(mook, 'corpse')!;
    expect(corpse.descriptor).toContain('corpse');
    // The ghost's plane holds no corpse — the body belongs to the living world.
    expect(findKind(prey, 'corpse')).toBeUndefined();
    // Wilderness rule (D-511): everything carried moved to the corpse.
    expect(prey.inventory).toEqual([]);
    expect(await store.getItemsByCharacter(preyChar)).toEqual([]);
    expect(await store.countItems()).toBe(itemBaseline);
  });

  it('spirit abilities are class-gated (D-208): no rites without the class', async () => {
    const corpse = findKind(mook, 'corpse')!;
    await walkAdjacentTo(mook, corpse.id);
    mook.send({ t: 'speak_dead', targetEntityId: corpse.id });
    await mook.expectError('lacks_ability');
    mook.send({ t: 'animate_dead', targetEntityId: corpse.id });
    await mook.expectError('lacks_ability');
  });

  it('corpses are not combat targets', async () => {
    const corpse = findKind(mook, 'corpse')!;
    mook.send({ t: 'attack', targetEntityId: corpse.id });
    await mook.expectError('bad_target');
  });

  it('Speak With Dead pulls the ghost to the body for five questions (D-204)', async () => {
    const corpse = findKind(necro, 'corpse')!;
    await walkAdjacentTo(necro, corpse.id);
    necro.send({ t: 'speak_dead', targetEntityId: corpse.id });
    await waitUntil(() => necro.seance?.active === true, 'the séance opens');
    await waitUntil(() => prey.seance?.active === true, 'the spirit is drawn back');
    expect(necro.seance!.questionsLeft).toBe(5);
    expect(prey.seance!.role).toBe('spirit');

    // A question crosses the veil…
    const heardBefore = prey.speeches.length;
    necro.send({ t: 'say', channel: 'say', text: 'Who struck you down?' });
    await waitUntil(
      () => prey.speeches.slice(heardBefore).some((s) => s.text.includes('Who struck you down')),
      'the spirit hears the question',
    );
    await waitUntil(() => necro.seance?.questionsLeft === 4, 'a question is spent');

    // …and the answer comes back out of the corpse's mouth. The dead are
    // under no oath: this answer is a barefaced lie, and nothing stops it.
    const necroHeard = necro.speeches.length;
    prey.send({ t: 'say', channel: 'say', text: 'A stranger in imperial colours.' });
    await waitUntil(
      () =>
        necro.speeches
          .slice(necroHeard)
          .some((s) => s.text.includes('imperial colours') && s.speakerDescriptor.includes('corpse')),
      'the corpse speaks the answer',
    );
    // Bystanders hear the corpse too — a séance is a public performance.
    expect(
      mook.speeches.some((s) => s.text.includes('imperial colours') && s.speakerDescriptor.includes('corpse')),
    ).toBe(true);

    // Spend the remaining four questions; the fifth answer ends it.
    for (let q = 0; q < 4; q++) {
      necro.send({ t: 'say', channel: 'say', text: `Question ${q + 2}?` });
      await waitUntil(() => necro.seance?.questionsLeft === 3 - q, `question ${q + 2} spent`);
    }
    prey.send({ t: 'say', channel: 'say', text: 'And that is all you get.' });
    await waitUntil(() => prey.seance?.active === false, 'the spirit departs');
    await waitUntil(() => necro.seance?.active === false, 'the séance closes');
  });

  it('a respawned spirit is beyond reach — a distinct result (D-511)', async () => {
    for (let i = 0; i < 40 && prey.status?.ghost !== false; i++) {
      prey.send({ t: 'respawn' });
      await sleep(200);
    }
    await waitUntil(() => prey.status?.ghost === false, 'prey walks again');
    const corpse = findKind(necro, 'corpse')!;
    necro.send({ t: 'speak_dead', targetEntityId: corpse.id });
    await necro.expectError('beyond_reach');
  });

  it('looting a wilderness corpse hands over everything it held', async () => {
    const corpse = findKind(mook, 'corpse')!;
    await walkAdjacentTo(mook, corpse.id);
    mook.send({ t: 'loot', targetEntityId: corpse.id });
    await waitUntil(
      () => mook.inventory.some((i) => i.templateId === 'iron-ore'),
      'the looter holds the ore',
    );
    expect(mook.inventory.some((i) => i.templateId === 'bandage')).toBe(true);
    expect(await store.countItems()).toBe(itemBaseline);
    // The body itself remains where it fell.
    expect(findKind(mook, 'corpse')).toBeDefined();
    // A second loot finds nothing.
    mook.send({ t: 'loot', targetEntityId: corpse.id });
    await mook.expectError('no_such_item');
  });

  it('Animate Dead raises the corpse; the cap scales with skill (D-511)', async () => {
    const corpse = findKind(necro, 'corpse')!;
    await walkAdjacentTo(necro, corpse.id);
    necro.send({ t: 'animate_dead', targetEntityId: corpse.id });
    await waitUntil(
      () => [...necro.entities.values()].some((e) => e.descriptor.includes('walking corpse')),
      'the body rises',
    );
    expect(findKind(necro, 'corpse')).toBeUndefined();

    // Kill the prey again for a second corpse — carrying one fresh ore.
    await store.grantItem(preyChar, 'iron-ore', 1);
    const preyEntity2 = prey.you!;
    await walkAdjacentTo(mook, preyEntity2);
    await attackUntilDead(mook, preyEntity2);
    await waitUntil(() => findKind(necro, 'corpse') !== undefined, 'a second corpse lies');

    // Necromancy 0 sustains one body only.
    const corpse2 = findKind(necro, 'corpse')!;
    await walkAdjacentTo(necro, corpse2.id);
    necro.send({ t: 'animate_dead', targetEntityId: corpse2.id });
    await necro.expectError('limit_reached');

    // Skill raises the cap (admin verb, live-applied).
    const r = await server.adminSetSkills('Hollis Grave', { necromancy: 40 });
    expect(r.ok).toBe(true);
    necro.send({ t: 'animate_dead', targetEntityId: corpse2.id });
    await waitUntil(
      () =>
        [...necro.entities.values()].filter((e) => e.descriptor.includes('walking corpse')).length === 2,
      'two bodies walk',
    );
  });

  it('zombies shamble after their necromancer', async () => {
    const zombie = [...necro.entities.values()].find((e) => e.descriptor.includes('walking corpse'))!;
    for (let i = 0; i < 6; i++) {
      necro.send({ t: 'move', dir: 'e' });
      await sleep(TICK * 4);
    }
    const me = () => necro.entities.get(necro.you!)!;
    await waitUntil(() => {
      const z = necro.entities.get(zombie.id);
      return z !== undefined && Math.max(Math.abs(z.x - me().x), Math.abs(z.y - me().y)) <= 2;
    }, 'the zombie closes the distance');
  });

  it('the dead owner may ride the body and speak in the undead register (D-224)', async () => {
    await waitUntil(() => prey.status?.ghost === true, 'prey is a ghost again');
    prey.send({ t: 'observe_body', on: true });
    await waitUntil(() => prey.observing === true, 'riding the body');

    // What the body hears, the owner hears.
    const heardBefore = prey.speeches.length;
    necro.send({ t: 'say', channel: 'say', text: 'Walk with me, dead thing.' });
    await waitUntil(
      () => prey.speeches.slice(heardBefore).some((s) => s.text.includes('Walk with me')),
      'the owner hears through dead ears',
    );

    // What the owner says leaves the body's mouth, garbled beyond the living
    // tongues — and the original is preserved in the event log.
    const necroHeard = necro.speeches.length;
    prey.send({ t: 'say', channel: 'say', text: 'Remember the ferry crossing' });
    await waitUntil(
      () =>
        necro.speeches
          .slice(necroHeard)
          .some((s) => s.speakerDescriptor.includes('walking corpse') && s.language === 'unknown'),
      'the body speaks in the undead register',
    );
    const spoken = necro.speeches.slice(necroHeard).find((s) => s.speakerDescriptor.includes('walking corpse'))!;
    expect(spoken.text).not.toContain('Remember the ferry crossing');
    const logged = (await store.listRecentEvents(20)).find(
      (e) => e.type === 'speech' && (e.data as { language?: string }).language === 'undead',
    );
    expect((logged?.data as { text?: string }).text).toBe('Remember the ferry crossing');

    prey.send({ t: 'observe_body', on: false });
    await waitUntil(() => prey.observing === false, 'let go of the body');
  });

  it('destroying the zombie drops the gear it wore (D-224)', async () => {
    // The second zombie wears the fresh ore from the second death.
    const zombies = [...mook.entities.values()].filter((e) => e.descriptor.includes('walking corpse'));
    expect(zombies.length).toBe(2);
    const oreBefore = mook.inventory.filter((i) => i.templateId === 'iron-ore').reduce((n, i) => n + i.qty, 0);
    for (const z of zombies) {
      await walkAdjacentTo(mook, z.id);
      await attackUntilDead(mook, z.id);
    }
    await waitUntil(() => findKind(mook, 'pile') !== undefined, 'the gear hits the ground');
    const pile = findKind(mook, 'pile')!;
    expect(pile.descriptor).toContain('belongings');
    await walkAdjacentTo(mook, pile.id);
    mook.send({ t: 'loot', targetEntityId: pile.id });
    await waitUntil(
      () =>
        mook.inventory.filter((i) => i.templateId === 'iron-ore').reduce((n, i) => n + i.qty, 0) ===
        oreBefore + 1,
      'the hunt pays off',
    );
    // The emptied pile vanishes; item count is conserved through the chain.
    await waitUntil(() => findKind(mook, 'pile') === undefined, 'the pile is gone');
    expect(await store.countItems()).toBe(itemBaseline + 1); // +1: the ore granted mid-test
  });

  it('no partition leaks and no protocol violations anywhere in the chain', () => {
    expect(necro.violations).toEqual([]);
    expect(prey.violations).toEqual([]);
    expect(mook.violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Settled ground: the corpse is a shape, not a container (D-511).
// ---------------------------------------------------------------------------

describe('spirits on settled ground (hanged-ferryman)', () => {
  let store: MemoryStore;
  let server: GameServer;
  let necro: BotClient;
  let prey: BotClient;
  let mook: BotClient;
  let preyChar: string;

  beforeAll(async () => {
    store = new MemoryStore();
    server = new GameServer({
      store,
      content: loadContent(contentDir),
      port: 0,
      tickIntervalMs: TICK,
      rngSeed: 31,
      defaultAreaId: 'hanged-ferryman', // settled (D-206)
      hostilityWindowTicks: 20,
      ghostMinTicks: 300,
      attackCooldownTicks: 2,
      bleedIntervalTicks: 5000,
      corpseDecayTicks: 4000,
      groundLootTicks: 4000,
      zombieDurationTicks: 250, // short: the expiry test lives here
    });
    await server.start();
    const url = `ws://127.0.0.1:${server.port}`;
    necro = await BotClient.connect(url);
    prey = await BotClient.connect(url);
    mook = await BotClient.connect(url);
    await join(necro, 'necro_two', 'Sel Mourner', 611, {
      classId: 'bonespeaker',
      store,
      legacyPoints: 1,
    });
    ({ characterId: preyChar } = await join(prey, 'prey_two', 'Wick Fenn', 612));
    await join(mook, 'mook_two', 'Oren Slate', 613);
    await store.grantItem(preyChar, 'iron-ore', 1);
  });

  afterAll(async () => {
    necro?.close();
    prey?.close();
    mook?.close();
    await server.stop();
  });

  async function killPreySettled(): Promise<void> {
    const target = prey.you!;
    await walkAdjacentTo(mook, target);
    mook.send({ t: 'hostile', targetEntityId: target, text: 'This town is done with you.' });
    await sleep(TICK * 25); // the warning window
    await attackUntilDead(mook, target);
    await waitUntil(() => prey.status?.ghost === true, 'prey is a ghost');
  }

  it('a settled-zone corpse cannot be looted; the dead keep their goods', async () => {
    const itemsBefore = await store.countItems();
    await killPreySettled();
    await waitUntil(() => findKind(mook, 'corpse') !== undefined, 'the corpse lies in the tavern');
    // The player keeps their loot (D-511): still on the character record.
    expect((await store.getItemsByCharacter(preyChar)).some((i) => i.templateId === 'iron-ore')).toBe(true);
    const corpse = findKind(mook, 'corpse')!;
    await walkAdjacentTo(mook, corpse.id);
    mook.send({ t: 'loot', targetEntityId: corpse.id });
    await mook.expectError('no_such_item');
    expect(await store.countItems()).toBe(itemsBefore);
  });

  it('an animated settled corpse drops nothing when destroyed', async () => {
    const corpse = findKind(necro, 'corpse')!;
    await walkAdjacentTo(necro, corpse.id);
    necro.send({ t: 'animate_dead', targetEntityId: corpse.id });
    await waitUntil(
      () => [...mook.entities.values()].some((e) => e.descriptor.includes('walking corpse')),
      'the body rises in the tavern',
    );
    // Zombies are NPCs — fair game even on settled ground (D-206).
    const zombie = [...mook.entities.values()].find((e) => e.descriptor.includes('walking corpse'))!;
    await walkAdjacentTo(mook, zombie.id);
    await attackUntilDead(mook, zombie.id);
    await sleep(200);
    expect(findKind(mook, 'pile')).toBeUndefined();
  });

  it('an animated corpse crumbles when its time runs out (D-511)', async () => {
    // Prey respawns, dies again; this zombie is left to expire.
    for (let i = 0; i < 40 && prey.status?.ghost !== false; i++) {
      prey.send({ t: 'respawn' });
      await sleep(200);
    }
    await killPreySettled();
    await waitUntil(() => findKind(necro, 'corpse') !== undefined, 'a fresh corpse');
    const corpse = findKind(necro, 'corpse')!;
    await walkAdjacentTo(necro, corpse.id);
    necro.send({ t: 'animate_dead', targetEntityId: corpse.id });
    await waitUntil(
      () => [...necro.entities.values()].some((e) => e.descriptor.includes('walking corpse')),
      'the body rises once more',
    );
    // 250 ticks at 5ms — it has moments to live.
    await waitUntil(
      () => ![...necro.entities.values()].some((e) => e.descriptor.includes('walking corpse')),
      'the body sags and falls still',
      6000,
    );
    expect(necro.narrations.some((n) => n.includes('lets go'))).toBe(true);
  });

  it('legacy-locked classes require Legacy Points at creation (placeholder gate)', async () => {
    const fresh = await BotClient.connect(`ws://127.0.0.1:${server.port}`);
    fresh.send({ t: 'register', username: 'poor_bot', password: 'password-word' });
    await fresh.expect('auth_ok');
    fresh.send({ t: 'create_character', name: 'Penniless Pate', classId: 'bonespeaker' });
    await fresh.expectError('lacks_ability');
    fresh.send({ t: 'create_character', name: 'Penniless Pate', classId: 'physician' });
    const created = await fresh.expect('character_created');
    expect(created.character.classId).toBe('physician');
    fresh.close();
  });

  it('no violations on settled ground either', () => {
    expect(necro.violations).toEqual([]);
    expect(prey.violations).toEqual([]);
    expect(mook.violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Decay and cleanup: the world does not fill with the dead (D-511).
// ---------------------------------------------------------------------------

describe('corpse decay and the ground-loot clock', () => {
  let store: MemoryStore;
  let server: GameServer;
  let prey: BotClient;
  let mook: BotClient;
  let preyChar: string;

  beforeAll(async () => {
    store = new MemoryStore();
    server = new GameServer({
      store,
      content: loadContent(contentDir),
      port: 0,
      tickIntervalMs: TICK,
      rngSeed: 37,
      defaultAreaId: 'broken-yard',
      ghostMinTicks: 60,
      attackCooldownTicks: 2,
      bleedIntervalTicks: 5000,
      corpseDecayTicks: 60, // clamped to ghostMinTicks — the D-511 minimum
      groundLootTicks: 80,
      zombieDurationTicks: 4000,
    });
    await server.start();
    const url = `ws://127.0.0.1:${server.port}`;
    prey = await BotClient.connect(url);
    mook = await BotClient.connect(url);
    ({ characterId: preyChar } = await join(prey, 'decay_prey', 'Fen Marsh', 621));
    await join(mook, 'decay_mook', 'Cutter Voss', 622);
    await store.grantItem(preyChar, 'iron-ore', 3);
  });

  afterAll(async () => {
    prey?.close();
    mook?.close();
    await server.stop();
  });

  it('corpse → pile → cleanup, with the destruction logged as evidence', async () => {
    const itemsBefore = await store.countItems();
    await walkAdjacentTo(mook, prey.you!);
    await attackUntilDead(mook, prey.you!);
    await waitUntil(() => findKind(mook, 'corpse') !== undefined, 'the corpse lies');
    // 60 ticks at 5ms: the body rots quickly here.
    await waitUntil(() => findKind(mook, 'corpse') === undefined, 'the corpse rots away', 8000);
    await waitUntil(() => findKind(mook, 'pile') !== undefined, 'the gear remains behind');
    expect(await store.countItems()).toBe(itemsBefore); // nothing lost yet
    // 80 more ticks and the server sweeps the street.
    await waitUntil(() => findKind(mook, 'pile') === undefined, 'the pile is swept', 8000);
    await sleep(50); // let the cleanup's store writes settle
    expect(await store.countItems()).toBe(itemsBefore - 3);
    const cleanup = (await store.listRecentEvents(30)).find((e) => e.type === 'corpse_loot_cleanup');
    expect(cleanup).toBeDefined();
    expect((cleanup!.data as { destroyed: { templateId: string }[] }).destroyed).toEqual([
      { templateId: 'iron-ore', qty: 3 },
    ]);
    expect(mook.violations).toEqual([]);
    expect(prey.violations).toEqual([]);
  });
});
