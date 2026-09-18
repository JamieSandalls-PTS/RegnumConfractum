import * as THREE from 'three';
import type { LightingProfile } from '@rc/shared';

/**
 * Scene shell (D-401): orthographic camera at an isometric angle, physical
 * light units (r155+: key ~4-5, not ~1), fog starting beyond the camera
 * orbit distance — both prototype lessons, see CLAUDE.md rendering notes.
 */

const FRUSTUM = 5.2; // vertical half-extent in world units (1 unit = 1 tile)
/** Orbit geometry: fixed elevation, user-controlled azimuth. The horizontal
 * radius and height keep |offset| ≈ 15.3 regardless of azimuth, so the
 * fog-vs-camera-distance contract holds at every rotation. */
const ORBIT_RADIUS = Math.hypot(9, 9);
const ORBIT_HEIGHT = 8.5;
const DEFAULT_AZIMUTH = Math.PI / 4; // reproduces the original (9, 8.5, 9)
const ZOOM_MIN = 0.55; // tighter than this and heads leave the frame
const ZOOM_MAX = 2.2;

/**
 * Per-area lighting profiles (D-504, feeding D-305). The stakeholder's
 * ruling: the dark look suits enclosed spaces; outdoors must read brighter
 * and more colourful. Time-of-day and weather will modulate these later.
 */
interface LightingParams {
  background: number;
  fogNear: number;
  fogFar: number;
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  keyColor: number;
  keyIntensity: number;
  rimColor: number;
  rimIntensity: number;
}

const LIGHTING: Record<LightingProfile, LightingParams> = {
  overcast: {
    background: 0x2a2f38, fogNear: 26, fogFar: 54,
    hemiSky: 0xbccbdb, hemiGround: 0x6a5c4a, hemiIntensity: 5.6,
    keyColor: 0xfff2dd, keyIntensity: 6.2,
    rimColor: 0x9db8d2, rimIntensity: 2.2,
  },
  interior: {
    background: 0x16130f, fogNear: 24, fogFar: 48,
    hemiSky: 0xa8a49c, hemiGround: 0x5c4936, hemiIntensity: 4.8,
    keyColor: 0xffe4b8, keyIntensity: 5.6,
    rimColor: 0x8fb8d8, rimIntensity: 1.6,
  },
  underground: {
    background: 0x0c0b10, fogNear: 24, fogFar: 48,
    hemiSky: 0x9cc0dd, hemiGround: 0x40332a, hemiIntensity: 2.9,
    keyColor: 0xffeed2, keyIntensity: 4.6,
    rimColor: 0x8fb8d8, rimIntensity: 1.5,
  },
  night: {
    background: 0x0a0c14, fogNear: 24, fogFar: 46,
    hemiSky: 0x36485e, hemiGround: 0x1e1813, hemiIntensity: 2.0,
    keyColor: 0xa8c0e0, keyIntensity: 2.4,
    rimColor: 0x4a5f78, rimIntensity: 1.2,
  },
};


/**
 * The veil the dead see through (D-621).
 *
 * The stakeholder asked for the map and the characters to look "ethereal,
 * grayscale" while dead. It is a full-screen pass rather than a material swap
 * for one reason: a ghost has to see the WORLD change, not their own body, and
 * there is no per-object edit that reaches painted ground, instanced terrain,
 * placed meshes, effects and people alike.
 *
 * ⚠ Grayscale is the floor and not the whole of it. A straight desaturate
 * reads as a broken screenshot; what reads as a different plane is desaturate
 * plus LIFTED blacks (the dark stops hiding anything, so the world looks
 * washed out rather than dim), a cold tint weighted into the shadows, and a
 * vignette that closes the edges in. All four together, and none of them
 * alone.
 *
 * ⚠ It never reaches the server, and it reveals nothing. Every delivery
 * path already partitions the planes both ways (invariant 4, D-203); this is
 * paint on what a ghost was ALREADY sent.
 */
