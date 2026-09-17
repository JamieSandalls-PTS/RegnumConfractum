import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AreaSchema } from '@rc/shared';
import { loadContent } from '@rc/server/content';
import { hasLineOfSight } from '@rc/server/game/los';
import { GameServer } from '@rc/server/net/gateway';
import { MemoryStore } from '@rc/server/store/memory';
import {
  COMBAT_ROUND_TICKS,
  ObjectiveSchema,
  attackSpacingTicks,
  combatRoundOf,
  type ObjectiveDef,
} from '@rc/shared';
import { BotClient } from '../src/botClient';
import { TICK as SIM_TICK, sleep } from '../src/testTick';

/**
 * Combat rounds, weapon reach, the town watch and the well (D-550 – D-552).
 *
 * Everything here is a rule a player would otherwise have to discover by
 * being surprised by it: how many times you may swing in four seconds,
 * whether a bow shoots through a wall, whether the guards saw you, and what
 * happens to somebody who drinks after the antagonist has been at the water.
 */

const contentDir = fileURLToPath(new URL('../../content', import.meta.url));
const TICK = SIM_TICK; // see sim/src/testTick.ts (D-633)
const SURVIVE: ObjectiveDef = ObjectiveSchema.parse({
  id: 'survive-test',
  name: 'Last the night',
  brief: 'Be standing when it is over.',
  kind: { type: 'survive' },
  // The SCHEMA floor is two (D-522's cast minimum is a design rule, not a
  // test knob); the server's own `minCast` is what lets one bot play.
  minCast: 2,
});

let store: MemoryStore;
let server: GameServer;
/**
 * A bot that joins once and stays for the whole file.
 *
 * The round refuses to start when no live objective is playable at the
 * current cast size, and `survive` needs two (D-522's floor is a design rule,
 * not a test knob). Without this the lobby sits there forever and every test
 * that waits for a running round times out with a message about the round
 * rather than about what it was actually testing.
 */
let filler: Player;

beforeAll(async () => {
  store = new MemoryStore();
  server = new GameServer({
    store,
    content: loadContent(contentDir),
    port: 0,
    tickIntervalMs: TICK,
    rngSeed: 404,
    defaultAreaId: 'round-town',
    round: {
      enabled: true,
      // ⚠ This fixture stands characters in a chosen area with
      // `saveCharacterPosition` and asserts what they can see from there, so
      // it opts OUT of D-608's rule that an arrival is placed at the round's
      // opening point and reset. The rule is right for players joining a
      // game and wrong for a fixture whose whole question is 'what happens
      // to a body standing HERE'.
      placeArrivals: false,
      minCast: 2,
      lengthTicks: 200_000,
      objectives: [SURVIVE],
      resolutionTicks: 10,
      seed: 'watch-test',
      // No dawn truce (D-536): this suite is about blows landing, and a
      // 60-second peace at the opening is only dead time here. The one test
      // that cares waits for `graceTicks` to be zero regardless.
      graceTicks: 0,
    },
  });
  await server.start();
  filler = await join('watch_filler', 'Still Aldren', 'physician', { x: 8, y: 8 });
});

afterAll(async () => {
  filler?.bot.close();
  await server.stop();
});


async function waitUntil(check: () => boolean, what: string, ms = 8000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${what}`);
}

interface Player {
  bot: BotClient;
  characterId: string;
}

async function join(
  username: string,
  name: string,
  classId: string,
  at?: { x: number; y: number },
): Promise<Player> {
  const bot = await BotClient.connect(`ws://127.0.0.1:${server.port}`);
  bot.send({ t: 'register', username, password: 'password-word' });
  await bot.expect('auth_ok');
  bot.send({
    t: 'create_character',
    name,
    appearanceSeed: 5000 + username.length,
    classId,
    build: { attributes: {}, skills: {}, feats: [], spells: [] },
  } as never);
  const characterId = (await bot.expect('character_created')).character.id;
  if (at) await store.saveCharacterPosition(characterId, 'round-town', at.x, at.y);
  bot.send({ t: 'enter_world', characterId });
  await bot.expect('snapshot');
  return { bot, characterId };
}

