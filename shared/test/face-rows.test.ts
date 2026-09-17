import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  RaceSchema,
  defaultLookParts,
  faceRows,
  type RaceDef,
} from '../src/index';

/**
 * What the character creator actually offers (D-601).
 *
 * ⚠ Asserted against the SHIPPED races, not a fixture. The thing that goes
 * wrong here is not the algorithm — it is the join between what a race
 * curates and what the screen thinks to ask about, and a fixture cannot see
 * that. `facialHair` was curated eighteen deep by the human race, named,
 * built, exported, and offered to nobody for as long as the screen carried a
 * hard-coded list of four slots.
 *
 * ⚠ These are decisions, not rendering. The doctrine forbids logic that can
 * only be exercised through a browser, and "can a player make a woman with a
 * beard" is exactly the kind of question that is invisible until somebody
 * looks.
 */

const contentDir = fileURLToPath(new URL('../../content', import.meta.url));

function races(): RaceDef[] {
  const dir = join(contentDir, 'races');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => RaceSchema.parse(JSON.parse(readFileSync(join(dir, f), 'utf8'))));
}

const ALL = races();
const human = ALL.find((r) => r.id === 'human');

describe.skipIf(ALL.length === 0)('the rows a player is offered', () => {
  it('offers a row wherever the race curates a real choice', () => {
    for (const race of ALL) {
      for (const sex of ['male', 'female'] as const) {
        const rows = faceRows(race, sex);
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
          // ⚠ A row with one option and no "none" is a menu with no
          // alternative — it reads as a choice the screen is refusing to let
          // you make, which is why the limbs have no row at all.
          expect(row.options.length + (row.optional ? 1 : 0)).toBeGreaterThan(1);
        }
      }
    }
  });

  it('offers NO row for the slots a race curates one of', () => {
    for (const race of ALL) {
      const slots = faceRows(race, 'male').map((r) => r.slot);
      // A race curates one bare option per limb (D-563) — arms, legs and
      // hands are filled in, never asked about.
      expect(slots).not.toContain('armUpperL');
      expect(slots).not.toContain('legL');
      expect(slots).not.toContain('handL');
    }
  });

  it('offers the beards the human race has curated all along', () => {
    // ⚠ The bug this file exists for. 18 facial-hair parts, curated, named
    // and built, and the creation screen never mentioned them because its
    // slot list was written before they were curated.
    const beard = faceRows(human!, 'male').find((r) => r.slot === 'facialHair');
    expect(beard).toBeDefined();
    expect(beard!.options.length).toBeGreaterThan(1);
    expect(beard!.optional).toBe(true);
  });

  it('gives the two bodies DIFFERENT faces, both non-empty', () => {
    for (const race of ALL) {
      const male = faceRows(race, 'male').find((r) => r.slot === 'head');
      const female = faceRows(race, 'female').find((r) => r.slot === 'head');
      expect(male!.options.length).toBeGreaterThan(0);
      expect(female!.options.length).toBeGreaterThan(0);
      expect(male!.options).not.toEqual(female!.options);
      // Neither list may leak the other body's cut into it.
      expect(male!.options.every((s) => !/_Female_/i.test(s))).toBe(true);
      expect(female!.options.every((s) => !/_Male_/i.test(s))).toBe(true);
    }
  });
});

describe.skipIf(ALL.length === 0)('what a player starts with', () => {
  it('opens on a complete body, so the preview is somebody', () => {
    for (const race of ALL) {
      const parts = defaultLookParts(race, 'male');
      // ⚠ A head and a body from the first frame. The screen used to open
      // with an empty look, which is what made it fall back to the procedural
      // cast — the first thing a player saw was a character they will never
      // play as.
      expect(parts.head).toBeDefined();
      expect(parts.torso).toBeDefined();
      expect(parts.legL).toBeDefined();
      expect(parts.handR).toBeDefined();
    }
  });

  it('leaves hair and beard EMPTY rather than choosing for somebody', () => {
    const parts = defaultLookParts(human!, 'male');
    expect(parts.facialHair).toBeUndefined();
    expect(parts.hair).toBeUndefined();
  });

  it('every default is a part the race actually offers', () => {
    // The server refuses a look naming anything the race does not curate
    // (D-574), so a default that were not curated would make the screen
    // produce a character its own server rejects at the last step.
    for (const race of ALL) {
      for (const sex of ['male', 'female'] as const) {
        for (const [slot, stem] of Object.entries(defaultLookParts(race, sex))) {
          expect(race.parts[slot as keyof typeof race.parts] ?? []).toContain(stem);
        }
      }
    }
  });

  it('KEEPS what still fits when the body changes, and replaces what does not', () => {
    const male = defaultLookParts(human!, 'male');
    const chosen = { ...male, hair: human!.parts.hair![0]! };
    const female = defaultLookParts(human!, 'female', chosen);
    // Hair is cut once for both bodies, so it survives.
    expect(female.hair).toBe(chosen.hair);
    // The torso is cut twice, so it is replaced with the other cut.
    expect(female.torso).not.toBe(male.torso);
    expect(/_Female_/i.test(female.torso!)).toBe(true);
  });
});
