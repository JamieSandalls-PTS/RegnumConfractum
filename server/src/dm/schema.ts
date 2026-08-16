import { z } from 'zod';
import { LightingProfileSchema } from '@rc/shared';

/**
 * DM event documents (D-216): what the form-based editor produces and the
 * EventEngine interprets. Declarative rather than generated Lua — a document
 * can be schema-validated before it ever runs, rehearsed, and rolled back.
 *
 * An event is a chain of STAGES. Stage N+1 arms only after stage N fires —
 * chained consequences are the point (the M3 done-when is exactly such a
 * chain). Area/entity references may be `$alias` names bound by earlier
 * spawn actions in the same run.
 */

const AliasSchema = z.string().regex(/^[a-z][a-z0-9-]*$/);
/** A concrete areaId, or `$alias` of an area spawned earlier in the run. */
const AreaRefSchema = z.string().min(1);

export const EventTriggerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('immediate') }),
  /** Fires when the game clock next strikes this hour (48-minute day). */
  z.object({ type: z.literal('at_hour'), hour: z.number().int().min(0).max(23) }),
  /** Fires this long after the stage arms. */
  z.object({ type: z.literal('after_seconds'), seconds: z.number().positive().max(86_400) }),
  z.object({
    type: z.literal('player_count'),
    area: AreaRefSchema,
    count: z.number().int().min(1),
  }),
  /** Registered now, fires from M4 when entities can die (D-507). */
  z.object({ type: z.literal('entity_death'), alias: AliasSchema }),
]);
export type EventTrigger = z.infer<typeof EventTriggerSchema>;

export const EventActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('narrate'),
    scope: z.enum(['area', 'global']),
    area: AreaRefSchema.optional(),
    text: z.string().min(1).max(500),
  }),
  z.object({
    type: z.literal('spawn_npc'),
    area: AreaRefSchema,
    x: z.number().int().min(0),
    y: z.number().int().min(0),
    descriptor: z.string().min(1).max(120),
    alias: AliasSchema.optional(),
    seed: z.number().int().nonnegative().optional(),
  }),
  z.object({
    type: z.literal('npc_say'),
    alias: AliasSchema,
    text: z.string().min(1).max(400),
    channel: z.enum(['say', 'whisper', 'shout']).optional(),
  }),
  z.object({
    type: z.literal('set_lighting'),
    area: AreaRefSchema,
    lighting: LightingProfileSchema,
  }),
  /**
   * Spawns a temporary area cloned from a content area, linked by a new
   * way-marker placed in an existing area (D-216 "rapid creation of
   * temporary areas"). Rolled back with the run.
   */
  z.object({
    type: z.literal('spawn_area'),
    from: z.string().min(1),
    alias: AliasSchema,
    name: z.string().min(1).max(80),
    link: z.object({
      area: AreaRefSchema,
      x: z.number().int().min(0),
      y: z.number().int().min(0),
    }),
  }),
  z.object({ type: z.literal('despawn'), alias: AliasSchema }),
]);
export type EventAction = z.infer<typeof EventActionSchema>;

export const EventStageSchema = z.object({
  trigger: EventTriggerSchema,
  actions: z.array(EventActionSchema).min(1).max(20),
});

export const EventDocSchema = z.object({
  name: z.string().min(1).max(80),
  stages: z.array(EventStageSchema).min(1).max(12),
});
export type EventDoc = z.infer<typeof EventDocSchema>;
