import { z } from 'zod';

/**
 * Everything a character can be DOING, as a closed vocabulary (D-561).
 *
 * The foundation under animation, written before any clip exists. Naming the
 * actions first is what lets the item tools say "this weapon changes the walk
 * and the attacks" while the clips are still missing — and it is what stops
 * the eventual answer being a pile of strings that only match by luck.
 *
 * CLOSED on purpose. A set that names an action nothing implements is a
 * promise the renderer never keeps, which is the lie D-553 refused for hotbar
 * spells; the validator rejects one. Adding an action is a deliberate edit
 * here, next to the note saying what it is for.
 */

/**
 * Where animation actually varies, and it is not race.
 *
 * Clips bind to bones BY NAME (D-555), so a clip belongs to a rig, and every
 * character in this pack shares one. What genuinely changes a character's
 * movement is what they are HOLDING — a greatsword changes idle, walk and
 * every attack — and, as flavour rather than necessity, who they are.
 *
 * So sets layer rather than nest: a base set per rig, an optional override
 * per race and body, an optional override per stance. Anything a layer does
 * not name falls through to the one beneath. Nesting animation under race
 * would leave the weapon case, which is the heaviest one, with nowhere to go.
 */
export const ANIMATION_LAYERS = ['rig', 'race', 'stance', 'readiness'] as const;
export type AnimationLayer = (typeof ANIMATION_LAYERS)[number];

/**
 * How a character is carrying themselves. A stance is chosen by what is in
 * their hands, and it is the layer that overrides the most.
 */
export const STANCES = [
  'unarmed',
  'one-handed',
  'one-handed-shield',
  'two-handed',
  'polearm',
  'dagger',
  'bow',
  'crossbow',
  'staff',
  'thrown',
  'carrying',
] as const;
export type Stance = (typeof STANCES)[number];

/**
 * Whether the weapon is put away or up (D-565).
 *
 * ⚠ NOT called `Posture`, though that is the natural word: `Posture` already
 * means sitting / standing / kneeling in this codebase (D-506), and `shared`
 * re-exports everything from one index, so the two would have collided
 * silently in every file that imported either. The compiler caught it; the
 * name is `Readiness` so it cannot happen again.
 *
 * ⚠ This is a fourth LAYER rather than a doubling of the vocabulary, and the
 * difference matters. The stakeholder's ask was "running (Combat), running
 * (Peaceful)" for every action that has both — 62 actions with a combat twin
 * is 124 enum entries, most of which would never differ. As a layer it is one
 * override per clip that actually changes, and everything else falls through
 * to how the character moves with their hands free.
 *
 * The two are not symmetrical. `peaceful` is the ABSENCE of an override: a man
 * with a sheathed sword walks like a man. `combat` is where the guard idle,
 * the sidestep, the shortened stride and every attack live. So a posture set
 * is always a combat set in practice, and `peaceful` exists as a name so the
 * renderer can ask for one without a special case.
 */
export const READINESS = ['peaceful', 'combat'] as const;
export type Readiness = (typeof READINESS)[number];

/** What a readiness set applies to: the stance it dresses, and which readiness. */
export function readinessApplies(stance: Stance, readiness: Readiness): string {
  return `${stance}/${readiness}`;
}


/** Moving about the world. Every stance needs these or falls back to them. */
export const LOCOMOTION_ACTIONS = [
  'idle',
  'walk',
  'run',
  'walk-back',
  'strafe-left',
  'strafe-right',
  'sneak',
  'turn-left',
  'turn-right',
  'jump',
  'fall',
  'land',
  'swim',
  'climb',
] as const;

/**
 * Fighting. The attack variants are numbered rather than named after a
 * motion, because which way a blade travels is the animator's business and
 * the server only knows it asked for variant 2 (D-516).
 */
export const COMBAT_ACTIONS = [
  'draw',
  'sheathe',
  // ⚠ `combat-idle` USED TO LIVE HERE and was removed when the posture layer
  // arrived (D-565, superseding this part of D-561). With only three layers it
  // was the one way to say "standing still, weapon up"; with a posture layer
  // that is `idle` resolved through `<stance>/combat`, and keeping both would
  // be two spellings of one thing waiting to disagree. Removing it rather than
  // leaving it unused is the same rule D-538 applied to feats: a vocabulary
  // entry nothing implements is a promise the renderer never keeps.
  'attack-1',
  'attack-2',
  'attack-3',
  'attack-heavy',
  'attack-thrust',
  'block',
  'block-impact',
  'parry',
  'dodge',
  'aim',
  'shoot',
  'reload',
  'cast',
  'channel',
] as const;

/** Being acted upon, and the end of it. */
export const REACTION_ACTIONS = [
  'hit-light',
  'hit-heavy',
  'stagger',
  'knockdown',
  'get-up',
  'death',
  'death-back',
  'downed',
  'revive',
] as const;

/**
 * Doing things that are not fighting. This is the half a roleplaying server
 * lives on (D-303): a world where the only verbs are combat verbs teaches
 * players that combat is the point.
 */
export const INTERACTION_ACTIONS = [
  'pick-up',
  'use',
  'open',
  'harvest-swing',
  'harvest-gather',
  'craft',
  'eat',
  'drink',
  'sit-down',
  'sitting',
  'stand-up',
  'kneel',
  'sleep',
  'treat-wound',
  'carry-body',
] as const;

/** Emotes the lexicon may fire (D-506). Kept beside the rest so one list rules. */
export const EMOTE_ACTIONS = ['bow', 'wave', 'laugh', 'point', 'shrug', 'nod', 'shake-head'] as const;

