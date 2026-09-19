import { z } from 'zod';

/** The content-id rule, spelled here so `content.ts` can import this file. */
const ContentIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lower-case, digits and dashes');

/**
 * Visual effects as content (D-639).
 *
 * The stakeholder's brief: one page to create a VFX, usable anywhere a VFX
 * can be applied — a fire in a fireplace on a map, a glow on a held weapon,
 * a fireball leaving a staff — and a weapon that fires a projectile which is
 * an asset (an arrow), a VFX, or both.
 *
 * A VFX is a small data-driven composition of three things the renderer
 * knows how to draw: PARTICLES (motes with a life, a velocity and a colour
 * ramp), a LIGHT (a point light with a flicker), and a GLOW (a soft sphere
 * that pulses). Any of the three may be absent. `loop` says whether it burns
 * until removed (a hearth) or plays once and ends (an impact). A projectile
 * uses the same definition for its trail and names a second one for the
 * impact.
 *
 * ⚠ Everything here is PRESENTATION. The server never reads a colour or a
 * particle count: it carries ids on the wire (D-102) and the client draws
 * what content says. A VFX the client cannot resolve draws nothing and says
 * so in the console — never a fallback effect that looks like a decision.
 *
 * ⚠ Colours are hex strings, not palette swatches: an effect is light, not
 * cloth, and the quantiser that made off-palette colours dangerous is gone
 * (D-586).
 */

const HexSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'a #rrggbb colour');

/** [low, high], low first. */
const RangeSchema = z.tuple([z.number(), z.number()]).refine(([a, b]) => a <= b, 'low first');

export const VfxParticlesSchema = z.object({
  /**
   * Motes per second while the effect loops; motes in the single burst of a
   * one-shot. The renderer keeps at most `MAX_MOTES` alive per effect.
   */
  rate: z.number().min(0).max(400).default(30),
  /** Seconds a mote lives. */
  life: RangeSchema.default([0.5, 1.0]),
  /** Metres per second it leaves at. */
  speed: RangeSchema.default([0.4, 0.9]),
  /**
   * Which way motes leave: up (fire, smoke), out in every direction (a
   * burst), down (a dissolve), or none (they only drift).
   */
  direction: z.enum(['up', 'out', 'down', 'none']).default('up'),
  /** 0 is a beam along `direction`; 1 is any direction at all. */
  spread: z.number().min(0).max(1).default(0.35),
  /** Metres per second squared, downward. Negative rises (embers, smoke). */
  gravity: z.number().min(-10).max(20).default(0),
  /** A sideways wander, in metres per second. */
  drift: z.number().min(0).max(3).default(0.15),
  /** Metres across at birth and at death — a mote usually shrinks, so this is NOT low-first. */
  size: z.tuple([z.number().min(0), z.number().min(0)]).default([0.08, 0.02]),
  /** Colour at birth and at death. */
  colour: z.tuple([HexSchema, HexSchema]).default(['#ffb347', '#ff3b0a']),
  /** Additive blending reads as light; plain reads as matter (smoke, blood). */
  additive: z.boolean().default(true),
  /** Metres: how far from the origin motes may be born. */
  radius: z.number().min(0).max(5).default(0.12),
});
export type VfxParticles = z.infer<typeof VfxParticlesSchema>;

export const VfxLightSchema = z.object({
  colour: HexSchema.default('#ffa040'),
  /** Three.js physical units (D-586's note: expect single digits to tens). */
  intensity: z.number().min(0).max(200).default(12),
  /** Metres the light reaches. */
  distance: z.number().min(0).max(60).default(8),
  /** How much the intensity wavers, 0..1, and how fast, in hertz. */
  flicker: z.object({
    amount: z.number().min(0).max(1).default(0.25),
    speed: z.number().min(0).max(30).default(9),
  }).default({}),
  /** Metres above the effect's origin the light sits. */
  height: z.number().min(-2).max(5).default(0.6),
});
export type VfxLight = z.infer<typeof VfxLightSchema>;

export const VfxGlowSchema = z.object({
  colour: HexSchema.default('#ffc66b'),
  /** Metres. */
  radius: z.number().min(0.01).max(5).default(0.25),
  opacity: z.number().min(0).max(1).default(0.55),
  /** How much the radius pulses, 0..1, and how fast, in hertz. */
  pulse: z.object({
    amount: z.number().min(0).max(1).default(0.15),
    speed: z.number().min(0).max(30).default(2),
  }).default({}),
  height: z.number().min(-2).max(5).default(0.3),
});
export type VfxGlow = z.infer<typeof VfxGlowSchema>;

