import { describe, expect, it } from 'vitest';
import {
  ItemVfxSchema,
  PlacedVfxSchema,
  VfxDefSchema,
  attackShowOf,
  itemVfxRefs,
  vfxReferenceProblems,
} from '../src/vfx';

/**
 * Effects as content (D-639): the shape, and the two rules the build and
 * the server enforce on top of it — what a blow SHOWS is resolved off the
 * item, and every reference must name an effect that exists.
 */
describe('a VFX definition', () => {
  it('fills every knob with a default, so an author can start from {}', () => {
    const d = VfxDefSchema.parse({ id: 'fire', name: 'Fire', particles: {}, light: {}, glow: {} });
    expect(d.loop).toBe(true);
    expect(d.particles?.direction).toBe('up');
    expect(d.particles?.colour).toHaveLength(2);
    expect(d.light?.flicker.amount).toBeGreaterThan(0);
    expect(d.glow?.radius).toBeGreaterThan(0);
  });

  it('refuses a colour that is not #rrggbb, and a range written high first', () => {
    expect(VfxDefSchema.safeParse({ id: 'x', name: 'x', light: { colour: 'orange' } }).success).toBe(false);
    expect(VfxDefSchema.safeParse({ id: 'x', name: 'x', particles: { life: [2, 1] } }).success).toBe(false);
  });

  it('refuses an id that is not content-id shaped', () => {
    expect(VfxDefSchema.safeParse({ id: 'Hearth Fire', name: 'x' }).success).toBe(false);
  });

  it('a placement carries only where and how big', () => {
    const p = PlacedVfxSchema.parse({ vfx: 'fire', x: 3, y: 4 });
    expect(p.z).toBe(0);
    expect(p.scale).toBe(1);
  });
});

describe('what an item shows', () => {
  it('⚠ a projectile is what makes a weapon fire rather than swing', () => {
    const v = ItemVfxSchema.parse({ projectile: { asset: 'bow-crossbow/arrow-01' } });
    expect(v.projectile?.speed).toBeGreaterThan(0);
    expect(v.projectile?.arc).toBeGreaterThanOrEqual(0);
    expect(ItemVfxSchema.safeParse({ projectile: { asset: 'arrow-01' } }).success, 'pack/asset, not a bare id').toBe(false);
  });

  it('resolves to what the wire carries, and to nothing when there is nothing to show', () => {
    expect(attackShowOf(undefined)).toBeUndefined();
    expect(attackShowOf(ItemVfxSchema.parse({ held: 'ember-glow' })), 'a held glow is not an attack').toBeUndefined();
    const show = attackShowOf(ItemVfxSchema.parse({
      attack: 'flare', projectile: { vfx: 'bolt', speed: 12, arc: 0.3 }, impact: 'burst',
    }));
    expect(show).toEqual({ attack: 'flare', projectile: { vfx: 'bolt', speed: 12, arc: 0.3 }, impact: 'burst' });
  });

  it('lists every effect an item names, by field', () => {
    const refs = itemVfxRefs('staff', ItemVfxSchema.parse({
      held: 'glow', attack: 'flare', projectile: { vfx: 'bolt' }, impact: 'burst',
    }));
    expect(refs.map((r) => r.vfx).sort()).toEqual(['bolt', 'burst', 'flare', 'glow']);
    expect(refs.every((r) => r.where.startsWith("item 'staff'"))).toBe(true);
  });

  it('⚠ names what does not exist, so a renamed effect is a build error and not a dark hearth', () => {
    const problems = vfxReferenceProblems(new Set(['glow']), [
      { where: "item 'staff' held", vfx: 'glow' },
      { where: "area 'tavern' vfx[0]", vfx: 'hearth-fire' },
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("area 'tavern' vfx[0]");
    expect(problems[0]).toContain("'hearth-fire'");
  });
});
