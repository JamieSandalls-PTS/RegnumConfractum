import { z } from 'zod';
import { DIRECTIONS } from './types';
import { AttributeSchema } from './attributes';
import { AnimationSetSchema, StanceSchema } from './actions';
import { CharacterItemSchema } from './assets';
import { GroundMaterialSchema } from './content';
import { CharacterLookSchema, PartNamesSchema, RaceSchema } from './creation';
import { EquipSlotSchema, EquipStatsSchema } from './equipment';
import {
  CharacterAdvancesSchema,
  CharacterBuildSchema,
  ClassSchema,
  ContentIdSchema,
  FeatSchema,
  PostureSchema,
  PresentationSchema,
  SkillSchema,
  SpellSchema,
  TransientAnimSchema,
} from './content';
import { RoundOutcomeSchema, RoundPhaseSchema } from './round';
import { NeedStageSchema } from './needs';
import {
  ACCENT_COLORS,
  APPEARANCE_LIMITS,
  ARCHETYPE_NAMES,
  CLOTH_COLORS,
  HAIR_COLORS,
  HAIR_STYLES,
  SKIN_COLORS,
  type AppearanceOverride,
} from './appearance';

/**
 * The wire protocol, defined once and consumed by both server and client
 * (D-105). JSON over WebSocket, snapshot-then-deltas (D-107). Every inbound
 * message is validated against these schemas before it touches game logic;
 * headless bots validate server messages the same way, so a shape change
 * breaks tests instead of desyncing silently.
 */

export const DirectionSchema = z.enum(DIRECTIONS);

