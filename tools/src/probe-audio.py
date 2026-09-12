"""
Checks the split/normalise logic against the real files (D-541).

    python tools/src/probe-audio.py

A Python port of `shared/src/audio.ts` run over every WAV in
`client/public/audio` — which is every file this machine can decode without
ffmpeg, including both AIFF conversions and the multi-take `maledeath`. It
reports how many takes the splitter finds, how long each is, and what gain
each would be given.

This is evidence rather than tooling: the splitter runs in the browser, and
without this the only way to know whether it finds four takes or forty would
be to listen. The ogg/mp3/flac files cannot be checked here — nothing on this
machine decodes them — which is precisely why the real implementation lives
where the decoder is.
"""

import os
import struct
import sys
import wave

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
AUDIO = os.path.join(ROOT, "client", "public", "audio")

# Mirrors shared/src/audio.ts. If these drift, this script is lying.
LOUDNESS_TARGETS = {"effect": 0.14, "ambience": 0.045, "music": 0.08}
PEAK_CEILING = 0.97
GAIN_LIMITS = (0.05, 8.0)


def read_wav_mono(path):
    with wave.open(path, "rb") as w:
        channels, width, rate, frames = (
            w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes())
        raw = w.readframes(frames)
    if width == 2:
        data = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    elif width == 1:
        data = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128) / 128.0
    elif width == 3:
        b = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3).astype(np.int32)
        packed = (b[:, 0] | (b[:, 1] << 8) | (b[:, 2] << 16))
        packed = np.where(packed & 0x800000, packed - 0x1000000, packed)
        data = packed.astype(np.float32) / 8388608.0
    else:
        raise ValueError(f"{path}: unsupported sample width {width}")
    if channels > 1:
        data = data.reshape(-1, channels).mean(axis=1)
    return data, rate


def measure_loudness(samples, floor=0.0035):
    peak = float(np.max(np.abs(samples))) if samples.size else 0.0
    loud = np.abs(samples) > floor
    if not loud.any():
        return 0.0, peak
    first, last = int(np.argmax(loud)), int(len(loud) - np.argmax(loud[::-1]) - 1)
    body = samples[first:last + 1]
    return float(np.sqrt(np.mean(body * body))), peak


def normalisation_gain(rms, peak, category):
    if rms <= 0 or peak <= 0:
        return 1.0
    gain = min(LOUDNESS_TARGETS[category] / rms, PEAK_CEILING / peak)
    return min(GAIN_LIMITS[1], max(GAIN_LIMITS[0], gain))


def find_segments(samples, rate, floor=0.012, min_gap=0.18, min_take=0.12, pad=0.03):
    min_gap_n, min_take_n, pad_n = int(min_gap * rate), int(min_take * rate), int(pad * rate)
    loud = np.abs(samples) > floor
    segments, start, quiet = [], -1, 0
    for i in range(len(loud)):
        if loud[i]:
            if start < 0:
                start = i
            quiet = 0
        elif start >= 0:
            quiet += 1
            if quiet >= min_gap_n:
                end = i - quiet
                if end - start >= min_take_n:
                    segments.append((start, end))
                start, quiet = -1, 0
    if start >= 0 and len(loud) - start >= min_take_n:
        segments.append((start, len(loud)))
    if not segments:
        segments = [(0, len(samples))]
    return [(max(0, s - pad_n), min(len(samples), e + pad_n)) for s, e in segments]


def main():
    if not os.path.isdir(AUDIO):
        print("run tools/src/build-audio.py first", file=sys.stderr)
        return 1
    for category in sorted(os.listdir(AUDIO)):
        cat_dir = os.path.join(AUDIO, category)
        if not os.path.isdir(cat_dir):
            continue
        loud_cat = "ambience" if category == "areas" else "music" if category == "menu" else "effect"
        for name in sorted(os.listdir(cat_dir)):
            if not name.endswith(".wav"):
                continue
            path = os.path.join(cat_dir, name)
            samples, rate = read_wav_mono(path)
            rms, peak = measure_loudness(samples)
            segments = find_segments(samples, rate)
            takes = ", ".join(f"{(e - s) / rate:.2f}s" for s, e in segments[:8])
            more = "" if len(segments) <= 8 else f" (+{len(segments) - 8} more)"
            gains = []
            for s, e in segments:
                srms, speak = measure_loudness(samples[s:e])
                gains.append(normalisation_gain(srms, speak, loud_cat))
            print(f"{category}/{name}: {len(samples) / rate:.2f}s  rms={rms:.4f} peak={peak:.3f}")
            print(f"    {len(segments)} take(s): {takes}{more}")
            print(f"    gains: {', '.join(f'{g:.2f}x' for g in gains[:8])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
