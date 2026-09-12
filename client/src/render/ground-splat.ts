import * as THREE from 'three';
import { GROUND_MASKS, GROUND_WEIGHTS_PER_MASK, type GroundMaterial } from '@rc/shared';

/**
 * Ground as a SPLAT: a painted mask, with the real textures composited at full
 * resolution (D-587, extended by D-588).
 *
 * ⚠ D-585 baked the material's texture INTO the painted image. That was argued
 * from the palette quantiser — "the detail a splat shader buys is quantised
 * away" — and D-586 removed the quantiser, which voided the argument without
 * anybody noticing. Measured afterwards: a 1024px forest texture covering 2.5
 * metres, baked at 32 pixels per metre, is squeezed into 80 pixels. A
 * THIRTEENFOLD downsample, before the frame is drawn. The ground looked poor
 * because 99% of it had been thrown away at paint time.
 *
 * So the painted image carries WEIGHTS, not colours. The shader samples each
 * material's own texture, tiled in world space at its own scale, and mixes
 * them by weight — the blend stays soft and the detail is whatever the art has.
 */

/**
 * ⚠ THREE weights per mask, not four, and the reason is a canvas trap.
 *
 * An RGBA mask looks like four weight channels. It is not: a 2D canvas stores
 * premultiplied pixels, so a weight written into ALPHA reads back as zero for
 * red, green and blue. The first cut painted happily and measured an entirely
 * empty mask — nothing on screen, no error, every channel zero.
 *
 * ⚠ ALPHA CARRIES NOTHING, and that is a correction to D-587 rather than a
 * simplification of it. D-587 made alpha the coverage, derived as the largest
 * weight in its own mask — which put a SMALL NUMBER in alpha exactly where the
 * weights were small, and premultiplication is lossy in proportion to how small
 * alpha is. Measured in the browser, writing and reading one canvas:
 *
 *     wrote 255,128, 64,255  ->  read 255,128, 64,255   lossless
 *     wrote 100, 50,  0,100  ->  read  99, 51,  0,100   ±1
 *     wrote  10,  0,  0, 10  ->  read   0,  0,  0, 10   GONE
 *     wrote   3,  0,  0,  3  ->  read   0,  0,  0,  3   GONE
 *
 * The soft rim of every stroke is where the weights are smallest, so the blend
 * between two materials — the thing the brush exists for — was being eaten on
 * the next read, the next save and every reload. It did not look like a bug:
 * it looked like a slightly harder edge.
 *
 * So alpha is 255 wherever anything is painted and 0 where nothing is, which
 * are the two values a premultiplied store round-trips exactly, and COVERAGE
 * is computed in the shader from the weights themselves.
 */
export const WEIGHTS_PER_MASK = GROUND_WEIGHTS_PER_MASK;

/**
 * ⚠ TWO masks, for six materials (D-588).
 *
 * Three was one mask's worth and it ran out immediately: a town is grass, dirt
 * and cobble before anybody has laid a gravel yard or a patch of mud. The cost
 * of the second is one more texture fetch per fragment, which is the cheapest
 * thing in this shader.
 */
export const SPLAT_MASKS = GROUND_MASKS;
export const SPLAT_CHANNELS = WEIGHTS_PER_MASK * SPLAT_MASKS;

/** How many pixels of MASK per world metre. */
export const SPLAT_PIXELS_PER_METRE = 16;

export interface SplatLayer {
  material: GroundMaterial;
  texture: THREE.Texture | null;
}

/** Which mask, and which of its three weight channels, a layer lives in. */
export function channelOf(index: number): { mask: number; channel: number } {
  return { mask: Math.floor(index / WEIGHTS_PER_MASK), channel: index % WEIGHTS_PER_MASK };
}

