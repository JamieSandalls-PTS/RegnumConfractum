import { z } from 'zod';
import { ARMOUR_MATERIALS } from './characters';
import { type Stance } from './actions';

/**
 * Equipment and the paperdoll (D-547).
 *
 * Two rules shape the whole module and both are consequences of decisions
 * already made rather than new opinions:
 *
 *   1. **Gear is round-scoped power.** Everything here is stripped between
 *      rounds (D-522) and every class is handed a kit at the start, so a
 *      sword that adds damage cannot compound across a career the way an
 *      attribute point can. That is why armour and weapon damage are allowed
 *      to matter more than a level does.
 *
 *   2. **What you wear is public, and recognition does not read it.** The
 *      paperdoll never feeds the descriptor pipeline (D-201/D-219). D-539
 *      already refused authored equipment at creation because a helm chosen
 *      once would be a permanent disguise; the same reasoning applies here in
 *      reverse — equipping a hood must not silently become a presentation
 *      change. Presentation stays its own explicit verb.
 *
 * Pure module. Slot legality and the stat totals are computed identically on
 * both sides, and the server decides (D-102).
 */

/**
 * The slots, in paperdoll order. `both-hands` is NOT a slot a character has —
 * it is what a two-handed item DECLARES, and equipping one fills main-hand
 * and off-hand together. Modelling it as a real slot was the first attempt
 * and it immediately produced the bug where a shield and a greatsword were
 * both worn, because nothing owned the contradiction.
 */
export const EQUIP_SLOTS = [
  'head',
  'chest',
  'hands',
  'legs',
  'feet',
  'cloak',
  'main-hand',
  'off-hand',
  'amulet',
  'ring-left',
  'ring-right',
] as const;
export type EquipSlot = (typeof EQUIP_SLOTS)[number];
export const EquipSlotSchema = z.enum(EQUIP_SLOTS);

/** What an item may declare. `both-hands` and `ring` expand at equip time. */
export const ITEM_SLOTS = [...EQUIP_SLOTS, 'both-hands', 'ring'] as const;
export type ItemSlot = (typeof ITEM_SLOTS)[number];
export const ItemSlotSchema = z.enum(ITEM_SLOTS);

export const SLOT_LABELS: Record<EquipSlot, string> = {
  head: 'Head',
  chest: 'Body',
  hands: 'Hands',
  legs: 'Legs',
  feet: 'Feet',
  cloak: 'Cloak',
  'main-hand': 'Main hand',
  'off-hand': 'Off hand',
  amulet: 'Amulet',
  'ring-left': 'Ring',
  'ring-right': 'Ring',
};

/** Grouping for the paperdoll's three columns. */
export const SLOT_GROUP: Record<EquipSlot, 'clothing' | 'weapon' | 'trinket'> = {
  head: 'clothing',
  chest: 'clothing',
  hands: 'clothing',
  legs: 'clothing',
  feet: 'clothing',
  cloak: 'clothing',
  'main-hand': 'weapon',
  'off-hand': 'weapon',
  amulet: 'trinket',
  'ring-left': 'trinket',
  'ring-right': 'trinket',
};

/**
 * What wearing a thing is worth. Every field is additive and every field is
 * optional, because the alternative — a required stat block on every item —
 * would force a number onto the parchment and the loaf of bread.
 */
export const EquipStatsSchema = z.object({
  slot: ItemSlotSchema,
  /** Subtracted from incoming damage. Never below the floor of 1 (see below). */
  armour: z.number().int().min(0).max(10).default(0),
  /** Added to a blow struck with this weapon. */
  damage: z.number().int().min(0).max(10).default(0),
  /** Added to the mana pool — a staff or a charm is a deeper reserve. */
  mana: z.number().int().min(0).max(30).default(0),
  /**
   * What it costs to lug about, on the same scale as CARRY_BASE_CAPACITY.
   * Plate should be a decision, not a free upgrade.
   */
  weight: z.number().int().min(0).max(60).default(0),
  /**
   * How far this weapon reaches, in tiles (D-550). One is arm's length and is
   * the default, so nothing that is not explicitly a missile weapon gains
   * reach by omission.
   *
   * Anything beyond one tile requires LINE OF SIGHT at the server, or a bow
   * would shoot through the tavern wall — and a witness model built on line
   * of sight (D-217) cannot have a weapon that ignores it.
   */
  range: z.number().int().min(1).max(12).default(1),
  /**
   * What this counts as for a class's armour gate (D-566): plate, leather or
   * cloth. Absent means it is not armour in the gated sense -- a ring, a
   * charm, a weapon -- and the armour gate does not apply to it.
   *
   * WARNING: declared on the ITEM, which is a compromise and should not
   * outlive the garment editor. D-566's principle is that the ASSET owns what
   * a thing is and the item owns which asset, what colour and what it weighs
   * -- and D-566's own material tagging went onto the 720 character PARTS, by
   * measuring their pixels. An armour item will eventually name part swaps
   * (D-562's wardrobe), and its material will be derivable from those parts
   * rather than repeated here. Until that exists there is nowhere else to put
   * it, and a gate nothing can evaluate is not a gate.
   */
  material: z.enum(ARMOUR_MATERIALS).optional(),
});
export type EquipStats = z.infer<typeof EquipStatsSchema>;

