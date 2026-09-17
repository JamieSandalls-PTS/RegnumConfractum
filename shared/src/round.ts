import { z } from 'zod';
import { ContentIdSchema } from './content';

/**
 * The Round (D-521 – D-526): a 20-30 minute scenario with a hidden
 * antagonist and no respawn, played over the same world the persistent game
 * uses. This module is the single source of truth for objective documents and
 * round wire shapes — the server loads with these schemas, the validator
 * fails CI on a bad file, and the client renders from the same types.
 *
 * Two rules are encoded here rather than left to convention, because both are
 * invariants and both are easy to break by accident:
 *
 *   - An objective's `brief` is antagonist-only knowledge. It travels in
 *     `round_role`, which is sent to one connection. It must never appear in
 *     `round_state`, which is broadcast.
 *   - `status: 'planned'` objectives are authored but never selected. MR1 can
 *     only evaluate what the server can already observe (deaths and the
 *     clock); steal and starve arrive with MR2's item and survival systems.
 *     A planned objective in content is a design note, not a live scenario.
 */

// ---------------------------------------------------------------------------
// Objectives — content (D-110: content is data, never hardcoded)
// ---------------------------------------------------------------------------

/**
 * What the antagonist must accomplish. Each kind names the fact the server
 * watches; nothing here is scored, and nothing rewards the cast for being
 * right about who to accuse (D-303, restated in D-521).
 */
export const ObjectiveKindSchema = z.discriminatedUnion('type', [
  /** Kill a specific NPC, matched by its public descriptor. The strongest
   * low-cast objective (D-526): the cast defends a known, defenceless target
   * instead of coin-flipping accusations at each other. */
  z.object({ type: z.literal('kill_npc'), descriptor: z.string().min(1) }),
  /** Kill one member of the cast, drawn at random at round start. Reserved
   * for larger casts — at three players this reduces to a duel (D-522). */
  z.object({ type: z.literal('kill_player') }),
  /** Simply live to the end of the round while the cast tries to find you. */
  z.object({ type: z.literal('survive') }),
  /** Take a specific item out of the round. Needs MR2's item verbs. */
  z.object({ type: z.literal('steal'), itemTemplate: ContentIdSchema }),
  /** Deny the cast food and water until they cannot go on. Needs MR2's
   * survival needs (D-526). */
  z.object({ type: z.literal('starve') }),
]);
export type ObjectiveKind = z.infer<typeof ObjectiveKindSchema>;

export const ObjectiveSchema = z
  .object({
    id: ContentIdSchema,
    name: z.string().min(1),
    /**
     * Read by the antagonist alone, at round start. Written in world voice —
     * it is the only briefing they get, so it carries the fiction as well as
     * the instruction.
     */
    brief: z.string().min(1),
    kind: ObjectiveKindSchema,
    /** Smallest cast this objective is playable at. */
    minCast: z.number().int().min(2).default(3),
    /** Largest cast, or null for no ceiling. */
    maxCast: z.number().int().min(2).nullable().default(null),
    /**
     * 'live' objectives may be selected. 'planned' ones are authored ahead of
     * the systems that would evaluate them and are never chosen — the round
     * engine refuses them rather than silently failing to resolve.
     */
    status: z.enum(['live', 'planned']).default('live'),
    /** Why this objective exists, for whoever reads the content later. */
    notes: z.string().optional(),
  })
  .strict();
export type ObjectiveDef = z.infer<typeof ObjectiveSchema>;

// ---------------------------------------------------------------------------
// Round shape and tuning
// ---------------------------------------------------------------------------

/**
 * Minimum cast (D-522, carried at this size by D-526's objective set). This is
 * the floor that lets a round *start*, not the size rounds are designed for —
 * a hidden antagonist wants five to eight to be a mystery rather than a knife
 * fight. Below three there is no deduction at all.
 */
export const ROUND_MIN_CAST = 3;

/** 25 minutes at the 10Hz tick (D-104). Unratified — first-pass length. */
export const ROUND_LENGTH_TICKS = 15_000;

// ---------------------------------------------------------------------------
// The day-night cycle (D-527)
//
// A full cycle is ten real minutes: five of day, five of night. A 25-minute
// round is therefore two and a half cycles — three day phases and TWO nights,
// opening and closing in daylight. The two nights are the round's structure:
// each one drives the cast indoors, and a body discovered at dawn is the
// oldest setup in the genre.
//
// This replaces the persistent world's fixed clock inside a round. The
// script host's TICKS_PER_GAME_HOUR (two real minutes) governs the persistent
// world; a round runs on ROUND_TICKS_PER_GAME_HOUR so that authored on_hour
// and at_hour triggers keep working, just very much faster.
// ---------------------------------------------------------------------------

