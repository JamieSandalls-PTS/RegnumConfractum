import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACTIONS,
  AnimationSetSchema,
  READINESS,
  STANCES,
  readinessApplies,
  type Action,
  type AnimationSet,
  type Readiness,
  type Stance,
} from '@rc/shared';
import { WISHLIST, wishFilename, type AnimationWish } from './animation-wishlist.js';

/**
 * Draft the animation sets from the clips that were actually built (D-564).
 *
 *   npm run draft:animations
 *
 * The wishlist already carries the two facts a set needs — which action a clip
 * serves and which stance it belongs to — so the first pass is mechanical and
 * there is no reason to type it out by hand. What it is NOT is the final word:
 * a set is content (D-110), the tool can edit it, and this refuses to
 * overwrite one that already exists, exactly as `name:assets` does.
 *
 * ⚠ What it drafts is the LAYERING, and that is the part worth reading. The
 * `unarmed` clips become the RIG set, not a stance set — the base every other
 * layer falls through to (D-561) — so `two-handed` naming three attacks is a
 * complete two-handed character, and the sixty other actions come from
 * beneath. Drafting them into a stance set instead would look identical in the
 * tool and mean the opposite: nothing would inherit anything.
 */

const root = fileURLToPath(new URL('../..', import.meta.url));
const outDir = join(root, 'content', 'animations');
const manifestFile = join(root, 'client', 'public', 'models', 'manifest.json');

/**
 * The clip name the build gives a wish: `unarmed__idle.fbx` → `unarmed-idle`,
 * `one-handed__combat__walk.fbx` → `one-handed-combat-walk`.
 */
export function clipNameFor(
  stance: Stance,
  action: Action,
  readiness?: Readiness,
): string {
  const stem =
    readiness === 'combat' ? `${stance}__combat__${action}` : `${stance}__${action}`;
  return stem.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

/** Which clips the last build actually produced. */
export function builtClips(): Set<string> {
  if (!existsSync(manifestFile)) return new Set();
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as { clips?: string[] };
  return new Set(manifest.clips ?? []);
}

/**
 * The sets the wishlist implies, given what is on disk.
 *
 * A wish whose clip did not build is simply absent — an action with no clip
 * plays nothing, which is the honest outcome and is visible in the tool as an
 * empty row rather than as a name that resolves to nothing.
 */
export function draftSets(built: ReadonlySet<string>): AnimationSet[] {
  // Keyed by the LAYER a wish belongs in, which is what the readiness field
  // decides: `combat` goes to a readiness set, everything else to the stance
  // it names (or, for `unarmed`, to the rig).
  const stanceClips = new Map<Stance, Partial<Record<Action, string>>>();
  const combatClips = new Map<Stance, Partial<Record<Action, string>>>();
  const bucket = (wish: AnimationWish): Map<Stance, Partial<Record<Action, string>>> =>
    wish.readiness === 'combat' ? combatClips : stanceClips;

  for (const wish of WISHLIST) {
    const clip = clipNameFor(wish.stance, wish.action, wish.readiness);
    if (!built.has(clip)) continue;
    const into = bucket(wish);
    const clips = into.get(wish.stance) ?? {};
    clips[wish.action] = clip;
    into.set(wish.stance, clips);
  }

  const sets: AnimationSet[] = [];
  const base = stanceClips.get('unarmed');
  if (base) {
    sets.push({
      id: 'rig-unreal',
      name: 'Unarmed (base)',
      layer: 'rig',
      applies: 'unreal',
      clips: base,
      note:
        'The base every other layer falls through to. Empty hands: locomotion, ' +
        'reactions, work, emotes and casting from a bare palm.',
    });
  }
  for (const stance of STANCES) {
    if (stance === 'unarmed') continue;
    const clips = stanceClips.get(stance);
    if (!clips) continue;
    sets.push({
      id: `stance-${stance}`,
      name: `${stanceName(stance)} — carried`,
      layer: 'stance',
      applies: stance,
      clips,
      note:
        'How the weapon is carried when it is not up, and the draw and sheathe ' +
        'that move between the two. Everything else comes from the rig set.',
    });
  }
  for (const stance of STANCES) {
    const clips = combatClips.get(stance);
    if (!clips) continue;
    sets.push({
      id: `combat-${stance}`,
      name: `${stanceName(stance)} — weapon up`,
      layer: 'readiness',
      applies: readinessApplies(stance, 'combat'),
      clips,
      note:
        `Plays only with the weapon up: ${Object.keys(clips).length} of ${ACTIONS.length} ` +
        'actions. Sheathed, the character falls through to the stance and the rig.',
    });
  }
  return sets;
}

/** Every readiness a drafted set could apply to, for the tool's benefit. */
export const DRAFTED_READINESS: readonly Readiness[] = READINESS;

function stanceName(stance: Stance): string {
  const words: Partial<Record<Stance, string>> = {
    'one-handed': 'Sword and shield',
    'one-handed-shield': 'Sword and shield (shield up)',
    'two-handed': 'Greatsword',
    polearm: 'Polearm',
    dagger: 'Dagger',
    bow: 'Bow',
    crossbow: 'Crossbow',
    staff: 'Staff',
    thrown: 'Thrown',
    carrying: 'Carrying a burden',
  };
  return words[stance] ?? stance;
}

const invokedDirectly = process.argv[1]?.includes('draft-animation-sets');
if (invokedDirectly) {
  mkdirSync(outDir, { recursive: true });
  const built = builtClips();
  if (built.size === 0) {
    console.log('no built clips — run `npm run build:characters` first');
  }
  const have = new Set(
    readdirSync(outDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, '')),
  );
  let wrote = 0;
  for (const set of draftSets(built)) {
    if (have.has(set.id)) {
      console.log(`  kept ${set.id} (already authored)`);
      continue;
    }
    // Parse before writing, so a draft that would fail CI fails here instead.
    writeFileSync(join(outDir, `${set.id}.json`), `${JSON.stringify(AnimationSetSchema.parse(set), null, 2)}\n`);
    console.log(`  drafted ${set.id.padEnd(20)} ${Object.keys(set.clips).length} clips`);
    wrote++;
  }
  console.log(`${wrote} sets drafted from ${built.size} built clips`);
}
