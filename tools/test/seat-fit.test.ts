import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { AreaSchema, AssetFileSchema } from '@rc/shared';
import { measureSeat } from '../src/measure-seat';

/**
 * A stool is the height a body sits on (D-648).
 *
 * The stakeholder found the taproom's stools too big twice, by eye, and the
 * second resize still left the body sitting inside them. This measures the
 * built character in the sitting clip — the lowest skin under the pelvis —
 * and holds every STOOL placed in every area to it. Stools only: a chair's
 * mesh height is its backrest, not its seat, and nothing in the catalogue
 * says where a chair's seat is.
 */

const content = fileURLToPath(new URL('../../content', import.meta.url));
let contact = 0;

beforeAll(async () => {
  contact = (await measureSeat('ashfold-townsfolk')).contact;
}, 60_000);

function catalogue(): Map<string, { size?: [number, number, number]; placeScale: number }> {
  const out = new Map<string, { size?: [number, number, number]; placeScale: number }>();
  for (const f of readdirSync(`${content}/assets`).filter((x) => x.endsWith('.environment.json'))) {
    const file = AssetFileSchema.parse(JSON.parse(readFileSync(`${content}/assets/${f}`, 'utf8')));
    for (const a of file.assets) {
      if (a.kind === 'environment') out.set(`${a.pack}/${a.id}`, { size: a.size, placeScale: a.placeScale });
    }
  }
  return out;
}

describe('stools fit the sitting body (D-648)', () => {
  it('the sitting clip rests a 1.7m body about 30cm off the floor', () => {
    expect(contact).toBeGreaterThan(0.25);
    expect(contact).toBeLessThan(0.35);
  });

  it('⚠ every stool placed in every area has its seat at the body, not above it', () => {
    const cat = catalogue();
    const wrong: string[] = [];
    for (const f of readdirSync(`${content}/areas`).filter((x) => x.endsWith('.json'))) {
      const area = AreaSchema.parse(JSON.parse(readFileSync(`${content}/areas/${f}`, 'utf8')));
      for (const a of area.assets) {
        if (!a.seat || !/stool/.test(a.asset)) continue;
        const size = cat.get(`${a.pack}/${a.asset}`)?.size;
        if (!size) continue;
        const top = size[1] * a.scale;
        // A centimetre or two of give either way reads as resting; more
        // above the body is the body sunk into the seat.
        if (top > contact + 0.04 || top < contact - 0.03) {
          wrong.push(`${area.id}: ${a.asset} at (${a.x},${a.y}) seat ${(top * 100).toFixed(0)}cm vs body ${(contact * 100).toFixed(0)}cm`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it('a stool newly placed starts at that height too', () => {
    for (const [key, a] of catalogue()) {
      if (!/stool/.test(key) || !a.size) continue;
      const top = a.size[1] * a.placeScale;
      expect(top, key).toBeLessThan(contact + 0.04);
      expect(top, key).toBeGreaterThan(contact - 0.03);
    }
  });
});
