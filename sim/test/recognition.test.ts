import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadContent } from '@rc/server/content';
import { GameServer } from '@rc/server/net/gateway';
import { MemoryStore } from '@rc/server/store/memory';
import { BotClient } from '../src/botClient';

/**
 * The M2 core, played by bots (D-114): strangers meet, speak, one gives a
 * false name, listeners' Insight grades it per observer — and nothing on the
 * wire betrays that the declaration mechanic fired.
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
let liar: BotClient; // Aldous Crane, declaring himself "Marcus Hale"
let sharp: BotClient; // very high insight — must read the lie
let dull: BotClient; // very low insight — must be taken in
let liarChar: string;
let sharpChar: string;
let dullChar: string;
let liarEntity: number;

async function join(
  bot: BotClient,
  username: string,
  charName: string,
  seed: number,
  skills?: { bluff?: number; insight?: number },
) {
  bot.send({ t: 'register', username, password: 'password-word' });
  await bot.expect('auth_ok');
  bot.send({ t: 'create_character', name: charName, appearanceSeed: seed });
  const characterId = (await bot.expect('character_created')).character.id;
  // Skills must be set before enter_world — the gateway caches the record.
  if (skills) await store.setCharacterSkills(characterId, skills);
  bot.send({ t: 'enter_world', characterId });
  const snap = await bot.expect('snapshot');
  return { characterId, entityId: snap.you };
}

beforeAll(async () => {
  store = new MemoryStore();
  server = new GameServer({
    store,
    content: loadContent(contentDir),
    port: 0,
    tickIntervalMs: TICK,
    rngSeed: 1207,
  });
  await server.start();
  const url = `ws://127.0.0.1:${server.port}`;
  liar = await BotClient.connect(url);
  sharp = await BotClient.connect(url);
  dull = await BotClient.connect(url);
  // Extreme stats so the graded contest is deterministic at the tails.
  ({ characterId: liarChar, entityId: liarEntity } = await join(
    liar, 'liar_bot', 'Aldous Crane', 101, { bluff: 10 },
  ));
  ({ characterId: sharpChar } = await join(sharp, 'sharp_bot', 'Serane Voss', 102, { insight: 60 }));
  ({ characterId: dullChar } = await join(dull, 'dull_bot', 'Tobbin Mudge', 103, { insight: -60 }));
});

afterAll(async () => {
  liar?.close();
  sharp?.close();
  dull?.close();
  await server.stop();
});

describe('strangers, speech, and false names (M2)', () => {
  it('strangers are described, never named', async () => {
    await waitUntil(() => sharp.entities.has(liarEntity), 'sharp sees liar');
    const seen = sharp.entities.get(liarEntity)!;
    expect(seen.descriptor).toMatch(/figure/);
    expect(seen.descriptor).not.toContain('Aldous');
    expect(seen.descriptor).not.toContain('Crane');
  });

  it('speech reaches everyone in earshot, attributed by description', async () => {
    liar.send({ t: 'say', channel: 'say', text: 'Cold night on the roads.' });
    await waitUntil(() => sharp.speeches.length >= 1, 'sharp hears');
    await waitUntil(() => dull.speeches.length >= 1, 'dull hears');
    const heard = sharp.speeches[0]!;
    expect(heard.text).toBe('Cold night on the roads.');
    expect(heard.speakerDescriptor).toMatch(/figure/);
    // The speaker hears their own line under their own name.
    expect(liar.speeches[0]!.speakerDescriptor).toBe('Aldous Crane');
  });

  it('a false declaration lands differently per listener (D-218, D-219)', async () => {
    liar.send({
      t: 'say',
      channel: 'say',
      text: 'Marcus Hale, at your service.',
      declareAs: 'Marcus Hale',
    });
    await waitUntil(() => sharp.speeches.length >= 2 && dull.speeches.length >= 2, 'both hear');
    const sharpHeard = sharp.speeches[1]!;
    const dullHeard = dull.speeches[1]!;
    // The sharp listener reads the lie with certainty; the dull one is taken in.
    expect(sharpHeard.impression).toBe('certain_false');
    expect(dullHeard.impression).toBeUndefined();
    // Insight never reveals WHAT the truth is — only doubt (schema enforces).
    expect(JSON.stringify(sharpHeard)).not.toContain('Aldous');
  });

  it('the declaration flag itself is invisible on the wire (D-218 rule 2)', async () => {
    // Same-shaped message with and without a declaration, impression aside.
    const plain = Object.keys(sharp.speeches[0]!).sort();
    const declared = Object.keys(dull.speeches[1]!).sort();
    expect(declared).toEqual(plain);
    expect(JSON.stringify(dull.speeches[1])).not.toMatch(/declare/i);
  });

  it('after the declaration, both listeners call him by the claimed name', async () => {
    sharp.send({ t: 'resync' });
    await sharp.expect('snapshot');
    dull.send({ t: 'resync' });
    await dull.expect('snapshot');
    expect(sharp.entities.get(liarEntity)!.descriptor).toBe('Marcus Hale');
    expect(dull.entities.get(liarEntity)!.descriptor).toBe('Marcus Hale');
    // The knowledge carries provenance and the listener's own impression.
    const sharpKnows = await store.getKnowledge(sharpChar, [liarChar]);
    expect(sharpKnows.get(liarChar)).toMatchObject({
      knownName: 'Marcus Hale',
      provenance: 'self_claimed',
      impression: 'certain_false',
    });
    const dullKnows = await store.getKnowledge(dullChar, [liarChar]);
    expect(dullKnows.get(liarChar)).toMatchObject({
      knownName: 'Marcus Hale',
      impression: null,
    });
  });

  it('whispers do not carry across the yard', async () => {
    // Move the liar far from both listeners (everyone spawned together).
    for (let i = 0; i < 25; i++) {
      liar.send({ t: 'move', dir: 'e' });
      await sleep(TICK * 4);
    }
    const sharpBefore = sharp.speeches.length;
    liar.send({ t: 'say', channel: 'whisper', text: 'can anyone hear this?' });
    await waitUntil(() => liar.speeches.some((s) => s.channel === 'whisper'), 'liar hears self');
    await sleep(150);
    expect(sharp.speeches.length).toBe(sharpBefore);
  });

  it('a shout carries to the whole yard', async () => {
    const sharpBefore = sharp.speeches.length;
    liar.send({ t: 'say', channel: 'shout', text: 'HAIL THE BROKEN CROWN' });
    await waitUntil(() => sharp.speeches.length > sharpBefore, 'sharp hears the shout');
    const shout = sharp.speeches[sharp.speeches.length - 1]!;
    expect(shout.channel).toBe('shout');
  });

  it('emotes animate and postures persist for late observers', async () => {
    liar.send({ t: 'say', channel: 'say', text: '*sits down and laughs* Enough walking.' });
    await waitUntil(
      () => sharp.entities.get(liarEntity)?.posture === 'sitting',
      'posture propagates',
    );
    // A brand-new observer's snapshot must show him already seated.
    const late = await BotClient.connect(`ws://127.0.0.1:${server.port}`);
    const { entityId } = await join(late, 'late_bot', 'Wenna Harrow', 104);
    expect(entityId).toBeGreaterThan(0);
    expect(late.entities.get(liarEntity)?.posture).toBe('sitting');
    late.close();
  });

  it('negated emotes do not fire', async () => {
    const before = sharp.entities.get(liarEntity)!.posture;
    liar.send({ t: 'say', channel: 'say', text: "*doesn't kneel* Not for anyone." });
    await sleep(200);
    expect(sharp.entities.get(liarEntity)!.posture).toBe(before);
  });

  it('movement returns the posture to standing everywhere', async () => {
    liar.send({ t: 'move', dir: 'w' });
    await waitUntil(
      () => sharp.entities.get(liarEntity)?.posture === 'standing',
      'stood up by walking',
    );
  });

  it('speech is in the event log in full (D-215)', async () => {
    const events = await store.listRecentEvents(100);
    const speech = events.filter((e) => e.type === 'speech');
    expect(speech.length).toBeGreaterThanOrEqual(5);
    const declared = speech.find((e) => (e.data as { declaredAs?: string }).declaredAs);
    expect(declared).toBeDefined();
    expect((declared!.data as { truthful?: boolean }).truthful).toBe(false);
  });
});
