import { describe, expect, it } from 'vitest';
import { VEIL_FADE, easeVeil } from '../src/render/scene';

/**
 * The veil the dead see through (D-621).
 *
 * ⚠ What is testable here is the TIMING, and only the timing. The shader
 * itself needs a GPU, and an assertion that a uniform was written would prove
 * nothing about what is on screen — so the look is verified by the stakeholder
 * looking, and that is said out loud rather than dressed up as coverage
 * (D-114).
 */
describe('easing the veil', () => {
  it('takes about a second to close, and ARRIVES', () => {
    // ⚠ Arrival is the load-bearing half. An exponential ease approaches 1
    // and never reaches it, so `render()`'s cheap path for the living — which
    // tests `veil <= 0.001` — would never come back after a respawn, and the
    // world would stay grey for somebody who is plainly alive.
    let v = 0;
    for (let i = 0; i < 100; i++) v = easeVeil(v, 1, 1 / 60);
    expect(v).toBe(1);
    // And it is not instant: half a fade gets you about halfway.
    let half = 0;
    for (let i = 0; i < 30; i++) half = easeVeil(half, 1, VEIL_FADE / 60);
    expect(half).toBeGreaterThan(0.35);
    expect(half).toBeLessThan(0.65);
  });

  it('lifts all the way back to nothing', () => {
    let v = 1;
    for (let i = 0; i < 100; i++) v = easeVeil(v, 0, 1 / 60);
    expect(v).toBe(0);
  });

  it('never overshoots in either direction', () => {
    // A single enormous frame — a tab that was in the background, a stall —
    // must land on the target rather than past it, or the amount goes negative
    // and the shader mixes the other way.
    expect(easeVeil(0, 1, 10)).toBe(1);
    expect(easeVeil(1, 0, 10)).toBe(0);
    expect(easeVeil(0.5, 0, -1)).toBe(0.5);
  });
});
