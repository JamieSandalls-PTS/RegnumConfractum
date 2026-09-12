import { z } from 'zod';
import type { Vec2 } from './types';

/**
 * The world's collision layer, in METRES (D-567).
 *
 * ⚠ This file replaces the tile grid as the thing that decides where a body
 * can be. D-104 moved characters tile to tile and asked one boolean per tile;
 * that could not express a door (passable in a strip narrower than a tile), an
 * arch (passable because of its HEIGHT), or a stair. 1,157 of 1,402
 * environment assets were marked solid over a bounding rectangle and 395 of
 * them blocked nine tiles or more, so no interior could be authored that
 * anybody could walk into.
 *
 * ⚠ The design rule, and the reason there is no `blocks` flag anywhere below:
 * **"blocked" is not a property, it is an outcome.** A volume stops you when
 * its top is higher than you can step onto and its body overlaps yours. That
 * one rule produces every behaviour the map needs:
 *
 *   kerb / rug / root   top 0.15m           you walk OVER it   (within STEP_UP)
 *   stair / ramp        ramp 0 → 2.4m       you walk UP it     (each step is small)
 *   wall                top 3m              you are BLOCKED    (too high, bodies overlap)
 *   arch / bridge       base 2.4m, top 4m   you walk UNDER it  (bodies never overlap)
 *
 * Adding a `blocks: true` flag would let a volume's geometry and its flag
 * disagree, and the version that renders is not always the version that
 * decides — which is the class of bug this project keeps finding.
 */

/** How high a character steps without effort. A kerb, a root, one stair tread. */
export const STEP_UP = 0.35;

/**
 * How far a character drops without refusing to go.
 *
 * ⚠ Deliberately larger than `STEP_UP` and NOT symmetric: stepping off a low
 * wall is easy and climbing it is not, and a symmetric rule makes every ledge
 * a one-way door. Beyond this the edge refuses — which is what makes a cliff
 * a boundary rather than a way to die.
 */
export const MAX_DROP = 1.2;

/** Shoulder height, for what a body occupies and what an eye sees over. */
export const BODY_HEIGHT = 1.8;

/** Half a character's width. Bodies are circles; nothing here needs more. */
export const BODY_RADIUS = 0.3;

/** Where the eye sits for line of sight (D-217). */
export const EYE_HEIGHT = 1.6;

/** The area's ground plane. Everything is measured from it. */
export const DATUM = 0;

export const Vec2Schema = z.object({ x: z.number(), y: z.number() });

/**
 * A footprint on the ground plane.
 *
 * ⚠ A rect is placed by its CENTRE, not its corner, because it rotates freely
 * and a corner-anchored rect moves when you turn it. The tile system could
 * anchor at a corner precisely because it could not rotate.
 */
export const ShapeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('rect'),
    x: z.number(),
    y: z.number(),
    w: z.number().positive(),
    h: z.number().positive(),
    /** Degrees, clockwise in the screen frame (+x east, +y south). Free. */
    rotation: z.number().default(0),
  }),
  z.object({
    kind: z.literal('circle'),
    x: z.number(),
    y: z.number(),
    r: z.number().positive(),
  }),
  z.object({
    kind: z.literal('poly'),
    /** A simple polygon in area coordinates; winding does not matter. */
    points: z.array(Vec2Schema).min(3),
  }),
]);
export type Shape = z.infer<typeof ShapeSchema>;

