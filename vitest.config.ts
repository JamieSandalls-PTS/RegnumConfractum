import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

/**
 * ⚠ Reads `.env` so the Postgres-backed suites RUN LOCALLY (D-607).
 *
 * `persistence.pg` and `stores.pg` are `skipIf(!DATABASE_URL)`. The server
 * reads `.env` itself; vitest did not — so on a developer machine those two
 * files were skipped every single run and Postgres was only ever exercised in
 * CI. Vitest prints a skipped file in green, which is why nobody noticed that
 * the only tests standing between the code and the real schema had not run in
 * months.
 *
 * It cost exactly what this repo has been warned about twice (D-572): an
 * INSERT naming a column that does not exist passes every in-memory test and
 * killed the server process on the first tick of every round.
 *
 * Real environment variables still win, so CI is unaffected.
 */
function loadDotEnv(): void {
  try {
    const text = readFileSync(new URL('./.env', import.meta.url), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!;
    }
  } catch {
    // No .env — the pg suites skip, exactly as they did before.
  }
}
loadDotEnv();

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    include: ['{shared,server,sim,tools,client}/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Simulation tests bind real sockets and (when DATABASE_URL is set) share a
    // Postgres database; keep test files sequential to avoid port/DB races.
    fileParallelism: false,
    // The Windows timer clock the simulation tests were calibrated on,
    // reproduced on every platform (D-633). See sim/test/setup-clock.ts.
    setupFiles: ['./sim/test/setup-clock.ts'],
  },
});
