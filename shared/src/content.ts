import { z } from 'zod';
import {
  ATTRIBUTES,
  ATTRIBUTE_BASE,
  ATTRIBUTE_CREATION_MAX,
  ATTRIBUTE_CREATION_POINTS,
  ATTRIBUTE_MAX,
  validateAttributeAllocation,
} from './attributes';
import { EquipStatsSchema, StartingKitEntrySchema } from './equipment';
import {
  MAX_LEVEL,
  SKILL_CEILING,
  advancementBudget,
  type CharacterAdvances,
} from './progression';
import { ARMOUR_MATERIALS } from './characters';
import { StanceSchema } from './actions';
import { PlacedAssetSchema, assetVolumes, type PlacedAsset } from './placement';
import type { Vec2 } from './types';

/**
 * The four facilities (D-530). A closed list, because each one has geometry,
 * a recipe gate and a descriptor, and a fifth spelling would be a station
 * nothing draws.
 */
import {
  BODY_RADIUS,
  CollisionLayerSchema,
  Vec2Schema,
  canOccupy,
  sightBlocked,
  type CollisionLayer,
} from './collision';

/**
 * Content schemas (D-110): all world content is versioned, schema-validated
 * data. These schemas are the single source of truth — the server loads with
 * them, and tools/validate-content.ts fails CI on any file that does not parse.
 */

export const ContentIdSchema = z

  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'content ids are lowercase-kebab-case');

/**
 * The facilities a map may place (D-530).
 *
 * WARNING: these four are the ones the RULES name -- a recipe requires the
 * workshop, eating at the storehouse is a proper meal, treatment happens at
 * the infirmary, and the well is the thing worth poisoning (D-529). Server
 * code refers to them by id, so removing one breaks a rule rather than a
 * model.
 *
 * A map may place any station `content/stations/` defines, not only these:
 * `StationTypeSchema` is deliberately a content id and not an enum, so a
 * forge, a loom or a shrine is a JSON file rather than an edit in four
 * TypeScript files. CI checks that every placed station is defined.
 */
export const CORE_STATION_TYPES = ['workshop', 'storehouse', 'infirmary', 'well'] as const;
export type CoreStationType = (typeof CORE_STATION_TYPES)[number];
export const StationTypeSchema = ContentIdSchema;
export type StationType = string;

/**
 * A facility, as content (D-530, D-567).
 *
 * WARNING: `art` is what lets this stop being procedural. The four originals
 * are the last hand-written geometry in the game -- a station is not scenery,
 * it is an object the server spawns and the well has to be visible across the
 * square, so it could not simply be deleted with the props. Naming a pack mesh
 * here replaces the built-in model; leaving it absent keeps it.
 */
export const StationDefSchema = z.object({
  id: ContentIdSchema,
  name: z.string().min(1),
  /** What a player is told they are looking at. */
  descriptor: z.string().min(1),
  /** A pack mesh to draw instead of the built-in geometry. */
  art: z
    .object({
      pack: z.string().min(1),
      asset: ContentIdSchema,
      /** Degrees clockwise, and a uniform scale, as a placed asset has. */
      rotation: z.number().default(0),
      scale: z.number().positive().default(1),
    })
    .optional(),
  notes: z.string().optional(),
});
export type StationDef = z.infer<typeof StationDefSchema>;

export const HexColourSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be #rrggbb');

/**
 * How many painted masks an area may carry, and therefore how many ground
 * materials: three weights per mask (D-587's canvas trap — alpha is coverage,
 * not a fourth weight), two masks, six materials (D-588).
 *
 * ⚠ ONE number, here, because three things must agree: the schema below, the
 * renderer that samples the masks, and the editor server that writes them.
 * Three separate constants is three chances for a map to name a mask nobody
 * writes, and that failure is a build error about a missing file rather than
 * about the number being wrong.
 */
export const GROUND_MASKS = 2;
export const GROUND_WEIGHTS_PER_MASK = 3;
export const GROUND_MATERIAL_LIMIT = GROUND_MASKS * GROUND_WEIGHTS_PER_MASK;

/**
 * What a patch of ground is made of (D-585).
 *
 * ⚠ A ground material is CONTENT, not a constant in the renderer. The floor
 * has been flat colour since D-567 took the painted tile art away, and the
 * reason it stayed flat is that nothing could say what a tile should look like
 * without editing TypeScript. This is that sentence, in a file.
 *
 * ⚠ The texture is a FILE NAME, not a path, and it is checked in CI exactly
 * as a sound cue's file is (D-541): a material naming a texture that is not on
 * disk renders as its tint and looks identical to one nobody has finished, so
 * the build refuses it rather than warning.
 */
