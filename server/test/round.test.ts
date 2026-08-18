import { describe, expect, it } from 'vitest';
import {
  ObjectiveSchema,
  ROUND_DAY_TICKS,
  ROUND_TICKS_PER_GAME_HOUR,
  Rng,
  isNight,
  roundHour,
  roundPhaseOfDay,
  winnerFor,
  type ObjectiveDef,
} from '@rc/shared';
import { RoundEngine, type CastMember } from '@rc/server/game/round';

/**
 * The round engine (D-521), tested headlessly and deterministically — which
 * is the only review this code gets (D-114). What is asserted here is not
 * "does it run" but the properties the design depends on:
 *
 *   - a round never starts below the minimum cast, and never selects an
 *     objective it cannot resolve ('planned' content)
 *   - the antagonist's briefing reaches the antagonist and nobody else
 *   - every victory condition resolves, including 'survive', which inverts
 *     the clock
 *   - assignment is random, so "X was the traitor last round" is worthless
 *     (D-524 depends on this to justify keeping faces across rounds)
 */

const objective = (over: Partial<ObjectiveDef> & { id: string }): ObjectiveDef =>
  ObjectiveSchema.parse({
    name: over.id,
    brief: `brief for ${over.id}`,
    kind: { type: 'survive' },
    ...over,
  });

const KILL_KEEPER = objective({
  id: 'kill-keeper',
  kind: { type: 'kill_npc', descriptor: 'the keeper' },
});
const SURVIVE = objective({ id: 'survive-it', kind: { type: 'survive' } });
const ASSASSINATE = objective({ id: 'assassinate', kind: { type: 'kill_player' }, minCast: 5 });
const PLANNED = objective({ id: 'planned-one', status: 'planned' });

const cast = (n: number): CastMember[] =>
  Array.from({ length: n }, (_, i) => ({ characterId: `char-${i}`, entityId: 100 + i }));

function engine(objectives: ObjectiveDef[], seed = 'seed-1', lengthTicks = 1000) {
  return new RoundEngine({ objectives, rng: new Rng(seed), lengthTicks, minCast: 3 });
}

describe('starting a round', () => {
  it('refuses a cast below the minimum', () => {
    const e = engine([KILL_KEEPER]);
    expect(e.start(cast(2), 0)).toBeNull();
    expect(e.phase).toBe('lobby');
    expect(e.start(cast(3), 0)).not.toBeNull();
    expect(e.phase).toBe('running');
  });

  it('never selects a planned objective, and stays in lobby if that leaves none', () => {
    const e = engine([PLANNED]);
    expect(e.eligibleObjectives(5)).toEqual([]);
    expect(e.start(cast(5), 0)).toBeNull();
    expect(e.phase).toBe('lobby');
  });

  it('respects an objective minimum cast — assassination is not for three', () => {
    const e = engine([ASSASSINATE]);
    expect(e.eligibleObjectives(3)).toEqual([]);
    expect(e.eligibleObjectives(5).map((o) => o.id)).toEqual(['assassinate']);
  });

  it('draws a kill_player target who is not the antagonist', () => {
    for (let i = 0; i < 50; i++) {
      const e = engine([ASSASSINATE], `seed-${i}`);
      const a = e.start(cast(6), 0)!;
      expect(a.targetCharacterId).not.toBeNull();
      expect(a.targetCharacterId).not.toBe(a.antagonistCharacterId);
    }
  });
});

describe('the secret', () => {
  it('gives the brief to the antagonist and nothing to anyone else', () => {
    const e = engine([KILL_KEEPER]);
    const a = e.start(cast(4), 0)!;
    expect(e.secretRole(a.antagonistCharacterId)?.objective.id).toBe('kill-keeper');
    for (const c of cast(4)) {
      if (c.characterId === a.antagonistCharacterId) continue;
      expect(e.secretRole(c.characterId)).toBeNull();
      expect(e.isAntagonist(c.characterId)).toBe(false);
    }
  });
});

