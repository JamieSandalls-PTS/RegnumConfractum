import * as THREE from 'three';
import type { LightingProfile } from '@rc/shared';
import { PixelPost } from './palette';

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

export class GameScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.OrthographicCamera;
  readonly post = new PixelPost();
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

  constructor(private stage: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: false });
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
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(w, h, false);
    this.post.setSize(w, h);
    this.applyFrustum();
  }

  private applyFrustum(): void {
    const aspect = this.post.internalWidth / this.post.internalHeight;
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

  /** Jump the orbit to an exact angle (viewer/automation use). */
  setAzimuth(angle: number): void {
    this.azimuth = angle;
    this.azimuthTarget = angle;
  }

  /** Jump zoom to an exact factor (viewer/automation use). Allows tighter
   * close-ups than the in-game wheel clamp — zoomBy() keeps the game limit. */
  setZoom(zoom: number): void {
    this.zoom = Math.min(ZOOM_MAX, Math.max(0.02, zoom)); // near-macro for the editor
    this.zoomTarget = this.zoom;
    this.applyFrustum();
  }

  /** Viewer-only: override orbit elevation for near-eye-level model review.
   * Keeps |offset| under the fog near plane; the game never calls this. */
  private orbitHeight = ORBIT_HEIGHT;
  setOrbitHeight(h: number): void {
    this.orbitHeight = h;
  }

  /** Multiplicative zoom (wheel): > 1 zooms out, < 1 zooms in. */
  zoomBy(factor: number): void {
    this.zoomTarget = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, this.zoomTarget * factor));
  }

  /** Current azimuth — picking needs it to unproject cursor rays. */
  get cameraAzimuth(): number {
    return this.azimuth;
  }

  /** Eases azimuth/zoom toward their targets; call once per frame. */
  updateCamera(dt: number): void {
    const k = Math.min(1, dt * 10);
    this.azimuth += (this.azimuthTarget - this.azimuth) * k;
    const prevZoom = this.zoom;
    this.zoom += (this.zoomTarget - this.zoom) * k;
    if (Math.abs(this.zoom - prevZoom) > 1e-4) this.applyFrustum();
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

  render(): void {
    this.post.render(this.renderer, this.scene, this.camera);
  }

  /**
   * Split render (D-404, stakeholder ruling reinstated 2026-08-18):
   * characters go through the low-res palette quantiser while the world
   * stays crisp. Requires characters on layer 1 (CharacterVisual
   * .setRenderLayer) and lights/camera on all layers — see enableAllLayers.
   */
  renderSplit(envPalette: boolean): void {
    this.post.renderSplit(this.renderer, this.scene, this.camera, envPalette);
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
