import { defineConfig } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  // Serve from this directory; the shared package is reached via @rc/shared
  // path aliases from the root tsconfig.
  plugins: [tsconfigPaths({ root: '..' })],
  server: { port: 5173 },
  build: { outDir: 'dist', emptyOutDir: true },
});
