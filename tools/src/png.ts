import { inflateSync } from 'node:zlib';

/**
 * A minimal PNG reader, so the toolchain can look at a texture (D-566).
 *
 * Every measurement that has decided something about this art — skin is four
 * flat colours (D-560), the unlettered atlas hides face markings, a weapon
 * samples three to seven colours — needed pixels, and until now getting them
 * meant the browser or a Python script beside the TypeScript. Neither belongs
 * in a build step.
 *
 * ⚠ Deliberately NOT a general PNG library. It handles what these packs
 * actually are — 8-bit RGB or RGBA, non-interlaced — and THROWS on anything
 * else rather than returning plausible wrong pixels. A silently mis-decoded
 * atlas would produce a colour classification that looks like a decision and
 * is noise, which is the worst failure available here.
 */

export interface Bitmap {
  width: number;
  height: number;
  /** RGBA, four bytes per pixel, row-major from the top left. */
  data: Uint8Array;
}

/** Paeth, from the PNG spec. The one filter that is not obvious by inspection. */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

export function readPng(bytes: Buffer): Bitmap {
  const magic = [137, 80, 78, 71, 13, 10, 26, 10];
  if (magic.some((b, i) => bytes[i] !== b)) throw new Error('not a PNG');

  let width = 0;
  let height = 0;
  let depth = 0;
  let colour = -1;
  const idat: Buffer[] = [];

  // Chunks: length, type, data, crc. The CRC is not checked — a corrupt file
  // fails at inflate or at the row arithmetic, loudly enough.
  for (let at = 8; at + 8 <= bytes.length; ) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString('latin1', at + 4, at + 8);
    const from = at + 8;
    if (type === 'IHDR') {
      width = bytes.readUInt32BE(from);
      height = bytes.readUInt32BE(from + 4);
      depth = bytes[from + 8]!;
      colour = bytes[from + 9]!;
      const interlace = bytes[from + 12]!;
      if (depth !== 8) throw new Error(`PNG bit depth ${depth} is not supported (only 8)`);
      if (colour !== 2 && colour !== 6) {
        throw new Error(`PNG colour type ${colour} is not supported (only 2 = RGB, 6 = RGBA)`);
      }
      if (interlace !== 0) throw new Error('interlaced PNG is not supported');
    } else if (type === 'IDAT') {
      idat.push(bytes.subarray(from, from + length));
    } else if (type === 'IEND') {
      break;
    }
    at = from + length + 4;
  }
  if (!width || !height) throw new Error('PNG has no IHDR');

  const channels = colour === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  // The previous row, unfiltered — filters address the pixel above as well as
  // the one to the left, so a whole row has to be kept.
  let prev = new Uint8Array(stride);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const row = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const x = line[i]!;
      const a = i >= channels ? row[i - channels]! : 0;
      const b = prev[i]!;
      const c = i >= channels ? prev[i - channels]! : 0;
      row[i] =
        filter === 0 ? x
        : filter === 1 ? (x + a) & 0xff
        : filter === 2 ? (x + b) & 0xff
        : filter === 3 ? (x + ((a + b) >> 1)) & 0xff
        : filter === 4 ? (x + paeth(a, b, c)) & 0xff
        : (() => { throw new Error(`unknown PNG filter ${filter} on row ${y}`); })();
    }
    for (let x = 0; x < width; x++) {
      const s = x * channels;
      const d = (y * width + x) * 4;
      out[d] = row[s]!;
      out[d + 1] = row[s + 1]!;
      out[d + 2] = row[s + 2]!;
      out[d + 3] = channels === 4 ? row[s + 3]! : 255;
    }
    prev = row;
  }
  return { width, height, data: out };
}

/**
 * The colour at a UV, with the V flipped.
 *
 * ⚠ The flip is not optional and not a preference: glTF and FBX put the UV
 * origin at the bottom left and an image's first row is the top. Sampling
 * without it reads a mesh's colours from the wrong end of the atlas, which
 * for this pack means reading skin where the garment is.
 */
export function sampleUv(bitmap: Bitmap, u: number, v: number): [number, number, number] {
  const x = Math.min(bitmap.width - 1, Math.max(0, Math.floor(u * bitmap.width)));
  const y = Math.min(bitmap.height - 1, Math.max(0, Math.floor((1 - v) * bitmap.height)));
  const at = (y * bitmap.width + x) * 4;
  return [bitmap.data[at]!, bitmap.data[at + 1]!, bitmap.data[at + 2]!];
}

export function hex(rgb: readonly [number, number, number]): string {
  return `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}
