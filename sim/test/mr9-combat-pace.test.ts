import { describe, expect, it } from 'vitest';
import { RUN_SPEED, WALK_SPEED, speedFor } from '@rc/shared';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { NpcDefSchema, RoamerSchema } from '@rc/shared';

/**
 * Combat pace (D-619).
 *
 * The stakeholder's note was that a fight at level 1 is over in seconds — not
 * because the rounds are too short, but because nothing about a fight moves:
 * the man swinging and the man running away travelled at one speed, the watch
 * advanced slower than a walking player and so never arrived, and the keeper
 * an objective is built around had the world's test-fixture default of ten
 * hit points.
 *
 * ⚠ Every number here is UNRATIFIED. What these assertions protect is the
 * SHAPE — a fighter is faster than a walker, the watch is not capped below its
 * own speed, and a named objective is not a three-swing NPC — so that moving a
 * magnitude is a decision somebody makes rather than a regression nobody sees.
 */

const contentDir = fileURLToPath(new URL('../../content', import.meta.url));

describe('a body with its weapon up runs', () => {
  it('moves faster in combat than out of it', () => {
    expect(speedFor(true)).toBe(RUN_SPEED);
    expect(speedFor(false)).toBe(WALK_SPEED);
    expect(RUN_SPEED).toBeGreaterThan(WALK_SPEED);
  });

  it('is bounded: a runner opens ground over a combat round, but not a duel', () => {
    // ⚠ The reason it is 1.45x rather than 2x. A four-second round (D-550)
    // with reach at 1.5m: doubling the speed lets a body leave and return
    // between two swings, which makes a non-twitch game (D-104) into kiting.
    const roundSeconds = 4;
    const gained = (RUN_SPEED - WALK_SPEED) * roundSeconds;
    expect(gained).toBeGreaterThan(3); // enough to break away
    expect(gained).toBeLessThan(12); // not enough to fight out of reach
  });

});

describe('the watch can reach the man it saw', () => {
  const guard = RoamerSchema.parse(
    JSON.parse(readFileSync(`${contentDir}/roamers/town-guard.json`, 'utf8')),
  );

  it('is not capped below the speed it is allowed to move at', () => {
    // ⚠ This is the measurement that mattered, and it is not a damage number.
    // A roamer lays down one metre of route every `moveCooldownTicks`, so the
    // cadence is a SPEED LIMIT: at 4 ticks the watch was held to 2.5 m/s
    // against a player walking at 2.9, and could never catch anybody who
    // simply left. The cap has to sit above the speed, or the guard's own
    // legs are irrelevant.
    const metresPerSecondCap = 1 / (guard.moveCooldownTicks / 10);
    expect(metresPerSecondCap).toBeGreaterThan(WALK_SPEED);
    expect(metresPerSecondCap).toBeGreaterThanOrEqual(RUN_SPEED);
  });

  it('hits hard enough that arriving matters', () => {
    expect(guard.damageMin).toBeGreaterThanOrEqual(4);
    expect(guard.damageMax).toBeGreaterThanOrEqual(9);
  });

  it('still pays nothing for killing it', () => {
    // D-552: the moment the watch is worth xp or loot, murdering it is a
    // farming strategy. None of the re-tune touches that.
    expect(guard.xp).toBe(0);
    expect(guard.loot).toHaveLength(0);
  });
});

describe('a named objective is not a three-swing NPC', () => {
  it('gives both keepers hit points worth a fight', () => {
    for (const id of ['ashfold-keeper', 'ferryman-keeper']) {
      const def = NpcDefSchema.parse(
        JSON.parse(readFileSync(`${contentDir}/npcs/${id}.json`, 'utf8')),
      );
      // A level-1 swordsman deals about 2.1 a swing, one swing per four-second
      // round: this is "about a minute in the open", not "three swings".
      expect(def.hp).toBeGreaterThanOrEqual(30);
    }
  });

  it('leaves an unauthored NPC exactly where it was', () => {
    // ⚠ The default is the old hardcoded spawn value. A townsman is not
    // supposed to be hard to kill, and a schema default that raised every NPC
    // in the world would be a silent rebalance of content nobody edited.
    expect(NpcDefSchema.parse({ id: 'x', name: 'x', descriptor: 'x' }).hp).toBe(10);
  });
});
