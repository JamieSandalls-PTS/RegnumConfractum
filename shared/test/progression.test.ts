import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MAX_LEVEL,
  SKILL_CEILING,
  effectiveSheet,
  levelForXp,
  progressionPreview,
  resolveAppearance,
  validateAppearanceOverride,
  validateBuild,
  xpForLevel,
  xpForNextLevel,
  APPEARANCE_LIMITS,
  HAIR_COLORS,
  generateAppearance,
  type ClassDef,
} from '../src/index';
import { loadContent } from '@rc/server/content';

/**
 * Levels and authored appearance (D-538, D-539) as pure logic.
 *
 * The interesting assertions here are not the arithmetic — they are the two
 * RULES the systems exist to keep, both checked against the real content
 * files so they fail when someone edits a class rather than when someone
 * edits this test:
 *
 *   - a level never grants a creation-only skill (that is where `arms` lives),
 *     which is D-522's "levels buy access, never raw power" made mechanical;
 *   - a feat that only a level can grant must be granted by SOME level, or it
 *     is unreachable content — invariant 2's principle (D-210) applied to
 *     feats rather than to items.
 */

const content = loadContent(fileURLToPath(new URL('../../content', import.meta.url)));
const classes = [...content.classes.values()];

describe('the level curve', () => {
  it('is monotonic, starts at one, and stops at the cap', () => {
    expect(levelForXp(0)).toBe(1);
    expect(levelForXp(-500)).toBe(1); // death debt can make xp look odd
    let last = 1;
    for (let xp = 0; xp < 20_000; xp += 137) {
      const level = levelForXp(xp);
      expect(level).toBeGreaterThanOrEqual(last);
      expect(level).toBeLessThanOrEqual(MAX_LEVEL);
      last = level;
    }
    expect(levelForXp(1_000_000)).toBe(MAX_LEVEL);
    expect(xpForNextLevel(1_000_000)).toBeNull();
  });

  it('agrees with itself about where each level begins', () => {
    for (let level = 1; level <= MAX_LEVEL; level++) {
      expect(levelForXp(xpForLevel(level))).toBe(level);
      if (level > 1) expect(levelForXp(xpForLevel(level) - 1)).toBe(level - 1);
    }
  });
});

describe('the effective sheet', () => {
  const cls: ClassDef = {
    id: 'test-class',
    name: 'Test',
    description: 'x',
    role: 'melee',
    abilities: ['speak-with-dead'],
    legacyLocked: false,
    // Empty is unrestricted (D-566): this fixture is about progression, not
    // about what the class may wear.
    armour: [],
    weapons: [],
    races: [],
    items: [],
    startingAttributes: {},
    startingKit: [],
    affinities: [],
    spellcasting: false,
    progression: [
      { level: 2, skills: { medicine: 5 }, feats: ['a'], spells: [], abilities: [], note: 'n' },
      { level: 4, skills: { medicine: 10 }, feats: [], spells: [], abilities: ['animate-dead'], note: 'n' },
    ],
  };

  it('pays out only what the level has reached', () => {
    const base = { skills: { medicine: 20 }, feats: [], spells: [] };
    expect(effectiveSheet(cls, { level: 1 }, base).skills.medicine).toBe(20);
    expect(effectiveSheet(cls, { level: 2 }, base).skills.medicine).toBe(25);
    expect(effectiveSheet(cls, { level: 3 }, base).skills.medicine).toBe(25);
    expect(effectiveSheet(cls, { level: 4 }, base).skills.medicine).toBe(35);
    expect(effectiveSheet(cls, { level: 1 }, base).feats).toEqual([]);
    expect(effectiveSheet(cls, { level: 2 }, base).feats).toEqual(['a']);
  });

  it('grants class abilities at level one and adds the rest on schedule', () => {
    expect(effectiveSheet(cls, { level: 1 }, {}).abilities).toEqual(['speak-with-dead']);
    expect(effectiveSheet(cls, { level: 4 }, {}).abilities).toContain('animate-dead');
    expect(effectiveSheet(cls, { level: 3 }, {}).abilities).not.toContain('animate-dead');
  });

  it('never carries a skill past the ceiling', () => {
    const base = { skills: { medicine: SKILL_CEILING }, feats: [], spells: [] };
    expect(effectiveSheet(cls, { level: MAX_LEVEL }, base).skills.medicine).toBe(SKILL_CEILING);
  });

  it('is derived from xp, so a character cannot be levelled and unlevelled at once', () => {
    const byXp = effectiveSheet(cls, { xp: xpForLevel(4) }, {});
    const byLevel = effectiveSheet(cls, { level: 4 }, {});
    expect(byXp).toEqual(byLevel);
  });

  it('does nothing at all for a classless character', () => {
    const sheet = effectiveSheet(undefined, { level: MAX_LEVEL }, { skills: { arms: 10 } });
    expect(sheet.skills).toEqual({ arms: 10 });
    expect(sheet.abilities).toEqual([]);
  });
});

