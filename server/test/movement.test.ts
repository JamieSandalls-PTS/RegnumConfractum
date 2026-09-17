import { describe, expect, it } from 'vitest';
import { RUN_SPEED, TICK_RATE, WALK_SPEED, distance } from '@rc/shared';
import { World } from '@rc/server/game/world';
import { tinyArea } from './helpers';

/**
 * Server-authoritative movement, in METRES (D-102, D-567).
 *
 * ⚠ This file used to assert the tile contract — "one tile per cooldown
 * window" — and every assertion in it changed with D-567. It is rewritten
 * rather than patched, because the thing being tested is different: movement
 * is now continuous, the server owns the ROUTE as well as the step, and the
 * question "did it arrive" has become "did it get there without passing
 * through anything".
 */

function makeWorld() {
  const world = new World();
  world.addArea(tinyArea());
  return world;
}

/** Ticks to cover a distance at walking pace, with one to spare. */
function ticksFor(metres: number): number {
  return Math.ceil((metres / WALK_SPEED) * TICK_RATE) + 1;
}

describe('a direction is one stride, walked smoothly', () => {
  it('arrives exactly one metre on, over several ticks rather than one', () => {
    const world = makeWorld();
    const { entity } = world.spawn('tiny-test', {
      characterId: 'char-1',
      name: 'Mover',
      pos: { x: 1, y: 1 },
    });

    world.setMoveIntent(entity.id, 'e');
    world.step();
    // ⚠ Part way, not there. The tile version arrived on the first tick and
    // then waited out a cooldown; if this ever equals 2 again, movement has
    // quietly gone back to teleporting between lattice points.
    expect(entity.pos.x).toBeGreaterThan(1);
    expect(entity.pos.x).toBeLessThan(2);

    for (let i = 0; i < ticksFor(1); i++) world.step();
    expect(entity.pos.x).toBeCloseTo(2, 6);
    expect(entity.pos.y).toBeCloseTo(1, 6);
  });

  it('stops when the stride is done, and does not drift on', () => {
    const world = makeWorld();
    const { entity } = world.spawn('tiny-test', {
      characterId: 'char-1',
      name: 'Fickle',
      pos: { x: 2, y: 2 },
    });
    // The later intent replaces the earlier one outright.
    world.setMoveIntent(entity.id, 'e');
    world.setMoveIntent(entity.id, 's');
    for (let i = 0; i < ticksFor(1); i++) world.step();
    expect(entity.pos.x).toBeCloseTo(2, 6);
    expect(entity.pos.y).toBeCloseTo(3, 6);

    const settled = { ...entity.pos };
    for (let i = 0; i < 20; i++) world.step();
    expect(entity.pos).toEqual(settled);
  });

  it('⚠ a diagonal covers 1.41m and therefore takes longer', () => {
    // The grid gave diagonals away free — a diagonal tile step was 1.41m in
    // the same three ticks as a 1m cardinal one. Keeping the destination on
    // the lattice is what lets a caller counting in whole steps still work.
    const world = makeWorld();
    const { entity } = world.spawn('tiny-test', {
      characterId: 'char-1',
      name: 'Diagonal',
      pos: { x: 2, y: 2 },
    });
    world.setMoveIntent(entity.id, 'se');
    for (let i = 0; i < ticksFor(Math.SQRT2); i++) world.step();
    expect(entity.pos.x).toBeCloseTo(3, 6);
    expect(entity.pos.y).toBeCloseTo(3, 6);
  });

  it('rejects walking into a wall, but still turns to face it', () => {
    const world = makeWorld();
    const { entity } = world.spawn('tiny-test', {
      characterId: 'char-1',
      name: 'Wallhugger',
      pos: { x: 1, y: 1 },
    });
    world.setMoveIntent(entity.id, 'n'); // border wall above
    for (let i = 0; i < ticksFor(1); i++) world.step();
    expect(entity.pos.y).toBeCloseTo(1, 6);
    // Facing is set on INTENT, not on arrival: turning to look at a wall you
    // cannot walk into is how a player learns the wall is there.
    expect(entity.facing).toBe('n');
  });

  it('does not cut the corner of a wall', () => {
    const world = makeWorld();
    // The wall column occupies x=4, rows 2–5. From (3,2), a diagonal to (4,1)
    // grazes that column's corner, and a body has width.
    const { entity } = world.spawn('tiny-test', {
      characterId: 'char-1',
      name: 'Cutter',
      pos: { x: 3, y: 2 },
    });
    world.setMoveIntent(entity.id, 'ne');
    for (let i = 0; i < ticksFor(Math.SQRT2); i++) world.step();
    expect(distance(entity.pos, { x: 4, y: 1 })).toBeGreaterThan(0.2);
  });

  it('spawns at the area spawn when the requested spot is not standable', () => {
    const world = makeWorld();
    const { entity } = world.spawn('tiny-test', {
      characterId: 'char-1',
      name: 'Faller',
      pos: { x: 4, y: 3 },
    });
    expect(entity.pos).toEqual({ x: 1, y: 1 });
  });

  it('emits entity_moved only for what actually moved, per area', () => {
    const world = makeWorld();
    const a = world.spawn('tiny-test', {
      characterId: 'char-a',
      name: 'Alpha',
      pos: { x: 1, y: 1 },
    }).entity;
    const b = world.spawn('tiny-test', {
      characterId: 'char-b',
      name: 'Beta',
      pos: { x: 2, y: 6 },
    }).entity;
    world.setMoveIntent(a.id, 'n'); // blocked by the border wall
    world.setMoveIntent(b.id, 'e');
    const events = world.step().get('tiny-test')!;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'entity_moved', id: b.id, facing: 'e', z: 0 });
  });
});

