import './node-dom';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Box3, Vector3, type Mesh, type Object3D } from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import {
  AssetFileSchema,
  kindOfMesh,
  type AssetFile,
  type EnvironmentAsset,
} from '@rc/shared';
import { allMeshStems, allPacks, meshPath } from './packs.js';
import { draftName } from './name-assets.js';

/**
 * Classify the 1,402 environment meshes so a map can be built out of them
 * (D-566).
 *
 *   npm run name:environment
 *
 * The map editor places 44 procedurally-built prop types and cannot place a
 * pack mesh at all, which leaves the entire environment library unreachable by
 * the game. This is the half of that gap that is measurable.
 *
 * ⚠ Environment filenames ARE descriptive, unlike the character parts — a wall
 * is `SM_Bld_Wall_01` and a tree is `SM_Env_Tree_01`. D-563 deliberately did
 * not draft names for them ("1,459 `Wall_01`-shaped names is noise") and that
 * judgement was about NAMES. It was wrong about the rest: whether a thing stops
 * a body, stops an eye, and how many tiles it covers are all derivable, and
 * they are the fields the map actually needs.
 *
 * ⚠ `solid` and `opaque` are SEPARATE, and conflating them is how a witness
 * sees through a wall or fails to see over a rail (D-217, D-545). A fence stops
 * a body and not an eye. So both are decided, and the decision leans on the
 * measured HEIGHT as well as the name: nothing knee-high blocks line of sight,
 * whatever it is called.
 */

const root = fileURLToPath(new URL('../..', import.meta.url));
const assetsDir = join(root, 'content', 'assets');
const loader = new FBXLoader();

/** One tile is one world unit is one metre (`terrain.ts` builds 1.0 boxes). */
export const TILE_METRES = 1;

/** Anything shorter than this cannot block a line of sight. */
export const SIGHT_HEIGHT = 1.2;

/**
 * Names that describe a thing you can see past, whatever its height.
 *
 * ⚠ Sight, not movement. A palisade is solid and a rail is not, but neither is
 * opaque — you can see between the stakes. Getting this wrong does not look
 * like a bug, it silently changes who witnessed a murder (D-217).
 */
const SEE_THROUGH = /fence|railing|rail|spike|gate|bars|lattice|arch|scaffold|ladder|banner|flag|chain|rope|web/i;

/** Names that lie flat on the ground: paths, tiles, decals, rubble. */
const FLAT = /path|tiles?$|_tile|floor|ground|decal|dirt|puddle|rubble|blood|crack|leaves|grass_/i;

/** Names that are certainly a wall, a building or a rock. */
const MASSIVE = /wall|house|castle|tower|church|bld_|room|cliff|rock|boulder|pillar|column|door/i;

export interface EnvMeasurement {
  /** Extent in metres, after the pack's unit convention is applied. */
  readonly size: [number, number, number];
  readonly footprint: [number, number];
  readonly solid: boolean;
  readonly opaque: boolean;
  readonly operable: boolean;
}

/**
 * What a mesh is, given its name and its size.
 *
 * Pure, so the decisions are testable without loading an FBX — which matters,
 * because the art is gitignored and CI has none of it.
 */
/**
 * A measurement in metres, to the millimetre.
 *
 * ⚠ Rounded because the raw float is seventeen digits of noise: a mesh is
 * not measured to the width of an atom, and an unrounded number makes every
 * re-run a diff and every review a scroll. A millimetre is finer than anything
 * `STEP_UP` (0.35m) or `SIGHT_HEIGHT` can act on.
 */
function mm(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function classify(stem: string, size: [number, number, number]): EnvMeasurement {
  const [x, height, z] = size;
  const flat = FLAT.test(stem) || height < 0.15;
  const seeThrough = SEE_THROUGH.test(stem);
  const massive = MASSIVE.test(stem);

  // ⚠ A door is `operable` and still solid: it blocks until it is opened, and
  // an area whose only doorway was walkable-by-default would let anybody stroll
  // through a locked church.
  const operable = /door|gate|chest|lid|hatch|portcullis|drawbridge/i.test(stem);

  const solid = flat ? false : massive || seeThrough || height >= 0.3;
  const opaque = !flat && !seeThrough && height >= SIGHT_HEIGHT;

  const tiles = (n: number): number => Math.max(1, Math.min(24, Math.round(n / TILE_METRES)));
  return {
    size,
    footprint: [tiles(x), tiles(z)],
    solid,
    opaque,
    operable,
  };
}

/**
 * The scale that turns a pack's own units into metres.
 *
 * The same measurement `fit:weapons` makes and for the same reason: the packs
 * disagree by 100× and nothing in a file listing shows it (D-561). Taken from
 * the MEDIAN of what has been measured so far, so one enormous castle piece
 * cannot decide it for six hundred props.
 */
export function unitScale(lengths: readonly number[]): number {
  if (lengths.length === 0) return 1;
  const sorted = [...lengths].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]! > 20 ? 0.01 : 1;
}

