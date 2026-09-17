import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { MeshCloth, clothFor } from './mesh-cloth';
import type {
  Action,
  Appearance,
  CharacterLook,
  Direction,
  Posture,
  Presentation,
  Stance,
  TransientAnim,
} from '@rc/shared';
import { clipTable } from './animation-sets';
import { HOOD_ID } from './hood';
import { gripFor } from './held-items';
import { loadOneAsset } from './world-assets';
import type { EquipmentState } from './equipment-state';
import {
  available,
  loadDressed,
  loadLook,
  outfitFor,
  outfitForPack,
  outfitById,
  sexOfLook,
  type ImportedOutfit,
} from './imported-models';

/**
 * An imported character in the world (D-559).
 *
 * Drop-in for `CharacterVisual`: the same members `main.ts` drives, so the
 * game can be switched between the procedural cast and the imported one
 * without the world code knowing which it has. That is the whole point of
 * doing it this way — the stakeholder's verdict on the art (D-555) needs the
 * art in the GAME, moving between areas, in the tavern with other people,
 * not standing on a slab in a viewer.
 *
 * ⚠ It is NOT equivalent, and the ways it falls short are listed on the
 * members that fall short rather than hidden in a summary. Nothing here
 * pretends to do something it does not.
 */

/** Angle at which the model faces each way. Rest pose looks down +z. */
const FACING_ANGLE: Record<Direction, number> = {
  s: 0,
  se: Math.PI * 0.25,
  e: Math.PI * 0.5,
  ne: Math.PI * 0.75,
  n: Math.PI,
  nw: Math.PI * 1.25,
  w: Math.PI * 1.5,
  sw: Math.PI * 1.75,
};

/**
 * Which clip plays for what.
 *
 * Five clips is what the drop contains, so this is honest about the gaps
 * rather than inventing motion: there is no kneel, no sit-idle and no
 * emote, and each of those falls back to the nearest thing that exists.
 */
export const CLIP = {
  idle: 'neutral-idle',
  walk: 'walking',
  attack: 'standing-melee-attack-horizontal',
  death: 'death',
  sit: 'stand-to-sit',
} as const;

/**
 * The pack a player-chosen face is cut from.
 *
 * ⚠ One constant because two places need the same answer: which outfit's
 * ATLAS to paint the face with, and which pack to fetch the part meshes
 * from. They disagreed, and the disagreement is what made every skin tone
 * a no-op.
 */
const LOOK_PACK = 'modular-fantasy-hero';

/** How long a cross-fade takes. Matches the procedural rig's feel (D-514). */
const FADE = 0.22;

/**
 * Which ACTION a character in this state is performing.
 *
 * Pure, and exported, because it is the one piece of this class worth
 * testing without a GPU — everything else is three.js doing what three.js
 * does, but "a dead man keeps playing the walk" is a bug that reads as the
 * corpse getting up.
 *
 * ⚠ It returns an action from the closed vocabulary (D-561), not a clip name.
 * Which clip an action plays depends on what the character is holding and
 * whether their weapon is up (D-564, D-565) — that is the animation sets' job,
 * and deciding it here would be the hard-coded clip names this replaces.
 */
export function actionFor(state: {
  dead: boolean;
  posture: Posture;
  moving: boolean;
  /** On a real seat rather than the ground (D-615). */
  seated?: boolean;
  /** Weapon up. A fighting body RUNS (D-619). */
  combat?: boolean;
}): Action {
  // Death outranks everything. A body on the floor is not standing, sitting
  // or walking, whatever else the server last said about it.
  if (state.dead) return 'death';
  // ⚠ Kneeling is its OWN action now. D-559 recorded "kneeling borrows the
  // sit, because there is no kneel" — there is: `unarmed-kneel` shipped in
  // D-564's library and nothing read it. A figure praying now kneels.
  if (state.posture === 'kneeling') return 'kneel';
  // ⚠ A chair and the ground are two different actions (D-615). `sitting`
  // is the chair pose -- measured, its hips sit 58cm off the floor -- and the
  // `*sits*` emote used to resolve to it too, so anybody sitting down in a
  // field hovered at chair height with their legs round furniture that was
  // not there. The server says which, because only the server knows: the
  // `sit` verb finds a seat, the emote says nothing about furniture.
  if (state.posture === 'sitting') return state.seated ? 'sitting' : 'sit-ground';
  // ⚠ A weapon up means a run, not a faster walk (D-619). The server moves
  // a fighting body at `RUN_SPEED`, so playing the walk here would be a
  // stride that does not match the ground going past -- the moonwalk every
  // renderer with a single locomotion clip eventually shows.
  if (state.moving) return state.combat ? 'run' : 'walk';
  return 'idle';
}

/**
 * The clip an action plays, given the character's resolved set.
 *
 * ⚠ The fallback is the hard-coded name this module used to pick directly.
 * A resolved set that is missing an action is not an error — most sets are
 * deliberately partial and fall through (D-564) — but falling through to
 * NOTHING would freeze a character mid-stride, so the five clips that always
 * existed remain the floor.
 */
