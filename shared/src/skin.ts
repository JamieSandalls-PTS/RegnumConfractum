/**
 * Skin as a colour, not as a file (D-560).
 *
 * The pack ships three skin tones as three atlases, which is three tones. But
 * skin in this art is only FOUR flat colours out of a 1024² atlas — measured,
 * across every pixel that differs between the `_A` and `_C` variants:
 *
 *   #ffccae  235,306 px   the skin itself
 *   #edaf97    6,935 px   a warmer shade — lips, the inside of an ear
 *   #cdb3a1    5,700 px   a greyer shade
 *   #433622    3,577 px   the deep shadow — eye sockets, the open mouth
 *
 * So a tone is four colour substitutions, and any colour a person can pick is
 * reachable. That is why a race stores an RGB rather than a texture name:
 * three tones was a property of how many files somebody exported, not a
 * property of the art, and it should not have become a property of the game.
 *
 * The same four colours appear in all four clothing colourways, so a tone
 * composes with whatever a character is wearing rather than replacing it.
 */

/** The four skin colours, as they appear in every atlas this pack ships. */
export const SKIN_SOURCE = ['#ffccae', '#edaf97', '#cdb3a1', '#433622'] as const;

/**
 * Face markings — war paint, tattoos — are one more colour.
 *
 * Twenty-eight of the 46 heads carry them, and NO other part in the pack
 * touches this colour: it is a channel of its own, so it recolours
 * independently of skin.
 *
 * ⚠ They exist only in the LETTERED atlases. The plain `PolygonFantasyHero_
 * Texture_01` is the markings-free cut, and rendering against it makes the
 * marked heads sample plain skin instead — which is exactly what "many heads
 * with no visible difference" looks like. Anything previewing or building a
 * head must use a lettered atlas.
 */
export const MARKING_SOURCE = '#4566a9';

/**
 * Skin occupies the bottom of the atlas, up to this V coordinate.
 *
 * Measured, not guessed: the pixels that differ between the `_A` and `_C`
 * atlases — same clothing, different skin tone — span the full width and
 * v 0.00..0.31. A part whose UVs land mostly inside that band is BARE, which
 * is how the base body is told from a garment without anybody eyeballing 720
 * meshes.
 */
export const SKIN_UV_MAX_V = 0.31;

/**
 * How much of a part is bare skin, from its UVs alone.
 *
 * The pack does not label its nude parts, and the answer matters: character
 * creation offers a body, everything else is clothing and belongs to an
 * equippable item instead.
 */
export function skinFraction(uv: { count: number; getY(i: number): number }): number {
  if (uv.count === 0) return 0;
  let hits = 0;
  for (let i = 0; i < uv.count; i++) if (uv.getY(i) <= SKIN_UV_MAX_V) hits++;
  return hits / uv.count;
}

/**
 * The other body's version of a part, if the pack ships one.
 *
 * ⚠ The pairing is by NUMBER and it is real, not a hopeful convention:
 * `Torso_Female_12` shares 0.96 of its UV islands with `Torso_Male_12` and
 * only 0.36 with any other female torso. Measured across every slot the pack
 * cuts twice — hips 0.97, legs 0.94, arms 0.89, hands 0.94 — against controls
 * of 0.13 to 0.36. It is the same garment cut for a different body.
 */
export function mirroredPart(stem: string): string | null {
  if (/_Male_/i.test(stem)) return stem.replace(/_Male_/i, '_Female_');
  if (/_Female_/i.test(stem)) return stem.replace(/_Female_/i, '_Male_');
  return null;
}

/**
 * A name carried across to the other body.
 *
 * If the name says which body it is for, that word is swapped rather than
 * copied — "Studded leather male" becoming "Studded leather male" on a woman
 * is the sort of mistake that survives a hundred rows unnoticed.
 */
export function mirroredName(name: string, to: 'male' | 'female'): string {
  const from = to === 'male' ? 'female' : 'male';
  // Whole word only, or "Malevolent" loses its middle. A fresh regex per
  // call: a `/g` one carries `lastIndex` between uses and would skip every
  // other name.
  return name.replace(new RegExp(`\\b${from}\\b`, 'gi'), (matched) =>
    matched[0] === matched[0]?.toUpperCase() ? `${to[0]!.toUpperCase()}${to.slice(1)}` : to,
  );
}