export const GroundMaterialSchema = z.object({
  id: ContentIdSchema,
  name: z.string().min(1),
  /**
   * The file under `client/public/textures/ground/`.
   *
   * Absent is legal and means "just the tint" — which is what every tile looks
   * like today, and what a map looks like before anybody has drawn anything.
   */
  texture: z.string().min(1).optional(),
  /**
   * How many times it repeats across ONE TILE.
   *
   * ⚠ Per tile rather than per area, because a map is not a fixed size: an
   * area that grows must not stretch its grass. 1 means one tile, one image.
   */
  repeat: z.number().positive().default(1),
  /**
   * What this material looks like with NO art: a flat colour, so a map can be
   * laid out before the texture exists and gain its surface later without
   * being re-painted.
   *
   * ⚠ IT IS NOT MULTIPLIED INTO THE TEXTURE, and that is a correction
   * (D-590). It used to be both — the fallback AND a tint over the art — and
   * the two jobs cannot be done by one number, because a material's tint IS
   * roughly the average colour of its own texture. Multiplying them squares
   * it. Measured across the shipped materials: mud rendered at an albedo of
   * 0.107/0.080/0.051, about as dark as coal, and grass at 0.153/0.199/0.084.
   * The whole town came out nearly black and read as bad lighting.
   */
  tint: HexColourSchema.default('#6b7a55'),
  /**
   * A deliberate multiply over the art, when somebody wants one — a sun-bleached
   * cut of the same gravel, a greener grass.
   *
   * ⚠ Defaults to WHITE, i.e. no wash. Separate from `tint` because they are
   * opposite jobs: `tint` stands in for art that is missing, `wash` modifies
   * art that is there. One field doing both is what darkened every surface in
   * the game by its own colour.
   */
  wash: HexColourSchema.default('#ffffff'),
  /** Walkable ground by default; set false for a material that is a barrier. */
  walkable: z.boolean().default(true),
  notes: z.string().optional(),
});
export type GroundMaterial = z.infer<typeof GroundMaterialSchema>;

export const TileDefSchema = z.object({
  walkable: z.boolean(),
  /** Render/logic hint: 'floor', 'wall', 'water', ... Free-form for now. */
  kind: z.string().min(1),
  /** Blocks line of sight. Defaults to true for kind 'wall', else false. */
  opaque: z.boolean().optional(),
});

/**
 * The wall family (D-545). One `wall` kind was never enough — a taproom, a
 * town gate, a mine gallery and a treeline are not made of the same stuff — so walls are
 * a family of kinds that differ in material and silhouette while behaving
 * identically: unwalkable, opaque, and full height.
 *
 * ⚠ Line of sight keys off this list. `isTileOpaque` used to test
 * `kind === 'wall'`, so a timber wall added without touching it would have
 * been a wall you could see straight through — and D-217's whole
 * witness model runs on line of sight.
 */
export const WALL_KINDS = [
  'wall',
  'wall-timber',
  'wall-plaster',
  'wall-brick',
  'wall-cave',
  'wall-forest',
  'palisade',
] as const;
export type WallKind = (typeof WALL_KINDS)[number];

export function isWallKind(kind: string): boolean {
  return (WALL_KINDS as readonly string[]).includes(kind);
}

