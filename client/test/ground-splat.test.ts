import { describe, expect, it } from 'vitest';
import {
  SPLAT_CHANNELS,
  SPLAT_MASKS,
  WEIGHTS_PER_MASK,
  channelOf,
  compactChannels,
  coverageByte,
} from '../src/render/ground-splat';

/**
 * The splat mask's arithmetic (D-587, D-588).
 *
 * ⚠ These are the parts that CANNOT be checked by looking at the map, which is
 * why they are pulled out of the canvas and tested here. A compaction that
 * moves a material to a new channel but leaves its weights behind renders a
 * completely plausible town — grass where the gravel was — and there is
 * nothing in the picture to say so.
 */

/** One texel's worth of mask bytes, from six weights. */
function texel(weights: number[]): Uint8ClampedArray[] {
  const masks = Array.from(
    { length: SPLAT_MASKS },
    () => new Uint8ClampedArray(4),
  );
  weights.forEach((w, i) => {
    const { mask, channel } = channelOf(i);
    masks[mask]![channel] = w;
  });
  for (const m of masks) m[3] = coverageByte(m[0]!, m[1]!, m[2]!);
  return masks;
}

/** Read the six weights back out. */
function weights(masks: Uint8ClampedArray[]): number[] {
  return Array.from({ length: SPLAT_CHANNELS }, (_, i) => {
    const { mask, channel } = channelOf(i);
    return masks[mask]![channel]!;
  });
}

describe('the splat channel layout', () => {
  it('fills the first mask before starting the second', () => {
    expect(channelOf(0)).toEqual({ mask: 0, channel: 0 });
    expect(channelOf(2)).toEqual({ mask: 0, channel: 2 });
    expect(channelOf(3)).toEqual({ mask: 1, channel: 0 });
    expect(channelOf(5)).toEqual({ mask: 1, channel: 2 });
  });

  it('leaves alpha out of it, because a canvas eats a weight stored there', () => {
    // ⚠ The measured trap (D-587, corrected by D-588): a 2D canvas stores
    // premultiplied pixels, so a small alpha destroys the weights beside it.
    // Three per mask, and alpha carries nothing.
    expect(WEIGHTS_PER_MASK).toBe(3);
    expect(SPLAT_CHANNELS).toBe(SPLAT_MASKS * WEIGHTS_PER_MASK);
  });

  it('makes coverage binary, since 0 and 255 are what survive a round trip', () => {
    expect(coverageByte(0, 0, 0)).toBe(0);
    // A single faint weight still counts as painted — it is the soft rim of a
    // stroke, and rounding it away is exactly what was being lost.
    expect(coverageByte(3, 0, 0)).toBe(255);
    expect(coverageByte(0, 0, 200)).toBe(255);
  });
});

describe('removing a material', () => {
  it('slides every later material down, weights and all', () => {
    const masks = texel([10, 20, 30, 40, 50, 60]);
    compactChannels(masks, 2);
    // 30 is gone; everything after it moved down one and kept its weight.
    expect(weights(masks)).toEqual([10, 20, 40, 50, 60, 0]);
  });

  it('moves a weight ACROSS the mask boundary', () => {
    // ⚠ The case a single-mask implementation cannot have and a two-mask one
    // gets wrong silently: channel 3 lives in the second image and has to land
    // in the first. Half the map moves and half does not, and both halves
    // render.
    const masks = texel([0, 0, 0, 90, 0, 0]);
    compactChannels(masks, 0);
    expect(weights(masks)).toEqual([0, 0, 90, 0, 0, 0]);
    expect(masks[0]![2]).toBe(90);
    expect(masks[1]![0]).toBe(0);
  });

  it('leaves the materials before it exactly where they were', () => {
    const masks = texel([11, 22, 33, 44, 55, 66]);
    compactChannels(masks, 5);
    expect(weights(masks)).toEqual([11, 22, 33, 44, 55, 0]);
  });

  it('frees the last channel, which is the whole point', () => {
    // ⚠ The bug this exists for: a material claimed a channel on first use and
    // never gave it back, so the editor's "rub one out to free its channel"
    // could not work however hard anybody rubbed.
    const masks = texel([1, 2, 3, 4, 5, 6]);
    compactChannels(masks, 0);
    expect(weights(masks)[SPLAT_CHANNELS - 1]).toBe(0);
  });

  it('recomputes coverage rather than leaving it behind', () => {
    const masks = texel([0, 0, 0, 7, 0, 0]);
    expect(masks[1]![3]).toBe(255);
    compactChannels(masks, 3); // remove the only material in the second mask
    expect(weights(masks)).toEqual([0, 0, 0, 0, 0, 0]);
    // ⚠ An emptied texel that still reads as covered is ground the shader
    // draws as a normalised blend of nothing.
    expect(masks[0]![3]).toBe(0);
    expect(masks[1]![3]).toBe(0);
  });

  it('handles a whole image, not just one texel', () => {
    const texels = 64;
    const masks = Array.from(
      { length: SPLAT_MASKS },
      () => new Uint8ClampedArray(texels * 4),
    );
    for (let t = 0; t < texels; t++) {
      masks[0]![t * 4 + 1] = 100 + (t % 50); // material 1
      masks[1]![t * 4 + 0] = 200 - (t % 50); // material 3
      masks[0]![t * 4 + 3] = 255;
      masks[1]![t * 4 + 3] = 255;
    }
    compactChannels(masks, 1);
    for (let t = 0; t < texels; t++) {
      // Material 3 slid down two places to channel 2 — still in the FIRST
      // mask, which is the crossing a one-mask brush cannot make.
      expect(masks[0]![t * 4 + 2]).toBe(200 - (t % 50));
      expect(masks[0]![t * 4 + 0]).toBe(0);
      expect(masks[0]![t * 4 + 1]).toBe(0);
      expect(masks[0]![t * 4 + 3]).toBe(255);
      expect(masks[1]![t * 4 + 0]).toBe(0);
      expect(masks[1]![t * 4 + 3]).toBe(0);
    }
  });
});