export const VolumeSchema = z
  .object({
    shape: ShapeSchema,
    /** Underside, metres above the datum. Above `BODY_HEIGHT` you walk under it. */
    base: z.number().default(0),
    /** Top surface, metres above the datum. */
    top: z.number(),
    /**
     * May a character stand on the top surface?
     *
     * ⚠ Defaults to FALSE, and the direction was chosen after it defaulted the
     * other way and broke the pathfinder in three places at once. A volume is
     * an obstacle unless somebody says otherwise: defaulting to true made every
     * 3m wall a standable platform at 3m and every archway a floor at 4m, so
     * the navigation index filled with floating open ground nothing could reach
     * and routes detoured around thin air. Standing on something is an
     * authoring act — a step, a kerb, a bridge deck — and it is one tick box.
     *
     * ⚠ Not the same question as whether the top is REACHABLE. A 3m wall marked
     * walkable is still a wall from the ground; this only says what happens if
     * you ever get up there.
     */
    walkable: z.boolean().default(false),
    /**
     * Does it stop a line of sight (D-217, D-545)?
     *
     * ⚠ SEPARATE from geometry and it must stay that way. A rail stops a body
     * and not an eye; a thicket stops an eye and not a body. Line of sight is
     * what makes a witness, and deriving it from height would quietly decide
     * who saw a murder.
     */
    opaque: z.boolean().default(false),
    /**
     * How high the EYE is stopped, when that is not the same as how high the
     * body is stopped. Defaults to `top`.
     *
     * ⚠ Added because a thicket broke the "blocked is an outcome" rule and the
     * test caught it. Undergrowth, smoke, a hanging and a bead curtain are all
     * pushed THROUGH — geometry says passable, and geometry is right — while
     * stopping sight well above head height. `opaque` was already separate
     * from geometry (a rail stops a body and not an eye); this is the same
     * separation in the other direction, and it is one number rather than a
     * `solid` flag that could disagree with the shape.
     */
    sightTop: z.number().optional(),
    /**
     * A linear gradient across the top surface — a ramp, a stair, a slope.
     *
     * `low` and `high` are heights above the datum at the two ends of the
     * shape's own local axis, so a staircase turned 37° still runs up its own
     * length. ⚠ Rects only: a gradient across a circle has no defined
     * direction, and one across a concave polygon has several.
     */
    ramp: z
      .object({
        along: z.enum(['x', 'y']),
        low: z.number(),
        high: z.number(),
      })
      .optional(),
  })
  .superRefine((v, ctx) => {
    if (v.top < v.base) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `top ${v.top} is below base ${v.base}` });
    }
    if (v.sightTop !== undefined && v.sightTop < v.top) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `sightTop ${v.sightTop} is below top ${v.top} — an eye stopped lower than a body is just 'opaque: false'`,
      });
    }
    if (v.ramp && !v.walkable) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a ramp you cannot stand on is not a ramp — set walkable',
      });
    }
    if (v.ramp && v.shape.kind !== 'rect') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `a ramp needs a rect: '${v.shape.kind}' has no local axis to run along`,
      });
    }
    if (v.ramp && v.ramp.high < v.ramp.low) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `ramp runs downhill: low ${v.ramp.low} is above high ${v.ramp.high} — turn the shape instead`,
      });
    }
  });
export type Volume = z.infer<typeof VolumeSchema>;

export const CollisionLayerSchema = z.object({
  /**
   * The edge of the map, as a polygon (D-567).
   *
   * ⚠ This is what replaces `width × height`. An area's extent used to be a
   * rectangle enforced by arithmetic, so every area was a rectangle. A cave
   * mouth, a river bank and a road leaving town at an angle are all now
   * expressible, and "outside the map" is authored rather than implied.
   */
  bounds: z.array(Vec2Schema).min(3),
  volumes: z.array(VolumeSchema).default([]),
});
export type CollisionLayer = z.infer<typeof CollisionLayerSchema>;

// ---------------------------------------------------------------- geometry

const RAD = Math.PI / 180;

/** A rect's four corners, in order, with its rotation applied about its centre. */
export function rectCorners(r: Extract<Shape, { kind: 'rect' }>): Vec2[] {
  const c = Math.cos(r.rotation * RAD);
  const s = Math.sin(r.rotation * RAD);
  const hw = r.w / 2;
  const hh = r.h / 2;
  return [
    { x: -hw, y: -hh },
    { x: hw, y: -hh },
    { x: hw, y: hh },
    { x: -hw, y: hh },
  ].map((p) => ({ x: r.x + p.x * c - p.y * s, y: r.y + p.x * s + p.y * c }));
}