/** One full day-night cycle: 10 real minutes at 10Hz. */
export const ROUND_DAY_TICKS = 6_000;

/**
 * 24 game hours to a cycle, so a game hour is 25 real seconds. The cycle
 * LENGTH is a parameter everywhere below rather than a constant, because
 * tests have to reach dusk without waiting fifty real seconds for it — the
 * same reason combat and corpse pacing are options (D-114).
 */
export const ROUND_TICKS_PER_GAME_HOUR = ROUND_DAY_TICKS / 24; // 250

/** Night falls at 18:00 and lifts at 06:00 — an even split. */
export const ROUND_DUSK_HOUR = 18;
export const ROUND_DAWN_HOUR = 6;

/**
 * Game hour 0-23 within the round's compressed cycle.
 *
 * A round OPENS AT DAWN. Without the offset, tick 0 is midnight and a
 * 25-minute round gets a truncated opening night plus two more — three
 * nights, starting in the dark, which is neither what D-527 specifies nor a
 * sensible way to begin a round the cast is meant to walk into. The offset
 * is what makes the cycle land as designed: day, night, day, night, day.
 */
export function roundHour(tickIntoRound: number, dayTicks = ROUND_DAY_TICKS): number {
  const ticksPerHour = Math.max(1, dayTicks / 24);
  return (ROUND_DAWN_HOUR + Math.floor(tickIntoRound / ticksPerHour)) % 24;
}

/**
 * Whether it is dark out. Night is the round's pressure inwards: NPCs roam
 * outdoors, so open ground is perilous and the brave are paid for crossing it
 * (D-527). It completes a set of three forces — the dungeon pulls players
 * out (D-523), hunger pushes them out (D-526), night drives them in — and no
 * single spot is safe against all three, which is what stops the cast from
 * simply barricading together for the whole round.
 */
export function isNight(tickIntoRound: number, dayTicks = ROUND_DAY_TICKS): boolean {
  const h = roundHour(tickIntoRound, dayTicks);
  return h >= ROUND_DUSK_HOUR || h < ROUND_DAWN_HOUR;
}

/**
 * What night pays over day (D-528, stakeholder: "night should return 50% more
 * rewards"). It applies ONLY to what is earned OUTDOORS after dusk, because
 * the bonus is compensation for the peril and there is no peril where the
 * sky does not reach. Applied everywhere it would be worse than useless: it
 * would make the safest possible choice — sitting indoors, or diving where
 * roamers cannot follow — also the best-paid one, which inverts the whole
 * point of night.
 *
 * It multiplies xp and materials only. It must never touch anything that
 * wins a round (D-522), and it cannot leak into player kills because those
 * pay nothing at all inside a round.
 */
export const NIGHT_REWARD_MULTIPLIER = 1.5;

/**
 * Scales a reward for where and when it was earned. Rounded rather than
 * floored so small rewards are not quietly swallowed — at these numbers an
 * odd value floored would cost more than the bonus gives.
 */
export function applyNightBonus(amount: number, opts: { outdoor: boolean; night: boolean }): number {
  if (!opts.outdoor || !opts.night) return amount;
  return Math.round(amount * NIGHT_REWARD_MULTIPLIER);
}

/** Which day-night phase a tick falls in, for lighting and spawn logic. */
export function roundPhaseOfDay(
  tickIntoRound: number,
  dayTicks = ROUND_DAY_TICKS,
): 'day' | 'night' {
  return isNight(tickIntoRound, dayTicks) ? 'night' : 'day';
}

// ---------------------------------------------------------------------------
// Violence is free, and loud (D-531)
// ---------------------------------------------------------------------------

/**
 * How far the sound of fighting carries, in tiles. NOT limited by line of
 * sight — you hear a brawl through a tavern wall, and that is the point.
 *
 * At 100x100 areas this is roughly a third of the town, so killing anywhere
 * near where people gather is heard; killing deep in a spoke is not. Distance
 * from other players, rather than a zone rule, is what makes murder quiet.
 * Unratified first pass.
 */
export const COMBAT_NOISE_METRES = 30;

/** Inside this, the sound is close enough to place; beyond it, a direction. */
export const COMBAT_NOISE_NEAR_METRES = 12;