const VEIL_VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const VEIL_FRAG = `
uniform sampler2D tDiffuse;
uniform float amount;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tDiffuse, vUv).rgb;
  // Rec. 601 luma. The green weight is what stops foliage going black and
  // skin going white, which is what an unweighted average does.
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  // Lift the blacks. A ghost's world is PALE, not dark -- darkening it would
  // read as the lights going out, which is a different feeling entirely.
  float lifted = pow(l, 0.72) * 0.86 + 0.14;
  // Cold, and coldest in the shadows: a uniform blue cast looks like a filter,
  // a gradient looks like light behaving differently.
  vec3 tint = mix(vec3(0.78, 0.86, 1.04), vec3(1.0), l);
  vec3 ethereal = vec3(lifted) * tint;
  // The edges close in. Centred on the screen rather than on the player,
  // because the camera keeps the player near the middle and a vignette that
  // tracks a body reads as a spotlight.
  vec2 d = vUv - 0.5;
  float vignette = 1.0 - smoothstep(0.34, 0.78, dot(d, d) * 2.0) * 0.55;
  ethereal *= vignette;
  gl_FragColor = vec4(mix(c, ethereal, amount), 1.0);
  // ⚠ The output has to be ENCODED, and the input decoded, or the veil is
  // a gamma shift as well as a desaturation. Measured before this line
  // existed: an orange box read (204,68,34) alive and (90,97,112) dead, where
  // the arithmetic says about (133,141,153) -- every veiled pixel was a third
  // too dark, because a raw ShaderMaterial writes whatever it is given and
  // the canvas expects sRGB. The render target is sRGB (so the world pass
  // encodes into it), sampling decodes, and this re-encodes.
  #include <colorspace_fragment>
}
`;

/** How long the veil takes to close or lift, in seconds. */
export const VEIL_FADE = 1.1;

/**
 * One frame of the veil easing (D-621).
 *
 * Pure and exported so the timing is testable without a GPU. The shader is
 * not, and saying so is better than an assertion that only proves a uniform
 * was written.
 *
 * ⚠ Linear over about a second, not a spring and not a cut. Dying is the
 * moment the whole screen changes; a hard cut reads as a graphics glitch,
 * which is the wrong reading for the one event a player most needs to
 * understand. It must also ARRIVE -- an exponential ease approaches 1 and
 * never reaches it, so the cheap `veil <= 0.001` fast path for the living
 * would never come back on after a respawn.
 */
export function easeVeil(current: number, target: number, dt: number): number {
  const step = Math.max(0, dt) / VEIL_FADE;
  if (current < target) return Math.min(target, current + step);
  return Math.max(target, current - step);
}

