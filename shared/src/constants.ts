// Simulation constants. D-104 locked 10Hz / tile movement / non-twitch; these
// are not tuneables in the sense that systems may assume them.
export const TICK_RATE = 10;
export const TICK_MS = 1000 / TICK_RATE;

/** Ticks between tile steps — one tile per 300ms at 10Hz. */
export const MOVE_COOLDOWN_TICKS = 3;

/** Dirty-entity flush cadence (D-106: 30–60s). 30s at 10Hz. */
export const FLUSH_INTERVAL_TICKS = 300;

/** Bumped on any breaking wire change; both sides assert it (D-105). */
export const PROTOCOL_VERSION = 9; // v9: attributes, mana, equipment, level-up (D-546, D-547)

/** Session tokens live this long without activity. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How far a direct interaction reaches (give, pay), in METRES (D-567).
 *
 * WARNING: 1.5, not 1, and the extra half-metre is not a buff. Chebyshev
 * distance called a diagonal neighbour 1 away; it is 1.41m. Converting the
 * metric without moving the number would have quietly dropped every diagonal
 * neighbour out of reach -- handing something to the person beside you would
 * work north and fail north-east. 1.5m keeps exactly who was in reach before,
 * and is also about where an outstretched arm ends.
 */
export const INTERACT_RANGE = 1.5;

/*
 * Combat and death (D-104, D-203, D-206). Non-twitch by construction: the
 * cooldown, not reaction time, sets the pace.
 *
 * WARNING -- every distance below is METRES and Euclidean (D-567). The old
 * figures were chebyshev tiles, where a diagonal neighbour was 1 away and is
 * really 1.41. The conversion follows one rule, applied twice:
 *
 *   SHORT ranges, where the semantic is "adjacent" -- raised to 1.5, so the
 *   same people are in reach. Dropping diagonals would be a silent rules
 *   change nothing in the UI could explain.
 *
 *   LONG ranges, where the semantic is "about this far" -- left alone, so the
 *   straight-line reach that was actually tuned is preserved and the square's
 *   corners go. This SHRINKS the area covered by about a third.
 *
 * Neither is a re-measure against play, which is what D-567 says these
 * ultimately need.
 */
export const ATTACK_COOLDOWN_TICKS = 20; // one swing per 2s (NPCs; see below)

/**
 * The combat ROUND (D-550, stakeholder 2026-08-20). Four seconds, on a global
 * beat: `floor(tick / COMBAT_ROUND_TICKS)`.
 *
 * Global rather than per-character on purpose. A shared beat is what makes it
 * a round in the sense the stakeholder meant — everybody's turn comes over at
 * the same moment, so "I get one swing this round" is a statement two people
 * can agree about. Per-character timers would just be the cooldown again with
 * a longer name.
 *
 * A basic character gets ONE attack in a round. Feats declaring `extra_attack`
 * add more, and they are gated behind `minLevel` so they arrive with the class
 * progression rather than being picked at creation.
 *
 * ⚠ THIS IS A REBALANCE, not just a restructure. `ATTACK_COOLDOWN_TICKS` was
 * 20, i.e. TWO swings every four seconds for everybody. One attack per round
 * halves that; a single `extra_attack` feat restores today's rate. Flagged for
 * the stakeholder — every number here is unratified.
 */
export const COMBAT_ROUND_TICKS = 40; // 4s at 10Hz

/** Attacks a character gets in a round before any feat adds to it. */
export const BASE_ATTACKS_PER_ROUND = 1;

/**
 * Which round a tick falls in. Shared so both sides agree exactly.
 *
 * The length is a parameter rather than a constant for the same reason combat
 * and corpse pacing are options (D-114): a test must be able to reach the
 * fifth round of a fight without waiting twenty real seconds for it.
 */
export function combatRoundOf(tick: number, roundTicks = COMBAT_ROUND_TICKS): number {
  return Math.floor(tick / Math.max(1, roundTicks));
}

/**
 * Ticks between one swing and the next, given how many a character gets.
 *
 * Attacks are SPACED across the round rather than allowed to burst: without
 * this, somebody with two attacks could throw both on consecutive ticks at a
 * round boundary and land four blows in under a second, which is the twitch
 * combat D-104 ruled out.
 */
