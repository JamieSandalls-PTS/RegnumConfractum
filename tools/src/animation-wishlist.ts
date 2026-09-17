import type { Action, Readiness, Stance } from '@rc/shared';

/**
 * What this game needs a clip for, and what to search for to get it (D-564).
 *
 * Written against the action vocabulary (D-561) rather than against whatever
 * a library happens to contain, so the gaps are visible: an entry with no
 * match is a missing animation somebody has to decide about, not a silent
 * absence.
 *
 * ⚠ A wish is not an asset. `search` is a query and `prefer` is how a human
 * would pick from the results — both are guesses that the downloader reports
 * on. What actually arrived is on disk, and what is BOUND to an action is a
 * decision made afterwards in the tool.
 *
 * ⚠ A search that matches nothing preferred falls back to the FIRST result,
 * and that is how the polearm stance once shipped its idle as a crouch and
 * crafting shipped as a squat — invisible in the filename, the log and the
 * browser. `tools/test/imported-rig.test.ts` measures every clip's opening
 * hip height for exactly this reason. Prefer a query that is narrow enough
 * that the fallback never fires.
 */

export interface AnimationWish {
  /** The action this is meant to serve. */
  readonly action: Action;
  /** Which stance layer it belongs to; `unarmed` is the base set. */
  readonly stance: Stance;
  /**
   * Whether this is the weapon-up version (D-565).
   *
   * Absent means it belongs to the stance itself — how the thing is carried,
   * and the draw and sheathe that move between the two. `combat` means it
   * only plays with the weapon up, and it is what makes a combat run
   * different from a peaceful one without doubling the action vocabulary.
   */
  readonly readiness?: Readiness;
  /** What to ask the library for. */
  readonly search: string;
  /**
   * Preferred result names, best first. Mixamo's search is loose — "walking"
   * returns 370 results including "Iv Pole Walking" — so the first hit is
   * usually wrong and the name is the only thing that distinguishes them.
   */
  readonly prefer: readonly string[];
  /** A clip that must loop seamlessly; the exporter asks for in-place. */
  readonly loop?: boolean;
  /**
   * Which match to take when the library ships several motions under ONE
   * title. Default 0, the first. Mixamo does this often — five distinct
   * "Sword And Shield Slash" products — so without this a stance's light and
   * heavy attacks are the same animation twice.
   */
  readonly nth?: number;
}

const w = (
  action: Action,
  stance: Stance,
  search: string,
  prefer: string[],
  loop = false,
  nth = 0,
): AnimationWish => ({ action, stance, search, prefer, loop, nth });

/** The same, but for a clip that only plays with the weapon up. */
const c = (
  action: Action,
  stance: Stance,
  search: string,
  prefer: string[],
  loop = false,
  nth = 0,
): AnimationWish => ({ action, stance, readiness: 'combat', search, prefer, loop, nth });

/**
 * The base set: what a person does with empty hands.
 *
 * Every stance falls through to this (D-561), so a gap here is a gap
 * everywhere, while a gap in `two-handed` only costs one weapon class.
 */
const UNARMED: AnimationWish[] = [
  w('idle', 'unarmed', 'idle', ['Breathing Idle', 'Idle', 'Standing Idle'], true),
  w('walk', 'unarmed', 'walking', ['Walking', 'Standard Walk'], true),
  w('run', 'unarmed', 'running', ['Running', 'Standard Run'], true),
  w('walk-back', 'unarmed', 'walking backwards', ['Walking Backwards'], true),
  w('strafe-left', 'unarmed', 'left strafe walk', ['Left Strafe Walk', 'Left Strafe'], true),
  w('strafe-right', 'unarmed', 'right strafe walk', ['Right Strafe Walk', 'Right Strafe'], true),
  w('sneak', 'unarmed', 'sneak walk', ['Sneaking Forward', 'Sneak Walk', 'Crouched Walking'], true),
  w('turn-left', 'unarmed', 'left turn', ['Left Turn', 'Standing Turn Left']),
  w('turn-right', 'unarmed', 'right turn', ['Right Turn', 'Standing Turn Right']),
  w('jump', 'unarmed', 'jump', ['Jumping Up', 'Jump']),
  w('fall', 'unarmed', 'falling idle', ['Falling Idle'], true),
  w('land', 'unarmed', 'hard landing', ['Hard Landing', 'Falling To Landing']),
  w('climb', 'unarmed', 'climbing ladder', ['Climbing', 'Climbing Up Wall'], true),
  w('swim', 'unarmed', 'swimming', ['Swimming'], true),
];

