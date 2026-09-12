import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { GameScene } from './render/scene';
import { CharacterVisual } from './render/character';

/**
 * The A/B page (D-555): the procedural character on the left, the imported
 * one on the right, same light, same camera, same filter.
 *
 * The art-direction verdict (D-406, D-504) is the stakeholder's and cannot be
 * given against a build log, so this exists to make the comparison a thing
 * that can be looked at rather than argued about. It is a viewer only —
 * nothing here is on the path the game takes.
 */

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const stage = $('stage');
const scene = new GameScene(stage);
const status = $('status');

const MODELS = '/models/';

interface ManifestOutfit {
  id: string;
  model: string;
  palette: string | null;
  /** The clip file for THIS character's rig — not every character shares one. */
  animations: string;
  rig: string;
  source: 'pack' | 'fbx';
  height: number;
}

interface Manifest {
  animations: string;
  clips: string[];
  outfits: ManifestOutfit[];
}
let manifest: Manifest | null = null;
/** Clips, cached per animation file, because two rigs need two of them. */
const clipCache = new Map<string, THREE.AnimationClip[]>();

// A slab and a grid: enough to read ground contact and scale, which is most
// of what an animation is judged on.
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(40, 40).rotateX(-Math.PI / 2),
  new THREE.MeshLambertMaterial({ color: 0x5c564c }),
);
ground.receiveShadow = true;
scene.scene.add(ground);
const grid = new THREE.GridHelper(40, 40, 0x3a362e, 0x2c2a26);
(grid.material as THREE.Material).transparent = true;
(grid.material as THREE.Material & { opacity: number }).opacity = 0.35;
scene.scene.add(grid);
scene.enableAllLayers();

const loader = new GLTFLoader();
const textures = new THREE.TextureLoader();

/**
 * Sidekick colours a character with a 32x32 palette: every UV island lands
 * on one texel, so skin, cloth, leather and metal are four pixels rather
 * than four painted maps. Two settings are not optional — NEAREST, or a
 * bilinear tap between adjacent texels invents colours that are on nobody's
 * palette, and sRGB, or every tone comes out washed.
 *
 * It is also what makes per-character recolouring cheap: a copy of this
 * image with a few pixels changed is a whole new set of clothes.
 */