export function clipFor(
  state: {
    dead: boolean;
    posture: Posture;
    moving: boolean;
    seated?: boolean;
    combat?: boolean;
  },
  table: Partial<Record<Action, string>> = {},
): string {
  const action = actionFor(state);
  // ⚠ `sit-ground` falls back to the CHAIR sit, and that is deliberate
  // (D-615). There is no ground-sitting clip in the library -- measured: the
  // closest are `unarmed-sitting` at 58cm hips (a seat) and `unarmed-kneel` at
  // 43cm (a kneel), and hips on the floor would be around 20cm. Binding
  // either would be the substitution D-564 warns about, where a crouch shipped
  // as an idle because a search fell back to its first result.
  //
  // ⚠ So the SPLIT ships and the clip is wished for: `sit-ground` is in the
  // wishlist, and the day somebody fetches one it binds with no code change.
  // Until then an emote sit looks exactly as it does today rather than looking
  // wrong in a new way.
  if (action === 'sit-ground') {
    return table['sit-ground'] ?? table.sitting ?? FALLBACK.sitting ?? CLIP.idle;
  }
  return table[action] ?? FALLBACK[action] ?? CLIP.idle;
}

/** What each action played before there were sets to read (D-559). */
const FALLBACK: Partial<Record<Action, string>> = {
  idle: CLIP.idle,
  walk: CLIP.walk,
  // ⚠ A rig with no run clip walks rather than freezing (D-619). Every
  // authored set that has a combat cut names one, so this is the floor for a
  // rig nobody has bound -- and a fast walk reads as wrong where standing
  // still while the ground moves reads as broken.
  run: CLIP.walk,
  death: CLIP.death,
  sitting: CLIP.sit,
  // Borrowing the sit for a kneel is what D-559 had to do; it stays as the
  // floor for a rig whose set does not name one.
  kneel: CLIP.sit,
  'attack-1': CLIP.attack,
};


/**
 * What happens to the weapon when readiness changes (D-620).
 *
 * Pure, and exported, for the reason `actionFor` is: this is the whole of the
 * decision, and the rest of `crossReadiness` is three.js parenting. "The sword
 * disappeared halfway through putting it away" is a bug you can only see by
 * looking, and looking is not the reviewer (D-114).
 *
 * ⚠ The two halves are NOT symmetrical, and that is the design rather than
 * an oversight. The blade appears at the START of a draw -- the clip's hand
 * reaches to the hip and comes back holding something, and nothing to hold
 * makes the motion meaningless -- and leaves at the END of a sheathe, which is
 * the same sentence read backwards.
 *
 * ⚠ Nothing plays for an empty hand. An unarmed character entering combat
 * still changes how they STAND, because that is the readiness layer (D-565),
 * but a draw with nothing to draw is the renderer claiming something happened.
 */
export function readinessTransition(input: {
  /** Entering combat rather than leaving it. */
  toCombat: boolean;
  /** Is there anything in the hand at all? */
  armed: boolean;
  /** How long the bound draw/sheathe clip runs. Zero when none is bound. */
  clipSeconds: number;
}): {
  /** The action to play, or null to play nothing. */
  action: 'draw' | 'sheathe' | null;
  /** Whether the weapon is in the hand the moment this returns. */
  weaponOut: boolean;
  /** Seconds until the weapon leaves the hand; 0 means "not pending". */
  stowAfter: number;
} {
  if (!input.armed) {
    // Keep the flag honest anyway, or the day somebody equips mid-fight the
    // blade arrives invisible.
    return { action: null, weaponOut: input.toCombat, stowAfter: 0 };
  }
  if (input.toCombat) {
    return {
      action: input.clipSeconds > 0 ? 'draw' : null,
      weaponOut: true,
      stowAfter: 0,
    };
  }
  if (input.clipSeconds > 0) {
    // Still in the fist until the hand has finished putting it away.
    return { action: 'sheathe', weaponOut: true, stowAfter: input.clipSeconds };
  }
  return { action: null, weaponOut: false, stowAfter: 0 };
}

export class ImportedVisual {
  readonly root = new THREE.Group();

  private mixer: THREE.AnimationMixer | null = null;
  private clips = new Map<string, THREE.AnimationClip>();
  private current: THREE.AnimationAction | null = null;
  private currentName = '';
  private hand: THREE.Object3D | null = null;
  /** What the hand should hold, as `pack/asset` (D-614). */
  private heldWanted: string | undefined;
  /** What it actually holds, so a repeat does not reload the mesh. */
  private heldShown: string | null = null;
  /** ⚠ Which request owns the hand. Two quick equips would otherwise
   * leave the slower weapon parented on top of the faster one. */
  private heldToken = 0;
  private held: THREE.Object3D | null = null;
  private disposed = false;

