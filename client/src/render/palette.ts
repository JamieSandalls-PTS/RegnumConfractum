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
];

export class PixelPost {
  pixelScale = 4;
  readonly renderTarget: THREE.WebGLRenderTarget;
  private material: THREE.ShaderMaterial;
  private postScene = new THREE.Scene();
  private postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  internalWidth = 320;
  internalHeight = 200;

  constructor() {
    this.renderTarget = new THREE.WebGLRenderTarget(320, 200, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
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

        void main() {
          vec3 c = texture2D(tDiffuse, vUv).rgb;
          vec2 px = vUv * uRes;

          // exposure + vignette FIRST (see module comment)
          c *= 1.18;
          vec2 q = vUv - 0.5;
          c *= 1.0 - dot(q, q) * 0.26;
          c = clamp((c - 0.5) * 1.12 + 0.5, 0.0, 1.0);

          c += bayer(px) * 0.030;

          float best = 1e9;
          vec3 bc = c;
          for (int i = 0; i < ${PALETTE.length}; i++) {
            vec3 d = uPalette[i] - c;
            // perceptual-ish weighting keeps skin off the blues
            float dist = d.r*d.r*0.50 + d.g*d.g*0.58 + d.b*d.b*0.42;
            if (dist < best) { best = dist; bc = uPalette[i]; }
          }
          gl_FragColor = vec4(bc, 1.0);
        }
      `,
    });

    this.postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material));
  }

  /** Call on resize with the CSS pixel size of the stage. */
  setSize(width: number, height: number): void {
    this.internalWidth = Math.max(80, Math.floor(width / this.pixelScale));
    this.internalHeight = Math.max(60, Math.floor(height / this.pixelScale));
    this.renderTarget.setSize(this.internalWidth, this.internalHeight);
    (this.material.uniforms.uRes!.value as THREE.Vector2).set(this.internalWidth, this.internalHeight);
    this.material.uniforms.tDiffuse!.value = this.renderTarget.texture;
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    renderer.setRenderTarget(this.renderTarget);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.render(this.postScene, this.postCamera);
  }
}
