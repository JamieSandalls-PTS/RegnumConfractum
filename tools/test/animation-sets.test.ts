import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACTIONS,
  AnimationSetSchema,
  REQUIRED_ACTIONS,
  animationSetProblems,
  inheritedAnimations,
  missingActions,
  resolveAnimations,
  type AnimationSet,
} from '@rc/shared';
import { WISHLIST, wishFilename } from '../src/animation-wishlist';
import { clipNameFor, draftSets } from '../src/draft-animation-sets';

const contentDir = join(__dirname, '..', '..', 'content', 'animations');

function authored(): AnimationSet[] {
  if (!existsSync(contentDir)) return [];
  return readdirSync(contentDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => AnimationSetSchema.parse(JSON.parse(readFileSync(join(contentDir, f), 'utf8'))));
}

/**
 * The animation sets, and the layering that makes them small (D-564).
 *
 * The stakeholder does not read code (D-114), and none of this is visible in
 * the browser until something plays the wrong clip. So the properties that
 * matter are asserted here: that a stance inherits rather than repeats, that a
 * set naming an unbuilt clip is refused, and that the resolved whole can walk.
 */
describe('animation sets', () => {
  it('resolves the most specific layer last', () => {
    const rig: AnimationSet = {
      id: 'rig-x',
      name: 'base',
      layer: 'rig',
      applies: 'x',
      clips: { idle: 'base-idle', walk: 'base-walk', 'attack-1': 'base-punch' },
    };
    const stance: AnimationSet = {
      id: 'stance-two-handed',
      name: 'greatsword',
      layer: 'stance',
      applies: 'two-handed',
      clips: { 'attack-1': 'greatsword-slash' },
    };
    const resolved = resolveAnimations([stance, rig]);
    // Order in the ARRAY must not decide it — the layer does. Passing the
    // stance first is exactly how a caller would get this wrong.
    expect(resolved['attack-1']).toBe('greatsword-slash');
    expect(resolved.walk).toBe('base-walk');
  });

  it('tells an author what an empty row will actually play', () => {
    const rig: AnimationSet = {
      id: 'rig-x',
      name: 'base',
      layer: 'rig',
      applies: 'x',
      clips: { idle: 'base-idle', walk: 'base-walk' },
    };
    const stance: AnimationSet = {
      id: 'stance-bow',
      name: 'bow',
      layer: 'stance',
      applies: 'bow',
      clips: { shoot: 'bow-shoot' },
    };
    const inherited = inheritedAnimations([rig, stance], stance);
    expect(inherited.walk).toBe('base-walk');
    // Its OWN clips are not inherited: a row showing "inherits bow-shoot"
    // under the set that defines bow-shoot would be a lie about where it
    // comes from.
    expect(inherited.shoot).toBeUndefined();
  });

  it('refuses a set that names a clip nothing built', () => {
    const set: AnimationSet = {
      id: 'stance-bow',
      name: 'bow',
      layer: 'stance',
      applies: 'bow',
      clips: { shoot: 'bow-shoot' },
    };
    expect(animationSetProblems(set, new Set(['bow-shoot']))).toEqual([]);
    expect(animationSetProblems(set, new Set(['something-else'])).join(' ')).toContain(
      'not built',
    );
    // With no clip list — which is CI, where the build product is absent —
    // the clip half is simply not checked rather than failing everything.
    expect(animationSetProblems(set, null)).toEqual([]);
  });

  it('refuses a stance set that applies to something that is not a stance', () => {
    const set: AnimationSet = {
      id: 'stance-sword',
      name: 'sword',
      layer: 'stance',
      applies: 'sword',
      clips: { 'attack-1': 'a' },
    };
    expect(animationSetProblems(set, null).join(' ')).toContain('must apply to one of');
  });

  it('refuses a set that changes nothing', () => {
    const set: AnimationSet = {
      id: 'rig-x',
      name: 'empty',
      layer: 'rig',
      applies: 'x',
      clips: {},
    };
    expect(animationSetProblems(set, null).join(' ')).toContain('names no clips');
  });

  /**
   * The drafter puts unarmed in the RIG layer, and that is the whole design.
   *
   * Drafted into a stance set instead it would look identical in the tool and
   * mean the opposite: nothing would inherit anything, and every stance would
   * need all 62 actions filled in by hand.
   */
  it('drafts the unarmed clips as the base layer, not as a stance', () => {
    const built = new Set(WISHLIST.map((w) => clipNameFor(w.stance, w.action, w.readiness)));
    const sets = draftSets(built);
    const base = sets.find((s) => s.layer === 'rig');
    expect(base, 'no rig set was drafted').toBeDefined();
    expect(Object.keys(base!.clips).length).toBeGreaterThan(30);
    expect(sets.some((s) => s.layer === 'stance' && s.applies === 'unarmed')).toBe(false);
    // A weapon set carries only what holding the thing changes.
    const twoHanded = sets.find((s) => s.applies === 'two-handed/combat');
    expect(Object.keys(twoHanded!.clips).length).toBeLessThan(Object.keys(base!.clips).length / 2);
  });

  /**
   * The readiness layer, and what it is FOR (D-565).
   *
   * A combat walk beats a stance walk beats the rig walk, and a character with
   * the weapon away resolves without ever seeing the combat set. Getting the
   * order wrong here would give a sheathed man a guard stride, which renders
   * perfectly and is wrong in every frame.
   */
  it('lets a weapon-up clip beat the stance and the rig', () => {
    const rig: AnimationSet = {
      id: 'rig-x', name: 'base', layer: 'rig', applies: 'x',
      clips: { idle: 'base-idle', walk: 'base-walk' },
    };
    const stance: AnimationSet = {
      id: 'stance-one-handed', name: 'carried', layer: 'stance', applies: 'one-handed',
      clips: { draw: 'one-handed-draw' },
    };
    const combat: AnimationSet = {
      id: 'combat-one-handed', name: 'up', layer: 'readiness', applies: 'one-handed/combat',
      clips: { walk: 'one-handed-combat-walk' },
    };
    // Weapon up: the combat walk wins, the draw still resolves, idle falls all
    // the way through. Array order deliberately puts the rig last.
    const up = resolveAnimations([combat, stance, rig]);
    expect(up.walk).toBe('one-handed-combat-walk');
    expect(up.draw).toBe('one-handed-draw');
    expect(up.idle).toBe('base-idle');

    // Weapon away: the caller simply does not pass the combat set, and the
    // character walks like anybody else.
    const away = resolveAnimations([stance, rig]);
    expect(away.walk).toBe('base-walk');
  });

  it('refuses a readiness set that does not name a stance and a readiness', () => {
    const bad = (applies: string): string[] =>
      animationSetProblems(
        { id: 'combat-x', name: 'x', layer: 'readiness', applies, clips: { walk: 'a' } },
        null,
      );
    expect(bad('one-handed/combat')).toEqual([]);
    expect(bad('one-handed').join(' ')).toContain('is not one of');
    expect(bad('sword/combat').join(' ')).toContain('is not a stance');
    expect(bad('one-handed/angry').join(' ')).toContain('is not one of');
  });

  it('drafts the draw and the combat walk into DIFFERENT layers', () => {
    const built = new Set(WISHLIST.map((w) => clipNameFor(w.stance, w.action, w.readiness)));
    const sets = draftSets(built);
    const stance = sets.find((s) => s.id === 'stance-one-handed');
    const combat = sets.find((s) => s.id === 'combat-one-handed');
    expect(stance?.layer).toBe('stance');
    expect(combat?.layer).toBe('readiness');
    // ⚠ Holstering belongs to the stance, not to either readiness: it is the
    // TRANSITION between them, so putting it in the combat set would mean a
    // sheathed character had no way to draw.
    expect(stance?.clips.draw).toBeTruthy();
    expect(stance?.clips.sheathe).toBeTruthy();
    expect(combat?.clips.draw).toBeUndefined();
    expect(combat?.clips.walk).toBeTruthy();
    expect(stance?.clips.walk).toBeUndefined();
  });

  it('keeps the burden stance out of the combat layer', () => {
    // A man with a barrel in his arms has no guard. `carrying` is the one
    // stance that is peaceful by nature, and it must stay in the stance layer.
    const built = new Set(WISHLIST.map((w) => clipNameFor(w.stance, w.action, w.readiness)));
    const sets = draftSets(built);
    expect(sets.find((s) => s.id === 'stance-carrying')?.layer).toBe('stance');
    expect(sets.some((s) => s.applies === 'carrying/combat')).toBe(false);
  });

  it('drafts nothing for a clip that did not build', () => {
    expect(draftSets(new Set())).toEqual([]);
  });

  it('names a clip the same way the build does', () => {
    // The build slugs the FILENAME; the drafter has to arrive at the same
    // string from the wish, or every set points at clips that do not exist.
    for (const wish of WISHLIST) {
      const fromFile = wishFilename(wish)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
      expect(clipNameFor(wish.stance, wish.action, wish.readiness)).toBe(fromFile);
    }
  });
});

describe('the authored sets', () => {
  it('resolve to something that can stand and walk', () => {
    const sets = authored();
    expect(sets.length, 'no animation sets in content/animations').toBeGreaterThan(0);
    expect(missingActions(resolveAnimations(sets))).toEqual([]);
    for (const required of REQUIRED_ACTIONS) {
      expect(resolveAnimations(sets)[required]).toBeTruthy();
    }
  });

  it('only ever name actions from the closed vocabulary', () => {
    // The schema enforces this, so this is really a check that the FILES on
    // disk went through it — a hand-edited set is the case that would not.
    for (const set of authored()) {
      for (const action of Object.keys(set.clips)) {
        expect(ACTIONS as readonly string[]).toContain(action);
      }
    }
  });

  it('have unique ids', () => {
    const ids = authored().map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
