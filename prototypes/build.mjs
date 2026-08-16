/**
 * Inlines Three.js into procgen.src.html to produce a single self-contained
 * procedural-characters.html that opens with a double-click — no server, no
 * network, no build step for the reader.
 *
 *   npm install three esbuild
 *   node build.mjs
 */
import fs from 'fs';
import path from 'path';
import url from 'url';
import { build } from 'esbuild';

const DIR = path.dirname(url.fileURLToPath(import.meta.url));
const SRC = path.join(DIR, 'procgen.src.html');
const OUT = path.join(DIR, 'procedural-characters.html');
const TMP_IN = path.join(DIR, '_app.js');
const TMP_OUT = path.join(DIR, '_bundle.js');

const src = fs.readFileSync(SRC, 'utf8');

const m = src.match(/<script type="module">([\s\S]*?)<\/script>/);
if (!m) {
  console.error('No <script type="module"> block found in', SRC);
  process.exit(1);
}

fs.writeFileSync(TMP_IN, m[1]);

await build({
  entryPoints: [TMP_IN],
  bundle: true,
  format: 'iife',
  minify: true,
  target: 'es2020',
  outfile: TMP_OUT,
  logLevel: 'info',
});

const bundle = fs.readFileSync(TMP_OUT, 'utf8');

const out = src
  .replace(/<script type="importmap">[\s\S]*?<\/script>\s*/, '')
  .replace(/<script type="module">[\s\S]*?<\/script>/, `<script>\n${bundle}\n</script>`);

fs.writeFileSync(OUT, out);
fs.rmSync(TMP_IN, { force: true });
fs.rmSync(TMP_OUT, { force: true });

console.log(`built ${path.basename(OUT)} — ${(out.length / 1024).toFixed(0)}kb`);
