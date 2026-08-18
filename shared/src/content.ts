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
    /**
     * Does the sky reach here? Drives the day-night cycle's danger and its
     * reward (D-527, D-528): after dusk, outdoor areas darken, roamers walk
     * them, and what is earned there pays more.
     *
     * Never inferred from `lighting` — that is a rendering profile, and
     * tying how an area LOOKS to whether it is dangerous is the coupling
     * D-527 warned against. A bright cavern and a gloomy field both break it.
     *
     * Defaults to FALSE, and the direction is the point: an area opts IN to
     * night. Forgetting the flag on open ground means night never reaches it,
     * which is wrong but visible in play. The opposite default would have
     * every cellar quietly paying the night bonus for hiding — wrong and
     * invisible. Set it explicitly on every authored area regardless.
     */
    outdoor: z.boolean().default(false),
    /**
     * Where the resource nodes stand (MR2). Placement is area content and the
     * node's BEHAVIOUR is its own document, so the same vein definition can
     * be dropped in twenty places without repeating its yield or its timing.
     */
    nodes: z
      .array(
        z.object({
          x: z.number().int().min(0),
          y: z.number().int().min(0),
          type: ContentIdSchema,
        }),
      )
      .default([]),
    /** PvP tier (D-206): settled requires declared hostility with a spoken
     * warning window; wilderness is open; endgame adds permadeath (M4b). */
    zone: z.enum(['settled', 'wilderness', 'endgame']).default('settled'),
    /**
     * Graph edges between areas (D-103): stepping onto (x, y) moves the
     * character to (toX, toY) in toArea. The validator cross-checks targets.
     */
    transitions: z
      .array(
        z.object({
          x: z.number().int().min(0),
          y: z.number().int().min(0),
          toArea: ContentIdSchema,
          toX: z.number().int().min(0),
          toY: z.number().int().min(0),
        }),
      )
      .default([]),
    /** Lua scripts (content/scripts/<id>.lua) attached to this area (D-109). */
    scripts: z.array(ContentIdSchema).default([]),
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

/**
 * Languages (M2): speech in a language a listener does not know arrives
 * scrambled — deterministically per word, so recurring words stay
 * recognisable and can themselves become roleplay material.
 */
export const LanguageSchema = z.object({
  id: ContentIdSchema,
  name: z.string().min(1),
  description: z.string().min(1),
});
export type Language = z.infer<typeof LanguageSchema>;
export const LanguagesFileSchema = z
  .array(LanguageSchema)
  .refine((list) => list.some((l) => l.id === 'common'), {
    message: "the language list must include 'common'",
  })
  .refine((list) => new Set(list.map((l) => l.id)).size === list.length, {
    message: 'duplicate language ids',
  });

/** Presentation states (D-219). The observed identity is character × state. */
export const PRESENTATIONS = ['normal', 'hooded'] as const;
export const PresentationSchema = z.enum(PRESENTATIONS);
export type Presentation = z.infer<typeof PresentationSchema>;

/**
 * Classes (D-208, roster ratified in D-511). A class is content, not code:
 * it names an archetype and grants distinctive abilities. Mechanical gating
 * reads `abilities`; everything else is presentation. Legacy-locked classes
 * (D-207) cost Legacy Points to create — access and flavour, never power.
 */
export const CLASS_ABILITIES = [
  /** D-204: pull a ghost back to its corpse for five questions. */
  'speak-with-dead',
  /** D-204/D-224: raise a corpse as a walking ally. */
  'animate-dead',
  /** D-204: perceive the ghost plane while living. Not yet implemented. */
  'plane-shift',
] as const;
export const ClassAbilitySchema = z.enum(CLASS_ABILITIES);
export type ClassAbility = z.infer<typeof ClassAbilitySchema>;

export const ClassSchema = z.object({
  id: ContentIdSchema,
  name: z.string().min(1),
  description: z.string().min(1),
  /** Broad role tag for grouping in UI: 'melee', 'arcane', 'support', ... */
  role: z.string().min(1),
  abilities: z.array(ClassAbilitySchema).default([]),
  legacyLocked: z.boolean().default(false),
  /** Skills this class is built around — the creation UI suggests them
   * first. Purely advisory: points may go anywhere (D-208's "deep, not
   * railroaded" reading). */
  affinities: z.array(ContentIdSchema).default([]),
  /** Casters pick spells at creation; everyone else skips that step. */
  spellcasting: z.boolean().default(false),
});
export type ClassDef = z.infer<typeof ClassSchema>;

/**
 * Skills, feats and spells (D-208, D-110). All three are CONTENT, not code:
 * the creation screen renders whatever these files contain, and the server
 * validates submitted builds against them. Balance numbers here are a first
 * pass and are flagged for stakeholder ratification, not settled design.
 */

export const SkillSchema = z.object({
  id: ContentIdSchema,
  name: z.string().min(1),
  description: z.string().min(1),
  /** Grouping for the creation UI: 'social', 'martial', 'lore', ... */
  group: z.string().min(1),
});
export type SkillDef = z.infer<typeof SkillSchema>;
export const SkillsFileSchema = z.array(SkillSchema);