async function loadPalette(file: string): Promise<THREE.Texture> {
  const tex = await textures.loadAsync(`${MODELS}${file}`);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** The clips, loaded once and shared — they are not per-outfit (D-555). */
let clips: THREE.AnimationClip[] = [];

interface Imported {
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  action: THREE.AnimationAction | null;
}
let imported: Imported | null = null;
let procedural: CharacterVisual | null = null;

// The imported model sits at the origin the camera follows, so turning
// the procedural one off leaves it centred rather than at the pane's edge.
const IMPORTED_AT = new THREE.Vector3(0, 0, 0);
const PROCEDURAL_AT = new THREE.Vector3(-1.3, 0, 0);

function say(text: string, bad = false): void {
  status.textContent = text;
  status.classList.toggle('bad', bad);
}

async function loadOutfit(id: string): Promise<void> {
  if (imported) {
    scene.scene.remove(imported.root);
    imported = null;
  }
  const entry = manifest?.outfits.find((o) => o.id === id);
  if (!entry) return;
  const gltf = await loader.loadAsync(`${MODELS}${entry.model}`);
  const palette = entry.palette ? await loadPalette(entry.palette) : null;
  // A character built from a plain FBX is on its own rig, so it needs its
  // own clip file. Picking the wrong one leaves it standing perfectly still
  // with no error anywhere.
  clips = await clipsFor(entry.animations);
  refreshClipList();
  // `SkeletonUtils.clone` rather than `Object3D.clone`: a plain clone copies
  // the meshes but leaves them bound to the ORIGINAL bones, so every copy
  // moves as one.
  const root = cloneSkinned(gltf.scene);
  root.position.copy(IMPORTED_AT);
  root.traverse((o) => {
    o.castShadow = true;
    o.receiveShadow = true;
    const mesh = o as THREE.Mesh;
    if (palette && mesh.isMesh) {
      const mat = mesh.material as THREE.MeshStandardMaterial;
      mat.map = palette;
      mat.needsUpdate = true;
    }
  });
  scene.scene.add(root);
  const mixer = new THREE.AnimationMixer(root);
  imported = { root, mixer, action: null };
  playClip($<HTMLSelectElement>('in-clip').value);
}

async function clipsFor(file: string): Promise<THREE.AnimationClip[]> {
  const cached = clipCache.get(file);
  if (cached) return cached;
  const gltf = await loader.loadAsync(`${MODELS}${file}`);
  clipCache.set(file, gltf.animations);
  return gltf.animations;
}

/** Keep the animation dropdown showing what this rig can actually play. */
function refreshClipList(): void {
  const sel = $<HTMLSelectElement>('in-clip');
  const wanted = sel.value;
  sel.replaceChildren();
  for (const c of clips) sel.add(new Option(c.name, c.name));
  sel.value = clips.some((c) => c.name === wanted)
    ? wanted
    : (clips.find((c) => c.name === 'walking') ?? clips[0])?.name ?? '';
}

function playClip(name: string): void {
  if (!imported) return;
  const clip = clips.find((c) => c.name === name);
  if (!clip) return;
  imported.action?.fadeOut(0.2);
  const next = imported.mixer.clipAction(clip);
  next.reset().fadeIn(0.2).play();
  imported.action = next;
}

function setProcedural(on: boolean): void {
  if (on && !procedural) {
    procedural = new CharacterVisual(20_260_908, scene.scene);
    procedural.setPosition(PROCEDURAL_AT.x, PROCEDURAL_AT.z);
    procedural.setFacing('s');
  } else if (!on && procedural) {
    procedural.dispose();
    procedural = null;
  }
}

async function boot(): Promise<void> {
  const outfitSel = $<HTMLSelectElement>('in-outfit');
  const clipSel = $<HTMLSelectElement>('in-clip');

  try {
    manifest = (await (await fetch(`${MODELS}manifest.json`)).json()) as Manifest;
  } catch {
    say('No models in client/public/models — run: npm run build:characters', true);
    return;
  }
  for (const o of manifest.outfits) {
    outfitSel.add(new Option(o.source === 'fbx' ? `${o.id} (plain FBX)` : o.id, o.id));
  }
  await loadOutfit(outfitSel.value);
  setProcedural(true);
  say(`${clips.length} clips · ${manifest.outfits.length} characters`);

  outfitSel.onchange = () => void loadOutfit(outfitSel.value);
  clipSel.onchange = () => playClip(clipSel.value);
  $<HTMLInputElement>('in-both').onchange = (e) =>
    setProcedural((e.target as HTMLInputElement).checked);
}

const zoom = $<HTMLInputElement>('in-zoom');
const spin = $<HTMLInputElement>('in-spin');
const mode = $<HTMLSelectElement>('in-render');

const clock = new THREE.Clock();
let azimuth = 0;
let elapsed = 0;

function step(dt: number): void {
  elapsed += dt;
  if (spin.checked) azimuth += dt * 0.35;
  scene.setAzimuth(azimuth);
  scene.setZoom(Number(zoom.value));
  scene.follow(new THREE.Vector3(0, 0, 0));

  imported?.mixer.update(dt);
  procedural?.update(dt, elapsed, false, 0);

  scene.render();

}

function frame(): void {
  step(clock.getDelta());
  requestAnimationFrame(frame);
}

/**
 * The same automation hook the character viewer has (D-503 technique): a
 * WebGL canvas has no pixels to read outside the frame that drew them, so
 * the capture renders one first, in this task.
 */
declare global {
  interface Window {
    __imported?: {
      shoot(name: string): Promise<string>;
      /**
       * The scene, so a garment can be put on a body and LOOKED at (D-571).
       *
       * This page exists to compare two casts by eye; dressing one is the
       * same question. Exposed rather than driven through the UI because
       * which garment to try is a thing you decide while looking.
       */
      wear(outfitId: string, garments: readonly string[]): Promise<string>;
    };
  }
}
let dressed: THREE.Object3D | null = null;

window.__imported = {
  async wear(outfitId: string, garments: readonly string[]): Promise<string> {
    const { outfits, loadDressed, loadManifest } = await import('./render/imported-models');
    await loadManifest();
    const outfit = outfits().find((o) => o.id === outfitId);
    if (!outfit) return `no outfit ${outfitId}`;
    const loaded = await loadDressed(outfit, garments);
    if (dressed) scene.scene.remove(dressed);
    dressed = cloneSkinned(loaded.scene);
    dressed.position.set(1.2, 0, 0);
    scene.scene.add(dressed);
    let verts = 0;
    dressed.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (m.isSkinnedMesh) verts += m.geometry.attributes.position!.count;
    });
    return `${outfitId} wearing [${garments.join(', ')}] — ${verts} verts`;
  },
  async shoot(name: string): Promise<string> {
    step(1 / 60);
    const canvas = stage.querySelector('canvas') as HTMLCanvasElement;
    const url = canvas.toDataURL('image/png');
    await fetch(`http://localhost:8123/${name}`, { method: 'POST', body: url, mode: 'no-cors' });
    return `${canvas.width}x${canvas.height}`;
  },
};

void boot();
frame();
