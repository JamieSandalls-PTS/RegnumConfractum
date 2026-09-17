import bowCrossbow from '../../../content/assets/bow-crossbow.character-item.json';
import dungeonPack from '../../../content/assets/dungeon-pack.character-item.json';
import knights from '../../../content/assets/knights.character-item.json';
import modularHero from '../../../content/assets/modular-fantasy-hero.character-item.json';
import vikings from '../../../content/assets/vikings.character-item.json';
import { AssetFileSchema, type CharacterItem } from '@rc/shared';

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
 * ⚠ Imported rather than fetched, for the reason D-541 gives for the sound
 * cues: a grip offset is PRESENTATION. The server has no opinion about where
 * a hilt sits and should not be asked; sending it would put a rendering
 * constant on the wire and make it a thing that can desync.
 *
 * ⚠ Parsed through the real schema rather than trusted as JSON. These files
 * are hand-edited and tool-written, and a bad `attach` would put a sword on a
 * bone that does not exist — which draws nothing, silently, exactly like
 * having no weapon at all.
 */
const FILES = [bowCrossbow, dungeonPack, knights, modularHero, vikings];

const GRIPS = new Map<string, CharacterItem>();
for (const raw of FILES) {
  const file = AssetFileSchema.parse(raw);
  for (const asset of file.assets) {
    if (asset.kind !== 'character-item') continue;
    GRIPS.set(`${file.pack}/${asset.id}`, asset);
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