  private targetAngle = 0;
  private angle = 0;
  private posture: Posture = 'standing';
  private seated = false;
  private dead = false;
  private lootable = true;
  private inCombat = false;
  private attackUntil = 0;
  /**
   * Is the weapon in the hand right now (D-620)?
   *
   * ⚠ NOT the same question as `inCombat`. A sheathe takes about a second,
   * and the blade has to stay in the fist for the whole of it or the hand
   * puts away something that vanished when the clip started. So this follows
   * combat on the way UP and the clip on the way DOWN.
   */
  private weaponOut = false;
  /**
   * While a draw or a sheathe is playing, in `performance.now()` ms.
   *
   * ⚠ Milliseconds and this clock, to match `emotingUntil` rather than
   * `attackUntil`. The two were already on different clocks in this file and
   * joining a third to the wrong one is how a transition either never holds
   * or holds forever.
   */
  private transitionUntil = 0;
  /** When the blade should leave the hand, in the same ms (D-620). */
  private stowAt = 0;
  /** What is in hand, per the server (D-578). Undefined is empty-handed. */
  private stance: Stance | undefined;
  /** `rig ← race ← stance ← readiness`, flattened. Rebuilt when an input moves. */
  private table: Partial<Record<Action, string>> = {};
  private layer = 0;
  private readonly outfit: ImportedOutfit | null;
  private model: THREE.Object3D | null = null;
  /**
   * Cloth on the parts that have it (D-631). One solver per clothing part
   * with settings in `content/cloth/`; the proxy meshes are parented to the
   * SCENE, not to `root`, because the simulation runs in world space.
   */
  private cloths: MeshCloth[] = [];
  private wearing: string[] = [];
  /** Hood up (D-616). Kept apart from `wearing`: it is not equipment. */
  private hooded = false;
  /** While an emote is playing, in `performance.now()` terms (D-616). */
  private emotingUntil = 0;

  /** Which clip is playing. Verification only (D-616). */
  get playing(): string {
    return this.currentName;
  }
  private dressToken = 0;
  private readonly appearanceHeight: number;

  /**
   * The face this player CHOSE, if they chose one (D-574).
   *
   * ⚠ Null is the normal case and not a fallback worth apologising for: every
   * NPC, roamer, corpse and pre-face-step character has none, and the seed
   * picks a body for them exactly as it did (D-559).
   */
  private readonly look: CharacterLook | null;

  constructor(
    appearance: Appearance,
    private parent: THREE.Scene,
    seed: number,
    look: CharacterLook | null = null,
    /**
     * The built character this entity IS, when the server said (D-594).
     *
     * ⚠ Named rather than drawn from the seed. The seed picks a body that is
     * deterministic and arbitrary, which is fine for a stranger in a tavern
     * and wrong for a goblin — D-559 left this open and this is the answer:
     * the content says.
     */
    model: string | null = null,
  ) {
    parent.add(this.root);
    this.appearanceHeight = appearance.height;
    this.look = look;
    // ⚠ The outfit is still resolved even when a look exists, because it is
    // what names the CLIP FILE for this rig and the palette — the look says
    // which meshes, not which animations. Losing it would leave a chosen face
    // standing perfectly still.
    // ⚠ A named model that is not built falls back to the seed rather than
    // failing to draw. An enemy nobody can see is worse than one that looks
    // like a townsman, and the build is what should have caught the missing
    // model — not the frame in front of a player.
    // ⚠ A chosen face picks its outfit by PACK, not by seed (D-602). The
    // outfit is what names the clip library AND the palette, and a seed-drawn
    // one painted a player's face from whichever of the twelve atlases the
    // number landed on. The seed remains the answer for everybody who chose
    // nothing — strangers, roamers, corpses — which is almost everybody.
    const forLook = look && Object.keys(look.parts).length > 0
      ? outfitForPack(LOOK_PACK)
      : null;
    this.outfit = (model ? outfitById(model) : null) ?? forLook ?? outfitFor(seed);
    if (!this.outfit) return;
    // ⚠ Resolve the layers UP FRONT, not on the first change of kit. Nearly
    // everybody in the world never equips anything and never draws a weapon —
    // roamers, the watch, the keeper, every corpse — so building the table
    // lazily would leave the authored rig set applying to almost nobody and
    // the old hard-coded clip names still running the world. That is the
    // defect this whole change exists to remove, surviving in the common case.
    this.retable();

    const token = ++this.dressToken;
    void this.modelFor([]).then((loaded) => {
      // The model arrives after the entity does, so a character can be in
      // the world for a frame or two before it can be seen. Preloading on
      // snapshot makes that the exception rather than the rule; bailing out
      // here matters more, because an entity can be gone by then.
      //
      // ⚠ The token check matters as well now: `setEquipment` can land before
      // this resolves, and without it the bare model would arrive second and
      // silently undress somebody.
      if (this.disposed || token !== this.dressToken) return;
      this.attach(loaded);
    });
  }

  /** Is the imported cast usable at all? */
  static available(): boolean {
    return available();
  }

  // ---------------------------------------------------------------- state

