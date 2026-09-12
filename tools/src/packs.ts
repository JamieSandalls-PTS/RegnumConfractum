import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePolygonPart } from '@rc/shared';

/**
 * Where the ingested art lives, and what is in it (D-558).
 *
 * Both the studio server and `build:characters` have to turn a pack NAME —
 * which is all a character definition stores — into a folder of meshes and a
 * folder of textures. That resolution lives here once, because two copies of
 * it drift and the failure is a character that previews in the studio and
 * then cannot be built.
 *
 * `assets/source/` is gitignored: the art is somebody else's and stays out
 * of the repository (D-556). Everything here therefore has to cope with the
 * directory being absent, which is the normal state in CI.
 */

const root = fileURLToPath(new URL('../..', import.meta.url));

export const SOURCE_DIR = path.join(root, 'assets', 'source');

export interface Pack {
  readonly id: string;
  readonly meshDir: string;
  readonly textureDir: string | null;
}

/**
 * Find a named subdirectory anywhere under `from`.
 *
 * Packs do not agree on layout — one puts meshes in `FBX/`, another under
 * `Source_Files/FBX/` — so the mesh directory is FOUND rather than assumed.
 * A vendor reorganising their zip is then not a code change.
 */
export function findDir(from: string, name: string): string | null {
  const stack = [from];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.toLowerCase() === name) return path.join(dir, e.name);
      stack.push(path.join(dir, e.name));
    }
  }
  return null;
}

/**
 * Every ingested pack that holds modular character parts.
 *
 * A pack whose files do not parse as parts is skipped rather than listed: an
 * environment pack has `FBX/` too, and offering it would be a menu of
 * barrels to put in a helmet slot.
 */
export function packs(): Pack[] {
  if (!fs.existsSync(SOURCE_DIR)) return [];
  const out: Pack[] = [];
  for (const entry of fs.readdirSync(SOURCE_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const base = path.join(SOURCE_DIR, entry.name);
    const meshDir = findDir(base, 'fbx');
    if (!meshDir) continue;
    if (!fs.readdirSync(meshDir).some((f) => parsePolygonPart(f))) continue;
    out.push({ id: entry.name, meshDir, textureDir: findDir(base, 'textures') });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function packOf(id: string): Pack | undefined {
  return allPacks().find((p) => p.id === id);
}

/**
 * EVERY ingested pack that ships meshes, character parts or not.
 *
 * `packs()` deliberately hides the packs with no modular character parts —
 * offering an environment pack in a helmet slot is a menu of barrels. The
 * asset tools want the opposite: weapons, buildings and props live precisely
 * in the packs `packs()` filters out.
 */
export function allPacks(): Pack[] {
  if (!fs.existsSync(SOURCE_DIR)) return [];
  const out: Pack[] = [];
  for (const entry of fs.readdirSync(SOURCE_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const base = path.join(SOURCE_DIR, entry.name);
    const meshDir = findDir(base, 'fbx');
    if (!meshDir) continue;
    out.push({ id: entry.name, meshDir, textureDir: findDir(base, 'textures') });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Mesh stems in a pack, recursively.
 *
 * `partStems` looks in one directory because modular parts live in one. A
 * pack's props do not: `knights` keeps its meshes under `Source_Files/FBX`
 * and its variants in subfolders, so anything hunting for a barrel has to
 * walk.
 */
export function allMeshStems(pack: Pack): string[] {
  const out: string[] = [];
  const stack = [pack.meshDir];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (/\.fbx$/i.test(e.name)) out.push(e.name.replace(/\.fbx$/i, ''));
    }
  }
  return [...new Set(out)].sort();
}

/** Where a mesh actually lives, since it may be in a subfolder. */
export function meshPath(pack: Pack, stem: string): string | null {
  const stack = [pack.meshDir];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name.toLowerCase() === `${stem.toLowerCase()}.fbx`) return full;
    }
  }
  return null;
}

/** The part files a pack ships, by stem, so a missing part is named not guessed. */
export function partStems(pack: Pack): Set<string> {
  return new Set(
    fs
      .readdirSync(pack.meshDir)
      .filter((f) => /\.fbx$/i.test(f))
      .map((f) => f.replace(/\.fbx$/i, '')),
  );
}

/**
 * The colour atlases a pack ships, by stem.
 *
 * Shared with the studio and the naming tools for the same reason `assemble`
 * is shared (D-558): three callers resolving a pack's textures three ways is
 * three chances to sample the wrong atlas, and D-560 already showed what that
 * costs — the unlettered cut hides every face marking in the pack.
 */
export function texturesIn(pack: Pack): string[] {
  return [...texturePaths(pack).keys()].sort();
}

/**
 * Every PNG in the pack, by stem, wherever it actually lives.
 *
 * ⚠ NOT just `textureDir`, and the knights pack is why: it keeps its people in
 * `Source_Files/Textures/` and `POLYGON_Knights_Texture_01.png` — the atlas
 * that covers every WEAPON and prop in the pack — one level up in
 * `Source_Files/`. Reading only the folder called "Textures" made that atlas
 * invisible to the studio, the creation tool and every colour measurement, and
 * sampling a sword against the character sheet returns confident nonsense: a
 * steel blade came back green and red.
 *
 * A vendor is not obliged to put every texture in one folder, so they are
 * found rather than assumed — the same rule `findDir` already applies to
 * meshes. The first path wins when two folders hold the same stem.
 */
export function texturePaths(pack: Pack): Map<string, string> {
  const found = new Map<string, string>();
  const base = path.join(SOURCE_DIR, pack.id);
  const stack = [base];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (/\.png$/i.test(e.name)) {
        const stem = e.name.replace(/\.png$/i, '');
        if (!found.has(stem)) found.set(stem, full);
      }
    }
  }
  return found;
}
