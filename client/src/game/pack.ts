import type { ServerMessage, WireItem } from '@rc/shared';

/**
 * What the pack holds and what can be made from it (MR2).
 *
 * Pure, and separated from the DOM so it can be tested headlessly (D-114).
 * Everything here is ADVISORY: the server decides whether a craft succeeds
 * and re-checks materials on completion (D-102). This exists so the player
 * is not asked to guess — a greyed-out button that disagrees with the server
 * is worse than no button, so the arithmetic is worth testing.
 */

export type Catalogue = Extract<ServerMessage, { t: 'catalogue' }>;
export type CatalogueItem = Catalogue['items'][number];
export type CatalogueRecipe = Catalogue['recipes'][number];

/** Display name for a template id, falling back to the id itself. */
export function itemName(items: CatalogueItem[], templateId: string): string {
  return items.find((i) => i.id === templateId)?.name ?? templateId;
}

export interface PackRow {
  templateId: string;
  name: string;
  qty: number;
}

/**
 * The pack, collapsed by template and sorted by name. Stacks arrive as
 * separate rows on the wire — a player thinks in "four ore", not in "a stack
 * of three and a stack of one".
 */
export function packRows(inventory: WireItem[], items: CatalogueItem[]): PackRow[] {
  const byTemplate = new Map<string, number>();
  for (const item of inventory) {
    byTemplate.set(item.templateId, (byTemplate.get(item.templateId) ?? 0) + item.qty);
  }
  return [...byTemplate.entries()]
    .map(([templateId, qty]) => ({ templateId, name: itemName(items, templateId), qty }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface RecipeStatus {
  /** Everything the recipe needs, with what is actually held. */
  costs: { templateId: string; name: string; need: number; have: number; short: boolean }[];
  hasMaterials: boolean;
  /** False when the recipe names a station and the player is elsewhere. */
  atStation: boolean;
  /** Both conditions. The server still has the final word. */
  canAttempt: boolean;
}

export function recipeStatus(
  recipe: CatalogueRecipe,
  inventory: WireItem[],
  items: CatalogueItem[],
  inTown: boolean,
): RecipeStatus {
  const held = new Map<string, number>();
  for (const item of inventory) {
    held.set(item.templateId, (held.get(item.templateId) ?? 0) + item.qty);
  }
  const costs = recipe.inputs.map((input) => {
    const have = held.get(input.item) ?? 0;
    return {
      templateId: input.item,
      name: itemName(items, input.item),
      need: input.quantity,
      have,
      short: have < input.quantity,
    };
  });
  const hasMaterials = costs.every((c) => !c.short);
  // Stations are the town, for now: the buildings are authored geometry with
  // no identity of their own yet, and the server agrees (`atStation`). When
  // stations become real objects this must follow the server, not guess.
  const atStation = recipe.station === 'anywhere' || inTown;
  return { costs, hasMaterials, atStation, canAttempt: hasMaterials && atStation };
}

/** Ticks → a short "about 4s" for a recipe's cost in time. */
export function formatEffort(ticks: number, tickRate = 10): string {
  return `${Math.max(1, Math.round(ticks / tickRate))}s`;
}
