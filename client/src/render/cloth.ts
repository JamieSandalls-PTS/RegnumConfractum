import * as THREE from 'three';

/**
 * Verlet cloth and hair (D-403): position-based chains with distance
 * constraints and a torso collider. ~100 lines each, no physics engine.
 * Wind arrives as a parameter — under D-305 it will be a world variable, so
 * capes react to weather for free.
 */

/**
 * Closest point to `p` on a bone-axis segment (collider centre ± axis ·
 * halfLen), written into `out`. Colliders were once VERTICAL cylinders that
 * ignored bone rotation — a bowing torso left its collider standing upright
 * and hair fell straight through the inclined chest (stakeholder, bow
 * animation). Oriented capsules follow the bone.
 */
function closestOnBoneSegment(
  p: THREE.Vector3,
  centre: THREE.Vector3,
  axis: THREE.Vector3,
  halfLen: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  let t = (p.x - centre.x) * axis.x + (p.y - centre.y) * axis.y + (p.z - centre.z) * axis.z;
  t = Math.max(-halfLen, Math.min(halfLen, t));
  return out.set(centre.x + axis.x * t, centre.y + axis.y * t, centre.z + axis.z * t);
}

/**
 * Global cloth tuning (stakeholder, 2026-08-18: "a slider to adjust the
 * number of faces/fidelity of all cloth physics clothing — I want to test
 * the effect of making them more floppy").
 *
 * `fidelity` scales the simulated grid of EVERY garment: more segments mean
 * more places to fold, which is what reads as floppier. `solverIterations`
 * is the other half — fewer passes leave the distance constraints slacker,
 * so the same grid hangs looser. Both are read at CONSTRUCTION for the
 * grid and per-step for the solver, so changing fidelity needs a rebuild
 * (the viewer repopulates) while slack takes effect immediately.
 */
export const clothTuning = {
  /** Multiplies each garment's authored column/row counts. */
  fidelity: 1,
  /** Constraint relaxation passes per step. Lower = floppier. */
  solverIterations: 6,
};

/** Applies the fidelity multiplier to an authored grid dimension. */
function scaled(n: number, min: number): number {
  return Math.max(min, Math.round(n * clothTuning.fidelity));
}

export class Cloth {
  /** Simulated grid, after the fidelity multiplier. */
  private cols = 0;
  private rows = 0;
  private pos: THREE.Vector3[] = [];
  private prev: THREE.Vector3[] = [];
  private constraints: { a: number; b: number; len: number }[] = [];
  private geom: THREE.PlaneGeometry;
  readonly mesh: THREE.Mesh;
  /** Pin positions for the pinned rows, row-major, in pin-bone space. */
  private pinLocal: THREE.Vector3[] = [];
  /** How many leading rows carry pins (collar: two — see pinMask). */
  private pinnedRows = 1;
  /** Per-node pin flags for the leading rows. Collar mode pins the whole
   * collar ring but ONLY THE LATERAL (shoulder) sections of the second
   * ring: pinning its back span held the fabric out in a rigid box
   * (stakeholder: "capes are very square... should conform to the body").
   * The unpinned back span falls in and drapes against the torso collider. */
  private pinMask: boolean[] = [];

