import {
  Bone,
  BufferAttribute,
  BufferGeometry,
  Group,
  Matrix4,
  MeshStandardMaterial,
  Object3D,
  Skeleton,
  SkinnedMesh,
  Vector3,
} from 'three';

/**
 * Assembling a character out of modular parts (D-555, D-558).
 *
 * ONE implementation, imported by both the Node build and the browser
 * studio. A preview that assembles differently from the build is a preview
 * that lies, and the whole point of the studio is that what you approve is
 * what ships.
 */

export interface Assembled {
  readonly group: Group;
  readonly skeleton: Skeleton;
  readonly meshes: readonly SkinnedMesh[];
  /**
   * Weighting faults found in the source art and corrected, one line each.
   * Never silent: the build prints them and the studio shows them, because
   * altering somebody else's art without saying so is how a pipeline starts
   * lying about what it shipped.
   */
  readonly repairs: readonly string[];
}

/** What we learn about one bone, gathered before anything is built. */
interface BoneSpec {
  readonly name: string;
  /**
   * The bone above it, once every part has had its say.
   *
   * ⚠ MUTABLE, because the first part to mention a bone is often the one
   * that knows least about it. See `gather`.
   */
  parent: string | null;
  readonly src: Object3D;
  /** Present only for bones some mesh is actually weighted to. */
  inverse: Matrix4 | null;
}

const LOCAL = new Matrix4();

/**
 * One skeleton, many meshes.
 *
 * A part's `skeleton.bones` is NOT the whole rig — it is only the bones that
 * part is weighted to. A Synty torso lists seven; a hand lists nine, and a
 * different nine. So the shared skeleton is the UNION, and each part's
 * `skinIndex` is remapped from its own bone order into the union's BY NAME.
 * Binding on index instead — which works right up until the first part with
 * a different bone list — is how you get a character whose left arm follows
 * its right leg.
 *
 * Built in TWO PASSES, and that matters. The first pass gathers every bone
 * and its parent from the source hierarchies; the second links them. Doing
 * it in one pass made the result depend on which part happened to be
 * processed first: whichever part's chain terminated highest became the
 * root, and the next part with a different top threw "two rig roots". The
 * build sorted parts one way and the studio another, so the same character
 * assembled in one and failed in the other.
 */
