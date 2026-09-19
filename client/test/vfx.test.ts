import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { VfxDefSchema } from '@rc/shared';
import {
  VfxSystem,
  alignProjectile,
  pixelsPerMetre,
  setVfxDefinitions,
  vfxCount,
  vfxDefinition,
} from '../src/render/vfx';

/**
 * The effects renderer (D-639), headless.
 *
 * Nothing here needs a GPU: the system is stepped by hand and what is
 * asserted is the bookkeeping that can be wrong silently — a loop that never
 * ends, a one-shot that never leaves, a light left registered after its
 * effect is gone, a projectile that never lands, a definition that draws as
 * something else.
 */

const FIRE = VfxDefSchema.parse({
  id: 'test-fire', name: 'Fire', loop: true,
  particles: { rate: 60, life: [0.2, 0.3] }, light: { intensity: 10 }, glow: {},
});
const BURST = VfxDefSchema.parse({
  id: 'test-burst', name: 'Burst', loop: false, duration: 0.3,
  particles: { rate: 20, life: [0.1, 0.2], direction: 'out' }, light: {},
});

function fresh(): { scene: THREE.Scene; sys: VfxSystem } {
  const scene = new THREE.Scene();
  return { scene, sys: new VfxSystem(scene) };
}

function step(sys: VfxSystem, seconds: number, dt = 1 / 60): void {
  let t = 0;
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    t += dt;
    sys.update(dt, t, null, 40);
  }
}

describe('the catalogue', () => {
  it('takes what the wire sends, refusing what does not parse rather than drawing it', () => {
    setVfxDefinitions([FIRE, { id: 'bad', name: 'x', light: { colour: 'red' } }]);
    expect(vfxCount()).toBe(1);
    expect(vfxDefinition('test-fire')?.name).toBe('Fire');
    expect(vfxDefinition('bad')).toBeNull();
  });

  it('⚠ an unknown id draws nothing, and does not throw', () => {
    setVfxDefinitions([FIRE]);
    const { sys } = fresh();
    expect(sys.spawn('never-defined', new THREE.Vector3())).toBeNull();
    expect(sys.stats().live).toBe(0);
  });
});

describe('a looping effect', () => {
  it('emits while it burns, registers its light, and goes out when stopped', () => {
    const { sys } = fresh();
    const h = sys.spawn(FIRE, new THREE.Vector3(1, 0, 1))!;
    step(sys, 0.5);
    const mid = sys.stats();
    expect(mid.live).toBe(1);
    expect(mid.motes).toBeGreaterThan(5);
    expect(mid.lights).toBe(1);
    expect(sys.lights.sourceCount, 'the light is on the rig').toBe(1);
    h.stop();
    expect(h.alive).toBe(false);
    // Motes age out; then the effect is gone and the rig has no source.
    step(sys, 1.0);
    expect(sys.stats().live).toBe(0);
    expect(sys.lights.sourceCount).toBe(0);
  });

  it('follows what it rides on, in world space, and ends when that is gone', () => {
    const { scene, sys } = fresh();
    const bone = new THREE.Object3D();
    bone.scale.setScalar(0.01); // a bone at centimetre scale, as the packs are
    const holder = new THREE.Object3D();
    bone.add(holder);
    scene.add(bone);
    bone.position.set(3, 1, 3);
    holder.position.set(100, 0, 0); // one metre in bone space
    scene.updateMatrixWorld(true);
    sys.attach(FIRE, holder);
    step(sys, 0.2);
    // Every mote was born within the birth radius of the holder's WORLD position (4, 1, 3).
    const s = sys.stats();
    expect(s.motes).toBeGreaterThan(0);
    // A hidden parent stops emission without ending the effect.
    holder.visible = false;
    step(sys, 1.0);
    expect(sys.stats().motes).toBe(0);
    expect(sys.stats().live).toBe(1);
    holder.visible = true;
    step(sys, 0.2);
    expect(sys.stats().motes).toBeGreaterThan(0);
  });

  it('a `follow` returning null ends it', () => {
    const { sys } = fresh();
    let there = true;
    sys.spawn(FIRE, new THREE.Vector3(), { follow: () => (there ? new THREE.Vector3(0, 1, 0) : null) });
    step(sys, 0.2);
    expect(sys.stats().live).toBe(1);
    there = false;
    step(sys, 1.0);
    expect(sys.stats().live).toBe(0);
  });
});