/** A point in the rect's own frame, so a rotated rect is tested as an upright one. */
export function toLocal(r: Extract<Shape, { kind: 'rect' }>, p: Vec2): Vec2 {
  const c = Math.cos(-r.rotation * RAD);
  const s = Math.sin(-r.rotation * RAD);
  const dx = p.x - r.x;
  const dy = p.y - r.y;
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}

export function polygonContains(points: readonly Vec2[], p: Vec2): boolean {
  // Crossing number. The half-open comparison on y is what stops a vertex
  // being counted by both of its edges.
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i]!;
    const b = points[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2));
  return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
}

function shapeOutline(shape: Shape): Vec2[] {
  return shape.kind === 'rect' ? rectCorners(shape) : shape.kind === 'poly' ? [...shape.points] : [];
}

export function shapeContains(shape: Shape, p: Vec2): boolean {
  if (shape.kind === 'circle') return Math.hypot(p.x - shape.x, p.y - shape.y) <= shape.r;
  if (shape.kind === 'rect') {
    const l = toLocal(shape, p);
    return Math.abs(l.x) <= shape.w / 2 && Math.abs(l.y) <= shape.h / 2;
  }
  return polygonContains(shape.points, p);
}

/** Distance from a point to a shape; zero inside it. */
export function distanceToShape(shape: Shape, p: Vec2): number {
  if (shape.kind === 'circle') {
    return Math.max(0, Math.hypot(p.x - shape.x, p.y - shape.y) - shape.r);
  }
  if (shapeContains(shape, p)) return 0;
  const pts = shapeOutline(shape);
  let best = Infinity;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    best = Math.min(best, distanceToSegment(p, pts[j]!, pts[i]!));
  }
  return best;
}

function segmentsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const side = (p: Vec2, q: Vec2, r: Vec2): number =>
    Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  return side(a, b, c) !== side(a, b, d) && side(c, d, a) !== side(c, d, b);
}

/** Does the segment a→b touch the shape at all (including starting inside it)? */
export function segmentHitsShape(shape: Shape, a: Vec2, b: Vec2): boolean {
  if (shapeContains(shape, a) || shapeContains(shape, b)) return true;
  if (shape.kind === 'circle') return distanceToSegment({ x: shape.x, y: shape.y }, a, b) <= shape.r;
  const pts = shapeOutline(shape);
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    if (segmentsCross(a, b, pts[j]!, pts[i]!)) return true;
  }
  return false;
}

// ------------------------------------------------------------------ height

/**
 * The height of a volume's top surface under `p`.
 *
 * Flat for anything without a ramp; interpolated along the shape's own local
 * axis for anything with one, so a stair turned any angle still climbs its own
 * length. Clamped at the ends, so standing at the very edge is defined.
 */
export function surfaceHeight(v: Volume, p: Vec2): number {
  if (!v.ramp || v.shape.kind !== 'rect') return v.top;
  const l = toLocal(v.shape, p);
  const span = v.ramp.along === 'x' ? v.shape.w : v.shape.h;
  const along = v.ramp.along === 'x' ? l.x : l.y;
  const t = Math.max(0, Math.min(1, (along + span / 2) / span));
  return v.ramp.low + (v.ramp.high - v.ramp.low) * t;
}

/**
 * Every surface a character could be standing on at `p`, highest first.
 *
 * The datum is always a candidate: the ground exists everywhere inside the
 * bounds. A pit is authored as a volume that cannot be entered, not as an
 * absence of floor — one fewer special case, and a hole in the floor and a
 * wall then fail for the same reason.
 */