export function assemble(files: readonly { slot: string; mesh: SkinnedMesh }[]): Assembled {
  const specs = new Map<string, BoneSpec>();

  /** Record a bone and everything above it, without building anything yet. */
  const gather = (src: Object3D, inverse: Matrix4 | null): void => {
    const existing = specs.get(src.name);
    if (existing) {
      if (inverse && !existing.inverse) existing.inverse = inverse;
      else if (inverse && existing.inverse) checkAgrees(src.name, existing.inverse, inverse);
      // ⚠ A part that knows this bone's PARENT upgrades one recorded as a
      // root. Each part file carries only the ancestors it needs, so the head
      // ships `neck_01` with nothing above it while the torso ships the same
      // bone under `spine_03` -- and slot order puts the head first. Taking
      // the first answer and never revisiting it left the neck parentless, the
      // orphan rule below (written for capes) adopted it onto the nearest body
      // bone, and that bone was `clavicle_r`.
      //
      // ⚠ The result was a head mounted on a SHOULDER. It is invisible at
      // rest, because the bind matrices still place every bone correctly, and
      // it appears the moment a clip rotates the neck: measured 84 degrees out
      // of true, swinging with the arm. It affected every re-assembled body --
      // every player-chosen face and every garment worn in the world (D-571),
      // not only the creation screen where it was noticed.
      if (existing.parent === null) {
        let above: Object3D | null = src.parent;
        while (above && (above as Bone).isBone && above.name === src.name) above = above.parent;
        if (above && (above as Bone).isBone) {
          existing.parent = above.name;
          gather(above, null);
        }
      }
      return;
    }
    // Walk past a bone that is merely its own duplicate under another copy of
    // the rig — a Mixamo FBX exported with skin nests two identically named
    // skeletons inside each other.
    let up: Object3D | null = src.parent;
    while (up && (up as Bone).isBone && up.name === src.name) up = up.parent;
    const parent = up && (up as Bone).isBone ? up : null;
    specs.set(src.name, { name: src.name, parent: parent?.name ?? null, src, inverse });
    if (parent) gather(parent, null);
  };

  for (const { mesh } of files) {
    const bones = mesh.skeleton.bones;
    for (let i = 0; i < bones.length; i++) gather(bones[i]!, mesh.skeleton.boneInverses[i]!);
  }

  /**
   * Where a bone belongs at rest.
   *
   * The BIND matrix, whenever the part supplies one - it is by definition
   * the bone's world transform in the pose the vertices were weighted
   * against, which is the only statement in the file about where that bone
   * goes. A node's own transform is merely the pose the file happened to be
   * saved in, and the two are not always the same thing.
   *
   * For every body part in the Synty pack they agree to the decimal, so this
   * changes nothing for an arm, a leg or a torso. For a CAPE they disagree
   * completely: `back_05` binds across the back at y=53.6 while its node
   * sits at y=-80.1, below the floor, because the exporter dropped the
   * socket the chain used to hang from. Reading the node put the cape on the
   * ground behind the character. Reading the bind matrix puts it on their
   * back.
   */
  const restOf = (spec: BoneSpec): Matrix4 =>
    spec.inverse ? new Matrix4().copy(spec.inverse).invert() : spec.src.matrixWorld;

  // Link. A bone whose parent is not itself in the set is a root.
  const made = new Map<string, Bone>();
  const build = (name: string): Bone => {
    const already = made.get(name);
    if (already) return already;
    const spec = specs.get(name)!;
    const bone = new Bone();
    bone.name = name;
    made.set(name, bone);
    const parentSpec = spec.parent ? specs.get(spec.parent) : undefined;
    if (parentSpec) {
      const parent = build(parentSpec.name);
      // Local transform from the two REST matrices, so any duplicate bones
      // skipped over above cannot shift the result.
      LOCAL.copy(restOf(parentSpec)).invert().multiply(restOf(spec));
      LOCAL.decompose(bone.position, bone.quaternion, bone.scale);
      parent.add(bone);
    } else {
      // A root takes its place in the WORLD, which also picks up whatever
      // transform the FBX's own group nodes carry above the rig.
      restOf(spec).decompose(bone.position, bone.quaternion, bone.scale);
    }
    return bone;
  };

  // Refresh world matrices from the top of the BONE hierarchy, not from the
  // mesh. A SkinnedMesh clone is detached from its source group while its
  // skeleton still points at the original bones, so walking up from the mesh
  // updates nothing that is read below — and the result is a character two
  // centimetres tall rather than an error.
  for (const spec of specs.values()) {
    if (spec.parent) continue;
    // All the way to the top of whatever the bone is sitting in, not just to
    // the bone. The FBX's own group nodes above the rig carry the exporter's
    // unit scaling, and stopping at the root bone drops it — which is the
    // difference between a 1.7m character and a 2cm one.
    let top: Object3D = spec.src;
    while (top.parent) top = top.parent;
    top.updateMatrixWorld(true);
  }
  for (const name of specs.keys()) build(name);

  const roots = [...specs.values()].filter((s) => !s.parent || !specs.has(s.parent));
  if (roots.length === 0) throw new Error('no bones');

  /**
   * More than one root is normal, and leaving them side by side was wrong.
   *
   * Thirteen of this pack's 720 parts are capes: a chain of their own
   * (`Capes_00 > Capes_01 > back_02..back_06`) with not one body bone in the
   * file, because in the vendor's engine you parent it to a socket on
   * import. Left as a second root it is placed correctly and then never
   * moves - the character walks out from under their own cloak, which is
   * exactly what it looked like.
   *
   * So an orphan chain is hung off the body bone nearest to where it binds.
   * Nearest-by-bind-position needs no table of part names and no socket
   * these files do not ship: a cape resolves to the upper spine because that
   * is what its top bone sits against. The chain stays RIGID relative to
   * that bone - it travels and turns with the torso but does not yet flow,
   * which is D-519's cloth system's job and not the importer's.
   */
  const primary = roots.reduce((a, b) => (subtreeSize(specs, b) > subtreeSize(specs, a) ? b : a));
  const group = new Group();
  group.add(made.get(primary.name)!);

  for (const orphan of roots) {
    if (orphan === primary) continue;
    const anchor = nearestAnchor(specs, made, orphan, primary, restOf);
    if (!anchor) {
      group.add(made.get(orphan.name)!);
      continue;
    }
    const bone = made.get(orphan.name)!;
    LOCAL.copy(restOf(specs.get(anchor)!)).invert().multiply(restOf(orphan));
    LOCAL.decompose(bone.position, bone.quaternion, bone.scale);
    made.get(anchor)!.add(bone);
  }

  // The skeleton lists only bones something is weighted to; the rest are in
  // the hierarchy to position their children and have no bind matrix.
  //
  // PARENT BEFORE CHILD, and this is not cosmetic. `SkeletonUtils.retarget`
  // walks `skeleton.bones` in array order and derives each bone's local
  // matrix from `bone.parent.matrixWorld` — so a child listed before its
  // parent is solved against the parent's STALE world matrix, and the error
  // then propagates down everything beneath it. Gathering order gave the
  // exact opposite: parts are visited leaf-first and their ancestors
  // appended as they are discovered, so the whole spine came out reversed
  // (`neck_01` at index 0, `Pelvis` at index 4). Nothing errored; the walk
  // simply retargeted wrong, worst at the ends of the longest chains.
  const order: string[] = [];
  const walk = (name: string): void => {
    if (specs.get(name)?.inverse) order.push(name);
    for (const child of made.get(name)!.children) {
      if ((child as Bone).isBone) walk(child.name);
    }
  };
  // From what actually ended up at the top of the group, not from `roots` —
  // an orphan chain has been re-parented into the body by now, so walking
  // the original root list as well would list a cape's bones twice and the
  // skin remap would bind them to the second copy.
  for (const child of group.children) {
    if ((child as Bone).isBone) walk(child.name);
  }
  const skeleton = new Skeleton(
    order.map((n) => made.get(n)!),
    order.map((n) => specs.get(n)!.inverse!),
  );
  const indexOf = new Map(order.map((n, i) => [n, i]));

  const material = new MeshStandardMaterial({ name: 'character', roughness: 0.85, metalness: 0 });
  const meshes: SkinnedMesh[] = [];
  const repairs: string[] = [];
  for (const { slot, mesh } of files) {
    // CLONE before remapping. `setAttribute` mutates, and the studio hands
    // the same cached part in repeatedly — remapping an already-remapped
    // skinIndex scrambles the weights of every part after the first.
    const geometry = mesh.geometry.clone();
    // ⚠ The pack's VERTEX COLOURS are discarded (D-637). Some parts carry a
    // colour attribute — the heads, torsos, hands and legs of this pack — and
    // it is not art: the atlas is. This material ignores it, so the studio
    // and the tool never showed it; but the exporter wrote it into every
    // .glb as COLOR_0, and GLTFLoader turns vertex colours ON for a mesh that
    // has them, multiplying the atlas by black. That was the keeper's face in
    // the game: right in the tool, black in the world, same head.
    geometry.deleteAttribute('color');
    const repair = repairLopsidedWeights(mesh, geometry, slot);
    if (repair) repairs.push(repair);
    const skinIndex = geometry.getAttribute('skinIndex');
    const names = mesh.skeleton.bones.map((b) => b.name);
    const remap = names.map((n) => indexOf.get(n)!);
    const array = skinIndex.array as ArrayLike<number>;
    const rebuilt = new Uint16Array(array.length);
    for (let i = 0; i < array.length; i++) rebuilt[i] = remap[array[i]!]!;
    geometry.setAttribute('skinIndex', new BufferAttribute(rebuilt, skinIndex.itemSize));

    const out = new SkinnedMesh(geometry, material);
    out.name = slot;
    out.bind(skeleton, new Matrix4().copy(mesh.bindMatrix));
    out.frustumCulled = false;
    group.add(out);
    meshes.push(out);
  }

  // Pose the rig before handing it back.
  //
  // Until this runs the hierarchy is in whatever pose the source files were
  // authored in, which for per-slot parts is not a usable one. Leaving it to
  // the caller meant the build did it and the studio did not, and the studio
  // rendered a character two centimetres tall.
  // WORLD MATRICES FIRST, and this is not belt-and-braces.
  //
  // `Skeleton.pose()` restores each skinned bone's LOCAL matrix from its bind
  // matrix relative to its PARENT'S WORLD matrix — and it only sets the world
  // matrices of bones that are in the skeleton. A bone nothing is weighted to
  // is not in the skeleton, so on a freshly built hierarchy its world matrix
  // is still identity, and every skinned child of one lands at its bind
  // position measured from the ORIGIN instead of from its parent.
  //
  // A whole character never showed it: almost every bone in the chain carries
  // weights, so `pose()` had already set the parents it needed. A single head
  // does — its `spine_03` is an unweighted ancestor — and the head assembled
  // 1.6 metres behind the character, which is exactly its own height, because
  // that is what "measured from the origin" means for a bone at eye level.
  group.updateMatrixWorld(true);
  skeleton.pose();
  group.updateMatrixWorld(true);
  return { group, skeleton, meshes, repairs };
}