export function isTileOpaque(def: { kind: string; opaque?: boolean }): boolean {
  return def.opaque ?? isWallKind(def.kind);
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
     * The painted ground MASKS for this area (D-585, re-cut by D-587/D-588),
     * under `client/public/textures/painted/`.
     *
     * ⚠ An IMAGE, not a property of each tile. The first cut of this hung a
     * material off the tile legend, which made painting "assign a character to
     * a square" — cheap to store and wrong for the job: a tile-based floor can
     * only ever have square edges, and what a person painting ground wants is
     * a brush that goes where they put it and blends where two surfaces meet.
     *
     * ⚠ A LIST, because one mask holds three materials and a town wants more
     * (D-588). It was a single string while three was the ceiling; the list is
     * one entry per mask, in mask order, and the renderer pairs mask 0 with
     * `groundMaterials[0..2]` and mask 1 with `[3..5]`. Reordering it swaps
     * half a map's materials with the other half.
     *
     * ⚠ The image carries WEIGHTS, not colours (D-587). Baking each material's
     * texture into the painted image was argued from the palette quantiser
     * throwing the detail away; D-586 removed the quantiser and voided the
     * argument, and the measured cost was a thirteenfold downsample of every
     * surface before a frame was drawn.
     *
     * Absent means unpainted, which is every area until somebody paints one.
     */
    groundPaint: z.array(z.string().min(1)).max(GROUND_MASKS).optional(),
    /**
     * Which material owns each channel of the painted masks (D-587, D-588).
     *
     * ⚠ ORDER IS THE DATA. The first mask's red channel means "this much of
     * `groundMaterials[0]`" and nothing else — reorder the list and a map
     * repaints itself with grass where the gravel was, silently and
     * everywhere. It is written by the editor and read by the renderer; a
     * person editing it by hand is editing the painting.
     *
     * ⚠ At most SIX: three weights per mask across two masks. Three per mask
     * rather than four because the mask's alpha carries coverage — a 2D canvas
     * premultiplies, so a weight stored in alpha reads back as an empty mask.
     * Removing a material COMPACTS this list, and the editor moves the painted
     * weights to match; dropping an entry by hand shifts every material after
     * it onto somebody else's paint.
     */
    groundMaterials: z.array(ContentIdSchema).max(GROUND_MATERIAL_LIMIT).default([]),
    /**
     * Is this map part of a real game loop, or a place to test things?
     *
     * ⚠ A map a player can reach and a map that exists to exercise a bot
     * are different kinds of object, and nothing in a file said which was
     * which. `proving-ground` and `round-town` parse identically, so every
     * question that matters — is this reachable, is it dressed, has anybody
     * walked it — had to be answered by recognising the name.
     *
     * ⚠ Defaults to FALSE, the same direction as `outdoor` above and for
     * the same reason: a map opts IN to being real. Forgetting it on a live
     * map understates what is shipping, which someone notices the moment they
     * look for their map and it says test. The opposite default quietly
     * promotes every scratch map somebody makes to part of the game, which is
     * the failure nobody sees.
     *
     * It gates nothing today. It is a statement of intent that the editor
     * shows and a person can trust — deliberately not a switch that changes
     * behaviour, because a flag that silently alters how an area plays is how
     * a test map starts behaving differently from the thing it was testing.
     */
    live: z.boolean().default(false),
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
    /**
     * Pack meshes placed on the grid (D-566): walls, houses, trees out of
     * `content/assets`. Separate from `props` because a prop's shape is built
     * from code and an asset's comes from a vendor file — and because a prop
     * type is a closed enum of 44 while this reaches 1,402.
     */
    assets: z.array(PlacedAssetSchema).default([]),
    /**
     * Where a body may be, in metres (D-567).
     *
     * ⚠ OPTIONAL, and that is the migration plan rather than an oversight.
     * An area without one gets a layer derived from its tile grid by
     * `areaCollision`, so the continuous rules run everywhere from the day
     * they land and re-cutting an area by hand is an improvement rather than a
     * prerequisite. When every area carries one, the tile fields go and this
     * becomes required.
     */
    collision: CollisionLayerSchema.optional(),
    /**
     * The edge of the map, as a polygon in metres (D-567).
     *
     * ⚠ This is what lets an area stop being a RECTANGLE. Its extent was
     * `width × height` enforced by arithmetic, so every area was a rectangle
     * whether the place was one or not — a cave mouth, a river bank and a road
     * leaving town at an angle were all unexpressible. Absent means the
     * rectangle, so nothing has to be re-authored to keep working.
     *
     * ⚠ It does NOT change `width`/`height`, which still size the tile grid
     * and the navigation index. Shrinking the bounds inside them is legal and
     * useful; drawing them OUTSIDE simply has no effect, because there is no
     * floor out there to stand on.
     */
    bounds: z.array(Vec2Schema).min(3).optional(),
    /**
     * Which floor of the dungeon this is, if any (D-535). Floors open on
     * successive round-days and the entrance seals at dusk.
     */
    dungeonFloor: z.number().int().min(1).optional(),
    /**
     * Crafting and facility stations (D-530). Real placed objects rather
     * than "you are in the town", so a recipe can require the workshop and
     * mean it — and so the antagonist has something specific to stand next
     * to, or to poison.
     */
    stations: z
      .array(
        z.object({
          x: z.number().int().min(0),
          y: z.number().int().min(0),
          type: StationTypeSchema,
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
    /**
     * Roofed tiles (D-545). A roof is PAINTED as a footprint and its shape is
     * derived: contiguous tiles form a region, and the region gets a pitch
     * with its ridge along the longer axis. That is why this is a list of
     * tiles rather than a list of buildings — you paint where the roof is and
     * the geometry follows, so a room that grows by two tiles does not need
     * its roof re-authored.
     *
     * Roofs are pure presentation: they never block movement, never block
     * line of sight, and the server does not read them. A roof that changed
     * what a witness could see would be a rendering decision quietly editing
     * D-217, which is the sort of coupling this project keeps refusing.
     */
    roofs: z
      .array(
        z.object({
          x: z.number().int().min(0),
          y: z.number().int().min(0),
          /** Material, matching the wall families. */
          style: z.enum(['thatch', 'tile', 'slate', 'plank']).default('thatch'),
        }),
      )
      .default([]),
    /**
     * The bed that plays here (D-541), by sound-cue id. Absent means silence
     * — which is a legitimate choice for an area, not an oversight, so it is
     * optional rather than defaulted to something.
     *
     * Deliberately NOT derived from `lighting` or `zone`, for the same reason
     * `outdoor` is not (D-527): a render profile and a danger tier are not the
     * same axis as what a place sounds like, and coupling them means the day
     * somebody wants a quiet cave they have to change how it looks.
     */
    ambience: ContentIdSchema.optional(),
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
    for (const roof of area.roofs) {
      if (roof.x >= area.width || roof.y >= area.height) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `roof at (${roof.x},${roof.y}) is outside the area`,
        });
      }
    }
  });

