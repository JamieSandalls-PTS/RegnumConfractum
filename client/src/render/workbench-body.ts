import * as THREE from 'three';

/**
 * A placeholder body for the cloth workbench (D-617).
 *
 * ⚠ The workbench was built on the procedural cast (D-520): it pins cloth to
 * `CharacterVisual.bones()` and collides it against `colliderCatalog()`, both
 * of which are properties of a skeleton this renderer GENERATED. With the
 * procedural cast deleted there is no such skeleton, and the imported cast is
 * fixed meshes with no cloth simulation of its own — so the workbench needed
 * something to stand on or it went down with the cast.
 *
 * ⚠ This is a PLACEHOLDER and says so: a jointed stand-in at roughly human
 * proportions, enough to pin a cape to a shoulder and watch it fall against a
 * chest. It is explicitly NOT the cast, and anything tuned against it is tuned
 * against an approximation — which is the honest state of cloth tuning now
 * that the body it was tuned against is gone.
 *
 * ⚠ Proportions are the ones the procedural rig used, so existing garment
 * settings (D-520, the stakeholder's own tuned exports) stay in roughly the
 * right place rather than being silently re-scaled by a new body.
 */

/** Rough human proportions, in metres. The old rig's numbers. */
const DIMS = {
  height: 1.75,
  bodyW: 0.38,
  hipW: 0.34,
  torsoH: 0.58,
  armLen: 0.30,
  legLen: 0.45,
};

export class WorkbenchBody {
  readonly root = new THREE.Group();

  private readonly joints = new Map<string, THREE.Object3D>();

  // Any parent will do: the viewer gave it the scene, the tool gives it the
  // stage mount that every preview hangs from.
  constructor(parent: THREE.Object3D) {
    parent.add(this.root);
    this.build();
    this.root.updateMatrixWorld(true);
  }

  /**
   * Bones a garment may be pinned to, by the names the workbench already uses.
   *
   * ⚠ The NAMES are kept identical to the procedural rig's on purpose. A saved
   * garment stores the bone it is pinned to as a string (D-520), so renaming
   * them would silently unpin every garment already tuned — the pin would
   * resolve to nothing and the cloth would fall through the floor.
   */
  bones(): Record<string, THREE.Object3D> {
    return Object.fromEntries(this.joints);
  }

  /** Collision volumes, in the shape `ClothSim` expects. */
  colliderCatalog(): Record<
    string,
    { matrix: THREE.Matrix4; radius: number; height?: number; axisCol?: number; off?: number }
  > {
    const at = (name: string): THREE.Matrix4 =>
      this.joints.get(name)?.matrixWorld ?? new THREE.Matrix4();
    return {
      chest: {
        matrix: at('chest'),
        radius: DIMS.bodyW * 0.45,
        height: Math.max(0.02, DIMS.torsoH * 0.55 - DIMS.bodyW * 0.45),
      },
      pelvis: {
        matrix: at('pelvis'),
        radius: DIMS.hipW * 0.5,
        height: Math.max(0.02, DIMS.torsoH * 0.35 - DIMS.hipW * 0.5),
      },
      'shoulder left': { matrix: at('shoulder left'), radius: DIMS.bodyW * 0.27 },
      'shoulder right': { matrix: at('shoulder right'), radius: DIMS.bodyW * 0.27 },
      'hips (skirt)': {
        matrix: at('pelvis'),
        radius: DIMS.hipW * 0.55,
        height: Math.max(0.02, DIMS.legLen * 0.4),
      },
    };
  }