/** Being hurt, going down, and getting up. Shared by every stance. */
const REACTIONS: AnimationWish[] = [
  w('hit-light', 'unarmed', 'hit reaction', ['Standing React Small From Front', 'Hit Reaction']),
  w('hit-heavy', 'unarmed', 'hit reaction', ['Standing React Large From Front']),
  w('stagger', 'unarmed', 'stagger', ['Stagger Backwards', 'Stagger']),
  w('knockdown', 'unarmed', 'knocked down', ['Falling Back Death', 'Knocked Out']),
  w('get-up', 'unarmed', 'standing up', ['Standing Up', 'Getting Up']),
  w('death', 'unarmed', 'dying', ['Dying', 'Death From Front']),
  w('death-back', 'unarmed', 'falling back death', ['Falling Back Death', 'Death From Back']),
  w('downed', 'unarmed', 'lying down idle', ['Laying Idle', 'Dying'], true),
  w('revive', 'unarmed', 'standing up', ['Getting Up', 'Standing Up']),
];

/**
 * Doing things that are not fighting.
 *
 * The half a roleplaying server lives on (D-303) — a world whose only verbs
 * are combat verbs teaches players that combat is the point.
 */
const INTERACTIONS: AnimationWish[] = [
  w('pick-up', 'unarmed', 'picking up object', ['Picking Up Object', 'Pick Up']),
  w('use', 'unarmed', 'button pushing', ['Button Pushing', 'Interact']),
  w('open', 'unarmed', 'opening door', ['Opening A Door', 'Open Door']),
  // ⚠ SUBSTITUTE. The library has no woodcutting or mining clip at all
  // ("chopping", "axe", "pickaxe", "mining" all return nothing useful). A
  // downward two-handed melee swing is the closest real motion and reads as an
  // axe or a pick at isometric distance.
  w('harvest-swing', 'unarmed', 'axe', ['Standing Melee Attack Downward'], true),
  w('harvest-gather', 'unarmed', 'gathering', ['Picking Up Object', 'Crouch To Stand']),
  // ⚠ SUBSTITUTE. No smithing, hammering or carpentry clip exists. This is
  // somebody standing at a counter working with both hands, which is the right
  // SHAPE for a workbench even though it was authored for a bar. The first
  // pick, "Working On Device", was a CROUCH — caught by the shape test, not by
  // its name.
  w('craft', 'unarmed', 'work', ['Bartending'], true),
  // ⚠ NO MATCH. There is no eating clip in the library — "eating", "sandwich",
  // "food" and "meal" all come back empty. Left here deliberately so the gap
  // is visible: `eat` currently has nothing to play and D-533's meals will
  // need either a hand-made clip or a different verb.
  w('eat', 'unarmed', 'eating', ['Eating', 'Eating Sandwich']),
  w('drink', 'unarmed', 'drinking', ['Drinking', 'Drinking From Bottle']),
  w('sit-down', 'unarmed', 'sitting down', ['Sitting Down', 'Stand To Sit']),
  w('sitting', 'unarmed', 'sitting idle', ['Sitting Idle', 'Seated Idle'], true),
  // ⚠ A DIFFERENT clip from `sitting`, not a variant of it (D-615). The
  // library's sit is a chair pose -- hips 58cm off the floor -- and the
  // `*sits*` emote is somebody sitting down on the ground where they stand.
  // Until this arrives the emote borrows the chair sit, which is the honest
  // fallback rather than a kneel pretending to be a sit.
  w('sit-ground', 'unarmed', 'sitting on ground',
    ['Sitting On Ground', 'Sit Floor', 'Seated Ground Idle', 'Floor Sitting'], true),
  w('stand-up', 'unarmed', 'stand up', ['Stand Up', 'Standing Up']),
  w('kneel', 'unarmed', 'kneeling', ['Kneeling Down', 'Praying'], true),
  w('sleep', 'unarmed', 'laying idle', ['Laying Idle', 'Sleeping Idle'], true),
  // ⚠ SUBSTITUTE. No bandaging clip. Kneeling and examining something on the
  // ground is what treating a downed person looks like from above (D-205).
  w('treat-wound', 'unarmed', 'kneel', ['Kneeling Inspecting']),
  w('carry-body', 'unarmed', 'carry', ['Carrying'], true),
];