/**
 * Which side of the body a bone is on, by its name.
 *
 * Rigs mark the side in the bone name and nowhere else — `clavicle_r`,
 * `UpperArm_L`, `mixamorigLeftHand` — so this is a naming question, not a
 * geometric one. A bone on the centre line (`spine_02`, `head`) is neither.
 */
function sideOfBone(name: string): 'l' | 'r' | 'c' {
  if (/(_l$|_l_|left)/i.test(name)) return 'l';
  if (/(_r$|_r_|right)/i.test(name)) return 'r';
  return 'c';
}

/**
 * Correct a part that is anchored on the centre line but bound to ONE side.
 *
 * `SK_Chr_HelmetAttachment_03` is a pair of wings on a helmet. Ninety-eight
 * per cent of it is weighted to the head, and twenty-six vertices at the
 * root of the RIGHT wing are weighted, fully, to `clavicle_r` and
 * `UpperArm_R`. So the right wing is partly driven by the shoulder: it tears
 * away from the helmet every time the arm swings, and only on that side.
 * That is a weight painted onto the wrong bone at the vendor, and it would
 * do the same thing in their own engine.
 *
 * The test has to be this narrow. Asymmetry alone is not a fault — this pack
 * ships sashes over one shoulder and drapes over one hip, and six parts are
 * deliberately lopsided. What no garment does is hang off exactly one side
 * of a body while being anchored on the spine: a part that touches the right
 * arm and NOT the left, for under a twentieth of its weight, is a mistake
 * rather than a design. Across all 720 parts in this pack that describes one
 * of them, and it is the broken one.
 *
 * The weights move to whichever bone already carries most of the part, which
 * for an attachment is the bone it is attached to. Per-vertex totals are
 * untouched — an influence is repointed, not removed — so nothing needs
 * renormalising and the part cannot lose volume.
 */
