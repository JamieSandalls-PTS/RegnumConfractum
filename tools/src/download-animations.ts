import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Downloads exported animation files that a browser could not save (D-564).
 *
 *   npx tsx tools/src/download-animations.ts urls.json
 *
 * The split exists because neither half can do the whole job. The library's
 * API needs the session, which lives in the browser; the download URL is
 * PRESIGNED, so it needs no session at all but is refused to the page by
 * CORS. So the page produces `{ name, url }` and this consumes it.
 *
 * ⚠ Presigned URLs expire in five minutes. A batch that sits around waiting
 * fails with a 403 that reads like a permissions problem rather than a clock
 * one, so the failure message says so.
 */

const root = fileURLToPath(new URL('../..', import.meta.url));
const outDir = join(root, 'assets', 'incoming', 'animations');
const FBX_MAGIC = 'Kaydara FBX Binary';

interface Wanted {
  name: string;
  url: string;
}

export async function downloadAll(items: readonly Wanted[]): Promise<{
  saved: string[];
  failed: { name: string; why: string }[];
}> {
  mkdirSync(outDir, { recursive: true });
  const saved: string[] = [];
  const failed: { name: string; why: string }[] = [];

  for (const item of items) {
    const file = join(outDir, `${item.name}.fbx`);
    try {
      const res = await fetch(item.url);
      if (!res.ok) {
        failed.push({
          name: item.name,
          why: res.status === 403 ? 'expired (presigned URLs last 5 minutes)' : `HTTP ${res.status}`,
        });
        continue;
      }
      const data = Buffer.from(await res.arrayBuffer());
      if (data.subarray(0, FBX_MAGIC.length).toString('latin1') !== FBX_MAGIC) {
        failed.push({ name: item.name, why: `not an FBX (${data.byteLength} bytes)` });
        continue;
      }
      writeFileSync(file, data);
      saved.push(`${item.name} (${(data.byteLength / 1024).toFixed(0)} KB)`);
    } catch (e) {
      failed.push({ name: item.name, why: (e as Error).message });
    }
  }
  return { saved, failed };
}

/** What is already on disk, so a re-run skips it rather than re-fetching. */
export function alreadyHave(): string[] {
  if (!existsSync(outDir)) return [];
  return readdirSync(outDir)
    .filter((f) => /\.fbx$/i.test(f))
    .map((f) => f.replace(/\.fbx$/i, ''));
}

const invokedDirectly = process.argv[1]?.includes('download-animations');
if (invokedDirectly) {
  const listFile = process.argv[2];
  if (!listFile) {
    console.log(`have ${alreadyHave().length}: ${alreadyHave().join(', ')}`);
  } else {
    const items = JSON.parse(readFileSync(listFile, 'utf8')) as Wanted[];
    const { saved, failed } = await downloadAll(items);
    for (const s of saved) console.log(`  saved ${s}`);
    for (const f of failed) console.log(`  FAILED ${f.name}: ${f.why}`);
    console.log(`${saved.length} saved, ${failed.length} failed, ${alreadyHave().length} on disk`);
  }
}
