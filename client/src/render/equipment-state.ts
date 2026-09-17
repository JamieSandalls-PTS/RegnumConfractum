import type { Stance } from '@rc/shared';

/**
 * What a character is visibly wearing and carrying (D-617).
 *
 * ⚠ This lived in `character.ts` alongside the procedural cast, and outlived
 * it: the cast is deleted and this is still the shape `main.ts` hands the
 * renderer. It moved here rather than into `ImportedVisual` so that the thing
 * describing an appearance is not defined inside the one class that happens to
 * draw it today.
 *
 * ⚠ Several fields read as leftovers from a cast that generated geometry from
 * flags, and they are not: `helm`, `pauldrons`, `cape` and `robe` are the
 * SILHOUETTE the server broadcasts (D-554) and are what a stranger's
 * descriptor is built from. They are a coarser statement than `garments` on
 * purpose, and the server sends both.
 */
export interface EquipmentState {
  helm: boolean;
  pauldrons: boolean;
  weapon: boolean;
  /** What the weapon hand holds when `weapon` is true. */
  weaponKind: 'sword' | 'staff';
  cape: boolean;
  /** Full-length robe: skirt to the ankles, overtunic, rope belt. */
  robe: boolean;
  /**
   * WHICH weapon, as `pack/asset` (D-614). Absent means no particular one —
   * an item that names no art still fills a hand, it just has no fitted mesh.
   */
  weaponArt?: string;
  /**
   * Garments worn, in the wire's canonical order (D-571).
   *
   * ⚠ ORDER IS THE RULE. Two garments can claim one body slot, and the last
   * listed is the one seen; every observer must resolve that collision the
   * same way or two clients draw the same person in two different coats.
   */
  garments: readonly string[];
  /**
   * How the weapon in hand is carried (D-565, wired D-578).
   *
   * Absent means empty-handed — the rig's own clips, never a stance (D-564).
   */
  stance?: Stance;
}
