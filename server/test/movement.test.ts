import { describe, expect, it } from 'vitest';
import { MOVE_COOLDOWN_TICKS } from '@rc/shared';
import { World } from '@rc/server/game/world';
import { tinyArea } from './helpers';

function makeWorld() {
  const world = new World();
  world.addArea(tinyArea());
  return world;
}

describe('server-authoritative movement (D-102, D-104)', () => {
  it('applies a move intent one tile per cooldown window', () => {
    const world = makeWorld();
    const { entity } = world.spawn('tiny-test', 'char-1', 'Mover', { x: 1, y: 1 });

    world.setMoveIntent(entity.id, 'e');
    world.step();
    expect(entity.pos).toEqual({ x: 2, y: 1 });

    // Cooldown: an immediate second intent must not move until it elapses.
    world.setMoveIntent(entity.id, 'e');
    world.step();
    expect(entity.pos).toEqual({ x: 2, y: 1 });
    world.step();
    world.step();
    expect(entity.pos).toEqual({ x: 3, y: 1 });
  });

  it('rejects walking into walls and out of bounds, but still turns to face', () => {
    const world = makeWorld();
    const { entity } = world.spawn('tiny-test', 'char-1', 'Wallhugger', { x: 1, y: 1 });
    world.setMoveIntent(entity.id, 'n'); // border wall above
    world.step();
    expect(entity.pos).toEqual({ x: 1, y: 1 });
    expect(entity.facing).toBe('n');
  });

  it('does not cut corners diagonally', () => {
    const world = makeWorld();
    // At (3,1); wall column occupies x=4, rows 2–5. Moving se to (4,2) is a
    // wall; moving to walkable (4,1) then s is legal — but the diagonal from
    // (3,2) to (4,1) would cut the wall corner and must be blocked.
    const { entity } = world.spawn('tiny-test', 'char-1', 'Cutter', { x: 3, y: 2 });
    world.setMoveIntent(entity.id, 'ne'); // target (4,1) walkable, but (4,2) is wall
    world.step();
    expect(entity.pos).toEqual({ x: 3, y: 2 });
  });

  it('spawns at area spawn when requested tile is not walkable', () => {
    const world = makeWorld();
    const { entity } = world.spawn('tiny-test', 'char-1', 'Faller', { x: 4, y: 3 });
    expect(entity.pos).toEqual({ x: 1, y: 1 });
  });

  it('latest intent wins; intents are consumed once applied', () => {
    const world = makeWorld();
    const { entity } = world.spawn('tiny-test', 'char-1', 'Fickle', { x: 2, y: 2 });
    world.setMoveIntent(entity.id, 'e');
    world.setMoveIntent(entity.id, 's');
    world.step();
    expect(entity.pos).toEqual({ x: 2, y: 3 });
    for (let i = 0; i < MOVE_COOLDOWN_TICKS + 1; i++) world.step();
    // No further intent — must not keep walking.
    expect(entity.pos).toEqual({ x: 2, y: 3 });
  });

  it('emits entity_moved events only for actual moves, per area', () => {
    const world = makeWorld();
    const a = world.spawn('tiny-test', 'char-a', 'Alpha', { x: 1, y: 1 }).entity;
    const b = world.spawn('tiny-test', 'char-b', 'Beta', { x: 2, y: 6 }).entity;
    world.setMoveIntent(a.id, 'n'); // blocked
    world.setMoveIntent(b.id, 'e');
    const events = world.step().get('tiny-test')!;
    expect(events).toEqual([{ type: 'entity_moved', id: b.id, x: 3, y: 6, facing: 'e' }]);
  });
});
