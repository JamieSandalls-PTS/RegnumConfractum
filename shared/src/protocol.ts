import { z } from 'zod';
import { DIRECTIONS } from './types';
import {
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
    /** Skills, feats and spells chosen at creation. The server re-validates
     * against content and rejects anything illegal (D-102). */
    build: CharacterBuildSchema.optional(),
  }),
  /** Asks for the creation catalogue (classes, skills, feats, spells). */
  z.object({ t: z.literal('get_creation_content') }),
  z.object({ t: z.literal('enter_world'), characterId: UuidSchema }),
  z.object({ t: z.literal('move'), dir: DirectionSchema }),
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
  z.object({ t: z.literal('retire') }),
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
  'character_name_taken',
  'bad_target',
  'not_adjacent',
  'no_such_item',
  'insufficient_funds',
  'not_hostile',
  'on_cooldown',
  'dead',
  'not_dead',
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
  kind: z.enum(['player', 'npc', 'corpse', 'pile']),
  x: z.number().int(),
  y: z.number().int(),
  facing: DirectionSchema,
  posture: PostureSchema,
  presentation: PresentationSchema,
  /** Drives client-side procedural appearance (D-402). */
  appearanceSeed: z.number().int().nonnegative(),
});
export type WireEntity = z.infer<typeof WireEntitySchema>;

export const WireItemSchema = z.object({
  id: UuidSchema,
  templateId: z.string(),
  qty: z.number().int().positive(),
  /** Display label for written/inscribed items (the note's title). */
  label: z.string().optional(),
});
export type WireItem = z.infer<typeof WireItemSchema>;

export const CharacterSummarySchema = z.object({
  id: UuidSchema,
  name: CharacterNameSchema,
  areaId: z.string(),
  x: z.number().int(),
  y: z.number().int(),
  appearanceSeed: z.number().int().nonnegative(),
  /** Playable class id (D-208/D-511); absent on pre-class characters. */
  classId: z.string().optional(),
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
    x: z.number().int(),
    y: z.number().int(),
    facing: DirectionSchema,
  }),
  z.object({ type: z.literal('entity_entered'), entity: WireEntitySchema }),
  z.object({ type: z.literal('entity_left'), id: z.number().int() }),
  z.object({
    type: z.literal('entity_emote'),
    id: z.number().int(),
    posture: PostureSchema.optional(),
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
  }),
  /** The visible death. Observers drop the entity; the ghost lives on in a
   * world only other ghosts can see (D-203). */
  z.object({ type: z.literal('entity_died'), id: z.number().int() }),
]);
export type SimEvent = z.infer<typeof SimEventSchema>;

/** Graded, fallible Insight readings (D-218). Absence means "you cannot tell". */
export const ImpressionSchema = z.enum(['rings_false', 'certain_false']);
export type Impression = z.infer<typeof ImpressionSchema>;

export const ServerMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('error'), code: ErrorCodeSchema, message: z.string() }),
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
   * The creation catalogue (D-208/D-110). Sent on request so the creation
   * screen is rendered from CONTENT rather than hardcoded in the client —
   * adding a feat is a data change, not a client deploy.
   */
  z.object({
    t: z.literal('creation_content'),
    classes: z.array(ClassSchema),
    skills: z.array(SkillSchema),
    feats: z.array(FeatSchema),
    spells: z.array(SpellSchema),
    budget: z.object({
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
  /** Your own vitals — sent on change. Others never see your numbers. */
  z.object({
    t: z.literal('status'),
    hp: z.number().int(),
    maxHp: z.number().int(),
    xp: z.number().int().nonnegative(),
    deathDebt: z.number().int().nonnegative(),
    ghost: z.boolean(),
    injuries: z.array(InjurySchema),
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