function repairLopsidedWeights(
  mesh: SkinnedMesh,
  geometry: BufferGeometry,
  label: string,
): string | null {
  const index = geometry.getAttribute('skinIndex');
  const weight = geometry.getAttribute('skinWeight');
  const names = mesh.skeleton.bones.map((b) => b.name);

  const perBone = new Float64Array(names.length);
  const perSide = { l: 0, r: 0, c: 0 };
  let total = 0;
  for (let v = 0; v < index.count; v++) {
    for (let k = 0; k < 4; k++) {
      const w = weight.getComponent(v, k);
      if (w <= 0) continue;
      const b = index.getComponent(v, k);
      perBone[b] = (perBone[b] ?? 0) + w;
      perSide[sideOfBone(names[b] ?? '')] += w;
      total += w;
    }
  }
  if (total <= 0) return null;

  // Anchored on the centre line, and touching one side but not the other.
  if (perSide.c / total < 0.8) return null;
  const strayside = perSide.l > 0 && perSide.r === 0 ? 'l' : perSide.r > 0 && perSide.l === 0 ? 'r' : null;
  if (!strayside) return null;
  const share = perSide[strayside] / total;
  if (share >= 0.05) return null;

  let dominant = 0;
  for (let i = 1; i < perBone.length; i++) if (perBone[i]! > perBone[dominant]!) dominant = i;
  if (sideOfBone(names[dominant] ?? '') !== 'c') return null;

  const moved = new Set<string>();
  let vertices = 0;
  const rebuilt = new Uint16Array(index.array.length);
  for (let i = 0; i < rebuilt.length; i++) rebuilt[i] = (index.array as ArrayLike<number>)[i]!;
  for (let v = 0; v < index.count; v++) {
    let touched = false;
    for (let k = 0; k < 4; k++) {
      const b = index.getComponent(v, k);
      if (weight.getComponent(v, k) <= 0) continue;
      if (sideOfBone(names[b] ?? '') !== strayside) continue;
      // Repoint the influence. A vertex may now name the dominant bone
      // twice; skinning sums the weights, so the total is preserved exactly.
      rebuilt[v * index.itemSize + k] = dominant;
      moved.add(names[b] ?? '?');
      touched = true;
    }
    if (touched) vertices++;
  }
  geometry.setAttribute('skinIndex', new BufferAttribute(rebuilt, index.itemSize));
  return (
    `${label}: ${vertices} vertices were bound to ${[...moved].join(' and ')} ` +
    `on a part otherwise anchored to ${names[dominant]} — moved to ${names[dominant]}`
  );
}

