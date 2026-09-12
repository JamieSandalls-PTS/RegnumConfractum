import { describe, expect, it } from 'vitest';
import {
  castCoverageProblem,
  objectiveProblems,
  recipeProblems,
  roamerProblems,
  type ObjectiveDef,
  type RecipeDef,
  type RoamerDef,
} from '../src';

/**
 * The rules behind the round-content editor (D-569).
 *
 * ⚠ These functions are the ONE implementation: `validate-content.ts` calls
 * them in CI and the authoring server calls them on save. That is the whole
 * point — D-543's promise is that the editor refuses anything that would fail
 * the build, and that promise is only true while both read the same code.
 * Testing them here rather than through either caller is what keeps it cheap
 * enough to be true.
 */

const ITEMS = new Set(['flour', 'bread', 'bandage', 'linen']);

function recipe(over: Partial<RecipeDef> = {}): RecipeDef {
  return {
    id: 'bake',
    name: 'Bake bread',
    output: 'bread',
    outputQuantity: 1,
    inputs: [{ item: 'flour', quantity: 1 }],
    station: 'storehouse',
    effortTicks: 40,
    ...over,
  };
}

function roamer(over: Partial<RoamerDef> = {}): RoamerDef {
  return {
    id: 'thing',
    descriptor: 'something in the dark',
    hp: 12,
    damageMin: 1,
    damageMax: 3,
    aggroMetres: 9,
    attackCooldownTicks: 12,
    moveCooldownTicks: 4,
    perArea: 4,
    habitat: 'night',
    xp: 10,
    loot: [],
    ...over,
  };
}

function objective(over: Partial<ObjectiveDef> = {}): ObjectiveDef {
  return {
    id: 'survive-it',
    name: 'See it through',
    brief: 'Live.',
    kind: { type: 'survive' },
    minCast: 3,
    maxCast: null,
    status: 'live',
    ...over,
  };
}

describe('recipes (D-569)', () => {
  it('passes a recipe whose items all exist', () => {
    expect(recipeProblems(recipe(), { itemIds: ITEMS })).toEqual([]);
  });

  it('names the unknown item, in or out', () => {
    expect(recipeProblems(recipe({ output: 'cake' }), { itemIds: ITEMS })).toEqual([
      "outputs unknown item 'cake'",
    ]);
    expect(
      recipeProblems(recipe({ inputs: [{ item: 'sand', quantity: 1 }] }), { itemIds: ITEMS }),
    ).toEqual(["consumes unknown item 'sand'"]);
  });

  it('refuses a recipe that eats its own output', () => {
    // Run it for free, or run it forever. Either way it is a duplication bug
    // wearing a content hat, and invariant 2 is about exactly this graph.
    const problems = recipeProblems(
      recipe({ inputs: [{ item: 'bread', quantity: 1 }] }),
      { itemIds: ITEMS },
    );
    expect(problems).toContain("consumes its own output 'bread'");
  });

  it('refuses one ingredient listed twice', () => {
    // ⚠ Two rows with the same dropdown is not a doubled quantity — the
    // crafting code reads one of them. It looks completely correct in a form,
    // which is why it is caught here rather than left to be noticed in play.
    const problems = recipeProblems(
      recipe({ inputs: [{ item: 'flour', quantity: 1 }, { item: 'flour', quantity: 1 }] }),
      { itemIds: ITEMS },
    );
    expect(problems).toContain("lists 'flour' twice — raise the quantity instead");
  });

  it('says NOTHING about items when it has not been told what exists', () => {
    // ⚠ `null` means "I cannot check this", and must stay a skipped check
    // rather than a fabricated pass. The authoring server sometimes knows the
    // item list and CI always does; a validator that treated "I don't know"
    // as "it exists" would be worse than one that said nothing.
    expect(recipeProblems(recipe({ output: 'cake' }), { itemIds: null })).toEqual([]);
  });
});