const UsernameSchema = z.string().regex(/^[a-zA-Z0-9_]{3,24}$/);
const PasswordSchema = z.string().min(8).max(128);
const CharacterNameSchema = z
  .string()
  .min(2)
  .max(32)
  .regex(/^[\p{L}][\p{L} '-]*[\p{L}]$/u, 'letters, spaces, apostrophes, hyphens');
const UuidSchema = z.string().uuid();

/**
 * A player-authored appearance (D-539). Sparse: anything omitted comes from
 * the seed, which is what keeps every pre-existing character, NPC and monster
 * rendering exactly as before. The bounds mirror APPEARANCE_LIMITS so an
 * illegal body is rejected at the schema rather than deep in the renderer.
 */
const range = (r: readonly [number, number]) => z.number().min(r[0]).max(r[1]);
const swatch = (palette: readonly number[]) =>
  z.number().int().refine((n) => palette.includes(n), "not one of the world's colours");

export const AppearanceOverrideSchema = z.object({
  archetype: z.enum(ARCHETYPE_NAMES as [string, ...string[]]).optional(),
  sex: z.enum(['male', 'female']).optional(),
  height: range(APPEARANCE_LIMITS.height).optional(),
  bulk: range(APPEARANCE_LIMITS.bulk).optional(),
  shoulder: range(APPEARANCE_LIMITS.shoulder).optional(),
  limb: range(APPEARANCE_LIMITS.limb).optional(),
  headScale: range(APPEARANCE_LIMITS.headScale).optional(),
  bust: range(APPEARANCE_LIMITS.bust).optional(),
  hairLen: range(APPEARANCE_LIMITS.hairLen).optional(),
  hairStyle: z.enum(HAIR_STYLES as unknown as [string, ...string[]]).optional(),
  hairColor: swatch(HAIR_COLORS).optional(),
  skin: swatch(SKIN_COLORS).optional(),
  cloth: swatch(CLOTH_COLORS).optional(),
  accent: swatch(ACCENT_COLORS).optional(),
  capeColor: swatch(ACCENT_COLORS).optional(),
  hasCape: z.boolean().optional(),
}) as unknown as z.ZodType<AppearanceOverride>;

// ---------------------------------------------------------------------------
// Client → server. The client sends intent only (D-102).
// ---------------------------------------------------------------------------

export const ChannelSchema = z.enum(['whisper', 'say', 'shout']);
export type Channel = z.infer<typeof ChannelSchema>;

export const ClientMessageSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('say'),
    channel: ChannelSchema,
    text: z.string().min(1).max(400),
    /** Spoken language; the speaker must know it. Defaults to 'common'. */
    language: ContentIdSchema.optional(),
    /**
     * Explicit name declaration (D-218). True or false, it propagates to
     * everyone in earshot, contested per listener by Insight against the
     * speaker's Bluff. The flag itself is never echoed to observers.
     */
    declareAs: CharacterNameSchema.optional(),
    /**
     * Third-party introduction (D-201): "this is X", attaching a name to a
     * present target for everyone in earshot, provenance 'third_party'.
     * Never overwrites a name a listener already holds.
     */
    introduce: z
      .object({ entityId: z.number().int(), name: CharacterNameSchema })
      .optional(),
  }),
  z.object({ t: z.literal('set_presentation'), state: PresentationSchema }),
  z.object({
    t: z.literal('write'),
    title: z.string().min(1).max(80),
    text: z.string().min(1).max(2000),
  }),
  z.object({ t: z.literal('read_item'), itemId: z.string().uuid() }),
  z.object({ t: z.literal('register'), username: UsernameSchema, password: PasswordSchema }),
  z.object({ t: z.literal('login'), username: UsernameSchema, password: z.string().max(128) }),
  z.object({ t: z.literal('resume'), token: z.string().max(128) }),
  z.object({
    t: z.literal('create_character'),
    name: CharacterNameSchema,
    appearanceSeed: z.number().int().nonnegative().optional(),
    /** Playable class (D-208/D-511). Optional: bots and pre-class clients
     * still create without one. */
    classId: ContentIdSchema.optional(),
    /**
     * What this character IS (D-560, wired in D-572).
     *
     * ⚠ Optional for the same reason `classId` is, and it is the property the
     * whole design rests on: every character made before races existed, every
     * bot and every older client sends none and behaves exactly as before.
     * A class that names no races admits all of them (D-566), so authoring a
     * race narrows and never silently locks.
     */
    raceId: ContentIdSchema.optional(),
    /** Skills, feats and spells chosen at creation. The server re-validates
     * against content and rejects anything illegal (D-102). */
    build: CharacterBuildSchema.optional(),
    /** What the player set by hand in the appearance step (D-539). Omitted
     * entirely by bots and old clients, which then look exactly as before. */
    appearance: AppearanceOverrideSchema.optional(),
    /** The parts chosen from the race's curated lists (D-574). */
    look: CharacterLookSchema.optional(),
  }),
  /** Asks for the creation catalogue (classes, skills, feats, spells). */
  z.object({ t: z.literal('get_creation_content') }),
  z.object({ t: z.literal('enter_world'), characterId: UuidSchema }),
  z.object({ t: z.literal('move'), dir: DirectionSchema }),
  /**
   * Walk to a point, in metres (D-567).
   *
   * ⚠ The server does the pathing, which is a change of ownership as much as
   * of units. The client used to run its own A* and send one direction per
   * tile — so the client decided the route and the server only checked each
   * step. Around a continuous obstacle those two would disagree constantly.
   * The client now says where; the server decides how, and remains the only
   * thing that moves anybody (invariant 1).
   */
  z.object({ t: z.literal('move_to'), x: z.number(), y: z.number() }),
  /** Stop where you are, abandoning any route. */
  z.object({ t: z.literal('move_stop') }),
  z.object({ t: z.literal('give'), itemId: UuidSchema, toEntityId: z.number().int() }),
  z.object({ t: z.literal('pay'), toEntityId: z.number().int(), amount: z.number().int().positive() }),
  z.object({ t: z.literal('resync') }),
  z.object({ t: z.literal('ping'), nonce: z.number().int() }),
  /** Declared hostility (D-206): the hostile words are spoken aloud and
   * logged with the declaration; the attack window opens afterwards. */
  z.object({
    t: z.literal('hostile'),
    targetEntityId: z.number().int(),
    text: z.string().min(1).max(400),
  }),
  z.object({ t: z.literal('attack'), targetEntityId: z.number().int() }),
  z.object({
    t: z.literal('treat'),
    targetEntityId: z.number().int(),
    injuryId: z.string().uuid().optional(),
  }),
  z.object({ t: z.literal('respawn') }),
  /** Voluntary permadeath (D-207): irreversible; earns Legacy Points. */
  /**
   * Sit on the seat nearest a point (D-605).
   *
   * ⚠ A POINT, not an entity id. Chairs are area scenery, not entities —
   * thirty-two of them in one taproom would be thirty-two deltas and a
   * snapshot entry each (D-542) — so the client says where it clicked and the
   * server finds the seat. It is also the server that decides where the
   * sitter ends up and which way they face, which is what stops a sit playing
   * into the back of the chair.
   */
  z.object({ t: z.literal('sit'), x: z.number(), y: z.number() }),
  z.object({ t: z.literal('retire') }),
  /**
   * Fill out the lobby with bots, and send them home again (D-607).
   *
   * ⚠ A DEVELOPMENT verb, and the server refuses it outright unless it was
   * started with bots allowed. It registers accounts and creates characters on
   * demand, so on a public server it is an account-creation hole with a button
   * on it. The refusal is by error code rather than by silence — a control the
   * client draws and the server ignores is worse than one that is not drawn.
   *
   * ⚠ `count` is how many MORE to bring in, not a target. A target would
   * have to decide what to do about the ones already standing there, and the
   * only sensible answer ('remove some') is a different verb.
   */
  z.object({ t: z.literal('add_bots'), count: z.number().int().min(1).max(11) }),
  z.object({ t: z.literal('remove_bots') }),
  /**
   * End a character from the ROSTER, without entering the world (D-600).
   *
   * ⚠ Separate from `retire` rather than a relaxation of it. `retire` is an
   * act performed BY a character who is standing somewhere: the world watches
   * them go, a corpse is made, a seance can still reach them. This is the
   * roster's delete, taken by an account about a character who is nowhere,
   * and conflating the two would either put a body in a tavern nobody is in
   * or quietly drop the part of retirement other players can see.
   */
  z.object({ t: z.literal('retire_character'), characterId: UuidSchema }),
  /** Take everything a corpse or scatter of gear holds (D-224/D-511). */
  z.object({ t: z.literal('loot'), targetEntityId: z.number().int() }),
  /** D-204: draw the ghost back to this corpse for five questions. */
  z.object({ t: z.literal('speak_dead'), targetEntityId: z.number().int() }),
  /** D-204/D-224: raise this corpse as a walking ally. */
  z.object({ t: z.literal('animate_dead'), targetEntityId: z.number().int() }),
  /** Dead owner's choice (D-224): ride along in the animated body — hear what
   * it hears, speak through it in the undead register. */
  z.object({ t: z.literal('observe_body'), on: z.boolean() }),
  /** D-206 endgame zones: pull a downed companion back from the brink before
   * the window closes and the death becomes permanent. */
  z.object({ t: z.literal('revive'), targetEntityId: z.number().int() }),
  /** Lift a body (D-224 groundwork): only if strong enough for its build. */
  z.object({ t: z.literal('carry_body'), targetEntityId: z.number().int() }),
  z.object({ t: z.literal('drop_body') }),
  /**
   * Work a resource node (MR2). Takes time, and the time is the danger: you
   * stand still, occupied, for a known interval, which is exactly when
   * someone would choose to be behind you (D-529).
   */
  z.object({ t: z.literal('harvest'), targetEntityId: z.number().int() }),
  /** Work a recipe. Interruptible, and station-gated when the recipe says so. */
  z.object({ t: z.literal('craft'), recipeId: ContentIdSchema }),
  /** Abandon whatever is being worked on. */
  z.object({ t: z.literal('cancel_work') }),
  /** Eat something from the pack (D-526). */
  z.object({ t: z.literal('eat'), templateId: ContentIdSchema }),
  /**
   * Drink. Water is NOT carried: you come to the well, which is what makes
   * thirst the leash back to town and the well worth poisoning (D-529).
   */
  z.object({ t: z.literal('drink') }),
  /**
   * Wear or wield something from the pack (D-547). `slot` is a REQUEST, not
   * an instruction: the server picks when it is omitted and refuses when the
   * named slot is wrong for the item. Rings are the reason it exists at all —
   * there are two hands and the player has an opinion about which.
   */
  z.object({ t: z.literal('equip'), itemId: UuidSchema, slot: EquipSlotSchema.optional() }),
  z.object({ t: z.literal('unequip'), itemId: UuidSchema }),
  /**
   * Spoil the well (D-529, built in D-552). The antagonist's one non-violent
   * attack on a settled zone, and the reason the watch has something to watch
   * for besides a stabbing.
   *
   * No target: you poison the well you are standing at. There is only ever
   * one within reach, and naming it would let a client try to poison a well
   * in another area.
   */
  z.object({ t: z.literal('poison_well') }),
  /**
   * Use one thing from the pack (D-554): eat it, drink it, or bind a wound
   * with it. What it does is the ITEM's business — the client sends "use
   * this" and the server reads the template, so a new consumable is a content
   * change and never a protocol one.
   */
  z.object({ t: z.literal('use_item'), templateId: ContentIdSchema }),
  /**
   * Put something on the floor (D-554). It becomes a heap anyone can loot,
   * which is what makes dropping a real decision rather than a delete: a
   * bandage abandoned at the tavern door is a bandage somebody else finds.
   */
  z.object({ t: z.literal('drop_item'), itemId: UuidSchema, qty: z.number().int().min(1).optional() }),
  /**
   * Pool something in the town's common stores (D-530, built D-580).
   *
   * ⚠ Never required, which is the whole design: carrying your own is
   * wasteful and redeemable anywhere, pooling is efficient and redeemable
   * only in town, in daylight, when you are not the one bleeding in the wood.
   * Neither dominates, and the cast builds its own single point of failure by
   * cooperating.
   */
  /** Look at what the stores hold. Anybody within reach may (D-530). */
  z.object({ t: z.literal('store_look') }),
  z.object({ t: z.literal('store_deposit'), itemId: UuidSchema }),
  /** Take something back out of the stores. Anybody may: they are common. */
  z.object({ t: z.literal('store_withdraw'), itemId: UuidSchema }),
  /**
   * Ruin what the stores hold (D-526, D-529, D-530).
   *
   * ⚠ The antagonist's non-violent play at the one place everybody is. Town
   * is `settled`, so murder there costs the antagonist its own game (D-531) —
   * without this the hub gives it nothing to do. Deliberately a bare verb
   * with no target: what it ruins is whatever is there.
   */
  z.object({ t: z.literal('store_spoil') }),
  /**
   * Save the hotbar to the character (D-553). Sent whole and debounced, for
   * the same reason `advance` is sent whole: a resend has to be harmless.
   *
   * The server stores it and hands it back on the next login. It does not
   * validate what the slots CONTAIN — an ability id the client no longer
   * knows renders as an empty slot rather than an error, which is what should
   * happen when a character is rebuilt and loses a rite.
   */
  z.object({
    t: z.literal('set_hotbar'),
    slots: z.array(z.string().max(40).nullable()).max(16),
  }),
  /**
   * Spend a level (D-546). The WHOLE advancement record, not a delta, so a
   * resend after a dropped connection is harmless — which matters because the
   * level-up screen appears exactly when a round is tearing its sockets down.
   */
  z.object({ t: z.literal('advance'), advances: CharacterAdvancesSchema }),
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// ---------------------------------------------------------------------------
// Server → client.
// ---------------------------------------------------------------------------