export const RoundPhaseSchema = z.enum(['lobby', 'running', 'resolved']);
export type RoundPhase = z.infer<typeof RoundPhaseSchema>;

/** Why the round ended. Descriptive only — a round ends, it does not grade. */
export const RoundOutcomeSchema = z.enum([
  /** The cast found and killed the antagonist. */
  'antagonist_dead',
  /** Nobody on the cast is still standing. */
  'cast_wiped',
  /** The antagonist did the thing it was sent to do. */
  'objective_complete',
  /** The clock ran out with the antagonist alive and the deed undone. */
  'time_expired',
  /** Too few players remained connected to continue. */
  'abandoned',
]);
export type RoundOutcome = z.infer<typeof RoundOutcomeSchema>;

export type RoundWinner = 'cast' | 'antagonist' | 'nobody';

/** Which side an outcome favours. Kept beside the outcome so the mapping is
 * defined once — the client must never infer a winner from an outcome. */
export function winnerFor(outcome: RoundOutcome): RoundWinner {
  switch (outcome) {
    case 'antagonist_dead':
    case 'time_expired':
      return 'cast';
    case 'cast_wiped':
    case 'objective_complete':
      return 'antagonist';
    case 'abandoned':
      return 'nobody';
  }
}

/**
 * The dawn grace window (D-536): sixty real seconds at the round's opening
 * and at every dawn during which the day does not begin.
 *
 * The round's clock is PAUSED, not merely quiet: needs do not deepen, the
 * countdown does not run, and nobody can strike, be struck, starve or leave
 * the area they are standing in. It is a hard, total truce.
 *
 * It exists because the Round's whole point is people talking to each other
 * (D-521), and a mode that never stops moving never lets them. Dawn is when
 * the survivors count themselves, show their wounds, argue about who goes
 * where — and it is when the antagonist has to lie in front of everybody,
 * with no way to end the conversation by violence.
 */
export const ROUND_GRACE_TICKS = 600; // 60s at 10Hz

/**
 * How long a running round tolerates a cast below the minimum before it is
 * abandoned (D-608). 30 seconds at 10Hz.
 *
 * ⚠ Long enough that a dropped connection is not the end of a round —
 * reconnecting mid-round is supported and deliberate (D-579) — and short
 * enough that a round everybody has actually left does not go on running to
 * its full twenty-five minutes with nobody in it. The second half is what this
 * is for: the next person to log in was arriving as a latecomer in a round
 * that could not be won, rather than in a lobby they could start one from.
 *
 * ⚠ Unratified, like every other duration in the mode.
 */
export const ROUND_THIN_CAST_TICKS = 300;

// ---------------------------------------------------------------------------
// The dungeon's floors (D-535)
// ---------------------------------------------------------------------------

/**
 * Which round-day each floor opens on, one-based. Floor 1 from the start,
 * floor 2 at the second dawn, floor 3 at the third.
 *
 * This is how the dungeon changes without ever being reshaped underneath
 * anybody. Regenerating a space needs it EMPTY, which needs players evicted;
 * revealing a new one needs nothing, because nobody was ever in it. It also
 * buys something reshaping would not: a **schedule**. "The lower stair opens
 * at dawn" is a fixed, shared, known event, and the cast has to gather and
 * decide who goes down — which is where the social game happens.
 */
export const DUNGEON_FLOOR_OPENS_ON_DAY: Record<number, number> = { 1: 1, 2: 2, 3: 3 };

/** Round-day, one-based: day 1 is the round's opening dawn. */
export function roundDay(tickIntoRound: number, dayTicks = ROUND_DAY_TICKS): number {
  return Math.floor(tickIntoRound / dayTicks) + 1;
}

/** Whether a given floor has opened yet. */
export function dungeonFloorOpen(floor: number, tickIntoRound: number, dayTicks = ROUND_DAY_TICKS): boolean {
  const opensOn = DUNGEON_FLOOR_OPENS_ON_DAY[floor];
  if (opensOn === undefined) return true; // not a gated floor
  return roundDay(tickIntoRound, dayTicks) >= opensOn;
}

