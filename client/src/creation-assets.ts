import { API } from './authoring-api';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import {
  ACTION_GROUPS,
  STANCES,
  type AssetDef,
  type AssetFile,
  type AssetKind,
  type CharacterItem,
  type EnvironmentAsset,
  type PickupAsset,
} from '@rc/shared';

export type {
  AssetDef,
  AssetFile,
  AssetKind,
  CharacterItem,
  EnvironmentAsset,
  PickupAsset,
} from '@rc/shared';

/**
 * Naming and describing everything that is not a character part (D-561).
 *
 * Three tabs — worn items, environment, pickups — over one implementation,
 * because the job is identical in all three: a mesh has a filename nobody can
 * show a player and properties nothing can infer from it. Only the per-kind
 * property panel differs.
 *
 * ⚠ Packs disagree about UNITS. This vendor's dungeon weapons are authored in
 * metres and their knights and vikings weapons in centimetres — a hundredfold
 * difference that is invisible in a file listing and unmissable on a
 * character. The tool measures each mesh as it loads and shows what it would
 * be in centimetres once placed, so the mistake is caught by looking.
 */



export interface MeshEntry {
  stem: string;
  kind: AssetKind | null;
}

export interface AssetPackCatalogue {
  meshes: MeshEntry[];
  textures: string[];
}

const loader = new FBXLoader();
const bytes = new Map<string, ArrayBuffer>();

/** Load one mesh, cached as BYTES and parsed fresh — as everywhere else. */
export async function assetMesh(pack: string, stem: string): Promise<THREE.Object3D> {
  const key = `${pack}/${stem}`;
  let buf = bytes.get(key);
  if (!buf) {
    buf = await (
      await fetch(`${API}/assetpacks/${encodeURIComponent(pack)}/fbx/${encodeURIComponent(stem)}`)
    ).arrayBuffer();
    bytes.set(key, buf);
  }
  return loader.parse(buf.slice(0), '');
}

/**
 * How big this mesh is, in its own units.
 *
 * The number that tells you whether a pack is metres or centimetres, and the
 * only honest way to find out: the files do not say.
 */
export function measure(object: THREE.Object3D): THREE.Vector3 {
  const box = new THREE.Box3().setFromObject(object);
  return new THREE.Vector3().subVectors(box.max, box.min);
}

/**
 * A scale that makes this mesh a sensible size, guessed from its own extent.
 *
 * A weapon between 0.3 and 3 units long is already metres; one between 30 and
 * 300 is centimetres. Offered as a STARTING VALUE that the person can see and
 * override, never applied silently — a guess that cannot be seen is the same
 * defect as a unit that cannot be seen.
 */
export function guessScale(longest: number): number {
  if (longest <= 0) return 1;
  return longest > 20 ? 0.01 : 1;
}

export async function loadAssetPacks(): Promise<string[]> {
  const list = (await (await fetch(`${API}/assetpacks`)).json()) as { id: string }[];
  return list.map((p) => p.id);
}

export async function loadAssetCatalogue(pack: string): Promise<AssetPackCatalogue> {
  return (await (
    await fetch(`${API}/assetpacks/${encodeURIComponent(pack)}`)
  ).json()) as AssetPackCatalogue;
}

export async function loadAssets(pack: string, kind: AssetKind): Promise<AssetFile> {
  return (await (
    await fetch(`${API}/assets/${encodeURIComponent(pack)}/${kind}`)
  ).json()) as AssetFile;
}

export async function saveAssets(file: AssetFile): Promise<{ ok: boolean; problems: string[] }> {
  const res = await fetch(
    `${API}/assets/${encodeURIComponent(file.pack)}/${file.kind}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(file),
    },
  );
  const body = (await res.json()) as { problems?: string[]; error?: string; issues?: unknown[] };
  if (res.ok) return { ok: true, problems: [] };
  const problems =
    body.problems ?? (body.issues ?? []).map((i) => JSON.stringify(i)) ?? [body.error ?? 'refused'];
  return { ok: false, problems: problems.length ? problems : [body.error ?? 'refused'] };
}

/** An id from a mesh name: `SM_Wep_Broadsword_01` becomes `wep-broadsword-01`. */
export function idFromMesh(stem: string): string {
  return stem
    .replace(/^S[MK]_/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** A first draft of a name, so a hundred rows are edits rather than blanks. */
export function nameFromMesh(stem: string): string {
  const bare = stem.replace(/^S[MK]_/i, '').replace(/^(Wep|Bld|Env|Prop|Gen|Item|Veh)_/i, '');
  return bare
    .replace(/_(\d+)$/, '')
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
}

/** A blank asset of the right kind, ready to edit. */
export function blankAsset(kind: AssetKind, pack: string, mesh: string, scale: number): AssetDef {
  const core = { id: idFromMesh(mesh), name: nameFromMesh(mesh), pack, mesh, tags: [] };
  if (kind === 'character-item') {
    return {
      ...core,
      kind,
      // The right hand, spelled as this rig spells it. Overridable, because
      // a shield belongs in the left and a quiver on the back.
      attach: 'Hand_R',
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale },
      stance: 'one-handed',
      clips: {},
    } satisfies CharacterItem;
  }
  if (kind === 'environment') {
    return {
      ...core,
      kind,
      solid: true,
      opaque: true,
      footprint: [1, 1],
      operable: false,
      clips: {},
      // Unauthored: `defaultMask` derives a box from the measured size until
      // somebody draws the real shape (D-567).
      collision: [],
    } satisfies EnvironmentAsset;
  }
  return {
    ...core,
    kind,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale },
  } satisfies PickupAsset;
}

/** Actions worth offering per kind, so a barrel is not asked about its parry. */
export function actionsFor(kind: AssetKind): readonly string[] {
  if (kind === 'character-item') {
    return [...ACTION_GROUPS.locomotion!, ...ACTION_GROUPS.combat!];
  }
  if (kind === 'environment') return ['open', 'use'];
  return ['pick-up', 'use'];
}

export const STANCE_OPTIONS = STANCES;
