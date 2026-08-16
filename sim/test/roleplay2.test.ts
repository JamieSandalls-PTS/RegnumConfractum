import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadContent } from '@rc/server/content';
import { scrambleSpeech } from '@rc/server/game/language';
import { GameServer } from '@rc/server/net/gateway';
import { MemoryStore } from '@rc/server/store/memory';
import { BotClient } from '../src/botClient';

/**
 * M2b played by bots: languages scrambled per listener, writing as physical
 * items, third-party introductions, and the hooded thread with its merge on
 * unhooding (D-219). Set in the first-slice tavern.
 */

const contentDir = fileURLToPath(new URL('../../content', import.meta.url));
const TICK = 5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(pred: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting until ${what}`);
}

let store: MemoryStore;
let server: GameServer;
let keeper: BotClient; // speaks common + old-imperial
let scholar: BotClient; // speaks common + old-imperial
let peasant: BotClient; // common only
let keeperChar: string;
let scholarChar: string;
let peasantChar: string;
let keeperEntity: number;
let scholarEntity: number;

async function join(
  bot: BotClient,
  username: string,
  charName: string,
  seed: number,
  languages?: string[],
) {
  bot.send({ t: 'register', username, password: 'password-word' });
  await bot.expect('auth_ok');
  bot.send({ t: 'create_character', name: charName, appearanceSeed: seed });
  const characterId = (await bot.expect('character_created')).character.id;
  if (languages) await store.setCharacterLanguages(characterId, languages);
  bot.send({ t: 'enter_world', characterId });
  const snap = await bot.expect('snapshot');
  return { characterId, entityId: snap.you, areaId: snap.area.id };
}

beforeAll(async () => {
  store = new MemoryStore();
  server = new GameServer({
    store,
    content: loadContent(contentDir),
    port: 0,
    tickIntervalMs: TICK,
    rngSeed: 77,
    defaultAreaId: 'hanged-ferryman',
  });
  await server.start();
  const url = `ws://127.0.0.1:${server.port}`;
  keeper = await BotClient.connect(url);
  scholar = await BotClient.connect(url);
  peasant = await BotClient.connect(url);
  const k = await join(keeper, 'keeper_bot', 'Osric Fenn', 201, ['common', 'old-imperial']);
  keeperChar = k.characterId;
  keeperEntity = k.entityId;
  expect(k.areaId).toBe('hanged-ferryman'); // the first slice starts at the tavern
  const s = await join(scholar, 'scholar_bot', 'Serane Voss', 202, ['common', 'old-imperial']);
  scholarChar = s.characterId;
  scholarEntity = s.entityId;
  const p = await join(peasant, 'peasant_bot', 'Tobbin Mudge', 203);
  peasantChar = p.characterId;
});

afterAll(async () => {
  keeper?.close();
  scholar?.close();
  peasant?.close();
  await server.stop();
});

describe('languages (M2)', () => {
  it('a known tongue arrives intact; an unknown one arrives scrambled', async () => {
    keeper.send({
      t: 'say',
      channel: 'say',
      text: 'The old duke buried his silver under the granary.',
      language: 'old-imperial',
    });
    await waitUntil(
      () => scholar.speeches.length >= 1 && peasant.speeches.length >= 1,
      'both hear',
    );
    const learned = scholar.speeches[0]!;
    const heard = peasant.speeches[0]!;
    expect(learned.text).toBe('The old duke buried his silver under the granary.');
    expect(learned.language).toBe('Old Imperial');
    expect(heard.language).toBe('unknown');
    expect(heard.text).not.toContain('silver');
    expect(heard.text).not.toContain('granary');
    // Deterministic scramble: the wire text matches the pure function.
    expect(heard.text).toBe(
      scrambleSpeech('The old duke buried his silver under the granary.', 'old-imperial'),
    );
  });

  it('emote spans are seen even when the words are not', async () => {
    keeper.send({
      t: 'say',
      channel: 'say',
      text: '*bows* An honour beyond deserving.',
      language: 'old-imperial',
    });
    await waitUntil(() => peasant.speeches.length >= 2, 'peasant hears');
    expect(peasant.speeches[1]!.text).toContain('*bows*');
    expect(peasant.speeches[1]!.text.toLowerCase()).not.toContain('honour');
  });

  it('you cannot speak a tongue you do not know', async () => {
    peasant.send({ t: 'say', channel: 'say', text: 'salve!', language: 'old-imperial' });
    await peasant.expectError('invalid_message');
  });
});

describe('in-world writing (M2)', () => {
  let noteId: string;

  it('writing consumes parchment and produces a titled note', async () => {
    await store.grantItem(keeperChar, 'parchment', 2);
    keeper.send({ t: 'write', title: 'Debts of the House', text: 'Marlow owes four crowns.\nThe smith owes nothing now.' });
    await waitUntil(() => keeper.inventory.some((i) => i.templateId === 'written-note'), 'note appears');
    const note = keeper.inventory.find((i) => i.templateId === 'written-note')!;
    expect(note.label).toBe('Debts of the House');
    const parchment = keeper.inventory.find((i) => i.templateId === 'parchment');
    expect(parchment?.qty).toBe(1); // one sheet consumed
    noteId = note.id;
  });

  it('the holder can read it back', async () => {
    keeper.send({ t: 'read_item', itemId: noteId });
    const page = await keeper.expect('item_text');
    expect(page.title).toBe('Debts of the House');
    expect(page.text).toContain('Marlow owes four crowns.');
  });

  it('a handed-over note carries its words; the giver loses them', async () => {
    keeper.send({ t: 'give', itemId: noteId, toEntityId: scholarEntity });
    await keeper.expect('inventory');
    scholar.send({ t: 'read_item', itemId: noteId });
    const page = await scholar.expect('item_text');
    expect(page.text).toContain('Marlow owes four crowns.');
    keeper.send({ t: 'read_item', itemId: noteId });
    await keeper.expectError('no_such_item');
    expect(await store.countItems()).toBe(2); // 1 parchment + 1 note, conserved
  });
});

