import { defineConfig } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  // Serve from this directory; the shared package is reached via @rc/shared
  // path aliases from the root tsconfig.
  plugins: [tsconfigPaths({ root: '..' })],
  // ⚠ The repository's `.env`, not one under client/: the game server reads
  // PORT from there, and the login form's default used to be a second copy
  // of the server's default (8080) while `.env` put the server on 8095 — the
  // same drift D-628 fixed for `npm run bots`. Only PORT is exposed.
  envDir: '..',
  envPrefix: ['VITE_', 'PORT'],
  server: { port: 5173 },
  build: { outDir: 'dist', emptyOutDir: true },
});
