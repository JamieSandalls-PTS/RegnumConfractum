import { describe, expect, it } from 'vitest';
import {
  ACTIONS,
  ACTION_GROUPS,
  REQUIRED_ACTIONS,
  STANCES,
  type AnimationSet,
  missingActions,
  resolveAnimations,
} from '../src/actions';
import { AssetFileSchema, assetProblems, kindOfMesh } from '../src/assets';

/**
 * Where animation varies, and it is not race (D-561).
 *
 * The stakeholder asked whether animations should hang under race and then
 * gender. They should not, and the weapons are why: clips bind to bones by
 * name so a set belongs to a RIG, and what actually changes how somebody
 * moves is what is in their hands. With 163 weapons in these packs, a design
 * that nests animation under race leaves the heaviest case nowhere to live.
 *
 * So the layers stack instead: rig, then race and body, then stance.
 */
const set = (
  layer: AnimationSet['layer'],
  applies: string,
  clips: Record<string, string>,
): AnimationSet => ({ id: `${layer}-${applies}`, name: applies, layer, applies, clips });

describe('layering animation sets (D-561)', () => {
  const rig = set('rig', 'unreal', { idle: 'base-idle', walk: 'base-walk', 'attack-1': 'base-swing' });

  it('uses the base when nothing overrides it', () => {
    expect(resolveAnimations([rig])).toEqual({
      idle: 'base-idle',
      walk: 'base-walk',
      'attack-1': 'base-swing',
    });
  });

  it('lets a race restyle a gait without restating everything', () => {
    // The flavour case: a heavier walk, and every other clip inherited.
    const race = set('race', 'highland-folk/male', { walk: 'heavy-walk' });
    const out = resolveAnimations([rig, race]);
    expect(out.walk).toBe('heavy-walk');
    expect(out.idle).toBe('base-idle');
  });

  it('lets a weapon beat the race, because a greatsword changes more than ancestry', () => {
    const race = set('race', 'highland-folk/male', { walk: 'heavy-walk', idle: 'proud-idle' });
    const stance = set('stance', 'two-handed', { walk: 'greatsword-walk', 'attack-1': 'overhead' });
    const out = resolveAnimations([rig, race, stance]);
    expect(out.walk).toBe('greatsword-walk');
    expect(out['attack-1']).toBe('overhead');
    // And what the stance is silent about still comes from the race.
    expect(out.idle).toBe('proud-idle');
  });

  it('does not care what order the sets are handed over in', () => {
    // They are resolved by LAYER, not by position, so a caller collecting
    // sets from three different files cannot change the answer by accident.
    const race = set('race', 'r', { walk: 'race-walk' });
    const stance = set('stance', 's', { walk: 'stance-walk' });
    expect(resolveAnimations([stance, rig, race]).walk).toBe('stance-walk');
    expect(resolveAnimations([race, stance, rig]).walk).toBe('stance-walk');
  });

  it('names what is missing rather than playing nothing quietly', () => {
    // A character with no idle and no walk is a statue that slides. Every
    // other action may legitimately be absent.
    expect(missingActions({})).toEqual([...REQUIRED_ACTIONS]);
    expect(missingActions({ idle: 'a', walk: 'b' })).toEqual([]);
    expect(missingActions({ idle: 'a' })).toEqual(['walk']);
  });
});

describe('the action vocabulary (D-561)', () => {
  it('names every action exactly once', () => {
    expect(new Set(ACTIONS).size).toBe(ACTIONS.length);
  });

  it('accounts for every action in exactly one group', () => {
    // A tool renders the groups; an action in none of them is invisible, and
    // one in two of them is offered twice.
    const grouped = Object.values(ACTION_GROUPS).flat();
    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped].sort()).toEqual([...ACTIONS].sort());
  });

  it('requires only what nothing can do without', () => {
    for (const action of REQUIRED_ACTIONS) expect(ACTIONS).toContain(action);
    expect(REQUIRED_ACTIONS.length).toBeLessThan(4);
  });

  it('has a stance for every way of holding something', () => {
    expect(new Set(STANCES).size).toBe(STANCES.length);
    expect(STANCES).toContain('unarmed');
    expect(STANCES).toContain('two-handed');
  });
});

