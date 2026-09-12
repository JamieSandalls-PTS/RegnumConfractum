import {
  EYE_HEIGHT,
  areaCollision,
  segmentHitsShape,
  shapeContains,
  surfaceHeight,
  type AreaDef,
  type Vec2,
} from '@rc/shared';

/**
 * Line of sight, in metres (D-217, D-223, D-567).
 *
 * ⚠ This was Bresenham over the tile grid, and it did not merely become
 * inaccurate when positions went continuous — it HUNG. The loop ran
 * `while (x !== to.x || y !== to.y)` stepping by whole numbers, so from 45.05
 * towards 39 it stepped 44.05, 43.05, 42.05 and never once hit the target. No
 * exception, no wrong answer: a server thread pinned at 100% and every test
 * that reached it reported a timeout somewhere else entirely. Worth recording
 * because the same shape — an integer loop condition fed float coordinates —
 * exists anywhere else that survived the tile era.
 *
 * The replacement is a segment against the area's opaque volumes at EYE
 * height, which is what makes a witness (D-217): you see over a wall that
 * comes to your chest and under an arch you walk beneath.
 */

/**
 * ⚠ One rule carried over deliberately: an opaque volume containing either
 * END of the line is ignored. You can always see out of where you are
 * standing, and a body inside a thicket that sees nothing at all — including
 * the person stabbing it — is worse than the alternative in every direction.
 */
export function hasLineOfSight(area: AreaDef, from: Vec2, to: Vec2, eyeZ = EYE_HEIGHT): boolean {
  const layer = areaCollision(area);
  for (const v of layer.volumes) {
    if (!v.opaque) continue;
    if (v.base > eyeZ || (v.sightTop ?? v.top) < eyeZ) continue;
    if (shapeContains(v.shape, from) || shapeContains(v.shape, to)) continue;
    if (segmentHitsShape(v.shape, from, to)) return false;
  }
  return true;
}

/**
 * How high the ground is under a point — for placing an eye on a gallery or a
 * stair rather than assuming everyone stands on the datum.
 *
 * Not yet wired into `hasLineOfSight`: doing it properly means the eye and the
 * target each sit at their own height and the test becomes a 3D segment, and
 * nothing in the world is stacked yet. Said here rather than left as a silent
 * assumption that the world is flat.
 */
export function groundHeight(area: AreaDef, p: Vec2): number {
  let floor = 0;
  for (const v of areaCollision(area).volumes) {
    if (!v.walkable) continue;
    if (!shapeContains(v.shape, p)) continue;
    floor = Math.max(floor, surfaceHeight(v, p));
  }
  return floor;
}