describe('the combat round (D-550)', () => {
  /**
   * The headline rule: a basic character gets ONE swing in four seconds. The
   * server refuses the second, and the refusal is what makes the round a rule
   * rather than a suggestion the client is trusted to honour (D-102).
   */
  it('gives a basic character one attack in a round and refuses the second', async () => {
    const p = await join('cr_basic', 'Odo Kell', 'man-at-arms');
    const status = await p.bot.expect('status');
    expect(status.attacksPerRound).toBe(1);

    // Something to hit that is not a player, placed beside where the player
    // ACTUALLY is. Writing a position to the store and resyncing does not move
    // a character who is already in the world — the entity is live, and the
    // stored row is only where it will wake up next time.
    const me = p.bot.entities.get(p.bot.you!)!;
    const target = server.spawnNpc('round-town', {
      x: me.x + 1,
      y: me.y,
      descriptor: 'a straw man',
    });

    p.bot.send({ t: 'attack', targetEntityId: target });
    p.bot.send({ t: 'attack', targetEntityId: target });
    const err = await p.bot.expect('error');
    expect(err.code).toBe('on_cooldown');
    await p.bot.close();
  });

  it('agrees with the client about where a round begins and ends', () => {
    // Both sides compute this, so they had better be the same function.
    expect(combatRoundOf(0)).toBe(0);
    expect(combatRoundOf(COMBAT_ROUND_TICKS - 1)).toBe(0);
    expect(combatRoundOf(COMBAT_ROUND_TICKS)).toBe(1);
  });

  /**
   * Spacing, not just a budget. Without it two attacks could land on
   * consecutive ticks across a round boundary — four blows in under a second,
   * which is the twitch combat D-104 ruled out.
   */
  it('spaces the swings across the round rather than allowing a burst', () => {
    expect(attackSpacingTicks(1)).toBe(COMBAT_ROUND_TICKS);
    expect(attackSpacingTicks(2)).toBe(COMBAT_ROUND_TICKS / 2);
    // Never zero, whatever nonsense is passed in.
    expect(attackSpacingTicks(0)).toBeGreaterThan(0);
    expect(attackSpacingTicks(99)).toBeGreaterThan(0);
  });
});

describe('reach comes from the weapon (D-550)', () => {
  it('lets a bow strike from further than an arm', async () => {
    const p = await join('cr_bow', 'Nessa Vane', 'hunter');
    const status = await p.bot.expect('status');
    // The hunter's kit has the bow in hand.
    expect(status.reach).toBeGreaterThan(1);
    await p.bot.close();
  });

  it('gives a sword arm’s length, and says so in metres', async () => {
    const p = await join('cr_sword', 'Ordric Kell', 'man-at-arms');
    const status = await p.bot.expect('status');
    // ⚠ 1.5m, not 1 (D-567). Chebyshev called a diagonal neighbour 1 away when
    // it is 1.41, so leaving the number alone while changing the metric would
    // have made every diagonal swing miss for reasons nothing in the UI could
    // explain. This asserts the FLOAT: it was `.int()` on the wire, and a
    // fractional reach silently dropped the whole status message.
    expect(status.reach).toBeCloseTo(1.5, 6);
    await p.bot.close();
  });
});

describe('the town watch (D-552)', () => {
  /**
   * The whole design in one test: a guard does not hunt on sight. It walks
   * its round until it witnesses something, and the answer to the watch is
   * not to fight them, it is not to be seen.
   */
  it('leaves an innocent alone', async () => {
    const p = await join('watch_clean', 'Meek Aldren', 'physician', { x: 25, y: 31 });
    await waitUntil(() => p.bot.roundState?.phase === 'running', 'the round begins');
    const first = p.bot.status!.hp;
    // Long enough for a guard to have crossed the square several times.
    await sleep(1500);
    expect(p.bot.status!.hp).toBe(first);
    await p.bot.close();
  });

  it('is on the map for the whole round, day and night', async () => {
    const p = await join('watch_present', 'Watchful Aldren', 'physician', { x: 25, y: 31 });
    await waitUntil(() => p.bot.roundState?.phase === 'running', 'the round begins');
    await waitUntil(
      () => [...p.bot.entities.values()].some((e) => e.descriptor.includes('watchman')),
      'a watchman is somewhere in Ashfold',
    );
    await p.bot.close();
  });

  /**
   * Striking somebody in the square is seen, and the culprit is told so —
   * and NOBODY else is. Whoever did it knows; the rest of the cast has to be
   * told by a person, which is the only kind of evidence this game recognises
   * (D-217).
   */
  it('sees a killing in the open square, and tells only the killer', async () => {
    // ⚠ In the SQUARE, beside the well, which is where the watch actually
    // walks (D-549 put the well in the open between the tavern door and the
    // south gate precisely so that using it is public). The old coordinates
    // were two buildings south and worked only because the map was a tile
    // grid; once the town was rebuilt from pack meshes a guard eight metres
    // away had a wall between it and the killing, and the test timed out
    // reporting the watch as broken when it was doing its job.
    // ⚠ Both of these must be somewhere a body FITS. Moving the killer to
    // (25,33) to be "in the square" put it inside a wall mask, the server
    // relocated it to the area spawn eight metres away, and every blow fell
    // short — which looked exactly like the watch being broken.
    const killer = await join('watch_killer', 'Bloody Aldren', 'man-at-arms', { x: 25, y: 31 });
    const bystander = await join('watch_witness', 'Quiet Aldren', 'physician', { x: 25, y: 32 });
    await waitUntil(() => killer.bot.roundState?.phase === 'running', 'the round begins');
    // The dawn truce has to lift before anybody can be struck (D-536).
    await waitUntil(() => (killer.bot.roundState?.graceTicks ?? 1) === 0, 'the truce lifts', 20_000);

    // ⚠ Struck REPEATEDLY, because witnessing happens at the moment of the
    // blow (D-552) and the watch is walking a round. One swing only ever
    // passed when a guard happened to be looking at that instant — a coin
    // toss the suite had been winning. What D-552 actually promises is that
    // you cannot keep killing in the open square without being seen, and that
    // is what this now tests.
    const seen = (): boolean =>
      killer.bot.narrations.join(' ').includes('watchman has seen you');
    for (let i = 0; i < 40 && !seen(); i++) {
      const victim = server.spawnNpc('round-town', {
        x: 26,
        y: 31,
        descriptor: 'a stranger',
      });
      killer.bot.send({ t: 'attack', targetEntityId: victim });
      await sleep(TICK * 60);
    }
    if (!seen()) {
      const me = killer.bot.entities.get(killer.bot.you!)!;
      const town = AreaSchema.parse(
        JSON.parse(readFileSync(`${contentDir}/areas/round-town.json`, 'utf8')),
      );
      const watch = [...killer.bot.entities.values()]
        .filter((e) => e.descriptor.includes('watchman'))
        .map((e) => ({
          at: `${e.x.toFixed(1)},${e.y.toFixed(1)}`,
          d: +Math.hypot(e.x - me.x, e.y - me.y).toFixed(1),
          los: hasLineOfSight(town, { x: e.x, y: e.y }, { x: me.x, y: me.y }),
        }));
      throw new Error(
        `the watch never saw a killing | me=${me.x.toFixed(1)},${me.y.toFixed(1)}` +
          ` | watch=${JSON.stringify(watch)}` +
          ` | attacked=${killer.bot.attacks.length}`,
      );
    }
    // The bystander was standing right there and is told nothing by the game.
    expect(bystander.bot.narrations.join(' ')).not.toContain('watchman has seen you');
    await killer.bot.close();
    await bystander.bot.close();
  });
});

