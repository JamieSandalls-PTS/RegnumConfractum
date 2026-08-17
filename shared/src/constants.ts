// Simulation constants. D-104 locked 10Hz / tile movement / non-twitch; these
// are not tuneables in the sense that systems may assume them.
export const TICK_RATE = 10;
export const TICK_MS = 1000 / TICK_RATE;

/** Ticks between tile steps — one tile per 300ms at 10Hz. */
export const MOVE_COOLDOWN_TICKS = 3;

/** Dirty-entity flush cadence (D-106: 30–60s). 30s at 10Hz. */
export const FLUSH_INTERVAL_TICKS = 300;

/** Bumped on any breaking wire change; both sides assert it (D-105). */
export const PROTOCOL_VERSION = 2; // v2: corpse/pile entity kinds, spirit actions (D-511)

/** Session tokens live this long without activity. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Max chebyshev distance for direct interactions (give, pay). */
export const INTERACT_RANGE = 1;

// Combat and death (D-104, D-203, D-206). Non-twitch by construction: the
// cooldown, not reaction time, sets the pace.
export const ATTACK_COOLDOWN_TICKS = 20; // one swing per 2s
export const ATTACK_RANGE = 1;
/** Declared hostility in settled zones: attacks land only after this window. */
export const HOSTILITY_WINDOW_TICKS = 100; // 10s (D-206)
/** A declaration goes stale after this long unused. */
export const HOSTILITY_EXPIRY_TICKS = 3000; // 5 min
export const DEFAULT_MAX_HP = 20;
export const GHOST_MIN_TICKS = 3000; // 5 min before self-respawn (D-203)
export const DEATH_DEBT_PER_DEATH = 100; // paid down by future XP (D-203)
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
