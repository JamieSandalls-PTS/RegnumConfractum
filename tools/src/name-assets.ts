import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ASSET_KINDS,
  AssetFileSchema,
  type AssetDef,
  type AssetFile,
  type AssetKind,
  type Stance,
  kindOfMesh,
} from '@rc/shared';
import { allMeshStems, allPacks } from './packs';

/**
 * A first draft of every asset name, from the filenames (D-563).
 *
 *   npm run name:assets
 *
 * The vendor's filenames are descriptive — `SM_Wep_Goblin_Bone_Axe_01`,
 * `SM_Item_Potion_Pole_01` — so drafting from them beats typing six hundred
 * names, and the stakeholder asked for exactly that. What it produces is a
 * DRAFT: mechanical, occasionally clumsy, and meant to be corrected in the
 * tool.
 *
 * ⚠ It NEVER overwrites. An asset already in the file was looked at by a
 * person, and a generator that silently replaces considered work is one
 * nobody dares run twice. Re-running after a new pack arrives adds only what
 * is missing.
 */

const root = fileURLToPath(new URL('../..', import.meta.url));
const outDir = join(root, 'content', 'assets');

/**
 * Where a weapon goes and how it is carried.
 *
 * Guessed from the name, because the name is the only thing that says. A
 * wrong stance is one dropdown to fix and a wrong ATTACH is a sword through
 * a wrist, so the fallbacks are the safe ones: the right hand, one-handed.
 */
function carry(bare: string): { attach: string; stance: Stance } {
  const n = bare.toLowerCase();
  if (/shield|buckler/.test(n)) return { attach: 'Hand_L', stance: 'one-handed-shield' };
  // Crossbow BEFORE bow, or every crossbow is drafted as a bow.
  //
  // ⚠ The boundary here must be `_`, not `\b`. `_` IS a word character, so
  // `/bow\b/` does not match `rigged_bow_testing`: it wants a non-word
  // character after "bow" and finds an underscore. The first version of this
  // line therefore matched no filename in any pack, and the `bow` stance was
  // unreachable by the drafter for as long as it existed. Nothing failed —
  // a bow was simply drafted as a one-handed weapon held in the right fist,
  // which reads as a naming slip rather than as a dead branch.
  if (/crossbow/.test(n)) return { attach: 'Hand_L', stance: 'crossbow' };
  if (/(^|_)(bow|longbow|shortbow)(_|$)/.test(n)) return { attach: 'Hand_L', stance: 'bow' };
  if (/dagger|knife|shiv/.test(n)) return { attach: 'Hand_R', stance: 'dagger' };
  if (/staff|stave|wand|rod/.test(n)) return { attach: 'Hand_R', stance: 'staff' };
  if (/halberd|spear|pike|polearm|glaive|trident|scythe/.test(n)) {
    return { attach: 'Hand_R', stance: 'polearm' };
  }
  if (/zweihander|greatsword|claymore|greataxe|maul|doublesword|large/.test(n)) {
    return { attach: 'Hand_R', stance: 'two-handed' };
  }
  if (/banner|flag|torch|lantern/.test(n)) return { attach: 'Hand_L', stance: 'carrying' };
  return { attach: 'Hand_R', stance: 'one-handed' };
}

/**
 * A readable name from a filename.
 *
 * `SM_Wep_Goblin_Bone_Axe_01` becomes "Goblin bone axe". The trailing number
 * is dropped because it is a variant index rather than part of the name, and
 * put back only when two meshes would otherwise collide — a menu with two
 * entries called "Axe" is a menu that cannot be used.
 */
/**
 * Words the vendor appends that read as adjectives in English.
 *
 * `Axe_Nature_01` and `Hammer_Large_01` are noun-then-modifier, which is a
 * filing convention and not a name — "Axe nature" is nobody's idea of a
 * weapon. Moved to the front, they read as written: "Nature axe", "Large
 * hammer". Only a trailing one moves; `Goblin_Axe` is already the right way
 * round.
 */
const MODIFIERS = new Set([
  'large', 'small', 'long', 'short', 'broken', 'ornate', 'rune', 'nature',
  'crystal', 'gem', 'bone', 'spikes', 'double', 'heavy', 'light', 'old',
  'rusty', 'gold', 'silver', 'iron', 'wood', 'wooden', 'stone',
]);