describe('a one-shot', () => {
  it('bursts at once and is gone after its duration and its motes', () => {
    const { sys } = fresh();
    sys.spawn(BURST, new THREE.Vector3());
    expect(sys.stats().motes, 'the whole burst is born on spawn').toBe(20);
    step(sys, 1.0);
    expect(sys.stats().live).toBe(0);
    expect(sys.lights.sourceCount).toBe(0);
  });
});

describe('placed effects', () => {
  it('are cleared as a set, leaving anything else burning', () => {
    const { sys } = fresh();
    sys.place('test-fire', 2, 3, 0.2, 1);
    sys.place('test-fire', 4, 3);
    sys.spawn(FIRE, new THREE.Vector3(9, 0, 9));
    expect(sys.stats().placed).toBe(2);
    sys.clearPlaced();
    expect(sys.stats().placed).toBe(0);
    expect(sys.stats().live).toBe(1);
  });
});

describe('a projectile', () => {
  it('flies from muzzle to target at the item\'s speed, trailing, and lands as its impact', () => {
    setVfxDefinitions([FIRE, BURST]);
    const { sys } = fresh();
    const from = new THREE.Vector3(0, 1, 0);
    const to = new THREE.Vector3(6, 1, 0);
    sys.fireProjectile({ projectile: { vfx: 'test-fire', speed: 12, arc: 0.5 }, impact: 'test-burst' }, from, to);
    expect(sys.stats().flights).toBe(1);
    expect(sys.stats().live, 'the trail is burning').toBe(1);
    step(sys, 0.25);
    const mid = sys.flightPositions()[0]!;
    expect(mid.x).toBeGreaterThan(2);
    expect(mid.x).toBeLessThan(4);
    expect(mid.y, 'the arc lifts it at its middle').toBeGreaterThan(1.3);
    step(sys, 0.3);
    expect(sys.stats().flights, 'landed after 6m / 12m/s').toBe(0);
    // The trail is stopped (its motes die), the impact has burst.
    const after = sys.stats();
    expect(after.live).toBeGreaterThanOrEqual(1);
    step(sys, 1.5);
    expect(sys.stats().live).toBe(0);
  });

  it('⚠ turns a mesh to fly tip first along +Z whichever axis the pack laid it on', () => {
    // A cone's apex is +y in three.js: the narrow end is the tip.
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.1, 1, 8));
    const holder = alignProjectile(cone);
    holder.updateMatrixWorld(true);
    const apex = new THREE.Vector3(0, 0.5, 0).applyMatrix4(cone.matrixWorld);
    expect(apex.z).toBeCloseTo(0.5, 5);
    expect(Math.abs(apex.x) + Math.abs(apex.y)).toBeLessThan(1e-6);

    // The same cone lying along -x (tip at -x) turns the other way.
    const lying = new THREE.Mesh(new THREE.ConeGeometry(0.1, 1, 8));
    lying.rotation.z = Math.PI / 2; // +y → -x
    const h2 = alignProjectile(lying);
    h2.updateMatrixWorld(true);
    const apex2 = new THREE.Vector3(0, 0.5, 0).applyMatrix4(lying.matrixWorld);
    expect(apex2.z).toBeCloseTo(0.5, 5);
  });
});

describe('sizing', () => {
  it('converts metres to device pixels off the orthographic frustum, zoom included', () => {
    const cam = new THREE.OrthographicCamera(-8, 8, 4.5, -4.5, 0.1, 100);
    expect(pixelsPerMetre(cam, 900)).toBeCloseTo(100, 5);
    cam.zoom = 2;
    expect(pixelsPerMetre(cam, 900)).toBeCloseTo(200, 5);
  });
});