/**
 * The damage floor. Armour reduces a blow and can never erase it: an
 * unkillable player in a 25-minute round with no respawn is not a tank, it is
 * a stalemate, and the antagonist would have no answer to it at all.
 */
export const MIN_DAMAGE = 1;

/** Which real slots an item occupies, given a preferred hand for rings. */
export function slotsOccupied(slot: ItemSlot, prefer?: EquipSlot): EquipSlot[] {
  if (slot === 'both-hands') return ['main-hand', 'off-hand'];
  if (slot === 'ring') {
    return [prefer === 'ring-right' ? 'ring-right' : 'ring-left'];
  }
  return [slot];
}

/** Every slot an item is ALLOWED to go in, for the client's drag targets. */
export function slotCandidates(slot: ItemSlot): EquipSlot[] {
  if (slot === 'both-hands') return ['main-hand'];
  if (slot === 'ring') return ['ring-left', 'ring-right'];
  return [slot];
}

/** Is this item two-handed? Two-handers own the off hand and refuse a shield. */
export function isTwoHanded(slot: ItemSlot): boolean {
  return slot === 'both-hands';
}

export interface EquippedItem {
  /** The slot the character is wearing it in. */
  slot: EquipSlot;
  stats: EquipStats;
  /**
   * The garment this item puts on the body (D-570, D-571), if it names one.
   *
   * ⚠ Carried here rather than looked up from an item id because `lookOf` is
   * deliberately keyed off the SLOT and the stats, "so a new sword looks like
   * a sword without anybody registering it anywhere". A garment is the one
   * piece of appearance that cannot be inferred from numbers — which mesh
   * replaces which slot is a decision somebody made by looking (D-562) — so
   * it travels with the item rather than being guessed from it.
   */
  garment?: string;
  /**
   * How holding this makes a character carry themselves (D-565, wired D-578).
   *
   * ⚠ Beside `garment` and for the SAME reason it is here rather than looked
   * up: `lookOf` is keyed off the slot and the stats so a new sword looks like
   * a sword without anybody registering it anywhere — and a stance is the
   * other fact numbers cannot give you. A bow and an arming sword have the
   * same shape of damage and reach; which one is drawn back and which is swung
   * is a decision somebody made when they filed the asset, so it travels with
   * the item.
   */
  stance?: Stance;
}

export interface LoadoutTotals {
  armour: number;
  /** Best single weapon, NOT the sum: dual-wielding must not double damage. */
  damage: number;
  mana: number;
  weight: number;
  /** Reach of the weapon actually being swung. Bare hands are one tile. */
  range: number;
}

/**
 * Adds a worn set up. Armour, mana and weight sum; DAMAGE DOES NOT — a
 * character holding two swords swings one of them, and summing would make
 * dual-wield strictly correct for everyone, which is a build decision nobody
 * made on purpose.
 *
 * A two-handed weapon is counted once even though it fills two slots, which
 * is why the caller must not pass the same item twice.
 */
export function loadoutTotals(worn: readonly EquippedItem[]): LoadoutTotals {
  const totals: LoadoutTotals = { armour: 0, damage: 0, mana: 0, weight: 0, range: 1 };
  const counted = new Set<EquippedItem>();
  let best: EquipStats | null = null;
  for (const item of worn) {
    if (counted.has(item)) continue;
    counted.add(item);
    totals.armour += item.stats.armour;
    totals.mana += item.stats.mana;
    totals.weight += item.stats.weight;
    // Reach travels with the weapon that sets the damage, not separately: a
    // bow in one hand and a dagger in the other must not give a dagger's
    // damage at a bow's reach.
    if (!best || item.stats.damage > best.damage) best = item.stats;
  }
  if (best) {
    totals.damage = best.damage;
    totals.range = best.range;
  }
  return totals;
}

/**
 * What a character LOOKS like it is wearing (D-554).
 *
 * Compact and public on purpose. Everyone can see that you are in mail with a
 * sword out — that is what wearing it means — so this rides on the wire
 * entity like posture and facing do.
 *
 * ⚠ It must NEVER reach the descriptor pipeline (D-201/D-219, restated in
 * D-547). What a stranger is CALLED is a separate question from what they are
 * seen to be carrying, and letting gear feed the descriptor would turn
 * equipping a helm into the permanent disguise D-539 refused.
 */