/**
 * Alpha for a texel, given its three weights: opaque if anything is painted
 * there, transparent if nothing is.
 *
 * ⚠ BINARY, and never the weights themselves — see `WEIGHTS_PER_MASK` for the
 * measurement. 0 and 255 are the two values a premultiplied canvas round-trips
 * exactly. How much of a texel is covered is worked out in the shader from the
 * weights, which is both lossless and a better edge.
 */
export function coverageByte(r: number, g: number, b: number): number {
  return r > 0 || g > 0 || b > 0 ? 255 : 0;
}

/**
 * Take channel `index` out of the masks and slide every later channel down
 * into the gap, weights and all (D-588).
 *
 * Mutates `masks` in place. Each entry is one mask's RGBA bytes.
 *
 * ⚠ PURE, and separate from the canvas, because this is the half that cannot
 * be judged by looking. A compaction that moves the materials but not their
 * weights renders a perfectly plausible map with the wrong surfaces on it —
 * grass where the gravel was — and nothing about the picture says so. The
 * canvas work around it (read, write, repaint) is the part a browser check can
 * see; this is the part only arithmetic can.
 *
 * ⚠ Every mask is READ before any is written. Channel 3 lives in the second
 * mask and moves down into channel 2 in the FIRST one, so editing as it goes
 * would move half the map against an already-edited source.
 */
export function compactChannels(masks: Uint8ClampedArray[], index: number): void {
  if (masks.length === 0) return;
  const source = masks.map((m) => Uint8ClampedArray.from(m));
  const weightAt = (layer: number, texel: number): number => {
    if (layer >= SPLAT_CHANNELS) return 0;
    const { mask, channel } = channelOf(layer);
    return source[mask]?.[texel * 4 + channel] ?? 0;
  };
  const texels = masks[0]!.length / 4;
  for (let t = 0; t < texels; t++) {
    for (let layer = 0; layer < SPLAT_CHANNELS; layer++) {
      const { mask, channel } = channelOf(layer);
      const data = masks[mask];
      if (!data) continue;
      data[t * 4 + channel] = layer < index ? weightAt(layer, t) : weightAt(layer + 1, t);
    }
    for (const data of masks) {
      data[t * 4 + 3] = coverageByte(data[t * 4]!, data[t * 4 + 1]!, data[t * 4 + 2]!);
    }
  }
}

/**
 * Build the ground material.
 *
 * ⚠ `MeshStandardMaterial` with the blend injected, rather than a bare
 * `ShaderMaterial`. The ground has to take the scene's lights and shadows like
 * everything else; a hand-written shader would have to reimplement all of it
 * and would drift the first time the lighting changed.
 */