  setPosition(x: number, z: number, elevation = 0): void {
    this.root.position.set(x, elevation, z);
  }

  setFacing(dir: Direction): void {
    this.targetAngle = FACING_ANGLE[dir];
  }

  setPosture(posture: Posture, seated = false): void {
    this.posture = posture;
    // ⚠ On a seat or on the ground (D-615). Two different clips, and the
    // only thing that knows which is the server.
    this.seated = seated;
  }

  /**
   * Raise or drop the hood (D-219, built on this cast in D-616).
   *
   * ⚠ This was an empty method whose own comment called it a regression,
   * and the regression was load-bearing: recognition depends on the hood being
   * VISIBLE -- a hood dropping in view is what merges two identity threads --
   * so on the cast that actually ships, the mechanic rested on nothing.
   *
   * ⚠ It re-assembles rather than toggling a mesh, because that is what
   * this cast is: a body built from part files (D-571). The hood is a head
   * COVERING swapped into the assembly, which is why it conceals hair the way
   * the pack intends and why it costs no new machinery.
   */
  setPresentation(presentation: Presentation): void {
    const hooded = presentation === 'hooded';
    if (hooded === this.hooded) return;
    this.hooded = hooded;
    this.redress();
  }

  /**
   * Put a garment on, or take one off (D-571).
   *
   * ⚠ This used to do nothing, and the comment where it did nothing said so.
   * It now re-assembles the character out of part files with the garment's
   * slots swapped — because a garment IS a set of slot swaps (D-570) and the
   * art leaves no alternative: of 720 parts the torso has no bare option at
   * all, so a body and its clothes are the same mesh and there is nothing to
   * layer a breastplate over (D-560).
   *
   * ⚠ The five silhouette flags beside `garments` are still ignored here, and
   * that is correct rather than unfinished. They exist so the PROCEDURAL cast
   * can generate approximate armour geometry; this cast wears the actual
   * mesh, so reading them as well would be drawing the same pauldrons twice.
   *
   * ⚠ Nothing happens when the set has not changed. `setEquipment` is called
   * on every `entity_worn` and on every resync, and rebuilding a character
   * because the server repeated itself would drop the animation mid-stride.
   */
  setEquipment(next: Partial<EquipmentState>): void {
    // ⚠ Handled BEFORE the garment early-return below, exactly as the
    // stance is and for the same reason: swapping one sword for another
    // changes no mesh on the BODY, so a weapon change parked under the garment
    // check would never be seen.
    if ('weaponArt' in next && next.weaponArt !== this.heldWanted) {
      this.heldWanted = next.weaponArt;
      void this.refreshHeld();
    }
    // ⚠ The stance is handled BEFORE the early return below. Drawing a
    // different weapon need not change a single mesh — a bow and a sword are
    // both `art`, not garments — so a character who swapped one for the other
    // would keep the old stance forever if this sat under the garment check.
    if ('stance' in next && next.stance !== this.stance) {
      this.stance = next.stance;
      this.retable();
    }
    if (next.garments === undefined) return;
    const wanted = [...next.garments];
    if (wanted.length === this.wearing.length
      && wanted.every((g, i) => g === this.wearing[i])) {
      return;
    }
    this.wearing = wanted;
    this.redress();
  }

  /**
   * Rebuild the model for the current garments, keeping the character where
   * it is and doing what it was doing.
   *
   * ⚠ The old model is REMOVED, never disposed. Geometry, material and
   * palette are shared across every instance wearing the same thing — the
   * cache in `imported-models` hands the same scene to everyone — so
   * disposing here would blank every other character in the same kit, which
   * is the same trap `dispose()` already documents.
   */
  /**
   * The model for this character in this kit.
   *
   * ⚠ One place, so the constructor and a change of clothes cannot disagree
   * about which body they are dressing. A chosen face goes through `loadLook`
   * and everything else through `loadDressed`; both return the same shape and
   * both cache by combination, so a crowd still shares one assembly.
   */
  /**
   * ⚠ The hood is layered on at MODEL time, not folded into `wearing`.
   * `wearing` is compared to decide whether a change of clothes needs a
   * rebuild, so a hood living in it would be dropped by the next equipment
   * update -- and it is not equipment, which is the whole distinction.
   */
  private dressing(wearing: readonly string[]): readonly string[] {
    return this.hooded ? [...wearing, HOOD_ID] : wearing;
  }

  private modelFor(
    wearing: readonly string[],
  ): Promise<{
    scene: THREE.Object3D;
    clips: readonly THREE.AnimationClip[];
    /** How tall what came back stands, in metres — see `attach` (D-577). */
    height: number;
  }> {
    if (this.look && Object.keys(this.look.parts).length > 0) {
      return loadLook(
        this.look as { parts: Record<string, string>; skin?: string; markings?: string },
        this.lookPack(),
        this.outfit!,
        this.dressing(wearing),
      );
    }
    return loadDressed(this.outfit!, this.dressing(wearing));
  }