describe('the server owns the route (D-567)', () => {
  it('walks around a wall to somewhere it cannot see', () => {
    const world = makeWorld();
    const { entity } = world.spawn('tiny-test', {
      characterId: 'char-1',
      name: 'Router',
      pos: { x: 2, y: 3 },
    });
    // The far side of the wall column, reachable only round one end.
    expect(world.moveTo(entity.id, { x: 6, y: 3 })).toBe(true);
    for (let i = 0; i < 400; i++) world.step();
    expect(distance(entity.pos, { x: 6, y: 3 })).toBeLessThan(0.6);
  });

  it('⚠ never passes through the wall it went around', () => {
    // The assertion that matters: a route that teleports through masonry
    // arrives just as fast and looks identical in a position check.
    const world = makeWorld();
    const { entity } = world.spawn('tiny-test', {
      characterId: 'char-1',
      name: 'Router',
      pos: { x: 2, y: 3 },
    });
    world.moveTo(entity.id, { x: 6, y: 3 });
    for (let i = 0; i < 400; i++) {
      world.step();
      // x=4 rows 2–5 is wall; a body must never be inside it.
      const inWall =
        entity.pos.x > 3.5 && entity.pos.x < 4.5 && entity.pos.y > 1.5 && entity.pos.y < 5.5;
      expect(inWall, `walked into the wall at ${entity.pos.x},${entity.pos.y}`).toBe(false);
    }
  });

  it('refuses a destination with no way to it', () => {
    const world = makeWorld();
    const { entity } = world.spawn('tiny-test', {
      characterId: 'char-1',
      name: 'Router',
      pos: { x: 2, y: 3 },
    });
    // Outside the map entirely.
    expect(world.moveTo(entity.id, { x: 40, y: 40 })).toBe(false);
  });

  it('stops on request, wherever it has got to', () => {
    const world = makeWorld();
    const { entity } = world.spawn('tiny-test', {
      characterId: 'char-1',
      name: 'Router',
      pos: { x: 2, y: 3 },
    });
    world.moveTo(entity.id, { x: 6, y: 3 });
    for (let i = 0; i < 4; i++) world.step();
    world.stopMoving(entity.id);
    const where = { ...entity.pos };
    for (let i = 0; i < 20; i++) world.step();
    expect(entity.pos).toEqual(where);
  });
});

describe('a weapon up is a run (D-619)', () => {
  it('covers more ground in one tick than the same body walking', () => {
    const world = makeWorld();
    const walker = world.spawn('tiny-test', {
      characterId: 'char-walk',
      name: 'Walker',
      pos: { x: 1, y: 1 },
    }).entity;
    const runner = world.spawn('tiny-test', {
      characterId: 'char-run',
      name: 'Runner',
      pos: { x: 1, y: 2 },
    }).entity;
    // ⚠ The entity's OWN combat flag, which the gateway owns and
    // broadcasts. There is no run key and no client-side speed: you run
    // because your weapon is out, so every observer sees the same pace.
    runner.combat = true;

    const walkFrom = { ...walker.pos };
    const runFrom = { ...runner.pos };
    world.setMoveIntent(walker.id, 'e');
    world.setMoveIntent(runner.id, 'e');
    world.step();

    const walked = distance(walkFrom, walker.pos);
    const ran = distance(runFrom, runner.pos);
    expect(ran).toBeGreaterThan(walked);
    expect(ran / walked).toBeCloseTo(RUN_SPEED / WALK_SPEED, 2);
    expect(walked).toBeCloseTo(WALK_SPEED / TICK_RATE, 5);
    expect(ran).toBeCloseTo(RUN_SPEED / TICK_RATE, 5);
  });

  it('sheathing puts the same body back to a walk', () => {
    const world = makeWorld();
    const { entity } = world.spawn('tiny-test', {
      characterId: 'char-1',
      name: 'Mover',
      pos: { x: 1, y: 1 },
    });
    entity.combat = true;
    world.setMoveIntent(entity.id, 'e');
    world.step();
    const fast = entity.pos.x - 1;
    entity.combat = false;
    const before = entity.pos.x;
    world.setMoveIntent(entity.id, 'e');
    world.step();
    expect(entity.pos.x - before).toBeLessThan(fast);
  });
});