describe('third-party introduction (D-201)', () => {
  it("'this is X' teaches listeners the target's name, provenance third_party", async () => {
    keeper.send({
      t: 'say',
      channel: 'say',
      text: 'This is the Doctor. Mind your grammar.',
      introduce: { entityId: scholarEntity, name: 'Doctor Voss' },
    });
    await waitUntil(() => peasant.speeches.some((s) => s.text.includes('Doctor')), 'peasant hears');
    await sleep(150); // knowledge upsert follows message dispatch
    const known = await store.getKnowledge(peasantChar, [scholarChar]);
    expect(known.get(scholarChar)).toMatchObject({
      knownName: 'Doctor Voss',
      provenance: 'third_party',
    });
    // The peasant's snapshot now names them.
    peasant.send({ t: 'resync' });
    await peasant.expect('snapshot');
    expect(peasant.entities.get(scholarEntity)!.descriptor).toBe('Doctor Voss');
  });

  it('an introduction never overwrites a name already held', async () => {
    await store.upsertKnowledge({
      observerCharacterId: keeperChar,
      subjectCharacterId: peasantChar,
      presentation: 'normal',
      knownName: 'Old Tobbin',
      provenance: 'verified',
      impression: null,
    });
    const peasantEntity = [...scholar.entities.keys()].find(
      (id) => id !== scholarEntity && id !== keeperEntity,
    )!;
    scholar.send({
      t: 'say',
      channel: 'say',
      text: 'This wretch is Mudfoot.',
      introduce: { entityId: peasantEntity, name: 'Mudfoot the Wretch' },
    });
    await sleep(200);
    const known = await store.getKnowledge(keeperChar, [peasantChar]);
    expect(known.get(peasantChar)?.knownName).toBe('Old Tobbin');
  });
});

describe('the hooded thread and its merge (D-219)', () => {
  it('raising a hood makes you a stranger again', async () => {
    scholar.send({ t: 'set_presentation', state: 'hooded' });
    await waitUntil(
      () => peasant.entities.get(scholarEntity)?.presentation === 'hooded',
      'peasant sees the hood',
    );
    // The peasant knew them as Doctor Voss — but that name belongs to the
    // unhooded identity. The hooded figure is nobody they know.
    peasant.send({ t: 'resync' });
    await peasant.expect('snapshot');
    const seen = peasant.entities.get(scholarEntity)!;
    expect(seen.descriptor).toMatch(/hooded/);
    expect(seen.descriptor).not.toContain('Voss');
  });

  it('a name declared while hooded attaches to the hooded identity only', async () => {
    scholar.send({
      t: 'say',
      channel: 'say',
      text: 'Call me the Crow.',
      declareAs: 'The Crow',
    });
    await sleep(250);
    const hooded = await store.getKnowledge(peasantChar, [scholarChar], 'hooded');
    expect(hooded.get(scholarChar)?.knownName).toBe('The Crow');
    const normal = await store.getKnowledge(peasantChar, [scholarChar], 'normal');
    expect(normal.get(scholarChar)?.knownName).toBe('Doctor Voss');
    peasant.send({ t: 'resync' });
    await peasant.expect('snapshot');
    expect(peasant.entities.get(scholarEntity)!.descriptor).toBe('The Crow');
  });

  it('lowering the hood in view merges the threads — the recognition beat', async () => {
    scholar.send({ t: 'set_presentation', state: 'normal' });
    await waitUntil(
      () => peasant.entities.get(scholarEntity)?.presentation === 'normal',
      'hood comes down',
    );
    await sleep(250);
    // The Crow and Doctor Voss are now the same person in the peasant's world.
    const hooded = await store.getKnowledge(peasantChar, [scholarChar], 'hooded');
    expect(hooded.get(scholarChar)).toBeUndefined(); // thread folded away
    const normal = await store.getKnowledge(peasantChar, [scholarChar], 'normal');
    expect(normal.get(scholarChar)?.knownName).toBe('Doctor Voss'); // real thread wins
    peasant.send({ t: 'resync' });
    await peasant.expect('snapshot');
    expect(peasant.entities.get(scholarEntity)!.descriptor).toBe('Doctor Voss');
  });

  it('when only the hooded name was known, the merge carries it over', async () => {
    // A fresh witness who has only ever met the hooded Crow.
    const witness = await BotClient.connect(`ws://127.0.0.1:${server.port}`);
    const w = await join(witness, 'witness_bot', 'Wenna Harrow', 204);
    scholar.send({ t: 'set_presentation', state: 'hooded' });
    await waitUntil(
      () => witness.entities.get(scholarEntity)?.presentation === 'hooded',
      'witness sees the hood',
    );
    scholar.send({ t: 'say', channel: 'say', text: 'The Crow.', declareAs: 'The Crow' });
    await sleep(250);
    scholar.send({ t: 'set_presentation', state: 'normal' });
    await sleep(250);
    const normal = await store.getKnowledge(w.characterId, [scholarChar], 'normal');
    expect(normal.get(scholarChar)?.knownName).toBe('The Crow');
    witness.close();
  });
});
