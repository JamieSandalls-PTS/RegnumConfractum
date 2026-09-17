import { z } from 'zod';
import { ActionSchema, StanceSchema } from './actions';
import { VolumeSchema, type Volume } from './collision';

/**
 * Everything in the packs that is not a character part, named and described
 * (D-561).
 *
 * Three kinds, one shape, because the job is the same in all three: a mesh
 * file has a name nobody can show a player and properties nothing can infer.
 * `SM_Wep_Broadsword_01` is a filename; "an arming sword" is a thing in a
 * world. Nothing downstream — an item template, a description, a container
 * listing — can use the first.
 *
 * As with character parts, only the DECISION is stored. Which pack a mesh is
 * in and how big it is are read from the file.
 */

export const ASSET_KINDS = ['character-item', 'environment', 'pickup'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

/** What every named asset carries, whatever kind it is. */
const AssetCoreSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  /** What a player is told it is. */
  name: z.string().min(1),
  /** The ingested pack, and the mesh file stem within it. */
  pack: z.string().min(1),
  mesh: z.string().min(1),
  /**
   * Free keywords. This is what gates equipment by class or race later:
   * tagging beats a table of ids, because a tag survives adding a class.
   */
  tags: z.array(z.string().min(1)).default([]),
  note: z.string().optional(),
});

/**
 * A transform, in the character's own space.
 *
 * ⚠ `scale` is not decoration. Packs disagree about units: this vendor's
 * dungeon weapons are authored in METRES (a longsword is 1.2 units) while
 * their knights and vikings weapons are in CENTIMETRES (the same sword is
 * 120). Characters are centimetres. Getting it wrong is not subtle — it is a
 * sword the size of a thumbnail — but it is invisible in a file listing, so
 * the scale is stored and the tool shows the resulting length in centimetres
 * beside it.
 */
export const AttachTransformSchema = z.object({
  position: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  /** Euler angles in DEGREES, because a person is typing them. */
  rotation: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  scale: z.number().positive().default(1),
});
export type AttachTransform = z.infer<typeof AttachTransformSchema>;

/**
 * Something a character wears or carries: a weapon, a shield, a banner.
 *
 * ⚠ These are RIGID meshes with no skeleton of their own, so they hang off a
 * bone rather than deforming with one. That is why an attach point and a
 * transform are required and a slot alone will not do: a sword parented to a
 * hand with no offset sticks out of the wrist.
 */
export const CharacterItemSchema = AssetCoreSchema.extend({
  kind: z.literal('character-item'),
  /**
   * The bone it hangs from, by name. Not an enum: rigs disagree about what
   * the right hand is called, and `rigNamesFor` already exists to resolve
   * that per skeleton.
   */
  attach: z.string().min(1),
  transform: AttachTransformSchema.default({}),
  /**
   * How holding this makes a character carry themselves. The stance is what
   * selects an animation set, so a hundred and sixty weapons need a handful
   * of stances rather than a hundred and sixty animation sets.
   */
  stance: StanceSchema.default('one-handed'),
  /**
   * Clips this specific item overrides, on top of its stance. Almost always
   * empty — a named sword with its own attack exists, but it is the
   * exception, and the schema should make it look like one.
   */
  clips: z.record(ActionSchema, z.string().min(1)).default({}),
});
export type CharacterItem = z.infer<typeof CharacterItemSchema>;

/**
 * Something placed in the world: a building, a tree, a barrel.
 *
 * The properties here are the ones the SERVER needs, which is why they are so
 * few. Whether a thing blocks movement and whether it blocks sight are
 * simulation facts — reachability is checked in CI (D-542) and line of sight
 * is what makes a witness (D-217) — while everything else about how it looks
 * is the renderer's business.
 */
