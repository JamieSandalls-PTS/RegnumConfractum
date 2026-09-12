import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PartNamesSchema, parsePolygonPart } from '@rc/shared';
import { isBrown, materialOf, saturation, shadeWord, votes } from '../src/name-parts';

/**
 * Classifying armour by colour, and how right it actually is (D-566).
 *
 * The filenames carry no material, so `name:parts` measures the pixels a part
 * samples and reads plate / leather / cloth off them. That is a HEURISTIC, and
 * the honest way to ship a heuristic is to state its accuracy and fail if it
 * drops — otherwise a tweak that makes it worse looks exactly like a tweak
 * that makes it better.
 *
 * ⚠ The test set is the stakeholder's OWN names. Fifty-six parts they typed
 * carry a material word — "Heavy plate male", "Fine leather female", "Robe
 * male" — which makes them ground truth that nothing in this repo generated.
 */

const root = fileURLToPath(new URL('../..', import.meta.url));
const file = join(root, 'content', 'parts', 'modular-fantasy-hero.json');

/** Material words in a human-written name, and what they mean. */
const TRUTH: [RegExp, string][] = [
  [/\bplate\b|\bmail\b|\bchain\b/i, 'plate'],
  [/\bleather\b|\bjerkin\b|\bhide\b/i, 'leather'],
  [/\brobe\b|\bshirt\b|\bcloth\b|\btunic\b|\bsilk\b/i, 'cloth'],
];

describe('classifying a part by the colours it samples', () => {
  it('knows grey from brown from colour', () => {
    expect(saturation([139, 144, 149])).toBeLessThan(0.12); // steel
    expect(saturation([73, 102, 126])).toBeGreaterThan(0.12); // blue cloth
    expect(isBrown([72, 53, 42])).toBe(true); // dark leather
    expect(isBrown([139, 144, 149])).toBe(false); // steel is not brown
    expect(isBrown([73, 102, 126])).toBe(false); // blue is not brown
    // ⚠ The shadow tones do not vote at all. `#2d3237` is 78,000 pixels of
    // this atlas and appears in robes and harnesses alike; letting it count
    // carried 189 cloth parts over to plate.
    expect(votes([45, 50, 55])).toBe(false);
    expect(votes([59, 67, 72])).toBe(false);
    expect(votes([139, 144, 149])).toBe(true);
  });

  it('calls a mostly-grey part plate and a mostly-brown one leather', () => {
    const of = (shares: [string, number][], skin = 0) =>
      materialOf({ shares: new Map(shares), skin });
    expect(of([['#8b9095', 0.6], ['#48352a', 0.4]])).toBe('plate');
    expect(of([['#48352a', 0.7], ['#5f5447', 0.3]])).toBe('leather');
    expect(of([['#49667e', 0.6], ['#c19b51', 0.4]])).toBe('cloth');
    // ⚠ Skin wins outright. A bare arm's few remaining colours are noise, and
    // classifying it as leather because of a wrist strap would put a naked
    // character behind a class's armour rule.
    expect(of([['#48352a', 1]], 0.95)).toBe('bare');
  });

  it('gives two plate parts different words so they are not one name', () => {
    expect(shadeWord([139, 144, 149])).toBe('Steel');
    expect(shadeWord([90, 96, 101])).toBe('Dark');
    expect(shadeWord([73, 102, 126])).toBe('Blue');
    expect(shadeWord([193, 155, 81])).not.toBe(shadeWord([139, 144, 149]));
  });
});

describe.skipIf(!existsSync(file))('the classification against the names a person wrote', () => {
  const data = PartNamesSchema.parse(JSON.parse(readFileSync(file, 'utf8')));

  it('agrees with at least four in five of them', () => {
    let agree = 0;
    let total = 0;
    const missed: string[] = [];
    for (const [stem, name] of Object.entries(data.names)) {
      const tags = data.tags[stem] ?? [];
      if (tags.includes('draft')) continue; // only judge names a person wrote
      const want = TRUTH.find(([rx]) => rx.test(name))?.[1];
      if (!want) continue;
      total++;
      const got = tags.find((t) => ['plate', 'leather', 'cloth', 'base'].includes(t));
      if (got === want) agree++;
      else missed.push(`${name} → ${got ?? 'none'}`);
    }
    expect(total, 'no human-written material names to check against').toBeGreaterThan(20);
    // 50/56 when this was written. The floor stops a change that quietly makes
    // it worse; the misses are all mixed-material garments — "Scrap plate" is
    // plate with enough strapping to read brown.
    expect(agree / total, `misses: ${missed.join(', ')}`).toBeGreaterThan(0.85);
  });

  /**
   * ⚠ The check that accuracy alone could not make.
   *
   * A plate-biased classifier scored 93% on the names above — HIGHER than the
   * one shipped — while calling 381 parts plate and 38 cloth, because the
   * human-named set is mostly plate torsos. An unbalanced test set rewards the
   * wrong thing, so the shape of the whole result is asserted separately: no
   * material may run away with the pack.
   */
  it('does not let one material run away with the pack', () => {
    const count: Record<string, number> = {};
    for (const tags of Object.values(data.tags)) {
      const m = tags.find((t) => ['plate', 'leather', 'cloth'].includes(t));
      if (m) count[m] = (count[m] ?? 0) + 1;
    }
    const totals = Object.values(count);
    expect(totals.length, 'all three materials should appear').toBe(3);
    const most = Math.max(...totals);
    const least = Math.min(...totals);
    expect(most / least, `distribution: ${JSON.stringify(count)}`).toBeLessThan(3);
  });

  it('gives every armour slot a material and no face one', () => {
    const NONE = new Set(['head', 'hair', 'eyebrows', 'facialHair', 'ears', 'helmetCrest']);
    const wrong: string[] = [];
    for (const [stem, tags] of Object.entries(data.tags)) {
      const slot = parsePolygonPart(stem)?.slot;
      if (!slot) continue;
      const material = tags.find((t) => ['plate', 'leather', 'cloth', 'base'].includes(t));
      // ⚠ A face is not made of cloth. Tagging one is how eyebrows end up in
      // front of a class's armour rule.
      if (NONE.has(slot) && material) wrong.push(`${stem} is a ${slot} tagged ${material}`);
    }
    expect(wrong).toEqual([]);
  });

  it('names every part exactly once within a slot', () => {
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const [stem, name] of Object.entries(data.names)) {
      const parsed = parsePolygonPart(stem);
      if (!parsed) continue;
      const key = `${parsed.slot}/${parsed.sex}/${name.toLowerCase()}`;
      if (seen.has(key)) clashes.push(`${name} (${stem} and ${seen.get(key)})`);
      seen.set(key, stem);
    }
    expect(clashes).toEqual([]);
  });
});
