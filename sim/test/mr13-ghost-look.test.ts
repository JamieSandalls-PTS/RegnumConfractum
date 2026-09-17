import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadContent } from '@rc/server/content';
import { GameServer } from '@rc/server/net/gateway';
import { MemoryStore } from '@rc/server/store/memory';
import { BotClient } from '../src/botClient';

/**
 * The dead are drawn as their race's ghost (D-632).
 *
 * A race may name a `content/characters/` definition as its ghost look. When
 * a member dies, the entity other GHOSTS see carries that model, and the
 * dying player is told to draw themselves the same way. The living are told
 * nothing — they see the fall and then nothing at all (D-203), and a model
 * change for someone you cannot see would be a fact about the dead leaking
 * into the world of the living.
 */

const contentDir = fileURLToPath(new URL('../../content', import.meta.url));
const TICK = 5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const GHOST = 'character-ghost-02';

let store: MemoryStore;
let server: GameServer;
let killer: BotClient;
let victim: BotClient;
let second: BotClient;
let victimEntity: number;
let secondEntity: number;

async function join(bot: BotClient, username: string, name: string, seed: number) {
  bot.send({ t: 'register', username, password: 'password-word' });
  await bot.expect('auth_ok');
  bot.send({ t: 'create_character', name, appearanceSeed: seed, raceId: 'human' });
  const characterId = (await bot.expect('character_created')).character.id;
  bot.send({ t: 'enter_world', characterId });
  const snap = await bot.expect('snapshot');
  return { characterId, entityId: snap.you };
}

async function attackUntilDead(attacker: BotClient, targetId: number): Promise<void> {
  for (let i = 0; i < 400; i++) {
    attacker.send({ t: 'attack', targetEntityId: targetId });
    await sleep(TICK * 3);
    if (!attacker.entities.has(targetId)) return;
  }
  throw new Error('target refused to die');
}

beforeAll(async () => {
  const content = loadContent(contentDir);
  // The rule under test, stated in the fixture rather than read off a file
  // somebody may retune.
  content.races.get('human')!.ghost = GHOST;
  expect(content.characters.has(GHOST)).toBe(true);
  store = new MemoryStore();
  server = new GameServer({
    store,
    content,
    port: 0,
    tickIntervalMs: TICK,
    rngSeed: 17,
    // The yard is open wilderness: no spoken declaration before a blow
    // (D-206), so the killing is quick and the test is about the ghost.
    defaultAreaId: 'broken-yard',
    ghostMinTicks: 400,
    attackCooldownTicks: 2,
    watch: false,
  });
  await server.start();
  const url = `ws://127.0.0.1:${server.port}`;
  killer = await BotClient.connect(url);
  victim = await BotClient.connect(url);
  second = await BotClient.connect(url);
  await join(killer, 'ghost_killer', 'Hale Marrow', 601);
  ({ entityId: victimEntity } = await join(victim, 'ghost_victim', 'Wren Ashby', 602));
  ({ entityId: secondEntity } = await join(second, 'ghost_second', 'Tobin Sallow', 603));
});

afterAll(async () => {
  killer?.close();
  victim?.close();
  second?.close();
  await server?.stop();
});

describe('the ghost look', () => {
  it('⚠ the dying player is told to draw themselves as the ghost; the living are told nothing', async () => {
    victim.drain('delta');
    await attackUntilDead(killer, victimEntity);
    // Wait for the death to land on the victim's own wire.
    let told: { model: string | null } | null = null;
    for (let i = 0; i < 200 && !told; i++) {
      const own = victim.entities.get(victimEntity) as { model?: string } | undefined;
      if (own?.model === GHOST) told = { model: own.model };
      await sleep(TICK * 2);
    }
    expect(told?.model, 'the victim was not told to draw themselves as the ghost').toBe(GHOST);
    expect(victim.status?.ghost).toBe(true);
    // The killer, alive, has dropped the victim and knows nothing of a ghost look.
    expect(killer.entities.has(victimEntity)).toBe(false);
    expect(killer.violations).toEqual([]);
    expect(victim.violations).toEqual([]);
  });

  it('⚠ another ghost sees the dead as the ghost look, not as the person', async () => {
    await attackUntilDead(killer, secondEntity);
    // The second, now dead, is greeted by the first ghost's entity — carrying
    // the model — and the first is told about the second the same way.
    let seen: { model?: string } | undefined;
    for (let i = 0; i < 200; i++) {
      seen = second.entities.get(victimEntity) as { model?: string } | undefined;
      if (seen?.model) break;
      await sleep(TICK * 2);
    }
    expect(seen?.model, 'a ghost saw the other dead as a living person').toBe(GHOST);
    let back: { model?: string } | undefined;
    for (let i = 0; i < 200; i++) {
      back = victim.entities.get(secondEntity) as { model?: string } | undefined;
      if (back?.model) break;
      await sleep(TICK * 2);
    }
    expect(back?.model).toBe(GHOST);
    expect(second.violations).toEqual([]);
  });
});
