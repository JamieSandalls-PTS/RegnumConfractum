import { attributePointsAt } from './attributes';
import type { ClassAbility, ClassDef } from './content';

/**
 * Character levels (D-538), the persistent spine D-522 asked for: a character
 * survives the round and levels across rounds, and what a level buys is
 * ACCESS AND OPTIONS, NEVER RAW POWER.
 *
 * That rule is not decoration. D-529 showed why: the Round's whole betrayal
 * geometry rests on "going out alone at night is death, so take a partner".
 * If a level made a veteran able to walk the night alone, the buddy system
 * would evaporate for exactly the players who have been here longest. So:
 *
 *   - a level grants FEATS (verbs and permissions), class ABILITIES (rites),
 *     and points in NON-COMBAT skills;
 *   - a level never grants hit points, never grants damage, and never grants
 *     a skill marked `creationOnly` — which is how `arms` is fenced off.
 *
 * The fence is enforced in CI by tools/validate-content.ts, not merely
 * described here, because a class file is exactly the place someone would
 * one day quietly add `arms: 10` at level 5.
 *
 * Pure module: no server, no DOM. Both sides compute the same sheet, and the
 * server remains the authority (D-102).
 */

export const MAX_LEVEL = 10;

/**
 * Cumulative xp required to REACH each level; index 0 is level 1.
 *
 * ⚠ UNRATIFIED. Calibrated against MR2's actual earnings — a harvest pays 4,
 * a craft 6, a dungeon dweller 10–55 — so a competent surviving round banks
 * roughly 150–350. That puts level 2 at about one good round, level 5 at
 * eight or ten, and level 10 somewhere past thirty. The curve is deliberately
 * shallow at the bottom (a first-timer sees a level early) and long at the
 * top (there is somewhere to go).
 */
export const XP_TABLE: readonly number[] = [
  0, 150, 400, 800, 1400, 2200, 3200, 4500, 6100, 8000,
];

export function levelForXp(xp: number): number {
  let level = 1;
  for (let i = 1; i < XP_TABLE.length; i++) {
    if (xp >= XP_TABLE[i]!) level = i + 1;
    else break;
  }
  return Math.min(level, MAX_LEVEL);
}

/** Cumulative xp at which `level` is reached. */
export function xpForLevel(level: number): number {
  const clamped = Math.max(1, Math.min(level, MAX_LEVEL));
  return XP_TABLE[clamped - 1]!;
}

/**
 * Cumulative xp for the NEXT level, or null at the cap. The client shows a
 * bar with it; nothing mechanical reads it.
 */
export function xpForNextLevel(xp: number): number | null {
  const level = levelForXp(xp);
  return level >= MAX_LEVEL ? null : XP_TABLE[level]!;
}

/**
 * Skills are on the same 0–100 scale as the pre-existing bluff/insight/
 * necromancy, and stay there: creation allocates at most 40 (D-515) and
 * progression can carry a specialist toward — never past — the ceiling.
 */
export const SKILL_CEILING = 100;

/** What a character actually has, once its level has been paid out. */
export interface EffectiveSheet {
  level: number;
  /** Creation allocation plus every progression grant at or below `level`. */
  skills: Record<string, number>;
  feats: string[];
  spells: string[];
  abilities: ClassAbility[];
}

export interface BaseBuild {
  skills?: Record<string, number>;
  feats?: string[];
  spells?: string[];
  /** What the player chose on the level-up screen (D-546). */
  advances?: CharacterAdvances | null;
}

/**
 * The player's own level-up spending (D-546), stored rather than derived —
 * unlike level itself, these are choices and nothing can recompute them.
 *
 * `attributes` holds POINTS ADDED, not totals: storing totals here would mean
 * two places disagreeing about a character's strength the moment creation and
 * advancement were both written, which is the same dual-write trap D-538
 * avoided by deriving level from xp.
 */
export interface CharacterAdvances {
  attributes: Record<string, number>;
  skills: Record<string, number>;
  feats: string[];
  spells: string[];
}

export function emptyAdvances(): CharacterAdvances {
  return { attributes: {}, skills: {}, feats: [], spells: [] };
}

/**
 * The one place a character's real numbers are computed. Everything that
 * gates on a skill, a feat or an ability must read this rather than the
 * stored creation build — otherwise levelling would be cosmetic in some
 * places and real in others, which is the bug that never gets noticed until
 * a player finds it.
 */