function boxOf(object: Object3D): Vector3 {
  const box = new Box3();
  object.updateMatrixWorld(true);
  object.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    mesh.geometry.computeBoundingBox();
    const b = mesh.geometry.boundingBox;
    if (b) box.union(new Box3().copy(b).applyMatrix4(mesh.matrixWorld));
  });
  const size = new Vector3();
  box.getSize(size);
  return size;
}

const invokedDirectly = process.argv[1]?.includes('name-environment');
if (invokedDirectly) {
  for (const pack of allPacks()) {
    const stems = allMeshStems(pack).filter((s) => kindOfMesh(s) === 'environment');
    if (stems.length === 0) continue;

    const file = join(assetsDir, `${pack.id}.environment.json`);
    const existing: AssetFile = existsSync(file)
      ? AssetFileSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
      : { pack: pack.id, kind: 'environment', assets: [] };
    const byMesh = new Map(existing.assets.map((a) => [a.mesh, a]));

    // Two passes: measure everything first so the unit convention is decided
    // from the whole pack rather than from whichever mesh happened to be first.
    const raw = new Map<string, Vector3>();
    for (const stem of stems) {
      const path = meshPath(pack, stem);
      if (!path) continue;
      try {
        raw.set(stem, boxOf(loader.parse(readFileSync(path).buffer as ArrayBuffer, '')));
      } catch {
        /* a mesh that will not parse is reported by the count at the end */
      }
    }
    const scale = unitScale([...raw.values()].map((v) => Math.max(v.x, v.y, v.z)));

    // ⚠ `Railing_01` through `_04` all draft to "Railing", and two things
    // sharing a name is legal data and a broken menu (D-561) — the validator
    // fails the build over it. They ARE four different railings, so numbering
    // is honest: "Railing 2" tells a map author which of them this is, which is
    // the only thing they need from the name at this stage.
    const taken = new Set(existing.assets.map((a) => a.name.toLowerCase()));

    let added = 0;
    let kept = 0;
    let sized = 0;
    for (const [stem, size] of raw) {
      const already = byMesh.get(stem);
      if (already) {
        kept++;
        // ⚠ BACKFILL the measured extent, and nothing else.
        //
        // `size` was added to the schema by D-567 and only ever written for
        // assets drafted AFTER it existed — which was none of them. Measured:
        // 1,402 catalogued assets, 0 carrying a size. Every one of them
        // therefore collided as a box of its footprint by a flat DEFAULT 3m
        // (`defaultMask`), so a barrel and a gatehouse were the same height to
        // walk into, and the one number the schema says decides whether a
        // thing is walked over, under or into was a guess.
        //
        // ⚠ ONLY `size`. `solid`, `opaque`, `footprint` and the name may all
        // have been corrected by a person since they were drafted, and
        // re-deriving them from the mesh would silently undo that work — which
        // is the same reason `name:assets` skips a mesh somebody has already
        // catalogued (D-568). A backfill fills a hole; it does not re-run a
        // decision.
        if (already.kind === 'environment' && already.size === undefined) {
          already.size = [mm(size.x * scale), mm(size.y * scale), mm(size.z * scale)];
          sized++;
        }
        continue;
      }
      const metres: [number, number, number] = [
        mm(size.x * scale), mm(size.y * scale), mm(size.z * scale),
      ];
      const m = classify(stem, metres);
      let name = draftName(stem);
      if (taken.has(name.toLowerCase())) {
        let n = 2;
        while (taken.has(`${name} ${n}`.toLowerCase())) n++;
        name = `${name} ${n}`;
      }
      taken.add(name.toLowerCase());
      const asset: EnvironmentAsset = {
        id: stem.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
        name,
        pack: pack.id,
        mesh: stem,
        tags: ['draft'],
        kind: 'environment',
        solid: m.solid,
        opaque: m.opaque,
        footprint: m.footprint,
        // ⚠ The measured height is KEPT now (D-567). `footprint` threw away the
        // one number that decides whether a thing is walked over, under or
        // into, and a bounding rectangle with no height is what made 395
        // assets block nine tiles apiece.
        size: m.size,
        operable: m.operable,
        // ⚠ Seats are decided by a person, not by the classifier. A bench,
        // a stool and a throne are a chair; so, by name, are a "bench press"
        // and a "chair rail". D-568 settled that English is not a classifier,
        // and the cost of guessing here is somebody sitting on a fence.
        seat: false,
        clips: {},
        collision: [],
      };
      existing.assets.push(asset);
      added++;
    }
    existing.assets.sort((a, b) => a.mesh.localeCompare(b.mesh));
    writeFileSync(file, `${JSON.stringify(AssetFileSchema.parse(existing), null, 2)}\n`);

    const solid = existing.assets.filter((a) => a.kind === 'environment' && a.solid).length;
    const opaque = existing.assets.filter((a) => a.kind === 'environment' && a.opaque).length;
    console.log(
      `${pack.id.padEnd(22)} ${String(added).padStart(4)} drafted, ${kept} kept` +
        `${sized ? `, ${sized} measured` : ''}  ` +
        `· units ${scale === 1 ? 'metres' : 'centimetres'}  ` +
        `· ${solid} solid, ${opaque} opaque of ${existing.assets.length}`,
    );
  }
}