  /**
   * Which pack a look's parts come from.
   *
   * ⚠ Taken from the OUTFIT rather than stored on the look, because a look
   * names parts and a part is only meaningful inside a pack. Today every
   * character and every race is on one pack; when that stops being true this
   * is the line that has to carry the pack on the look instead, and it is
   * better to have one obvious place than a guess spread over three.
   */
  private lookPack(): string {
    return this.outfit?.parts?.pack ?? LOOK_PACK;
  }

  private redress(): void {
    if (!this.outfit) return;
    const token = ++this.dressToken;
    void this.modelFor(this.wearing).then((loaded) => {
      // Three ways to be stale by the time this resolves: the entity is gone,
      // something newer is already on its way, or a faster call has landed.
      if (this.disposed || token !== this.dressToken) return;
      this.attach(loaded);
    });
  }

  /**
   * Put one loaded model on the root, taking over from whatever was there.
   *
   * Shared by the constructor and by re-dressing so the two cannot drift —
   * the height scale, the weapon socket and the mixer have to be set up
   * identically or a character that changes coat loses its sword.
   */
  private attach(loaded: {
    scene: THREE.Object3D;
    clips: readonly THREE.AnimationClip[];
    height: number;
    parts?: readonly { slot: string; pack: string; stem: string }[];
  }): void {
    const model = cloneSkinned(loaded.scene);
    this.dropCloth();
    // Height is the ONE thing D-539's appearance still reaches: the server's
    // descriptors call people towering or slight (D-201), and a cast of
    // identical statures would make every one of those a lie. Build and shape
    // are not expressible on a fixed mesh.
    //
    // ⚠ MULTIPLIES, and divides by the height of the model actually loaded
    // (D-577). This used to set an absolute scale from `outfit.height`, which
    // was wrong twice over and in the same direction. It WIPED the unit
    // conversion the re-assembly loaders apply — part files are centimetres by
    // design (D-571) — so every garment and every player-chosen face rendered
    // one hundred times too large; and it divided by the MONOLITH's height
    // when the thing on screen was a different assembly of different meshes
    // (1.90m against the manifest's 1.667m). Neither threw, and the only
    // symptom is a camera inside somebody's shin.
    model.scale.multiplyScalar(this.appearanceHeight / (loaded.height || 1));

    // ⚠ Carry the animation ACROSS rather than restarting it. Putting on a
    // cloak mid-stride must not reset the walk to frame zero, and a corpse
    // being looted must not stand up to play its death again.
    const wasPlaying = this.currentName;
    const wasAt = this.current?.time ?? 0;

    if (this.model) this.root.remove(this.model);
    this.mixer?.stopAllAction();
    this.root.add(model);
    this.model = model;

    this.hand =
      model.getObjectByName('prop_r')
      ?? model.getObjectByName('Hand_R')
      ?? model.getObjectByName('hand_r')
      ?? null;
    // ⚠ The weapon hangs off a bone of the model that was just replaced, so
    // it has to be hung again (D-614). Re-dressing rebuilds the whole
    // character (D-571); without this, changing coat disarmed you -- which is
    // what the comment on this function warned about in the abstract ("a
    // character that changes coat loses its sword") before there was a sword
    // to lose.
    this.heldShown = null;
    void this.refreshHeld();

    this.mixer = new THREE.AnimationMixer(model);
    this.clips.clear();
    for (const clip of loaded.clips) this.clips.set(clip.name, clip);
    this.current = null;
    this.currentName = '';
    this.applyLayer();
    this.hangCloth(model, loaded.parts ?? []);
    const resumed = this.play(wasPlaying || this.wanted(false), 0);
    // Pick the walk back up where it was rather than at frame zero: putting
    // on a cloak mid-stride must not reset the stride, and a corpse being
    // looted must not sit up and die again.
    if (resumed && wasPlaying) resumed.time = wasAt;
  }

  /**
   * Perform an emote (D-506, built on this cast in D-616).
   *
   * ⚠ The comment here used to read "no emotes in the drop", and it had
   * been out of date since D-564: `unarmed-bow`, `-wave`, `-laugh`, `-point`
   * and `-shrug` all shipped with the library and `rig-unreal.json` binds
   * every one of them by name. Nothing played them. The clips, the bindings
   * and the lexicon were all in place and the method was empty, so an emote
   * reached every other player as text and as nothing on screen.
   *
   * ⚠ One-shot, and it does NOT become the resting animation: `emoting`
   * holds the name only while it runs, and `update` puts the idle or the walk
   * back when it finishes. Leaving it as `currentName` would freeze a
   * character mid-wave until they next moved.
   */
  playTransients(names: readonly TransientAnim[]): void {
    const name = names[0];
    if (!name || !this.mixer) return;
    const clip = this.table[name as Action];
    if (!clip || !this.clips.has(clip)) return;
    const action = this.play(clip, 0.12, THREE.LoopOnce);
    if (!action) return;
    // ⚠ Held open by TIME rather than by the mixer's `finished` event. The
    // event fires on the mixer, which is shared by every action on this
    // character, so a listener would have to be added and removed per emote
    // and would fire for the walk cycle as well.
    this.emotingUntil = performance.now() + action.getClip().duration * 1000;
  }