function draftName(stem: string): string {
  const bare = stem
    .replace(/^S[MK]_/i, '')
    .replace(/^(Wep|Bld|Env|Prop|Gen|Item|Veh)_/i, '')
    // `Item_Chr_Bag_Large` — the `Chr_` says the vendor files it under
    // characters, which is not part of what the thing is called.
    .replace(/^Chr_/i, '')
    .replace(/_(\d+)$/, '');
  let words = bare
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  if (words.length === 0) return stem;
  // Move the trailing modifiers to the front in ONE pass, keeping their
  // order. Rotating one word at a time and looping while the new last word is
  // a modifier cycles forever when every word is one — `Bone_Spikes` becomes
  // `Spikes_Bone` becomes `Bone_Spikes` — and it hangs rather than throwing.
  let noun = words.length;
  while (noun > 1 && MODIFIERS.has(words[noun - 1]!)) noun--;
  if (noun < words.length) words = [...words.slice(noun), ...words.slice(0, noun)];
  return words[0]!.charAt(0).toUpperCase() + words[0]!.slice(1) + (words.length > 1 ? ` ${words.slice(1).join(' ')}` : '');
}

function idFrom(stem: string): string {
  return stem
    .replace(/^S[MK]_/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Every mesh in a pack already catalogued, under ANY kind.
 *
 * ⚠ The skip has to span kinds, not just the file being written. The vendor's
 * prefix is a guess (`kindOfMesh`), and the corrections are exactly the cases
 * where it is wrong — a crossbow bolt filed `Wep_`, an arrow filed `Prop_`.
 * Moving one to the right file is the intended fix, and if this skipped only
 * within a file the next run would put a second copy back where the prefix
 * said, leaving the mesh catalogued twice under two ids. That is the same
 * non-idempotency the wall converter shipped once: a generator is only safe
 * to re-run if a person's correction survives it.
 */
function catalogued(packId: string): Set<string> {
  const out = new Set<string>();
  for (const kind of ASSET_KINDS) {
    const file = join(outDir, `${packId}.${kind}.json`);
    if (!existsSync(file)) continue;
    for (const a of AssetFileSchema.parse(JSON.parse(readFileSync(file, 'utf8'))).assets) {
      out.add(a.mesh);
    }
  }
  return out;
}

/** Every mesh of one kind in a pack, drafted, merged over what is already there. */
function draftFor(packId: string, kind: AssetKind, stems: string[]): AssetFile | null {
  const file = join(outDir, `${packId}.${kind}.json`);
  const existing: AssetFile = existsSync(file)
    ? AssetFileSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
    : { pack: packId, kind, assets: [] };

  const have = catalogued(packId);
  const usedNames = new Map(existing.assets.map((a) => [a.name.toLowerCase(), a.mesh]));
  const added: AssetDef[] = [];

  for (const stem of stems) {
    if (kindOfMesh(stem) !== kind || have.has(stem)) continue;
    let name = draftName(stem);
    // Only reach for the variant number when the plain name is taken; most
    // meshes are the only one of their kind and read better without it.
    if (usedNames.has(name.toLowerCase())) {
      const suffix = /_(\d+)$/.exec(stem)?.[1];
      name = suffix ? `${name} ${Number(suffix)}` : `${name} (${stem})`;
    }
    if (usedNames.has(name.toLowerCase())) continue;
    usedNames.set(name.toLowerCase(), stem);
    const core = { id: idFrom(stem), name, pack: packId, mesh: stem, tags: [] };
    if (kind === 'character-item') {
      const { attach, stance } = carry(stem);
      added.push({ ...core, kind, attach, stance, transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 }, clips: {} });
    } else if (kind === 'pickup') {
      added.push({ ...core, kind, transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } });
    }
  }
  if (added.length === 0) return null;
  return { ...existing, assets: [...existing.assets, ...added] };
}

export function nameAssets(kinds: readonly AssetKind[]): { file: string; added: number }[] {
  const report: { file: string; added: number }[] = [];
  mkdirSync(outDir, { recursive: true });
  for (const pack of allPacks()) {
    const stems = allMeshStems(pack);
    for (const kind of kinds) {
      const before = existsSync(join(outDir, `${pack.id}.${kind}.json`))
        ? AssetFileSchema.parse(
            JSON.parse(readFileSync(join(outDir, `${pack.id}.${kind}.json`), 'utf8')),
          ).assets.length
        : 0;
      const drafted = draftFor(pack.id, kind, stems);
      if (!drafted) continue;
      writeFileSync(
        join(outDir, `${pack.id}.${kind}.json`),
        `${JSON.stringify(drafted, null, 2)}\n`,
      );
      report.push({ file: `${pack.id}.${kind}.json`, added: drafted.assets.length - before });
    }
  }
  return report;
}

const invokedDirectly = process.argv[1]?.includes('name-assets');
if (invokedDirectly) {
  // Weapons and pickups only. Buildings and props are 1,459 meshes whose
  // names are mostly `Wall_01`-shaped: drafting those would fill the files
  // with noise nobody asked for, and the environment tab is there for when
  // somebody wants a particular one.
  const report = nameAssets(['character-item', 'pickup']);
  if (report.length === 0) console.log('nothing to draft — every mesh already has a name');
  for (const r of report) console.log(`${r.file.padEnd(38)} +${r.added}`);
}

export { carry, draftName };