export const VfxDefSchema = z.object({
  id: ContentIdSchema,
  name: z.string().min(1),
  /** What it is for, in words. Never shown to players. */
  notes: z.string().default(''),
  /** Burns until removed (a hearth, a glowing blade), or plays once. */
  loop: z.boolean().default(true),
  /** Seconds a one-shot lasts. Ignored while `loop`. */
  duration: z.number().min(0.05).max(10).default(0.6),
  particles: VfxParticlesSchema.optional(),
  light: VfxLightSchema.optional(),
  glow: VfxGlowSchema.optional(),
});
export type VfxDef = z.infer<typeof VfxDefSchema>;

/** A VFX standing in an area (D-639): a fire in a fireplace. */
export const PlacedVfxSchema = z.object({
  vfx: ContentIdSchema,
  x: z.number(),
  y: z.number(),
  /** Metres above the floor. */
  z: z.number().default(0),
  scale: z.number().positive().max(10).default(1),
});
export type PlacedVfx = z.infer<typeof PlacedVfxSchema>;

/**
 * What an ITEM does with VFX (D-639).
 *
 * `held` burns on the weapon while it is out — a glowing blade. `attack`
 * plays on the weapon as a swing or cast begins. `projectile` is what
 * leaves the weapon on an attack: an asset (`pack/asset`, an arrow), a VFX
 * that flies (a fireball), or both; `impact` plays where it lands. A weapon
 * with no projectile is a melee weapon whatever its reach.
 */
export const ItemVfxSchema = z.object({
  held: ContentIdSchema.optional(),
  attack: ContentIdSchema.optional(),
  projectile: z.object({
    asset: z.string().regex(/^[^/]+\/[^/]+$/, 'pack/asset').optional(),
    vfx: ContentIdSchema.optional(),
    /** Metres per second. */
    speed: z.number().min(1).max(80).default(18),
    /** How high the arc rises at its middle, in metres. */
    arc: z.number().min(0).max(5).default(0.6),
  }).optional(),
  impact: ContentIdSchema.optional(),
});
export type ItemVfx = z.infer<typeof ItemVfxSchema>;

/**
 * What an attack SHOWS, as the server tells it (D-639). Resolved server-side
 * off the attacker's weapon, for the reason `stance` and `art` are (D-578,
 * D-614): a client that had to look the item up would need the whole item
 * catalogue.
 */
export const AttackShowSchema = z.object({
  attack: ContentIdSchema.optional(),
  projectile: z.object({
    asset: z.string().optional(),
    vfx: ContentIdSchema.optional(),
    speed: z.number(),
    arc: z.number(),
  }).optional(),
  impact: ContentIdSchema.optional(),
});
export type AttackShow = z.infer<typeof AttackShowSchema>;

export function attackShowOf(v: ItemVfx | undefined): AttackShow | undefined {
  if (!v) return undefined;
  const out: AttackShow = {};
  if (v.attack) out.attack = v.attack;
  if (v.projectile) {
    out.projectile = { speed: v.projectile.speed, arc: v.projectile.arc };
    if (v.projectile.asset) out.projectile.asset = v.projectile.asset;
    if (v.projectile.vfx) out.projectile.vfx = v.projectile.vfx;
  }
  if (v.impact) out.impact = v.impact;
  return Object.keys(out).length ? out : undefined;
}

/**
 * References that would draw nothing. Run by `validate:content` and the
 * editors, so a renamed effect is a build error rather than a dark hearth.
 */
export function vfxReferenceProblems(
  known: ReadonlySet<string>,
  refs: readonly { where: string; vfx: string }[],
): string[] {
  return refs
    .filter((r) => !known.has(r.vfx))
    .map((r) => `${r.where} names vfx '${r.vfx}', which does not exist`);
}

/** Every effect an item names, for the reference check. */
export function itemVfxRefs(itemId: string, v: ItemVfx | undefined): { where: string; vfx: string }[] {
  if (!v) return [];
  const out: { where: string; vfx: string }[] = [];
  const add = (field: string, id?: string): void => {
    if (id) out.push({ where: `item '${itemId}' ${field}`, vfx: id });
  };
  add('held', v.held);
  add('attack', v.attack);
  add('projectile', v.projectile?.vfx);
  add('impact', v.impact);
  return out;
}

/** The renderer's cap on live motes per effect. */
export const MAX_MOTES = 240;
