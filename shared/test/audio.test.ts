import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  GAIN_LIMITS,
  LOUDNESS_TARGETS,
  PEAK_CEILING,
  SoundsFileSchema,
  findSegments,
  measureLoudness,
  normalisationGain,
} from '../src/index';

/**
 * Sound preparation (D-541).
 *
 * The synthetic cases pin the rules; the last block runs the real splitter
 * over the actual `maledeath.wav` from the stakeholder's drop, because a
 * splitter that behaves on a square wave and finds forty takes in a real
 * performance is worse than no splitter. WAV is decodable here without any
 * dependency, which is the only reason this can be tested at this level —
 * the ogg and mp3 cues are exercised in the browser, where the decoder is.
 */

const audioRoot = fileURLToPath(new URL('../../client/public/audio/', import.meta.url));

/** Minimal 16-bit PCM WAV reader — enough for the drop's own files. */
function readWavMono(path: string): { samples: Float32Array; sampleRate: number } {
  const buf = readFileSync(path);
  let pos = 12;
  let channels = 1;
  let sampleRate = 44100;
  let bits = 16;
  let data: Buffer | null = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(pos + 10);
      sampleRate = buf.readUInt32LE(pos + 12);
      bits = buf.readUInt16LE(pos + 22);
    } else if (id === 'data') {
      data = buf.subarray(pos + 8, pos + 8 + size);
    }
    pos += 8 + size + (size % 2);
  }
  if (!data || bits !== 16) throw new Error(`${path}: expected 16-bit PCM`);
  const frames = Math.floor(data.length / 2 / channels);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += data.readInt16LE((i * channels + c) * 2) / 32768;
    out[i] = sum / channels;
  }
  return { samples: out, sampleRate };
}

/** A burst of noise, then silence, repeated. */
function takes(count: number, sampleRate: number, takeSec = 0.4, gapSec = 0.4, amp = 0.5) {
  const take = Math.floor(takeSec * sampleRate);
  const gap = Math.floor(gapSec * sampleRate);
  const out = new Float32Array(count * (take + gap));
  for (let n = 0; n < count; n++) {
    const base = n * (take + gap);
    for (let i = 0; i < take; i++) {
      // A shaped burst rather than a constant, so the envelope is realistic.
      out[base + i] = Math.sin((i / sampleRate) * 900 * Math.PI * 2) * amp
        * Math.min(1, i / 400) * Math.exp((-2 * i) / take);
    }
  }
  return out;
}

describe('loudness', () => {
  it('ignores leading and trailing silence', () => {
    // The same burst, once tightly cropped and once buried in silence, must
    // measure the same — otherwise a mostly-silent file is amplified into
    // distortion, which is exactly what maledeath.wav would suffer.
    const body = takes(1, 44100, 0.4, 0);
    const padded = new Float32Array(44100 * 5);
    padded.set(body, 44100 * 2);
    expect(measureLoudness(padded).rms).toBeCloseTo(measureLoudness(body).rms, 3);
  });

  it('brings a quiet and a loud sound to the same level', () => {
    const quiet = takes(1, 44100, 0.4, 0, 0.05);
    const loud = takes(1, 44100, 0.4, 0, 0.8);
    const q = measureLoudness(quiet);
    const l = measureLoudness(loud);
    const after = (s: Float32Array, g: number) => measureLoudness(s.map((v) => v * g)).rms;
    const qAfter = after(quiet, normalisationGain(q, 'effect'));
    const lAfter = after(loud, normalisationGain(l, 'effect'));
    expect(qAfter).toBeCloseTo(lAfter, 2);
    expect(qAfter).toBeCloseTo(LOUDNESS_TARGETS.effect, 2);
  });

  it('never lets a gain clip, whatever the target says', () => {
    // A signal that is loud in peak but quiet in RMS — a click in a silent
    // room. RMS alone would amplify it well past full scale.
    const clicky = new Float32Array(44100);
    clicky[100] = 0.99;
    for (let i = 2000; i < 3000; i++) clicky[i] = 0.01;
    const loudness = measureLoudness(clicky);
    const gain = normalisationGain(loudness, 'effect');
    expect(loudness.peak * gain).toBeLessThanOrEqual(PEAK_CEILING + 1e-6);
  });

  it('refuses absurd gains and survives silence', () => {
    expect(normalisationGain({ rms: 0, peak: 0 }, 'effect')).toBe(1);
    expect(normalisationGain({ rms: 1e-9, peak: 1e-9 }, 'effect')).toBeLessThanOrEqual(GAIN_LIMITS[1]);
    expect(normalisationGain({ rms: 5, peak: 5 }, 'effect')).toBeGreaterThanOrEqual(GAIN_LIMITS[0]);
  });

  it('keeps beds well under effects, so ambience never buries a cry', () => {
    expect(LOUDNESS_TARGETS.ambience).toBeLessThan(LOUDNESS_TARGETS.effect / 2);
    expect(LOUDNESS_TARGETS.music).toBeLessThan(LOUDNESS_TARGETS.effect);
  });
});