export const EnvironmentAssetSchema = AssetCoreSchema.extend({
  kind: z.literal('environment'),
  /** Blocks movement. CI floods the map and fails on an unreachable tile. */
  solid: z.boolean().default(true),
  /**
   * Blocks line of sight. Separate from `solid` on purpose: a fence stops a
   * body and not an eye, and conflating them is how a witness sees through a
   * wall or fails to see over a rail (D-545).
   */
  opaque: z.boolean().default(true),
  /** Tiles it occupies, for placement and for the reachability flood. */
  footprint: z.tuple([z.number().int().positive(), z.number().int().positive()]).default([1, 1]),
  /** A door, a chest, a portcullis: something that opens. */
  operable: z.boolean().default(false),
  /**
   * Something a person can sit on (D-605).
   *
   * ⚠ A fact about the ASSET, not about where it stands: a stool is a stool
   * in every tavern. It is copied onto each placement the way collision is
   * (D-567), because the server holds areas and deliberately does not hold the
   * 1,402-entry environment catalogue.
   */
  seat: z.boolean().default(false),
  /** Clips for opening and closing, when it is operable. */
  clips: z.record(ActionSchema, z.string().min(1)).default({}),
  /**
   * The mesh's measured extent in metres, `[x, height, z]`.
   *
   * ⚠ Kept because HEIGHT is what decides whether a thing is walked over,
   * under, or into (D-567), and the classifier already measured it and threw
   * it away — `footprint` kept two of the three numbers. Absent on anything
   * classified before this existed.
   */
  size: z.tuple([z.number(), z.number(), z.number()]).optional(),
  /**
   * What this asset does to a body, in its OWN frame, metres about its origin
   * (D-567).
   *
   * ⚠ Authored once here and inherited by every placement, which is what makes
   * a door frame worth getting right: 684 dungeon-pack assets, each placed
   * many times. A placement may override its own copy — so one wall in one map
   * can have a gap knocked in it without forking the asset.
   *
   * Empty means "not authored yet", NOT "passable": `defaultMask` derives a
   * conservative box from the measured size. The distinction matters because
   * 1,157 assets arrive here unauthored, and an empty list that meant
   * "walk through" would make every one of them a ghost.
   */
  collision: z.array(VolumeSchema).default([]),
});
export type EnvironmentAsset = z.infer<typeof EnvironmentAssetSchema>;

/**
 * The collision an asset has before anybody authors one.
 *
 * ⚠ A single box the size of the mesh — deliberately the CRUDEST possible
 * answer, and deliberately not silent about it. It is exactly the bounding
 * rectangle that made 395 assets block nine tiles or more, so it is a
 * placeholder that keeps a map honest until a person opens the asset and draws
 * the real shape. What it buys is that nothing is passable by accident.
 *
 * `solid: false` still yields nothing, because that classification was made by
 * measurement (flat things, ground planes, decals) and is the one the old
 * system got right.
 */
export function defaultMask(asset: EnvironmentAsset): Volume[] {
  if (asset.collision.length > 0) return asset.collision;
  if (!asset.solid) return [];
  const [w, h] = asset.footprint;
  const height = asset.size?.[1] ?? 3;
  return [
    {
      shape: { kind: 'rect', x: 0, y: 0, w, h, rotation: 0 },
      base: 0,
      top: height,
      walkable: false,
      opaque: asset.opaque,
      sightTop: undefined,
      ramp: undefined,
    },
  ];
}

/**
 * Something that goes in a pack: a potion, a loaf, an ore.
 *
 * Deliberately thin. What an item DOES is already content (`content/items/`,
 * D-210) and is validated against the recipe graph; this only says which mesh
 * and which name belong to it, so the two can be joined without either
 * guessing at the other's filenames.
 */
export const PickupAssetSchema = AssetCoreSchema.extend({
  kind: z.literal('pickup'),
  /** The `content/items/` template this mesh represents, once one exists. */
  item: z.string().optional(),
  /** How it sits when dropped on the ground, if the mesh needs righting. */
  transform: AttachTransformSchema.default({}),
});
export type PickupAsset = z.infer<typeof PickupAssetSchema>;

export const AssetSchema = z.discriminatedUnion('kind', [
  CharacterItemSchema,
  EnvironmentAssetSchema,
  PickupAssetSchema,
]);
export type AssetDef = z.infer<typeof AssetSchema>;

/** One file per pack per kind, so a pack can be re-ingested without a merge. */
export const AssetFileSchema = z.object({
  pack: z.string().min(1),
  kind: z.enum(ASSET_KINDS),
  assets: z.array(AssetSchema).default([]),
});
export type AssetFile = z.infer<typeof AssetFileSchema>;

/**
 * Which kind a mesh looks like it is, from the vendor's own prefix.
 *
 * A starting point for the tool's lists, never a decision: the prefixes are
 * consistent across every pack here (`Wep_`, `Bld_`, `Env_`, `Prop_`,
 * `Item_`), and a guess that puts a barrel in front of somebody to confirm
 * beats an empty list they have to populate by hand.
 */