  constructor(
    cols: number,
    rows: number,
    private width: number,
    private height: number,
    color: number,
    /** 'bar': straight pin row (banners, the old cape). 'collar': the pin
     * row curves around the neck so fabric wraps OVER the shoulder tops and
     * ties at the front — the stakeholder's cape reference (2026-08-17).
     * 'tube': a CLOSED ring of fabric — robe skirts and sleeve cuffs. The
     * top ring is pinned; rest positions form an A-line cone from
     * `collarRadius` (waist) to `shoulderHalfWidth` (hem radius — the
     * parameter is reused); the seam column welds to column 0. */
    private layout: 'bar' | 'collar' | 'tube' = 'bar',
    collarRadius = 0,
    /** Collar mode: x-radius of the pinned SHOULDER ring (defaults to
     * 1.8 × collarRadius). Tube mode: the HEM radius of the A-line cone. */
    shoulderHalfWidth = 0,
    /** Tube mode: how many leading rows are RIGID (pinned to the bone,
     * following it exactly). The robe skirt is a fitted garment from waist
     * to knee and only flows below (stakeholder) — rigid rows cost no
     * physics and never misbehave. */
    rigidRows = 1,
  ) {
    // The authored counts are the DESIGN; fidelity scales them for review.
    // A tube's seam welds column 0 to the last, so it needs at least 6
    // columns to stay a ring rather than a fan.
    this.cols = scaled(cols, layout === 'tube' ? 6 : 3);
    this.rows = scaled(rows, Math.max(2, rigidRows + 1));
    cols = this.cols;
    rows = this.rows;
    this.pinnedRows = layout === 'collar' ? 2 : layout === 'tube' ? Math.max(1, rigidRows) : 1;
    const rowDrop = height / (rows - 1);
    for (let row = 0; row < this.pinnedRows; row++) {
      for (let x = 0; x < cols; x++) {
        const u = x / (cols - 1);
        if (layout === 'tube') {
          // Rigid rows follow the cone: ring radius grows toward the hem.
          // The WAIST rows are elliptical — the body is flattened front-to-
          // back there, and a circular ring left a visible gap between the
          // skirt and the belt (stakeholder). Rounds out by mid-skirt.
          const a = u * Math.PI * 2;
          const r = collarRadius + (shoulderHalfWidth - collarRadius) * (row / (rows - 1));
          const zk = 0.68 + 0.32 * Math.min(1, row / 4);
          this.pinLocal.push(new THREE.Vector3(
            Math.sin(a) * r, -row * rowDrop, Math.cos(a) * r * zk));
          this.pinMask.push(true);
        } else if (layout === 'collar') {
          // The attachment line is a YOKE (top-angle review, stakeholder):
          // across the top of the back, RISING AND WIDENING over the
          // shoulder points so fabric is attached ON the deltoid tops —
          // an edge that stops at the shoulder sides leaves the caps bare
          // when seen from the game's high camera. Ends reach ±115°,
          // slightly forward of the shoulder line.
          const a = (u - 0.5) * Math.PI * (row === 0 ? 1.28 : 1.15);
          const over = Math.pow(Math.abs(Math.sin(a)), 2); // 1 at the shoulder points
          const rx = row === 0
            ? collarRadius * (1 + 0.75 * over)
            : (shoulderHalfWidth || collarRadius * 1.8);
          const rz = row === 0 ? collarRadius * 0.72 : collarRadius * 0.9;
          // The shoulder ring barely drops: it must clear the TOPS of the
          // deltoids, or the pinned fabric slices through the shoulder caps.
          // The yoke's ends dip slightly as they ride over the shoulders.
          const dip = row === 0 ? -over * rowDrop * 0.25 : -row * rowDrop * 0.07;
          this.pinLocal.push(new THREE.Vector3(
            Math.sin(a) * rx, dip, -Math.cos(a) * rz));
          // Row 0 (collar) is fully fastened. Row 1 is NEVER hard-pinned:
          // rigid ring corners tented the fabric into wing spikes whenever
          // a pose moved the shoulders (stakeholder, seated). The ring is a
          // weak soft target only; real shoulder support comes from
          // COLLIDING with the shoulder spheres, like fabric on shoulders.
          this.pinMask.push(row === 0);
        } else {
          this.pinLocal.push(new THREE.Vector3((u - 0.5) * width, 0, -0.02));
          this.pinMask.push(row === 0);
        }
      }
    }
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (layout === 'tube') {
          // A-line cone: waist radius at the top, hem radius at the bottom.
          // Elliptical at the waist, round by mid-skirt (see pinLocal).
          const a = (x / (cols - 1)) * Math.PI * 2;
          const r = collarRadius + (shoulderHalfWidth - collarRadius) * (y / (rows - 1));
          const zk = 0.68 + 0.32 * Math.min(1, y / 4);
          const v = new THREE.Vector3(
            Math.sin(a) * r, (-y / (rows - 1)) * height, Math.cos(a) * r * zk);
          this.pos.push(v);
          this.prev.push(v.clone());
          continue;
        }
        // Rest positions use the FLAT cut of the fabric: when the cloth is
        // wider than the collar arc it gathers at the pins and billows out
        // over the shoulders — exactly how the reference cape drapes.
        const v = new THREE.Vector3(
          (x / (cols - 1) - 0.5) * width,
          (-y / (rows - 1)) * height,
          layout === 'collar' ? -collarRadius : 0,
        );
        this.pos.push(v);
        this.prev.push(v.clone());
      }
    }
    const idx = (x: number, y: number) => y * cols + x;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (x < cols - 1) this.addConstraint(idx(x, y), idx(x + 1, y));
        if (y < rows - 1) this.addConstraint(idx(x, y), idx(x, y + 1));
        if (x < cols - 1 && y < rows - 1) this.addConstraint(idx(x, y), idx(x + 1, y + 1));
        // Bend resistance across the upper rows (skip-one constraints):
        // gathered surplus at a collar folds in wide, ordered waves instead
        // of crumpling (stakeholder round: the conforming cape buckled).
        if (this.layout === 'collar' && y < 5 && x < cols - 2) {
          this.addConstraint(idx(x, y), idx(x + 2, y));
        }
      }
    }
    this.geom = new THREE.PlaneGeometry(width, height, cols - 1, rows - 1);
    this.mesh = new THREE.Mesh(
      this.geom,
      new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide }),
    );
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false; // vertices move in world space
  }

  private addConstraint(a: number, b: number): void {
    this.constraints.push({ a, b, len: this.pos[a]!.distanceTo(this.pos[b]!) });
  }

  step(
    dt: number,
    wind: number,
    t: number,
    pinMatrix: THREE.Matrix4,
    /** The BODY volumes the cloth must not pass through — torso AND pelvis
     * (round 7: one waist-up cylinder let the cape clip the buttocks).
     * `height` present = capsule along the bone axis (or the axis in matrix
     * column `axisCol`); absent = SPHERE (shoulder caps, so the collar cape
     * rests ON the deltoids instead of cutting through). `off` shifts the
     * capsule centre along its axis — limb capsules hang BELOW their joint. */
    colliders?: { matrix: THREE.Matrix4; radius: number; height?: number; axisCol?: number; off?: number }[],
    /** Half-space constraint: cloth stays BEHIND the wearer's coronal plane
     * (local z ≤ maxZ). Cylinders alone let the cape orbit to the front.
     * Nodes above `exemptAboveY` (local) skip it — collar-wrapped fabric
     * legitimately sits on and in front of the shoulder line. */
    backPlane?: { matrix: THREE.Matrix4; maxZ: number; exemptAboveY?: number },
  ): void {
    const cols = this.cols;
    const gravity = new THREE.Vector3(0, -9.0, 0);
    // Gusts oscillate around ~zero: a PERMANENT side bias made capes climb
    // around the body collider and hang off the front (review round 6).
    const w = new THREE.Vector3(
      Math.sin(t * 1.7) * 0.6 + 0.12,
      Math.sin(t * 2.3) * 0.2,
      Math.cos(t * 1.1) * 0.6 + 0.08,
    ).multiplyScalar(wind * 5.0);

    const pinCount = this.pinnedRows * cols;
    const isPinned = (i: number): boolean => i < pinCount && this.pinMask[i]!;
    // Cloth clings (stakeholder: capes must conform to the body, not box
    // over it): free nodes feel a gentle pull toward the wearer's axis;
    // the body colliders stop them at the surface.
    // No hug for tubes: a closed ring holds its own shape, and pulling it
    // toward the axis collapsed the skirt into the legs (robe sheet r1).
    const hugCentre = this.layout === 'collar' && colliders?.[0]
      ? new THREE.Vector3().setFromMatrixPosition(colliders[0].matrix)
      : null;
    // The hug only makes sense on an UPRIGHT torso. When the chest pitches
    // (bowing), pulling fabric toward the chest axis drags it onto the
    // near-horizontal back where it bunches at the collar (stakeholder) —
    // fade it with tilt so the fabric slides off the sides instead.
    const uprightK = colliders?.[0]
      ? Math.max(0, new THREE.Vector3().setFromMatrixColumn(colliders[0].matrix, 1).normalize().y) ** 2
      : 1;
    const HUG = 3.2 * uprightK;
    // Tubes are HEAVY garments: extra velocity damping and much less wind,
    // or the skirt flaps like a flag and momentum flips it in a bow.
    const damp = this.layout === 'tube' ? 0.88 : 0.97;
    const windK = this.layout === 'tube' ? 0.3 : 1;
    const FLOOR = 0.012;
    const acc = new THREE.Vector3();
    for (let i = 0; i < this.pos.length; i++) {
      if (isPinned(i)) continue;
      const p = this.pos[i]!;
      const pr = this.prev[i]!;
      acc.copy(gravity).addScaledVector(w, windK);
      if (hugCentre) {
        // The hug fades toward the hem: full-strength it pressed the lower
        // fabric against the legs, which read as wrapping them (8-dir
        // sheet). The top conforms; the skirt of the cape swings free.
        const hemK = Math.floor(i / cols) / (this.rows - 1) > 0.55 ? 0.3 : 1;
        const hx = hugCentre.x - p.x;
        const hz = hugCentre.z - p.z;
        const hl = Math.hypot(hx, hz) || 1e-6;
        acc.x += (hx / hl) * HUG * hemK;
        acc.z += (hz / hl) * HUG * hemK;
      }
      // Floor-contact nodes get heavy friction: pooled fabric RESTS.
      const onFloor = p.y < FLOOR + 0.005;
      const fk = onFloor ? 0.4 : 1;
      const vx = (p.x - pr.x) * damp * fk;
      const vy = (p.y - pr.y) * damp;
      const vz = (p.z - pr.z) * damp * fk;
      pr.copy(p);
      p.x += vx + acc.x * dt * dt;
      p.y += vy + acc.y * dt * dt;
      p.z += vz + acc.z * dt * dt;
      // The GROUND exists: without it, seated and bowing garments folded
      // through the floor into themselves (stakeholder, seated robe).
      if (p.y < FLOOR) p.y = FLOOR;
    }

    // pin the masked nodes of the leading rows to the anchor, per layout
    for (let i = 0; i < pinCount; i++) {
      const local = new THREE.Vector3().copy(this.pinLocal[i]!);
      local.applyMatrix4(pinMatrix);
      if (this.pinMask[i]) {
        this.pos[i]!.copy(local);
        this.prev[i]!.copy(local);
      } else {
        // Unpinned ring nodes are SOFT-pinned: eased toward their ring
        // target so the top edge stays tidy while still settling inward
        // (hard-freeing them crumpled the fabric around the collar).
        // Strong enough to re-centre a cape shaken sideways by an emote,
        // weak enough never to hold a rigid point against the drape.
        this.pos[i]!.lerp(local, 0.3);
      }
    }

    const d = new THREE.Vector3();
    const torso = new THREE.Vector3();
    for (let iter = 0; iter < clothTuning.solverIterations; iter++) {
      for (const c of this.constraints) {
        const pa = this.pos[c.a]!;
        const pb = this.pos[c.b]!;
        d.subVectors(pb, pa);
        const dist = d.length() || 1e-6;
        d.multiplyScalar(((dist - c.len) / dist) * 0.5);
        if (!isPinned(c.a)) pa.add(d);
        if (!isPinned(c.b)) pb.sub(d);
      }
      if (backPlane) {
        const inv = new THREE.Matrix4().copy(backPlane.matrix).invert();
        const local = new THREE.Vector3();
        const exempt = backPlane.exemptAboveY ?? Infinity;
        for (let i = 0; i < this.pos.length; i++) {
          if (isPinned(i)) continue;
          local.copy(this.pos[i]!).applyMatrix4(inv);
          if (local.z > backPlane.maxZ && local.y < exempt) {
            local.z = backPlane.maxZ;
            this.pos[i]!.copy(local).applyMatrix4(backPlane.matrix);
          }
        }
      }
      for (const collider of colliders ?? []) {
        torso.setFromMatrixPosition(collider.matrix);
        const axis = new THREE.Vector3().setFromMatrixColumn(collider.matrix, collider.axisCol ?? 1).normalize();
        if (collider.off) torso.addScaledVector(axis, collider.off);
        const near = new THREE.Vector3();
        for (let i = 0; i < this.pos.length; i++) {
          if (isPinned(i)) continue;
          const p = this.pos[i]!;
          if (collider.height === undefined) {
            // Sphere: radial push-out in 3D.
            d.subVectors(p, torso);
            const len = d.length();
            if (len < collider.radius) {
              p.copy(torso).addScaledVector(d, collider.radius / (len || 1e-6));
            }
            continue;
          }
          // Oriented capsule along the bone's axis (bows, sitting, kneeling
          // incline the torso — a vertical cylinder stops covering it).
          closestOnBoneSegment(p, torso, axis, collider.height, near);
          d.subVectors(p, near);
          const len = d.length();
          if (len < collider.radius) {
            p.copy(near).addScaledVector(d, collider.radius / (len || 1e-6));
          }
        }
      }
    }

    // Enforce the floor against constraint pulls as well.
    for (let i = pinCount; i < this.pos.length; i++) {
      if (this.pos[i]!.y < FLOOR) this.pos[i]!.y = FLOOR;
    }

    // Tube: weld the seam — the last column IS the first column, so the
    // ring closes and the mesh's seam faces stay stitched.
    if (this.layout === 'tube') {
      for (let y = 0; y < this.rows; y++) {
        const i0 = y * cols;
        const i1 = y * cols + cols - 1;
        this.pos[i1]!.copy(this.pos[i0]!);
        this.prev[i1]!.copy(this.prev[i0]!);
      }
    }

    const arr = this.geom.attributes.position!.array as Float32Array;
    for (let i = 0; i < this.pos.length; i++) {
      arr[i * 3] = this.pos[i]!.x;
      arr[i * 3 + 1] = this.pos[i]!.y;
      arr[i * 3 + 2] = this.pos[i]!.z;
    }
    this.geom.attributes.position!.needsUpdate = true;
    this.geom.computeVertexNormals();
  }

  dispose(): void {
    this.geom.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

/** One physics lock: a verlet chain rendered as solid tapered segments. */
interface Lock {
  pos: THREE.Vector3[];
  prev: THREE.Vector3[];
  /** Anchor offset in head-bone space. */
  off: THREE.Vector3;
  meshes: THREE.Mesh[];
  segLen: number;
  /** Which side of the shoulders this lock falls to: +1 front, -1 behind.
   * Real hair sheds off the shoulder ridge into one basin and stays; without
   * a committed side, locks balance on the collider's top edge and dance
   * there (stakeholder report, 2026-08-17). */
  bias: number;
  /** 1 where the node touched a collider last step — rests get damped. */
  contact: number[];
  /** Half-thickness of the rendered strand: collision pushes the chain this
   * much clear of a surface, so strands DRAPE OVER body parts instead of
   * running half-buried through them (stakeholder round 2). */
  halfW: number;
}

import type { HairStyle } from '@rc/shared';

/**
 * Solid hair (v2, stakeholder pass 2026-08-17): a shaped rigid mass fitted to
 * the cranium — hair reads as a SHAPE, not spaghetti — plus a few chunky
 * physics locks (verlet chains rendered as tapered solid segments) that
 * wobble and flow. Style comes from the appearance seed:
 *   crop — the cap alone        bob  — cap + jaw-length shell
 *   tail — cap + one back lock  long — cap + shell + three locks
 */
export class SolidHair {
  /** Rigid meshes, parented to the head bone by the constructor. */
  private capGroup = new THREE.Group();
  /** World-space physics meshes — the caller adds this to the scene. */
  readonly looseGroup = new THREE.Group();
  private locks: Lock[] = [];
  private headRadius: number;
  private headCenter: THREE.Vector3;

  constructor(
    style: HairStyle,
    len: number,
    headH: number,
    color: number,
    headBone: THREE.Object3D,
  ) {
    this.headRadius = headH * 0.38;
    this.headCenter = new THREE.Vector3(0, headH * 0.42, 0);
    const mat = () => new THREE.MeshLambertMaterial({ color });

    // The cap: a smooth, back-weighted mass that clearly COVERS the crown —
    // round 4 found the old cap ended level with the cranium top, leaving a
    // bald patch. High segment counts: hair must not read as a polyhedron.
    // A DOME, not a full sphere: the sphere's lower front quadrant wrapped
    // down over the face (round 8: "hair too far down the front").
    const cap = new THREE.Mesh(
      new THREE.SphereGeometry(headH * 0.395, 20, 14, 0, Math.PI * 2, 0, Math.PI * 0.55),
      mat(),
    );
    // Non-crop proportions stakeholder-tuned via the model editor.
    if (style === 'crop') {
      cap.scale.set(1.0, 0.78, 1.03); // close-cut
      cap.position.set(0, headH * 0.55, -headH * 0.04);
    } else {
      cap.scale.set(0.9, 0.75, 0.9); // editor export 2: tighter still
      cap.position.set(0, headH * 0.55, 0);
    }
    cap.castShadow = true;
    cap.name = 'hair cap';
    this.capGroup.add(cap);
    // Fringe: a slim band at the HAIRLINE, high on the forehead — round 7's
    // reference shows the face fully open, hair framing it from above.
    const fringe = new THREE.Mesh(
      // phi centred on π/2 = the +Z face in three.js's sphere convention.
      new THREE.SphereGeometry(headH * 0.375, 16, 10, Math.PI * 0.08, Math.PI * 0.84, Math.PI * 0.2, Math.PI * 0.1),
      mat(),
    );
    // Stakeholder-tuned: lower and forward, framing the brow; a touch wider.
    fringe.position.set(0, headH * 0.26, headH * 0.09);
    fringe.scale.x = 1.14;
    fringe.castShadow = true;
    fringe.name = 'hair fringe';
    this.capGroup.add(fringe);

    if (style === 'bob' || style === 'long') {
      // Back mass: a squashed sphere so the nape ROUNDS off (a box left a
      // squared step at the neck — cycle B). The old box cheek panels are
      // gone (stakeholder: "the side hair parts are just cubes") — the sides
      // are now physics locks, defined below with the rest.
      const back = new THREE.Mesh(new THREE.SphereGeometry(headH * 0.36, 16, 12), mat());
      back.scale.set(0.85, 0.95, 0.5);
      back.position.set(0, headH * 0.3, -headH * 0.26);
      back.castShadow = true;
      back.name = 'hair back';
      this.capGroup.add(back);
    }
    if (style === 'tail') {
      // The gather at the back of the head the tail hangs from.
      const tie = new THREE.Mesh(new THREE.SphereGeometry(headH * 0.14, 8, 6), mat());
      tie.position.set(0, headH * 0.58, -headH * 0.36);
      tie.name = 'hair tie';
      this.capGroup.add(tie);
    }
    headBone.add(this.capGroup);

    // Physics locks: verlet chains rendered as OVERLAPPING tapered capsules,
    // so a lock reads as one continuous piece of hair, not stacked crates.
    const lockDefs: { off: THREE.Vector3; len: number; width: number; bias: number }[] = [];
    if (style === 'tail') {
      // A gathered tail of three OVERLAPPING strands falling BEHIND the
      // shoulders: thin separated strands read as rope (stakeholder), so
      // widths overlap the neighbours into one moving mass.
      lockDefs.push(
        { off: new THREE.Vector3(0, headH * 0.58, -headH * 0.4), len: len * 1.3 + headH * 0.4, width: headH * 0.24, bias: -1 },
        { off: new THREE.Vector3(headH * 0.07, headH * 0.54, -headH * 0.38), len: len * 1.15 + headH * 0.35, width: headH * 0.16, bias: -1 },
        { off: new THREE.Vector3(-headH * 0.07, headH * 0.54, -headH * 0.38), len: len * 1.15 + headH * 0.35, width: headH * 0.16, bias: -1 },
      );
    } else if (style === 'long') {
      // A full head: a fan of back locks behind the shoulders, side-back
      // locks past the ears, temple locks framing the face in front. The
      // anchors cluster and the widths OVERLAP so the fan reads as a mass
      // of hair with strand definition, not parallel noodles.
      lockDefs.push(
        { off: new THREE.Vector3(0, headH * 0.46, -headH * 0.36), len: len * 1.5 + headH * 0.5, width: headH * 0.3, bias: -1 },
        { off: new THREE.Vector3(headH * 0.14, headH * 0.44, -headH * 0.32), len: len * 1.4 + headH * 0.45, width: headH * 0.24, bias: -1 },
        { off: new THREE.Vector3(-headH * 0.14, headH * 0.44, -headH * 0.32), len: len * 1.4 + headH * 0.45, width: headH * 0.24, bias: -1 },
        { off: new THREE.Vector3(headH * 0.26, headH * 0.42, -headH * 0.2), len: len * 1.3 + headH * 0.4, width: headH * 0.2, bias: -0.6 },
        { off: new THREE.Vector3(-headH * 0.26, headH * 0.42, -headH * 0.2), len: len * 1.3 + headH * 0.4, width: headH * 0.2, bias: -0.6 },
        { off: new THREE.Vector3(headH * 0.31, headH * 0.4, -headH * 0.06), len: len * 1.15 + headH * 0.32, width: headH * 0.18, bias: 0.7 },
        { off: new THREE.Vector3(-headH * 0.31, headH * 0.4, -headH * 0.06), len: len * 1.15 + headH * 0.32, width: headH * 0.18, bias: 0.7 },
      );
    }
    if (style === 'bob') {
      // The bob: cheek locks framing the face, ear locks behind them —
      // four chunky overlapping strands, shedding FRONT of the shoulders.
      for (const s of [1, -1]) {
        lockDefs.push(
          { off: new THREE.Vector3(s * headH * 0.32, headH * 0.44, -headH * 0.02), len: headH * 0.6, width: headH * 0.22, bias: 0.85 },
          { off: new THREE.Vector3(s * headH * 0.33, headH * 0.42, -headH * 0.18), len: headH * 0.68, width: headH * 0.2, bias: 0.4 },
        );
      }
    }
    const SEG = 4;
    for (const def of lockDefs) {
      const pos: THREE.Vector3[] = [];
      const prev: THREE.Vector3[] = [];
      for (let i = 0; i <= SEG; i++) {
        const v = new THREE.Vector3(def.off.x, def.off.y - i * (def.len / SEG), def.off.z);
        pos.push(v);
        prev.push(v.clone());
      }
      const meshes: THREE.Mesh[] = [];
      for (let i = 0; i < SEG; i++) {
        const w = def.width * (1 - i * 0.16);
        const seg = new THREE.Mesh(
          new THREE.CapsuleGeometry(w * 0.5, def.len / SEG, 3, 7),
          mat(),
        );
        seg.castShadow = true;
        seg.frustumCulled = false;
        meshes.push(seg);
        this.looseGroup.add(seg);
      }
      this.locks.push({
        pos, prev, off: def.off, meshes, segLen: def.len / SEG,
        bias: def.bias, contact: new Array<number>(pos.length).fill(0),
        halfW: def.width * 0.5,
      });
    }
  }

  setVisible(v: boolean): void {
    this.capGroup.visible = v;
    this.looseGroup.visible = v;
  }

  /** Hide only the physics strands (a worn-up hood covers them; the rigid
   * cap/fringe still peeks at the brow, as in the hood reference photo). */
  setLooseVisible(v: boolean): void {
    this.looseGroup.visible = v;
  }

  step(
    dt: number,
    wind: number,
    t: number,
    headMatrix: THREE.Matrix4,
    /** Body volumes the locks must not pass through — the ponytail clipped
     * straight through the torso without these (stakeholder report). Same
     * convention as the cape: `height` present = capsule along the bone
     * axis (or matrix column `axisCol`), absent = sphere (shoulder caps).
     * Pushes are padded by the strand's own half-thickness so hair drapes
     * ON surfaces, not half-inside them. `off` shifts a capsule's centre
     * along its axis (limb capsules hang below their joint). */
    colliders?: { matrix: THREE.Matrix4; radius: number; height?: number; axisCol?: number; off?: number }[],
  ): void {
    if (this.locks.length === 0) return;
    const g = new THREE.Vector3(0, -9.0, 0);
    const w = new THREE.Vector3(Math.sin(t * 2.1) * 0.6 + 0.4, 0, Math.cos(t * 1.4) * 0.5)
      .multiplyScalar(wind * 4.0);
    const d = new THREE.Vector3();
    const headWorld = this.headCenter.clone().applyMatrix4(headMatrix);
    const colliderAxes = (colliders ?? []).map((c) =>
      new THREE.Vector3().setFromMatrixColumn(c.matrix, c.axisCol ?? 1).normalize());
    const colliderCenters = (colliders ?? []).map((c, ci) => {
      const v = new THREE.Vector3().setFromMatrixPosition(c.matrix);
      if (c.off) v.addScaledVector(colliderAxes[ci]!, c.off);
      return v;
    });
    const near = new THREE.Vector3();
    const up = new THREE.Vector3(0, -1, 0);
    const q = new THREE.Quaternion();
    // The wearer's facing, from the head bone: locks shed to their side of
    // the shoulders along this axis.
    const forward = new THREE.Vector3().setFromMatrixColumn(headMatrix, 2);
    forward.y = 0;
    forward.normalize();
    // The shed force acts only in the SHOULDER BAND (the top of the first —
    // chest — collider): that is where a lock can balance on the ridge.
    // Applied full-length it shoved whole locks off the body like a rod.
    const chest = colliderCenters[0];
    const chestCol = colliders?.[0];
    const chestTop = chest && chestCol ? chest.y + (chestCol.height ?? 0) : null;
    const bandLo = chestTop !== null ? chestTop - 0.14 : -Infinity;
    const bandHi = chestTop !== null ? chestTop + 0.22 : -Infinity;

    for (const lock of this.locks) {
      const anchor = lock.off.clone().applyMatrix4(headMatrix);
      lock.pos[0]!.copy(anchor);
      lock.prev[0]!.copy(anchor);
      const shedX = forward.x * lock.bias * 2.4;
      const shedZ = forward.z * lock.bias * 2.4;
      for (let i = 1; i < lock.pos.length; i++) {
        const p = lock.pos[i]!;
        const pr = lock.prev[i]!;
        // Resting hair rests: nodes in contact last step lose most of their
        // velocity, so collider edges can't keep re-exciting them. Contacted
        // nodes also stop hearing the wind — it was the jitter's metronome.
        const damp = lock.contact[i] ? 0.55 : 0.9;
        const windK = lock.contact[i] ? 0 : 1;
        const inBand = p.y > bandLo && p.y < bandHi ? 1 : 0;
        const vx = (p.x - pr.x) * damp;
        const vy = (p.y - pr.y) * damp;
        const vz = (p.z - pr.z) * damp;
        pr.copy(p);
        p.x += vx + (g.x + w.x * windK + shedX * inBand) * dt * dt;
        p.y += vy + g.y * dt * dt;
        p.z += vz + (g.z + w.z * windK + shedZ * inBand) * dt * dt;
        lock.contact[i] = 0;
      }
      for (let it = 0; it < 8; it++) {
        for (let i = 0; i < lock.pos.length - 1; i++) {
          const a = lock.pos[i]!;
          const b = lock.pos[i + 1]!;
          d.subVectors(b, a);
          const dist = d.length() || 1e-6;
          d.multiplyScalar(((dist - lock.segLen) / dist) * (i === 0 ? 1.0 : 0.5));
          if (i !== 0) a.add(d);
          b.sub(d);
        }
        // Keep locks off the face: push nodes outside the cranium sphere.
        // NO thickness padding here — strands hug the scalp, and padding
        // put short tail/bob chains inside the pushed radius, splaying them
        // upward like pins (stakeholder screenshot, tavern). Node 1 is also
        // exempt: it IS on the scalp, and pushing it bulged strand roots
        // off the head like spider legs.
        for (let i = 2; i < lock.pos.length; i++) {
          const p = lock.pos[i]!;
          d.subVectors(p, headWorld);
          const dist = d.length();
          const min = this.headRadius * 1.02;
          if (dist < min) p.copy(headWorld).addScaledVector(d, min / (dist || 1e-6));
        }
        // Hair meets the floor too (kneeling with floor-length hair).
        for (let i = 1; i < lock.pos.length; i++) {
          if (lock.pos[i]!.y < 0.012 + lock.halfW * 0.5) {
            lock.pos[i]!.y = 0.012 + lock.halfW * 0.5;
            lock.contact[i] = 1;
          }
        }
        // Keep locks off the body: capsule/sphere push-out (cape rules),
        // padded by the strand's half-thickness so it drapes on the surface.
        for (let ci = 0; ci < colliderCenters.length; ci++) {
          const col = colliders![ci]!;
          const centre = colliderCenters[ci]!;
          const axis = colliderAxes[ci]!;
          const reach = col.radius + lock.halfW * 0.7;
          for (let i = 1; i < lock.pos.length; i++) {
            const p = lock.pos[i]!;
            if (col.height === undefined) {
              // Sphere (shoulder cap): radial 3D push.
              d.subVectors(p, centre);
              const dist = d.length();
              if (dist < reach) {
                p.copy(centre).addScaledVector(d, reach / (dist || 1e-6));
                lock.contact[i] = 1;
              }
              continue;
            }
            // Oriented capsule following the bone: a bowing chest tilts its
            // collider with it, so hair rests on the inclined back instead
            // of falling through it (stakeholder, bow animation).
            closestOnBoneSegment(p, centre, axis, col.height, near);
            d.subVectors(p, near);
            const dist = d.length();
            if (dist < reach) {
              p.copy(near).addScaledVector(d, reach / (dist || 1e-6));
              lock.contact[i] = 1;
            }
          }
        }
      }
      // Solid segments follow the chain: midpoint position, oriented along it.
      for (let i = 0; i < lock.meshes.length; i++) {
        const a = lock.pos[i]!;
        const b = lock.pos[i + 1]!;
        const mesh = lock.meshes[i]!;
        mesh.position.copy(a).add(b).multiplyScalar(0.5);
        d.subVectors(b, a).normalize();
        q.setFromUnitVectors(up, d);
        mesh.quaternion.copy(q);
      }
    }
  }

  dispose(): void {
    this.capGroup.parent?.remove(this.capGroup);
    for (const group of [this.capGroup, this.looseGroup]) {
      group.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
    }
  }
}