/** Emotes the lexicon can fire (D-506). */
const EMOTES: AnimationWish[] = [
  w('bow', 'unarmed', 'bowing', ['Bow', 'Quick Formal Bow']),
  w('wave', 'unarmed', 'waving', ['Waving', 'Wave Hip Hop Dance']),
  w('laugh', 'unarmed', 'laughing', ['Laughing', 'Happy Idle']),
  w('point', 'unarmed', 'pointing', ['Pointing', 'Point']),
  w('shrug', 'unarmed', 'shrugging', ['Shrugging', 'Shrug']),
  w('nod', 'unarmed', 'nodding', ['Head Nod Yes', 'Nod']),
  w('shake-head', 'unarmed', 'shaking head', ['Head Shake No', 'Shaking Head No']),
];

/**
 * Putting a weapon away and taking it out again (D-565).
 *
 * ⚠ These are the ONE part of a stance that is not readiness-specific, and
 * that is not a technicality: drawing is the transition BETWEEN the two
 * readiness states, so it cannot belong to either. It is also the clip the
 * whole distinction is visible through — without it a character snaps from
 * hands-free to guard between one frame and the next, which is what the
 * combat state has been doing since D-516.
 *
 * The melee pack's "Equip"/"Disarm" pair is the general case (a weapon coming
 * over the shoulder or from the hip); the sword-and-shield and greatsword
 * packs ship their own.
 */
const HOLSTER: AnimationWish[] = [
  w('draw', 'one-handed', 'draw sword', ['Draw Sword', 'Withdrawing Sword', 'Sword And Shield Equip']),
  w('sheathe', 'one-handed', 'sheath sword', ['Sheath Sword', 'Sheathing Sword']),
  w('draw', 'two-handed', 'draw sword', ['Draw A Great Sword 1', 'Draw A Great Sword 2']),
  w('sheathe', 'two-handed', 'sheath great sword', ['Sheath A Great Sword 1', 'Sheath A Great Sword 2']),
  w('draw', 'polearm', 'axe', ['Unarmed Equip Over Shoulder', 'Unarmed Equip Underarm']),
  w('sheathe', 'polearm', 'axe', ['Standing Disarm Over Shoulder', 'Standing Disarm Underarm']),
  w('draw', 'dagger', 'axe', ['Unarmed Equip Underarm']),
  w('sheathe', 'dagger', 'axe', ['Standing Disarm Underarm']),
  w('draw', 'staff', 'axe', ['Unarmed Equip Over Shoulder']),
  w('sheathe', 'staff', 'axe', ['Standing Disarm Over Shoulder']),
  // ⚠ NOT "Standing Draw Arrow" — that is nocking an arrow, which is `reload`
  // and the combat idle, not taking the bow off your back.
  w('draw', 'bow', 'equip', ['Standing Equip Bow']),
  w('sheathe', 'bow', 'axe', ['Standing Disarm Over Shoulder']),
];

/**
 * One-handed sword and shield: the commonest stance in the pack's weapons.
 *
 * Everything here is `combat` — a sword-and-shield walk is a guard walk, and
 * a character with the same sword sheathed should walk like anybody else.
 */
const ONE_HANDED: AnimationWish[] = [
  c('idle', 'one-handed', 'sword and shield idle', ['Sword And Shield Idle'], true),
  c('walk', 'one-handed', 'sword and shield walk', ['Sword And Shield Walk'], true),
  c('run', 'one-handed', 'sword and shield run', ['Sword And Shield Run'], true),
  c('walk-back', 'one-handed', 'sword and shield walk', ['Sword And Shield Walk'], true, 1),
  c('strafe-left', 'one-handed', 'sword and shield strafe', ['Sword And Shield Strafe'], true),
  c('strafe-right', 'one-handed', 'sword and shield strafe', ['Sword And Shield Strafe'], true, 1),
  c('turn-left', 'one-handed', 'sword and shield turn', ['Sword And Shield Turn']),
  c('turn-right', 'one-handed', 'sword and shield 180 turn', ['Sword And Shield 180 Turn']),
  c('jump', 'one-handed', 'sword and shield jump', ['Sword And Shield Jump']),
  c('attack-1', 'one-handed', 'sword and shield slash', ['Sword And Shield Slash']),
  c('attack-2', 'one-handed', 'sword and shield attack', ['Sword And Shield Attack']),
  c('attack-3', 'one-handed', 'sword and shield', ['Sword And Shield Kick']),
  // The library ships five DIFFERENT motions all called "Sword And Shield
  // Slash"; `nth` takes the second, so the light and heavy attacks are two
  // takes rather than one clip played twice.
  c('attack-heavy', 'one-handed', 'sword and shield slash', ['Sword And Shield Slash'], false, 1),
  c('block', 'one-handed', 'sword and shield block idle', ['Sword And Shield Block Idle'], true),
  c('block-impact', 'one-handed', 'sword and shield block', ['Sword And Shield Block']),
  c('hit-light', 'one-handed', 'sword and shield impact', ['Sword And Shield Impact']),
  c('death', 'one-handed', 'sword and shield death', ['Sword And Shield Death']),
  c('dodge', 'one-handed', 'dodge', ['Sword And Shield Roll', 'Dodging Right']),
];

