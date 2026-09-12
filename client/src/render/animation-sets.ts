import {
  AnimationSetSchema,
  readinessApplies,
  resolveAnimations,
  type Action,
  type AnimationSet,
  type Readiness,
  type Stance,
} from '@rc/shared';

/**
 * The authored animation sets, in the renderer at last (D-564 → D-578).
 *
 * ⚠ D-564 built the library — 126 clips, fifteen sets, a closed action
 * vocabulary, CI resolving every set together — and recorded that "nothing in
 * the game reads a set yet". This is the module that reads them. It is the
 * third thing found this session that was authored, validated and consumed
 * only by the authoring tools (see D-576), and the most consequential: the
 * renderer was picking clips by hard-coded NAME, so a character holding a bow
 * swung it like a sword and eleven stances animated identically.
 *
 * ⚠ Loaded at BUILD time, the same way `content/audio/sounds.json` reaches the
 * client. That is the established channel for presentation content here and it
 * keeps one loading path; the cost, stated plainly, is that authoring a new
 * set needs a client rebuild rather than a server restart. Sets bind actions
 * to clips in a `.glb` the same build produces, so the two move together
 * anyway — but if content ever needs to outpace deploys, this is the line that
 * has to change.
 */
const files = import.meta.glob('../../../content/animations/*.json', { eager: true }) as Record<
  string,
  { default: unknown }
>;

/**
 * ⚠ Parsed through the real schema rather than trusted as typed JSON. These
 * are hand-authored documents; a set naming a layer that does not exist would
 * otherwise resolve as if it were absent, which looks exactly like a set
 * nobody filled in.
 */
const SETS: AnimationSet[] = Object.entries(files)
  .sort(([a], [b]) => a.localeCompare(b))
  .flatMap(([path, mod]) => {
    const parsed = AnimationSetSchema.safeParse(mod.default);
    if (!parsed.success) {
      console.warn(`[animations] ${path}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
      return [];
    }
    return [parsed.data];
  });

export function animationSets(): readonly AnimationSet[] {
  return SETS;
}

export interface ClipQuery {
  /** The rig the character's skeleton is, e.g. `unreal`. */
  rig: string;
  /** A race set applies to `race/sex`; absent for anything with no race. */
  race?: string | null;
  sex?: string | null;
  /** What is in hand. Absent means empty-handed — the RIG layer, not a stance. */
  stance?: Stance | null;
  readiness: Readiness;
}

const cache = new Map<string, Partial<Record<Action, string>>>();

/**
 * Flatten `rig ← race ← stance ← readiness` into one action → clip table.
 *
 * ⚠ `unarmed` is not a stance and must never be passed as one (D-564). It is
 * the rig layer — the base everything falls through to — so a character with
 * nothing in hand simply has no stance set applied, and a set named `unarmed`
 * would look identical in the tool and mean the opposite.
 *
 * ⚠ `peaceful` readiness applies NOTHING (D-565). A man with a sheathed sword
 * walks like a man, so the absence of an override IS the peaceful case; only
 * `combat` has sets. Passing `<stance>/peaceful` would silently match no set
 * and look the same until somebody authored one.
 */
export function clipTable(q: ClipQuery): Partial<Record<Action, string>> {
  const key = `${q.rig}|${q.race ?? ''}/${q.sex ?? ''}|${q.stance ?? ''}|${q.readiness}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const layers: AnimationSet[] = [];
  for (const set of SETS) {
    if (set.layer === 'rig' && set.applies === q.rig) layers.push(set);
    else if (set.layer === 'race' && q.race && set.applies === `${q.race}/${q.sex ?? ''}`) {
      layers.push(set);
    } else if (set.layer === 'stance' && q.stance && set.applies === q.stance) layers.push(set);
    else if (
      set.layer === 'readiness'
      && q.stance
      && q.readiness === 'combat'
      && set.applies === readinessApplies(q.stance, 'combat')
    ) {
      layers.push(set);
    }
  }
  // `resolveAnimations` owns the precedence, not the order things were pushed
  // here — it reads `ANIMATION_LAYERS`, so a fourth layer cannot be silently
  // dropped by this loop getting its ifs in the wrong order.
  const table = resolveAnimations(layers);
  cache.set(key, table);
  return table;
}