  setCombat(inCombat: boolean): void {
    if (inCombat === this.inCombat) return;
    this.inCombat = inCombat;
    // Readiness is a LAYER (D-565): raising a weapon swaps the idle, the walk
    // and the attacks for the combat cut of the same stance, and lowering it
    // removes the override rather than applying a `peaceful` one.
    this.retable();
    this.crossReadiness(inCombat);
  }

  /**
   * Draws or sheathes, and decides when the blade is in the hand (D-620).
   *
   * ⚠ A weapon is only VISIBLE in combat. It used to be welded to the fist
   * from the moment it was equipped, so the whole cast stood about the tavern
   * holding drawn steel -- and the draw and sheathe clips D-564 fetched and
   * D-565 put in the stance layer had never been played by anything.
   *
   * ⚠ The two halves are NOT symmetrical, and that is the whole of it. The
   * blade appears at the START of a draw, because the clip's hand reaches to
   * the hip and comes back holding something -- nothing to hold makes the
   * motion meaningless. It leaves at the END of a sheathe, for the same
   * reason read backwards.
   *
   * ⚠ Nothing plays for an empty hand. An unarmed character entering combat
   * still changes how they stand, because that is the readiness layer, but a
   * draw with nothing to draw is the renderer claiming something happened.
   */
  private crossReadiness(inCombat: boolean): void {
    if (this.dead) return;
    const clipName = this.table[inCombat ? 'draw' : 'sheathe'];
    const seconds = (clipName ? this.clips.get(clipName)?.duration : undefined) ?? 0;
    const step = readinessTransition({
      toCombat: inCombat,
      armed: this.heldWanted !== undefined,
      clipSeconds: seconds,
    });
    this.weaponOut = step.weaponOut;
    this.stowAt = step.stowAfter > 0 ? performance.now() + step.stowAfter * 1000 : 0;
    this.applyWeaponVisibility();
    if (step.action === null || !clipName) return;
    this.transitionUntil = performance.now() + seconds * 1000;
    this.play(clipName, FADE * 0.5, THREE.LoopOnce);
  }

  /** Is the blade in the hand? Verification only (D-620). */
  get weaponDrawn(): boolean {
    return this.weaponOut;
  }

  /**
   * Shows or hides what is in the hand.
   *
   * ⚠ `visible`, not attach and detach. The mesh is loaded asynchronously
   * and parented to a BONE; tearing it off on every sheathe would make
   * entering combat a network round trip, and two quick changes would race
   * the way D-614's token exists to stop.
   */
  private applyWeaponVisibility(): void {
    if (this.held) this.held.visible = this.weaponOut;
  }

  /**
   * Re-flatten the layers, and switch to the clip the current action now maps
   * to if it changed.
   *
   * ⚠ It re-plays rather than waiting for the next frame, because a character
   * standing still generates no `update` that would notice: raising a weapon
   * while stationary would leave them in the peaceful idle until they walked.
   */
  private retable(): void {
    this.table = clipTable({
      rig: this.outfit?.rig ?? 'unreal',
      // ⚠ The RACE layer is not reachable yet, and saying so is better than
      // quietly passing something wrong. A race set applies to `race/sex`; the
      // sex is derivable from the chosen parts, but `raceId` is on the
      // character record (D-572) and NOT on the wire entity, so there is
      // nothing here to match against. No race set is authored today, so
      // nothing is currently lost — the day somebody authors one, this is the
      // line that has to be fed, not the resolver.
      race: null,
      sex: this.look ? sexOfLook(this.look.parts as Record<string, string>) : null,
      stance: this.stance ?? null,
      readiness: this.inCombat ? 'combat' : 'peaceful',
    });
    if (this.dead || performance.now() / 1000 < this.attackUntil) return;
    // ⚠ A draw or a sheathe owns the body while it plays (D-620). Without
    // this the re-table that RAISED the weapon immediately replaces the draw
    // with the combat idle, and the clip is never seen.
    if (performance.now() < this.transitionUntil) return;
    // ⚠ Locomotion is TWO clips now (D-619), and asking only about the walk
    // is how raising a weapon mid-stride drops a running character into the
    // idle: the clip playing was the run, which is not the walk, so "am I
    // moving" answered no and the whole thing was re-tabled as standing still.
    const locomotion = new Set([this.table.walk ?? CLIP.walk, this.table.run ?? CLIP.walk]);
    const wanted = this.wanted(locomotion.has(this.currentName));
    if (wanted !== this.currentName) this.play(wanted, FADE);
  }

  get combat(): boolean {
    return this.inCombat;
  }

  /** No casting animation exists yet, and claiming one would be the lie D-553 refused. */
  get castsSpells(): boolean {
    return false;
  }