/**
 * The way in and out of the dungeon is shut between dusk and dawn (D-535,
 * stakeholder's option 2).
 *
 * The dungeon is the one place night's roamers cannot reach, so leaving it
 * open would make diving the correct way to earn through the night without
 * taking night's risk — exactly the inversion D-528 restricted the night
 * bonus to prevent. Sealing the entrance instead makes dusk a decision with
 * teeth: come up now, or be shut in until morning.
 *
 * Only the ENTRANCE seals. Movement between floors already reached stays
 * open, so being caught below is frightening rather than merely idle — and
 * it hands the antagonist a sealed room with a known set of people in it.
 */
export function dungeonEntranceOpen(tickIntoRound: number, dayTicks = ROUND_DAY_TICKS): boolean {
  return !isNight(tickIntoRound, dayTicks);
}

// ---------------------------------------------------------------------------
// Objective validation (D-569)
// ---------------------------------------------------------------------------

/**
 * Everything wrong with one objective. Pure, so CI and the authoring tool
 * agree on what would refuse to build.
 *
 * ⚠ It cannot answer the question that actually matters — whether the SET of
 * objectives still leaves a round startable. That is `castCoverageProblem`
 * below, and it is the check a per-objective form cannot make: narrowing the
 * last live objective's cast range is a legal edit to a legal document that
 * makes the lobby fill and never start.
 */
export function objectiveProblems(
  objective: ObjectiveDef,
  refs: { itemIds: ReadonlySet<string> | null; npcDescriptors: ReadonlySet<string> | null },
): string[] {
  const problems: string[] = [];
  if (objective.maxCast !== null && objective.maxCast < objective.minCast) {
    problems.push(`maxCast ${objective.maxCast} is below minCast ${objective.minCast}`);
  }
  if (objective.kind.type === 'steal' && refs.itemIds && !refs.itemIds.has(objective.kind.itemTemplate)) {
    problems.push(`steals unknown item '${objective.kind.itemTemplate}'`);
  }
  // ⚠ Matched by DESCRIPTOR, not by id, because that is what the round engine
  // watches (`kill_npc`). A descriptor nobody wears is an objective that can
  // never complete, and it reads as perfectly good prose in the form.
  if (
    objective.kind.type === 'kill_npc'
    && refs.npcDescriptors
    && !refs.npcDescriptors.has(objective.kind.descriptor)
  ) {
    problems.push(`targets '${objective.kind.descriptor}', which no NPC in any area is described as`);
  }
  return problems;
}

/**
 * Why this set of objectives could not start a round, or null.
 *
 * A round cannot begin without something to give the antagonist, so if any
 * objective exists at all, at least one must be live and playable at the
 * minimum cast. Otherwise the lobby fills and nothing happens — a failure
 * with no error message anywhere.
 */
export function castCoverageProblem(objectives: readonly ObjectiveDef[]): string | null {
  if (objectives.length === 0) return null;
  const playable = objectives.filter(
    (o) =>
      o.status === 'live'
      && o.minCast <= ROUND_MIN_CAST
      && (o.maxCast === null || o.maxCast >= ROUND_MIN_CAST),
  );
  if (playable.length > 0) return null;
  return `no live objective is playable at the minimum cast of ${ROUND_MIN_CAST} — a round could never start`;
}


// ---------------------------------------------------------------------------
// The scenario — the round's edges, as data (D-627)
// ---------------------------------------------------------------------------

/**
 * One playable round: which map it is played on, what may be dealt, how big a
 * cast it takes.
 *
 * ⚠ This exists because **the round had no edges at all**. `RoundEngine` knew
 * the cast, the clock and the objective and had no concept of an AREA — while
 * the world graph ran `round-town -> hanged-ferryman -> broken-yard ->
 * sunken-crypt`, and `sunken-crypt` is `zone: endgame`, which carries
 * involuntary permadeath. D-523 says in terms that a round must never contain
 * one, because a round death must not cost a character levelled across fifty
 * rounds. Nothing stopped the walk. The invariant was held up by nobody having
 * gone west.
 *
 * ⚠ DATA, not another guard. A check against `sunken-crypt` by name would fix
 * the case found and leave the class — and the class grows, because the
 * persistent world is meant to keep being built behind the Round (D-521). A
 * declared set makes the question answerable by reading: an area is in this
 * round or it is not, and CI can tell.
 *
 * ⚠ It is also what MR3 has been waiting for. "Multiple scenarios as data,
 * chosen or rotated per round" stops being a feature to build and becomes the
 * thing that already exists.
 */