describe('roamers (D-569)', () => {
  it('passes an ordinary night roamer', () => {
    expect(roamerProblems(roamer(), { itemIds: ITEMS })).toEqual([]);
  });

  it('requires a dungeon dweller to name its floor, and only a dungeon dweller', () => {
    expect(roamerProblems(roamer({ habitat: 'dungeon' }), { itemIds: ITEMS })).toEqual([
      'lives in the dungeon but names no floor',
    ]);
    expect(roamerProblems(roamer({ habitat: 'night', floor: 2 }), { itemIds: ITEMS })).toEqual([
      'names dungeon floor 2 but does not live there',
    ]);
    expect(roamerProblems(roamer({ habitat: 'dungeon', floor: 2 }), { itemIds: ITEMS })).toEqual([]);
  });

  it('never lets killing the WATCH pay (D-552)', () => {
    // ⚠ A rule, not tuning. The guard stands in the one place the cast cannot
    // avoid, all round, day and night. If a guard kill paid xp or dropped
    // gear, murdering the watch would be the safest income in the game and
    // the guardhouse would become a barn.
    const paid = roamerProblems(
      roamer({ habitat: 'guard', xp: 25, loot: [{ item: 'linen', quantity: 1, chance: 1 }] }),
      { itemIds: ITEMS },
    );
    expect(paid).toEqual([
      'is a guard worth 25 xp — killing the watch must never pay',
      'is a guard carrying loot — killing the watch must never pay',
    ]);
    expect(roamerProblems(roamer({ habitat: 'guard', xp: 0 }), { itemIds: ITEMS })).toEqual([]);
  });

  it('names loot that does not exist', () => {
    expect(
      roamerProblems(roamer({ loot: [{ item: 'gold', quantity: 1, chance: 1 }] }), {
        itemIds: ITEMS,
      }),
    ).toEqual(["drops unknown item 'gold'"]);
  });
});

describe('objectives (D-569)', () => {
  it('refuses a cast range that excludes itself', () => {
    expect(
      objectiveProblems(objective({ minCast: 6, maxCast: 4 }), {
        itemIds: ITEMS,
        npcDescriptors: null,
      }),
    ).toEqual(['maxCast 4 is below minCast 6']);
  });

  it('checks a steal target against the item library', () => {
    expect(
      objectiveProblems(objective({ kind: { type: 'steal', itemTemplate: 'crown' } }), {
        itemIds: ITEMS,
        npcDescriptors: null,
      }),
    ).toEqual(["steals unknown item 'crown'"]);
  });

  it('checks a kill target only when told what descriptors exist', () => {
    // ⚠ `kill_npc` is an exact match on the descriptor of whatever died, so a
    // target nobody wears reads as good prose and can never complete. But
    // NPCs are spawned by Lua rather than declared, so the caller usually
    // CANNOT enumerate them — and passing `null` must skip the check rather
    // than reject every objective aimed at a scripted NPC.
    const kind = { type: 'kill_npc', descriptor: 'the keeper' } as const;
    expect(
      objectiveProblems(objective({ kind }), { itemIds: ITEMS, npcDescriptors: null }),
    ).toEqual([]);
    expect(
      objectiveProblems(objective({ kind }), {
        itemIds: ITEMS,
        npcDescriptors: new Set(['a heavyset keeper with scarred knuckles']),
      }),
    ).toEqual([
      "targets 'the keeper', which no NPC in any area is described as",
    ]);
  });
});

describe('a round has to be startable (D-569)', () => {
  it('is content with no objectives at all', () => {
    // A repository that has not authored one yet is not broken.
    expect(castCoverageProblem([])).toBeNull();
  });

  it('accepts one live objective playable at the minimum cast', () => {
    expect(castCoverageProblem([objective()])).toBeNull();
  });

  it('refuses a set where every objective is shelved or out of range', () => {
    // ⚠ This is the check a per-objective form cannot make. Shelving the last
    // live objective is a legal edit to a legal document; the failure is that
    // the lobby fills and the round never starts, with no error anywhere.
    expect(castCoverageProblem([objective({ status: 'planned' })])).toMatch(/never start/);
    expect(castCoverageProblem([objective({ minCast: 5 })])).toMatch(/never start/);
    expect(castCoverageProblem([objective({ maxCast: 2 })])).toMatch(/never start/);
    expect(
      castCoverageProblem([objective({ minCast: 5 }), objective({ id: 'b' })]),
    ).toBeNull();
  });
});