export type AreaDef = z.infer<typeof AreaSchema>;

/**
 * The area's collision layer, derived when it has not been authored (D-567).
 *
 * ⚠ This is the bridge that lets the runtime move to metres before the eleven
 * authored areas are re-cut. An area with no `collision` block gets one built
 * from its tile grid: the rectangle as bounds, every unwalkable tile as a
 * volume, plus whatever the placed assets contribute. So the same rules run
 * everywhere from the day they land, and migrating an area becomes an
 * improvement rather than a prerequisite.
 *
 * ⚠ Unwalkable tiles are merged into horizontal RUNS before becoming volumes.
 * A 100×100 dungeon is around four thousand blocked tiles, and `canOccupy` is
 * linear in volumes — one volume per tile would put four thousand shape tests
 * inside every step of every path. Runs cut that by an order of magnitude and
 * are exact, not an approximation.
 *
 * ⚠ Memoised on the area OBJECT, so an edited area rebuilds only when it is
 * re-parsed. A cache keyed by `area.id` would serve a stale layer to the
 * editor after every save.
 */
const derived = new WeakMap<AreaDef, CollisionLayer>();

export function areaCollision(area: AreaDef): CollisionLayer {
  if (area.collision) return area.collision;
  const hit = derived.get(area);
  if (hit) return hit;

  const volumes = [];
  for (let y = 0; y < area.height; y++) {
    let run = -1;
    for (let x = 0; x <= area.width; x++) {
      const def = x < area.width ? area.legend[area.tiles[y]![x]!]! : undefined;
      const blocked = def !== undefined && !def.walkable;
      if (blocked && run < 0) run = x;
      if (!blocked && run >= 0) {
        // Tiles are unit squares whose CENTRE is the integer coordinate, so a
        // run from x0 to x1 spans x0-0.5 to x1+0.5. Getting that half-metre
        // wrong shifts every wall in the world by half its thickness.
        const w = x - run;
        volumes.push({
          shape: { kind: 'rect' as const, x: run + w / 2 - 0.5, y, w, h: 1, rotation: 0 },
          base: 0,
          top: 3,
          walkable: false,
          opaque: isTileOpaque(area.legend[area.tiles[y]![run]!]!),
          sightTop: undefined,
          ramp: undefined,
        });
        run = -1;
      }
    }
  }
  volumes.push(...assetVolumes(area.assets as PlacedAsset[]));

  const layer = CollisionLayerSchema.parse({
    // ⚠ Half a metre out from the tile centres, for the same reason as above:
    // tile 0 reaches to -0.5, and bounds drawn at 0 would make the whole first
    // row unstandable. An authored polygon replaces it outright (D-567).
    bounds: area.bounds ?? [
      { x: -0.5, y: -0.5 },
      { x: area.width - 0.5, y: -0.5 },
      { x: area.width - 0.5, y: area.height - 0.5 },
      { x: -0.5, y: area.height - 0.5 },
    ],
    volumes,
  });
  derived.set(area, layer);
  return layer;
}

/**
 * Whether a body may stand at a point, in metres (D-567).
 *
 * This is what `isTileWalkable` becomes. It is kept beside it rather than
 * replacing it in one commit because nineteen range checks, the pathfinder and
 * CI's flood all still speak tiles, and converting them together would leave
 * nothing testable in between.
 */
export function canStandAt(area: AreaDef, p: Vec2, z = 0, radius = BODY_RADIUS): boolean {
  return canOccupy(areaCollision(area), p, z, radius);
}

/** Whether anything opaque stands between two points, in metres (D-217, D-567). */
export function sightBlockedIn(area: AreaDef, a: Vec2, b: Vec2): boolean {
  return sightBlocked(areaCollision(area), a, b);
}

export function isTileWalkable(area: AreaDef, pos: Vec2): boolean {
  if (pos.x < 0 || pos.y < 0 || pos.x >= area.width || pos.y >= area.height) return false;
  const ch = area.tiles[pos.y]![pos.x]!;
  if (!area.legend[ch]!.walkable) return false;
  // ⚠ And the same for a placed pack mesh — but asked of the COLLISION layer
  // now, not of a baked rectangle (D-567). A tile counts as walkable if a body
  // can stand at its centre, which is what finally lets a door frame cover a
  // tile without sealing it.
  return canOccupy(areaCollision(area), pos, 0);
}

/**
 * Whether anything standing on this tile stops a line of sight (D-217).
 *
 * ⚠ Terrain opacity alone is not enough once buildings are placed as assets: a
 * murder behind a house would be witnessed through it, and who saw what is the
 * whole of the reputation system.
 */
