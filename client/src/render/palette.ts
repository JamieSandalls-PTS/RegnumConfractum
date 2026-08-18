import * as THREE from 'three';

/**
 * Palette quantisation post-process (D-404) — the art direction. Render the
 * scene small, apply exposure/vignette/contrast, dither, snap to a ~24-colour
 * palette, upscale nearest-neighbour. Retuning the world's mood is an edit to
 * PALETTE, not an asset job.
 *
 * Ordering lesson (cost a debugging cycle in the prototype): exposure and
 * vignette must run BEFORE quantisation — after, they push colours off the
 * palette and undo the effect.
 */

export const PALETTE = [
  // warm-neutral ramp — carries stone, cloth and most of the frame
  0x0a090b, 0x141317, 0x1f1d21, 0x2b282d, 0x38343a,
  0x474248, 0x575058, 0x685f66, 0x7a7077, 0x8d8288, 0xa0959a,
  // cold shadow
  0x1a2028, 0x252f3a, 0x33404e,
  // firelight ramp
  0x4d3320, 0x744d2a, 0x9c6733, 0xc2853f, 0xe0a85c, 0xf2cd8f,
  // skin
  0x8a6a52, 0xb08a68,
  // warm mid-greys so stone has somewhere to land
  0x4a443e, 0x5c554d,
  // daylight extension (D-504): brighter but still desaturated, so overcast
  // exteriors have somewhere to land without breaking D-308's restraint
  0xb3ab9d, 0xc7bfae, 0x8fa3b0, 0x66735c,
];

export class PixelPost {
  pixelScale = 4;
  /** Split mode: the WORLD's own pixel scale (1 = crisp). */
  envPixelScale = 1;
  /** Verification switch (D-114): off reproduces the pre-fix flat overlay,
   * so an automated check can A/B the split pass's occlusion. */
  depthOcclusion = true;
  readonly renderTarget: THREE.WebGLRenderTarget;
  private envTarget: THREE.WebGLRenderTarget;
  private material: THREE.ShaderMaterial;
  private postScene = new THREE.Scene();
  private postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  internalWidth = 320;
  internalHeight = 200;
  private lastW = 320;
  private lastH = 200;

