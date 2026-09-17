import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AreaSchema, AssetFileSchema, defaultMask, type Volume } from '@rc/shared';

/**
 * Re-bake every placed asset's collision mask from the catalogue (D-599).
 *
 *     npm run map:rebake            every area
 *     npm run map:rebake -- round-town sunken-crypt
 *     npm run map:rebake -- --dry   say what would change and write nothing
 *
 * ⚠ A placement carries a COPY of its asset's mask (D-567), baked at placement
 * time so an area is self-describing and the server never has to hold the
 * catalogue to answer where a body may stand. The cost of that copy is drift:
 * change an asset's mask and every map placed before the change still has the
 * old one. `placedAssetDrift` reports it and CI fails the build — and until
 * now the only remedy CI named was "re-place it", by hand, once per placement.
 * 727 of them drifted the first time an asset's measured height was filled in.
 *
 * ⚠ It NEVER touches a placement marked `overrideCollision`. That flag is the
 * other half of the stakeholder's ruling — per-asset, overridable per
 * placement — and it is the only thing distinguishing a copy that should track
 * the catalogue from a doorway somebody deliberately knocked a gap in. A
 * re-bake that ignored it would silently seal every hand-authored arch, and
 * nothing downstream would say so: the map would simply validate, and a route
 * a test walks would be gone.
 *
 * ⚠ It is deliberately NOT part of `validate:content`. A build that repaired
 * its own inputs would make the drift check unfalsifiable — the thing it warns
 * about would be fixed before anybody read the warning, including the case
 * where the catalogue is what changed by mistake.
 */

const contentDir = resolve(process.argv[2]?.startsWith('--') ? 'content' : (process.argv[2] ?? 'content'));
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const dry = process.argv.includes('--dry');
const wanted = new Set(args.filter((a) => !a.includes('/') && !a.includes('\\')));

/** Every environment asset's current mask, keyed the way a placement names it. */
function catalogue(): Map<string, Volume[]> {
  const out = new Map<string, Volume[]>();
  const dir = join(contentDir, 'assets');
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    const parsed = AssetFileSchema.safeParse(JSON.parse(readFileSync(join(dir, f), 'utf8')));
    if (!parsed.success) continue;
    for (const a of parsed.data.assets) {
      if (a.kind !== 'environment') continue;
      out.set(`${a.pack}/${a.id}`, defaultMask(a));
    }
  }
  return out;
}

const masks = catalogue();
const areasDir = join(contentDir, 'areas');
let totalRebaked = 0;
let totalKept = 0;
let totalUnknown = 0;

for (const file of readdirSync(areasDir).filter((n) => n.endsWith('.json'))) {
  const id = file.replace(/\.json$/, '');
  if (wanted.size > 0 && !wanted.has(id)) continue;
  const path = join(areasDir, file);
  const raw = JSON.parse(readFileSync(path, 'utf8')) as {
    assets?: {
      asset: string; pack: string; collision?: Volume[]; overrideCollision?: boolean;
    }[];
  };
  // Parsed only to be sure the file is sound before rewriting it; the RAW
  // document is what gets written, so nothing else in it is reshaped by zod's
  // defaults on the way through.
  const check = AreaSchema.safeParse(raw);
  if (!check.success) {
    console.log(`${id.padEnd(20)} SKIPPED — does not validate as it stands`);
    continue;
  }

  let rebaked = 0;
  let kept = 0;
  let unknown = 0;
  for (const placed of raw.assets ?? []) {
    if (placed.overrideCollision) {
      kept++;
      continue;
    }
    const want = masks.get(`${placed.pack}/${placed.asset}`);
    if (!want) {
      unknown++;
      continue;
    }
    if (JSON.stringify(placed.collision ?? []) === JSON.stringify(want)) continue;
    placed.collision = want;
    rebaked++;
  }

  if (rebaked > 0 && !dry) {
    writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  }
  if (rebaked > 0 || unknown > 0) {
    console.log(
      `${id.padEnd(20)} ${String(rebaked).padStart(4)} re-baked`
      + `${kept ? `, ${kept} deliberate override(s) left alone` : ''}`
      + `${unknown ? `, ⚠ ${unknown} placement(s) name an asset the catalogue has no mask for` : ''}`
      + `${dry ? '   (dry run, nothing written)' : ''}`,
    );
  }
  totalRebaked += rebaked;
  totalKept += kept;
  totalUnknown += unknown;
}

console.log(
  `\n${totalRebaked} re-baked, ${totalKept} overrides untouched`
  + `${totalUnknown ? `, ${totalUnknown} unknown` : ''}.`,
);
if (totalRebaked > 0 && !dry) console.log('Run `npm run validate:content`.');