  /**
   * ⚠ The variant is READ now. D-516 has had the server send which swing it
   * asked for since combat was built, and this threw it away and played one
   * hard-coded clip — so a stance with three authored attacks showed one.
   * A set that names fewer variants than the server asks for falls back to the
   * first it does name, which is the honest answer to "I have two swings".
   */
  playAttack(variant: number, t: number): void {
    const name = this.attackClip(variant);
    const clip = this.clips.get(name);
    this.attackUntil = t + (clip?.duration ?? 0.6);
    this.play(name, FADE * 0.5, THREE.LoopOnce);
  }

  private attackClip(variant: number): string {
    const numbered: Action[] = ['attack-1', 'attack-2', 'attack-3'];
    // Variants are 1-based on the wire; anything outside the three authored
    // ones wraps rather than falling off the end.
    const wanted = numbered[(Math.max(1, variant) - 1) % numbered.length]!;
    return (
      this.table[wanted]
      ?? this.table['attack-1']
      ?? this.table.shoot
      ?? CLIP.attack
    );
  }

  playDeath(_t: number, _impulse?: THREE.Vector3): void {
    this.dead = true;
    this.play(CLIP.death, FADE, THREE.LoopOnce);
  }

  setDead(dead: boolean): void {
    this.dead = dead;
    if (!dead) return;
    // Already down when first seen: hold the last frame rather than
    // replaying a collapse nobody witnessed (D-554).
    this.play(CLIP.death, 0, THREE.LoopOnce);
    const action = this.current;
    if (action) action.time = Math.max(0, action.getClip().duration - 0.001);
    this.mixer?.update(0);
  }

  setLootable(lootable: boolean): void {
    this.lootable = lootable;
    // A looted body stays on the ground; only a heap disappears when emptied.
    this.root.visible = this.lootable || !this.dead ? true : this.root.visible;
  }

  /**
   * Where a projectile leaves from. The rig ships a `prop_r` socket, which
   * is exactly the right answer; a character without one falls back to the
   * hand, and one that has not loaded yet to its own chest.
   */
  /**
   * Puts the weapon in the hand, or takes it out (D-614).
   *
   * ⚠ The grip comes from CONTENT, not from a guess. D-564 fitted 163
   * weapons by measurement and recorded that "a weapon can be wrong in a way
   * no geometric test sees" -- an un-rotated blade stands upright out of the
   * fist, hits nothing, and measures correctly. So the offset, the rotation
   * and the scale are the ones a person set while looking at it.
   */
  private async refreshHeld(): Promise<void> {
    const want = this.heldWanted ?? null;
    if (want === this.heldShown) return;
    const mine = ++this.heldToken;
    if (this.held) {
      this.held.parent?.remove(this.held);
      this.held = null;
    }
    this.heldShown = want;
    if (!want || !this.model) return;

    const grip = gripFor(want);
    if (!grip) return;
    const [pack, asset] = want.split('/');
    if (!pack || !asset) return;
    const object = await loadOneAsset(pack, asset);
    // ⚠ A token, like the one guarding the body's own load. Equipping twice
    // quickly would otherwise leave the slower weapon parented on top of the
    // faster one -- two swords in one fist, and the caption right.
    if (!object || mine !== this.heldToken || !this.model) return;

    // The bone the fitting names, and only then a hand as a fallback: rigs
    // disagree about what the right hand is called, and the fitted transform
    // was measured against this specific bone.
    const bone = this.model.getObjectByName(grip.attach) ?? this.hand;
    if (!bone) return;

    const holder = new THREE.Group();
    const t = grip.transform;
    holder.rotation.set(
      THREE.MathUtils.degToRad(t.rotation[0]),
      THREE.MathUtils.degToRad(t.rotation[1]),
      THREE.MathUtils.degToRad(t.rotation[2]),
    );
    // ⚠ MEASURE the bone's world scale, never assume it (D-563). The body
    // is scaled because the art is centimetres, but a bind matrix can carry
    // scale of its own, so what a child inherits is not simply that factor --
    // and getting it wrong by a little makes a sword a dot in a fist. Dividing
    // by what the bone actually is makes the stored offsets mean metres,
    // whatever the rig does.
    this.model.updateMatrixWorld(true);
    const boneScale = new THREE.Vector3();
    bone.getWorldScale(boneScale);
    const inherited = Math.max(1e-6, boneScale.x);
    holder.scale.setScalar(t.scale / inherited);
    // ⚠ The POSITION is divided by the same factor, not only the scale. A
    // child's position is in its parent's local space, so a bone at a world
    // scale of 0.01 turns a stored offset of 12cm into 1.2mm -- a hilt welded
    // to the wrist. Caught by comparing against the fitting tool, which has
    // divided both since D-563; the offsets were MEASURED through that
    // division, so anything reading them has to undo it the same way.
    holder.position.set(
      t.position[0] / inherited,
      t.position[1] / inherited,
      t.position[2] / inherited,
    );
    holder.add(object);
    // ⚠ Hidden unless the weapon is OUT (D-620). A character who equips a
    // sword out of combat -- which is every character, every round, at the
    // moment their kit lands -- must not be standing in the tavern holding it.
    holder.visible = this.weaponOut;
    bone.add(holder);
    this.held = holder;
  }