/** How many bones hang off this root, so the body can be told from a cape. */
function subtreeSize(specs: Map<string, BoneSpec>, root: BoneSpec): number {
  let n = 0;
  for (const spec of specs.values()) {
    for (let at: BoneSpec | undefined = spec; at; at = at.parent ? specs.get(at.parent) : undefined) {
      if (at === root) {
        n++;
        break;
      }
    }
  }
  return n;
}

/**
 * The body bone an orphan chain should hang from.
 *
 * Measured from the orphan's topmost WEIGHTED bone: its root is often an
 * empty holder sitting at the file's origin, which would resolve to whatever
 * bone happens to be nearest the floor. The bone that carries vertices is
 * the one whose bind position says where the part actually belongs.
 */
function nearestAnchor(
  specs: Map<string, BoneSpec>,
  made: Map<string, Bone>,
  orphan: BoneSpec,
  primary: BoneSpec,
  restOf: (spec: BoneSpec) => Matrix4,
): string | null {
  const under = (spec: BoneSpec, root: BoneSpec): boolean => {
    for (let at: BoneSpec | undefined = spec; at; at = at.parent ? specs.get(at.parent) : undefined) {
      if (at === root) return true;
    }
    return false;
  };
  const depth = (spec: BoneSpec): number => {
    let d = 0;
    for (let at = spec; at.parent; d++) at = specs.get(at.parent)!;
    return d;
  };

  let top: BoneSpec | null = null;
  for (const spec of specs.values()) {
    if (!spec.inverse || !under(spec, orphan)) continue;
    if (!top || depth(spec) < depth(top)) top = spec;
  }
  if (!top) return null;

  const want = new Vector3().setFromMatrixPosition(restOf(top));
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const spec of specs.values()) {
    if (!spec.inverse || !under(spec, primary) || !made.has(spec.name)) continue;
    const d = new Vector3().setFromMatrixPosition(restOf(spec)).distanceTo(want);
    if (d < bestDistance) {
      bestDistance = d;
      best = spec.name;
    }
  }
  return best;
}

/**
 * Two parts claiming the same joint must agree about where it is.
 *
 * They do NOT agree to the bit: the FBX exporter round-trips through
 * float32, so the same joint differs by under a millimetre between parts.
 * That is noise. A genuine disagreement — a part rigged to a different
 * skeleton — is off by whole degrees and centimetres, and must throw,
 * because binding it anyway deforms it silently.
 */
function checkAgrees(name: string, a: Matrix4, b: Matrix4): void {
  for (let i = 0; i < 16; i++) {
    // Columns 0-2 are rotation and scale (unitless); column 3 is translation,
    // in the source file's centimetres.
    const tolerance = i >= 12 ? 0.5 : 1e-3;
    if (Math.abs(a.elements[i]! - b.elements[i]!) > tolerance) {
      throw new Error(`bone ${name} is bound differently in two parts`);
    }
  }
}