export function surfacesAt(layer: CollisionLayer, p: Vec2): number[] {
  const out = [0];
  for (const v of layer.volumes) {
    if (!v.walkable) continue;
    if (!shapeContains(v.shape, p)) continue;
    out.push(surfaceHeight(v, p));
  }
  return out.sort((a, b) => b - a);
}

/**
 * Where a character standing at height `fromZ` would find their feet at `p`.
 *
 * The highest surface they could step ONTO — never one above `STEP_UP`, which
 * is what stops somebody walking up the side of a platform. `null` when the
 * only surface available is a fall further than `MAX_DROP`: that is a cliff
 * edge, and refusing at the edge is what makes it a boundary.
 */
export function standingHeight(layer: CollisionLayer, p: Vec2, fromZ: number): number | null {
  const reachable = surfacesAt(layer, p).find((s) => s <= fromZ + STEP_UP);
  if (reachable === undefined) return null;
  return reachable < fromZ - MAX_DROP ? null : reachable;
}

/**
 * Does this volume's body overlap a character whose feet are at `feetZ`?
 *
 * ⚠ Compared against the SURFACE at p, not `top`: on a ramp those differ by the
 * whole climb, and using `top` makes a staircase a wall from its second tread
 * upwards.
 *
 * ⚠ And it must clear the feet by more than a STEP, not by any amount at all.
 * The strict version was unwalkable in a way that looked like geometry working:
 * a body has width, so approaching a platform up a ramp, the platform's side is
 * within arm's reach while the feet are still a few centimetres below its
 * top — and a strict test blocks the last 30cm of every ramp, every kerb and
 * every doorstep in the world. You cannot stand next to a kerb otherwise.
 */
export function overlapsBody(v: Volume, p: Vec2, feetZ: number): boolean {
  return v.base < feetZ + BODY_HEIGHT && surfaceHeight(v, p) > feetZ + STEP_UP;
}

/**
 * May a body of `BODY_RADIUS` stand at `p` with its feet at `feetZ`?
 *
 * ⚠ The radius is why a doorway works. A body is a circle, so a 0.9m gap
 * between two door jambs admits a 0.6m-wide character and refuses nothing
 * else — which is the thing a one-metre grid could not express at all.
 */
export function canOccupy(
  layer: CollisionLayer,
  p: Vec2,
  feetZ: number,
  radius = BODY_RADIUS,
): boolean {
  if (!polygonContains(layer.bounds, p)) return false;
  for (const v of layer.volumes) {
    if (distanceToShape(v.shape, p) >= radius) continue;
    if (overlapsBody(v, p, feetZ)) return false;
  }
  return true;
}

export interface Step {
  readonly pos: Vec2;
  readonly z: number;
}

/**
 * Move a body from one point to another, or refuse.
 *
 * Returns where it ends up — which carries a height the caller did not ask
 * for, because the feet settle onto whatever surface is there. `null` means
 * the move is refused: out of bounds, into something, or off an edge too high
 * to drop.
 *
 * ⚠ Height is resolved BEFORE the body is tested, and the order is the whole
 * trick. Test the body first and a kerb blocks you, because at the moment of
 * the test your feet are still on the ground below it.
 */
export function stepTo(
  layer: CollisionLayer,
  from: Step,
  to: Vec2,
  radius = BODY_RADIUS,
): Step | null {
  const z = standingHeight(layer, to, from.z);
  if (z === null) return null;
  if (!canOccupy(layer, to, z, radius)) return null;
  return { pos: to, z };
}

/**
 * Whether anything opaque stands between two points (D-217).
 *
 * ⚠ Tested at EYE height rather than as a solid: you see over a wall that
 * comes to your chest and under an arch you walk beneath, and a witness who
 * could not see over a fence is a crime that never registered.
 */
export function sightBlocked(
  layer: CollisionLayer,
  a: Vec2,
  b: Vec2,
  eyeZ = EYE_HEIGHT,
): boolean {
  for (const v of layer.volumes) {
    if (!v.opaque) continue;
    if (v.base > eyeZ || (v.sightTop ?? v.top) < eyeZ) continue;
    if (segmentHitsShape(v.shape, a, b)) return true;
  }
  return false;
}

