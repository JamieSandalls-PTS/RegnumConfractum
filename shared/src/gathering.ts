import { z } from 'zod';
import { ContentIdSchema } from './content';

/**
 * Gathering and crafting (MR2, D-521). The loop that gives the cross map its
 * reason to exist: each spoke yields something the others do not, nobody can
 * cover four spokes in twenty-five minutes, so the cast must divide the work
 * and trust each other to come back with what they promised (D-529).
 *
 * Both are content (D-110). Nodes and recipes are data, validated in CI, and
 * the orphan check (D-210, invariant 2) runs over the graph they form: a base
 * material that no recipe consumes is a build failure, not a curiosity.
 */

// ---------------------------------------------------------------------------
// Resource nodes
// ---------------------------------------------------------------------------

export const ResourceNodeSchema = z
  .object({
    id: ContentIdSchema,
    /** What an observer sees. Nodes have no identity mechanics — a vein is a
     * vein to everyone, unlike a person (D-219). */
    descriptor: z.string().min(1),
    /** The item template a successful harvest yields. */
    yields: ContentIdSchema,
    /** How many of it, per harvest. */
    quantity: z.number().int().min(1).default(1),
    /**
     * Ticks of continuous work per harvest. This is the whole reason
     * gathering is dangerous: you are stationary, occupied, and audible-
     * adjacent for a known length of time, which is exactly when someone
     * would choose to be behind you.
     */
    effortTicks: z.number().int().min(1).default(30),
    /** Harvests before the node is spent. */
    charges: z.number().int().min(1).default(3),
    /**
     * Ticks before a spent node refills. Within the round only — everything
     * resets when the round does (D-523's per-round reset).
     */
    respawnTicks: z.number().int().min(1).default(1200),
  })
  .strict();
export type ResourceNodeDef = z.infer<typeof ResourceNodeSchema>;

// ---------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------

/**
 * Where a recipe may be worked. `anywhere` is the field-improvised version;
 * naming a station ties the recipe to the town, which is D-530's trade:
 * the better result is only redeemable where you are not alone.
 */
export const CraftStationSchema = z.enum(['anywhere', 'workshop', 'infirmary', 'storehouse']);
export type CraftStation = z.infer<typeof CraftStationSchema>;

export const RecipeSchema = z
  .object({
    id: ContentIdSchema,
    name: z.string().min(1),
    /** Item produced, and how many. */
    output: ContentIdSchema,
    outputQuantity: z.number().int().min(1).default(1),
    /** Consumed on success. Every entry must name a real item template. */
    inputs: z
      .array(
        z.object({
          item: ContentIdSchema,
          quantity: z.number().int().min(1).default(1),
        }),
      )
      .min(1),
    station: CraftStationSchema.default('anywhere'),
    /** Ticks of work. Interruptible — moving or being struck cancels it. */
    effortTicks: z.number().int().min(1).default(40),
    notes: z.string().optional(),
  })
  .strict();
export type RecipeDef = z.infer<typeof RecipeSchema>;

// ---------------------------------------------------------------------------
// The orphan check (D-210, invariant 2)
// ---------------------------------------------------------------------------

export interface OrphanInput {
  items: { id: string; category: string }[];
  recipes: { output: string; inputs: { item: string }[] }[];
  nodes: { yields: string }[];
  /** What the world's inhabitants carry (D-537) — also a way an item enters
   * the world, and the only way some of them do. */
  loot?: { item: string }[];
  /** Items reachable some other way — objective targets, authored spawns. */
  otherwiseUsed?: string[];
}

/**
 * Every item must have a consumer (D-210). The rule differs by category
 * because "consumed" means different things:
 *
 *   - **base_material** exists to become something else. If no recipe takes
 *     it, it is dead weight in an inventory and a lie in a node's yield.
 *   - **equipment / consumable** are terminal: being worn or used IS the
 *     consumption, so they only need a way to come into existence.
 *   - **valuable** is terminal too — it exists to be carried, stolen and
 *     hoarded (D-225), which is a use.
 *
 * Returns human-readable failures; empty means the graph closes.
 */
