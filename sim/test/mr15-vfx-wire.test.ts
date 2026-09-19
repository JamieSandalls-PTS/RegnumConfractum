import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadContent } from '@rc/server/content';
import { GameServer } from '@rc/server/net/gateway';
import { MemoryStore } from '@rc/server/store/memory';
import { BotClient } from '../src/botClient';
import { TICK as SIM_TICK, sleep } from '../src/testTick';

/**
 * Effects reach the wire (D-639).
 *
 * The renderer is tested headless in `client/test/vfx.test.ts`; this proves
 * the three things the server has to say for any of it to draw in play:
 * the catalogue arrives with `render_content`, the glow on a held weapon
 * rides on `worn` for everybody watching, and a blow from a weapon that
 * fires carries what it SHOWS — resolved off the item, so a client never
 * needs the item catalogue to draw a fight.
 */

const contentDir = fileURLToPath(new URL('../../content', import.meta.url));
const TICK = SIM_TICK;

let store: MemoryStore;
let server: GameServer;
let caster: BotClient;
let casterId: string;
let victim: BotClient;
let victimEntity: number;

beforeAll(async () => {
  store = new MemoryStore();
  server = new GameServer({
    store,
    content: loadContent(contentDir),
    port: 0,
    tickIntervalMs: TICK,
    rngSeed: 639,
    defaultAreaId: 'broken-yard',
  });
  await server.start();

  caster = await BotClient.connect(`ws://127.0.0.1:${server.port}`);
  caster.send({ t: 'register', username: 'vfxcaster', password: 'password-word' });
  await caster.expect('auth_ok');
  caster.send({ t: 'create_character', name: 'Ysolde Marr', appearanceSeed: 11 });
  casterId = (await caster.expect('character_created')).character.id;
  caster.send({ t: 'enter_world', characterId: casterId });
  await caster.expect('snapshot');

  victim = await BotClient.connect(`ws://127.0.0.1:${server.port}`);
  victim.send({ t: 'register', username: 'vfxtarget', password: 'password-word' });
  await victim.expect('auth_ok');
  victim.send({ t: 'create_character', name: 'Tam Reed', appearanceSeed: 12 });
  const v = (await victim.expect('character_created')).character.id;
  victim.send({ t: 'enter_world', characterId: v });
  await victim.expect('snapshot');
  victimEntity = victim.you!;

  const me = caster.entities.get(caster.you!)!;
  victim.send({ t: 'move_to', x: me.x + 0.8, y: me.y });
  for (let i = 0; i < 200; i++) {
    const now = victim.entities.get(victimEntity)!;
    if (Math.hypot(now.x - me.x, now.y - me.y) < 1.2) break;
    await sleep(TICK * 4);
  }
  victim.send({ t: 'move_stop' });
  await sleep(TICK * 8);
});

afterAll(async () => {
  caster?.close();
  victim?.close();
  await server?.stop();
});

describe('effects on the wire (D-639)', () => {
  it('the catalogue arrives with render_content, and the shipped effects are in it', async () => {
    const fresh = await BotClient.connect(`ws://127.0.0.1:${server.port}`);
    try {
      const rc = await fresh.expect('render_content');
      const ids = rc.vfx.map((v) => v.id);
      expect(ids).toContain('hearth-fire');
      expect(ids).toContain('arcane-bolt');
      expect(rc.vfx.find((v) => v.id === 'hearth-fire')?.loop).toBe(true);
    } finally {
      fresh.close();
    }
  });

  it('⚠ the glow on a drawn weapon rides on `worn`, for everybody watching', async () => {
    const staff = await store.grantItem(casterId, 'apprentice-staff', 1);
    caster.send({ t: 'equip', itemId: staff.id });
    const deadline = Date.now() + 5000;
    let seen: string | undefined;
    while (Date.now() < deadline) {
      seen = victim.entities.get(caster.you!)?.worn?.weaponVfx;
      if (seen) break;
      await sleep(TICK * 4);
    }
    expect(seen, 'the victim sees the caster\'s staff glowing').toBe('ember-glow');
  });

  it('⚠ a blow from a weapon that fires carries what it shows, resolved off the item', async () => {
    let show: unknown;
    for (let i = 0; i < 40 && !show; i++) {
      caster.send({ t: 'attack', targetEntityId: victimEntity });
      await sleep(TICK * 4);
      for (const a of victim.attacks.splice(0)) {
        if (a.attackerId === caster.you && a.show) show = a.show;
      }
    }
    expect(show).toEqual({
      projectile: { vfx: 'arcane-bolt', speed: 14, arc: 0.4 },
      impact: 'arcane-burst',
    });
  }, 30_000);
});