export const InjurySchema = z.object({
  id: z.string().uuid(),
  location: z.enum(['head', 'torso', 'arms', 'legs']),
  kind: z.enum(['cut', 'pierce', 'blunt']),
  severity: z.enum(['minor', 'major']),
});
export type WireInjury = z.infer<typeof InjurySchema>;

export const ErrorCodeSchema = z.enum([
  'invalid_message',
  'protocol_error',
  'auth_failed',
  'username_taken',
  'not_authenticated',
  'already_in_world',
  'not_in_world',
  'no_such_character',
  /** That character is in the world; they cannot be deleted from under themselves (D-600). */
  'character_online',
  'character_name_taken',
  'bad_target',
  'not_adjacent',
  'no_such_item',
  'not_equippable',
  // What a calling may wear and wield (D-566). ACCESS, never power.
  'not_for_your_calling',
  'wrong_slot',
  'too_heavy',
  'illegal_advance',
  'no_mana',
  'insufficient_funds',
  'not_hostile',
  'on_cooldown',
  'dead',
  'not_dead',
  'no_such_recipe',
  'missing_materials',
  'wrong_station',
  'already_working',
  'node_spent',
  'not_hungry',
  'no_water_here',
  'already_poisoned',
  /** Nowhere within reach to pool goods (D-580). */
  'no_store_here',
  /** The stores hold nothing that could be ruined — refused BEFORE the
   * bitterleaf is spent, since the room is deliberately hard to read. */
  'nothing_to_spoil',
  'not_food',
  /** The server declines to do this at all — not a state, a policy.
   * Bots on a server that does not summon them (D-607). */
  'not_allowed',
  'grace_window',
  'too_soon',
  'no_injury',
  /** Speak With Dead on a spirit that is offline or already respawned — a
   * deliberately distinct result (D-511). */
  'beyond_reach',
  /** The acting character's class does not grant this ability (D-204/D-208). */
  'lacks_ability',
  /** Concurrent-zombie cap reached (D-511: skill-scaled, max 3). */
  'limit_reached',
  'internal',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const WireEntitySchema = z.object({
  id: z.number().int(),
  /**
   * What THIS observer calls the entity: a learned name, or a generated
   * description (D-201/D-219). Never the objective character name — names are
   * knowledge, and knowledge is per-observer. Snapshots and entity_entered
   * are therefore personalized per connection.
   */
  descriptor: z.string().min(1).max(120),
  /** 'corpse' lies where a player fell; 'pile' is gear left after decay. */
  kind: z.enum(['player', 'npc', 'corpse', 'pile', 'node', 'station']),
  /**
   * Where it is, in METRES (D-567).
   *
   * ⚠ These were integer tiles and are now free coordinates. Anything that
   * rounds them is reintroducing the grid: a client that floors a position to
   * draw it puts every character on a lattice, and a rule that compares them
   * with `chebyshev` is measuring the wrong distance.
   */
  x: z.number(),
  y: z.number(),
  /**
   * Metres above the area's ground plane — a bridge, a gallery, a stair.
   * Presentation and reach only; the plan of the world is still read in x/y.
   */
  z: z.number().default(0),
  facing: DirectionSchema,
  posture: PostureSchema,
  /**
   * Sitting on an actual SEAT rather than on the ground (D-615).
   *
   * ⚠ The server owns this because the server put them there: `sit` finds
   * the seat, decides where the sitter ends up and which way they face
   * (D-605), while the emote only ever says "sitting". A client cannot tell
   * the two apart -- both are `posture: 'sitting'` -- and guessing from the
   * tile would make it a question of geometry that the authority has already
   * answered (D-102).
   */
  seated: z.boolean().default(false),
  presentation: PresentationSchema,
  /** Drives client-side procedural appearance (D-402). */
  appearanceSeed: z.number().int().nonnegative(),
  /** Player-authored deviations from the seed (D-539). Absent for NPCs,
   * roamers and every character made before the appearance step existed. */
  appearance: AppearanceOverrideSchema.nullable().default(null),
  /**
   * The parts a player chose at creation (D-574), or null.
   *
   * ⚠ Null for every NPC, every roamer, every corpse and every character made
   * before the face step existed — which is all of them today. A null look is
   * not a blank face: it means the renderer falls back to exactly what it did
   * before, picking a body from the seed (D-559).
   *
   * ⚠ Public, and it has to be: this is what everybody in the room sees when
   * they look at you. It is NOT what they are told you are CALLED — the
   * descriptor pipeline reads `appearance`, never this (D-201/D-219).
   */
  look: CharacterLookSchema.nullable().default(null),
  /**
   * Which BUILT CHARACTER this entity is drawn as (D-594).
   *
   * ⚠ This is the wire field D-559 said was missing. Until now the model was
   * picked from the appearance seed — deterministic and agreed across clients,
   * and arbitrary: nothing connected the guard model to a guard, and every
   * goblin in the game was drawn as a random townsman. A night-walker
   * described as "something man-shaped that does not walk like a man" rendered
   * as a man.
   *
   * ⚠ Absent means "fall back to the seed", which is still right for players
   * who have not been through creation, for corpses and for anything a script
   * spawns without saying what it looks like. A creature that names a model
   * the client cannot find falls back the same way rather than failing to
   * draw — an invisible enemy is worse than a wrong-looking one.
   */
  model: z.string().optional(),
  /**
   * Which node or station this is — 'iron-vein', 'well', 'workshop' (D-542).
   * Public information about a public object, and the client needs it to draw
   * the right thing: before this it guessed from the descriptor's prose, and
   * stations fell through the guess and rendered as PEOPLE.
   */
  variant: z.string().optional(),
  /**
   * The mesh a station is drawn as (D-583), when its definition names one.
   *
   * ⚠ Resolved by the SERVER against `content/stations/`, not looked up by
   * the client: a station's art is content the client has no copy of, and an
   * id it could not resolve would fall back to built-in geometry — the well
   * silently reverting to a grey cylinder, which is the bug that looks like a
   * texture failing to load.
   *
   * ⚠ Absent means "draw the built-in geometry", which is what every
   * station did before any art was authored. A facility must never fail to
   * draw: the well has to be visible across the square or thirst does not
   * work (D-529).
   */
  art: z
    .object({
      pack: z.string().min(1),
      asset: z.string().min(1),
      rotation: z.number().default(0),
      scale: z.number().positive().default(1),
    })
    .optional(),
  /** In combat: weapon drawn and held ready. Server-owned so every
   * observer sees the same stance (D-102). */
  combat: z.boolean().default(false),
  /**
   * What this character is visibly WEARING (D-554). Public, like posture —
   * everyone can see you are in mail with a blade out.
   *
   * ⚠ It never reaches the descriptor pipeline. What a stranger is CALLED
   * (D-201/D-219) and what they are seen to be carrying are separate
   * questions, and joining them would make a helm the permanent disguise
   * D-539 refused to allow at creation.
   */
  worn: z
    .object({
      helm: z.boolean(),
      pauldrons: z.boolean(),
      cape: z.boolean(),
      robe: z.boolean(),
      weapon: z.enum(['none', 'sword', 'staff']),
      /**
       * The garments this character has on (D-571).
       *
       * ⚠ Exactly as public as the five flags beside it, and for the same
       * reason: everyone in the room can see you are in mail. It is more
       * PRECISE than the silhouette rather than more private — the flags are
       * what the procedural cast draws approximate shapes from, and these are
       * what the imported cast re-assembles a body out of.
       *
       * ⚠ Still never reaches the descriptor pipeline. What a stranger is
       * CALLED (D-201/D-219) and what they are seen to be wearing stay
       * separate questions; joining them would make a helm the permanent
       * disguise D-539 refused at creation.
       */
      garments: z.array(z.string()).default([]),
      /**
       * How the weapon in hand is carried (D-565, wired D-578).
       *
       * ⚠ On the wire because the SERVER decides it (D-102): which stance an
       * asset declares is content, and an observer who worked it out from the
       * silhouette would animate a crossbow as a sword. Absent means
       * empty-handed, which resolves to the rig's own clips — `unarmed` is the
       * base layer, never a stance (D-564).
       */
      stance: StanceSchema.optional(),
      /**
       * Which mesh the weapon in hand is, as `pack/asset` (D-614).
       *
       * ⚠ On the wire because the SERVER decides it (D-102) and because an
       * observer cannot work it out: the silhouette says 'sword' for every
       * blade in the game. Absent means no particular sword rather than no
       * sword -- the flag beside it still says whether a hand is full.
       */
      weaponArt: z.string().optional(),
    })
    .nullable()
    .default(null),
  /**
   * Visibly a thing that attacks people (D-550): a roamer, a dungeon dweller,
   * an animated corpse. Auto-attack keys off this and nothing else, so that
   * clicking the tavern keeper — who is an NPC, and is somebody's objective —
   * can never start a fight by accident.
   *
   * Public information about a public fact: a monster looks like a monster.
   * It is never set for players, whatever they have done.
   */
  hostile: z.boolean().default(false),
  /** For corpses: the entity carrying this body, if any. */
  carriedBy: z.number().int().nullable().default(null),
  /**
   * This body or heap has something in it (D-554). Drawn as a pack beside
   * the corpse, so "is that worth walking to" is answerable from where you
   * are standing.
   *
   * Public and honest: a settled-zone corpse holds nothing (D-511) and says
   * so, which saves the walk rather than hiding a disappointment behind it.
   */
  lootable: z.boolean().default(false),
});
export type WireEntity = z.infer<typeof WireEntitySchema>;

export const WireItemSchema = z.object({
  id: UuidSchema,
  templateId: z.string(),
  qty: z.number().int().positive(),
  /** Display label for written/inscribed items (the note's title). */
  label: z.string().optional(),
  /**
   * Which paperdoll slot this is worn in, or null for "in the pack" (D-547).
   * Carried on the item rather than as a separate equipped-list so the two
   * can never disagree about where a thing is — the bug that produces a sword
   * both wielded and stacked.
   */
  equipped: EquipSlotSchema.nullable().default(null),
});
export type WireItem = z.infer<typeof WireItemSchema>;

export const CharacterSummarySchema = z.object({
  id: UuidSchema,
  name: CharacterNameSchema,
  areaId: z.string(),
  /** Where they logged out, in metres (D-567). */
  x: z.number(),
  y: z.number(),
  appearanceSeed: z.number().int().nonnegative(),
  appearance: AppearanceOverrideSchema.nullable().default(null),
  /** The chosen face (D-574); null on everything made before it existed. */
  look: CharacterLookSchema.nullable().default(null),
  /** Playable class id (D-208/D-511); absent on pre-class characters. */
  classId: z.string().optional(),
  /** What it is (D-560/D-572); absent on every character made before races. */
  raceId: z.string().optional(),
  /** Derived from banked xp (D-538); shown on the roster screen. */
  level: z.number().int().min(1).default(1),
  /**
   * What retiring this character right now would pay the ACCOUNT (D-600).
   *
   * ⚠ Sent with the roster so the confirmation can state the number before
   * the player commits to something irreversible. Computed by the server,
   * never by the client: the formula has diminishing returns on repeat
   * sacrifice (D-207) and depends on how many characters this account has
   * already retired, which is not a fact the client holds.
   */
  legacyIfRetired: z.number().int().min(0).default(0),
});
export type CharacterSummary = z.infer<typeof CharacterSummarySchema>;

/**
 * Simulation events. Movement, departure and emotes are objective and are
 * broadcast; entity_entered carries a descriptor and is sent per connection.
 * A move implies posture returns to standing.
 */
export const SimEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('entity_moved'),
    id: z.number().int(),
    x: z.number(),
    y: z.number(),
    z: z.number().default(0),
    facing: DirectionSchema,
  }),
  z.object({ type: z.literal('entity_entered'), entity: WireEntitySchema }),
  z.object({ type: z.literal('entity_left'), id: z.number().int() }),
  z.object({
    type: z.literal('entity_emote'),
    id: z.number().int(),
    posture: PostureSchema.optional(),
    /**
     * Whether that sitting is on a SEAT (D-615).
     *
     * ⚠ On the event as well as on the entity, because this event is how a
     * posture change reaches an observer who already has the entity. Taking a
     * chair broadcasts `entity_emote` with `posture: 'sitting'` exactly as the
     * `*sits*` emote does -- so without this the client set the flag from the
     * entity, then immediately cleared it from the event, and everybody sat on
     * the floor through the chair.
     */
    seated: z.boolean().default(false),
    transients: z.array(TransientAnimSchema).max(3),
  }),
  z.object({
    type: z.literal('entity_presentation'),
    id: z.number().int(),
    state: PresentationSchema,
  }),
  z.object({
    type: z.literal('entity_attacked'),
    attackerId: z.number().int(),
    targetId: z.number().int(),
    damage: z.number().int().min(0),
    /**
     * What the d20 showed, and whether it landed (D-606).
     *
     * ⚠ A MISS is now a thing that happens, and zero damage is not enough to
     * say so: a blow absorbed to nothing and a blow that never connected look
     * identical on the wire and must not look identical on screen. The face is
     * carried too, because "natural 20" is the one result a player wants to
     * see named rather than inferred from a big number.
     */
    hit: z.boolean().default(true),
    roll: z.number().int().min(0).max(20).default(0),
    critical: z.boolean().default(false),
    /** Which swing/stab/cast to play. Chosen SERVER-side so every observer
     * sees the same blow — the animation is cosmetic, but disagreeing
     * clients would be a desync in the one place players are watching. */
    variant: z.number().int().min(0).default(0),
  }),
  /**
   * A visible/audible act at an entity that is not a blow (D-541): a wound
   * mended, a rite performed. Broadcast to the area, because these are public
   * acts — a corpse standing up is not a private matter, and a séance is a
   * sanctioned crossing that the room can see (D-204).
   *
   * It carries WHAT happened and never WHO it was done to or why, so it
   * cannot become a channel for information the observer had not already
   * earned (D-217).
   */
  z.object({
    type: z.literal('entity_effect'),
    id: z.number().int(),
    effect: z.enum(['heal', 'rite']),
  }),
  /** Weapon drawn / sheathed, per D-206's combat state. */
  z.object({
    type: z.literal('entity_combat'),
    id: z.number().int(),
    inCombat: z.boolean(),
  }),
  /**
   * Somebody put something on or took it off (D-554). Broadcast, because what
   * you are wearing is visible — and it is a DELTA rather than a resync so
   * that a room full of people changing kit does not cost a snapshot each.
   */
  z.object({
    type: z.literal('entity_worn'),
    id: z.number().int(),
    worn: z.object({
      helm: z.boolean(),
      pauldrons: z.boolean(),
      cape: z.boolean(),
      robe: z.boolean(),
      weapon: z.enum(['none', 'sword', 'staff']),
      /**
       * The garments this character has on (D-571).
       *
       * ⚠ Exactly as public as the five flags beside it, and for the same
       * reason: everyone in the room can see you are in mail. It is more
       * PRECISE than the silhouette rather than more private — the flags are
       * what the procedural cast draws approximate shapes from, and these are
       * what the imported cast re-assembles a body out of.
       *
       * ⚠ Still never reaches the descriptor pipeline. What a stranger is
       * CALLED (D-201/D-219) and what they are seen to be wearing stay
       * separate questions; joining them would make a helm the permanent
       * disguise D-539 refused at creation.
       */
      garments: z.array(z.string()).default([]),
      /**
       * How the weapon in hand is carried (D-565, wired D-578).
       *
       * ⚠ On the wire because the SERVER decides it (D-102): which stance an
       * asset declares is content, and an observer who worked it out from the
       * silhouette would animate a crossbow as a sword. Absent means
       * empty-handed, which resolves to the rig's own clips — `unarmed` is the
       * base layer, never a stance (D-564).
       */
      stance: StanceSchema.optional(),
    }),
  }),
  /**
   * A body or heap changed what it holds (D-554) — emptied by a looter, most
   * often. The pack drawn beside it comes and goes with this.
   *
   * A dedicated event rather than a re-sent `entity_entered`: the client
   * ignores an arrival for an entity it already has (correctly — otherwise
   * every resend would build a second visual), so re-broadcasting the entity
   * looked like an update and did nothing at all.
   */
  z.object({
    type: z.literal('entity_lootable'),
    id: z.number().int(),
    lootable: z.boolean(),
  }),
  /** A body picked up or set down; null carrier means it lies where it is. */
  z.object({
    type: z.literal('entity_carried'),
    id: z.number().int(),
    carrierId: z.number().int().nullable(),
  }),
  /** The visible death. Observers drop the entity; the ghost lives on in a
   * world only other ghosts can see (D-203). */
  z.object({ type: z.literal('entity_died'), id: z.number().int() }),
  /**
   * Undone by daylight (D-551). What walks abroad at night does not walk away
   * at dawn — it comes apart where it stands.
   *
   * A separate event from `entity_left` because the two mean different things
   * and a player needs to be able to tell them apart: a thing that LEFT might
   * be behind you, and a thing that came apart is gone. That distinction is
   * worth a wire message on its own, and it is what lets the client play a
   * dissolve instead of blinking the entity out of existence.
   */
  z.object({ type: z.literal('entity_dissolved'), id: z.number().int() }),
]);
export type SimEvent = z.infer<typeof SimEventSchema>;