export function findOrphans(input: OrphanInput): string[] {
  const consumedByRecipe = new Set<string>();
  const producedByRecipe = new Set<string>();
  for (const r of input.recipes) {
    producedByRecipe.add(r.output);
    for (const i of r.inputs) consumedByRecipe.add(i.item);
  }
  const yielded = new Set([
    ...input.nodes.map((n) => n.yields),
    ...(input.loot ?? []).map((l) => l.item),
  ]);
  const otherwise = new Set(input.otherwiseUsed ?? []);
  const problems: string[] = [];

  for (const item of input.items) {
    if (otherwise.has(item.id)) continue;
    if (item.category === 'base_material') {
      if (!consumedByRecipe.has(item.id)) {
        problems.push(
          `item '${item.id}' is a base material that no recipe consumes — it can be gathered and never used`,
        );
      }
    }
    // Everything must also be OBTAINABLE, or it is content nobody can reach.
    const obtainable = producedByRecipe.has(item.id) || yielded.has(item.id);
    if (!obtainable && item.category === 'base_material') {
      problems.push(`item '${item.id}' is a base material no node yields — nothing can produce it`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Night roamers (D-527, D-529)
// ---------------------------------------------------------------------------

/**
 * What walks the open ground after dusk. Tuned for ATTRITION, per D-529's
 * ruling: individually modest and numerous, so a strong solo player wins the
 * fights and still loses the night — worn down, out of light, unable to carry
 * a haul home. The alternative (a wall that scales with the player) would let
 * veterans out-level the dark, and the buddy system would evaporate for
 * exactly the players who have been here longest.
 *
 * The design consequence this protects is the whole reason roamers exist: if
 * going out alone at night is death, a night errand needs a PARTNER — and
 * your partner may be the antagonist.
 */
export const RoamerSchema = z
  .object({
    id: ContentIdSchema,
    descriptor: z.string().min(1),
    hp: z.number().int().min(1),
    damageMin: z.number().int().min(0),
    damageMax: z.number().int().min(1),
    /** How far it notices a living player, in tiles. */
    aggroTiles: z.number().int().min(1).default(9),
    attackCooldownTicks: z.number().int().min(1).default(12),
    moveCooldownTicks: z.number().int().min(1).default(4),
    /** How many of this kind per qualifying area, each night. */
    perArea: z.number().int().min(0).default(4),
    /**
     * Where this thing lives (D-537).
     *
     *   - `night` — outdoor wilderness, out at dusk and gone by dawn.
     *   - `dungeon` — a named floor, present from the moment the round opens
     *     and never leaving. Underground has no dawn to be driven off by.
     *
     * The two share every line of spawn, hunt, strike and wander code. A
     * dungeon needs a thing that walks towards you and hits you, which is
     * exactly what the night already had; giving it a second implementation
     * would have meant two sets of bugs.
     */
    habitat: z.enum(['night', 'dungeon']).default('night'),
    /** Which dungeon floor, for `habitat: 'dungeon'`. */
    floor: z.number().int().min(1).optional(),
    /** Experience for putting it down. Deeper floors are worth more. */
    xp: z.number().int().min(0).default(10),
    /**
     * What it was carrying. Granted straight to the killer rather than
     * dropped: a pile on the floor of a dungeon nobody can re-enter after
     * dusk is a reward that evaporates, and carrying the haul home yourself
     * is what makes you worth following (D-529).
     */
    loot: z
      .array(
        z.object({
          item: ContentIdSchema,
          quantity: z.number().int().min(1).default(1),
          /** 0..1. Rolled once per kill. */
          chance: z.number().min(0).max(1).default(1),
        }),
      )
      .default([]),
    notes: z.string().optional(),
  })
  .strict()
  .refine((r) => r.damageMax >= r.damageMin, {
    message: 'damageMax must be at least damageMin',
  });
export type RoamerDef = z.infer<typeof RoamerSchema>;

/**
 * How far from any player a roamer may be placed when night falls. Spawning
 * one on top of somebody would be an ambush nobody could have avoided, which
 * is not danger — it is a coin toss.
 */
export const ROAMER_SPAWN_CLEARANCE = 12;