/** Straight-line distance in metres. Everything that used `chebyshev` wants this. */
export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// --------------------------------------------------------------- transforms

/**
 * Where a placed thing sits: a point in the area, a height, a free turn and a
 * uniform scale.
 *
 * ⚠ `rotation` is ANY angle. The tile system allowed quarter turns because a
 * 37° house could not be tiled; nothing here has that problem, and a road
 * leaving town at an angle is the ordinary case rather than the awkward one.
 */
export interface Transform {
  readonly x: number;
  readonly y: number;
  /** Metres above the datum. A lantern on a shelf, a bridge over a stream. */
  readonly z: number;
  /** Degrees, clockwise in the screen frame. */
  readonly rotation: number;
  readonly scale: number;
}

export const TransformSchema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number().default(0),
  rotation: z.number().default(0),
  scale: z.number().positive().default(1),
});

function turn(p: Vec2, deg: number, scale: number): Vec2 {
  const c = Math.cos(deg * RAD);
  const s = Math.sin(deg * RAD);
  return { x: (p.x * c - p.y * s) * scale, y: (p.x * s + p.y * c) * scale };
}

/**
 * A volume authored in an asset's OWN frame, placed into the area.
 *
 * ⚠ This is what makes a mask worth authoring once. The 684 dungeon-pack
 * assets each carry their volumes in local metres about their own origin; a
 * placement supplies only where it stands and how it is turned. Authoring
 * masks in area coordinates instead would make every placement its own
 * authoring job, which is what "per-asset, overridable per placement" exists
 * to avoid.
 */
export function transformVolume(v: Volume, at: Transform): Volume {
  const shape: Shape =
    v.shape.kind === 'circle'
      ? {
          ...v.shape,
          ...offset(turn({ x: v.shape.x, y: v.shape.y }, at.rotation, at.scale), at),
          r: v.shape.r * at.scale,
        }
      : v.shape.kind === 'rect'
        ? {
            ...v.shape,
            ...offset(turn({ x: v.shape.x, y: v.shape.y }, at.rotation, at.scale), at),
            w: v.shape.w * at.scale,
            h: v.shape.h * at.scale,
            rotation: v.shape.rotation + at.rotation,
          }
        : {
            kind: 'poly',
            points: v.shape.points.map((p) => offset(turn(p, at.rotation, at.scale), at)),
          };
  return {
    ...v,
    shape,
    base: at.z + v.base * at.scale,
    top: at.z + v.top * at.scale,
    sightTop: v.sightTop === undefined ? undefined : at.z + v.sightTop * at.scale,
    ramp: v.ramp && {
      ...v.ramp,
      low: at.z + v.ramp.low * at.scale,
      high: at.z + v.ramp.high * at.scale,
    },
  };
}

function offset(p: Vec2, at: Transform): Vec2 {
  return { x: at.x + p.x, y: at.y + p.y };
}

/** Does any of these volumes' footprints cover this point? Hit-testing, in the editor. */
export function volumesCover(volumes: readonly Volume[], p: Vec2): boolean {
  return volumes.some((v) => shapeContains(v.shape, p));
}

/** The axis-aligned extent of some volumes on the ground, for framing and culling. */
export function volumesBounds(volumes: readonly Volume[]): { min: Vec2; max: Vec2 } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const v of volumes) {
    const pts =
      v.shape.kind === 'circle'
        ? [
            { x: v.shape.x - v.shape.r, y: v.shape.y - v.shape.r },
            { x: v.shape.x + v.shape.r, y: v.shape.y + v.shape.r },
          ]
        : v.shape.kind === 'rect'
          ? rectCorners(v.shape)
          : v.shape.points;
    for (const p of pts) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }
  return minX === Infinity ? null : { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
}
