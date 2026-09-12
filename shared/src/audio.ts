/**
 * Sound preparation (D-541): loudness normalisation and take-splitting, as
 * pure functions over raw samples.
 *
 * Both jobs were asked for as offline work, and both are done at LOAD instead.
 * The reason is not laziness — it is that half the drop is `.ogg`, `.mp3` and
 * `.flac`, and this machine has no decoder for any of them (no ffmpeg, and
 * Python's stdlib decodes WAV and AIFF only). Doing it offline would mean
 * normalising the twelve files that happen to be WAV and leaving the ambience
 * beds, the menu music and two of the hurt sets untouched — which is worse
 * than not doing it, because the inconsistency would be invisible until
 * someone walked from the town into the mine.
 *
 * The browser already decodes every one of these formats, and already has to
 * decode them to play them. So the work happens there, on the samples it has
 * in hand anyway, and it applies uniformly to everything — including whatever
 * the stakeholder drops in next, in whatever format, with no build step to
 * forget.
 *
 * Pure module: Float32Array in, numbers out. No Web Audio, no DOM (D-114) —
 * which is what lets both of these be tested against real files rather than
 * trusted because they sound about right.
 */

/**
 * Target loudness per category, as RMS of the normalised signal.
 *
 * RMS rather than peak, because peak normalisation is what makes a set of
 * sounds *look* level and still play unevenly: a single click at full scale
 * in an otherwise quiet take pins the peak and leaves the take inaudible.
 * These are perceived-loudness targets and the peak ceiling below is what
 * keeps them honest.
 *
 * ⚠ UNRATIFIED, like every other number in this project — but unusually easy
 * to judge, since getting them wrong is audible within one round.
 */
export const LOUDNESS_TARGETS = {
  /** Blows, spells, cries. The layer that must cut through everything. */
  effect: 0.14,
  /** Beds. Deliberately far below effects: ambience that competes with a
   * death cry is ambience that has to be turned off. */
  ambience: 0.045,
  /** Menu music: no competition, but not a wall of sound either. */
  music: 0.08,
} as const;

export type LoudnessCategory = keyof typeof LOUDNESS_TARGETS;

/** Nothing may be pushed past this, whatever its RMS says. */
export const PEAK_CEILING = 0.97;

/**
 * Gains outside this band are refused. A file that needs 20× is not quiet,
 * it is broken or nearly silent, and amplifying it would raise its noise
 * floor into a hiss; a file that needs 0.02× is not loud, it is a
 * measurement mistake.
 */
export const GAIN_LIMITS: readonly [number, number] = [0.05, 8];

export interface Loudness {
  rms: number;
  peak: number;
}

/**
 * RMS and peak over the samples that actually carry signal.
 *
 * Leading and trailing silence is excluded from the RMS. It matters more than
 * it sounds: `maledeath` is fifty seconds of mostly-silence around a handful
 * of takes, and measuring the whole file would report it as almost silent and
 * then amplify the takes into distortion.
 */
export function measureLoudness(samples: Float32Array, floor = 0.0035): Loudness {
  let peak = 0;
  let first = -1;
  let last = -1;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]!);
    if (a > peak) peak = a;
    if (a > floor) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return { rms: 0, peak };
  let sum = 0;
  for (let i = first; i <= last; i++) sum += samples[i]! * samples[i]!;
  const rms = Math.sqrt(sum / (last - first + 1));
  return { rms, peak };
}

/**
 * The gain that brings this sound to its category's target without letting
 * anything clip. Returns 1 for silence — there is nothing to normalise, and
 * dividing by zero would produce an Infinity that poisons the graph.
 */
export function normalisationGain(loudness: Loudness, category: LoudnessCategory): number {
  if (loudness.rms <= 0 || loudness.peak <= 0) return 1;
  const wanted = LOUDNESS_TARGETS[category] / loudness.rms;
  const headroom = PEAK_CEILING / loudness.peak;
  const gain = Math.min(wanted, headroom);
  return Math.min(GAIN_LIMITS[1], Math.max(GAIN_LIMITS[0], gain));
}

export interface Segment {
  /** Sample index of the first frame of the take. */
  start: number;
  /** Sample index one past the last frame. */
  end: number;
}

export interface SplitOptions {
  /** Amplitude below which a frame counts as silence. */
  floor?: number;
  /** Silence must last this long to be a gap between takes, in seconds. */
  minGapSeconds?: number;
  /** Anything shorter than this is a click or a breath, not a take. */
  minTakeSeconds?: number;
  /** Kept either side of a take so attacks are not clipped, in seconds. */
  padSeconds?: number;
}

/**
 * Splits one file of several takes into a take per segment (D-541).
 *
 * Two files in the drop are named "file needs to be split" and they are the
 * reason this exists, but every multi-take file gets the same treatment: find
 * runs of signal separated by real silence, pad them so the attack transient
 * survives, and throw away anything too short to be a performance.
 *
 * Always returns at least one segment — a file with no detectable silence is
 * one take, and callers should not have to handle an empty list.
 */
export function findSegments(
  samples: Float32Array,
  sampleRate: number,
  opts: SplitOptions = {},
): Segment[] {
  const floor = opts.floor ?? 0.012;
  const minGap = Math.floor((opts.minGapSeconds ?? 0.18) * sampleRate);
  const minTake = Math.floor((opts.minTakeSeconds ?? 0.12) * sampleRate);
  const pad = Math.floor((opts.padSeconds ?? 0.03) * sampleRate);

  const segments: Segment[] = [];
  let start = -1;
  let quietFor = 0;
  for (let i = 0; i < samples.length; i++) {
    const loud = Math.abs(samples[i]!) > floor;
    if (loud) {
      if (start < 0) start = i;
      quietFor = 0;
    } else if (start >= 0) {
      quietFor++;
      // The gap has to be long enough to be a gap. A short dip inside a
      // scream is not the end of the take, and treating it as one is how a
      // splitter turns four takes into forty.
      if (quietFor >= minGap) {
        const end = i - quietFor;
        if (end - start >= minTake) segments.push({ start, end });
        start = -1;
        quietFor = 0;
      }
    }
  }
  if (start >= 0 && samples.length - start >= minTake) {
    segments.push({ start, end: samples.length });
  }
  if (segments.length === 0) return [{ start: 0, end: samples.length }];
  return segments.map((s) => ({
    start: Math.max(0, s.start - pad),
    end: Math.min(samples.length, s.end + pad),
  }));
}