export function tileHidesSight(area: AreaDef, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= area.width || y >= area.height) return false;
  if (isTileOpaque(area.legend[area.tiles[y]![x]!]!)) return true;
  // Asked of the placed assets' VOLUMES at eye height (D-567), so an arch you
  // see under no longer hides what is beyond it. A degenerate segment is a
  // point test, which is exactly the question this function asks.
  const at = { x, y };
  return sightBlocked(
    { bounds: areaCollision(area).bounds, volumes: assetVolumes(area.assets as PlacedAsset[]) },
    at,
    at,
  );
}

/**
 * Item categories per D-210: every item is exactly one of these. "Recipe
 * input" is not a category — it is a property conferred by appearing in a
 * recipe, which the orphan validator (M5) will check graph-wide.
 */
export const ITEM_CATEGORIES = [
  'base_material',
  'equipment',
  'consumable',
  'valuable',
] as const;
export const ItemCategorySchema = z.enum(ITEM_CATEGORIES);

/** `#rrggbb`. Anywhere a colour is authored, it is checked the same way. */

export const ItemTemplateSchema = z.object({
  id: ContentIdSchema,
  name: z.string().min(1),
  description: z.string().min(1),
  category: ItemCategorySchema,
  stackable: z.boolean().default(false),
  /** Reference value in coin for telemetry/vendor floors (D-221). Not a price. */
  value: z.number().int().min(0),
  /**
   * What eating or drinking this relieves (D-526). Absent for everything that
   * is not a meal — the orphan check treats consumables as terminal, so this
   * is what distinguishes "a thing you use" from "a thing you eat".
   */
  nourishes: z.enum(['hunger', 'thirst']).optional(),
  /**
   * What USING it does (D-554). A closed enum, for the same reason feats
   * declare their mechanics from one (D-538): an item whose description
   * implies a use nobody wired is the commonest way a content-driven game
   * lies to its players.
   *
   *   mend   restores health, and closes one minor wound
   *
   * Eating and drinking are NOT here — `nourishes` already says that, and
   * having two fields able to describe a loaf would let them disagree.
   */
  use: z
    .object({
      kind: z.enum(['mend']),
      value: z.number().int().min(1).max(50),
    })
    .optional(),
  /**
   * What this item LOOKS like (D-566).
   *
   * ⚠ The point of the split. Many items share one mesh and differ only in
   * colour and numbers — a rusted shortsword and a fine one are the same
   * geometry twice — so an item POINTS AT an asset rather than owning one.
   * The asset carries how it is held, which bone, which animation stance; the
   * item carries which asset, what colour, and what it is worth.
   *
   * `swaps` are exact colour substitutions against the pack's atlas, the same
   * mechanism `skinPalette` uses (D-560) and safe for the same reason: every
   * UV island sits inside one flat region, so NEAREST filtering keeps a
   * substitution clean. A worn item samples three to seven colours (measured),
   * which is why recolouring one is a handful of entries and not a texture.
   *
   * Absent for anything with no appearance of its own — a note, an ore.
   */
  art: z
    .object({
      pack: z.string().min(1),
      /** The asset id in `content/assets/<pack>.character-item.json`. */
      asset: ContentIdSchema,
      swaps: z
        .array(z.object({ from: HexColourSchema, to: HexColourSchema }))
        .default([]),
    })
    .optional(),
  /**
   * The garment this item puts ON a body (D-562, D-570).
   *
   * ⚠ The counterpart to `art` and NOT a duplicate of it. `art` names a
   * character-item — a thing held in a fist, which the rig attaches to a
   * bone. Armour is not attached to anything: it REPLACES body meshes,
   * because there is essentially no bare body in this pack and a breastplate
   * layered over a torso would sit over a shirt nobody can take off (D-560).
   * So a sword points at an asset and a hauberk points at a garment.
   *
   * ⚠ It is also where `equip.material` is going to come from. D-566 put the
   * material on the item under protest — "declared on the ITEM, which is a
   * compromise and should not outlive the garment editor" — because there was
   * nowhere else for it. `garmentMaterial` derives it from the parts, which
   * were tagged by measuring their pixels, and CI refuses an item whose
   * declared material disagrees with the garment it names. The declared field
   * can be dropped once every armour item names a garment.
   */
  garment: ContentIdSchema.optional(),
  /**
   * What wearing or wielding this is worth (D-547). Absent for everything
   * that is not gear — which is the same distinction `nourishes` draws for
   * food, and for the same reason: the presence of the field, not a guess at
   * the category, is what tells the pack which verbs an item offers.
   */
  equip: EquipStatsSchema.optional(),
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
  /**
   * What this calling may WEAR, WIELD and BE (D-566).
   *
   * ⚠ One rule for all three: an EMPTY list means unrestricted. That is what
   * makes adding these safe — the nine classes authored before they existed
   * carry none of them, parse to `[]`, and therefore behave exactly as they
   * did. Authoring is narrowing from everything, never opening up from
   * nothing, so a half-finished class is permissive rather than unplayable.
   *
   * ⚠ This is ACCESS, not power (D-207 → D-522). Telling a magus they may not
   * wear plate takes an option away from them; it does not make the man-at-arms
   * hit harder. A gate that granted a bonus for obeying it would be the
   * mechanical reward for virtue D-303 forbids.
   *
   * `armour` reads the material tags on character parts, `weapons` reads the
   * `stance` every worn item declares, and `races` names race ids.
   */
  armour: z.array(z.enum(ARMOUR_MATERIALS)).default([]),
  weapons: z.array(StanceSchema).default([]),
  races: z.array(ContentIdSchema).default([]),
  /** Specific item templates this calling may use, beyond the broad gates. */
  items: z.array(ContentIdSchema).default([]),
  /**
   * Where this calling would put its ten creation points (D-566).
   *
   * ⚠ THIS CROSSES D-546, WHICH IS RATIFIED. That decision gives every calling
   * the same start — 10 in each attribute with 10 to place — precisely because
   * "a class is access and options (D-208) and not a stat block", and because
   * a class that opened three points of vigor ahead makes the round's social
   * problem arithmetic instead of deception (D-522).
   *
   * So this is authored data that NOTHING READS. The server still hands every
   * character the same start, and will keep doing so until the stakeholder
   * ratifies a superseding decision. Two readings are open and they are very
   * different: a SUGGESTED allocation the creation screen pre-fills and the
   * player may change (compatible with D-546, the same role `affinities`
   * plays for skills), or a MANDATED one (a supersession). Written as data
   * either way; which it means is not mine to decide.
   */
  startingAttributes: z.record(z.enum(ATTRIBUTES), z.number().int().min(0).max(10)).default({}),
  /**
   * What the class gains as it levels (D-538). Grants are AUTOMATIC and
   * fixed: there is no level-up wizard, because a class's identity deepening
   * on a known schedule is legible to everyone at the table — "a physician
   * has field surgery by four" is a thing players can plan around, and a
   * grab-bag of per-character choices is not.
   *
   * The hard rule, enforced in CI: a step may not grant a `creationOnly`
   * skill (that is where `arms` lives), and may not grant a feat below its
   * own `minLevel`. Levels buy access and options, never raw power
   * (D-207 → D-522 → D-538).
   */
  progression: z
    .array(
      z.object({
        level: z.number().int().min(2).max(MAX_LEVEL),
        /** Points ADDED to whatever creation allocated. */
        skills: z.record(ContentIdSchema, z.number().int().min(0)).default({}),
        feats: z.array(ContentIdSchema).default([]),
        spells: z.array(ContentIdSchema).default([]),
        abilities: z.array(ClassAbilitySchema).default([]),
        /** One line shown on the calling card — what this level feels like. */
        note: z.string().min(1),
      }),
    )
    .default([]),
  /**
   * What this calling walks into a round holding (D-547). Everyone gets a
   * kit, and the kits are deliberately close in total worth: the round is a
   * social game, and a calling that started three tiers of armour ahead
   * would make the antagonist's problem arithmetic instead of deception.
   *
   * Items here count as CONSUMED for the D-210 orphan graph — a starting kit
   * is a consumer, and the validator knows it.
   */
  startingKit: z.array(StartingKitEntrySchema).default([]),
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
  /**
   * May be allocated at creation but NEVER granted by a level (D-538). This
   * is the fence around raw power: every character buys its `arms` out of
   * the same creation budget, so a hundred-round veteran swings no harder
   * than a first-timer who spent the points. The validator rejects any class
   * progression that grants one of these.
   */
  creationOnly: z.boolean().default(false),
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
  /**
   * What the feat actually DOES, if anything (D-538). A closed enum, because
   * the alternative — a feat whose text implies a mechanic that was never
   * wired — is the single most common way a content-driven game lies to its
   * players. The server knows every kind here; CI asserts that it does, and
   * a feat with no `effect` is DECLARING itself flavour rather than hiding
   * that it is.
   *
   *   carry          capacity, on the same scale as athletics
   *   craft_speed    fraction of crafting time removed (0.15 = 15% faster)
   *   harvest_speed  the same, for gathering
   *   hunger_rate    fraction longer between hunger steps
   *   thirst_rate    the same, for thirst
   *   treat_bonus    health restored when treating someone's wound
   *   zombie_cap     concurrent animated dead, still under the hard cap of 3
   *   extra_attack   additional swings in a four-second combat round (D-550)
   */
  effect: z
    .object({
      kind: z.enum([
        'carry',
        'craft_speed',
        'harvest_speed',
        'hunger_rate',
        'thirst_rate',
        'treat_bonus',
        'zombie_cap',
        'extra_attack',
      ]),
      value: z.number(),
    })
    .optional(),
  /**
   * The earliest character level that may hold this feat (D-538). Anything
   * above 1 is unpickable at creation and arrives only through a class's
   * progression table — which is what stops the strong verbs being front-
   * loaded onto a brand-new character.
   */
  minLevel: z.number().int().min(1).max(MAX_LEVEL).default(1),
});
export type FeatDef = z.infer<typeof FeatSchema>;
/** The mechanics a feat may declare. The server implements every one. */
export type FeatEffectKind = NonNullable<FeatDef['effect']>['kind'];
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
 * Sound cues (D-541). Content, like everything else (D-110): which file plays
 * for which action is a data change, and the client renders whatever this
 * says.
 *
 * A cue is a set of FILES, not a file, because variety is what stops a
 * repeated sound becoming a joke — five hurt takes and nineteen death cries
 * are already in the drop. `split` marks a file that holds several takes with
 * silence between them; the client separates them at load (D-541 explains why
 * that is not done offline) and treats every take as another variant.
 *
 * `status: 'planned'` follows the convention objectives already use: the cue
 * is authored and validated, and nothing plays it, because the action it
 * belongs to does not exist yet. That is preferable to wiring it to a
 * near-miss action, which would be the audio version of a feat whose text
 * implies a mechanic nobody built (D-538).
 */
