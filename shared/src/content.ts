import { z } from 'zod';
import type { Vec2 } from './types';

/**
 * Content schemas (D-110): all world content is versioned, schema-validated
 * data. These schemas are the single source of truth — the server loads with
 * them, and tools/validate-content.ts fails CI on any file that does not parse.
 */

export const ContentIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'content ids are lowercase-kebab-case');

export const TileDefSchema = z.object({
  walkable: z.boolean(),
  /** Render/logic hint: 'floor', 'wall', 'water', ... Free-form for now. */
  kind: z.string().min(1),
  /** Blocks line of sight. Defaults to true for kind 'wall', else false. */
  opaque: z.boolean().optional(),
});

export function isTileOpaque(def: { kind: string; opaque?: boolean }): boolean {
  return def.opaque ?? def.kind === 'wall';
}

/** Per-area lighting profile (D-504, feeding D-305). */
export const LightingProfileSchema = z.enum(['overcast', 'night', 'underground', 'interior']);
export type LightingProfile = z.infer<typeof LightingProfileSchema>;

export const AreaSchema = z
  .object({
    id: ContentIdSchema,
    name: z.string().min(1),
    width: z.number().int().min(8).max(256),
    height: z.number().int().min(8).max(256),
    /** Maps each character used in `tiles` rows to a tile definition. */
    legend: z.record(z.string().length(1), TileDefSchema),
    /** Row-major, `height` strings of `width` characters each. */
    tiles: z.array(z.string()),
    /** Default spawn tile; must be walkable. */
    spawn: z.object({ x: z.number().int().min(0), y: z.number().int().min(0) }),
    lighting: LightingProfileSchema.default('overcast'),
  })
  .superRefine((area, ctx) => {
    if (area.tiles.length !== area.height) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `tiles has ${area.tiles.length} rows, height is ${area.height}`,
      });
      return;
    }
    for (let y = 0; y < area.tiles.length; y++) {
      const row = area.tiles[y]!;
      if (row.length !== area.width) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `row ${y} has ${row.length} chars, width is ${area.width}`,
        });
        return;
      }
      for (const ch of row) {
        if (!(ch in area.legend)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `row ${y} uses '${ch}' which is not in the legend`,
          });
          return;
        }
      }
    }
    const spawnRow = area.tiles[area.spawn.y];
    const spawnCh = spawnRow?.[area.spawn.x];
    if (spawnCh === undefined || !area.legend[spawnCh]!.walkable) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `spawn (${area.spawn.x},${area.spawn.y}) is not a walkable tile`,
      });
    }
  });

export type AreaDef = z.infer<typeof AreaSchema>;

export function isTileWalkable(area: AreaDef, pos: Vec2): boolean {
  if (pos.x < 0 || pos.y < 0 || pos.x >= area.width || pos.y >= area.height) return false;
  const ch = area.tiles[pos.y]![pos.x]!;
  return area.legend[ch]!.walkable;
}

/**
 * Item categories per D-210: every item is exactly one of these. "Recipe
 * input" is not a category — it is a property conferred by appearing in a
 * recipe, which the orphan validator (M5) will check graph-wide.
 */
export const ItemCategorySchema = z.enum([
  'base_material',
  'equipment',
  'consumable',
  'valuable',
]);

export const ItemTemplateSchema = z.object({
  id: ContentIdSchema,
  name: z.string().min(1),
  description: z.string().min(1),
  category: ItemCategorySchema,
  stackable: z.boolean().default(false),
  /** Reference value in coin for telemetry/vendor floors (D-221). Not a price. */
  value: z.number().int().min(0),
});

export type ItemTemplate = z.infer<typeof ItemTemplateSchema>;

/**
 * Emote lexicon (D-202): a data-defined mapping from spoken phrases to
 * animations, extendable by DMs without a deploy. Postures persist until
 * movement; transients play once. Unmatched text is fine — it renders as
 * plain emote text and never errors.
 */

export const POSTURES = ['standing', 'sitting', 'kneeling'] as const;
export const PostureSchema = z.enum(POSTURES);
export type Posture = z.infer<typeof PostureSchema>;

/** Transient animations the client can play; lexicon keys must stay inside this. */
export const TRANSIENT_ANIMS = ['bow', 'wave', 'laugh', 'point', 'shrug'] as const;
export const TransientAnimSchema = z.enum(TRANSIENT_ANIMS);
export type TransientAnim = z.infer<typeof TransientAnimSchema>;

const SynonymsSchema = z.array(z.string().min(1)).min(1);

export const EmoteLexiconSchema = z.object({
  /** Words that cancel a following match: "*doesn't flinch*" must not flinch. */
  negators: z.array(z.string().min(1)),
  postures: z.record(PostureSchema, SynonymsSchema),
  transients: z.record(TransientAnimSchema, SynonymsSchema),
});

export type EmoteLexicon = z.infer<typeof EmoteLexiconSchema>;

export const EMPTY_LEXICON: EmoteLexicon = { negators: [], postures: {}, transients: {} };
