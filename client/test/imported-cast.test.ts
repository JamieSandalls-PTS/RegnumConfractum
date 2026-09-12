import { describe, expect, it } from 'vitest';
import { CLIP, actionFor, clipFor } from '../src/render/imported-visual';
import { animationSets, clipTable } from '../src/render/animation-sets';
import { missingActions } from '@rc/shared';
import * as THREE from 'three';
import { heightOf, pickOutfit, type ImportedOutfit } from '../src/render/imported-models';

/**
 * The imported cast in the world (D-559).
 *
 * `ImportedVisual` itself is three.js driving a skinned mesh and needs a GPU
 * to say anything about. These two pieces do not, and they are the two that
 * can be wrong in a way nobody notices: a corpse that keeps walking, and a
 * tavern where every third person is the same man.
 *
 * The INTERFACE between the two casts is checked by the compiler rather than
 * here — `main.ts` holds them in one union and calls eighteen members on it,
 * so a member missing from either is a build failure, which is a better test
 * than any assertion.
 */

const outfit = (id: string): ImportedOutfit => ({
  id,
  model: `${id}.glb`,
  palette: `${id}.png`,
  animations: 'animations-unreal.glb',
  rig: 'unreal',
  variant: 'unreal',
  height: 1.7,
  parts: null,
});

describe('which clip an imported character plays (D-559)', () => {
  it('stands still, and walks when it moves', () => {
    expect(clipFor({ dead: false, posture: 'standing', moving: false })).toBe(CLIP.idle);
    expect(clipFor({ dead: false, posture: 'standing', moving: true })).toBe(CLIP.walk);
  });

  it('sits down when seated', () => {
    expect(clipFor({ dead: false, posture: 'sitting', moving: false })).toBe(CLIP.sit);
  });

  it('borrows the sit for a kneel, because there is no kneel', () => {
    // ⚠ A gap in the drop, stated rather than hidden: better a figure down on
    // the floor than one standing upright through a prayer.
    expect(clipFor({ dead: false, posture: 'kneeling', moving: false })).toBe(CLIP.sit);
  });

  it('stays dead whatever else it was doing', () => {
    // The server keeps sending posture and the client keeps computing
    // movement for a corpse; if either outranked death the body would stand
    // up and walk off, which is the one thing a corpse must never do.
    for (const posture of ['standing', 'sitting', 'kneeling'] as const) {
      for (const moving of [false, true]) {
        expect(clipFor({ dead: true, posture, moving })).toBe(CLIP.death);
      }
    }
  });
});

describe('which model an entity is drawn as (D-559)', () => {
  const cast = [outfit('guard'), outfit('townsfolk'), outfit('hero')];

  it('gives the same seed the same character every time', () => {
    // The seed is the server's, so this is what makes two clients agree
    // about who they are looking at, and a person keep their face between
    // sessions.
    for (const seed of [1, 7, 20260908, 2 ** 31 - 1]) {
      expect(pickOutfit(cast, seed)!.id).toBe(pickOutfit(cast, seed)!.id);
    }
  });

  it('uses the whole cast even when the seeds share their low bits', () => {
    // The case that matters, and the reason the seed is mixed before the
    // remainder is taken. Over CONSECUTIVE seeds a plain `seed % 3` spreads
    // perfectly well, so testing those proves nothing. Feed it seeds that
    // are all multiples of the cast size and the plain version collapses:
    // every single one picks outfit 0 and the whole tavern is one man.
    const seen = new Map<string, number>();
    for (let i = 1; i <= 300; i++) {
      const id = pickOutfit(cast, i * cast.length)!.id;
      seen.set(id, (seen.get(id) ?? 0) + 1);
    }
    expect(seen.size, 'the cast collapsed to a subset').toBe(cast.length);
    for (const [id, n] of seen) {
      // Nothing here needs to be uniform, only not degenerate.
      expect(n, `${id} appeared ${n} times in 300`).toBeGreaterThan(40);
    }
  });

  it('never picks a character that is not in the cast', () => {
    for (let seed = -50; seed <= 50; seed++) {
      const picked = pickOutfit(cast, seed);
      expect(cast).toContain(picked);
    }
  });

  it('returns nothing when no models are built', () => {
    // The path that matters most: a client whose `models/` was never built
    // has to fall back to the procedural cast rather than draw an empty
    // tavern.
    expect(pickOutfit([], 12345)).toBeNull();
  });

  it('copes with a single character', () => {
    expect(pickOutfit([outfit('only')], 99)!.id).toBe('only');
  });
});

/* ------------------------------------------------- wearing a garment ---- */