/** The substitution that paints a face's markings a chosen colour. */
export function markingSwap(rgb: string): ColourSwap {
  return { from: MARKING_SOURCE, to: toHex(parseHex(rgb)) };
}

/**
 * The atlas to render against, given what a pack ships.
 *
 * Prefers a lettered variant, because the unlettered one silently drops face
 * markings. Falls back to whatever exists rather than failing: a pack that
 * names its textures differently should still render.
 */
export function preferredAtlas(textures: readonly string[]): string {
  const usable = textures.filter((t) => !/mask/i.test(t));
  return usable.find((t) => /_0?1_A$/i.test(t)) ?? usable.find((t) => /_[A-C]$/i.test(t)) ?? usable[0] ?? '';
}

/**
 * How the three darker shades relate to the base one.
 *
 * Measured, not chosen: each is the mean of that shade's ratio to the base
 * across the vendor's own three tones. Using the vendor's relationships means
 * a picked colour is shaded the way an artist shaded theirs, rather than the
 * way a formula would.
 *
 * Multiplicative rather than a fixed offset, so a dark pick stays dark and a
 * pale one keeps its shading instead of clipping to white.
 */
const SHADE_RATIOS: readonly (readonly [number, number, number])[] = [
  [1, 1, 1],
  [0.844, 0.832, 0.88],
  [0.765, 0.83, 0.907],
  [0.244, 0.264, 0.252],
];

export interface ColourSwap {
  /** The colour in the source atlas, as `#rrggbb`. */
  readonly from: string;
  /** What it becomes, as `#rrggbb`. */
  readonly to: string;
}

const clamp = (n: number): number => Math.max(0, Math.min(255, Math.round(n)));

export function parseHex(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`not a colour: ${hex}`);
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function toHex(rgb: readonly [number, number, number]): string {
  return `#${rgb.map((c) => clamp(c).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The four substitutions that turn this pack's skin into the given colour.
 *
 * Pure, so the tool's live preview and whatever finally bakes the texture are
 * the same rule rather than two that drift — the mistake the studio was
 * careful to avoid between preview and build.
 */
export function skinPalette(base: string): ColourSwap[] {
  const [r, g, b] = parseHex(base);
  return SKIN_SOURCE.map((from, i) => {
    const ratio = SHADE_RATIOS[i]!;
    return { from, to: toHex([r * ratio[0], g * ratio[1], b * ratio[2]]) };
  });
}

/**
 * The tones the pack itself ships, as colours.
 *
 * Kept as presets rather than as the only options: they are what the artist
 * chose, so they are the right place to start from and the wrong place to
 * stop.
 */
export const VENDOR_SKIN_TONES: readonly { id: string; name: string; rgb: string }[] = [
  { id: 'pale', name: 'Pale', rgb: '#ffccae' },
  { id: 'tan', name: 'Tan', rgb: '#d1a275' },
  { id: 'dark', name: 'Dark', rgb: '#906850' },
];

/**
 * The atlas a pack's PROPS and WEAPONS are painted from (D-566).
 *
 * ⚠ Not `preferredAtlas`, which is for CHARACTERS and deliberately picks the
 * lettered cut of the body sheet so face markings survive (D-560). A pack
 * keeps its people and its swords on different images — knights ships
 * `Characters_Texture_Black` beside `POLYGON_Knights_Texture_01` — and asking
 * the character function for a sword's atlas returns a character sheet.
 *
 * ⚠ It exists in `shared` because the CLIENT paints the preview and the SERVER
 * measures the colours to offer as swatches, and the two disagreeing is worse
 * than either being wrong: the tool then shows colours that are not on the
 * mesh it is drawing, every substitution silently does nothing, and there is
 * no error anywhere. That is the D-558 lesson — one assembler, not two — in a
 * different place.
 */
export function assetAtlas(textures: readonly string[]): string {
  const usable = textures.filter((t) => !/mask|normal|metallic|emissi|roughness/i.test(t));
  return (
    usable.find((t) => /^POLYGON_.*_Texture_0?1$/i.test(t)) ??
    usable.find((t) => /^Texture_0?1$/i.test(t)) ??
    usable.find((t) => /_Texture_0?1$/i.test(t) && !/character/i.test(t)) ??
    usable.find((t) => !/character/i.test(t)) ??
    usable[0] ??
    ''
  );
}
