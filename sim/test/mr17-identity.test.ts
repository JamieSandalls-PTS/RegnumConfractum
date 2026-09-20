import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadContent } from '@rc/server/content';
import { GameServer } from '@rc/server/net/gateway';
import { MemoryStore } from '@rc/server/store/memory';
import { BotClient } from '../src/botClient';
import { TICK as SIM_TICK, sleep } from '../src/testTick';

/**
 * Identity (D-645): who others hear you called is chosen on the sheet, not
 * typed into a box before each line.
 *
 * Three names — real, hooded, disguised — and a radio between the first and
 * the last. Speaking under whichever is in use is a declaration (D-218),
 * contested by Insight the FIRST time a listener hears that name from you,
 * so switching from your real name to a disguise is exactly the moment a
 * sharp listener can notice something is off. This proves the wire end of it:
 * what a listener's line says the speaker is called, in each state.
 */

const contentDir = fileURLToPath(new URL('../../content', import.meta.url));
const TICK = SIM_TICK;

let server: GameServer;
let store: MemoryStore;
let a: BotClient;
let b: BotClient;
const characterIds = new Map<BotClient, string>();

async function heard(from: BotClient, to: BotClient, text: string): Promise<string> {
  const before = to.speeches.length;
  from.send({ t: 'say', channel: 'say', text });
  for (let i = 0; i < 100 && to.speeches.length === before; i++) await sleep(TICK * 4);
  const line = to.speeches[to.speeches.length - 1];
  if (!line || line.text !== text) throw new Error(`b did not hear "${text}"`);
  return line.speakerDescriptor;
}

beforeAll(async () => {
  store = new MemoryStore();
  server = new GameServer({
    store,
    content: loadContent(contentDir),
    port: 0,
    tickIntervalMs: TICK,
    rngSeed: 645,
    defaultAreaId: 'broken-yard',
  });
  await server.start();
  const join = async (user: string, name: string, seed: number): Promise<BotClient> => {
    const c = await BotClient.connect(`ws://127.0.0.1:${server.port}`);
    c.send({ t: 'register', username: user, password: 'password-word' });
    await c.expect('auth_ok');
    c.send({ t: 'create_character', name, appearanceSeed: seed });
    const made = await c.expect('character_created');
    characterIds.set(c, made.character.id);
    c.send({ t: 'enter_world', characterId: made.character.id });
    await c.expect('snapshot');
    return c;
  };
  a = await join('speaker', 'Aldric Vane', 21);
  b = await join('listener', 'Wren Dale', 22);
  // Side by side, in sight.
  const me = a.entities.get(a.you!)!;
  b.send({ t: 'move_to', x: me.x + 1, y: me.y });
  for (let i = 0; i < 200; i++) {
    const now = b.entities.get(b.you!)!;
    if (Math.hypot(now.x - me.x, now.y - me.y) < 1.4) break;
    await sleep(TICK * 4);
  }
  b.send({ t: 'move_stop' });
  await sleep(TICK * 8);
});

afterAll(async () => {
  a?.close();
  b?.close();
  await server?.stop();
});

describe('identity on the wire (D-645)', () => {
  it('the sheet carries three names, and the real one is the character\'s own', async () => {
    const id = a.status?.identity;
    expect(id?.real).toBe('Aldric Vane');
    expect(id?.hooded).toBeNull();
    expect(id?.disguised).toBeNull();
    expect(id?.use).toBe('real');
  });

  it('⚠ speaking under your real identity is how a stranger learns your name', async () => {
    expect(await heard(a, b, 'Well met.')).toBe('Aldric Vane');
  });

  it('a disguise, chosen, is what others hear — and it persists on the character', async () => {
    a.send({ t: 'set_identity', hooded: null, disguised: 'Gareth Hale', use: 'disguised' });
    for (let i = 0; i < 50 && a.status?.identity?.use !== 'disguised'; i++) await sleep(TICK * 4);
    expect(a.status?.identity?.disguised).toBe('Gareth Hale');
    expect(await heard(a, b, 'Call me Gareth.')).toBe('Gareth Hale');
    const saved = (await store.getCharacter(characterIds.get(a)!))?.identity;
    expect(saved?.use).toBe('disguised');
  });

  it('switching back to the real identity is heard as the real name again', async () => {
    a.send({ t: 'set_identity', hooded: null, disguised: 'Gareth Hale', use: 'real' });
    for (let i = 0; i < 50 && a.status?.identity?.use !== 'real'; i++) await sleep(TICK * 4);
    expect(await heard(a, b, 'No — Aldric, truly.')).toBe('Aldric Vane');
  });

  it('⚠ a hood with no hooded name says nothing about who you are; with one, it says that', async () => {
    a.send({ t: 'set_presentation', state: 'hooded' });
    await sleep(TICK * 8);
    const hoodedNoName = await heard(a, b, 'Evening.');
    expect(hoodedNoName).not.toBe('Aldric Vane');
    expect(hoodedNoName).not.toBe('Gareth Hale');
    a.send({ t: 'set_identity', hooded: 'The Grey Traveller', disguised: 'Gareth Hale', use: 'real' });
    for (let i = 0; i < 50 && a.status?.identity?.hooded !== 'The Grey Traveller'; i++) await sleep(TICK * 4);
    expect(await heard(a, b, 'Evening again.')).toBe('The Grey Traveller');
    // Hood down: the real name is back, and it was never overwritten by the hooded thread (D-219).
    a.send({ t: 'set_presentation', state: 'normal' });
    await sleep(TICK * 8);
    expect(await heard(a, b, 'It is me.')).toBe('Aldric Vane');
  });

  it('refuses a name that is not a name', async () => {
    const before = a.errors.length;
    a.send({ t: 'set_identity', hooded: null, disguised: 'x', use: 'disguised' });
    for (let i = 0; i < 50 && a.errors.length === before; i++) await sleep(TICK * 4);
    expect(a.errors.length).toBeGreaterThan(before);
  });
});
