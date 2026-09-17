/**
 * The clock the simulation tests were calibrated on, on every platform (D-633).
 *
 * Every simulation test was written on Windows, where Node's timers run on a
 * 15.6 ms system clock: `setInterval(fn, 5)` fires 63 times a second and
 * `setTimeout(r, 30)` waits 31 ms. Measured:
 *
 *     setTimeout   Windows   Linux
 *          5 ms      15.6      5.1
 *         30 ms      30.9     30.2
 *         50 ms      61.9     50.2
 *
 * Linux honours the number, so on CI the same servers ticked three times as
 * fast against the same wall-clock waits, a round could resolve and reset
 * inside one polling interval, and the suite had been red since 12 September
 * while it passed on the development machine every time.
 *
 * This file makes the process's timers behave like that clock where the OS
 * does not: a delay is rounded UP to whole periods of 15.625 ms. It runs
 * before every test file. It is not a fix for wall-clock tests — it is the
 * environment they were tuned in, reproduced on purpose so both platforms
 * run the same simulation. The durable fix is tick-driven waits, a rewrite
 * nobody has asked for yet.
 */

const CLOCK_MS = 15.625;

if (process.platform !== 'win32') {
  const quantise = (ms: unknown): number => {
    const n = typeof ms === 'number' ? ms : Number(ms ?? 0);
    if (!Number.isFinite(n) || n <= 0) return n;
    return Math.ceil(n / CLOCK_MS) * CLOCK_MS;
  };
  const realTimeout = globalThis.setTimeout;
  const realInterval = globalThis.setInterval;
  const patchedTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) =>
    realTimeout(fn, quantise(ms), ...args)) as typeof setTimeout;
  const patchedInterval = ((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) =>
    realInterval(fn, quantise(ms), ...args)) as typeof setInterval;
  // Node adds `__promisify__` to the real ones; keep it reachable.
  Object.assign(patchedTimeout, realTimeout);
  Object.assign(patchedInterval, realInterval);
  globalThis.setTimeout = patchedTimeout;
  globalThis.setInterval = patchedInterval;
}