describe('the authored classes obey the rules levels are for', () => {
  const creationOnly = new Set(content.skills.filter((s) => s.creationOnly).map((s) => s.id));

  it('fences raw power off from levelling entirely (D-522)', () => {
    // If this fails, the fix is to delete the grant — not to unset the flag.
    expect(creationOnly.size).toBeGreaterThan(0);
    for (const cls of classes) {
      for (const step of cls.progression) {
        for (const id of Object.keys(step.skills)) {
          expect(creationOnly.has(id), `${cls.id} level ${step.level} grants '${id}'`).toBe(false);
        }
      }
    }
  });

  it('leaves no levelled feat unreachable', () => {
    const granted = new Set(classes.flatMap((c) => c.progression.flatMap((s) => s.feats)));
    for (const feat of content.feats) {
      if (feat.minLevel > 1) expect(granted.has(feat.id), feat.id).toBe(true);
    }
  });

  it('gives every calling something at every level it has a step for', () => {
    for (const cls of classes) {
      expect(cls.progression.length, cls.id).toBeGreaterThan(0);
      expect(progressionPreview(cls).length).toBe(cls.progression.length);
      const levels = cls.progression.map((s) => s.level);
      expect(new Set(levels).size).toBe(levels.length);
    }
  });

  it('refuses a levelled feat at creation (D-538)', () => {
    const levelled = content.feats.find((f) => f.minLevel > 1)!;
    const cls = classes.find((c) => levelled.classes.includes(c.id))!;
    const problems = validateBuild(
      { classes, skills: content.skills, feats: content.feats, spells: content.spells },
      cls.id,
      { skills: {}, feats: [levelled.id], spells: [] },
    );
    expect(problems.join('; ')).toMatch(/earned at level/);
  });
});

describe('an authored appearance (D-539)', () => {
  it('leaves the seed alone where the player said nothing', () => {
    const base = generateAppearance(4242);
    const resolved = resolveAppearance(4242, { height: 1.9 });
    expect(resolved.height).toBe(1.9);
    expect(resolved.skin).toBe(base.skin);
    expect(resolved.archetype).toBe(base.archetype);
    // No override at all must be byte-identical to the old behaviour, or
    // every character made before the appearance step changes how it looks.
    expect(resolveAppearance(4242, null)).toEqual(base);
  });

  it('rejects a body outside the world and a colour outside the palette', () => {
    expect(validateAppearanceOverride({ height: APPEARANCE_LIMITS.height[1] + 1 })).not.toEqual([]);
    expect(validateAppearanceOverride({ height: APPEARANCE_LIMITS.height[1] })).toEqual([]);
    expect(validateAppearanceOverride({ hairColor: 0x00ff00 })).not.toEqual([]);
    expect(validateAppearanceOverride({ hairColor: HAIR_COLORS[0]! })).toEqual([]);
    expect(validateAppearanceOverride({ archetype: 'titan' as never })).not.toEqual([]);
  });
});
