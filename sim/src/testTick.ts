/**
 * The clock the simulation tests run on (D-633).
 *
 * ⚠ Every test declared `const TICK = 5` and slept in multiples of it, and
 * on the machine they were all written on none of that was true. Windows
 * runs timers on a 15.6 ms clock: `setInterval(fn, 5)` fires 63 times a
 * second, and `setTimeout(r, 30)` waits 46 ms. Linux honours both numbers —
 * 191 ticks a second, 30 ms is 30 ms — so on CI the world moved three times
 * as far between a test's actions, a round could resolve and reset inside
 * one polling interval, and the suite had been red since 12 September with
 * fights that never ended while it passed here every time.
 *
 * Measured with `sim/probe/linux-kill.ts`, on Windows: 5 → 63/s, 15 → 62/s,
 * 16 → 41/s, 20 → 31/s. Sixteen was tried first and halved the rate, because
 * an interval is rounded UP to whole periods of the clock.
 *
 * So the tests keep their arithmetic at 5, the server ticks at 15 (one clock
 * period, the same 62/s on both platforms), and `sim/test/setup-clock.ts`
 * rounds every timer in the process up to that clock where the OS does not.
 * That is not a fix for wall-clock tests — it is the environment they were
 * calibrated in, reproduced on purpose so both platforms run the same
 * simulation. The durable fix is tick-driven waits, and it is a rewrite of
 * forty-nine files that nobody has asked for yet.
 */

/** The unit every test's waits are written in. Unchanged from what they said. */
export const TICK = 5;

/** What the server is asked to tick at: one period of the Windows clock. */
export const TICK_INTERVAL_MS = 15;

/**
 * A plain wait. The rounding Windows applies to every timer is reproduced
 * for the whole process by `sim/test/setup-clock.ts`, so this needs no
 * arithmetic of its own — and must not have any, or a wait would be rounded
 * twice on Linux.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