/** Two-handed: the greatswords and mauls in the vikings and knights packs. */
const TWO_HANDED: AnimationWish[] = [
  c('idle', 'two-handed', 'great sword idle', ['Great Sword Idle', 'Two Handed Idle'], true),
  c('walk', 'two-handed', 'great sword walk', ['Great Sword Walk'], true),
  c('run', 'two-handed', 'great sword run', ['Great Sword Run'], true),
  c('walk-back', 'two-handed', 'great sword walk', ['Great Sword Walk'], true, 1),
  c('strafe-left', 'two-handed', 'great sword strafe', ['Great Sword Strafe'], true),
  c('strafe-right', 'two-handed', 'great sword strafe', ['Great Sword Strafe'], true, 1),
  c('turn-left', 'two-handed', 'great sword turn', ['Great Sword Turn']),
  c('turn-right', 'two-handed', 'great sword 180 turn', ['Great Sword 180 Turn']),
  c('jump', 'two-handed', 'great sword jump', ['Great Sword Jump']),
  c('attack-1', 'two-handed', 'great sword slash', ['Great Sword Slash']),
  c('attack-2', 'two-handed', 'great sword', ['Great Sword High Spin Attack']),
  c('attack-3', 'two-handed', 'great sword attack', ['Great Sword Attack']),
  c('attack-heavy', 'two-handed', 'great sword blocking', ['Great Sword Kick', 'Great Sword Slash']),
  c('block', 'two-handed', 'great sword block idle', ['Great Sword Blocking'], true),
  c('hit-light', 'two-handed', 'great sword impact', ['Great Sword Impact']),
  // ⚠ REMOVED, not missing: there is no two-handed death clip, and the layer
  // system already answers this — `two-handed` falls through to the rig's
  // `death` (D-561). Recorded here so nobody adds the wish back and calls it
  // a gap.
];

/**
 * Polearms — the halberds, spears and scythes.
 *
 * The melee pack these come from is the most complete combat set in the
 * library: a full locomotion ring, blocks, and six distinct attacks.
 */
const POLEARM: AnimationWish[] = [
  c('idle', 'polearm', 'axe', ['Standing Idle'], true),
  c('walk', 'polearm', 'axe', ['Standing Walk Forward'], true),
  c('run', 'polearm', 'axe', ['Standing Run Forward'], true),
  c('walk-back', 'polearm', 'axe', ['Standing Walk Back'], true),
  c('strafe-left', 'polearm', 'axe', ['Standing Walk Left'], true),
  c('strafe-right', 'polearm', 'axe', ['Standing Walk Right'], true),
  c('turn-left', 'polearm', 'axe', ['Standing Turn Left 90']),
  c('turn-right', 'polearm', 'axe', ['Standing Turn Right 90']),
  c('jump', 'polearm', 'axe', ['Standing Jump']),
  c('attack-1', 'polearm', 'axe', ['Standing Melee Attack Horizontal']),
  c('attack-2', 'polearm', 'axe', ['Standing Melee Attack Backhand']),
  c('attack-3', 'polearm', 'axe', ['Standing Melee Combo Attack Ver. 1']),
  c('attack-heavy', 'polearm', 'axe', ['Standing Melee Attack 360 High']),
  c('attack-thrust', 'polearm', 'stab', ['Stabbing']),
  c('block', 'polearm', 'axe', ['Standing Block Idle'], true),
  c('block-impact', 'polearm', 'axe', ['Standing Block React Large']),
  c('hit-heavy', 'polearm', 'axe', ['Standing React Large Gut']),
];