import { dressedParts, type ManifestGarment } from '../src/render/imported-models';
import { CHARACTER_SLOTS } from '@rc/shared';

/**
 * Which parts a dressed character is built from (D-571).
 *
 * ⚠ Pure, and worth testing precisely because the failure is silent. Getting
 * this wrong does not throw — it renders somebody in the wrong coat, or in no
 * coat at all, and the only sign is that the armour a player just equipped
 * did not appear.
 */
const dressable = (over: Partial<ImportedOutfit> = {}): ImportedOutfit => ({
  ...outfit('townsfolk'),
  parts: {
    pack: 'pack-a',
    sex: 'male',
    parts: { head: 'Head_00', torso: 'Torso_00', hips: 'Hips_00', handL: 'HandL_00' },
  },
  ...over,
});

const plate: ManifestGarment = {
  id: 'plate',
  pack: 'pack-a',
  parts: {
    male: { torso: 'Torso_15', hips: 'Hips_15' },
    female: { torso: 'Torso_F15', hips: 'Hips_F15' },
  },
};
const cloak: ManifestGarment = {
  id: 'cloak',
  pack: 'pack-b',
  parts: { male: { torso: 'Torso_99', back: 'Cape_01' }, female: { torso: 'Torso_F99', back: 'Cape_01' } },
};

describe('dressing an imported character (D-571)', () => {
  it('swaps the garment in and keeps everything else', () => {
    const got = dressedParts(dressable(), ['plate'], [plate]);
    expect(Object.fromEntries(got.map((p) => [p.slot, p.stem]))).toEqual({
      head: 'Head_00',
      torso: 'Torso_15',
      hips: 'Hips_15',
      handL: 'HandL_00',
    });
  });

  it('takes the cut that matches the BODY, not the player', () => {
    // ⚠ Sex here selects which MESHES fit (D-558): the pack cuts most parts
    // twice and a female forearm on a male upper arm meets it at the wrong
    // diameter. It is a property of the character that was assembled, which
    // is why it comes off the manifest and never off the wire.
    const female = dressable({
      parts: { pack: 'pack-a', sex: 'female', parts: { torso: 'Torso_F00' } },
    });
    // Both of the garment's slots, both in the female cut — the hips come
    // along because the garment covers them, which is a slot this body did
    // not have and is the case below.
    expect(dressedParts(female, ['plate'], [plate]).map((p) => p.stem)).toEqual([
      'Torso_F15',
      'Hips_F15',
    ]);
    expect(dressedParts(dressable(), ['plate'], [plate]).map((p) => p.stem)).toContain('Torso_15');
  });

  it('carries each garment its OWN pack', () => {
    // A garment may come from a pack the character does not. The part file is
    // named by pack and stem together, so getting this wrong asks for a mesh
    // that is not there rather than quietly using the wrong one.
    const got = dressedParts(dressable(), ['cloak'], [cloak]);
    expect(got.find((p) => p.slot === 'torso')).toEqual({
      slot: 'torso', pack: 'pack-b', stem: 'Torso_99',
    });
    expect(got.find((p) => p.slot === 'head')).toEqual({
      slot: 'head', pack: 'pack-a', stem: 'Head_00',
    });
  });

  it('lets the LATER garment win a contested slot', () => {
    // Two garments can claim one body slot — a hauberk and a cloak both
    // covering the torso. The wire orders them canonically (`lookOf`), so
    // every observer resolves the collision the same way; the alternative is
    // two clients drawing the same person in two different coats.
    const both = dressedParts(dressable(), ['plate', 'cloak'], [plate, cloak]);
    expect(both.find((p) => p.slot === 'torso')!.stem).toBe('Torso_99');
    const swapped = dressedParts(dressable(), ['cloak', 'plate'], [plate, cloak]);
    expect(swapped.find((p) => p.slot === 'torso')!.stem).toBe('Torso_15');
  });

  it('adds a slot the body did not have', () => {
    // A cape is not a swap — nothing was on `back`. It has to be ADDED, and
    // it brings bones the character's skeleton does not carry, which is
    // exactly why dressing re-assembles rather than grafting onto the built
    // model.
    expect(dressedParts(dressable(), ['cloak'], [cloak]).map((p) => p.slot)).toContain('back');
  });

  it('returns parts in SLOT ORDER, whatever order they were named in', () => {
    // ⚠ Not cosmetic. `assemble` derives its bone array by walking the
    // hierarchy as it builds it, so the order parts arrive in decides the
    // order bones end up in. It does not change what renders — measured — but
    // two assemblies of one character that disagree make any later comparison
    // between build and browser meaningless.
    const got = dressedParts(dressable(), ['plate'], [plate]).map((p) => p.slot);
    const expected = (CHARACTER_SLOTS as readonly string[]).filter((s) => got.includes(s));
    expect(got).toEqual(expected);
  });

  it('ignores a garment the manifest does not know', () => {
    // A client whose models were built before the garment existed must draw
    // the character it has, not throw and leave an empty space where somebody
    // is standing.
    expect(dressedParts(dressable(), ['nonesuch'], [plate])).toHaveLength(4);
  });

  it('dresses NOTHING when the character has no slot vocabulary', () => {
    // A character from a `.unitypackage` or a folder of loose FBX (D-556,
    // D-557) has meshes named after whatever file they came from, so a swap
    // has nothing to replace. `loadDressed` falls back to the plain model.
    expect(dressedParts(outfit('loose'), ['plate'], [plate])).toEqual([]);
  });
});