  constructor() {
    // Both split passes carry a DEPTH texture. Without them the character
    // layer composited as a flat overlay and floated in front of every
    // chair and wall regardless of where it stood (stakeholder, 2026-08-18):
    // separate passes mean separate depth buffers, so occlusion has to be
    // resolved in the composite shader instead.
    const depthTex = (w: number, h: number): THREE.DepthTexture => {
      const d = new THREE.DepthTexture(w, h);
      d.type = THREE.UnsignedIntType;
      d.minFilter = THREE.NearestFilter;
      d.magFilter = THREE.NearestFilter;
      return d;
    };
    this.renderTarget = new THREE.WebGLRenderTarget(320, 200, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthTexture: depthTex(320, 200),
    });
    this.envTarget = new THREE.WebGLRenderTarget(320, 200, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthTexture: depthTex(320, 200),
    });

    const palArray = new Float32Array(PALETTE.length * 3);
    PALETTE.forEach((hex, i) => {
      palArray[i * 3] = ((hex >> 16) & 255) / 255;
      palArray[i * 3 + 1] = ((hex >> 8) & 255) / 255;
      palArray[i * 3 + 2] = (hex & 255) / 255;
    });

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: this.renderTarget.texture },
        uPalette: { value: palArray },
        uRes: { value: new THREE.Vector2(320, 200) },
        /** 1 = compositing a transparent character layer over a crisp
         * environment (split mode): alpha-test edges, skip the vignette. */
        uComposite: { value: 0 },
        /** 0 = keep true colours (no palette snap, no dither). */
        uQuantize: { value: 1 },
        /** Depth of each split pass, for occlusion in the composite. */
        tCharDepth: { value: null },
        tEnvDepth: { value: null },
        /** 1 = discard character pixels that lie behind the environment. */
        uDepthTest: { value: 0 },
        /** 1 = blit the source untouched (the crisp-environment pass, which
         * must look exactly as it did when drawn straight to the screen). */
        uPassthrough: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D tDiffuse;
        uniform vec3 uPalette[${PALETTE.length}];
        uniform vec2 uRes;

        float bayer(vec2 p) {
          int x = int(mod(p.x, 4.0));
          int y = int(mod(p.y, 4.0));
          int i = y * 4 + x;
          float m[16];
          m[0]=0.0;  m[1]=8.0;  m[2]=2.0;  m[3]=10.0;
          m[4]=12.0; m[5]=4.0;  m[6]=14.0; m[7]=6.0;
          m[8]=3.0;  m[9]=11.0; m[10]=1.0; m[11]=9.0;
          m[12]=15.0;m[13]=7.0; m[14]=13.0;m[15]=5.0;
          for (int k = 0; k < 16; k++) { if (k == i) return m[k] / 16.0 - 0.5; }
          return 0.0;
        }

        uniform int uComposite;
        uniform int uQuantize;
        uniform sampler2D tCharDepth;
        uniform sampler2D tEnvDepth;
        uniform int uDepthTest;
        uniform int uPassthrough;

        void main() {
          vec4 t = texture2D(tDiffuse, vUv);
          if (uPassthrough == 1) { gl_FragColor = vec4(t.rgb, 1.0); return; }
          if (uComposite == 1 && t.a < 0.4) discard;
          // Occlusion between the two split passes. Both were drawn with the
          // same camera and projection, so their depth values are directly
          // comparable: a character fragment further away than whatever the
          // environment drew at that pixel is BEHIND it and must not show.
          if (uComposite == 1 && uDepthTest == 1) {
            float charZ = texture2D(tCharDepth, vUv).x;
            float envZ = texture2D(tEnvDepth, vUv).x;
            if (charZ >= envZ) discard;
          }
          vec3 c = t.rgb;
          vec2 px = vUv * uRes;

          // exposure + vignette FIRST (see module comment)
          c *= 1.18;
          if (uComposite == 0) {
            vec2 q = vUv - 0.5;
            c *= 1.0 - dot(q, q) * 0.26;
          }
          c = clamp((c - 0.5) * 1.12 + 0.5, 0.0, 1.0);

          vec3 bc = c;
          if (uQuantize == 1) {
            c += bayer(px) * 0.030;
            float best = 1e9;
            for (int i = 0; i < ${PALETTE.length}; i++) {
              vec3 d = uPalette[i] - c;
              // perceptual-ish weighting keeps skin off the blues
              float dist = d.r*d.r*0.50 + d.g*d.g*0.58 + d.b*d.b*0.42;
              if (dist < best) { best = dist; bc = uPalette[i]; }
            }
          }
          gl_FragColor = vec4(bc, 1.0);
        }
      `,
    });

    this.postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material));
  }

  /** Call on resize with the CSS pixel size of the stage. */
  setSize(width: number, height: number): void {
    this.lastW = width;
    this.lastH = height;
    this.internalWidth = Math.max(80, Math.floor(width / this.pixelScale));
    this.internalHeight = Math.max(60, Math.floor(height / this.pixelScale));
    this.renderTarget.setSize(this.internalWidth, this.internalHeight);
    this.envTarget.setSize(
      Math.max(80, Math.floor(width / this.envPixelScale)),
      Math.max(60, Math.floor(height / this.envPixelScale)),
    );
    (this.material.uniforms.uRes!.value as THREE.Vector2).set(this.internalWidth, this.internalHeight);
    this.material.uniforms.tDiffuse!.value = this.renderTarget.texture;
  }

  // (The round-11 character-shader A/B — posterize/soft/plain — is gone:
  // the stakeholder ruled palette pixelation IS the direction, 2026-08-17.)

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    this.material.uniforms.uComposite!.value = 0;
    renderer.setRenderTarget(this.renderTarget);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.render(this.postScene, this.postCamera);
  }

  /**
   * Split mode (stakeholder request): the ENVIRONMENT renders crisp at full
   * resolution; only CHARACTER-layer objects (layer 1) go through the
   * low-res palette quantiser, composited on top with alpha.
   */
  renderSplit(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    /** Palette-snap the world too? Its pixel size follows envPixelScale. */
    envPalette = false,
  ): void {
    const cam = camera as THREE.OrthographicCamera;
    const u = this.material.uniforms;
    // Pass 1: environment, at its OWN pixel scale and palette choice. It
    // ALWAYS goes to a render target, even when crisp and unquantised —
    // the composite needs its depth buffer to occlude characters, and a
    // direct-to-screen pass has no depth texture to sample.
    cam.layers.set(0);
    renderer.setRenderTarget(this.envTarget);
    renderer.render(scene, cam);
    u.tDiffuse!.value = this.envTarget.texture;
    (u.uRes!.value as THREE.Vector2).set(
      Math.max(80, Math.floor(this.lastW / this.envPixelScale)),
      Math.max(60, Math.floor(this.lastH / this.envPixelScale)),
    );
    u.uComposite!.value = 0;
    u.uQuantize!.value = envPalette ? 1 : 0;
    // Crisp-and-unquantised blits straight through, so turning the palette
    // off leaves the world exactly as a direct render looked.
    u.uPassthrough!.value = envPalette ? 0 : 1;
    renderer.setRenderTarget(null);
    renderer.render(this.postScene, this.postCamera);
    u.uPassthrough!.value = 0;
    u.tDiffuse!.value = this.renderTarget.texture;
    (u.uRes!.value as THREE.Vector2).set(this.internalWidth, this.internalHeight);
    u.uQuantize!.value = 1;

    // Pass 2: characters to the low-res target with a transparent clear.
    cam.layers.set(1);
    const bg = scene.background;
    scene.background = null;
    renderer.setRenderTarget(this.renderTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, cam);
    scene.background = bg;

    // Composite: quantised characters over the crisp environment, with the
    // depth test that keeps them BEHIND the furniture they stand behind.
    u.uComposite!.value = 1;
    u.uDepthTest!.value = this.depthOcclusion ? 1 : 0;
    u.tCharDepth!.value = this.renderTarget.depthTexture;
    u.tEnvDepth!.value = this.envTarget.depthTexture;
    this.material.transparent = true;
    renderer.setRenderTarget(null);
    const auto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clearDepth(); // the env pass's depth buffer must not occlude the quad
    renderer.render(this.postScene, this.postCamera);
    renderer.autoClear = auto;
    this.material.transparent = false;
    u.uDepthTest!.value = 0;
    cam.layers.enableAll();
  }
}