describe('resolving', () => {
  it('cast wins when the antagonist falls', () => {
    const e = engine([KILL_KEEPER]);
    const a = e.start(cast(4), 0)!;
    e.noteCharacterDeath(a.antagonistCharacterId);
    const r = e.evaluate(10)!;
    expect(r.outcome).toBe('antagonist_dead');
    expect(r.winner).toBe('cast');
    expect(e.phase).toBe('resolved');
  });

  it('antagonist wins when the whole cast falls', () => {
    const e = engine([KILL_KEEPER]);
    const a = e.start(cast(4), 0)!;
    for (const c of cast(4)) {
      if (c.characterId !== a.antagonistCharacterId) e.noteCharacterDeath(c.characterId);
    }
    const r = e.evaluate(10)!;
    expect(r.outcome).toBe('cast_wiped');
    expect(r.winner).toBe('antagonist');
  });

  it('antagonist wins when the named NPC dies', () => {
    const e = engine([KILL_KEEPER]);
    e.start(cast(4), 0);
    e.noteNpcDeath('some other npc');
    expect(e.evaluate(10)).toBeNull();
    e.noteNpcDeath('the keeper');
    const r = e.evaluate(11)!;
    expect(r.outcome).toBe('objective_complete');
    expect(r.winner).toBe('antagonist');
  });

  it('a completed objective stands even if the antagonist dies in the same tick', () => {
    const e = engine([KILL_KEEPER]);
    const a = e.start(cast(4), 0)!;
    e.noteNpcDeath('the keeper');
    e.noteCharacterDeath(a.antagonistCharacterId);
    expect(e.evaluate(10)!.outcome).toBe('objective_complete');
  });

  it('cast wins when the clock runs out on an ordinary objective', () => {
    const e = engine([KILL_KEEPER], 'seed-1', 1000);
    e.start(cast(4), 0);
    expect(e.evaluate(999)).toBeNull();
    const r = e.evaluate(1000)!;
    expect(r.outcome).toBe('time_expired');
    expect(r.winner).toBe('cast');
  });

  it("'survive' inverts the clock — the same deadline is an antagonist win", () => {
    const e = engine([SURVIVE], 'seed-1', 1000);
    e.start(cast(4), 0);
    const r = e.evaluate(1000)!;
    expect(r.outcome).toBe('objective_complete');
    expect(r.winner).toBe('antagonist');
  });

  it("'survive' is lost if the antagonist is found first", () => {
    const e = engine([SURVIVE], 'seed-1', 1000);
    const a = e.start(cast(4), 0)!;
    e.noteCharacterDeath(a.antagonistCharacterId);
    expect(e.evaluate(500)!.outcome).toBe('antagonist_dead');
  });

  it('kill_player completes on any death of the target', () => {
    const e = engine([ASSASSINATE]);
    const a = e.start(cast(6), 0)!;
    e.noteCharacterDeath(a.targetCharacterId!);
    expect(e.evaluate(10)!.outcome).toBe('objective_complete');
  });

  it('stops resolving once resolved, and reset returns it to lobby', () => {
    const e = engine([KILL_KEEPER]);
    const a = e.start(cast(4), 0)!;
    e.noteCharacterDeath(a.antagonistCharacterId);
    expect(e.evaluate(10)).not.toBeNull();
    expect(e.evaluate(11)).toBeNull();
    e.reset();
    expect(e.phase).toBe('lobby');
    expect(e.secretRole(a.antagonistCharacterId)).toBeNull();
  });
});

describe('assignment is random (D-524 depends on this)', () => {
  it('spreads the antagonist across the cast over many rounds', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const e = engine([KILL_KEEPER], `round-${i}`);
      seen.add(e.start(cast(4), 0)!.antagonistCharacterId);
    }
    // Every seat must be able to draw the short straw; a biased selection
    // would make past rounds predictive and undo D-524's face-persistence.
    expect(seen.size).toBe(4);
  });

  it('is reproducible for a given seed — the harness can replay a round', () => {
    const a = engine([KILL_KEEPER, SURVIVE], 'fixed').start(cast(5), 0)!;
    const b = engine([KILL_KEEPER, SURVIVE], 'fixed').start(cast(5), 0)!;
    expect(a.antagonistCharacterId).toBe(b.antagonistCharacterId);
    expect(a.objective.id).toBe(b.objective.id);
  });
});

describe('the day-night cycle (D-527)', () => {
  it('is ten real minutes, split evenly', () => {
    expect(ROUND_DAY_TICKS).toBe(6000); // 10 min at 10Hz
    expect(ROUND_TICKS_PER_GAME_HOUR).toBe(250); // a game hour is 25s
    let night = 0;
    for (let t = 0; t < ROUND_DAY_TICKS; t++) if (isNight(t)) night++;
    expect(night).toBe(ROUND_DAY_TICKS / 2);
  });

  it('opens at dawn, turns at dusk, and wraps', () => {
    expect(roundHour(0)).toBe(6); // the round begins at first light
    expect(roundPhaseOfDay(0)).toBe('day');
    expect(roundPhaseOfDay(11 * ROUND_TICKS_PER_GAME_HOUR)).toBe('day'); // 17:00
    expect(roundPhaseOfDay(12 * ROUND_TICKS_PER_GAME_HOUR)).toBe('night'); // 18:00
    expect(roundPhaseOfDay(23 * ROUND_TICKS_PER_GAME_HOUR)).toBe('night'); // 05:00
    expect(roundHour(ROUND_DAY_TICKS)).toBe(6); // one full cycle: dawn again
  });

  it('gives a 25-minute round exactly two nights, opening and closing in day', () => {
    const ROUND = 15_000;
    let transitions = 0;
    for (let t = 1; t < ROUND; t++) if (isNight(t) !== isNight(t - 1)) transitions++;
    // day → night → day → night → day is four transitions, two nights.
    expect(transitions).toBe(4);
    expect(roundPhaseOfDay(0)).toBe('day'); // opens in daylight
    expect(roundPhaseOfDay(ROUND - 1)).toBe('day'); // and closes in it
  });
});

describe('outcome-to-winner mapping is defined once', () => {
  it('never lets the client infer a winner', () => {
    expect(winnerFor('antagonist_dead')).toBe('cast');
    expect(winnerFor('time_expired')).toBe('cast');
    expect(winnerFor('cast_wiped')).toBe('antagonist');
    expect(winnerFor('objective_complete')).toBe('antagonist');
    expect(winnerFor('abandoned')).toBe('nobody');
  });
});