/**
 * How tall a loaded model stands (D-577).
 *
 * ⚠ This is the number `ImportedVisual.attach` divides by to put a character
 * at the stature the server gave it, and getting it wrong is invisible in
 * every other check: the model loads, the clips play, the wire is right, and
 * the figure is simply the wrong size. It was wrong twice at once — the scale
 * was SET rather than multiplied, wiping the centimetre-to-metre conversion a
 * re-assembly depends on (D-571), and it divided by the MONOLITH's height
 * while drawing a different assembly.
 */
describe('how tall a loaded model stands (D-577)', () => {
  /** A two-bone figure `span` units tall, with a mesh that overhangs it. */
  const figure = (span: number, overhang: number): THREE.Object3D => {
    const root = new THREE.Bone();
    const top = new THREE.Bone();
    top.position.y = span;
    root.add(top);
    // A crest, a hair mesh, a raised pauldron — geometry ABOVE the top bone.
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([0, 0, 0, 0, span + overhang, 0], 3),
    );
    const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
    const group = new THREE.Group();
    group.add(root, mesh);
    mesh.bind(new THREE.Skeleton([root, top]));
    return group;
  };

  it('measures the SKELETON, the way build:characters does', () => {
    expect(heightOf(figure(1.7, 0))).toBeCloseTo(1.7, 5);
  });

  it('ignores geometry above the top bone — a crest is not stature', () => {
    // ⚠ The measurement that kept the existing cast the size it already was.
    // By mesh bounds the authored guard measures 1.92m against the manifest's
    // 1.70m, because he wears a helmet crest; normalising by that makes him a
    // short man in a tall hat, and silently resizes every character already
    // in the world by up to 13%.
    expect(heightOf(figure(1.7, 0.22))).toBeCloseTo(1.7, 5);
  });

  it('reports the height AFTER whatever scale the group carries', () => {
    // ⚠ Part files are centimetres by design (D-571) and the re-assembly
    // loaders convert on the way out, so the height has to be measured on the
    // scaled result or the caller divides metres by centimetres.
    const cm = figure(170, 0);
    cm.scale.setScalar(0.01);
    expect(heightOf(cm)).toBeCloseTo(1.7, 5);
  });

  it('falls back to bounds for something with no skeleton at all', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 2.5, 0], 3));
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    expect(heightOf(mesh)).toBeCloseTo(2.5, 5);
  });
});

/**
 * A character animates according to what they are HOLDING (D-564 → D-578).
 *
 * ⚠ D-564 authored 126 clips and fifteen sets and recorded that "nothing in
 * the game reads a set yet". Until this, the renderer picked clips by
 * hard-coded name, so eleven stances animated identically and a man with a bow
 * swung it like a sword. These assertions are the ones that would have caught
 * that, and the ones that catch it coming back.
 */
describe('which action a character is performing (D-578)', () => {
  it('returns an ACTION, not a clip name', () => {
    // ⚠ The whole point of the split. Which clip an action plays depends on
    // the stance and the readiness, and deciding it here is the hard-coding
    // this replaced.
    expect(actionFor({ dead: false, posture: 'standing', moving: false })).toBe('idle');
    expect(actionFor({ dead: false, posture: 'standing', moving: true })).toBe('walk');
  });

  it('kneels, instead of borrowing the sit', () => {
    // ⚠ D-559 recorded "kneeling borrows the sit, because there is no kneel".
    // There is one: `unarmed-kneel` shipped with the library and nothing read
    // it. Sitting and kneeling are now two different things on screen.
    expect(actionFor({ dead: false, posture: 'kneeling', moving: false })).toBe('kneel');
    expect(actionFor({ dead: false, posture: 'sitting', moving: false })).toBe('sitting');
  });

  it('lets death outrank everything', () => {
    expect(actionFor({ dead: true, posture: 'standing', moving: true })).toBe('death');
    expect(actionFor({ dead: true, posture: 'sitting', moving: false })).toBe('death');
  });
});

