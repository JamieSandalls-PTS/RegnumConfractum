import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DUNGEON_FLOOR_OPENS_ON_DAY,
  ROUND_DAY_TICKS,
  ROUND_LENGTH_TICKS,
  dungeonEntranceOpen,
  dungeonFloorOpen,
  isNight,
  roundDay,
  type AreaDef,
} from '@rc/shared';
import { loadContent } from '@rc/server/content';

/**
 * The dungeon's floors and their gates (D-535).
 *
 * The whole reason floors exist is that a space cannot be reshaped while
 * somebody is standing in it. Revealing a new floor needs nothing, because
 * nobody was ever in it — so what these assertions protect is the SCHEDULE
 * and the seal, not the geometry.
 */

const content = loadContent(fileURLToPath(new URL('../../content', import.meta.url)));
const area = (id: string): AreaDef => {
  const a = content.areas.get(id);
  if (!a) throw new Error(`missing area ${id}`);
  return a;
};
const FLOORS = ['round-dungeon-1', 'round-dungeon-2', 'round-dungeon-3'] as const;

describe('three floors, going down', () => {
  it('numbers them, and keeps every one out of the sky and out of endgame', () => {
    FLOORS.forEach((id, i) => {
      const a = area(id);
      expect(a.dungeonFloor).toBe(i + 1);
      // No sky: no roamers, and no night bonus for hiding underground (D-528).
      expect(a.outdoor).toBe(false);
      // NEVER endgame — a round death must not cost a persistent character.
      expect(a.zone).toBe('wilderness');
    });
  });

  it('chains them, with only the first reachable from the surface', () => {
    expect(area('round-south').transitions.some((t) => t.toArea === 'round-dungeon-1')).toBe(true);
    for (const id of ['round-dungeon-2', 'round-dungeon-3']) {
      expect(area('round-south').transitions.some((t) => t.toArea === id)).toBe(false);
    }
    expect(area('round-dungeon-1').transitions.some((t) => t.toArea === 'round-dungeon-2')).toBe(true);
    expect(area('round-dungeon-2').transitions.some((t) => t.toArea === 'round-dungeon-3')).toBe(true);
    // And the bottom is the bottom.
    expect(area('round-dungeon-3').transitions.every((t) => t.toArea === 'round-dungeon-2')).toBe(true);
  });

  it('gets tighter as it goes down', () => {
    const walkable = (a: AreaDef) =>
      a.tiles.join('').split('').filter((ch) => a.legend[ch]?.walkable).length;
    expect(walkable(area('round-dungeon-2'))).toBeLessThan(walkable(area('round-dungeon-1')));
    expect(walkable(area('round-dungeon-3'))).toBeLessThan(walkable(area('round-dungeon-2')));
  });
});

describe('floors open on successive days', () => {
  const day = (n: number) => (n - 1) * ROUND_DAY_TICKS + ROUND_DAY_TICKS / 4;

  it('opens the first at once and the others on their dawns', () => {
    expect(DUNGEON_FLOOR_OPENS_ON_DAY).toEqual({ 1: 1, 2: 2, 3: 3 });
    expect(dungeonFloorOpen(1, 0)).toBe(true);
    expect(dungeonFloorOpen(2, 0)).toBe(false);
    expect(dungeonFloorOpen(3, 0)).toBe(false);
    expect(dungeonFloorOpen(2, day(2))).toBe(true);
    expect(dungeonFloorOpen(3, day(2))).toBe(false);
    expect(dungeonFloorOpen(3, day(3))).toBe(true);
  });

  it('counts round-days from the opening dawn', () => {
    expect(roundDay(0)).toBe(1);
    expect(roundDay(ROUND_DAY_TICKS - 1)).toBe(1);
    expect(roundDay(ROUND_DAY_TICKS)).toBe(2);
  });

  it("leaves the deepest floor open for exactly the round's last daylight", () => {
    // Floor 3 opens at the third dawn, 12,000 ticks in, and a 25-minute round
    // is 15,000 — so it is reachable for precisely the closing day phase and
    // not one minute of night. Five real minutes to go down, take what is
    // there, and get back up before the round decides itself. A climax you
    // cannot fully exploit is what makes it tempting.
    const opensAt = (DUNGEON_FLOOR_OPENS_ON_DAY[3]! - 1) * ROUND_DAY_TICKS;
    expect(opensAt).toBe(12_000);
    expect(ROUND_LENGTH_TICKS - opensAt).toBe(ROUND_DAY_TICKS / 2);
    // And it is daylight throughout that window, so the entrance is open.
    expect(dungeonEntranceOpen(opensAt)).toBe(true);
    expect(dungeonEntranceOpen(ROUND_LENGTH_TICKS - 1)).toBe(true);
  });
});

describe('the entrance seals at dusk (stakeholder option 2)', () => {
  it('is open by day and shut by night', () => {
    for (let t = 0; t < ROUND_DAY_TICKS; t += 25) {
      // The seal tracks night exactly — one rule, not two that can drift.
      expect(dungeonEntranceOpen(t)).toBe(!isNight(t));
    }
  });

  it('shuts for exactly half the cycle', () => {
    let shut = 0;
    for (let t = 0; t < ROUND_DAY_TICKS; t++) if (!dungeonEntranceOpen(t)) shut++;
    expect(shut).toBe(ROUND_DAY_TICKS / 2);
  });
});