export const FeatSchema = z.object({
  id: ContentIdSchema,
  name: z.string().min(1),
  description: z.string().min(1),
  /** Empty = open to every class; otherwise only these classes may take it. */
  classes: z.array(ContentIdSchema).default([]),
  /** Minimum allocated skill levels required to take the feat. */
  requiresSkills: z.record(ContentIdSchema, z.number().int().min(0)).default({}),
});
export type FeatDef = z.infer<typeof FeatSchema>;
export const FeatsFileSchema = z.array(FeatSchema);

export const SpellSchema = z.object({
  id: ContentIdSchema,
  name: z.string().min(1),
  description: z.string().min(1),
  /** Which casting classes may learn it. Empty = any spellcasting class. */
  classes: z.array(ContentIdSchema).default([]),
  /** Flavour grouping shown in the UI. */
  school: z.string().min(1),
});
export type SpellDef = z.infer<typeof SpellSchema>;
export const SpellsFileSchema = z.array(SpellSchema);

/**
 * A character build as submitted at creation. The client assembles one and
 * the SERVER re-validates it against content before anything is written —
 * the client never determines what is legal (D-102).
 */
export const CharacterBuildSchema = z.object({
  /** skill id → points allocated at creation. */
  skills: z.record(ContentIdSchema, z.number().int().min(0)).default({}),
  feats: z.array(ContentIdSchema).default([]),
  spells: z.array(ContentIdSchema).default([]),
});
export type CharacterBuild = z.infer<typeof CharacterBuildSchema>;

/**
 * Creation budget (UNRATIFIED — first-pass numbers, flagged for the
 * stakeholder). Skills use the same 0–100 scale as the pre-existing
 * bluff/insight/necromancy so every mechanic already written keeps working:
 * necromancy 40 at creation buys a second zombie (D-511), which is the
 * intended ceiling for a starting specialist.
 */
export const CREATION_SKILL_POINTS = 120;
export const CREATION_SKILL_STEP = 5;
export const CREATION_SKILL_MAX = 40;
export const CREATION_FEAT_PICKS = 2;
export const CREATION_SPELL_PICKS = 3;

export interface BuildContent {
  classes: readonly ClassDef[];
  skills: readonly SkillDef[];
  feats: readonly FeatDef[];
  spells: readonly SpellDef[];
}

/**
 * The one place creation legality is decided. The client calls it for live
 * feedback; the server calls it as the authority. Returns [] when the build
 * is legal, else human-readable reasons.
 */
export function validateBuild(
  content: BuildContent,
  classId: string | undefined,
  build: CharacterBuild,
): string[] {
  const errors: string[] = [];
  const cls = content.classes.find((c) => c.id === classId);
  if (!cls) {
    errors.push(`unknown class '${classId ?? ''}'`);
    return errors; // everything below is class-relative
  }

  let spent = 0;
  for (const [id, points] of Object.entries(build.skills)) {
    const skill = content.skills.find((s) => s.id === id);
    if (!skill) {
      errors.push(`unknown skill '${id}'`);
      continue;
    }
    if (points % CREATION_SKILL_STEP !== 0) {
      errors.push(`${skill.name} must be allocated in steps of ${CREATION_SKILL_STEP}`);
    }
    if (points > CREATION_SKILL_MAX) {
      errors.push(`${skill.name} exceeds the creation cap of ${CREATION_SKILL_MAX}`);
    }
    spent += points;
  }
  if (spent > CREATION_SKILL_POINTS) {
    errors.push(`skill points overspent: ${spent} of ${CREATION_SKILL_POINTS}`);
  }

  if (build.feats.length > CREATION_FEAT_PICKS) {
    errors.push(`too many feats: ${build.feats.length} of ${CREATION_FEAT_PICKS}`);
  }
  if (new Set(build.feats).size !== build.feats.length) errors.push('duplicate feat');
  for (const id of build.feats) {
    const feat = content.feats.find((f) => f.id === id);
    if (!feat) {
      errors.push(`unknown feat '${id}'`);
      continue;
    }
    if (feat.classes.length > 0 && !feat.classes.includes(cls.id)) {
      errors.push(`${cls.name} cannot take ${feat.name}`);
    }
    for (const [skillId, min] of Object.entries(feat.requiresSkills)) {
      if ((build.skills[skillId] ?? 0) < min) {
        const skill = content.skills.find((s) => s.id === skillId);
        errors.push(`${feat.name} requires ${skill?.name ?? skillId} ${min}`);
      }
    }
  }

  if (!cls.spellcasting && build.spells.length > 0) {
    errors.push(`${cls.name} does not cast spells`);
  } else {
    if (build.spells.length > CREATION_SPELL_PICKS) {
      errors.push(`too many spells: ${build.spells.length} of ${CREATION_SPELL_PICKS}`);
    }
    if (new Set(build.spells).size !== build.spells.length) errors.push('duplicate spell');
    for (const id of build.spells) {
      const spell = content.spells.find((s) => s.id === id);
      if (!spell) {
        errors.push(`unknown spell '${id}'`);
        continue;
      }
      if (spell.classes.length > 0 && !spell.classes.includes(cls.id)) {
        errors.push(`${cls.name} cannot learn ${spell.name}`);
      }
    }
  }
  return errors;
}