describe('resolving an action to a clip (D-578)', () => {
  const standing = { dead: false, posture: 'standing' as const, moving: false };
  const walking = { dead: false, posture: 'standing' as const, moving: true };

  it('plays what the resolved set names', () => {
    expect(clipFor(standing, { idle: 'bow-combat-idle' })).toBe('bow-combat-idle');
  });

  it('falls back to the clip that always existed', () => {
    // ⚠ Most sets are deliberately partial and fall through (D-564), so a
    // missing action is normal. Falling through to NOTHING would freeze a
    // character mid-stride, which is why the old hard-coded names are the
    // floor rather than being deleted.
    expect(clipFor(walking, {})).toBe(CLIP.walk);
    expect(clipFor(standing, { walk: 'bow-combat-walk' })).toBe(CLIP.idle);
  });
});

describe('the layers a character resolves through (D-564, D-565, D-578)', () => {
  it('gives an empty-handed character the RIG clips, with no stance applied', () => {
    // ⚠ `unarmed` is the rig layer, never a stance (D-564). A character
    // holding nothing has no stance set — not a set called `unarmed`.
    const table = clipTable({ rig: 'unreal', readiness: 'peaceful' });
    expect(table.idle).toBe('unarmed-idle');
    expect(table.walk).toBe('unarmed-walk');
  });

  it('lets a stance override the rig, and readiness override the stance', () => {
    const peaceful = clipTable({ rig: 'unreal', stance: 'bow', readiness: 'peaceful' });
    // A man with a bow slung walks like a man: the stance set names draw and
    // sheathe, and is silent about idle, so the rig's own clip falls through.
    expect(peaceful.idle).toBe('unarmed-idle');
    expect(peaceful.draw).toBe('bow-draw');

    const ready = clipTable({ rig: 'unreal', stance: 'bow', readiness: 'combat' });
    expect(ready.idle).toBe('bow-combat-idle');
    expect(ready.shoot).toBe('bow-combat-shoot');
    // ⚠ Draw and sheathe belong to the STANCE layer, not either readiness
    // (D-565) — they are the transition between the two, and a character
    // whose combat set owned them could never draw.
    expect(ready.draw).toBe('bow-draw');
  });

  it('gives every authored stance its own ATTACK in combat', () => {
    // ⚠ The assertion that would have caught the whole defect: before this
    // wiring every stance resolved to the same hard-coded clip name, so a bow
    // was shot with a sword swing.
    const stances = ['bow', 'dagger', 'one-handed', 'two-handed', 'polearm', 'staff', 'thrown'] as const;
    // ⚠ `attack-1 ?? shoot` is the chain the renderer uses, and the bow is why
    // it exists: `combat-bow` names no `attack-1` because you do not SWING a
    // bow, you shoot it. Asserting the raw key would have called correct
    // content a failure.
    const attacks = stances.map((stance) => {
      const t = clipTable({ rig: 'unreal', stance, readiness: 'combat' });
      return t['attack-1'] ?? t.shoot;
    });
    expect(attacks.every((a) => a !== undefined)).toBe(true);
    expect(new Set(attacks).size).toBe(stances.length);
  });

  it('lets a stance fall through to the rig idle when the library has none', () => {
    // ⚠ Asserted rather than assumed, because it looks like a bug and is not.
    // `dagger` and `thrown` name no combat idle — the library holds only their
    // attacks (2 clips each), which their own notes say — so a dagger fighter
    // stands like an unarmed one and stabs like a dagger fighter. That is the
    // fall-through working, and it is also a real gap in the CLIP LIBRARY
    // rather than in the sets: the fix is fetching those two idles, not
    // editing content.
    for (const stance of ['dagger', 'thrown'] as const) {
      expect(clipTable({ rig: 'unreal', stance, readiness: 'combat' }).idle).toBe('unarmed-idle');
    }
  });

  it('resolves EVERY authored set to something with an idle and a walk', () => {
    // The same floor CI holds the content to (D-564): a pile of stance sets
    // with no rig beneath them is legal data that renders a statue that slides.
    for (const set of animationSets()) {
      if (set.layer !== 'stance') continue;
      const table = clipTable({
        rig: 'unreal',
        stance: set.applies as Parameters<typeof clipTable>[0]['stance'],
        readiness: 'combat',
      });
      expect(missingActions(table)).toEqual([]);
    }
  });
});