export const ACTIONS = [
  ...LOCOMOTION_ACTIONS,
  ...COMBAT_ACTIONS,
  ...REACTION_ACTIONS,
  ...INTERACTION_ACTIONS,
  ...EMOTE_ACTIONS,
] as const;
export type Action = (typeof ACTIONS)[number];

/** Which family an action belongs to, for grouping in a tool. */
export const ACTION_GROUPS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  locomotion: LOCOMOTION_ACTIONS,
  combat: COMBAT_ACTIONS,
  reaction: REACTION_ACTIONS,
  interaction: INTERACTION_ACTIONS,
  emote: EMOTE_ACTIONS,
});

/**
 * The actions a character MUST have somewhere in their resolved set.
 *
 * Deliberately tiny. Everything else may be missing and simply not play, but
 * a character with no idle and no walk is a statue that slides, and no amount
 * of content authoring later makes that acceptable.
 */
export const REQUIRED_ACTIONS: readonly Action[] = Object.freeze(['idle', 'walk']);

export const ActionSchema = z.enum(ACTIONS);
export const StanceSchema = z.enum(STANCES);

/**
 * One layer of animation: action → clip name.
 *
 * Partial by design. A stance set that only names `attack-1` changes the
 * attack and inherits the walk, which is what makes 163 weapons expressible
 * without 163 complete sets.
 */
export const AnimationSetSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().min(1),
  layer: z.enum(ANIMATION_LAYERS),
  /**
   * What this set applies to: a rig variant, a `race/sex`, or a stance. Read
   * by whoever resolves the layers; unconstrained here because the three
   * layers key on different things.
   */
  applies: z.string().min(1),
  /** Action → the clip that plays for it. */
  clips: z.record(ActionSchema, z.string().min(1)).default({}),
  note: z.string().optional(),
});
export type AnimationSet = z.infer<typeof AnimationSetSchema>;

/**
 * Flatten the layers, most specific last.
 *
 * The whole point of the design in one function: a stance beats a race, a
 * race beats the rig, and anything a layer is silent about falls through.
 */
export function resolveAnimations(layers: readonly AnimationSet[]): Partial<Record<Action, string>> {
  const out: Partial<Record<Action, string>> = {};
  // Reads ANIMATION_LAYERS rather than repeating it: a fourth layer added
  // there and forgotten here would resolve as if it did not exist, which looks
  // exactly like a set nobody filled in.
  for (const layer of ANIMATION_LAYERS) {
    for (const set of layers.filter((s) => s.layer === layer)) {
      Object.assign(out, set.clips);
    }
  }
  return out;
}

/** What a resolved set is still missing that nothing can do without. */
export function missingActions(resolved: Partial<Record<Action, string>>): Action[] {
  return REQUIRED_ACTIONS.filter((a) => !resolved[a]);
}

/**
 * What is wrong with one authored set (D-564).
 *
 * Split the same way every other content check is: what can be judged from
 * the document alone runs in CI, and what needs the built clips in front of
 * it runs on the authoring server. `known` is that second half — pass `null`
 * where the animation file is not present, which is CI.
 */
export function animationSetProblems(
  set: AnimationSet,
  known: ReadonlySet<string> | null,
): string[] {
  const problems: string[] = [];

  // `applies` means something different per layer, and a set that names the
  // wrong kind of thing is not a small mistake: it simply never resolves, and
  // a set that never resolves looks exactly like one that does.
  if (set.layer === 'stance' && !(STANCES as readonly string[]).includes(set.applies)) {
    problems.push(`a stance set must apply to one of ${STANCES.join(', ')}, not '${set.applies}'`);
  }
  if (set.layer === 'race' && !/^[a-z0-9-]+\/[a-z-]+$/.test(set.applies)) {
    problems.push(`a race set applies to 'race/sex', not '${set.applies}'`);
  }
  if (set.layer === 'readiness') {
    const [stance, readiness] = set.applies.split('/');
    if (!stance || !(STANCES as readonly string[]).includes(stance)) {
      problems.push(`a readiness set applies to '<stance>/<readiness>'; '${stance ?? ''}' is not a stance`);
    }
    if (!readiness || !(READINESS as readonly string[]).includes(readiness)) {
      problems.push(
        `a readiness set applies to '<stance>/<readiness>'; '${readiness ?? ''}' is not one of ${READINESS.join(', ')}`,
      );
    }
  }

  const clips = Object.entries(set.clips) as [Action, string][];
  if (clips.length === 0) {
    problems.push('names no clips at all, so it can never change anything');
  }
  if (known) {
    for (const [action, clip] of clips) {
      if (!known.has(clip)) problems.push(`${action} names clip '${clip}', which is not built`);
    }
  }
  return problems;
}

/**
 * Everything the layers below a stance can offer it.
 *
 * The reason a stance set is allowed to be four lines long: `two-handed` names
 * its own attacks and inherits sitting, dying and every emote. Written as a
 * function so a tool can SHOW what is inherited rather than leaving an author
 * to remember which of 62 actions they have covered.
 */
export function inheritedAnimations(
  layers: readonly AnimationSet[],
  set: AnimationSet,
): Partial<Record<Action, string>> {
  const beneath: Record<AnimationLayer, AnimationLayer[]> = {
    rig: [],
    race: ['rig'],
    stance: ['rig', 'race'],
    readiness: ['rig', 'race', 'stance'],
  };
  return resolveAnimations(layers.filter((s) => beneath[set.layer].includes(s.layer)));
}
