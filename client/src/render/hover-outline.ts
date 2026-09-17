import * as THREE from 'three';

/**
 * A lit edge around whatever the cursor is over (D-622).
 *
 * The stakeholder asked for an interactable object to "show a highlighted edge
 * when hovering the mouse cursor over it... stations, characters, and chairs.
 * Any the character can directly interact with." There was a ring on the
 * GROUND under a hovered entity, which answers a different question — it says
 * where a thing stands, not that the thing is a thing you can use — and
 * scenery like a chair had no feedback at all.
 *
 * ⚠ **An inverted hull, not a post-process.** The alternative is an outline
 * pass over the whole frame, which means a second render target, a depth
 * prepass and an edge filter — and it would have to run every frame for
 * everybody so that it is available on the frames where something is hovered.
 * A hull is one extra draw per mesh of ONE object, only while the cursor is on
 * it. It is also the technique that survives the renderer changing underneath
 * it: nothing here reads the depth buffer.
 *
 * ⚠ **The push happens in the vertex shader, before skinning.** A character is
 * a skinned mesh: its vertices are transformed on the GPU by the skeleton, so
 * scaling the OBJECT up does nothing to where the skin ends up and an outline
 * built that way stays welded to the bind pose while the body walks out of it.
 * Pushing `transformed` along the vertex normal at `<begin_vertex>` puts the
 * expansion into the same bind-pose space the skinning then reads, so the hull
 * follows every frame of every clip for free.
 *
 * ⚠ **The width is divided by the object's world scale.** The imported cast is
 * authored in centimetres and worn at a root scale of 0.01 (D-555, D-577), and
 * the push is in LOCAL units — so a constant would be a hundred times too
 * small on a person and correct on a chair, which looks like the outline
 * failing on characters specifically.
 */

/** Warm, and not a colour the palette uses for danger or for a target ring. */
const OUTLINE_COLOUR = 0xffd27a;

/** How thick the edge reads, in metres of world space. */
const OUTLINE_METRES = 0.035;

/**
 * ⚠ `normal` rather than `objectNormal`. `objectNormal` is only declared by
 * the basic material's vertex shader inside `#if defined(USE_ENVMAP) ||
 * defined(USE_SKINNING)`, so reading it would compile for a character and fail
 * to compile for a chair — the shape of bug that shows up as one class of
 * object having no outline and nothing in the log.
 */
function outlineMaterial(localWidth: number): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({
    color: OUTLINE_COLOUR,
    // Backfaces only: they sit behind the object's own front faces, so the
    // hull is hidden everywhere except where the push carried it past the
    // silhouette. That band IS the edge.
    side: THREE.BackSide,
    transparent: true,
    opacity: 0.9,
    // ⚠ No depth WRITE, but depth TEST stays on. Writing would let the hull
    // occlude things behind it by a few centimetres; testing is what makes a
    // highlighted chair correctly disappear behind the wall in front of it.
    depthWrite: false,
    fog: false,
    toneMapped: false,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.outlineWidth = { value: localWidth };
    shader.vertexShader = `uniform float outlineWidth;\n${shader.vertexShader}`.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n\ttransformed += normalize( normal ) * outlineWidth;',
    );
  };
  // One program for every hull. The width is a uniform, not a define, so
  // outlining a chair does not recompile the shader the character used.
  material.customProgramCacheKey = () => 'rc-hover-outline';
  return material;
}

interface Hull {
  hull: THREE.Mesh;
  source: THREE.Object3D;
  material: THREE.Material;
}

export class HoverOutline {
  private readonly group = new THREE.Group();
  private hulls: Hull[] = [];
  private target: THREE.Object3D | null = null;

  constructor(private readonly scene: THREE.Scene) {
    // ⚠ Its own group at the identity, so a hull's local matrix can be its
    // source's WORLD matrix. Parenting a hull under the thing it outlines
    // would apply that thing's transform twice.
    this.scene.add(this.group);
  }

  /** What the outline is currently drawn around. Verification only. */
  get outlining(): THREE.Object3D | null {
    return this.target;
  }

  /** How many hull meshes are in the scene. Verification only. */
  get hullCount(): number {
    return this.hulls.length;
  }

  /**
   * Outline this object, or nothing.
   *
   * Cheap to call every frame with the same argument: it rebuilds only when
   * the target actually changes.
   */
  show(target: THREE.Object3D | null): void {
    if (target === this.target) return;
    this.clear();
    this.target = target;
    if (!target) return;
    target.updateMatrixWorld(true);
    const scale = new THREE.Vector3();
    target.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh || !mesh.visible) return;
      // ⚠ No normals, no hull. A few built-in shapes are drawn from geometry
      // that carries none, and pushing along a vector that is not there
      // produces a copy of the object in flat orange sitting exactly on top of
      // it — which reads as the model being replaced rather than outlined.
      if (!mesh.geometry?.getAttribute('normal')) return;
      mesh.getWorldScale(scale);
      const material = outlineMaterial(OUTLINE_METRES / Math.max(1e-6, scale.x));
      const skinned = mesh as THREE.SkinnedMesh;
      let hull: THREE.Mesh;
      if (skinned.isSkinnedMesh) {
        const clone = new THREE.SkinnedMesh(mesh.geometry, material);
        // ⚠ The SAME skeleton object, not a copy. A copied skeleton would
        // have to be posed by somebody, and nobody would: the outline would
        // stand in the bind pose while the body moved inside it.
        clone.bindMode = skinned.bindMode;
        clone.bind(skinned.skeleton, skinned.bindMatrix);
        hull = clone;
      } else {
        hull = new THREE.Mesh(mesh.geometry, material);
      }
      hull.matrixAutoUpdate = false;
      // The hull is expanded past its own bounds, and a character's bounds are
      // the bind pose rather than the frame; culling it on either is how an
      // outline blinks out at the edge of the screen.
      hull.frustumCulled = false;
      hull.castShadow = false;
      hull.receiveShadow = false;
      // ⚠ The source's layer, copied. Characters sit on layer 1 (D-404's
      // split pass left that shape behind), and a hull on layer 0 would be
      // lit and drawn by a different set of rules from the body inside it.
      hull.layers.mask = mesh.layers.mask;
      this.group.add(hull);
      this.hulls.push({ hull, source: mesh, material });
    });
  }

  /**
   * Follow the source. Call once a frame, after the world has been posed.
   *
   * ⚠ Copied rather than parented, and copied AFTER the animation has run:
   * a hull that reads last frame's matrix trails a running character by a
   * whole frame, which at four metres a second is visible as a double image.
   */
  update(): void {
    if (this.hulls.length === 0) return;
    for (const { hull, source } of this.hulls) {
      hull.matrix.copy(source.matrixWorld);
      hull.matrixWorldNeedsUpdate = true;
    }
  }

  private clear(): void {
    for (const { hull, material } of this.hulls) {
      this.group.remove(hull);
      // ⚠ The MATERIAL is disposed and the geometry is not. Geometry is
      // shared with the object being outlined — and, for the imported cast,
      // with every other copy of that character (D-559). Freeing it would
      // blank the room.
      material.dispose();
    }
    this.hulls = [];
    this.target = null;
  }

  dispose(): void {
    this.clear();
    this.scene.remove(this.group);
  }
}
