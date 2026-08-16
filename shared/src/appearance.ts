import { mulberry32 } from './rng';

/**
 * Appearance generation (D-402): a character's look derives deterministically
 * from the integer seed on its character record, constrained by hand-authored
 * archetype ranges — uniform random produces mush; constrained ranges produce
 * recognisable silhouettes, which is also what makes D-219's silhouette-based
 * recognition meaningful later.
 *
 * Pure module: no Three.js, no DOM — testable headlessly (D-114).
 */

export const ARCHETYPES = {
  brute: {
    height: [1.85, 2.05], bulk: [0.55, 0.75], shoulder: [0.34, 0.42],
    limb: [0.95, 1.05], headScale: [0.88, 0.98], capeChance: 0.25, hair: [0.0, 0.25],
  },
  soldier: {
    height: [1.7, 1.82], bulk: [0.34, 0.46], shoulder: [0.27, 0.32],
    limb: [1.0, 1.06], headScale: [0.95, 1.02], capeChance: 0.55, hair: [0.05, 0.3],
  },
  rogue: {
    height: [1.62, 1.74], bulk: [0.22, 0.3], shoulder: [0.22, 0.26],
    limb: [1.04, 1.12], headScale: [0.97, 1.04], capeChance: 0.75, hair: [0.15, 0.45],
  },
  ascetic: {
    height: [1.66, 1.8], bulk: [0.2, 0.28], shoulder: [0.21, 0.25],
    limb: [1.06, 1.16], headScale: [1.0, 1.08], capeChance: 0.85, hair: [0.3, 0.6],
  },
} as const satisfies Record<
  string,
  {
    height: readonly [number, number];
    bulk: readonly [number, number];
    shoulder: readonly [number, number];
    limb: readonly [number, number];
    headScale: readonly [number, number];
    capeChance: number;
    hair: readonly [number, number];
  }
>;

export type ArchetypeName = keyof typeof ARCHETYPES;
export const ARCHETYPE_NAMES = Object.keys(ARCHETYPES) as ArchetypeName[];

/* Base albedo is deliberately MID-TONE: the lighting and the palette
   quantiser push the final image dark. Near-black sources leave nothing
   to shade (learned in the prototype). */
export const CLOTH_COLORS = [0x6d6154, 0x565f68, 0x7a6248, 0x5d6a54, 0x6b5259, 0x4e5666, 0x84725a];
export const METAL_COLORS = [0x9aa0a8, 0xa8a094, 0x8894a0, 0xb0aa9e];
export const SKIN_COLORS = [0xc9a583, 0xb8916f, 0xa07c5e, 0xd8bb9a, 0x8a6a50];
export const ACCENT_COLORS = [0xb5713c, 0x6d8695, 0x94582f, 0x54697a, 0xd1904a];

export interface Appearance {
  seed: number;
  archetype: ArchetypeName;
  height: number;
  bulk: number;
  shoulder: number;
  limb: number;
  headScale: number;
  hairLen: number;
  hasCape: boolean;
  capeColor: number;
  skin: number;
  cloth: number;
  metal: number;
  accent: number;
  /** M1 equipment presence comes from the seed; later milestones drive it
   * from the actual inventory via the runtime swap API on CharacterVisual. */
  helm: boolean;
  pauldrons: boolean;
  weapon: boolean;
}

const rangePick = (rnd: () => number, r: readonly [number, number]) => r[0] + rnd() * (r[1] - r[0]);
const pick = <T>(rnd: () => number, arr: readonly T[]): T =>
  arr[Math.floor(rnd() * arr.length) % arr.length]!;

/**
 * What a stranger sees (D-201/D-219): until a name is learned, an entity is
 * described, never named. Deterministic from the appearance, so every client
 * and the server agree on how a stranger reads. Deliberately ungendered —
 * the appearance model carries no gender.
 */
export function describeAppearance(a: Appearance): string {
  const build =
    a.archetype === 'brute'
      ? a.height > 1.95 ? 'a towering, heavy-built figure' : 'a broad, heavy-built figure'
      : a.archetype === 'soldier'
        ? 'an upright, square-shouldered figure'
        : a.archetype === 'rogue'
          ? 'a slight, quick-looking figure'
          : a.height > 1.74 ? 'a tall, spare figure' : 'a lean, austere figure';
  const dress = a.helm
    ? 'in a battered helm'
    : a.hairLen > 0.35
      ? 'with long unkempt hair'
      : a.hasCape
        ? 'in a travel-stained cloak'
        : 'in worn cloth';
  return `${build} ${dress}`;
}

export function generateAppearance(seed: number): Appearance {
  const rnd = mulberry32(seed);
  const archetype = pick(rnd, ARCHETYPE_NAMES);
  const a = ARCHETYPES[archetype];
  return {
    seed,
    archetype,
    height: rangePick(rnd, a.height),
    bulk: rangePick(rnd, a.bulk),
    shoulder: rangePick(rnd, a.shoulder),
    limb: rangePick(rnd, a.limb),
    headScale: rangePick(rnd, a.headScale),
    hairLen: rangePick(rnd, a.hair),
    hasCape: rnd() < a.capeChance,
    skin: pick(rnd, SKIN_COLORS),
    cloth: pick(rnd, CLOTH_COLORS),
    metal: pick(rnd, METAL_COLORS),
    accent: pick(rnd, ACCENT_COLORS),
    helm: rnd() < 0.45,
    pauldrons: rnd() < 0.5,
    weapon: rnd() < 0.7,
    capeColor: pick(rnd, ACCENT_COLORS),
  };
}