  /**
   * Measurements the workbench sizes a garment against.
   *
   * ⚠ The same field names and roughly the same numbers as the rig this
   * replaces, so a garment already tuned is not silently re-cut by a body of
   * different proportions.
   */
  get measurements(): {
    shoulderW: number; bodyW: number; hipW: number; torsoH: number;
    headH: number; height: number; capeAnchorY: number;
  } {
    const anchor = this.joints.get('upper back (cape anchor)');
    return {
      shoulderW: DIMS.bodyW * 1.1,
      bodyW: DIMS.bodyW,
      hipW: DIMS.hipW,
      torsoH: DIMS.torsoH,
      headH: 0.22,
      height: DIMS.height,
      capeAnchorY: anchor ? anchor.position.y : DIMS.height * 0.72,
    };
  }

  /** What cloth hangs off. One group, so a garment can be cleared wholesale. */
  get clothParent(): THREE.Object3D {
    return this.root;
  }

  /** Nothing animates; the stand-in is a stand. */
  update(): void {
    this.root.updateMatrixWorld(true);
  }

  dispose(): void {
    this.root.parent?.remove(this.root);
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    });
  }

  private build(): void {
    const material = new THREE.MeshStandardMaterial({
      color: 0x6f6a78,
      roughness: 0.9,
      // ⚠ Visibly a mannequin. Making it look like a character would invite
      // somebody to judge the ART on it, and it is not the art.
      flatShading: true,
    });

    const joint = (name: string, x: number, y: number, z = 0): THREE.Object3D => {
      const node = new THREE.Object3D();
      node.position.set(x, y, z);
      this.root.add(node);
      this.joints.set(name, node);
      return node;
    };

    const hipY = DIMS.legLen + 0.12;
    const chestY = hipY + DIMS.torsoH * 0.55;
    const shoulderY = hipY + DIMS.torsoH * 0.9;

    joint('pelvis', 0, hipY, 0);
    joint('spine', 0, hipY + DIMS.torsoH * 0.3, 0);
    joint('chest', 0, chestY, 0);
    joint('upper back (cape anchor)', 0, shoulderY - 0.04, -DIMS.bodyW * 0.16);
    joint('neck', 0, shoulderY + 0.06, 0);
    joint('head', 0, shoulderY + 0.18, 0);
    joint('shoulder left', -DIMS.bodyW * 0.55, shoulderY, 0);
    joint('shoulder right', DIMS.bodyW * 0.55, shoulderY, 0);
    joint('elbow left', -DIMS.bodyW * 0.62, shoulderY - DIMS.armLen, 0);
    joint('elbow right', DIMS.bodyW * 0.62, shoulderY - DIMS.armLen, 0);
    joint('hand left', -DIMS.bodyW * 0.66, shoulderY - DIMS.armLen * 2, 0);
    joint('hand right', DIMS.bodyW * 0.66, shoulderY - DIMS.armLen * 2, 0);
    joint('knee left', -DIMS.hipW * 0.3, DIMS.legLen * 0.55, 0);
    joint('knee right', DIMS.hipW * 0.3, DIMS.legLen * 0.55, 0);
    joint('foot left', -DIMS.hipW * 0.3, 0.04, 0);
    joint('foot right', DIMS.hipW * 0.3, 0.04, 0);

    // The visible stand-in: a torso, a head and four limbs. Blocky on purpose.
    const add = (geo: THREE.BufferGeometry, x: number, y: number, z = 0): void => {
      const mesh = new THREE.Mesh(geo, material);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      this.root.add(mesh);
    };
    add(new THREE.CapsuleGeometry(DIMS.bodyW * 0.42, DIMS.torsoH * 0.6, 4, 10), 0, chestY);
    add(new THREE.SphereGeometry(0.11, 12, 10), 0, shoulderY + 0.2);
    for (const side of [-1, 1]) {
      add(
        new THREE.CapsuleGeometry(0.055, DIMS.armLen * 1.7, 3, 8),
        side * DIMS.bodyW * 0.62,
        shoulderY - DIMS.armLen,
      );
      add(
        new THREE.CapsuleGeometry(0.075, DIMS.legLen * 0.95, 3, 8),
        side * DIMS.hipW * 0.3,
        DIMS.legLen * 0.55,
      );
    }
  }
}
