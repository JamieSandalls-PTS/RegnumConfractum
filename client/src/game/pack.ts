import {
  EQUIP_SLOTS,
  SLOT_LABELS,
  isTwoHanded,
  slotCandidates,
  type EquipSlot,
  type ServerMessage,
  type WireItem,
} from '@rc/shared';

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

// ---------------------------------------------------------------------------
// The paperdoll (D-547)
// ---------------------------------------------------------------------------

/** One occupied slot, resolved for display. */
export interface DollSlotView {
  slot: EquipSlot;
  label: string;
  /** The item worn there, or null for an empty slot. */
  item: { id: string; templateId: string; name: string } | null;
}

/**
 * The paperdoll, in a fixed order that never changes with what is worn.
 *
 * Fixed rather than "occupied slots first" on purpose: a grid whose cells
 * move when you take a hat off is a grid you have to re-read every time, and
 * the whole value of a paperdoll is that your eye already knows where the
 * chest slot is.
 *
 * A two-handed weapon is shown in BOTH hands, because that is what it is
 * doing. Showing it only in the main hand would leave an empty off-hand slot
 * that silently refuses everything dropped on it.
 */
export function dollSlots(
  inventory: readonly WireItem[],
  items: readonly CatalogueItem[],
): DollSlotView[] {
  const byId = new Map(inventory.map((i) => [i.id, i]));
  return EQUIP_SLOTS.map((slot) => {
    let worn = inventory.find((i) => i.equipped === slot) ?? null;
    if (!worn && slot === 'off-hand') {
      // The two-hander's other half. It is stored in the main hand and it is
      // genuinely occupying this slot as well.
      const main = inventory.find((i) => i.equipped === 'main-hand');
      const stats = main && items.find((it) => it.id === main.templateId)?.equip;
      if (main && stats && isTwoHanded(stats.slot)) worn = byId.get(main.id) ?? null;
    }
    return {
      slot,
      label: SLOT_LABELS[slot],
      item: worn
        ? { id: worn.id, templateId: worn.templateId, name: itemName([...items], worn.templateId) }
        : null,
    };
  });
}

/** Rows for the pack, with what each can be worn as. Worn items are excluded. */
export interface PackGearRow extends PackRow {
  /** An item id that can be equipped, or null when it is not gear. */
  equipItemId: string | null;
  /** Where it would go, for the hint beside the row. */
  slots: EquipSlot[];
  /**
   * An item id that can be USED, or null (D-554). Food, drink and anything
   * declaring a `use` — read off the template, so a new consumable needs no
   * client change.
   */
  useItemId: string | null;
  /** What using it would do, for the button's label. */
  useVerb: string | null;
  /** Any single item id, for dropping. Everything can be dropped. */
  dropItemId: string | null;
}

/**
 * The pack, excluding what is currently worn.
 *
 * Excluding rather than annotating is the point: a sword that is in your hand
 * is not also in your bag, and listing it twice is how a player ends up
 * trying to drop the one they are holding.
 */
export function packGearRows(
  inventory: readonly WireItem[],
  items: readonly CatalogueItem[],
): PackGearRow[] {
  const stowed = inventory.filter((i) => !i.equipped);
  const rows = packRows([...stowed], [...items]);
  return rows.map((row) => {
    const template = items.find((i) => i.id === row.templateId);
    const stats = template?.equip;
    const first = stowed.find((i) => i.templateId === row.templateId);
    // `nourishes` and `use` are the two ways an item declares it can be used
    // (D-554). Neither is inferred from the category: a "consumable" that
    // declares nothing is a crafting input, and offering a button for it
    // would be the lie D-538 refused for feats.
    const verb = template?.nourishes === 'hunger'
      ? 'eat'
      : template?.nourishes === 'thirst'
        ? 'drink'
        : template?.use?.kind === 'mend'
          ? 'bind a wound'
          : null;
    return {
      ...row,
      equipItemId: stats && first ? first.id : null,
      slots: stats ? slotCandidates(stats.slot) : [],
      useItemId: verb && first ? row.templateId : null,
      useVerb: verb,
      dropItemId: first ? first.id : null,
    };
  });
}
