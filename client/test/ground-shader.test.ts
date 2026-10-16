import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { GroundMaterialSchema } from '@rc/shared';
import { splatMaterial } from '../src/render/ground-splat';

/**
 * The ground shader's own source, read without a GPU (D-648).
 *
 * ⚠ D-642 named a GLSL parameter `patch`. It is a reserved word in WebGL 2's
 * shading language (GLSL ES 3.00), the browser refused to compile the shader,
 * and every painted floor in the game drew NOTHING — while every test passed,
 * because nothing headless ever looked at the text the shader is built from.
 * This builds the material, runs the injection three.js would run, and checks
 * every identifier in the result against the reserved list.
 */

/** GLSL ES 3.00 §3.7 reserved words, plus the ones WebGL 2 drivers also refuse. */
const RESERVED = new Set([
  'attribute', 'varying', 'coherent', 'volatile', 'restrict', 'readonly', 'writeonly',
  'resource', 'atomic_uint', 'noperspective', 'patch', 'sample', 'subroutine', 'common',
  'partition', 'active', 'asm', 'class', 'union', 'enum', 'typedef', 'template', 'this',
  'goto', 'inline', 'noinline', 'public', 'static', 'extern', 'external', 'interface',
  'long', 'short', 'double', 'half', 'fixed', 'unsigned', 'superp', 'input', 'output',
  'hvec2', 'hvec3', 'hvec4', 'dvec2', 'dvec3', 'dvec4', 'fvec2', 'fvec3', 'fvec4',
  'sampler3DRect', 'filter', 'sizeof', 'cast', 'namespace', 'using', 'image1D', 'image2D',
  'image3D', 'imageCube', 'iimage1D', 'iimage2D', 'iimage3D', 'iimageCube', 'uimage1D',
  'uimage2D', 'uimage3D', 'uimageCube', 'image1DArray', 'image2DArray', 'iimage1DArray',
  'iimage2DArray', 'uimage1DArray', 'uimage2DArray', 'imageBuffer', 'iimageBuffer',
  'uimageBuffer', 'sampler1D', 'sampler1DShadow', 'sampler1DArray', 'sampler1DArrayShadow',
  'isampler1D', 'isampler1DArray', 'usampler1D', 'usampler1DArray', 'sampler2DRect',
  'sampler2DRectShadow', 'isampler2DRect', 'usampler2DRect', 'samplerBuffer',
  'isamplerBuffer', 'usamplerBuffer', 'sampler2DMS', 'isampler2DMS', 'usampler2DMS',
  'sampler2DMSArray', 'isampler2DMSArray', 'usampler2DMSArray', 'buffer', 'shared',
]);

/** The fragment shader three.js would compile, with our injection applied. */
function injectedFragment(): string {
  const mat = GroundMaterialSchema.parse({
    id: 'mud', name: 'Mud', texture: 'mud.png',
    // Variation ON, so the varied sampling path is in the source.
    variation: { rotate: 1, zoom: 0.3, patch: 5 },
  });
  const layers = Array.from({ length: 6 }, () => ({ material: mat, texture: new THREE.Texture() }));
  const material = splatMaterial([new THREE.Texture(), new THREE.Texture()], layers, { width: 8, height: 8 });
  const shader = {
    uniforms: {} as Record<string, unknown>,
    vertexShader: '',
    fragmentShader: '#include <common>\nvoid main() {\n#include <map_fragment>\n}',
  };
  material.onBeforeCompile(shader as never, undefined as never);
  return shader.fragmentShader;
}

describe('the ground shader (D-648)', () => {
  it('⚠ declares nothing the shading language reserves', () => {
    const src = injectedFragment()
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    const used = new Set(src.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);
    const clashes = [...used].filter((w) => RESERVED.has(w) && w !== 'common');
    expect(clashes, 'reserved words in the injected GLSL').toEqual([]);
  });

  it('carries the varied sampling path and every uniform it reads', () => {
    const src = injectedFragment();
    expect(src).toContain('sampleVaried(');
    for (const u of ['uRotA', 'uZoomA', 'uPatchA', 'uMaskA', 'uTex5']) expect(src, u).toContain(u);
  });
});