export interface WornLook {
  helm: boolean;
  /** Shoulder armour: the silhouette of somebody in a real harness. */
  pauldrons: boolean;
  cape: boolean;
  /** A full-length robe rather than a fitted tunic. */
  robe: boolean;
  /** What is actually in hand, if anything. */
  weapon: 'none' | 'sword' | 'staff';
  /**
   * The garments worn, in a canonical order (D-571).
   *
   * ⚠ ORDER IS THE RULE, not an accident of iteration. Two garments can claim
   * one body slot — a hauberk and a cloak both covering the torso — and the
   * last one listed is the one seen. Sorting by the equip-slot vocabulary
   * means every observer resolves the same collision the same way; leaving it
   * to whatever order the store returned would let two clients draw the same
   * person in two different coats.
   */
  garments: string[];
  /**
   * The stance the weapon in hand declares (D-565, wired D-578).
   *
   * ⚠ Public in exactly the way the rest of this silhouette is: how somebody
   * holds a bow is visible at forty paces, and every observer must resolve it
   * identically or two clients animate the same person differently. Absent
   * means empty-handed — the rig's own clips, which is what `unarmed` IS
   * (D-564): the base everything falls through to, never a stance.
   *
   * ⚠ Like the rest of `worn`, it must never reach the descriptor pipeline
   * (D-539, D-547): drawing a bow is not a change of appearance.
   */
  stance?: Stance;
}

export const BARE_LOOK: WornLook = {
  helm: false, pauldrons: false, cape: false, robe: false, weapon: 'none', garments: [],
};

/**
 * Reads a worn set into a silhouette.
 *
 * Keyed off the SLOT and the stats rather than off item ids, so a new sword
 * looks like a sword without anybody registering it anywhere. The one
 * judgement call is armour weight: a chest piece heavy enough to be a harness
 * gets pauldrons, which is what makes a man-at-arms read differently from
 * somebody in a jerkin at forty paces.
 */
export function lookOf(worn: readonly EquippedItem[]): WornLook {
  const look: WornLook = { ...BARE_LOOK, garments: [] };
  let bestWeapon = -1;
  // Canonical order, so every observer resolves a two-garment collision on
  // one body slot the same way. See `WornLook.garments`.
  const order = (slot: EquipSlot): number => {
    const i = (EQUIP_SLOTS as readonly string[]).indexOf(slot);
    return i < 0 ? EQUIP_SLOTS.length : i;
  };
  for (const item of [...worn].sort((a, b) => order(a.slot) - order(b.slot))) {
    if (item.garment) look.garments.push(item.garment);
  }
  for (const item of worn) {
    const { slot } = item.stats;
    if (item.slot === 'head') look.helm = true;
    if (item.slot === 'cloak') look.cape = true;
    if (item.slot === 'chest') {
      // Mana on a chest piece is a robe; weight is a harness. A jerkin is
      // neither and simply reads as the body it already had.
      if (item.stats.mana > 0) look.robe = true;
      else if (item.stats.weight >= 10 || item.stats.armour >= 3) look.pauldrons = true;
    }
    if ((item.slot === 'main-hand' || item.slot === 'off-hand') && item.stats.damage > bestWeapon) {
      bestWeapon = item.stats.damage;
      // A staff is the two-handed thing that carries a reserve; everything
      // else in a hand is drawn as a blade, because those are the two
      // silhouettes the renderer has (D-402).
      look.weapon = slot === 'both-hands' && item.stats.mana > 0 ? 'staff' : 'sword';
      // ⚠ The stance follows the SAME weapon the silhouette picked, not a
      // separate scan. A character holding a bow and a dagger is drawn with
      // one of them, and choosing the silhouette from one while animating the
      // other is a man aiming a bow he is not holding.
      look.stance = item.stance;
    }
  }
  return look;
}

/**
 * What a class is handed at the start of a round (D-547). Not a starting
 * INVENTORY — a starting kit: enough to fight, be seen to be somebody, eat
 * once and bind one wound. Anything richer and the farm and the workshop stop
 * being the reason to leave the tavern.
 */
export const StartingKitEntrySchema = z.object({
  item: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'content ids are lowercase-kebab-case'),
  qty: z.number().int().min(1).max(20).default(1),
  /**
   * Worn on arrival rather than sitting in the pack. The server checks the
   * slot is free and that the item declares one; a kit that tries to equip a
   * loaf is a content error and fails the build.
   */
  equip: EquipSlotSchema.optional(),
});
export type StartingKitEntry = z.infer<typeof StartingKitEntrySchema>;
