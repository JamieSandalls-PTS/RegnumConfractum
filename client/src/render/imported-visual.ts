import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
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
import type { EquipmentState } from './character';
import {
  available,
  loadDressed,
  loadLook,
  outfitFor,
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
}): Action {
  // Death outranks everything. A body on the floor is not standing, sitting
  // or walking, whatever else the server last said about it.
  if (state.dead) return 'death';
  // ⚠ Kneeling is its OWN action now. D-559 recorded "kneeling borrows the
  // sit, because there is no kneel" — there is: `unarmed-kneel` shipped in
  // D-564's library and nothing read it. A figure praying now kneels.
  if (state.posture === 'kneeling') return 'kneel';
  if (state.posture === 'sitting') return 'sitting';
  return state.moving ? 'walk' : 'idle';
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
  state: { dead: boolean; posture: Posture; moving: boolean },
  table: Partial<Record<Action, string>> = {},
): string {
  const action = actionFor(state);
  return table[action] ?? FALLBACK[action] ?? CLIP.idle;
}

/** What each action played before there were sets to read (D-559). */
const FALLBACK: Partial<Record<Action, string>> = {
  idle: CLIP.idle,
  walk: CLIP.walk,
  death: CLIP.death,
  sitting: CLIP.sit,
  // Borrowing the sit for a kneel is what D-559 had to do; it stays as the
  // floor for a rig whose set does not name one.
  kneel: CLIP.sit,
  'attack-1': CLIP.attack,
};

export class ImportedVisual {
  readonly root = new THREE.Group();

  private mixer: THREE.AnimationMixer | null = null;
  private clips = new Map<string, THREE.AnimationClip>();
  private current: THREE.AnimationAction | null = null;
  private currentName = '';
  private hand: THREE.Object3D | null = null;
  private disposed = false;

  private targetAngle = 0;
  private angle = 0;
  private posture: Posture = 'standing';
  private dead = false;
  private lootable = true;
  private inCombat = false;
  private attackUntil = 0;
  /** What is in hand, per the server (D-578). Undefined is empty-handed. */
  private stance: Stance | undefined;
  /** `rig ← race ← stance ← readiness`, flattened. Rebuilt when an input moves. */
  private table: Partial<Record<Action, string>> = {};
  private layer = 0;
  private readonly outfit: ImportedOutfit | null;
  private model: THREE.Object3D | null = null;
  private wearing: string[] = [];
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
  ) {
    parent.add(this.root);
    this.appearanceHeight = appearance.height;
    this.look = look;
    // ⚠ The outfit is still resolved even when a look exists, because it is
    // what names the CLIP FILE for this rig and the palette — the look says
    // which meshes, not which animations. Losing it would leave a chosen face
    // standing perfectly still.
    this.outfit = outfitFor(seed);
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

  setPosture(posture: Posture): void {
    this.posture = posture;
  }

  /**
   * ⚠ Does nothing, and that is a REGRESSION worth stating.
   *
   * D-219's hooded presentation is a distinct silhouette that the procedural
   * rig draws and the recognition system depends on being visible: a hood
   * dropping in view is what merges two identity threads. A fixed mesh has
   * no hood to raise, so on the imported cast a hooded figure looks exactly
   * like an unhooded one. Reconciling the imported meshes with presentation
   * is part of what a yes to this art commits to.
   */
  setPresentation(_presentation: Presentation): void {}

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
        wearing,
      );
    }
    return loadDressed(this.outfit!, wearing);
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
    return this.outfit?.parts?.pack ?? 'modular-fantasy-hero';
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
  }): void {
    const model = cloneSkinned(loaded.scene);
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

    this.mixer = new THREE.AnimationMixer(model);
    this.clips.clear();
    for (const clip of loaded.clips) this.clips.set(clip.name, clip);
    this.current = null;
    this.currentName = '';
    this.applyLayer();
    const resumed = this.play(wasPlaying || this.wanted(false), 0);
    // Pick the walk back up where it was rather than at frame zero: putting
    // on a cloak mid-stride must not reset the stride, and a corpse being
    // looted must not sit up and die again.
    if (resumed && wasPlaying) resumed.time = wasAt;
  }

  /** ⚠ No emotes in the drop, so a bow or a wave is not performed. */
  playTransients(_names: readonly TransientAnim[]): void {}

  setCombat(inCombat: boolean): void {
    if (inCombat === this.inCombat) return;
    this.inCombat = inCombat;
    // Readiness is a LAYER (D-565): raising a weapon swaps the idle, the walk
    // and the attacks for the combat cut of the same stance, and lowering it
    // removes the override rather than applying a `peaceful` one.
    this.retable();
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
    const wanted = this.wanted(this.currentName === (this.table.walk ?? CLIP.walk));
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
  }

  // ---------------------------------------------------------------- frame

  /** The clip this character should be playing right now. */
  private wanted(moving: boolean): string {
    return clipFor({ dead: this.dead, posture: this.posture, moving }, this.table);
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

  update(dt: number, t: number, moving: boolean, _wind: number): void {
    // Turn toward the facing by the shortest way round, or a character
    // walking north-west spins three quarters of a circle to get there.
    const delta = ((this.targetAngle - this.angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    this.angle += delta * Math.min(1, dt * 12);
    this.root.rotation.y = this.angle;

    if (t >= this.attackUntil) {
      this.play(this.wanted(moving), FADE);
    }
    this.mixer?.update(dt);
  }

  dispose(): void {
    this.disposed = true;
    this.mixer?.stopAllAction();
    this.parent.remove(this.root);
    // Geometry, materials and textures are SHARED with every other instance
    // of this character (see imported-models). Disposing them here would
    // blank every other guard in the room the moment one of them died.
    this.root.clear();
  }
}