export function attackSpacingTicks(
  attacksPerRound: number,
  roundTicks = COMBAT_ROUND_TICKS,
): number {
  return Math.max(1, Math.floor(roundTicks / Math.max(1, attacksPerRound)));
}
/**
 * Bare-handed reach, in METRES (D-567). A weapon may declare more.
 *
 * WARNING: 1.5 for the same reason as INTERACT_RANGE -- it preserves exactly
 * who counted as adjacent on the grid, diagonals included. Leaving it at 1
 * would have made every diagonal melee attack miss for reasons nothing in the
 * UI could explain.
 */
export const ATTACK_RANGE = 1.5;
/** Declared hostility in settled zones: attacks land only after this window. */
export const HOSTILITY_WINDOW_TICKS = 100; // 10s (D-206)
/** A declaration goes stale after this long unused. */
export const HOSTILITY_EXPIRY_TICKS = 3000; // 5 min
export const DEFAULT_MAX_HP = 20;

/**
 * Combat state (stakeholder, 2026-08-18). A character enters combat when
 * attacked or when hostility is declared either way, and leaves only once
 * BOTH are true for the full cooldown: no attack involving them, and no
 * hostile within COMBAT_PROXIMITY_TILES. Weapons are sheathed out of
 * combat, so this state drives the whole draw/stance/sheathe cycle.
 */
export const COMBAT_LEAVE_TICKS = 100; // 10s at 10Hz
/**
 * How near a hostile keeps you in combat, in METRES (D-567).
 *
 * WARNING: the number is UNCHANGED from the tile version and that is a real,
 * if small, nerf -- chebyshev 20 reached 28m into the corners and a 20m circle
 * does not. At long ranges the straight-line figure is the one that was
 * actually tuned ("a hostile within twenty paces"), and a circle is what a
 * person pictures; the corners were an artefact of the metric. Flagged rather
 * than silently compensated: D-567 says these are re-measured against play.
 */
export const COMBAT_PROXIMITY_METRES = 20;

/** How many distinct swing animations the client may be told to play. */
export const ATTACK_VARIANTS = 4;

/**
 * Carrying the dead (D-224 groundwork). A body's burden is its build; a
 * carrier manages `CARRY_BASE_CAPACITY + athletics`. An average character
 * can shift a slight corpse and not a brute's.
 */
export const CARRY_BASE_CAPACITY = 35;
export const GHOST_MIN_TICKS = 3000; // 5 min before self-respawn (D-203)
export const DEATH_DEBT_PER_DEATH = 100; // paid down by future XP (D-203)
/**
 * Health restored by a treated wound, before the treater's Medicine and
 * feats are added (D-538). Small on purpose: the physician is a dependency,
 * not a fountain, and a base anyone can deliver would make the skill
 * pointless.
 *
 * UNRATIFIED, like every other number in the treatment chain.
 */
export const TREAT_BASE_HEAL = 2;

/** Untreated major wounds bleed: 1 hp per wound per interval (D-205). */
export const BLEED_INTERVAL_TICKS = 300; // 30s

// Spirit interactions (D-204/D-224, limits ratified in D-511).
/** A corpse lies where you fell at least as long as the respawn timer. */
export const CORPSE_DECAY_TICKS = 9000; // 15 min
/** Gear from a decayed corpse stays on the ground this long before cleanup. */
export const GROUND_LOOT_TICKS = 36000; // 1 h
/** Hard cap on how long an animated corpse walks: 3 h of play, tick-counted. */
export const ZOMBIE_DURATION_TICKS = 108000;
/** Questions a séance may put to the dead (D-204). */
export const SEANCE_QUESTIONS = 5;
/** Concurrent zombies scale with necromancy skill; never above this (D-511). */
export const MAX_ZOMBIES_PER_NECROMANCER = 3;

// Endgame zones (D-206): permadeath unless revived in time.
/** Ticks a downed player may be revived before the death is permanent. */
export const REVIVE_WINDOW_TICKS = 600; // 60s — tuning unratified
/** Stepping onto an endgame way-marker warns; stepping on again within this
 * window confirms. The warning must be unmissable (D-206). */
export const ENDGAME_CONFIRM_TICKS = 300; // 30s

/**
 * What the rites cost from the reserve (D-546). Both are deliberately large
 * fractions of a base-will caster's pool (10): a rite is a decision with a
 * recovery period, not a verb you spam. A specialist who put the whole
 * creation allocation into will carries 30 and can do three.
 *
 * ⚠ UNRATIFIED, like every other magnitude in the attribute chain.
 */
export const SEANCE_MANA_COST = 6;
export const ANIMATE_MANA_COST = 8;
