import { describe, expect, it } from 'vitest';
import type { WireItem } from '@rc/shared';
import {
  formatEffort,
  itemName,
  packRows,
  recipeStatus,
  type CatalogueItem,
  type CatalogueRecipe,
} from '../src/game/pack';

/**
 * The pack and workbench arithmetic (MR2), tested headlessly.
 *
 * This is advisory UI — the server decides whether a craft succeeds and
 * re-checks on completion (D-102). It is worth testing anyway, because a
 * greyed-out button that disagrees with the server is worse than no button:
 * the player is told they cannot do something they can, and stops trying.
 */

const ITEMS: CatalogueItem[] = [
  { id: 'iron-ore', name: 'Iron Ore', description: '', category: 'base_material', stackable: true },
  { id: 'rough-timber', name: 'Rough Timber', description: '', category: 'base_material', stackable: true },
  { id: 'bitterleaf', name: 'Bitterleaf', description: '', category: 'base_material', stackable: true },
];

const item = (templateId: string, qty: number, equipped: WireItem['equipped'] = null): WireItem => ({
  id: `00000000-0000-4000-8000-${templateId.slice(0, 12).padEnd(12, '0')}`,
  templateId,
  qty,
  equipped,
});

const HATCHET: CatalogueRecipe = {
  id: 'iron-hatchet',
  name: 'Forge a hatchet',
  output: 'iron-hatchet',
  outputQuantity: 1,
  inputs: [{ item: 'iron-ore', quantity: 2 }, { item: 'rough-timber', quantity: 1 }],
  station: 'workshop',
  effortTicks: 90,
};

const BANDAGE: CatalogueRecipe = {
  id: 'bandage',
  name: 'Boil a bandage',
  output: 'bandage',
  outputQuantity: 2,
  inputs: [{ item: 'bitterleaf', quantity: 1 }],
  station: 'anywhere',
  effortTicks: 40,
};

describe('the pack', () => {
  it('collapses stacks, because a player thinks in "four ore"', () => {
    // The wire sends stacks as separate rows; showing them that way would be
    // technically accurate and useless.
    const rows = packRows([item('iron-ore', 3), item('iron-ore', 1)], ITEMS);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.qty).toBe(4);
    expect(rows[0]!.name).toBe('Iron Ore');
  });

  it('sorts by name, not by arrival', () => {
    const rows = packRows([item('rough-timber', 1), item('bitterleaf', 1), item('iron-ore', 1)], ITEMS);
    expect(rows.map((r) => r.name)).toEqual(['Bitterleaf', 'Iron Ore', 'Rough Timber']);
  });

  it('falls back to the id for anything the catalogue does not know', () => {
    // Better an ugly id than a blank row: content can outrun a stale client.
    expect(itemName(ITEMS, 'mystery-thing')).toBe('mystery-thing');
    expect(packRows([item('mystery-thing', 2)], ITEMS)[0]!.name).toBe('mystery-thing');
  });

  it('is empty rather than broken with nothing held', () => {
    expect(packRows([], ITEMS)).toEqual([]);
  });
});

describe('what can be made', () => {
  it('counts held materials across stacks', () => {
    const status = recipeStatus(HATCHET, [item('iron-ore', 1), item('iron-ore', 1), item('rough-timber', 1)], ITEMS, true);
    expect(status.hasMaterials).toBe(true);
    expect(status.canAttempt).toBe(true);
    expect(status.costs.every((c) => !c.short)).toBe(true);
  });

  it('marks exactly which input is short, not just that something is', () => {
    const status = recipeStatus(HATCHET, [item('iron-ore', 2)], ITEMS, true);
    expect(status.hasMaterials).toBe(false);
    const timber = status.costs.find((c) => c.templateId === 'rough-timber')!;
    expect(timber.short).toBe(true);
    expect(timber.have).toBe(0);
    expect(timber.need).toBe(1);
    // And the input that IS satisfied must not be flagged — a panel that
    // reddens everything tells the player nothing about what to go and get.
    expect(status.costs.find((c) => c.templateId === 'iron-ore')!.short).toBe(false);
  });

  it('blocks a station recipe away from the town, materials or not (D-530)', () => {
    const held = [item('iron-ore', 2), item('rough-timber', 1)];
    const away = recipeStatus(HATCHET, held, ITEMS, false);
    expect(away.hasMaterials).toBe(true); // the materials are fine…
    expect(away.atStation).toBe(false); // …but the workshop is not here
    expect(away.canAttempt).toBe(false);
  });

  it("lets an 'anywhere' recipe run in the field", () => {
    const status = recipeStatus(BANDAGE, [item('bitterleaf', 1)], ITEMS, false);
    expect(status.atStation).toBe(true);
    expect(status.canAttempt).toBe(true);
  });

  it('treats an exact count as enough, not as short', () => {
    // Off-by-one here would tell a player with exactly the right materials
    // that they cannot build the thing they can build.
    const status = recipeStatus(BANDAGE, [item('bitterleaf', 1)], ITEMS, true);
    expect(status.costs[0]!.short).toBe(false);
    expect(status.canAttempt).toBe(true);
  });
});

describe('effort', () => {
  it('reads in seconds at the 10Hz tick', () => {
    expect(formatEffort(90)).toBe('9s');
    expect(formatEffort(40)).toBe('4s');
    expect(formatEffort(3)).toBe('1s'); // never "0s"
  });
});
