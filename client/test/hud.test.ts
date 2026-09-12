import { describe, expect, it } from 'vitest';
import { NEED_STAGES, ROUND_DAWN_HOUR, ROUND_DUSK_HOUR } from '@rc/shared';
import {
  barFraction,
  barState,
  clockHands,
  clockText,
  compassLabel,
  compassRotationDeg,
  needFraction,
  needLabel,
} from '../src/game/hud';

describe('the compass (D-548)', () => {
  /**
   * The needle is fed the CAMERA-SPACE direction of north rather than the
   * azimuth, so these cases are about the arithmetic and not about the
   * renderer's handedness — which is exactly the point of taking the
   * projection from the camera instead of re-deriving it.
   */
  it('points straight up when north is up the screen', () => {
    expect(compassRotationDeg({ x: 0, y: 1 })).toBe(0);
  });

  it('points right when north is to the right', () => {
    expect(compassRotationDeg({ x: 1, y: 0 })).toBe(90);
  });

  it('points left when north is to the left', () => {
    expect(compassRotationDeg({ x: -1, y: 0 })).toBe(-90);
  });

  it('points down when north is behind the camera', () => {
    expect(Math.abs(compassRotationDeg({ x: 0, y: -1 }))).toBe(180);
  });

  it('survives a degenerate direction rather than producing NaN', () => {
    expect(compassRotationDeg({ x: 0, y: 0 })).toBe(0);
  });

  it('names the eight points, wrapping at the seam', () => {
    expect(compassLabel(0)).toBe('N');
    expect(compassLabel(90)).toBe('E');
    expect(compassLabel(180)).toBe('S');
    expect(compassLabel(-90)).toBe('W');
    expect(compassLabel(359)).toBe('N');
    expect(compassLabel(45)).toBe('NE');
  });
});

describe('the clock (D-548)', () => {
  it('puts the hour hand at the top at noon and midnight', () => {
    expect(clockHands(12).hourDeg).toBe(0);
    expect(clockHands(0).hourDeg).toBe(0);
  });

  /**
   * A twelve-hour face cannot tell noon from midnight, which is why the
   * night flag travels with the hands — the dial is shaded and the orb
   * swapped rather than the face being redesigned into something nobody
   * recognises as a clock.
   */
  it('distinguishes noon from midnight by night, not by the hands', () => {
    expect(clockHands(12).isNight).toBe(false);
    expect(clockHands(0).isNight).toBe(true);
  });

  it('agrees with the round cycle about when it is dark (D-527)', () => {
    expect(clockHands(ROUND_DUSK_HOUR).isNight).toBe(true);
    expect(clockHands(ROUND_DUSK_HOUR - 1).isNight).toBe(false);
    expect(clockHands(ROUND_DAWN_HOUR).isNight).toBe(false);
    expect(clockHands(ROUND_DAWN_HOUR - 1).isNight).toBe(true);
  });

  it('sweeps the minute hand through the game hour', () => {
    expect(clockHands(9, 0).minuteDeg).toBe(0);
    expect(clockHands(9, 0.5).minuteDeg).toBe(180);
    // Clamped rather than wrapped: an interpolation that overruns must not
    // send the hand round again.
    expect(clockHands(9, 3).minuteDeg).toBe(360);
  });

  it('advances the hour hand within the hour, not in jumps', () => {
    expect(clockHands(3, 0).hourDeg).toBe(90);
    expect(clockHands(3, 0.5).hourDeg).toBe(105);
  });

  it('normalises an hour outside the day', () => {
    expect(clockText(26)).toBe('02:00');
    expect(clockText(-1)).toBe(clockText(23));
  });
});

describe('the bars', () => {
  it('clamps and never divides by zero', () => {
    expect(barFraction(5, 10)).toBe(0.5);
    expect(barFraction(-3, 10)).toBe(0);
    expect(barFraction(30, 10)).toBe(1);
    expect(barFraction(5, 0)).toBe(0);
  });

  it('bands urgency rather than sliding it', () => {
    expect(barState(1)).toBe('ok');
    expect(barState(0.4)).toBe('low');
    expect(barState(0.1)).toBe('critical');
    expect(barState(0)).toBe('critical');
  });

  /**
   * Needs are stages underneath (D-526) and the bar is a presentation of one.
   * It must fall monotonically, or a player watching it would learn the
   * opposite of what is happening to them.
   */
  it('falls with every stage of a need', () => {
    const values = NEED_STAGES.map(needFraction);
    for (let i = 1; i < values.length; i++) {
      expect(values[i]!).toBeLessThan(values[i - 1]!);
    }
  });

  /**
   * Starving is drawn nearly empty, not empty: an empty bar reads as "this
   * mechanic has finished with you" at exactly the point starvation starts
   * doing damage (D-534).
   */
  it('leaves something showing at the bottom', () => {
    expect(needFraction('starving')).toBeGreaterThan(0);
  });

  it('names the sated state after the need it belongs to', () => {
    expect(needLabel('hunger', 'sated')).toBe('fed');
    expect(needLabel('thirst', 'sated')).toBe('watered');
    expect(needLabel('hunger', 'severe')).toBe('severe');
  });
});