describe('splitting takes', () => {
  it('finds each take, and does not invent any', () => {
    expect(findSegments(takes(4, 44100), 44100)).toHaveLength(4);
    expect(findSegments(takes(1, 44100), 44100)).toHaveLength(1);
  });

  it('does not cut a take in half at a quiet moment inside it', () => {
    // A dip well under the gap threshold — a breath in a scream, not an end.
    const sr = 44100;
    const s = takes(1, sr, 0.8, 0);
    for (let i = Math.floor(sr * 0.35); i < Math.floor(sr * 0.4); i++) s[i] = 0;
    expect(findSegments(s, sr)).toHaveLength(1);
  });

  it('always returns something, even for silence', () => {
    expect(findSegments(new Float32Array(44100), 44100)).toHaveLength(1);
    expect(findSegments(new Float32Array(0), 44100)).toHaveLength(1);
  });

  it('keeps the attack transient by padding the front', () => {
    const sr = 44100;
    const s = new Float32Array(sr);
    for (let i = sr / 2; i < sr / 2 + 4410; i++) s[i] = 0.6;
    const [seg] = findSegments(s, sr);
    expect(seg!.start).toBeLessThan(sr / 2);
    expect(seg!.end).toBeGreaterThan(sr / 2 + 4410);
  });
});

describe('the real drop', () => {
  const manifestPath = fileURLToPath(new URL('../../content/audio/sounds.json', import.meta.url));

  it('is a valid manifest and every file it names exists', () => {
    const cues = SoundsFileSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));
    expect(cues.length).toBeGreaterThan(0);
    for (const cue of cues) {
      for (const file of cue.files) {
        expect(existsSync(audioRoot + file), `${cue.id} -> ${file}`).toBe(true);
      }
    }
    // Every bed an area can ask for must be an ambience cue.
    expect(cues.filter((c) => c.kind === 'ambience').length).toBeGreaterThan(0);
  });

  it('splits maledeath.wav into its separate cries', () => {
    const path = `${audioRoot}combat/maledeath.wav`;
    if (!existsSync(path)) return; // drop not staged; the manifest test covers absence
    const { samples, sampleRate } = readWavMono(path);
    const segments = findSegments(samples, sampleRate);
    // It is one file of many takes — the exact count is the recording's
    // business, but "several, each a plausible length" is the contract.
    expect(segments.length).toBeGreaterThan(5);
    for (const seg of segments) {
      const seconds = (seg.end - seg.start) / sampleRate;
      expect(seconds).toBeGreaterThan(0.15);
      expect(seconds).toBeLessThan(6);
      // And each take normalises to a sane, non-clipping gain of its own.
      const loudness = measureLoudness(samples.subarray(seg.start, seg.end));
      const gain = normalisationGain(loudness, 'effect');
      expect(loudness.peak * gain).toBeLessThanOrEqual(PEAK_CEILING + 1e-6);
    }
    // The takes must not cover the whole file: most of it is silence, and a
    // splitter returning one segment would be silently doing nothing.
    const covered = segments.reduce((n, s) => n + (s.end - s.start), 0);
    expect(covered).toBeLessThan(samples.length * 0.9);
  });
});
