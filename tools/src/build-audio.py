"""
Prepares the stakeholder's raw sound drop for the web (D-541).

    python tools/src/build-audio.py

Reads `Sounds/` (the drop folder: Areas, Combat, Menu) and writes
`client/public/audio/` — the only copy the client ever loads. Two jobs:

  1. **AIFF is not a web format.** Chrome and Firefox will not play `.aif`
     at all, so those files are converted to WAV here. AIFF is big-endian
     PCM in a chunked container, so this is a byte-swap and a new header
     rather than a re-encode — nothing is resampled and nothing is lost.
     Everything else (ogg, mp3, wav, flac) is already playable and is
     copied untouched.

  2. **Names become ids.** `Hurtfemal (file needs to be split).ogg` is not
     something to type in a manifest, so files land as kebab-case ids that
     `content/audio/sounds.json` refers to.

The two files the stakeholder marked "needs to be split" are NOT split here.
They are several takes with silence between them, and the client splits them
at load (see `sliceOnSilence` in client/src/audio.ts) — one mechanism, no
offline step to forget, and re-dropping a longer take file just works.

Re-runnable: it clears and rewrites the output directory.
"""

import os
import re
import shutil
import struct
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC = os.path.join(ROOT, "Sounds")
OUT = os.path.join(ROOT, "client", "public", "audio")

# Formats every target browser can decode. AIFF is deliberately absent.
WEB_READY = {".ogg", ".mp3", ".wav", ".flac", ".m4a"}


def kebab(name: str) -> str:
    """'Hurtfemal (file needs to be split)' -> 'hurtfemal'."""
    name = re.sub(r"\(.*?\)", " ", name)          # drop parenthetical notes
    name = re.sub(r"([a-z0-9])([A-Z])", r"\1-\2", name)  # InsideBuilding -> Inside-Building
    name = re.sub(r"[^A-Za-z0-9]+", "-", name)
    return re.sub(r"-+", "-", name).strip("-").lower()


def read_aiff(path: str):
    """Returns (channels, sample_rate, bits, frames, big-endian PCM bytes)."""
    with open(path, "rb") as fh:
        data = fh.read()
    if data[0:4] != b"FORM" or data[8:12] != b"AIFF":
        raise ValueError(f"{path}: not an uncompressed AIFF (AIFC is not handled)")
    pos = 12
    comm = None
    pcm = None
    while pos + 8 <= len(data):
        cid = data[pos:pos + 4]
        size = struct.unpack(">I", data[pos + 4:pos + 8])[0]
        body = data[pos + 8:pos + 8 + size]
        if cid == b"COMM":
            channels, frames, bits = struct.unpack(">HIH", body[:8])
            comm = (channels, frames, bits, extended80(body[8:18]))
        elif cid == b"SSND":
            offset = struct.unpack(">I", body[0:4])[0]
            pcm = body[8 + offset:]
        pos += 8 + size + (size & 1)  # chunks are word-aligned
    if comm is None or pcm is None:
        raise ValueError(f"{path}: missing COMM or SSND chunk")
    channels, frames, bits, rate = comm
    return channels, rate, bits, frames, pcm


def extended80(raw: bytes) -> int:
    """The 80-bit IEEE extended sample rate AIFF stores. Always integral here."""
    exponent = struct.unpack(">H", raw[0:2])[0]
    mantissa = struct.unpack(">Q", raw[2:10])[0]
    if exponent == 0 and mantissa == 0:
        return 0
    sign = -1 if exponent & 0x8000 else 1
    exponent &= 0x7FFF
    return int(sign * mantissa * (2.0 ** (exponent - 16383 - 63)))


def write_wav(path: str, channels: int, rate: int, bits: int, pcm_le: bytes) -> None:
    block = channels * bits // 8
    header = b"RIFF" + struct.pack("<I", 36 + len(pcm_le)) + b"WAVE"
    header += b"fmt " + struct.pack("<IHHIIHH", 16, 1, channels, rate, rate * block, block, bits)
    header += b"data" + struct.pack("<I", len(pcm_le))
    with open(path, "wb") as fh:
        fh.write(header + pcm_le)


def swap_endian(pcm: bytes, bits: int) -> bytes:
    """AIFF stores samples big-endian; WAV wants little-endian."""
    if bits == 8:
        return pcm
    width = bits // 8
    usable = len(pcm) - (len(pcm) % width)
    out = bytearray(usable)
    for i in range(0, usable, width):
        out[i:i + width] = pcm[i:i + width][::-1]
    return bytes(out)


def main() -> int:
    if not os.path.isdir(SRC):
        print(f"no drop folder at {SRC}", file=sys.stderr)
        return 1
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    os.makedirs(OUT)

    converted, copied = 0, 0
    for category in sorted(os.listdir(SRC)):
        cat_dir = os.path.join(SRC, category)
        if not os.path.isdir(cat_dir):
            continue
        dest_dir = os.path.join(OUT, kebab(category))
        os.makedirs(dest_dir, exist_ok=True)
        for filename in sorted(os.listdir(cat_dir)):
            stem, ext = os.path.splitext(filename)
            ext = ext.lower()
            src_path = os.path.join(cat_dir, filename)
            if not os.path.isfile(src_path):
                continue
            if ext in (".aif", ".aiff"):
                channels, rate, bits, _frames, pcm = read_aiff(src_path)
                out_path = os.path.join(dest_dir, kebab(stem) + ".wav")
                write_wav(out_path, channels, rate, bits, swap_endian(pcm, bits))
                converted += 1
                print(f"  converted {filename} -> {os.path.relpath(out_path, ROOT)}"
                      f" ({channels}ch {rate}Hz {bits}bit)")
            elif ext in WEB_READY:
                out_path = os.path.join(dest_dir, kebab(stem) + ext)
                shutil.copyfile(src_path, out_path)
                copied += 1
            else:
                print(f"  SKIPPED {filename}: unknown format {ext}", file=sys.stderr)
    total = sum(
        os.path.getsize(os.path.join(dp, f))
        for dp, _dn, fn in os.walk(OUT) for f in fn
    )
    print(f"audio: {converted} converted, {copied} copied, {total / 1e6:.1f} MB in "
          f"{os.path.relpath(OUT, ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
