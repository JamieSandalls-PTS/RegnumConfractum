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
export const HAIR_COLORS = [0x2a221c, 0x4a342a, 0x6b4a30, 0x8a7050, 0x9a8a78, 0x5a5450, 0x3a3234];

/** Solid hair silhouettes (renderer interprets; combined with hairLen). */
export const HAIR_STYLES = ['crop', 'bob', 'tail', 'long'] as const;
export type HairStyle = (typeof HAIR_STYLES)[number];

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
  /**
   * Body type (stakeholder request, 2026-08-17). Drawn AFTER every original
   * field so pre-existing seeds keep their silhouettes and descriptors.
   * Renderers derive sex-specific proportions from this; the base parameters
   * above stay sex-neutral. Descriptions remain build-based for now — putting
   * sex into stranger-descriptors is a design question for the stakeholder.
   */
  sex: 'male' | 'female';
  hairStyle: HairStyle;
  hairColor: number;
  /** Bust volume 0..1, female builds only (renderer maps to geometry;
   * male builds ignore it). Range limits await stakeholder ratification
   * via the character creator. */
  bust: number;
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

/**
 * A hooded figure hides face and hair, not build — archetypes ARE silhouettes
 * (D-402), and silhouette is one of the channels disguise cannot fully close
 * (D-219). Height and bulk stay readable.
 */
export function describeHooded(a: Appearance): string {
  const build =
    a.archetype === 'brute'
      ? 'heavy-built'
      : a.archetype === 'soldier'
        ? 'square-shouldered'
        : a.archetype === 'rogue'
          ? 'slight'
          : 'tall and spare';
  return `a hooded ${build} figure`;
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
    // New draws stay at the END (see the Appearance comment): earlier fields
    // must keep their values for a given seed.
    sex: rnd() < 0.5 ? 'female' : 'male',
    hairStyle: pick(rnd, HAIR_STYLES),
    hairColor: pick(rnd, HAIR_COLORS),
    bust: 0.35 + rnd() * 0.3,
  };
}

/* ---------------------------------------------------------------------------
 * Player-authored appearance (D-539)
 *
 * The seed stays the origin of every character — it is what NPCs, roamers and
 * corpses are built from, and what a player rerolls until something is close.
 * An OVERRIDE is the handful of fields a player then sets by hand. Storing a
 * sparse override rather than a whole appearance means:
 *
 *   - old characters, NPCs and monsters keep working untouched (no override
 *     at all is the pre-existing behaviour, exactly);
 *   - a new appearance field added later is inherited from the seed by every
 *     existing character rather than defaulting to something wrong;
 *   - the wire carries a small object, not a full body description.
 *
 * Equipment presence (helm, pauldrons, weapon) is deliberately NOT here. Gear
 * is stripped between rounds (D-522) and will be driven by the inventory; a
 * player choosing to always appear helmed would be choosing a disguise the
 * recognition system (D-219) never agreed to.
 * ------------------------------------------------------------------------ */

/** The fields a player may set. Everything else derives from the seed. */
export interface AppearanceOverride {
  archetype?: ArchetypeName;
  sex?: 'male' | 'female';
  height?: number;
  bulk?: number;
  shoulder?: number;
  limb?: number;
  headScale?: number;
  bust?: number;
  hairLen?: number;
  hairStyle?: HairStyle;
  hairColor?: number;
  skin?: number;
  cloth?: number;
  accent?: number;
  capeColor?: number;
  hasCape?: boolean;
}

/**
 * Hard bounds on every numeric the creator exposes. These are the SERVER's
 * limits, not the UI's — a hand-rolled client that sends height 40 gets
 * rejected, because the client never decides anything (D-102).
 *
 * ⚠ The ranges are wider than any single archetype on purpose: archetypes
 * constrain *generation* (D-402, uniform random makes mush), while a player
 * building deliberately is allowed the whole human range. They are narrow
 * enough that no build breaks the rig or the garment cutter (D-519).
 */
export const APPEARANCE_LIMITS = {
  height: [1.5, 2.1],
  bulk: [0.16, 0.8],
  shoulder: [0.18, 0.44],
  limb: [0.9, 1.2],
  headScale: [0.85, 1.12],
  bust: [0.0, 1.0],
  hairLen: [0.0, 0.7],
} as const satisfies Record<string, readonly [number, number]>;

/** Colour choices are enumerated, so a client cannot invent a palette. */
const PALETTES = {
  hairColor: HAIR_COLORS,
  skin: SKIN_COLORS,
  cloth: CLOTH_COLORS,
  accent: ACCENT_COLORS,
  capeColor: ACCENT_COLORS,
} as const;

/**
 * Server-side legality. Returns [] for a legal override, else the reasons.
 * Deliberately strict about palettes: colours off the palette survive the
 * quantiser badly (D-404) and would make one character look wrong in a way
 * nobody could explain.
 */
export function validateAppearanceOverride(o: AppearanceOverride): string[] {
  const errors: string[] = [];
  if (o.archetype !== undefined && !ARCHETYPE_NAMES.includes(o.archetype)) {
    errors.push(`unknown build '${String(o.archetype)}'`);
  }
  if (o.sex !== undefined && o.sex !== 'male' && o.sex !== 'female') {
    errors.push('unknown body type');
  }
  if (o.hairStyle !== undefined && !HAIR_STYLES.includes(o.hairStyle)) {
    errors.push(`unknown hair style '${String(o.hairStyle)}'`);
  }
  for (const [key, range] of Object.entries(APPEARANCE_LIMITS)) {
    const v = (o as Record<string, unknown>)[key];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      errors.push(`${key} must be a number`);
    } else if (v < range[0] || v > range[1]) {
      errors.push(`${key} must be between ${range[0]} and ${range[1]}`);
    }
  }
  for (const [key, palette] of Object.entries(PALETTES)) {
    const v = (o as Record<string, unknown>)[key];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !(palette as readonly number[]).includes(v)) {
      errors.push(`${key} is not one of the world's colours`);
    }
  }
  return errors;
}

/**
 * Seed first, player second. Every reader of an appearance goes through
 * here — including the server's stranger-descriptors (D-201/D-219), so a
 * player who builds a towering figure is described as one.
 */
export function resolveAppearance(
  seed: number,
  override?: AppearanceOverride | null,
): Appearance {
  const base = generateAppearance(seed);
  if (!override) return base;
  const out: Appearance = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined || value === null) continue;
    (out as unknown as Record<string, unknown>)[key] = value;
  }
  return out;
}

/**
 * A creator's starting point: the seed's appearance as a full override, so
 * every control has a value the moment the panel opens.
 */
export function overrideFromAppearance(a: Appearance): Required<AppearanceOverride> {
  return {
    archetype: a.archetype,
    sex: a.sex,
    height: a.height,
    bulk: a.bulk,
    shoulder: a.shoulder,
    limb: a.limb,
    headScale: a.headScale,
    bust: a.bust,
    hairLen: a.hairLen,
    hairStyle: a.hairStyle,
    hairColor: a.hairColor,
    skin: a.skin,
    cloth: a.cloth,
    accent: a.accent,
    capeColor: a.capeColor,
    hasCape: a.hasCape,
  };
}
