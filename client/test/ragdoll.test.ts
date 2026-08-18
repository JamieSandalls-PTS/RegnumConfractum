import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Ragdoll, type JointName } from '../src/render/ragdoll';

/**
 * The ragdoll is pure maths — particles and constraints, no DOM and no
 * WebGL — so it is exactly the kind of "logic that must run headlessly"
 * D-114 demands. These tests pin the properties a falling body must have:
 * it goes down, it stays out of the floor, it does not fly away, it keeps
 * its bones the length they started, and it eventually stops.
 */

/** A roughly person-shaped set of joints, standing at the origin. */
function standing(): Record<JointName, THREE.Vector3> {
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  return {
    pelvis: v(0, 0.95, 0),
    chest: v(0, 1.32, 0),
    head: v(0, 1.62, 0),
    shoulderL: v(0.18, 1.42, 0),
    elbowL: v(0.2, 1.12, 0),
    handL: v(0.21, 0.84, 0),
    shoulderR: v(-0.18, 1.42, 0),
    elbowR: v(-0.2, 1.12, 0),
    handR: v(-0.21, 0.84, 0),
    hipL: v(0.09, 0.95, 0),
    kneeL: v(0.1, 0.5, 0),
    footL: v(0.1, 0.06, 0),
    hipR: v(-0.09, 0.95, 0),
    kneeR: v(-0.1, 0.5, 0),
    footR: v(-0.1, 0.06, 0),
  };
}

const ALL: JointName[] = [
  'pelvis', 'chest', 'head', 'shoulderL', 'elbowL', 'handL',
  'shoulderR', 'elbowR', 'handR', 'hipL', 'kneeL', 'footL',
  'hipR', 'kneeR', 'footR',
];

/** Runs the sim to rest (or the cap) and reports how long it took. */
function settle(doll: Ragdoll, maxSeconds = 12): number {
  let elapsed = 0;
  while (elapsed < maxSeconds && !doll.settled) {
    doll.step(1 / 60, 0);
    elapsed += 1 / 60;
  }
  return elapsed;
}

describe('the ragdoll falls', () => {
  it('drops the body to the ground and comes to rest', () => {
    const doll = new Ragdoll(standing(), 0.35, new THREE.Vector3());
    const took = settle(doll);
    expect(doll.settled, 'a body must stop moving eventually').toBe(true);
    expect(took).toBeGreaterThan(0.5); // it did not "settle" before falling
    // Everything ends up low: a standing head is at 1.62, a fallen one is not.
    expect(doll.position('head').y).toBeLessThan(0.6);
    expect(doll.position('pelvis').y).toBeLessThan(0.6);
  });

  it('never lets any part sink through the floor', () => {
    const doll = new Ragdoll(standing(), 0.35, new THREE.Vector3(2, 0, 0));
    for (let i = 0; i < 600; i++) {
      doll.step(1 / 60, 0);
      for (const j of ALL) {
        expect(doll.position(j).y, `${j} went through the floor`).toBeGreaterThan(-0.02);
      }
    }
  });

  it('keeps its bones the length they started — no stretching', () => {
    const start = standing();
    const doll = new Ragdoll(start, 0.35, new THREE.Vector3(3, 0, 1));
    const spine0 = start.pelvis.distanceTo(start.chest);
    const thigh0 = start.hipL.distanceTo(start.kneeL);
    settle(doll);
    const spine1 = doll.position('pelvis').distanceTo(doll.position('chest'));
    const thigh1 = doll.position('hipL').distanceTo(doll.position('kneeL'));
    // Verlet constraints are iterative, so allow a little give — but a
    // body whose spine doubled in length is a broken ragdoll, not a soft one.
    expect(Math.abs(spine1 - spine0)).toBeLessThan(spine0 * 0.2);
    expect(Math.abs(thigh1 - thigh0)).toBeLessThan(thigh0 * 0.2);
  });

  it('a struck body travels with the blow; an unstruck one drops in place', () => {
    const struck = new Ragdoll(standing(), 0.35, new THREE.Vector3(0, 0, 4));
    const dropped = new Ragdoll(standing(), 0.35, new THREE.Vector3());
    settle(struck);
    settle(dropped);
    // The shove was along +z, so the struck body must end further along it.
    expect(struck.position('chest').z).toBeGreaterThan(dropped.position('chest').z + 0.2);
    // …and it must not have been launched into the next area.
    expect(Math.abs(struck.position('chest').z)).toBeLessThan(3);
  });

  it('falls away from the blow whichever way it was struck', () => {
    const east = new Ragdoll(standing(), 0.35, new THREE.Vector3(4, 0, 0));
    const west = new Ragdoll(standing(), 0.35, new THREE.Vector3(-4, 0, 0));
    settle(east);
    settle(west);
    expect(east.position('chest').x).toBeGreaterThan(0);
    expect(west.position('chest').x).toBeLessThan(0);
  });

  it('stops costing anything once settled', () => {
    const doll = new Ragdoll(standing(), 0.35, new THREE.Vector3());
    settle(doll);
    const before = doll.position('head').clone();
    for (let i = 0; i < 120; i++) doll.step(1 / 60, 0);
    // A settled corpse lies still for fifteen minutes (D-511): no drift.
    expect(doll.position('head').distanceTo(before)).toBe(0);
  });
});