  weaponMuzzle(out: THREE.Vector3): THREE.Vector3 {
    if (this.hand) return this.hand.getWorldPosition(out);
    return out.set(this.root.position.x, 1.2, this.root.position.z);
  }

  setRenderLayer(layer: number): void {
    this.layer = layer;
    this.applyLayer();
  }

  private applyLayer(): void {
    this.root.traverse((o) => o.layers.set(this.layer));
    for (const c of this.cloths) c.proxy.layers.set(this.layer);
  }

  /**
   * Start a solver for every part on this model that has cloth settings.
   *
   * ⚠ After the model is on `root` and scaled: the solver measures the
   * instance's world scale to turn authored metres into model units, and reads
   * the skinned pose for its rest lengths.
   */
  private hangCloth(model: THREE.Object3D, parts: readonly { slot: string; pack: string; stem: string }[]): void {
    this.root.updateMatrixWorld(true);
    for (const part of parts) {
      const settings = clothFor(part.pack, part.stem);
      if (!settings) continue;
      const mesh = model.getObjectByName(part.slot) as THREE.SkinnedMesh | undefined;
      // ⚠ Indexed or not: the built parts are triangle soup like the FBX
      // they came from, and the solver welds either (D-631).
      if (!mesh?.isSkinnedMesh) continue;
      try {
        const cloth = new MeshCloth(mesh, settings, this.root);
        cloth.proxy.layers.set(this.layer);
        this.parent.add(cloth.proxy);
        this.cloths.push(cloth);
      } catch (e) {
        console.warn(`[cloth] ${part.stem}: ${(e as Error).message}`);
      }
    }
  }

  private dropCloth(): void {
    for (const c of this.cloths) c.dispose();
    this.cloths = [];
  }

  /** How many parts are being simulated. Verification only (D-114). */
  get clothCount(): number {
    return this.cloths.length;
  }

  // ---------------------------------------------------------------- frame

  /** The clip this character should be playing right now. */
  private wanted(moving: boolean): string {
    return clipFor(
      {
        dead: this.dead,
        posture: this.posture,
        moving,
        seated: this.seated,
        combat: this.inCombat,
      },
      this.table,
    );
  }

  /** Returns the action now playing, so a caller can seek it. */
  private play(
    name: string,
    fade: number,
    loop: THREE.AnimationActionLoopStyles = THREE.LoopRepeat,
  ): THREE.AnimationAction | null {
    if (!this.mixer || this.currentName === name) return this.current;
    const clip = this.clips.get(name);
    if (!clip) return this.current;
    const next = this.mixer.clipAction(clip);
    next.reset();
    next.setLoop(loop, loop === THREE.LoopOnce ? 1 : Infinity);
    // A one-shot holds its final pose instead of snapping back to bind —
    // which is what makes a corpse stay down and a sit stay sat.
    next.clampWhenFinished = loop === THREE.LoopOnce;
    next.play();
    if (this.current && fade > 0) this.current.crossFadeTo(next, fade, false);
    else if (this.current) this.current.stop();
    this.current = next;
    this.currentName = name;
    return next;
  }

  update(dt: number, t: number, moving: boolean, wind: number): void {
    // Turn toward the facing by the shortest way round, or a character
    // walking north-west spins three quarters of a circle to get there.
    const delta = ((this.targetAngle - this.angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    this.angle += delta * Math.min(1, dt * 12);
    this.root.rotation.y = this.angle;

    // ⚠ An emote holds the body the same way a swing does (D-616), and is
    // checked alongside it rather than instead: a character who waves and is
    // then struck should play the blow, and one who is mid-swing should not
    // have a wave cut it short. Whichever is still running wins.
    // ⚠ The blade leaves the hand when the SHEATHE ends, not when combat
    // does (D-620). Checked here rather than on a timer, because a timer that
    // outlives the character is a callback into a disposed visual.
    const now = performance.now();
    if (this.stowAt > 0 && now >= this.stowAt) {
      this.stowAt = 0;
      this.weaponOut = false;
      this.applyWeaponVisibility();
    }
    if (t >= this.attackUntil && now >= this.emotingUntil && now >= this.transitionUntil) {
      this.play(this.wanted(moving), FADE);
    }
    this.mixer?.update(dt);
    // The wind the world reports, finally used (D-631): it was passed here
    // and ignored since the procedural cast went.
    for (const c of this.cloths) c.step(dt, wind, t);
  }

  dispose(): void {
    this.disposed = true;
    this.mixer?.stopAllAction();
    this.dropCloth();
    this.parent.remove(this.root);
    // Geometry, materials and textures are SHARED with every other instance
    // of this character (see imported-models). Disposing them here would
    // blank every other guard in the room the moment one of them died.
    this.root.clear();
  }
}
