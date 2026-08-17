import * as THREE from 'three';

/**
 * Shared banded (toon) shading for characters (stakeholder request,
 * 2026-08-17: "make the seams of the overlapping shapes less noticeable").
 *
 * Why banding fixes seams: the body is overlapping primitives, and where two
 * surfaces intersect the normal jumps, so smooth Lambert shading jumps with
 * it — a visible crease line along every intersection. Quantising the light
 * into a few bands means a small normal difference lands in the SAME band
 * and renders identically: the crease disappears everywhere except where it
 * genuinely crosses a band boundary. Banded shading is also what hand-drawn
 * pixel art does, so it sits naturally under the palette quantiser (D-404).
 */

let gradient: THREE.DataTexture | null = null;

function gradientMap(): THREE.DataTexture {
  if (!gradient) {
    // Four bands, biased bright: the dark end stays readable under the
    // palette's warm-neutral ramp instead of collapsing to black.
    const steps = new Uint8Array([105, 155, 205, 250]);
    gradient = new THREE.DataTexture(steps, steps.length, 1, THREE.RedFormat);
    gradient.minFilter = THREE.NearestFilter;
    gradient.magFilter = THREE.NearestFilter;
    gradient.needsUpdate = true;
  }
  return gradient;
}

/** Drop-in replacement for the characters' MeshLambertMaterial. */
export function toonMaterial(color: number): THREE.MeshToonMaterial {
  return new THREE.MeshToonMaterial({ color, gradientMap: gradientMap() });
}