export const SoundCueSchema = z.object({
  id: ContentIdSchema,
  /**
   * Sets the loudness target the client normalises to (shared/src/audio.ts):
   * effects must cut through, beds must not compete with a death cry.
   */
  kind: z.enum(['effect', 'ambience', 'music']),
  /** Paths under client/public/audio. The validator checks they exist. */
  files: z.array(z.string().min(1)).min(1),
  /** Several takes in one file, separated by silence. */
  split: z.boolean().default(false),
  /** Applied AFTER normalisation, for a cue that should sit lower than its
   * category. 1 is "exactly the category target". */
  trim: z.number().min(0).max(4).default(1),
  /** 'planned' cues are never played — the action does not exist yet. */
  status: z.enum(['live', 'planned']).default('live'),
  /** What it is for, in words, so the manifest reads as documentation. */
  description: z.string().min(1),
});
export type SoundCueDef = z.infer<typeof SoundCueSchema>;
export const SoundsFileSchema = z.array(SoundCueSchema);

/**
 * A character build as submitted at creation. The client assembles one and
 * the SERVER re-validates it against content before anything is written —
 * the client never determines what is legal (D-102).
 */
/** Attribute ids, as a schema, so a typo in a build is a parse failure. */
export const AttributeIdSchema = z.enum(ATTRIBUTES);