/** Bows: the one stance where aiming and releasing are separate beats. */
const BOW: AnimationWish[] = [
  c('idle', 'bow', 'standing draw arrow', ['Standing Draw Arrow', 'Bow Idle'], true),
  c('aim', 'bow', 'standing aim overdraw', ['Standing Aim Overdraw', 'Standing Aim Idle'], true),
  c('shoot', 'bow', 'standing aim recoil', ['Standing Aim Recoil', 'Shoot Arrow']),
  c('reload', 'bow', 'standing draw arrow', ['Standing Draw Arrow']),
  c('walk', 'bow', 'standing aim walk forward', ['Standing Aim Walk Forward'], true),
  c('walk-back', 'bow', 'standing aim walk back', ['Standing Aim Walk Back'], true),
  c('strafe-left', 'bow', 'standing aim walk left', ['Standing Aim Walk Left'], true),
  c('strafe-right', 'bow', 'standing aim walk right', ['Standing Aim Walk Right'], true),
];

/** Staffs and casting — the magical half the stakeholder asked for. */
const STAFF: AnimationWish[] = [
  c('idle', 'staff', 'standing idle magic', ['Idle', 'Breathing Idle'], true),
  c('cast', 'staff', 'standing 2h magic attack', ['Standing 2H Magic Attack 01', 'Magic Attack']),
  c('channel', 'staff', 'standing 2h cast spell', ['Standing 2H Cast Spell 01', 'Casting'], true),
  c('attack-1', 'staff', 'standing 2h magic area attack', ['Standing 2H Magic Area Attack 01']),
];

/** Thrown weapons. */
const THROWN: AnimationWish[] = [
  c('attack-1', 'thrown', 'throw', ['Throw', 'Standing Throw']),
  c('aim', 'thrown', 'throw object', ['Throw Object', 'Throw'], true),
];

/** Casting without a staff — a spell from an empty hand. */
const UNARMED_MAGIC: AnimationWish[] = [
  w('cast', 'unarmed', 'standing 1h magic attack', ['Standing 1H Magic Attack 01', 'Magic Attack']),
  w('channel', 'unarmed', 'standing 1h cast spell', ['Standing 1H Cast Spell 01'], true),
];

/**
 * Daggers, and carrying something in both arms.
 *
 * Both fall through to a fuller set for everything they do not name — a dagger
 * walks like an unarmed man and a porter idles like one — so a stance is worth
 * having the moment ONE motion in it is distinct (D-561).
 *
 * ⚠ `carrying` is the one stance with no combat half, and that is the point of
 * it: a man with a barrel in his arms has no guard. Its clips sit in the
 * STANCE layer, where a peaceful override belongs.
 */
const DAGGER: AnimationWish[] = [
  c('attack-1', 'dagger', 'stab', ['Double Dagger Stab']),
  c('attack-2', 'dagger', 'stab', ['Stabbing']),
];

const CARRYING: AnimationWish[] = [
  w('idle', 'carrying', 'carry', ['Box Idle'], true),
  w('walk', 'carrying', 'carry', ['Carrying'], true),
];

export const WISHLIST: readonly AnimationWish[] = [
  ...UNARMED,
  ...REACTIONS,
  ...INTERACTIONS,
  ...EMOTES,
  ...UNARMED_MAGIC,
  ...HOLSTER,
  ...ONE_HANDED,
  ...TWO_HANDED,
  ...POLEARM,
  ...BOW,
  ...STAFF,
  ...THROWN,
  ...DAGGER,
  ...CARRYING,
];

/**
 * The filename a wish becomes on disk.
 *
 * Stance, readiness and action — not the library's own title. `Sword And
 * Shield Slash` is what Mixamo calls it and `one-handed__combat__attack-1` is
 * what this game needs it for. The build turns a filename into a clip name, so
 * this IS the clip name, and binding an action to a clip later becomes a
 * decision rather than a lookup through somebody else's naming.
 *
 * ⚠ The readiness segment is only present when it is `combat`. A clip with no
 * segment belongs to the stance itself, which is what draw, sheathe and every
 * `carrying` motion are — and leaving `peaceful` out keeps the base library's
 * names (`unarmed__walk`) unchanged.
 */
export function wishFilename(wish: AnimationWish): string {
  return wish.readiness === 'combat'
    ? `${wish.stance}__combat__${wish.action}`
    : `${wish.stance}__${wish.action}`;
}