/** Graded, fallible Insight readings (D-218). Absence means "you cannot tell". */
export const ImpressionSchema = z.enum(['rings_false', 'certain_false']);
export type Impression = z.infer<typeof ImpressionSchema>;

export const ServerMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('error'), code: ErrorCodeSchema, message: z.string() }),
  /**
   * The server re-read its content (D-630). Sent to everyone, so a client
   * drops what it cached off the build manifests — a character rebuilt with
   * a new face, a mesh the environment build just produced — and fetches it
   * fresh next time it draws one. Nothing already on screen is redrawn: this
   * is a dev-loop message, not a scene update, and the existing entity
   * stays as it was until it next changes.
   */
  /**
   * Presentation content, sent the moment a socket opens and again after a
   * reload (D-630). Animation sets, ground materials, weapon grips and the
   * part catalogue used to reach the client as BUILD-TIME imports — a fourth
   * channel beside server-load, the wire and the baked artefacts — so a set
   * authored in the tool needed a client rebuild, and `content/animations`
   * was a directory the game server had never read. It is one channel now:
   * the server loads it, the wire carries it, and a Publish reaches a client
   * that is already open.
   *
   * ⚠ Before auth, deliberately. None of this is a secret and none of it is
   * per-player; a client that connects needs it before the first snapshot.
   * The sound manifest is the one presentation file still imported at build
   * time, because the menu plays music before a connection exists.
   */
  z.object({
    t: z.literal('render_content'),
    animations: z.array(AnimationSetSchema),
    ground: z.array(GroundMaterialSchema),
    /** `pack/id` → the fitted grip. */
    grips: z.array(z.object({ key: z.string(), item: CharacterItemSchema })),
    parts: z.array(PartNamesSchema),
  }),
  z.object({
    t: z.literal('content_reloaded'),
    /** Directories that changed, as the server saw them. */
    applied: z.array(z.string()),
    /** Changes that wait for the next reset or a restart, with why. */
    deferred: z.array(z.string()),
  }),
  z.object({
    t: z.literal('auth_ok'),
    accountId: UuidSchema,
    token: z.string(),
    characters: z.array(CharacterSummarySchema),
    /** Spendable on access and flavour for future characters — never power. */
    legacyPoints: z.number().int().nonnegative(),
  }),
  z.object({ t: z.literal('character_created'), character: CharacterSummarySchema }),
  /**
   * The roster again (D-600).
   *
   * ⚠ Its own message rather than a second `auth_ok`. Re-sending `auth_ok`
   * would hand the client a session token and an account id it already has,
   * and every client handler for it would have to be written to be harmless
   * the second time — which is the sort of thing that is true until somebody
   * adds a line to it.
   */
  z.object({
    t: z.literal('character_list'),
    characters: z.array(CharacterSummarySchema),
    legacyPoints: z.number().int().min(0),
  }),
  /**
   * The creation catalogue (D-208/D-110). Sent on request so the creation
   * screen is rendered from CONTENT rather than hardcoded in the client —
   * adding a feat is a data change, not a client deploy.
   */
  z.object({
    t: z.literal('creation_content'),
    classes: z.array(ClassSchema),
    /**
     * What a player may BE (D-560, offered at creation in D-573).
     *
     * ⚠ Sent WHOLE, not as a list of ids, because the creation screen needs
     * what each race curates — its statures, its skin tones, its markings and
     * which parts each slot offers. Sending ids would mean a second round
     * trip per race, or the client shipping a copy of the content and going
     * stale the moment somebody authors one.
     *
     * ⚠ EMPTY is the normal state for a server whose content has no races,
     * and the screen must then skip the step rather than show an empty one —
     * the same rule the spell step already follows for a calling that does
     * not cast.
     */
    races: z.array(RaceSchema).default([]),
    /**
     * Part file stem → the name a player is told it is called (D-560, sent
     * from D-576).
     *
     * ⚠ The screen cannot show a filename, and until now it did: the names
     * lived in `content/parts/` where only the authoring tools read them, so
     * a face the stakeholder had called "Scarred mouth" was offered to a
     * player as `Head Female 05`.
     *
     * ⚠ Trimmed to what the races curate — 142 of the pack's 720 — because
     * the rest are garment meshes creation never offers. Missing means
     * UNNAMED, and the client falls back to the stem rather than to nothing.
     */
    partNames: z.record(z.string(), z.string()).default({}),
    skills: z.array(SkillSchema),
    feats: z.array(FeatSchema),
    spells: z.array(SpellSchema),
    budget: z.object({
      /** Points placed on the attribute step, over a base of 10 (D-546). */
      attributePoints: z.number().int().nonnegative(),
      attributeBase: z.number().int().nonnegative(),
      attributeMax: z.number().int().nonnegative(),
      skillPoints: z.number().int().nonnegative(),
      skillStep: z.number().int().positive(),
      skillMax: z.number().int().nonnegative(),
      feats: z.number().int().nonnegative(),
      spells: z.number().int().nonnegative(),
    }),
    /** Spendable Legacy Points — gates legacy-locked classes (D-207). */
    legacyPoints: z.number().int().nonnegative(),
  }),
  z.object({
    t: z.literal('snapshot'),
    tick: z.number().int(),
    you: z.number().int(),
    area: z.object({
      id: z.string(),
      name: z.string(),
      lighting: z.enum(['overcast', 'night', 'underground', 'interior']),
      /** Which bed plays here (D-541). Absent means silence. */
      ambience: ContentIdSchema.optional(),
      /**
       * Pack meshes standing on the map (D-566, D-567).
       *
       * ⚠ Deliberately SLIMMER than the authored `PlacedAsset`: where it
       * stands, how it is turned and how big it is — and not its collision
       * mask. The client used to be sent `props` because its own pathfinder
       * read them; it no longer has one (D-567), the server owns every route,
       * and shipping a few hundred collision volumes per area would be paying
       * bandwidth for a question the client is no longer allowed to answer.
       */
      assets: z
        .array(
          z.object({
            pack: z.string().min(1),
            asset: z.string().min(1),
            x: z.number(),
            y: z.number(),
            z: z.number().default(0),
            rotation: z.number().default(0),
            scale: z.number().positive().default(1),
            /**
             * Something a person can sit on (D-605).
             *
             * ⚠ On the wire for the MENU, not for the rule. The client needs
             * it to know whether "Sit here" is worth offering on a right
             * click; the server checks it again and its answer is the one
             * that counts (D-102). One boolean per placed asset is a cost
             * worth paying to avoid an entry that always appears and usually
             * fails.
             */
            seat: z.boolean().default(false),
          }),
        )
        .default([]),
      /** Roofed tiles (D-545). Presentation only — the server never reads
       * them, and they change nothing about movement or sight. */
      roofs: z
        .array(z.object({ x: z.number().int(), y: z.number().int(), style: z.string() }))
        .default([]),
      /**
       * The painted ground (D-585, D-587, D-588): the mask images, and which
       * material owns each of their channels.
       *
       * ⚠ Presentation only, like `roofs` above, and for a stronger reason
       * than convention: a ground material carries `walkable`, and the server
       * has never read it. What a floor is made of is not allowed to decide
       * where a body may stand — that is the tile grid and the collision
       * volumes (D-542, D-584) — or painting a map would silently re-cut it.
       *
       * ⚠ The two travel TOGETHER or not at all. A mask without its material
       * list is six unlabelled numbers per texel; the list without the mask is
       * a set of materials covering nothing. The client draws bare ground
       * unless it has both.
       *
       * ⚠ ORDER IS THE DATA. Mask 0's red channel means "this much of
       * `groundMaterials[0]`", mask 1's red means `[3]`, and nothing in the
       * pixels records which was which.
       */
      groundPaint: z.array(z.string().min(1)).default([]),
      groundMaterials: z.array(ContentIdSchema).default([]),
      width: z.number().int(),
      height: z.number().int(),
      legend: z.record(
        z.string().length(1),
        z.object({ walkable: z.boolean(), kind: z.string() }),
      ),
      tiles: z.array(z.string()),
      /** Where the exits are — targets stay server-side. */
      transitions: z.array(z.object({ x: z.number().int(), y: z.number().int() })),
    }),
    entities: z.array(WireEntitySchema),
    inventory: z.array(WireItemSchema),
    coin: z.number().int().nonnegative(),
  }),
  z.object({ t: z.literal('delta'), tick: z.number().int(), events: z.array(SimEventSchema) }),
  z.object({
    t: z.literal('speech'),
    speakerId: z.number().int(),
    channel: ChannelSchema,
    /** Scrambled server-side when this listener lacks the language — the
     * original words never reach their client. */
    text: z.string(),
    /** Display name of the language if the listener knows it, else 'unknown'. */
    language: z.string(),
    /** The speaker as THIS listener knew them at the moment of hearing. */
    speakerDescriptor: z.string(),
    /**
     * Insight reading, present only when a contested declaration produced
     * one. There is deliberately no field saying a declaration occurred —
     * the mechanic is invisible to observers (D-218).
     */
    impression: ImpressionSchema.optional(),
  }),
  z.object({
    t: z.literal('item_text'),
    itemId: UuidSchema,
    title: z.string(),
    text: z.string(),
  }),
  /** Per-observer descriptor refresh (e.g. after a presentation change). */
  z.object({ t: z.literal('descriptor'), entityId: z.number().int(), descriptor: z.string() }),
  /** DM/script narration (D-216): scene text with no speaker in the world. */
  z.object({ t: z.literal('narrate'), text: z.string() }),
  /** Live lighting change for the current area (DM weather/mood control). */
  z.object({
    t: z.literal('area_lighting'),
    lighting: z.enum(['overcast', 'night', 'underground', 'interior']),
  }),
  z.object({
    t: z.literal('inventory'),
    items: z.array(WireItemSchema),
    coin: z.number().int().nonnegative(),
  }),
  /**
   * What the common stores hold (D-580), sent to whoever is standing at them.
   *
   * ⚠ Public to anyone within reach, and that is the COST of pooling rather
   * than an oversight (D-530): goods on your person are your loss alone,
   * goods in the stores are one target everybody can see — including the
   * antagonist, whose sabotage grows stronger exactly as the cast grows more
   * trusting.
   *
   * ⚠ It carries NO "spoiled" flag, and that absence is the design. A
   * ruined larder must look exactly like a full one — the same rule the
   * poisoned well follows (D-552), where nothing looks different and you find
   * out by drinking. A first draft did send one; the client could not render
   * it without destroying the sabotage, which made it a wire field nothing
   * may ever read. Whether the bread is good is a property of the BREAD, and
   * it is discovered by eating it.
   */
  z.object({
    t: z.literal('store_contents'),
    station: z.string(),
    items: z.array(WireItemSchema),
  }),
  z.object({ t: z.literal('pong'), nonce: z.number().int(), tick: z.number().int() }),
  /**
   * Séance state (D-204). The caster learns how many questions remain; the
   * spirit learns it has been drawn back. Answers travel as ordinary speech
   * attributed to the corpse; questions reach the spirit the same way.
   */
  z.object({
    t: z.literal('seance'),
    role: z.enum(['caster', 'spirit']),
    active: z.boolean(),
    questionsLeft: z.number().int().nonnegative(),
  }),
  /** Confirmation of observe_body; also sent when observation ends (zombie
   * destroyed, duration expired). */
  z.object({ t: z.literal('observing'), on: z.boolean() }),
  /** The ending that is a beginning (D-207). Involuntary endings (endgame
   * permadeath, D-206) award nothing. */
  z.object({
    t: z.literal('retired'),
    awarded: z.number().int().nonnegative(),
    totalLegacyPoints: z.number().int().nonnegative(),
  }),
  // ---------------------------------------------------------------------
  // The Round (D-521). Three messages, and the split between them is a
  // security boundary rather than a convenience:
  //
  //   round_state  — BROADCAST. Never carries the objective or the
  //                  antagonist's identity. Anything added here is public.
  //   round_role   — to ONE connection, at round start. Everyone receives
  //                  one; only the antagonist's carries an objective, so the
  //                  mere arrival of the message is not a tell.
  //   round_ended  — the reveal. The only message that names the antagonist.
  // ---------------------------------------------------------------------
  z.object({
    t: z.literal('round_state'),
    phase: RoundPhaseSchema,
    /** How many are in the cast, and how many are needed to begin. */
    cast: z.number().int().nonnegative(),
    minCast: z.number().int().positive(),
    /** Ticks left in the round; null outside a running round. */
    remainingTicks: z.number().int().nonnegative().nullable(),
    /** The round's compressed clock (D-527) — drives lighting and dread. */
    hour: z.number().int().min(0).max(23),
    night: z.boolean(),
    /**
     * The dawn truce (D-536). While this is counting down the round's clock
     * is stopped and nobody can be hurt — it must be visible, or the safety
     * is only knowable by trying to attack someone.
     */
    graceTicks: z.number().int().nonnegative(),
    /**
     * How many of the cast are bots, and whether this server will summon
     * more (D-607).
     *
     * ⚠ Public, and safe to be: it says how many bots are in the round, and
     * never WHICH. Naming them would hand the cast a free elimination — a bot
     * can be dealt the objective like anybody else, and a round where the
     * antagonist can be deduced from a HUD is not a round (D-521, D-217).
     */
    bots: z.number().int().nonnegative().default(0),
    botsAllowed: z.boolean().default(false),
  }),
  z.object({
    t: z.literal('round_role'),
    antagonist: z.boolean(),
    /** Null for the whole cast except one. The brief is world-voice text and
     * is the antagonist's only briefing. */
    objective: z
      .object({ id: ContentIdSchema, name: z.string(), brief: z.string() })
      .nullable(),
  }),
  z.object({
    t: z.literal('round_ended'),
    outcome: RoundOutcomeSchema,
    winner: z.enum(['cast', 'antagonist', 'nobody']),
    objectiveName: z.string(),
    /** The reveal: who was carrying it. Sent nowhere else, ever. */
    antagonistName: z.string(),
    /** What this player banked — zero if they died (D-524). */
    xpBanked: z.number().int().nonnegative(),
    survived: z.boolean(),
  }),
  /**
   * Something was heard (D-531). Audio cue plus a line of text, delivered to
   * everyone in earshot who is not in the fight.
   *
   * It carries NO entity id and NO name, ever. A sound tells you that
   * violence is happening and roughly where — it is a LEAD, not proof, and
   * that is what keeps it compatible with D-217: reputation still requires a
   * witness, and hearing a scuffle through a wall is not one. The moment this
   * message names anybody, disguise, alibi and accusation all collapse.
   */
  z.object({
    t: z.literal('sound'),
    kind: z.enum(['combat']),
    /** Bearing from the listener, or 'here' when it is on top of them. */
    bearing: z.enum(['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw', 'here']),
    /** Coarse band, so the client can attenuate rather than being told a range. */
    distance: z.enum(['near', 'far']),
    /** The line to show. The client may render its own from kind + bearing. */
    text: z.string(),
  }),
  /**
   * Progress on whatever this player is working at (MR2). Sent to the worker
   * alone — bystanders see the ANIMATION and can draw their own conclusions,
   * but nobody gets a progress bar for someone else's labour.
   */
  z.object({
    t: z.literal('work'),
    activity: z.enum(['harvest', 'craft']),
    /** What is being worked: a node descriptor or a recipe name. */
    what: z.string(),
    /** 0..1. Reaching 1 is not a promise — being struck still cancels it. */
    progress: z.number().min(0).max(1),
    done: z.boolean(),
    /** Set when the work ended without producing anything, and why. */
    interrupted: z.string().nullable(),
  }),
  /**
   * What the client needs to NAME and MAKE things, sent once on entering.
   * Item templates travel with the recipes because both the inventory and
   * the craft panel need them: the wire carries template ids, and without
   * this the player reads "iron-ore" instead of "Iron Ore".
   */
  z.object({
    t: z.literal('catalogue'),
    items: z.array(
      z.object({
        id: ContentIdSchema,
        name: z.string(),
        description: z.string(),
        category: z.string(),
        stackable: z.boolean(),
        /** What eating or drinking this relieves (D-526); absent for
         * everything that is not a meal. The pack needs it to know which
         * items offer "eat", and so does anything playing headlessly. */
        nourishes: z.enum(['hunger', 'thirst']).optional(),
        /** Gear stats (D-547). Absent for anything that is not worn. */
        equip: EquipStatsSchema.optional(),
        /** What using it does (D-554); absent when it is not usable. The pack
         * shows a "use" verb on exactly the rows that carry this. */
        use: z.object({ kind: z.string(), value: z.number() }).optional(),
      }),
    ),
    recipes: z.array(
      z.object({
        id: ContentIdSchema,
        name: z.string(),
        output: ContentIdSchema,
        outputQuantity: z.number().int(),
        inputs: z.array(z.object({ item: ContentIdSchema, quantity: z.number().int() })),
        station: z.string(),
        effortTicks: z.number().int(),
      }),
    ),
  }),
  /** Your own vitals — sent on change. Others never see your numbers. */
  z.object({
    t: z.literal('status'),
    hp: z.number().int(),
    maxHp: z.number().int(),
    xp: z.number().int().nonnegative(),
    deathDebt: z.number().int().nonnegative(),
    ghost: z.boolean(),
    injuries: z.array(InjurySchema),
    /**
     * Survival needs (D-526). Coarse stages, never a bar — a number that
     * ticks down invites the player to watch it instead of the room.
     */
    hunger: NeedStageSchema.default('sated'),
    thirst: NeedStageSchema.default('sated'),
    /**
     * Level and the EFFECTIVE sheet (D-538) — creation allocation plus every
     * progression grant already paid out. The client renders a character
     * sheet from this and never recomputes it: the server is the authority
     * on what a character actually has (D-102).
     */
    /** Which calling, so the sheet and the level-up screen can filter by it. */
    classId: z.string().nullable().default(null),
    /** And what it is, for the sheet. Null on a character made before races. */
    raceId: z.string().nullable().default(null),
    level: z.number().int().min(1).default(1),
    xpForNextLevel: z.number().int().nonnegative().nullable().default(null),
    skills: z.record(z.string(), z.number().int()).default({}),
    feats: z.array(z.string()).default([]),
    spells: z.array(z.string()).default([]),
    abilities: z.array(z.string()).default([]),
    /**
     * The reserve rites and spells are paid out of (D-546). A bar, unlike the
     * needs above, because unlike hunger it is spent and refilled many times
     * a minute and a player has to be able to time the next one.
     */
    mana: z.number().int().nonnegative().default(0),
    maxMana: z.number().int().nonnegative().default(0),
    /** Creation allocation plus level-up points, resolved (D-546). */
    attributes: z.record(AttributeSchema, z.number().int()).default({}),
    /** What the worn set is contributing right now (D-547). */
    loadout: z
      .object({
        armour: z.number().int().nonnegative(),
        /** Best weapon in hand, not the sum of both. */
        damage: z.number().int().nonnegative(),
        /** Carried weight against what this character can shift. */
        weight: z.number().int().nonnegative(),
        capacity: z.number().int().nonnegative(),
      })
      .default({ armour: 0, damage: 0, weight: 0, capacity: 0 }),
    /**
     * What is still unspent (D-546). The client shows the level-up screen
     * when any of these is positive, which is also how a player who levelled
     * twice while away gets both screens' worth rather than losing one.
     */
    unspent: z
      .object({
        attributePoints: z.number().int().nonnegative(),
        skillPoints: z.number().int().nonnegative(),
        feats: z.number().int().nonnegative(),
        spells: z.number().int().nonnegative(),
      })
      .default({ attributePoints: 0, skillPoints: 0, feats: 0, spells: 0 }),
    /** The player's own level-up spending so far, so the screen can edit it. */
    advances: CharacterAdvancesSchema.nullable().default(null),
    /**
     * Swings in a four-second combat round (D-550), and the reach of whatever
     * is in hand. The client needs both to pace auto-attack and to know when
     * it is close enough to start — it never DECIDES either (D-102), it just
     * stops sending attacks the server would refuse.
     */
    attacksPerRound: z.number().int().min(1).default(1),
    /**
     * How far this character can strike, in METRES (D-567).
     *
     * ⚠ It was `.int()`, and that one word cost an hour. Raising bare-handed
     * reach to 1.5m — the honest conversion of "adjacent, diagonals included" —
     * made the ENTIRE status message fail schema validation, so it was dropped
     * on the floor: no error, no status, and six tests reporting a timeout
     * waiting for a message that was being sent every time. Any `.int()` left
     * on a distance is a trapdoor of exactly this shape.
     */
    reach: z.number().min(0).default(1),
    /**
     * How long a combat round is on THIS server, in ticks (D-550). Sent
     * rather than assumed: the length is a pacing option, and a client that
     * hardcoded the default would throttle its auto-attack wrongly against
     * any server that shortened it.
     */
    roundTicks: z.number().int().min(1).default(40),
    /** The character's saved hotbar (D-553); null means "use the defaults". */
    hotbar: z.array(z.string().nullable()).nullable().default(null),
  }),
]);

export type ServerMessage = z.infer<typeof ServerMessageSchema>;

export function parseClientMessage(raw: unknown): ClientMessage | null {
  const result = ClientMessageSchema.safeParse(raw);
  return result.success ? result.data : null;
}

export function parseServerMessage(raw: unknown): ServerMessage | null {
  const result = ServerMessageSchema.safeParse(raw);
  return result.success ? result.data : null;
}
