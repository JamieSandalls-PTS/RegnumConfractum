import { gunzipSync } from 'node:zlib';

/**
 * Reading a `.unitypackage` without Unity (D-555).
 *
 * The format is a gzipped tar whose entries are GUID directories, each
 * holding an `asset` (the real bytes), an `asset.meta` and a `pathname`
 * (where Unity would have put it). Recovering the real filenames is
 * therefore a tar walk and a lookup, not an import step in an engine the
 * stakeholder does not have installed.
 */

interface TarEntry {
  readonly name: string;
  readonly data: Buffer;
}

const BLOCK = 512;

function readTar(buf: Buffer): TarEntry[] {
  const out: TarEntry[] = [];
  let off = 0;
  while (off + BLOCK <= buf.length) {
    const header = buf.subarray(off, off + BLOCK);
    // Two consecutive zero blocks end the archive; one is enough to stop on.
    if (header.every((b) => b === 0)) break;
    let name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeField = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeField, 8) || 0;
    const type = String.fromCharCode(header[156]!);
    // GNU long names arrive as a preceding 'L' entry holding the real path.
    if (type === 'L') {
      const long = buf
        .subarray(off + BLOCK, off + BLOCK + size)
        .toString('utf8')
        .replace(/\0.*$/, '');
      off += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
      const next = readOne(buf, off, long);
      if (next) {
        out.push(next.entry);
        off = next.next;
      }
      continue;
    }
    // A prefix field lets a path exceed 100 bytes without a long-name entry.
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    if (prefix) name = `${prefix}/${name}`;
    const start = off + BLOCK;
    if (type === '0' || type === '\0') {
      out.push({ name, data: buf.subarray(start, start + size) });
    }
    off = start + Math.ceil(size / BLOCK) * BLOCK;
  }
  return out;
}

function readOne(buf: Buffer, off: number, name: string): { entry: TarEntry; next: number } | null {
  if (off + BLOCK > buf.length) return null;
  const header = buf.subarray(off, off + BLOCK);
  const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim(), 8) || 0;
  const start = off + BLOCK;
  return {
    entry: { name, data: buf.subarray(start, start + size) },
    next: start + Math.ceil(size / BLOCK) * BLOCK,
  };
}

/**
 * Every asset in the package, keyed by the path Unity would have written it
 * to (`Assets/Synty/.../SK_HUMN_BASE_01_10TORS_HU01.fbx`).
 */
export function readUnityPackage(gz: Buffer): Map<string, Buffer> {
  const entries = readTar(gunzipSync(gz));
  const byDir = new Map<string, { asset?: Buffer; pathname?: string }>();
  for (const e of entries) {
    const slash = e.name.indexOf('/');
    if (slash < 0) continue;
    const dir = e.name.slice(0, slash);
    const leaf = e.name.slice(slash + 1);
    const slot = byDir.get(dir) ?? {};
    if (leaf === 'asset') slot.asset = e.data;
    else if (leaf === 'pathname') slot.pathname = e.data.toString('utf8').split('\n')[0]!.trim();
    else continue;
    byDir.set(dir, slot);
  }
  const out = new Map<string, Buffer>();
  for (const { asset, pathname } of byDir.values()) {
    if (asset && pathname) out.set(pathname, asset);
  }
  return out;
}
