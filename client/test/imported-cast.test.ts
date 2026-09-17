import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLIP, actionFor, clipFor, readinessTransition }
  from '../src/render/imported-visual';
import { animationSets, clipTable, setAnimationSets } from '../src/render/animation-sets';
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

// The sets arrive on the wire in the game (D-630); here they are read off
// disk the way the server reads them, so the table under test is the shipped
// content and not a fixture.
const ANIMATIONS_DIR = fileURLToPath(new URL('../../content/animations', import.meta.url));
setAnimationSets(
  readdirSync(ANIMATIONS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(ANIMATIONS_DIR, f), 'utf8')) as unknown),
);

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
    // ⚠ A CHAIR sit, which is what `sitting` now means (D-615). On the
    // ground it is a different action, because it is a different shape: the
    // library's sit puts the hips 58cm up, round furniture.
    expect(actionFor({ dead: false, posture: 'sitting', moving: false, seated: true }))
      .toBe('sitting');
  });

  it('⚠ sits on the GROUND when there was no chair (D-615)', () => {
    // The `*sits*` emote never mentions furniture, so it must not borrow the
    // pose that assumes some. The server is the one that knows -- the `sit`
    // verb finds a seat and the emote does not -- so the flag comes from it.
    expect(actionFor({ dead: false, posture: 'sitting', moving: false, seated: false }))
      .toBe('sit-ground');
    // ⚠ And absent means the ground, not the chair. Anything that forgets
    // to pass the flag should end up sitting on the floor, which looks odd in
    // a tavern; the opposite default hides the bug by looking normal.
    expect(actionFor({ dead: false, posture: 'sitting', moving: false })).toBe('sit-ground');
  });

  it('⚠ RUNS when the weapon is up (D-619)', () => {
    // The server moves a fighting body at `RUN_SPEED`, so the walk cycle here
    // would be a stride that does not match the ground going past -- the
    // moonwalk every renderer with one locomotion clip eventually shows.
    expect(actionFor({ dead: false, posture: 'standing', moving: true, combat: true }))
      .toBe('run');
    // ⚠ Standing still with a weapon up is still the IDLE, resolved through
    // the combat cut of the stance (D-565). A guard stance is not a run on
    // the spot, and there is no `combat-idle` in the vocabulary to reach for.
    expect(actionFor({ dead: false, posture: 'standing', moving: false, combat: true }))
      .toBe('idle');
    // And a body that is not fighting walks, whatever else is true of it.
    expect(actionFor({ dead: false, posture: 'standing', moving: true, combat: false }))
      .toBe('walk');
  });

  it('falls back to the walk for a rig with no run bound', () => {
    // ⚠ A missing clip must not freeze a moving character. Every authored
    // set with a combat cut names a run; this is the floor for one nobody has
    // bound, and a fast walk reads as wrong where a statue sliding along the
    // ground reads as broken.
    expect(clipFor(
      { dead: false, posture: 'standing', moving: true, combat: true },
      {},
    )).toBe(CLIP.walk);
    expect(clipFor(
      { dead: false, posture: 'standing', moving: true, combat: true },
      { run: 'one-handed-combat-run' },
    )).toBe('one-handed-combat-run');
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

/**
 * The rig's own idle, READ off the set rather than written here. These tests
 * are about the layering — rig under stance under readiness — and which clip
 * the rig idles on is a content decision the Animations tab changes; it went
 * from `unarmed-idle` to `neutral-idle` in the tool and three tests broke on
 * a value that was never theirs to hold.
 */
const RIG_IDLE = animationSets().find((set) => set.id === 'rig-unreal')!.clips['idle']!;

describe('the layers a character resolves through (D-564, D-565, D-578)', () => {
  it('gives an empty-handed character the RIG clips, with no stance applied', () => {
    // ⚠ `unarmed` is the rig layer, never a stance (D-564). A character
    // holding nothing has no stance set — not a set called `unarmed`.
    const table = clipTable({ rig: 'unreal', readiness: 'peaceful' });
    expect(table.idle).toBe(RIG_IDLE);
    expect(table.walk).toBe('unarmed-walk');
  });

  it('lets a stance override the rig, and readiness override the stance', () => {
    const peaceful = clipTable({ rig: 'unreal', stance: 'bow', readiness: 'peaceful' });
    // A man with a bow slung walks like a man: the stance set names draw and
    // sheathe, and is silent about idle, so the rig's own clip falls through.
    expect(peaceful.idle).toBe(RIG_IDLE);
    expect(peaceful.draw).toBe('bow-draw');

    const ready = clipTable({ rig: 'unreal', stance: 'bow', readiness: 'combat' });
    // ⚠ Read from CONTENT, never hard-coded (D-110). This asserted the
    // literal 'bow-combat-idle' and broke the moment somebody legitimately
    // re-pointed that row in the creation tool — so a valid authoring change
    // failed the build with a message about a clip name, which says nothing
    // about what is actually wrong. What the LAYERING promises is that the
    // combat set wins over the fall-through, and that is what is checked: the
    // clip is whatever `combat-bow` names, and it is not the rig's own idle.
    const combatBow = animationSets().find((set) => set.id === 'combat-bow');
    expect(combatBow, 'the bow combat set is authored').toBeTruthy();
    expect(ready.idle).toBe(combatBow!.clips.idle);
    // The combat set wins over the fall-through on EVERY action it names.
    // ⚠ Not "differs from the peaceful table": the rig and the bow's combat
    // set may legitimately name the same idle (they do today), and a test
    // that needed them to differ was a test about content, not layering.
    for (const [action, clip] of Object.entries(combatBow!.clips)) {
      expect(ready[action as keyof typeof ready], action).toBe(clip);
    }
    expect(ready.shoot).toBe(combatBow!.clips.shoot);
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
      expect(clipTable({ rig: 'unreal', stance, readiness: 'combat' }).idle).toBe(RIG_IDLE);
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

describe('nobody is drawn as a goblin by accident (D-618)', () => {
  const person = (id: string) => ({
    id, model: `${id}.glb`, palette: null, animations: 'a.glb', rig: 'unreal',
    variant: 'unreal', source: 'defined' as const, height: 1.7, parts: null,
    kind: 'person' as const,
  });
  const creature = (id: string) => ({ ...person(id), kind: 'creature' as const });

  it('⚠ draws the seed fallback from PEOPLE only', () => {
    // ⚠ Reported as "one of the bots shows up as a goblin". Ten of the twelve
    // built characters are monsters, and anybody who never chose a face — every
    // bot, every NPC, every pre-creation character — was handed one of the
    // thirteen at random. A goblin should be drawn when content SAYS a thing is
    // a goblin (a roamer naming its look, D-594), never by a number.
    const all = [
      person('ashfold-guard'), creature('goblin'), creature('skeleton-soldier'),
      person('polygon-hero-male'), creature('rock-golem'),
    ];
    const drawn = new Set<string>();
    for (let seed = 0; seed < 500; seed++) drawn.add(pickOutfit(all, seed)!.id);
    expect([...drawn].sort()).toEqual(['ashfold-guard', 'polygon-hero-male']);
  });

  it('⚠ falls back to everything rather than to nobody', () => {
    // An unclassified checkout drawing the wrong bodies is a bug somebody can
    // see; an empty tavern reads as the server being down.
    const all = [creature('goblin'), creature('rock-golem')];
    expect(pickOutfit(all, 7)).not.toBeNull();
  });

  it('keeps the same body for the same seed', () => {
    // The seed is the server's (D-102) so every client agrees, and a character
    // keeps its body between sessions. Filtering must not make it wobble.
    const all = [person('a'), creature('c'), person('b')];
    expect(pickOutfit(all, 991)!.id).toBe(pickOutfit(all, 991)!.id);
  });
});


/**
 * Weapons are only out in combat, and getting them out is a motion (D-620).
 *
 * ⚠ A weapon used to be welded to the fist from the moment it was equipped,
 * so the whole cast stood about the tavern holding drawn steel -- and the
 * twelve draw and sheathe clips D-564 fetched and D-565 put in the stance
 * layer had never been played by anything at all.
 */
describe('drawing and sheathing (D-620)', () => {
  it('puts the blade in the hand at the START of a draw', () => {
    // The clip's hand reaches to the hip and comes back holding something.
    // Nothing to hold makes the motion meaningless, so it is there from the
    // first frame rather than from the last.
    const step = readinessTransition({ toCombat: true, armed: true, clipSeconds: 1.1 });
    expect(step.action).toBe('draw');
    expect(step.weaponOut).toBe(true);
    expect(step.stowAfter).toBe(0);
  });

  it('⚠ keeps it in the hand until the sheathe FINISHES', () => {
    // The asymmetry is the whole point. Hiding it when combat ends is a sword
    // that vanishes while the hand is still putting it away -- which reads as
    // a missing model rather than as a bug in a flag.
    const step = readinessTransition({ toCombat: false, armed: true, clipSeconds: 0.9 });
    expect(step.action).toBe('sheathe');
    expect(step.weaponOut).toBe(true);
    expect(step.stowAfter).toBeCloseTo(0.9, 5);
  });

  it('plays nothing for an empty hand, and still tracks the flag', () => {
    // ⚠ An unarmed character entering combat changes how they STAND --
    // that is the readiness layer (D-565) and it happens either way. A draw
    // with nothing to draw would be the renderer claiming something happened.
    const up = readinessTransition({ toCombat: true, armed: false, clipSeconds: 1.1 });
    expect(up.action).toBeNull();
    // ⚠ The flag is still set, or somebody who equips mid-fight gets an
    // invisible weapon and no event that would ever reveal it.
    expect(up.weaponOut).toBe(true);
    const down = readinessTransition({ toCombat: false, armed: false, clipSeconds: 1.1 });
    expect(down.action).toBeNull();
    expect(down.weaponOut).toBe(false);
  });

  it('stows immediately when no sheathe clip is bound', () => {
    // A rig with no transition must not leave the blade out forever: the
    // failure of a missing clip should be "it snapped away", not "combat
    // never ends".
    const step = readinessTransition({ toCombat: false, armed: true, clipSeconds: 0 });
    expect(step.action).toBeNull();
    expect(step.weaponOut).toBe(false);
    expect(step.stowAfter).toBe(0);
  });

  it('draws with no clip bound, and the blade still appears', () => {
    const step = readinessTransition({ toCombat: true, armed: true, clipSeconds: 0 });
    expect(step.action).toBeNull();
    expect(step.weaponOut).toBe(true);
  });
});
