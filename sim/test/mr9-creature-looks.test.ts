import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CharacterDefSchema, RoamerSchema, roamerProblems } from '@rc/shared';

/**
 * A creature is drawn as what its content says (D-594).
 *
 * ⚠ Until now nothing said. Every roamer was drawn from its appearance seed,
 * which is to say as a random townsman: "something man-shaped that does not
 * walk like a man" rendered as a man, while the ingested packs had sixteen
 * finished goblins, skeletons, ghosts and a rock golem sitting in them.
 *
 * These are content assertions, deliberately — the rendering is one line in
 * `ImportedVisual` and the thing that actually breaks is the join between a
 * roamer, a character definition and a mesh the build can find.
 */

const contentDir = fileURLToPath(new URL('../../content', import.meta.url));

function read<T>(dir: string, parse: (v: unknown) => T): T[] {
  const full = join(contentDir, dir);
  if (!existsSync(full)) return [];
  return readdirSync(full)
    .filter((f) => f.endsWith('.json'))
    .map((f) => parse(JSON.parse(readFileSync(join(full, f), 'utf8'))));
}

const characters = read('characters', (v) => CharacterDefSchema.parse(v));
const roamers = read('roamers', (v) => RoamerSchema.parse(v));

describe('a character can BE a mesh, not only an assembly', () => {
  it('ships whole-mesh enemies from an ingested pack', () => {
    const whole = characters.filter((c) => c.mesh !== undefined);
    expect(whole.length).toBeGreaterThan(0);
    // ⚠ Every one names a pack and a mesh and NO parts. A definition with both
    // would have an assembler and a finished body disagreeing about what the
    // character is; the schema refuses it, and this is the assertion that says
    // the authored content actually took the branch.
    for (const c of whole) {
      expect(Object.keys(c.parts)).toEqual([]);
      expect(c.pack.length).toBeGreaterThan(0);
    }
  });

  it('refuses a definition that is both, or neither', () => {
    const base = { id: 'x', name: 'X', pack: 'p', sex: 'male' as const };
    expect(CharacterDefSchema.safeParse({ ...base, parts: {}, mesh: undefined }).success)
      .toBe(false);
    expect(
      CharacterDefSchema.safeParse({ ...base, parts: { head: 'h' }, mesh: 'M' }).success,
    ).toBe(false);
    expect(CharacterDefSchema.safeParse({ ...base, parts: {}, mesh: 'M' }).success).toBe(true);
  });
});

describe('what a creature is drawn as', () => {
  it('names a character that exists, or names none at all', () => {
    const ids = new Set(characters.map((c) => c.id));
    for (const r of roamers) {
      const problems = roamerProblems(r, { itemIds: null, characterIds: ids });
      expect(problems, `${r.id}: ${problems.join('; ')}`).toEqual([]);
    }
  });

  it('FAILS a look that names nothing, rather than falling back quietly', () => {
    // ⚠ The renderer's fallback is deliberate — a missing model draws as a
    // townsman rather than as nothing, because an invisible enemy is worse
    // than a wrong-looking one. But a fallback nothing reports is exactly the
    // state this change existed to leave, so the BUILD is where it is caught.
    const r = RoamerSchema.parse({
      id: 'ghoul', descriptor: 'a thing', hp: 1, damageMin: 1, damageMax: 1,
      character: 'no-such-character',
    });
    expect(roamerProblems(r, { itemIds: null, characterIds: new Set(['goblin']) }))
      .toEqual([
        "is drawn as 'no-such-character', which is not a character in content/characters/",
      ]);
  });

  it('gives every roamer a look, or says in its notes why it has none', () => {
    // ⚠ The packs ship no quadruped — every one of their characters is a biped
    // on the Unreal rig — so the dog and the crawler genuinely cannot be drawn
    // yet. That is allowed and must be WRITTEN DOWN, or the next person reads
    // a missing look as an oversight and draws a dog as a goblin.
    for (const r of roamers) {
      if (r.character) continue;
      expect(r.notes ?? '', `${r.id} has no look and does not say why`).toMatch(/No art|person/i);
    }
  });
});
