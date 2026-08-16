import * as THREE from 'three';
import { PixelPost } from './palette';

/**
 * Scene shell (D-401): orthographic camera at an isometric angle, physical
 * light units (r155+: key ~4-5, not ~1), fog starting beyond the camera
 * orbit distance — both prototype lessons, see CLAUDE.md rendering notes.
 */

const FRUSTUM = 5.2; // vertical half-extent in world units (1 unit = 1 tile)
const CAMERA_OFFSET = new THREE.Vector3(9, 8.5, 9); // |offset| ≈ 15.3 < fog near 19

export class GameScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.OrthographicCamera;
  readonly post = new PixelPost();
  private key: THREE.DirectionalLight;
  private focus = new THREE.Vector3();

  constructor(private stage: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: false });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    stage.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x0c0b10);
    // Camera orbits at ~15.3 units and the visible play field extends ~13
    // units beyond the focus at this frustum — fog must start past their sum
    // or the far half of the yard washes to background (the prototype's
    // fog-vs-camera-distance lesson, rediscovered at game frustum size).
    this.scene.fog = new THREE.Fog(0x0c0b10, 24, 48);

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);

    // cold ambient + warm key + cool rim — tuned in the prototype
    this.scene.add(new THREE.HemisphereLight(0x9cc0dd, 0x40332a, 2.9));
    this.key = new THREE.DirectionalLight(0xffeed2, 4.6);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    this.key.shadow.bias = -0.0015;
    const sc = this.key.shadow.camera;
    sc.left = -10; sc.right = 10; sc.top = 10; sc.bottom = -10; sc.near = 1; sc.far = 40;
    this.scene.add(this.key);
    this.scene.add(this.key.target);
    const rim = new THREE.DirectionalLight(0x8fb8d8, 1.5);
    rim.position.set(-7, 4, -6);
    this.scene.add(rim);

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  resize(): void {
    const w = this.stage.clientWidth || window.innerWidth;
    const h = this.stage.clientHeight || window.innerHeight;
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(w, h, false);
    this.post.setSize(w, h);
    const aspect = this.post.internalWidth / this.post.internalHeight;
    this.camera.left = -FRUSTUM * aspect;
    this.camera.right = FRUSTUM * aspect;
    this.camera.top = FRUSTUM;
    this.camera.bottom = -FRUSTUM;
    this.camera.updateProjectionMatrix();
  }

  /** Follows a world point: camera, look-at, and the shadow frustum together. */
  follow(point: THREE.Vector3): void {
    this.focus.copy(point);
    this.camera.position.copy(point).add(CAMERA_OFFSET);
    this.camera.lookAt(point.x, point.y + 0.9, point.z);
    this.key.position.set(point.x + 8, point.y + 6.5, point.z + 5);
    this.key.target.position.copy(point);
  }

  render(): void {
    this.post.render(this.renderer, this.scene, this.camera);
  }
}
