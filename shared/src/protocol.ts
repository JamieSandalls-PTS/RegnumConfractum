import { z } from 'zod';
import { DIRECTIONS } from './types';

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

export const ClientMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('register'), username: UsernameSchema, password: PasswordSchema }),
  z.object({ t: z.literal('login'), username: UsernameSchema, password: z.string().max(128) }),
  z.object({ t: z.literal('resume'), token: z.string().max(128) }),
  z.object({
    t: z.literal('create_character'),
    name: CharacterNameSchema,
    appearanceSeed: z.number().int().nonnegative().optional(),
  }),
  z.object({ t: z.literal('enter_world'), characterId: UuidSchema }),
  z.object({ t: z.literal('move'), dir: DirectionSchema }),
  z.object({ t: z.literal('give'), itemId: UuidSchema, toEntityId: z.number().int() }),
  z.object({ t: z.literal('pay'), toEntityId: z.number().int(), amount: z.number().int().positive() }),
  z.object({ t: z.literal('resync') }),
  z.object({ t: z.literal('ping'), nonce: z.number().int() }),
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// ---------------------------------------------------------------------------
// Server → client.
// ---------------------------------------------------------------------------

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
  'internal',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const WireEntitySchema = z.object({
  id: z.number().int(),
  name: CharacterNameSchema,
  kind: z.enum(['player']),
  x: z.number().int(),
  y: z.number().int(),
  facing: DirectionSchema,
});
export type WireEntity = z.infer<typeof WireEntitySchema>;

export const WireItemSchema = z.object({
  id: UuidSchema,
  templateId: z.string(),
  qty: z.number().int().positive(),
});
export type WireItem = z.infer<typeof WireItemSchema>;

export const CharacterSummarySchema = z.object({
  id: UuidSchema,
  name: CharacterNameSchema,
  areaId: z.string(),
  x: z.number().int(),
  y: z.number().int(),
  appearanceSeed: z.number().int().nonnegative(),
});
export type CharacterSummary = z.infer<typeof CharacterSummarySchema>;

/** Per-tick simulation events, broadcast to everyone in the area. */
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
]);
export type SimEvent = z.infer<typeof SimEventSchema>;

export const ServerMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('error'), code: ErrorCodeSchema, message: z.string() }),
  z.object({
    t: z.literal('auth_ok'),
    accountId: UuidSchema,
    token: z.string(),
    characters: z.array(CharacterSummarySchema),
  }),
  z.object({ t: z.literal('character_created'), character: CharacterSummarySchema }),
  z.object({
    t: z.literal('snapshot'),
    tick: z.number().int(),
    you: z.number().int(),
    area: z.object({
      id: z.string(),
      name: z.string(),
      width: z.number().int(),
      height: z.number().int(),
      legend: z.record(
        z.string().length(1),
        z.object({ walkable: z.boolean(), kind: z.string() }),
      ),
      tiles: z.array(z.string()),
    }),
    entities: z.array(WireEntitySchema),
    inventory: z.array(WireItemSchema),
    coin: z.number().int().nonnegative(),
  }),
  z.object({ t: z.literal('delta'), tick: z.number().int(), events: z.array(SimEventSchema) }),
  z.object({
    t: z.literal('inventory'),
    items: z.array(WireItemSchema),
    coin: z.number().int().nonnegative(),
  }),
  z.object({ t: z.literal('pong'), nonce: z.number().int(), tick: z.number().int() }),
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
