import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BOT_ROLES } from '@rc/shared';
import { loadContent } from '@rc/server/content';

/**
 * The companions a lobby can summon are CONTENT (D-624).
 *
 * The roster was eleven names and six roles hardcoded in
 * `server/src/dev/bots.ts`, which is the thing D-110 exists to prevent and the
 * thing the stakeholder asked for: "the definition of bots needs to be added
 * to the creation tool". A tool cannot edit a TypeScript array.
 */

const content = loadContent(fileURLToPath(new URL('../../content', import.meta.url)));

describe('the authored roster', () => {
  it('is loaded, and every role is one the agent implements', () => {
    expect(content.bots.length).toBeGreaterThanOrEqual(3);
    for (const bot of content.bots) {
      expect(BOT_ROLES).toContain(bot.role);
    }
  });

  it('⚠ draws in the AUTHORED order, not the order files happen to sort in', () => {
    // Definitions are read alphabetically, so relying on the file listing put
    // Bran, Cass and Dorn first. That reads as harmless and is not: see below.
    const drawn = content.bots.map((b) => b.id);
    const alphabetical = [...drawn].sort();
    expect(drawn).not.toEqual(alphabetical);
    const orders = content.bots.map((b) => b.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
  });

  it('⚠ covers the mine, the farm and the WOOD in the first three', () => {
    // D-529's three arms. A cast of three is the floor (D-522), so if the
    // first three summoned leave the farm unworked, hunger looks broken when
    // it is merely unattended — a bug report about the wrong system.
    const first = content.bots.slice(0, 3).map((b) => b.role);
    expect(new Set(first)).toEqual(new Set(['gatherer', 'forager', 'woodsman']));
  });

  it('gives every companion a fixed face', () => {
    // ⚠ Without an authored seed a companion's appearance came from the order
    // it was summoned in, so Dorn was a different stranger depending on how
    // many arrived before him. That is half of what "one of the bots shows up
    // as a goblin" was about; D-618's person-only fallback is the other half.
    for (const bot of content.bots) {
      expect(bot.appearanceSeed, `${bot.id} has no fixed appearance`).toBeDefined();
    }
    const seeds = content.bots.map((b) => b.appearanceSeed);
    expect(new Set(seeds).size).toBe(seeds.length);
  });

  it('keeps names to letters, which is all the wire accepts', () => {
    // ⚠ D-540 lost twenty minutes to a refusal that surfaced as a timeout.
    // The schema refuses it now, so a new companion fails the build instead.
    for (const bot of content.bots) expect(bot.name).toMatch(/^[A-Za-z]+$/);
  });

  it('names a calling and a race only where one exists', () => {
    for (const bot of content.bots) {
      if (bot.classId) expect(content.classes.has(bot.classId)).toBe(true);
      if (bot.raceId) expect(content.races.has(bot.raceId)).toBe(true);
    }
  });
});