export const CharacterBuildSchema = z.object({
  /**
   * Attribute TOTALS after allocation (D-546) — base 10 plus whatever the
   * player placed. Totals rather than deltas because that is what the screen
   * shows and what the player thinks they are choosing; the delta is trivially
   * recovered and a screen that disagrees with its own numbers is worse.
   *
   * Omitted entirely by bots and by anything predating the step, which then
   * reads as a straight 10/10/10/10 — exactly the old character.
   */
  attributes: z
    .record(AttributeIdSchema, z.number().int().min(ATTRIBUTE_BASE).max(ATTRIBUTE_MAX))
    .default({}),
  /** skill id → points allocated at creation. */
  skills: z.record(ContentIdSchema, z.number().int().min(0)).default({}),
  feats: z.array(ContentIdSchema).default([]),
  spells: z.array(ContentIdSchema).default([]),
});

/**
 * The stored record of a player's level-up spending (D-546). Shapes only —
 * legality is `validateAdvances`, which needs the content catalogue and the
 * character's level and therefore cannot live in a schema.
 */
export const CharacterAdvancesSchema = z.object({
  attributes: z.record(AttributeIdSchema, z.number().int().min(0)).default({}),
  skills: z.record(ContentIdSchema, z.number().int().min(0)).default({}),
  feats: z.array(ContentIdSchema).default([]),
  spells: z.array(ContentIdSchema).default([]),
});
export type CharacterBuild = z.infer<typeof CharacterBuildSchema>;
/**
 * What a caller may hand the validator: the same shape with every field
 * optional. Deliberately the INPUT type rather than the parsed one — the
 * client assembles a build a step at a time and would otherwise have to
 * invent empty records for steps the player has not reached.
 */
export type CharacterBuildInput = z.input<typeof CharacterBuildSchema>;

/**
 * Creation budget (UNRATIFIED — first-pass numbers, flagged for the
 * stakeholder). Skills use the same 0–100 scale as the pre-existing
 * bluff/insight/necromancy so every mechanic already written keeps working:
 * necromancy 40 at creation buys a second zombie (D-511), which is the
 * intended ceiling for a starting specialist.
 */