describe('sorting a pack by what its meshes are (D-561)', () => {
  it('reads the vendor prefix, which is consistent across these packs', () => {
    expect(kindOfMesh('SM_Wep_Broadsword_01')).toBe('character-item');
    expect(kindOfMesh('SM_Bld_Castle_Door')).toBe('environment');
    expect(kindOfMesh('SM_Prop_Barrel_01')).toBe('environment');
    expect(kindOfMesh('SM_Item_Potion_01')).toBe('pickup');
  });

  it('admits when it does not know, rather than guessing a kind', () => {
    // A mesh filed into the wrong tab is one somebody has to notice; one
    // filed nowhere is one they go looking for.
    expect(kindOfMesh('SK_Chr_Head_Male_00')).toBeNull();
    expect(kindOfMesh('AATestmesh')).toBeNull();
  });

  it('treats a RIGGED mesh as a weapon (D-568)', () => {
    // The bow pack ships its bows as skinned meshes with an eight-bone draw
    // rig and no `Wep_` prefix. Without this they are the only weapons in the
    // repository that no tool lists, which is invisible rather than wrong.
    expect(kindOfMesh('Rigged_Bow_Testing')).toBe('character-item');
    expect(kindOfMesh('Rigged_CrossBow_Testing')).toBe('character-item');
  });

  it('does NOT classify ammunition by word, because English is not a classifier', () => {
    // ⚠ A rule matching Arrow/Bolt/Quiver was tried here and reverted. It
    // filed the bow pack's three projectiles correctly and broke three other
    // meshes doing it: a "bolt" is a fastener as often as it is ammunition,
    // and an "arrow" modifies a "slit". These three must stay where their
    // prefix puts them; the bow pack's oddities are filed by hand instead,
    // and `nameAssets` leaves a hand correction alone.
    expect(kindOfMesh('SM_Env_Basement_Support_Beam_Bolt_01')).toBe('environment');
    expect(kindOfMesh('SM_Prop_Bolt_01')).toBe('environment');
    expect(kindOfMesh('SM_Bld_Castle_Arrow_Slit_01')).toBe('environment');
  });
});

describe('validating named assets (D-561)', () => {
  const file = (assets: unknown[]): unknown => ({
    pack: 'knights',
    kind: 'character-item',
    assets,
  });
  const sword = {
    kind: 'character-item',
    id: 'arming-sword',
    name: 'Arming sword',
    pack: 'knights',
    mesh: 'SM_Wep_Broadsword_01',
    attach: 'Hand_R',
    stance: 'one-handed',
  };

  it('accepts a named weapon', () => {
    const parsed = AssetFileSchema.parse(file([sword]));
    expect(assetProblems(parsed, new Set(['SM_Wep_Broadsword_01']))).toEqual([]);
  });

  it('refuses two things sharing a name', () => {
    // Legal data, broken menu: a player choosing between two identical words
    // is not choosing.
    const parsed = AssetFileSchema.parse(
      file([sword, { ...sword, id: 'other', mesh: 'SM_Wep_Rapier_01' }]),
    );
    expect(assetProblems(parsed, null).join(' ')).toMatch(/names both/);
  });

  it('refuses a mesh the pack does not ship', () => {
    const parsed = AssetFileSchema.parse(file([sword]));
    expect(assetProblems(parsed, new Set(['something-else'])).join(' ')).toMatch(/is not in knights/);
  });

  it('defaults a transform rather than demanding one', () => {
    // Most items hang correctly from the bone with no offset; requiring six
    // numbers per item would make naming a hundred weapons unbearable.
    const parsed = AssetFileSchema.parse(file([sword]));
    const item = parsed.assets[0]!;
    expect(item.kind).toBe('character-item');
    if (item.kind === 'character-item') {
      expect(item.transform.scale).toBe(1);
      expect(item.transform.position).toEqual([0, 0, 0]);
    }
  });
});
