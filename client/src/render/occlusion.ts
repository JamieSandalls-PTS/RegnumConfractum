import * as THREE from 'three';

/**
 * See-through occluders (D-542).
 *
 * Walls were knee-high for a reason, written down in `terrain.ts`: at this
 * camera elevation a wall of height h hides roughly 1.5h tiles of floor
 * behind it, so full-height walls swallowed anyone standing beside them. The
 * note said "full-height walls need a camera-side cutaway — revisit with the
 * area pipeline". This is the cutaway.
 *
 * **How it works.** Every tall thing — walls, props over waist height — is
 * drawn with a patched material that knows, in screen space, where the
 * player is and how deep. A fragment that is both NEARER to the camera than
 * the player and within a soft radius of them on screen is thrown away in a
 * 4×4 ordered-dither pattern. The wall does not vanish: it goes stippled,
 * which reads as "there is something in front of you" rather than as a hole.
 *
 * **Why a shader rather than raycasting.** The terrain is instanced — one
 * draw call for every wall in the area — so there is no per-wall object to
 * fade. Patching the material handles every occluder by the same rule, costs
 * nothing per frame on the CPU, and needs no list of what is in the way.
 *
 * **Why an ordered dither rather than alpha.** Transparency would need sorting
 * against instanced geometry and against itself, and half-transparent walls
 * fight the palette quantiser (D-404) by introducing colours that are not in
 * the palette. Stippling is a discard: no sorting, no new colours, and it is
 * exactly the idiom the pixel-art direction already uses.
 */

/** Shared by every patched material, so one update per frame moves them all. */
const uniforms = {
  /** Focus point in device pixels: xy = screen position, z = depth 0..1. */
  uFocus: { value: new THREE.Vector3(0, 0, 1) },
  /** Radius in device pixels over which the cutout fades in. */
  uFocusRadius: { value: 90 },
  /** 0 disables the effect entirely (no player, or the setting is off). */
  uFocusOn: { value: 0 },
};

const FRAGMENT_HEAD = /* glsl */ `
uniform vec3 uFocus;
uniform float uFocusRadius;
uniform float uFocusOn;

/** Bayer 4x4, the same ordered pattern the palette pass dithers with. */
float rc_bayer(vec2 p) {
  int x = int(mod(p.x, 4.0));
  int y = int(mod(p.y, 4.0));
  int i = x + y * 4;
  if (i == 0)  return 0.0000; if (i == 1)  return 0.5000;
  if (i == 2)  return 0.1250; if (i == 3)  return 0.6250;
  if (i == 4)  return 0.7500; if (i == 5)  return 0.2500;
  if (i == 6)  return 0.8750; if (i == 7)  return 0.3750;
  if (i == 8)  return 0.1875; if (i == 9)  return 0.6875;
  if (i == 10) return 0.0625; if (i == 11) return 0.5625;
  if (i == 12) return 0.9375; if (i == 13) return 0.4375;
  if (i == 14) return 0.8125; if (i == 15) return 0.3125;
  return 0.5;
}
`;

const FRAGMENT_BODY = /* glsl */ `
  if (uFocusOn > 0.5) {
    // Only fragments IN FRONT of the focus can be hiding it. Everything
    // behind is left alone, so a wall on the far side of the room stays
    // solid and the room keeps its shape.
    if (gl_FragCoord.z < uFocus.z) {
      float d = length(gl_FragCoord.xy - uFocus.xy);
      // 1 at the centre, 0 at the rim: the hole has a soft edge rather than
      // a circle cut out of the wall.
      float strength = 1.0 - smoothstep(uFocusRadius * 0.45, uFocusRadius, d);
      if (strength > 0.001) {
        // Keep a few pixels even at full strength — a completely erased wall
        // reads as missing geometry, and the player needs to know it is there.
        float keep = mix(1.0, 0.16, strength);
        if (rc_bayer(gl_FragCoord.xy) > keep) discard;
      }
    }
  }
`;

/**
 * Patches a material so it participates in the cutout. Safe to call on a
 * material shared by several meshes; patching twice is a no-op.
 */
export function patchMaterialForOcclusion(material: THREE.Material): void {
  const m = material as THREE.Material & { userData: { rcOcclusion?: boolean } };
  if (m.userData.rcOcclusion) return;
  m.userData.rcOcclusion = true;
  const previous = material.onBeforeCompile?.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    previous?.(shader, renderer);
    shader.uniforms.uFocus = uniforms.uFocus;
    shader.uniforms.uFocusRadius = uniforms.uFocusRadius;
    shader.uniforms.uFocusOn = uniforms.uFocusOn;
    shader.fragmentShader = FRAGMENT_HEAD + shader.fragmentShader.replace(
      '#include <dithering_fragment>',
      `${FRAGMENT_BODY}\n#include <dithering_fragment>`,
    );
  };
  // Changing onBeforeCompile after a material has been used needs a recompile.
  material.needsUpdate = true;
}

/** Patches every material under an object. */
export function applyOcclusionFade(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh && !(o as THREE.InstancedMesh).isInstancedMesh) return;
    const mat = mesh.material;
    if (Array.isArray(mat)) mat.forEach(patchMaterialForOcclusion);
    else if (mat) patchMaterialForOcclusion(mat);
  });
}

/**
 * Tells the cutout where the player is. Call once per frame with the world
 * position of the character the camera is following; pass null when there is
 * nobody to protect (the login screen, a spectating camera).
 */
export function setOcclusionFocus(
  focus: THREE.Vector3 | null,
  camera: THREE.Camera,
  renderer: THREE.WebGLRenderer,
  radiusPx = 90,
): void {
  if (!focus) {
    uniforms.uFocusOn.value = 0;
    return;
  }
  const ndc = focus.clone().project(camera);
  // gl_FragCoord is in device pixels with y up from the bottom; the drawing
  // buffer size is the right frame here, not the CSS size, or the hole lands
  // in the wrong place on a scaled canvas.
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  uniforms.uFocus.value.set(
    ((ndc.x + 1) / 2) * size.x,
    ((ndc.y + 1) / 2) * size.y,
    (ndc.z + 1) / 2,
  );
  uniforms.uFocusRadius.value = radiusPx;
  uniforms.uFocusOn.value = 1;
}

/** Turns the effect off entirely (a graphics setting, or a headless test). */
export function setOcclusionEnabled(on: boolean): void {
  if (!on) uniforms.uFocusOn.value = 0;
}

/** Test/inspection hook: what the shader is currently being told. */
export function occlusionState(): { on: boolean; x: number; y: number; depth: number } {
  return {
    on: uniforms.uFocusOn.value > 0.5,
    x: uniforms.uFocus.value.x,
    y: uniforms.uFocus.value.y,
    depth: uniforms.uFocus.value.z,
  };
}
