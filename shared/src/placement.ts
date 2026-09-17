import { z } from 'zod';
import { DIRECTIONS, type Direction } from './types';
import {
  VolumeSchema,
  transformVolume,
  volumesCover,
  type Transform,
  type Volume,
} from './collision';

/**
 * Things placed on a map (D-566, D-567).
 *
 * WARNING: this file used to hold the 44 procedural PROP TYPES -- crates,
 * barrels, stalls, braziers, gravestones -- built from code and placed on
 * whole tiles. They were the tile system's scenery and they are gone, along
 * with the 1,916 of them standing in the eleven authored areas. A map is built
 * from pack meshes now, which is what the stakeholder asked for and what the
 * editor has done since D-567; everything here is the placement side of that.
 *
 * The four FACILITIES survive as geometry in the client, because a station is
 * a gameplay object rather than scenery and the well has to be visible across
 * the square (D-529). They are a known residue and should become pack assets
 * too -- see `client/src/render/station-visual.ts`.
 */

/**
 * A pack mesh placed on the map (D-566, re-cut by D-567).
 *
 * The 44 `PROP_TYPES` were the tile system's scenery and are gone from the
 * map (D-567). This is what a map is made of now: a wall, a house, a tree out
 * of `content/assets/*.json`, standing anywhere, turned any angle.
 *
 * ⚠ `x`/`y` are METRES and `rotation` is ANY angle. They were integer tiles
 * and quarter turns because the grid was square; nothing here is square any
 * more, and a road leaving town at 37° is the ordinary case.
 *
 * ⚠ `collision` is BAKED IN at placement rather than looked up, and that trade
 * is unchanged from D-566: looking it up would thread the asset catalogue
 * through movement, the client's pathfinder and CI's reachability flood — every
 * caller changed, for a value that must never differ between them. Baking keeps
 * an area self-describing.
 *
 * ⚠ The cost is drift — an asset whose mask is redrawn later does not update
 * what is already placed — so `placedAssetDrift` reports it and CI fails on it.
 */
export const PlacedAssetSchema = z.object({
  /** The asset id in `content/assets/<pack>.environment.json`. */
  asset: z.string().min(1),
  pack: z.string().min(1),
  x: z.number(),
  y: z.number(),
  /** Metres above the datum: a lantern on a shelf, a bridge over a stream. */
  z: z.number().default(0),
  /** Degrees, clockwise. Free — see above. */
  rotation: z.number().default(0),
  scale: z.number().positive().default(1),
  /**
   * What it does to a body, in the ASSET's own frame — a copy of the asset's
   * mask, which a single placement may edit without forking the asset.
   */
  collision: z.array(VolumeSchema).default([]),
  /**
   * A seat, and which way a sitter faces on it (D-605).
   *
   * ⚠ BAKED from the catalogue at placement time, exactly as the collision
   * mask is and for the same reason: an area is self-describing, and the
   * server answers "can somebody sit here" without loading 1,402 assets it
   * otherwise never asks about.
   *
   * ⚠ The facing is the placement's own `rotation`, read as the direction a
   * sitter LOOKS: a chair at 180 is a chair whose occupant faces south. That
   * is the one thing a sit cannot guess — walk up to a chair from behind and
   * sit without being turned, and the animation plays into the backrest.
   */
  seat: z.boolean().default(false),
  /**
   * This placement's mask was edited ON PURPOSE and must not track the asset.
   *
   * ⚠ Without this the two halves of the stakeholder's ruling contradict each
   * other. "Per-asset, overridable per placement" means a copy that normally
   * follows the catalogue and sometimes deliberately does not — and the drift
   * check cannot tell those apart by looking. It fired on every hand-authored
   * doorway in the first map built this way, which trains people to ignore it,
   * which is worse than not having it.
   *
   * Set by the editor the moment a placement's mask is touched. Everything
   * without it still fails loudly when the asset moves underneath it.
   */
  overrideCollision: z.boolean().default(false),
  /**
   * This placement is SCATTER a tool owns (D-592), not something a person put
   * here.
   *
   * ⚠ It exists so `dress-areas.py` can replace its own work on a re-run
   * without touching a hand-placed thing, and so `prune-unreachable.ts` knows
   * what it is allowed to remove when a map has a pocket in it. Both of those
   * need to tell "the generator put four hundred rocks down" apart from "a
   * person placed this gate", and nothing else in a placement says which.
   *
   * ⚠ It is in the SCHEMA rather than left as a stray key because zod strips
   * what it does not know: a flag the editor silently dropped on the next save
   * would turn every scattered rock into a hand placement, quietly, and the
   * next dressing run would double the map.
   */
  dressed: z.boolean().default(false),
});
export type PlacedAsset = z.infer<typeof PlacedAssetSchema>;

/** Where a placed asset stands, as a transform. */
export function placedTransform(a: PlacedAsset): Transform {
  return { x: a.x, y: a.y, z: a.z, rotation: a.rotation, scale: a.scale };
}

/** Its collision volumes, moved into area coordinates. */
export function placedVolumes(a: PlacedAsset): Volume[] {
  const at = placedTransform(a);
  return a.collision.map((v) => transformVolume(v, at));
}

/** Every placed asset's volumes, for the area's collision layer. */
export function assetVolumes(assets: readonly PlacedAsset[]): Volume[] {
  return assets.flatMap(placedVolumes);
}

