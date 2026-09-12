import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WISHLIST, wishFilename } from './animation-wishlist.js';

/** What the wishlist asked for and the download did not produce (D-564). */
const dir = join(fileURLToPath(new URL('../..', import.meta.url)), 'assets', 'incoming', 'animations');
const have = new Set(
  existsSync(dir) ? readdirSync(dir).filter((f) => /\.fbx$/i.test(f)).map((f) => f.replace(/\.fbx$/i, '')) : [],
);
const missing = WISHLIST.filter((w) => !have.has(wishFilename(w)));

// `--json` emits what the browser helper eats, so the query, the preferred
// titles and the `nth` never have to be retyped into a console by hand — which
// is where a mistyped preference becomes a crouch bound to `idle`.
if (process.argv.includes('--json')) {
  console.log(
    JSON.stringify(
      missing.map((w) => ({ f: wishFilename(w), s: w.search, p: w.prefer, n: w.nth ?? 0 })),
    ),
  );
} else {
  for (const w of missing) {
    console.log(`${wishFilename(w).padEnd(30)} search=${JSON.stringify(w.search)}  prefer=${w.prefer.join(' | ')}`);
  }
  console.log(`${missing.length} missing of ${WISHLIST.length}; ${have.size} on disk`);
}