describe('the well (D-529, built in D-552)', () => {
  it('refuses to spoil water you are not standing at', async () => {
    const p = await join('well_far', 'Distant Aldren', 'shade', { x: 6, y: 6 });
    await waitUntil(() => p.bot.roundState?.phase === 'running', 'the round begins');
    p.bot.send({ t: 'poison_well' } as never);
    const err = await p.bot.expect('error');
    expect(err.code).toBe('no_water_here');
    await p.bot.close();
  });

  it('refuses when you have nothing to put in it', async () => {
    const content = loadContent(contentDir);
    const well = content.areas.get('round-town')!.stations.find((s) => s.type === 'well')!;
    const p = await join('well_empty', 'Empty Aldren', 'shade', { x: well.x, y: well.y + 1 });
    await waitUntil(() => p.bot.roundState?.phase === 'running', 'the round begins');
    p.bot.send({ t: 'poison_well' } as never);
    const err = await p.bot.expect('error');
    expect(err.code).toBe('missing_materials');
    await p.bot.close();
  });

  /**
   * The act itself, and the thing that makes it worth doing: the water stops
   * being water. Nothing announces it — the well looks exactly the same, and
   * the only way anybody learns is by drinking or by having watched.
   */
  it('spoils the water, and the next drink hurts', async () => {
    const content = loadContent(contentDir);
    const well = content.areas.get('round-town')!.stations.find((s) => s.type === 'well')!;
    const p = await join('well_poison', 'Sour Aldren', 'shade', { x: well.x, y: well.y + 1 });
    await waitUntil(() => p.bot.roundState?.phase === 'running', 'the round begins');
    await store.grantItem(p.characterId, 'bitterleaf', 1);
    p.bot.send({ t: 'resync' });
    await p.bot.expect('snapshot');

    p.bot.send({ t: 'poison_well' } as never);
    await waitUntil(
      () => p.bot.narrations.join(' ').includes('takes it without a sound'),
      'the well is spoiled',
    );

    const before = p.bot.status!.hp;
    p.bot.send({ t: 'drink' });
    await waitUntil(
      () => p.bot.narrations.join(' ').includes('burns going down'),
      'the water is wrong',
    );
    expect(p.bot.status!.hp).toBeLessThan(before);
    await p.bot.close();
  });
});

describe('the hotbar belongs to the character (D-553)', () => {
  it('comes back on the next login, not from the browser', async () => {
    const p = await join('bar_save', 'Tidy Aldren', 'physician');
    await p.bot.expect('status');
    const arrangement = ['treat', null, 'loot', null, null, null, null, null, 'attack'];
    p.bot.send({ t: 'set_hotbar', slots: arrangement } as never);
    await sleep(120);
    p.bot.close();

    const again = await BotClient.connect(`ws://127.0.0.1:${server.port}`);
    again.send({ t: 'login', username: 'bar_save', password: 'password-word' });
    await again.expect('auth_ok');
    again.send({ t: 'enter_world', characterId: p.characterId });
    await again.expect('snapshot');
    const status = await again.expect('status');
    expect(status.hotbar).toEqual(arrangement);
    await again.close();
  });

  it('starts null so a fresh character gets the defaults', async () => {
    const p = await join('bar_fresh', 'New Aldren', 'physician');
    const status = await p.bot.expect('status');
    expect(status.hotbar).toBeNull();
    await p.bot.close();
  });
});