export function splatMaterial(
  masks: readonly THREE.Texture[],
  // ⚠ A channel may be EMPTY and still occupy its place: a material the
  // content no longer defines must not slide the ones after it down.
  layers: readonly (SplatLayer | null | undefined)[],
  area: { width: number; height: number },
): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    roughness: 1,
    metalness: 0,
    transparent: true,
  });

  const uniforms: Record<string, { value: unknown }> = {
    uMaskA: { value: masks[0] ?? null },
    uMaskB: { value: masks[1] ?? null },
    uSize: { value: new THREE.Vector2(area.width, area.height) },
    uRepeatA: {
      value: new THREE.Vector3(
        layers[0]?.material.repeat ?? 1,
        layers[1]?.material.repeat ?? 1,
        layers[2]?.material.repeat ?? 1,
      ),
    },
    uRepeatB: {
      value: new THREE.Vector3(
        layers[3]?.material.repeat ?? 1,
        layers[4]?.material.repeat ?? 1,
        layers[5]?.material.repeat ?? 1,
      ),
    },
    uHasA: {
      value: new THREE.Vector3(
        layers[0]?.texture ? 1 : 0, layers[1]?.texture ? 1 : 0, layers[2]?.texture ? 1 : 0,
      ),
    },
    uHasB: {
      value: new THREE.Vector3(
        layers[3]?.texture ? 1 : 0, layers[4]?.texture ? 1 : 0, layers[5]?.texture ? 1 : 0,
      ),
    },
  };
  for (let i = 0; i < SPLAT_CHANNELS; i++) {
    uniforms[`uTex${i}`] = { value: layers[i]?.texture ?? null };
    // ⚠ The TINT stands in for missing art and the WASH modifies art that is
    // there (D-590); a material with a texture is washed, never tinted. They
    // were one field, and since a material's tint is roughly its own texture's
    // average colour, every surface in the game was being multiplied by itself.
    const layer = layers[i];
    uniforms[`uTint${i}`] = {
      value: new THREE.Color(
        layer?.texture ? layer.material.wash ?? '#ffffff' : layer?.material.tint ?? '#ffffff',
      ),
    };
  }

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    const decls = Array.from(
      { length: SPLAT_CHANNELS },
      (_, i) => `uniform sampler2D uTex${i};\n         uniform vec3 uTint${i};`,
    ).join('\n         ');

    // ⚠ One line per material, UNROLLED. GLSL needs a constant index to sample
    // an array of samplers, so a loop over six textures does not compile on
    // the platforms this has to run on.
    const mix = Array.from({ length: SPLAT_CHANNELS }, (_, i) => {
      const first = i < WEIGHTS_PER_MASK;
      const w = first ? 'wa' : 'wb';
      const comp = ['x', 'y', 'z'][i % WEIGHTS_PER_MASK]!;
      const has = first ? 'uHasA' : 'uHasB';
      const rep = first ? 'uRepeatA' : 'uRepeatB';
      return `acc += (${has}.${comp} > 0.5 ? texture2D(uTex${i}, metres * ${rep}.${comp}).rgb`
        + ` : vec3(1.0)) * uTint${i} * ${w}.${comp};`;
    }).join('\n         ');

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform sampler2D uMaskA;
         uniform sampler2D uMaskB;
         uniform vec2 uSize;
         uniform vec3 uRepeatA;
         uniform vec3 uRepeatB;
         uniform vec3 uHasA;
         uniform vec3 uHasB;
         ${decls}`,
      )
      .replace(
        '#include <map_fragment>',
        `
         vec3 wa = texture2D(uMaskA, vMapUv).rgb;
         vec3 wb = texture2D(uMaskB, vMapUv).rgb;
         float total = wa.x + wa.y + wa.z + wb.x + wb.y + wb.z;
         // ⚠ Coverage comes from the WEIGHTS, not from alpha. Alpha is
         // deliberately blank (see WEIGHTS_PER_MASK) — and this is the better
         // answer anyway: the rim of a stroke carries a small total, so the
         // paint FADES into the bare ground under it instead of ending on a
         // rim that is faint and fully opaque.
         float cover = min(total, 1.0);
         if (total < 0.004) discard;

         // ⚠ World metres, not UVs. Each material tiles at its own scale, so
         // gravel stays gravel-sized beside grass rather than every material
         // being stretched to the same grid.
         vec2 metres = vMapUv * uSize;

         vec3 acc = vec3(0.0);
         ${mix}

         // Normalised by total weight, so overlapping strokes stay the right
         // brightness instead of blowing out where materials meet.
         diffuseColor.rgb = acc / max(total, 0.004);
         diffuseColor.a = cover;
        `,
      );
  };

  // ⚠ A mask has to be bound as `map`, or three never defines `vMapUv` and the
  // shader above will not compile. It is never sampled as a colour — the
  // injected code replaces that — but its presence turns the UV varying on.
  material.map = masks[0] ?? null;
  material.needsUpdate = true;
  return material;
}

/** A material's texture, tiled, at full resolution. */
export function loadLayerTexture(url: string): THREE.Texture {
  const tex = new THREE.TextureLoader().load(url);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  // ⚠ Mipmapped and anisotropic: ground runs away from an isometric camera to
  // the horizon, and a tiled texture without mipmaps shimmers violently at
  // distance — the artefact that reads as the renderer being broken.
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  return tex;
}