export class GameScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.OrthographicCamera;
  private key: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private rim: THREE.DirectionalLight;
  private focus = new THREE.Vector3();
  /** User camera state: azimuth orbits smoothly toward its target; zoom
   * scales the ortho frustum (distance never changes — fog stays safe). */
  private azimuth = DEFAULT_AZIMUTH;
  private azimuthTarget = DEFAULT_AZIMUTH;
  private zoom = 1;
  private zoomTarget = 1;
  /**
   * The ethereal pass (D-621). Built on FIRST USE, never at boot.
   *
   * ⚠ A render target is a full-screen buffer; allocating one for every
   * living player so that the dead need not wait is the wrong trade. Nothing
   * exists until somebody dies, and `render()` goes straight to the canvas
   * while `veil` is zero -- so the living pay nothing at all, not even a
   * blit.
   */
  private veilTarget: THREE.WebGLRenderTarget | null = null;
  private veilMaterial: THREE.ShaderMaterial | null = null;
  private veilScene: THREE.Scene | null = null;
  private veilCamera = new THREE.Camera();
  /** Where the veil is now, and where it is going. Eased, never snapped. */
  private veil = 0;
  private veilTarget01 = 0;

  constructor(private stage: HTMLElement) {
    // ⚠ Antialiased, at the device's own pixel density (D-636). D-586 took
    // the quantiser out and left `setPixelRatio(1)` and `antialias: false`
    // behind, both of which only made sense while a 320x200 buffer was being
    // upscaled anyway. On a 150% display that drew the world at two thirds
    // of the screen's resolution and stretched it, which the stakeholder read
    // as the pixelation having survived.
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    stage.appendChild(this.renderer.domElement);

    // Camera orbits at ~15.3 units and the visible play field extends ~13
    // units beyond the focus at this frustum — fog must start past their sum
    // or the far half of the yard washes to background (the prototype's
    // fog-vs-camera-distance lesson, rediscovered at game frustum size).
    this.scene.fog = new THREE.Fog(0x0c0b10, 24, 48);

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);

    // cold ambient + warm key + cool rim — tuned in the prototype
    this.hemi = new THREE.HemisphereLight(0x9cc0dd, 0x40332a, 2.9);
    this.scene.add(this.hemi);
    this.key = new THREE.DirectionalLight(0xffeed2, 4.6);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    this.key.shadow.bias = -0.0015;
    const sc = this.key.shadow.camera;
    sc.left = -10; sc.right = 10; sc.top = 10; sc.bottom = -10; sc.near = 1; sc.far = 40;
    this.scene.add(this.key);
    this.scene.add(this.key.target);
    this.rim = new THREE.DirectionalLight(0x8fb8d8, 1.5);
    this.rim.position.set(-7, 4, -6);
    this.scene.add(this.rim);
    this.applyLighting('underground');

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  applyLighting(profile: LightingProfile): void {
    const p = LIGHTING[profile];
    this.scene.background = new THREE.Color(p.background);
    this.scene.fog = new THREE.Fog(p.background, p.fogNear, p.fogFar);
    this.hemi.color.setHex(p.hemiSky);
    this.hemi.groundColor.setHex(p.hemiGround);
    this.hemi.intensity = p.hemiIntensity;
    this.key.color.setHex(p.keyColor);
    this.key.intensity = p.keyIntensity;
    this.rim.color.setHex(p.rimColor);
    this.rim.intensity = p.rimIntensity;
  }

  resize(): void {
    const w = this.stage.clientWidth || window.innerWidth;
    const h = this.stage.clientHeight || window.innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false);
    this.applyFrustum();
  }

  private applyFrustum(): void {
    // ⚠ The REAL viewport's aspect (D-586). This used to be the quantiser's
    // fixed 320x200 internal buffer, which was right while every frame was
    // rendered into that buffer and upscaled — and is a stretched world now
    // that the scene draws straight to the canvas.
    const w = this.stage.clientWidth || window.innerWidth;
    const h = this.stage.clientHeight || window.innerHeight;
    const aspect = h > 0 ? w / h : 1.6;
    const f = FRUSTUM * this.zoom;
    this.camera.left = -f * aspect;
    this.camera.right = f * aspect;
    this.camera.top = f;
    this.camera.bottom = -f;
    this.camera.updateProjectionMatrix();
  }

  /** Rotate the orbit by a screen-drag delta (radians). */
  rotateBy(delta: number): void {
    this.azimuthTarget += delta;
  }

  /** The orbit's current angle. Sound placement needs it: panning is
   * relative to where the camera is looking, not to the world axes. */
  get azimuthAngle(): number {
    return this.azimuth;
  }

  /** Jump the orbit to an exact angle (viewer/automation use). */
  setAzimuth(angle: number): void {
    this.azimuth = angle;
    this.azimuthTarget = angle;
  }

  /** Jump zoom to an exact factor (viewer/automation use). Allows tighter
   * close-ups than the in-game wheel clamp — zoomBy() keeps the game limit. */
  setZoom(zoom: number): void {
    this.zoom = Math.min(this.zoomCeiling, Math.max(0.02, zoom)); // near-macro for the editor
    this.zoomTarget = this.zoom;
    this.applyFrustum();
  }

  /** Viewer-only: override orbit elevation for near-eye-level model review.
   * Keeps |offset| under the fog near plane; the game never calls this. */
  private orbitHeight = ORBIT_HEIGHT;
  setOrbitHeight(h: number): void {
    this.orbitHeight = h;
  }

  /**
   * How far out the wheel may go. The GAME's limit is deliberate — pulling
   * the camera back is scouting, and D-217's witness model assumes you see
   * about as far as you are — but a map editor has no such stake and needs
   * the whole area on screen. Only tools raise it.
   */
  private zoomCeiling = ZOOM_MAX;

  raiseZoomCeiling(max: number): void {
    this.zoomCeiling = Math.max(ZOOM_MAX, max);
  }

  /** Multiplicative zoom (wheel): > 1 zooms out, < 1 zooms in. */
  zoomBy(factor: number): void {
    this.zoomTarget = Math.min(this.zoomCeiling, Math.max(ZOOM_MIN, this.zoomTarget * factor));
  }

  /** Current azimuth — picking needs it to unproject cursor rays. */
  get cameraAzimuth(): number {
    return this.azimuth;
  }

  /**
   * Where a world-XZ direction points ON SCREEN: +x right, +y up, in camera
   * space (D-548). The compass needs it.
   *
   * Asking the camera rather than re-deriving it from the azimuth is the
   * whole point. Working the angle out by hand means re-deciding which axis
   * is screen-right and whether tile y runs north or south, and getting that
   * subtly wrong yields a compass that is correct at one rotation and
   * mirrored at another — a bug that survives every screenshot taken from the
   * default angle.
   */
  screenDirection(dx: number, dz: number): { x: number; y: number } {
    const v = new THREE.Vector3(dx, 0, dz);
    this.camera.updateMatrixWorld();
    v.transformDirection(this.camera.matrixWorldInverse);
    return { x: v.x, y: v.y };
  }

  /** Eases azimuth/zoom toward their targets; call once per frame. */
  updateCamera(dt: number): void {
    const k = Math.min(1, dt * 10);
    this.azimuth += (this.azimuthTarget - this.azimuth) * k;
    const prevZoom = this.zoom;
    this.zoom += (this.zoomTarget - this.zoom) * k;
    if (Math.abs(this.zoom - prevZoom) > 1e-4) this.applyFrustum();
    // ⚠ The veil eases on the same frame clock as the camera (D-621), so
    // there is one place per frame that advances presentation and no second
    // timer to fall out of step with it.
    this.stepVeil(dt);
  }

  /** Follows a world point: camera, look-at, and the shadow frustum together. */
  follow(point: THREE.Vector3): void {
    this.focus.copy(point);
    this.camera.position.set(
      point.x + Math.cos(this.azimuth) * ORBIT_RADIUS,
      point.y + this.orbitHeight,
      point.z + Math.sin(this.azimuth) * ORBIT_RADIUS,
    );
    this.camera.lookAt(point.x, point.y + 0.9, point.z);
    this.key.position.set(point.x + 8, point.y + 6.5, point.z + 5);
    this.key.target.position.copy(point);
  }

  /**
   * Draw the world (D-586).
   *
   * ⚠ Straight to the canvas at full resolution. This used to go through a
   * palette quantiser — render small, dither, snap to 24 colours, upscale
   * nearest-neighbour — which was the ratified art direction from D-401 and
   * was removed at the stakeholder's request.
   */
  render(): void {
    // ⚠ The camera has to see EVERY layer. Characters and effects sit on
    // layer 1 because the old split pass drew them separately, and a single
    // pass with a default camera would render a world with nobody in it.
    this.camera.layers.enableAll();
    if (this.veil <= 0.001) {
      // The living path, unchanged: straight to the canvas, no buffer, no
      // second draw.
      this.renderer.render(this.scene, this.camera);
      return;
    }
    const pass = this.ensureVeil();
    this.renderer.setRenderTarget(pass.target);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);
    pass.material.uniforms.amount!.value = this.veil;
    this.renderer.render(pass.scene, this.veilCamera);
  }

  /**
   * Turns the veil on or off (D-621).
   *
   * ⚠ Eased over about a second rather than switched. Dying is the moment
   * the whole screen changes, and a hard cut reads as a graphics glitch --
   * which is exactly the wrong reading for the one event the player most
   * needs to understand. `update` does the easing, so it costs nothing while
   * nobody is dead.
   */
  setVeiled(veiled: boolean): void {
    this.veilTarget01 = veiled ? 1 : 0;
  }

  /** Where the veil is, 0..1. Verification only (D-621). */
  get veilAmount(): number {
    return this.veil;
  }

  private stepVeil(dt: number): void {
    if (this.veil === this.veilTarget01) return;
    this.veil = easeVeil(this.veil, this.veilTarget01, dt);
  }

  private ensureVeil(): {
    target: THREE.WebGLRenderTarget;
    material: THREE.ShaderMaterial;
    scene: THREE.Scene;
  } {
    // ⚠ The DRAWING buffer's size, not the CSS size: with a pixel ratio
    // above one the two differ, and a veil target at CSS size would draw
    // the dead a blurred world at a resolution the living never see.
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    if (!this.veilTarget) {
      this.veilTarget = new THREE.WebGLRenderTarget(
        Math.max(1, size.x),
        Math.max(1, size.y),
        // ⚠ Depth is REQUIRED. Without a depth buffer the world draws in
        // submission order and the terrain lands on top of the people -- a
        // failure that only appears once somebody dies, which is the worst
        // time to find it.
        { depthBuffer: true, stencilBuffer: false },
      );
      // ⚠ The world pass writes ENCODED pixels into it, exactly as it would
      // to the canvas. See the note in the fragment shader.
      this.veilTarget.texture.colorSpace = THREE.SRGBColorSpace;
    } else if (this.veilTarget.width !== size.x || this.veilTarget.height !== size.y) {
      this.veilTarget.setSize(Math.max(1, size.x), Math.max(1, size.y));
    }
    if (!this.veilMaterial || !this.veilScene) {
      this.veilMaterial = new THREE.ShaderMaterial({
        uniforms: {
          tDiffuse: { value: this.veilTarget.texture },
          amount: { value: 0 },
        },
        vertexShader: VEIL_VERT,
        fragmentShader: VEIL_FRAG,
        depthTest: false,
        depthWrite: false,
      });
      this.veilScene = new THREE.Scene();
      const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.veilMaterial);
      quad.frustumCulled = false;
      quad.layers.enableAll();
      this.veilScene.add(quad);
    }
    this.veilMaterial.uniforms.tDiffuse!.value = this.veilTarget.texture;
    return { target: this.veilTarget, material: this.veilMaterial, scene: this.veilScene };
  }

  /** Lights and camera must reach BOTH layers or the split pass goes dark.
   * Call again after adding lights (the hearth adds its own). */
  enableAllLayers(): void {
    this.scene.traverse((o) => {
      if ((o as THREE.Light).isLight) o.layers.enableAll();
    });
    this.camera.layers.enableAll();
  }
}
