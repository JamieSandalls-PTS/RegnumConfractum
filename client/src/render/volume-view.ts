import * as THREE from 'three';
import {
  BODY_HEIGHT,
  EYE_HEIGHT,
  STEP_UP,
  rectCorners,
  surfaceHeight,
  type Volume,
} from '@rc/shared';

/**
 * Collision volumes, drawn so a person can see what they authored (D-567).
 *
 * ⚠ The reason this exists at all: a collision mask is the one part of a map
 * that is completely invisible in play and completely decisive. Every previous
 * generation of this problem in the repo has been found by MEASURING rather
 * than looking — but a mask is authored by hand, and nobody can hand-author a
 * shape they cannot see. So the editor draws it, in colours that say what it
 * DOES rather than what it is made of:
 *
 *   red      stops a body
 *   green    your feet end up on it — a kerb, a step, a threshold
 *   amber    a ramp: a surface that climbs
 *   blue     stops only sight (D-217): a thicket, a hanging
 *   grey     you pass under it: an arch, a bridge deck, a beam
 *
 * ⚠ Drawn as wireframe boxes over translucent faces. A solid overlay hides the
 * mesh it describes, and the whole job is judging one against the other.
 */

export const VOLUME_COLOURS = {
  /** Stops a body walking at ground level. */
  block: 0xd05a4a,
  /** A surface you end up standing on — a kerb, a step, a low wall top. */
  stand: 0x5aa85f,
  /** A surface that climbs. */
  ramp: 0xd39b3c,
  /** Stops an eye at eye height and not a body — a thicket, a hanging. */
  sight: 0x4a7fd0,
  /** Neither: you pass under it. An arch, a bridge deck, a beam. */
  under: 0x6f7d8c,
} as const;

/**
 * What a volume DOES, as a colour.
 *
 * ⚠ Derived from the same rules the simulation runs, never from what the
 * volume is called or how tall it happens to be. The first version of this
 * keyed off `walkable` and a height threshold and got a thicket wrong — which
 * is the precise failure a legend must not have, because a legend that
 * disagrees with the model is worse than no legend: it is a person authoring
 * confidently against the wrong picture. `volume-legend.test.ts` asserts each
 * colour against `stepTo` and `sightBlocked`.
 */
export function volumeColour(v: Volume): number {
  if (v.ramp) return VOLUME_COLOURS.ramp;
  // A body on the ground occupies [0, BODY_HEIGHT]. It is stopped when this
  // overlaps that and the top is not something it can simply step onto.
  //
  // ⚠ One threshold, `STEP_UP`, whatever `walkable` says. A 10cm lip you may
  // not stand on is still something you walk over — `walkable` decides whether
  // your FEET RISE to it, not whether it stops you. An earlier version made the
  // threshold depend on `walkable` and painted low obstacles red.
  if (v.base < BODY_HEIGHT && v.top > STEP_UP) return VOLUME_COLOURS.block;
  if (v.opaque && v.base <= EYE_HEIGHT && (v.sightTop ?? v.top) >= EYE_HEIGHT) {
    return VOLUME_COLOURS.sight;
  }
  // ⚠ Green means "your feet end up here", which is only true within one step
  // of the ground. A 4m arch and a 3m gantry are `walkable: true` and standing
  // on either requires getting up there first — the ramp that does that is
  // amber, and painting the destination green from below was the second thing
  // the sweep caught.
  if (v.walkable && v.top > 0 && v.top <= STEP_UP) return VOLUME_COLOURS.stand;
  return VOLUME_COLOURS.under;
}

/** A flat-topped prism through the volume's footprint, from base to surface. */
function geometryFor(v: Volume): THREE.BufferGeometry {
  const height = Math.max(0.02, (v.ramp ? Math.max(v.ramp.low, v.ramp.high) : v.top) - v.base);
  if (v.shape.kind === 'circle') {
    const g = new THREE.CylinderGeometry(v.shape.r, v.shape.r, height, 20);
    g.translate(v.shape.x, v.base + height / 2, v.shape.y);
    return g;
  }
  const pts =
    v.shape.kind === 'rect'
      ? rectCorners(v.shape)
      : v.shape.points.map((p) => ({ x: p.x, y: p.y }));
  // ⚠ Built in the XY plane and laid down, rather than extruded along +z and
  // hoped for. `ExtrudeGeometry` runs up +z; the world's up is +y.
  const shape = new THREE.Shape(pts.map((p) => new THREE.Vector2(p.x, p.y)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
  g.rotateX(Math.PI / 2);
  g.translate(0, v.base + height, 0);
  return g;
}

export class VolumeView {
  private readonly group = new THREE.Group();

  constructor(
    private readonly scene: THREE.Scene,
    volumes: readonly Volume[],
  ) {
    for (const v of volumes) {
      const colour = volumeColour(v);
      const geo = geometryFor(v);
      const face = new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({
          color: colour,
          transparent: true,
          opacity: 0.18,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      const wire = new THREE.LineSegments(
        new THREE.EdgesGeometry(geo),
        // ⚠ `depthTest: false` so the cage shows THROUGH the mesh it wraps.
        // A mask hidden inside the wall it describes is exactly the one you
        // cannot check.
        new THREE.LineBasicMaterial({ color: colour, depthTest: false, transparent: true }),
      );
      wire.renderOrder = 999;
      this.group.add(face, wire);

      if (v.ramp && v.shape.kind === 'rect') this.group.add(this.rampArrow(v));
    }
    scene.add(this.group);
  }

  /**
   * Which way a ramp climbs.
   *
   * ⚠ Worth its own geometry: `low` and `high` plus an axis plus the shape's
   * own rotation is four facts, and a stair authored uphill-backwards renders
   * identically to one authored the right way round. The arrow is the only
   * thing that shows it before somebody tries to walk up it.
   */
  private rampArrow(v: Volume): THREE.Line {
    const rect = v.shape as Extract<Volume['shape'], { kind: 'rect' }>;
    const span = v.ramp!.along === 'x' ? rect.w : rect.h;
    const at = (t: number): THREE.Vector3 => {
      const local = { x: 0, y: 0 };
      if (v.ramp!.along === 'x') local.x = (t - 0.5) * span;
      else local.y = (t - 0.5) * span;
      const c = Math.cos((rect.rotation * Math.PI) / 180);
      const s = Math.sin((rect.rotation * Math.PI) / 180);
      const p = { x: rect.x + local.x * c - local.y * s, y: rect.y + local.x * s + local.y * c };
      return new THREE.Vector3(p.x, surfaceHeight(v, p) + 0.05, p.y);
    };
    const geo = new THREE.BufferGeometry().setFromPoints([at(0.05), at(0.95)]);
    return new THREE.Line(
      geo,
      new THREE.LineBasicMaterial({ color: 0xffe08a, depthTest: false, transparent: true }),
    );
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.geometry) return;
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    });
    this.group.clear();
  }
}
