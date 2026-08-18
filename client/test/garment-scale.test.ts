import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ARCHETYPE_NAMES, generateAppearance, type ArchetypeName } from '@rc/shared';
import { CharacterVisual } from '../src/render/character';

/**
 * Garments must sit the same way on every body (stakeholder, 2026-08-18:
 * "on larger models the cape is not positioned the same... it should be
 * anchored at the same relative Y").
 *
 * The trap this guards is subtle. Leg length carries a per-archetype
 * multiplier, so the point a cape hangs from ranges from ~0.76 to ~0.85 of
 * nominal height — a garment sized off `appearance.height` therefore hung
 * from a different place on every build. Bulk varies even harder (0.2 to
 * 0.75), so a cut driven off body width made a heavy character's cape
 * nearly twice its own shoulder span while a lean one's was half again.
 *
 * These tests assert PROPORTIONS rather than absolute sizes: a cape may be
 * any length the art direction likes, so long as it is the same length
 * relative to the body it is on.
 */

function caped(seed: number): CharacterVisual {
  const scene = new THREE.Scene();
  const visual = new CharacterVisual(seed, scene);
  visual.setEquipment({ cape: true, robe: false, helm: false, pauldrons: false, weapon: false });
  return visual;
}

interface Sample {
  seed: number;
  archetype: ArchetypeName;
  /** Cape width as a multiple of the shoulder span it hangs from. */
  widthPerSpan: number;
  /** How high the hem sits, as a fraction of the body's height. */
  hemPerHeight: number;
  /** Collar ring as a multiple of head height — it is a NECK ring. */
  collarPerHead: number;
}

function sample(seed: number): Sample {
  const visual = caped(seed);
  const m = visual.measurements;
  const cut = visual.capeMetrics()!;
  const s: Sample = {
    seed,
    archetype: generateAppearance(seed).archetype,
    widthPerSpan: cut.width / (m.shoulderW * 2),
    hemPerHeight: (cut.anchorY - cut.length) / m.height,
    collarPerHead: cut.collar / m.headH,
  };
  visual.dispose();
  return s;
}

/** A spread of seeds wide enough to include every archetype and extreme. */
const SAMPLES: Sample[] = Array.from({ length: 240 }, (_, i) => sample(1000 + i));

const ratio = (values: number[]): number => Math.max(...values) / Math.min(...values);

describe('a cape is cut to the body it hangs on', () => {
  it('covers every archetype in the sample', () => {
    const seen = new Set(SAMPLES.map((s) => s.archetype));
    for (const name of ARCHETYPE_NAMES) {
      expect(seen.has(name), `no ${name} in the sample`).toBe(true);
    }
  });

  it('hangs from a point that scales with the body, not nominal height', () => {
    // The anchor is rig-derived, so its height as a fraction of nominal
    // height legitimately varies — that is exactly why the cape must be
    // sized off the ANCHOR. What must not vary is where the hem lands.
    const hems = SAMPLES.map((s) => s.hemPerHeight);
    expect(ratio(hems), 'hem height drifts across builds').toBeLessThan(1.12);
  });

  it('is cut to the shoulders it hangs from, not to girth', () => {
    const widths = SAMPLES.map((s) => s.widthPerSpan);
    // Before the fix this spread was 1.26 — a cloak on one build and a
    // blanket on another.
    expect(ratio(widths), 'cape width drifts across builds').toBeLessThan(1.15);
    // And it must still be wider than the shoulders, or it is a scarf.
    expect(Math.min(...widths)).toBeGreaterThan(1.2);
  });

  it('keeps the collar a neck ring on every build', () => {
    const collars = SAMPLES.map((s) => s.collarPerHead);
    // The old max(shoulderW, bodyW) term nearly doubled across builds and
    // carried the fabric up around heavy characters' heads.
    expect(ratio(collars), 'collar drifts across builds').toBeLessThan(1.3);
  });

  it('holds for the extremes, not just on average', () => {
    // The worst case is a heavy short-limbed brute against a light
    // long-limbed ascetic — the two ends of both axes at once.
    const brutes = SAMPLES.filter((s) => s.archetype === 'brute');
    const ascetics = SAMPLES.filter((s) => s.archetype === 'ascetic');
    expect(brutes.length).toBeGreaterThan(0);
    expect(ascetics.length).toBeGreaterThan(0);
    const worstBrute = brutes.reduce((a, b) => (a.widthPerSpan > b.widthPerSpan ? a : b));
    const leanest = ascetics.reduce((a, b) => (a.widthPerSpan < b.widthPerSpan ? a : b));
    expect(worstBrute.widthPerSpan / leanest.widthPerSpan).toBeLessThan(1.15);
    expect(
      Math.abs(worstBrute.hemPerHeight - leanest.hemPerHeight),
      'the hem lands at a different place on the two extremes',
    ).toBeLessThan(0.025);
  });
});
