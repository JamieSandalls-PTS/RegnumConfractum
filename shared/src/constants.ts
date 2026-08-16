// Simulation constants. D-104 locked 10Hz / tile movement / non-twitch; these
// are not tuneables in the sense that systems may assume them.
export const TICK_RATE = 10;
export const TICK_MS = 1000 / TICK_RATE;

/** Ticks between tile steps — one tile per 300ms at 10Hz. */
export const MOVE_COOLDOWN_TICKS = 3;

/** Dirty-entity flush cadence (D-106: 30–60s). 30s at 10Hz. */
export const FLUSH_INTERVAL_TICKS = 300;

/** Bumped on any breaking wire change; both sides assert it (D-105). */
export const PROTOCOL_VERSION = 1;

/** Session tokens live this long without activity. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Max chebyshev distance for direct interactions (give, pay). */
export const INTERACT_RANGE = 1;
