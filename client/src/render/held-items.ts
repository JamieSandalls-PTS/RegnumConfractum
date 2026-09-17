import { CharacterItemSchema, type CharacterItem } from '@rc/shared';

/**
 * Where a weapon sits in a hand (D-564, reaching the game in D-614).
 *
 * D-564 fitted 163 weapons into hands by measurement — the pack's units, a
 * wrist-to-palm offset constant per hand, and which family the weapon is —
 * and recorded that "a weapon can be wrong in a way no geometric test sees".
 * All of that was authored into `content/assets/*.character-item.json` and
 * read by the creation tool alone. The game never put a weapon in anybody's
 * hand at all.
 *
 * ⚠ Carried on the WIRE since D-630 (`render_content`). It was five imports
 * naming five packs, so a sixth pack's weapons were invisible until somebody
 * edited this file — and the server already loaded the same files for the
 * stance a weapon declares (D-566). One load, one channel. A grip is still
 * presentation: the server sends it and never reads it.
 *
 * ⚠ Parsed through the real schema rather than trusted as JSON. These files
 * are hand-edited and tool-written, and a bad `attach` would put a sword on a
 * bone that does not exist — which draws nothing, silently, exactly like
 * having no weapon at all.
 */
const GRIPS = new Map<string, CharacterItem>();

export function setGrips(entries: readonly { key: string; item: unknown }[]): void {
  GRIPS.clear();
  for (const { key, item } of entries) {
    const parsed = CharacterItemSchema.safeParse(item);
    if (parsed.success) GRIPS.set(key, parsed.data);
    else console.warn(`[grips] ${key}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }
}

/** The fitted grip for `pack/asset`, or null if nobody has fitted one. */
export function gripFor(key: string): CharacterItem | null {
  return GRIPS.get(key) ?? null;
}

/** How many weapons have a measured grip. For the verification hook. */
export function gripCount(): number {
  return GRIPS.size;
}