/**
 * Does this placed asset cover a point? Hit-testing, for selecting one in the
 * editor.
 *
 * ⚠ Tested against its VOLUMES, not a bounding box. Clicking the gap in a door
 * frame must not select the frame, or the thing you cannot walk through and the
 * thing you cannot click are different shapes and the editor lies about which.
 */
export function assetCovers(a: PlacedAsset, p: { x: number; y: number }): boolean {
  return volumesCover(placedVolumes(a), p);
}

/**
 * The compass direction a rotation points (D-605).
 *
 * ⚠ Degrees CLOCKWISE from north, which is how a placement already stores
 * its rotation — so a seat's facing is the number that is already there
 * rather than a second field that can disagree with the mesh.
 *
 * ⚠ Rounded to the nearest of the eight the wire carries. A character faces
 * one of eight ways (D-104); a chair turned 22 degrees is still a chair you
 * sit in facing roughly north, and inventing a ninth direction to be exact
 * about it would break every renderer that switches on the eight.
 */
/**
 * Which way somebody sitting on a seat is looking, given the seat's yaw
 * (D-609).
 *
 * ⚠ A seat's `rotation` is its MESH YAW, exactly like every other placed
 * asset in the game — the editor, the renderer and the drift checker all read
 * it that way, and a field that means one thing for 2,800 objects and the
 * opposite for 32 is a trap rather than a convention.
 *
 * ⚠ The half turn is a MEASURED fact about the art, not a guess: the pack's
 * chair is modelled with its backrest at -Z and the seat opening toward +Z,
 * so a chair whose mesh points north seats somebody looking south. The tavern
 * was authored the other way round — `rotation` held the SITTER'S facing and
 * the mesh was drawn at that same angle — which put all 32 chairs with their
 * backs to the tables. The semantics were right and the picture was wrong,
 * which is why `mr9-sitting` passed: it asserted the server against the
 * convention rather than the convention against the room.
 */
export function sitterFacingFor(seatRotation: number): Direction {
  return directionFromDegrees(seatRotation + 180);
}

export function directionFromDegrees(deg: number): Direction {
  const step = Math.round(((deg % 360) + 360) % 360 / 45) % 8;
  return DIRECTIONS[step]!;
}

/**
 * Where a map and the asset catalogue have come apart.
 *
 * Returns one line per placed asset whose baked mask no longer matches the
 * catalogue's, so the fix is a re-place rather than a mystery.
 */
export function placedAssetDrift(
  assets: readonly PlacedAsset[],
  catalogue: ReadonlyMap<string, { collision: readonly Volume[] }>,
): string[] {
  const out: string[] = [];
  for (const a of assets) {
    // A deliberate override is not drift. It is the other half of the rule.
    if (a.overrideCollision) continue;
    const def = catalogue.get(`${a.pack}/${a.asset}`);
    if (!def) {
      out.push(`places '${a.asset}' from ${a.pack}, which the asset catalogue does not define`);
      continue;
    }
    // ⚠ Compared as VALUES, not by count. A mask redrawn to the same number of
    // volumes in different places is exactly the drift worth catching, and a
    // length check would pass it.
    if (JSON.stringify(def.collision) !== JSON.stringify(a.collision)) {
      out.push(
        `'${a.asset}' at ${a.x.toFixed(1)},${a.y.toFixed(1)} was placed with a collision mask ` +
          `the catalogue no longer agrees with — re-place it, or keep the override deliberately`,
      );
    }
  }
  return out;
}

/**
 * How far a pack mesh must be moved so its ORIGIN is the centre of its
 * footprint (D-591).
 *
 * A placed asset's `x,y` is the centre of the thing — that is what the editor
 * shows, what the collision mask is baked around, and what every generator
 * assumes. Almost every mesh in every pack agrees: measured across three
 * packs, walls, gates, houses and stalls all sit within a centimetre of
 * centred, and a tree or a statue is a little off because its canopy leans.
 *
 * ⚠ Two meshes do NOT: `SM_Env_Path_Cobble_01` and `_02` span 0…3 in x and
 * −3…0 in z, so their origin is a CORNER. Every cobble path in Ashfold was
 * drawn a metre and a half to the east and a metre and a half to the north of
 * the road it was laid on — the paved way missing the gate it leads to, in a
 * town whose gates and walkable corridor are aligned to the centimetre.
 *
 * ⚠ The rule is NARROW ON PURPOSE, and the narrowness is the point. Centring
 * every mesh on its bounding box would "fix" the two that are broken and move
 * a dozen that are right: a tree's origin is its TRUNK, and its box centre is
 * somewhere out in the canopy, so blanket-centring walks every tree off its
 * tile. So an axis is corrected only when the mesh lies ENTIRELY to one side
 * of the origin on it — which is a corner origin and cannot be anything else.
 * This is D-558's lesson about art repair: scan before implementing, because
 * most of what a loose rule flags is correct art.
 */
export function originCorrection(
  box: { minX: number; maxX: number; minZ: number; maxZ: number },
  tolerance = 0.05,
): { dx: number; dz: number } {
  const axis = (min: number, max: number): number =>
    min >= -tolerance || max <= tolerance ? -(min + max) / 2 : 0;
  return { dx: axis(box.minX, box.maxX), dz: axis(box.minZ, box.maxZ) };
}