export function effectiveSheet(
  cls: ClassDef | undefined,
  xpOrLevel: { xp: number } | { level: number },
  base: BaseBuild,
): EffectiveSheet {
  const level =
    'level' in xpOrLevel
      ? Math.max(1, Math.min(xpOrLevel.level, MAX_LEVEL))
      : levelForXp(xpOrLevel.xp);
  const skills: Record<string, number> = { ...(base.skills ?? {}) };
  const feats = [...(base.feats ?? [])];
  const spells = [...(base.spells ?? [])];
  // The player's own level-up spending lands before the class's automatic
  // grants, so a class grant still tops out at the same ceiling either way.
  for (const [id, points] of Object.entries(base.advances?.skills ?? {})) {
    skills[id] = Math.min(SKILL_CEILING, (skills[id] ?? 0) + points);
  }
  for (const id of base.advances?.feats ?? []) if (!feats.includes(id)) feats.push(id);
  for (const id of base.advances?.spells ?? []) if (!spells.includes(id)) spells.push(id);
  const abilities: ClassAbility[] = [...(cls?.abilities ?? [])];
  for (const step of cls?.progression ?? []) {
    if (step.level > level) continue;
    for (const [id, points] of Object.entries(step.skills)) {
      skills[id] = Math.min(SKILL_CEILING, (skills[id] ?? 0) + points);
    }
    for (const id of step.feats) if (!feats.includes(id)) feats.push(id);
    for (const id of step.spells) if (!spells.includes(id)) spells.push(id);
    for (const id of step.abilities) if (!abilities.includes(id)) abilities.push(id);
  }
  return { level, skills, feats, spells, abilities };
}

/** What a class will grant, in order — for the creation screen's preview. */
export function progressionPreview(cls: ClassDef): { level: number; text: string }[] {
  const out: { level: number; text: string }[] = [];
  for (const step of [...cls.progression].sort((a, b) => a.level - b.level)) {
    const parts: string[] = [];
    const skills = Object.entries(step.skills);
    if (skills.length > 0) parts.push(skills.map(([id, n]) => `${id} +${n}`).join(', '));
    if (step.feats.length > 0) parts.push(step.feats.join(', '));
    if (step.spells.length > 0) parts.push(step.spells.join(', '));
    if (step.abilities.length > 0) parts.push(step.abilities.join(', '));
    if (parts.length > 0) out.push({ level: step.level, text: parts.join(' · ') });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Advancement: what the PLAYER chooses at a level (D-546)
//
// D-538 made every grant automatic and fixed, and the argument for that still
// holds: "a physician has field surgery by four" is something the whole table
// can plan around, and a grab-bag of per-character picks is not. So the class
// progression table above is UNCHANGED and still automatic.
//
// What D-546 adds sits on top of it: a small, explicit budget the player
// spends on a level-up screen. The class still deepens on its own schedule;
// the player decides what ELSE they became. Both halves are visible on the
// sheet, and the automatic half is still the one other players can predict.
//
// ⚠ Every number here is UNRATIFIED.
// ---------------------------------------------------------------------------

/** Skill points handed out at every level from 2 up. */
export const ADVANCE_SKILL_POINTS_PER_LEVEL = 10;
/** Levels that let the player pick a feat. */
export const ADVANCE_FEAT_LEVELS: readonly number[] = [4, 8];
/** Levels that let a caster pick a spell. */
export const ADVANCE_SPELL_LEVELS: readonly number[] = [3, 6, 9];

export interface AdvancementBudget {
  /** Attribute points placed by hand. See ATTRIBUTE_LEVELS for the fence. */
  attributePoints: number;
  skillPoints: number;
  feats: number;
  spells: number;
}

/**
 * Everything a character of this level is entitled to have spent, cumulative.
 *
 * Cumulative rather than per-level on purpose: a player who was away when
 * they hit level four must not lose the pick. The level-up screen shows
 * whatever is still unspent, however long ago it was earned.
 */
export function advancementBudget(level: number, spellcasting: boolean): AdvancementBudget {
  const capped = Math.max(1, Math.min(level, MAX_LEVEL));
  return {
    attributePoints: attributePointsAt(capped),
    skillPoints: Math.max(0, capped - 1) * ADVANCE_SKILL_POINTS_PER_LEVEL,
    feats: ADVANCE_FEAT_LEVELS.filter((l) => l <= capped).length,
    spells: spellcasting ? ADVANCE_SPELL_LEVELS.filter((l) => l <= capped).length : 0,
  };
}

/** What a character has actually spent, from its stored advancement record. */
export function advancementSpent(adv: CharacterAdvances | null | undefined): AdvancementBudget {
  return {
    attributePoints: Object.values(adv?.attributes ?? {}).reduce((a, b) => a + (b ?? 0), 0),
    skillPoints: Object.values(adv?.skills ?? {}).reduce((a, b) => a + (b ?? 0), 0),
    feats: (adv?.feats ?? []).length,
    spells: (adv?.spells ?? []).length,
  };
}

/**
 * What is still on the table. A level-up screen is OWED when any of these is
 * positive — which is also how a character who levelled twice while offline
 * gets both screens' worth in one sitting rather than losing one.
 */
export function advancementUnspent(
  level: number,
  spellcasting: boolean,
  adv: CharacterAdvances | null | undefined,
): AdvancementBudget {
  const have = advancementBudget(level, spellcasting);
  const spent = advancementSpent(adv);
  return {
    attributePoints: Math.max(0, have.attributePoints - spent.attributePoints),
    skillPoints: Math.max(0, have.skillPoints - spent.skillPoints),
    feats: Math.max(0, have.feats - spent.feats),
    spells: Math.max(0, have.spells - spent.spells),
  };
}

export function hasUnspentAdvancement(b: AdvancementBudget): boolean {
  return b.attributePoints > 0 || b.skillPoints > 0 || b.feats > 0 || b.spells > 0;
}