export const ScenarioSchema = z
  .object({
    id: ContentIdSchema,
    /** What the round is called, for the lobby and the results screen. */
    name: z.string().min(1),
    /**
     * Every area this round is played in.
     *
     * ⚠ The boundary itself. A transition out of this set is refused while the
     * round runs — the door is still there, because it belongs to the
     * persistent world, and it does not open.
     */
    areas: z.array(ContentIdSchema).min(1),
    /**
     * Where the cast opens the round, and is gathered back to at a reset.
     *
     * ⚠ Must be one of `areas`. It used to be the server's `defaultAreaId` —
     * a global setting, which is the same absence of a boundary one layer up:
     * the persistent world's starting room decided where a round began.
     */
    opensIn: ContentIdSchema,
    /**
     * The objectives that may be dealt. Empty means every live objective,
     * which is what the engine did before scenarios existed.
     */
    objectives: z.array(ContentIdSchema).default([]),
    /** Smallest cast this scenario is playable at. */
    minCast: z.number().int().min(2).default(ROUND_MIN_CAST),
    /** Largest cast, or null for no ceiling. */
    maxCast: z.number().int().min(2).nullable().default(null),
    /**
     * 'live' scenarios may be chosen; 'planned' ones are drafts the engine
     * refuses, the same rule objectives follow and for the same reason.
     */
    status: z.enum(['live', 'planned']).default('live'),
    notes: z.string().optional(),
  })
  .strict();
export type ScenarioDef = z.infer<typeof ScenarioSchema>;

/**
 * What is wrong with a scenario, in the words its author needs.
 *
 * Pure, and in `shared`, so the authoring tool refuses exactly what the build
 * refuses — D-543's rule, which only holds while both read one implementation.
 */
export function scenarioProblems(
  scenario: ScenarioDef,
  world: {
    /** Area id -> its zone, for every area that exists. */
    zones: ReadonlyMap<string, string>;
    /** Area id -> the areas its transitions lead to. */
    exits: ReadonlyMap<string, readonly string[]>;
    /** Every objective, for the pool check. */
    objectives: readonly ObjectiveDef[];
  },
): string[] {
  const problems: string[] = [];
  const set = new Set(scenario.areas);

  for (const id of scenario.areas) {
    if (!world.zones.has(id)) problems.push(`names area '${id}', which does not exist`);
  }
  if (!set.has(scenario.opensIn)) {
    problems.push(`opens in '${scenario.opensIn}', which is not one of its areas`);
  }

  // ⚠ The rule D-523 states and nothing enforced. An endgame area carries
  // involuntary permadeath; a round death must not cost a character levelled
  // across fifty rounds.
  for (const id of scenario.areas) {
    if (world.zones.get(id) === 'endgame') {
      problems.push(
        `includes '${id}', which is an ENDGAME area — a round death there is `
        + 'permanent, and a round must never contain one (D-523)',
      );
    }
  }

  // ⚠ A WARNING in the author's hands rather than an error. A door leading out
  // of the set is legal and expected: the tavern's west door belongs to the
  // persistent world and is simply shut for the duration. What is not
  // acceptable is not knowing where the edges are, so they are named.
  const leaks: string[] = [];
  for (const id of scenario.areas) {
    for (const to of world.exits.get(id) ?? []) {
      if (!set.has(to)) leaks.push(`${id} -> ${to}`);
    }
  }
  if (leaks.length > 0) {
    problems.push(
      `NOTE its edges: ${leaks.join(', ')} lead out of the scenario and will be `
      + 'refused while the round runs',
    );
  }

  const pool = scenario.objectives.length > 0
    ? world.objectives.filter((o) => scenario.objectives.includes(o.id))
    : world.objectives;
  for (const id of scenario.objectives) {
    if (!world.objectives.some((o) => o.id === id)) {
      problems.push(`names objective '${id}', which does not exist`);
    }
  }
  // ⚠ The trap D-569 hit one level up: a scenario whose objectives all need a
  // bigger cast than it starts at makes the lobby fill and never start.
  const playable = pool.filter(
    (o) => o.status === 'live'
      && o.minCast <= scenario.minCast
      && (o.maxCast === null || o.maxCast >= scenario.minCast),
  );
  if (playable.length === 0) {
    problems.push(
      `has no live objective playable at its minimum cast of ${scenario.minCast} — `
      + 'the lobby would fill and never start',
    );
  }
  if (scenario.maxCast !== null && scenario.maxCast < scenario.minCast) {
    problems.push(`caps the cast at ${scenario.maxCast}, below its minimum of ${scenario.minCast}`);
  }
  return problems;
}
