import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    include: ['{shared,server,sim,tools}/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Simulation tests bind real sockets and (when DATABASE_URL is set) share a
    // Postgres database; keep test files sequential to avoid port/DB races.
    fileParallelism: false,
  },
});