export const CREATION_ATTRIBUTE_POINTS = ATTRIBUTE_CREATION_POINTS;
export const CREATION_ATTRIBUTE_MAX = ATTRIBUTE_CREATION_MAX;
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
  input: CharacterBuildInput,
): string[] {
  const build = {
    attributes: input.attributes ?? {},
    skills: input.skills ?? {},
    feats: input.feats ?? [],
    spells: input.spells ?? [],
  };
  const errors: string[] = [];
  const cls = content.classes.find((c) => c.id === classId);
  if (!cls) {
    errors.push(`unknown class '${classId ?? ''}'`);
    return errors; // everything below is class-relative
  }

  errors.push(...validateAttributeAllocation(build.attributes));

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
    // Levelled feats are granted by the class, never picked at creation
    // (D-538) — a new character has no level to spend.
    if (feat.minLevel > 1) {
      errors.push(`${feat.name} is earned at level ${feat.minLevel}, not chosen`);
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

/**
 * Level-up legality (D-546). The counterpart to `validateBuild`, and the one
 * place the rules live — the client renders a screen from it, the server
 * enforces it, and neither has a copy of its own (D-102).
 *
 * `advances` is the WHOLE record after the player's edit, not a delta. That
 * makes the check idempotent and makes a replayed or duplicated submission
 * harmless, which matters because the screen is shown at the end of a round
 * when connections are being torn down and re-established.
 *
 * The fences, each inherited rather than invented here:
 *   - a `creationOnly` skill can never be raised (D-538 — this is where
 *     `arms` lives, and it is the reason a veteran does not swing harder);
 *   - a feat below its own `minLevel` is not pickable, and a feat the class
 *     is barred from is not pickable at any level;
 *   - only a spellcasting class may hold spells;
 *   - nothing may exceed the cumulative budget for the character's level.
 */
export function validateAdvances(
  content: BuildContent,
  classId: string | undefined,
  level: number,
  base: { skills?: Record<string, number> },
  advances: CharacterAdvances,
): string[] {
  const errors: string[] = [];
  const cls = content.classes.find((c) => c.id === classId);
  if (!cls) {
    errors.push(`unknown class '${classId ?? ''}'`);
    return errors;
  }
  const budget = advancementBudget(level, cls.spellcasting);

  let attrSpent = 0;
  for (const [id, points] of Object.entries(advances.attributes)) {
    if (!(ATTRIBUTES as readonly string[]).includes(id)) {
      errors.push(`unknown attribute '${id}'`);
      continue;
    }
    if (points < 0) errors.push(`${id} cannot be reduced`);
    attrSpent += points;
  }
  if (attrSpent > budget.attributePoints) {
    errors.push(`attribute points overspent: ${attrSpent} of ${budget.attributePoints}`);
  }

  let skillSpent = 0;
  for (const [id, points] of Object.entries(advances.skills)) {
    const skill = content.skills.find((s) => s.id === id);
    if (!skill) {
      errors.push(`unknown skill '${id}'`);
      continue;
    }
    // The fence around raw power (D-538). Every character buys its `arms` out
    // of the same creation budget, so a hundred-round veteran swings no
    // harder than a first-timer who spent the points.
    if (skill.creationOnly) {
      errors.push(`${skill.name} is chosen at creation and never earned`);
      continue;
    }
    if (points < 0) errors.push(`${skill.name} cannot be reduced`);
    const total = (base.skills?.[id] ?? 0) + points;
    if (total > SKILL_CEILING) {
      errors.push(`${skill.name} would exceed the ceiling of ${SKILL_CEILING}`);
    }
    skillSpent += points;
  }
  if (skillSpent > budget.skillPoints) {
    errors.push(`skill points overspent: ${skillSpent} of ${budget.skillPoints}`);
  }

  if (advances.feats.length > budget.feats) {
    errors.push(`too many feats: ${advances.feats.length} of ${budget.feats}`);
  }
  if (new Set(advances.feats).size !== advances.feats.length) errors.push('duplicate feat');
  for (const id of advances.feats) {
    const feat = content.feats.find((f) => f.id === id);
    if (!feat) {
      errors.push(`unknown feat '${id}'`);
      continue;
    }
    if (feat.classes.length > 0 && !feat.classes.includes(cls.id)) {
      errors.push(`${cls.name} cannot take ${feat.name}`);
    }
    if (feat.minLevel > level) {
      errors.push(`${feat.name} is earned at level ${feat.minLevel}`);
    }
    for (const [skillId, min] of Object.entries(feat.requiresSkills)) {
      const held = (base.skills?.[skillId] ?? 0) + (advances.skills[skillId] ?? 0);
      if (held < min) {
        const skill = content.skills.find((s) => s.id === skillId);
        errors.push(`${feat.name} requires ${skill?.name ?? skillId} ${min}`);
      }
    }
  }

  if (!cls.spellcasting && advances.spells.length > 0) {
    errors.push(`${cls.name} does not cast spells`);
  } else {
    if (advances.spells.length > budget.spells) {
      errors.push(`too many spells: ${advances.spells.length} of ${budget.spells}`);
    }
    if (new Set(advances.spells).size !== advances.spells.length) errors.push('duplicate spell');
    for (const id of advances.spells) {
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
