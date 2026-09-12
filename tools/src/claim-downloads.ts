import { existsSync, mkdirSync, readdirSync, renameSync, statSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Claims freshly downloaded animation files and gives them their real names
 * (D-564).
 *
 * The browser can reach the library's presigned download URLs; Node cannot
 * reach the library's API without the session. So the page clicks the
 * downloads and they land in the OS download folder — as `<uuid>.tmp`,
 * because the URL is cross-origin and the browser therefore ignores both the
 * `download` attribute and the server's `Content-Disposition`.
 *
 * ⚠ So the files arrive ANONYMOUS and are matched by ORDER. That is only
 * sound because the page downloads them one at a time and hands over the same
 * order; this refuses to guess when the counts disagree, because a
 * silently-misnamed clip is a walk bound to the death action and nothing
 * about it looks wrong until somebody dies.
 *
 *   npx tsx tools/src/claim-downloads.ts names.json [sinceEpochMs]
 */

const root = fileURLToPath(new URL('../..', import.meta.url));
const outDir = join(root, 'assets', 'incoming', 'animations');
const downloads = process.env.DOWNLOADS ?? join(homedir(), 'Downloads');
const FBX_MAGIC = 'Kaydara FBX Binary';

interface Claimed {
  claimed: string[];
  skipped: string[];
  problems: string[];
}

/** Files that arrived after `since`, oldest first — the order they were asked for. */
export function arrivals(since: number): string[] {
  if (!existsSync(downloads)) return [];
  return readdirSync(downloads)
    .filter((f) => /\.(tmp|fbx)$/i.test(f))
    .map((f) => ({ f, at: statSync(join(downloads, f)).mtimeMs }))
    .filter((x) => x.at >= since)
    .sort((a, b) => a.at - b.at)
    .map((x) => x.f);
}

export function claim(names: readonly string[], since: number): Claimed {
  mkdirSync(outDir, { recursive: true });
  const files = arrivals(since);
  const out: Claimed = { claimed: [], skipped: [], problems: [] };

  // Only the ones that really are FBX. A cancelled or failed download leaves
  // a short file behind, and counting it would shift every name after it.
  const good = files.filter((f) => {
    try {
      const head = readFileSync(join(downloads, f)).subarray(0, FBX_MAGIC.length);
      return head.toString('latin1') === FBX_MAGIC;
    } catch {
      return false;
    }
  });

  if (good.length !== names.length) {
    out.problems.push(
      `expected ${names.length} downloads, found ${good.length} — refusing to match by ` +
        `order, because a shifted match names a walk "death" and nothing looks wrong ` +
        `until somebody dies`,
    );
    return out;
  }

  for (const [i, file] of good.entries()) {
    const name = names[i]!;
    const target = join(outDir, `${name}.fbx`);
    if (existsSync(target)) {
      out.skipped.push(name);
      continue;
    }
    renameSync(join(downloads, file), target);
    out.claimed.push(name);
  }
  return out;
}

const invokedDirectly = process.argv[1]?.includes('claim-downloads');
if (invokedDirectly) {
  const names = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as string[];
  const since = Number(process.argv[3] ?? 0);
  const r = claim(names, since);
  for (const p of r.problems) console.log(`  ! ${p}`);
  if (r.claimed.length) console.log(`  claimed: ${r.claimed.join(', ')}`);
  if (r.skipped.length) console.log(`  already had: ${r.skipped.join(', ')}`);
  const have = existsSync(outDir) ? readdirSync(outDir).filter((f) => /\.fbx$/i.test(f)).length : 0;
  console.log(`${r.claimed.length} claimed, ${have} clips on disk`);
}