export function kindOfMesh(stem: string): AssetKind | null {
  const bare = stem.replace(/^S[MK]_/i, '');
  if (/^Wep_/i.test(bare)) return 'character-item';
  // A rigged weapon is still a weapon. The bow pack ships its bows as skinned
  // meshes with a draw rig and no `Wep_` prefix, so without this they are the
  // only weapons in the repository that no tool would list.
  //
  // ⚠ This is as far as guessing goes, and an ammunition rule was tried here
  // and REVERTED. The bow pack files its three projectiles under three
  // different conventions (`SM_Arrow_01`, `SM_Prop_Arrow_NativeAmerican_01`,
  // `SM_Wep_Crossbow_Bolt_01`), so a word rule looks necessary — but "bolt"
  // is a fastener as often as it is ammunition and "arrow" modifies "slit".
  // Matching the word mis-filed `SM_Env_Basement_Support_Beam_Bolt_01`,
  // `SM_Prop_Bolt_01` and `SM_Bld_Castle_Arrow_Slit_01`: three meshes broken
  // to fix three. English is not a classifier. The three oddities are filed
  // BY HAND instead, which `nameAssets` now leaves alone (see `draftFor`).
  if (/^Rigged_/i.test(bare)) return 'character-item';
  if (/^(Bld_|Env_|Prop_|Gen_|Veh_)/i.test(bare)) return 'environment';
  if (/^Item_/i.test(bare)) return 'pickup';
  return null;
}

/**
 * Which SHELF of the creation tool a pack mesh belongs on.
 *
 * ⚠ TOTAL — every mesh lands somewhere, and that is the whole point.
 * `kindOfMesh` returns null for anything its prefixes do not cover, which is
 * correct for a CATALOGUE (better no entry than a guessed one, D-561) and
 * quietly disastrous for a MENU: the tool filters by kind, so a mesh with no
 * kind appeared in no tab and could not be found, named or placed by anybody.
 * Completeness by construction rather than by hoping the prefixes cover a
 * vendor we have not read yet.
 *
 * ⚠ It does NOT guess harder than `kindOfMesh` does. `unfiled` is a real
 * answer and is shown as one — D-568 tried matching English words to file the
 * last few and broke three meshes to fix three, because "bolt" is a fastener
 * as often as it is ammunition. A person files those; this only makes sure
 * they can see them.
 */
export type MeshShelf = AssetKind | 'character' | 'body-part' | 'helper' | 'unfiled';

export function meshShelf(stem: string): MeshShelf {
  // ⚠ Helpers FIRST, because several of them also carry a real prefix:
  // `SM_Bld_Base_Stairs_01_Collision` is a physics hull, not a staircase, and
  // classifying by prefix alone offered 78 invisible boxes as scenery.
  if (/(_collision|_convex|_lod\d*|_pivot)$/i.test(stem)) return 'helper';
  if (/^(FX_|SM_LightRay|AATest)/i.test(stem)) return 'helper';
  const bare = stem.replace(/^S[MK]_/i, '');
  // A whole rigged person is a CHARACTER (D-594), not a prop to place.
  if (/^Character[_s]/i.test(bare) || /^Generic_Characters$/i.test(bare)) return 'character';
  // Modular body parts have their own tab and their own catalogue (D-560).
  if (/^Chr_/i.test(bare)) return 'body-part';
  const kind = kindOfMesh(stem);
  if (kind) return kind;
  // ⚠ `Prp_` is the knights pack misspelling its own `Prop_` prefix, on one
  // mesh. Spelled out rather than folded into `kindOfMesh`, because that
  // function decides what a CATALOGUE may claim and this decides what a menu
  // shows — and a vendor typo is a fact about one pack, not a naming rule.
  if (/^Prp_/i.test(bare)) return 'environment';
  return 'unfiled';
}

/** Everything wrong with a set of assets, in one list. Pure, so CI and the tool agree. */
export function assetProblems(file: AssetFile, meshesInPack: ReadonlySet<string> | null): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const names = new Map<string, string>();
  for (const asset of file.assets) {
    if (asset.kind !== file.kind) {
      problems.push(`${asset.id}: is a ${asset.kind} in the ${file.kind} file`);
    }
    if (ids.has(asset.id)) problems.push(`${asset.id}: named twice`);
    ids.add(asset.id);
    // Two things with one name is a defect in a menu, not in the data.
    const clash = names.get(asset.name.toLowerCase());
    if (clash) problems.push(`"${asset.name}" names both ${clash} and ${asset.id}`);
    names.set(asset.name.toLowerCase(), asset.id);
    if (meshesInPack && !meshesInPack.has(asset.mesh)) {
      problems.push(`${asset.id}: mesh "${asset.mesh}" is not in ${file.pack}`);
    }
  }
  return problems;
}
