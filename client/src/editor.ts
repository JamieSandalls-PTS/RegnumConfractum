import * as THREE from 'three';
import { API } from './authoring-api';
import { AssetVisual } from './render/asset-visual';
import {
  type EnvironmentAsset,
  type PlacedAsset,
  type Volume,
  AssetFileSchema,
  areaCollision,
  assetCovers,
  canStandAt,
  placedVolumes,
  defaultMask,
  type GroundMaterial,
  type AreaDef,
  type CoreStationType,
} from '@rc/shared';
import { GameScene } from './render/scene';
import { EditorFloor } from './render/editor-floor';
import { GroundBrush } from './render/ground-brush';
import { SPLAT_CHANNELS } from './render/ground-splat';

import { VolumeView } from './render/volume-view';
import { StationVisual } from './render/station-visual';
import { LightRig } from './render/lights';
import { Roofs } from './render/roofs';
import { setOcclusionFocus } from './render/occlusion';

/**
 * The map editor (D-543): place walls, ground and objects, and see exactly
 * what the game will draw.
 *
 * `/tools` has said "map editor" in the repository layout since the beginning
 * and this is it, built when it was needed rather than up front.
 *
 * **It renders through the game's own renderers.** Not a
 * schematic, not a 2D grid with icons — the same instanced meshes, the same
 * lighting profile, the same see-through cutout. An editor that draws its own
 * approximation of the world is an editor that lies about what you are making,
 * and the whole point of placing scenery by hand is judging how it looks.
 *
 * **It cannot save invalid content.** Saving PUTs the area to
 * `tools/src/editor-server.ts`, which parses it with the real `AreaSchema`,
 * floods it for reachability with solid props blocking, and refuses to write
 * if anything fails. The validator guarding CI is the validator guarding the
 * save button.
 *
 * The file is the source of truth — there is no editor-only format, no
 * project file, and nothing to export. You edit `content/areas/*.json` and
 * the server loads the same bytes.
 */

/**
 * ONE authoring api (D-629). The editor used to talk to its own server on
 * 8140 for areas and to the studio's on 8150 for packs and meshes, and a
 * session was lost to a stale editor server answering with a schema it had
 * never heard of. Both names now point at the same origin, kept as two so
 * the call sites read as what they are — the `?api=` override in
 * `authoring-api.ts` moves both at once.
 */
const STUDIO = API;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const stage = $('stage');

// ---------------------------------------------------------------------------
// ⚠ There is no tile palette (D-638). Ground is PAINTED and everything that
// stands on it is a placed pack mesh with a collision mask; the tile grid
// under a map is the walkability lattice the server speaks and nothing draws
// it. `validate:content` refuses an unwalkable tile, so the only way to put a
// wall in a map is to place one.
// ---------------------------------------------------------------------------

/** Prop palette, grouped so a list of thirty-one is navigable. */


// ⚠ There is no `prop` tool and no prop schema any more (D-567). The 44
// code-built types were the tile system's scenery and they are gone, along
// with the 1,916 of them that stood in the authored areas. A map is built from
// pack meshes.
type Tool = 'select' | 'asset' | 'station' | 'node' | 'npc' | 'spawn' | 'exit' | 'roof'
  | 'paint';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let area: AreaDef | null = null;
let original = '';
let dirty = false;
let tool: Tool = 'asset';
/**
 * The ground materials content offers, and which one the brush paints (D-585).
 *
 * ⚠ Painting ground writes a LEGEND entry, exactly as painting a tile kind
 * always has. The material is a property of the character, so a 100x100 area
 * still says what it is made of in ten thousand characters and a dozen legend
 * lines — not ten thousand strings.
 */
let groundMats: GroundMaterial[] = [];
let groundPick: string | null = null;
/** The ground painter for the open area (D-585). */
let groundBrush: GroundBrush | null = null;
/** In METRES, so a stroke is the size it looks on the map rather than in pixels. */
let brushRadius = 2;
/** How much of the radius fades out: 0 a hard disc, 1 a fade from the centre. */
let brushSoftness = 0.6;
let brushStrength = 0.85;
/** Set when anything has been painted, so a save knows to write the image. */
let paintDirty = false;
/** Degrees. Free since D-567; the R key still steps it for convenience. */
let assetRot = 0;
/**
 * How high the NEXT placement sits, in metres.
 *
 * ⚠ Separate from a selected object's `z`. The two are different things a
 * person is adjusting — the height of the thing they are about to lay down a
 * row of, and the height of one thing already on the map — and sharing one
 * number means raising a lantern silently re-heights the next fifty walls.
 */
let assetZ = 0;
/**
 * The tool to come back to when selection mode is switched off (X).
 *
 * ⚠ Remembered rather than assumed, because the point of the key is to
 * glance at what is already placed and carry on with the SAME brush. Snapping
 * back to a default would lose the asset picked out of 1,402.
 */
let lastPaintTool: Tool = 'asset';
/** The translucent preview of what the next click would place. */
let ghost: AssetVisual | null = null;
/** Which asset the ghost was built for, so it is rebuilt only on a change. */
let ghostFor: EnvironmentAsset | null = null;
/** Where the cursor is on the ground, in METRES — what the ghost follows. */
let hoverGround: { x: number; y: number } | null = null;
/** Which asset the next click places, and the catalogue to choose it from. */
let assetPick: EnvironmentAsset | null = null;
let assetPack = '';
let assetPacks: string[] = [];
let assetList: EnvironmentAsset[] = [];
let assetTextures: string[] = [];
let assetSearch = '';
/**
 * ⚠ Keyed by the PLACED ASSET ITSELF, not by its coordinates.
 *
 * It was keyed `x:y` when a tile held one thing. In metres two assets share a
 * point routinely — a torch on a wall, a rug under a table — and a coordinate
 * key silently drops one of them from the scene while leaving it in the file.
 */
let assetVisuals = new Map<PlacedAsset, AssetVisual>();
/** The placed asset being manipulated, and the drawing of its collision. */
let selected: PlacedAsset | null = null;
let maskView: VolumeView | null = null;
/** Which volume of the selected asset's mask the fields are editing. */
let maskIndex = 0;
/** The whole area's collision layer, drawn over the map. */
let layerView: VolumeView | null = null;
let showLayer = false;
/** How much one nudge moves things. Metres, degrees and scale differ (D-565). */
let nudge = 0.25;
let stationType: string = 'workshop';
/**
 * The facilities this map may place, from content (D-530).
 *
 * ⚠ Read from the server rather than a hard-coded list. It WAS hard-coded, and
 * so were the resource nodes beside it — so a facility or a node added to
 * content simply never appeared in the palette, a content file the tool could
 * not see.
 */
let stationTypes: string[] = ['workshop', 'storehouse', 'infirmary', 'well'];
let nodeTypes: string[] = ['iron-vein', 'timber-stand', 'grain-row', 'herb-patch', 'game-trail'];
/**
 * The ambience cues and the scripts an area may name.
 *
 * ⚠ Empty until the palette arrives, and the map panel says so rather than
 * offering nothing: a `scripts` row that is blank because the server is down
 * looks exactly like a map that runs no scripts, and one of those is a fact
 * about the map while the other is a fact about the tooling.
 */
let cueIds: string[] = [];
let scriptIds: string[] = [];
let nodeType = 'iron-vein';
let brush = 1;
/** Where a newly placed exit leads, and to which tile in that area. */
let roofStyle: 'thatch' | 'tile' | 'slate' | 'plank' = 'thatch';
let exitTarget = '';
let exitToX = 1;
let exitToY = 1;
/** Every area, for the exit tool's target picker. */
let areaIndex: { id: string; name: string; width: number; height: number }[] = [];

const undoStack: string[] = [];
const redoStack: string[] = [];

const scene = new GameScene(stage);
// An editor needs the whole map, not a player's field of view (D-545).
scene.raiseZoomCeiling(14);
let floor: EditorFloor | null = null;
/** What has been painted on the ground, drawn under the grid (D-585). */
let paintedGround: THREE.Object3D | null = null;
let roofView: Roofs | null = null;
let stationVisuals = new Map<string, StationVisual>();
const lightRig = new LightRig(scene.scene);
let markerGroup = new THREE.Group();
scene.scene.add(markerGroup);


const camTarget = new THREE.Vector3(0, 0, 0);
/** Opens on the whole building rather than a few tiles of it. */
const START_ZOOM = 5.5;
let hovered: { x: number; y: number } | null = null;
let cursor: THREE.LineLoop | null = null;

// ---------------------------------------------------------------------------
// Area loading and drawing
// ---------------------------------------------------------------------------

const key = (x: number, y: number) => `${x}:${y}`;

/** Ground images on disk, for the material editor's texture picker. */
let groundTextureFiles: string[] = [];

/** The people this map may place (D-598), and which one the npc tool places. */
let npcTypes: string[] = [];
let npcType = '';

/**
 * The ground materials a person can paint with (D-585).
 *
 * ⚠ Fetched, not hardcoded. The point of the whole change is that what the
 * floor is made of became content — a list in this file would be the constant
 * it replaced, one indirection later.
 */
async function loadGround(): Promise<void> {
  try {
    const got = (await (await fetch(`${API}/ground`)).json()) as {
      ground: GroundMaterial[];
      textures?: string[];
    };
    groundMats = got.ground;
    // ⚠ The images on disk, so a material is given a texture from a LIST.
    // Typed, it is a way to author a surface that renders as its tint and
    // looks unfinished rather than wrong, and nothing in CI can see under
    // `client/public/` -- the editor server is the only thing that can check.
    groundTextureFiles = got.textures ?? [];
    groundPick ??= groundMats[0]?.id ?? null;
  } catch {
    // The editor still works without them: the brush simply offers the old
    // kinds, which is what it did before any material existed.
    groundMats = [];
  }
}

async function loadAreaList(): Promise<void> {
  const select = $<HTMLSelectElement>('area-select');
  try {
    const res = await fetch(`${API}/areas`);
    const { areas } = (await res.json()) as {
      areas: {
        id: string; name: string; width: number; height: number;
        generated: boolean; live: boolean;
      }[];
    };
    areaIndex = areas;
    select.innerHTML = areas
      // ⚠ The marker goes in FRONT of the name, where it is read before the
      // map is chosen rather than after. A test map opened by mistake is an
      // afternoon's work in the wrong file.
      .map((a) => `<option value="${a.id}" data-generated="${a.generated}" data-live="${a.live}">`
        + `${a.live ? '● ' : '○ '}${a.name} — ${a.id} (${a.width}×${a.height})</option>`)
      .join('');
    select.addEventListener('change', () => void openArea(select.value));
    if (areas.length > 0 && loadToken === 0) await openArea(areas[0]!.id);
  } catch (err) {
    // ⚠ Said in the PICKER as well as in the status line. The status line
    // is a toast in the bottom-right corner, and embedded in the creation
    // tool's Map builder it lands at the far edge of a 660px frame with its
    // last line clipped off — while the thing the person is actually looking
    // at is an empty dropdown at the top left. Reported as "why aren't the
    // maps visible": the answer was on screen and in the one place nobody
    // looks. An empty list and a list that cannot be loaded are different
    // facts and must not look the same.
    select.innerHTML =
      '<option value="">⚠ authoring server not running — npm run dev:tools</option>';
    select.disabled = true;
    setStatus(
      [`cannot reach the authoring server at ${API} — start it with:`,
       `npm run dev:tools`],
      'bad',
    );
    console.error(err);
  }
}

/** Bumped per load, so a slow fetch cannot overwrite a newer choice. */
let loadToken = 0;

async function openArea(id: string): Promise<void> {
  if (dirty && !confirm('Discard unsaved changes to this area?')) return;
  const token = ++loadToken;
  const res = await fetch(`${API}/areas/${id}`);
  const doc = (await res.json()) as AreaDef;
  // Two opens can be in flight — the list auto-opens the first area while a
  // person is already picking another — and the slower one used to win.
  if (token !== loadToken) return;
  area = doc;
  original = JSON.stringify(doc);
  undoStack.length = 0;
  redoStack.length = 0;
  setDirty(false);
  rebuildAll();
  renderPanel();
  renderResizePanel();
  camTarget.set(doc.spawn.x, 0, doc.spawn.y);
  scene.setZoom(START_ZOOM);
  $('hud-area').textContent = `${doc.name} · ${doc.id}`;
  $<HTMLSelectElement>('area-select').value = doc.id;
  const generated = $<HTMLSelectElement>('area-select').selectedOptions[0]?.dataset.generated === 'true';
  const warning = $('area-warning');
  warning.style.display = generated ? 'block' : 'none';
  // ⚠ This warning used to say the generator DISCARDS what you place, which
  // was true and is not any more (D-582): it now carries `assets`, `roofs` and
  // `live` across. Saying the old thing would scare somebody off placing
  // anything here, which is the opposite of what the editor is for — and a
  // warning people learn to disbelieve is worse than none.
  warning.textContent = generated
    ? 'This area’s SHAPE is generated by tools/src/build-round-map.py — its '
      + 'size, ground, doors, spawn, stations and nodes. Running that script '
      + 'rewrites those. What you place here (assets and roofs) is kept.'
    : '';
  setStatus([], 'good');
}

/**
 * The painter for the open area, around whatever it was last painted with.
 *
 * ⚠ The existing image is loaded back INTO the canvas rather than shown
 * beside it. A painter that starts blank every time is a painter that silently
 * throws away the last session the first time somebody touches it.
 */
function rebuildBrush(): void {
  if (!area) return;
  groundBrush?.dispose();
  groundBrush = null;
  paintDirty = false;
  const a = area;
  const make = (imgs: (HTMLImageElement | null)[]): void => {
    // The area may have been swapped while the images were loading.
    if (area !== a) return;
    // ⚠ The area's OWN materials first, in the order it recorded them, so a
    // reopened map paints into the same channels it was saved with. Getting
    // this wrong silently swaps grass for gravel across a whole map.
    const used = (a.groundMaterials ?? [])
      .map((id) => groundMats.find((m) => m.id === id))
      .filter((m): m is GroundMaterial => !!m);
    groundBrush = new GroundBrush(
      scene.scene, { width: a.width, height: a.height }, used, imgs,
    );
  };
  const names = a.groundPaint ?? [];
  if (names.length === 0) {
    make([]);
    return;
  }
  // ⚠ ALL the masks, or none of them (D-588). Building the brush as each
  // image arrives would make the second mask's materials paint into an empty
  // canvas — half a map's ground silently lost on the next save.
  void Promise.all(names.map((name) => new Promise<HTMLImageElement | null>((done) => {
    const img = new Image();
    img.onload = () => done(img);
    // A named image that will not load is drawn as bare ground, and the
    // console says so — CI refuses the case where it is missing at build.
    img.onerror = () => done(null);
    img.src = `textures/painted/${name}?t=${Date.now()}`;
  }))).then(make);
}

/** Rebuilds terrain and every prop. Called on load and after a stroke. */
function rebuildAll(): void {
  if (!area) return;
  // ⚠ An empty highlighted floor, not painted terrain (D-567). A map is built
  // from pack assets standing on open ground; the ground's job is to be
  // aimable at and otherwise invisible.
  floor?.dispose(scene.scene);
  floor = new EditorFloor(scene.scene, area.width, area.height);
  rebuildBrush();
  roofView?.dispose(scene.scene);
  roofView = new Roofs(area.roofs, scene.scene);
  scene.applyLighting(area.lighting);
  scene.enableAllLayers();
  rebuildProps();
  rebuildMarkers();
}

function rebuildProps(): void {
  for (const v of stationVisuals.values()) v.dispose();
  stationVisuals = new Map();
  for (const v of assetVisuals.values()) v.dispose();
  assetVisuals = new Map();
  lightRig.clear();
  if (!area) return;
  for (const a of area.assets) addAssetVisual(a);
  refreshLayer();
  // ⚠ The 44 code-built prop types are NOT drawn any more and are stripped on
  // load (D-567). They were the tile system's scenery — placed on whole tiles,
  // blocking whole tiles — and drawing them beside real pack meshes would show
  // two art directions in one map and make it impossible to judge either.
  // Stations are the exception below: they are gameplay objects, not scenery.
  // Stations are entities in play, but here they are things you place, so the
  // editor draws them with the same meshes the game gives them (D-542).
  for (const st of area.stations) {
    stationVisuals.set(
      `st:${st.x}:${st.y}`,
      new StationVisual(scene.scene, st.type as CoreStationType, st.x, st.y),
    );
  }
}

/** Spawn, transitions and nodes, as flat coloured plates you can see. */
function rebuildMarkers(): void {
  scene.scene.remove(markerGroup);
  markerGroup.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
  });
  markerGroup = new THREE.Group();
  if (!area) return;
  const plate = (x: number, y: number, color: number, h: number): THREE.Mesh => {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(0.9, 0.03, 0.9),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55 }),
    );
    m.position.set(x, h, y);
    return m;
  };
  markerGroup.add(plate(area.spawn.x, area.spawn.y, 0x63c26a, 0.09));
  for (const t of area.transitions) markerGroup.add(plate(t.x, t.y, 0xc4703a, 0.08));
  for (const n of area.nodes) {
    const m = new THREE.Mesh(
      new THREE.ConeGeometry(0.22, 0.5, 6),
      new THREE.MeshBasicMaterial({ color: 0x6fa0c0, transparent: true, opacity: 0.75 }),
    );
    m.position.set(n.x, 0.3, n.y);
    markerGroup.add(m);
  }
  // ⚠ A PERSON-SIZED marker, not a plate. Where somebody stands is judged
  // against the doorway they are standing in and the crowd that has to get
  // past them, and a flat square on the floor answers neither question.
  for (const person of area.npcs ?? []) {
    const m = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.24, 1.1, 4, 8),
      new THREE.MeshBasicMaterial({ color: 0xd8c27a, transparent: true, opacity: 0.7 }),
    );
    m.position.set(person.x, 0.85, person.y);
    markerGroup.add(m);
  }
  scene.scene.add(markerGroup);
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

function snapshot(): void {
  if (!area) return;
  undoStack.push(JSON.stringify(area));
  if (undoStack.length > 60) undoStack.shift();
  redoStack.length = 0;
}

function setDirty(on: boolean): void {
  dirty = on;
  $('hud-dirty').textContent = on ? '· unsaved' : '';
  $('hud-dirty').className = on ? 'dirty' : '';
}

// ⚠ A reload throws away unsaved work SILENTLY. Switching areas has asked
// since D-543; a refresh did not, and eleven hand-placed walls went that way.
// Placement is slow, careful work and there is no autosave to fall back on.
window.addEventListener('beforeunload', (e) => {
  if (!dirty) return;
  e.preventDefault();
  e.returnValue = '';
});

/**
 * The legend character a resized or trimmed map is filled with (D-638).
 *
 * Every tile is walkable ground now; the kind is the painter's hint and
 * nothing else reads it, so a map with no legend at all gets plain floor.
 */
function groundChar(a: AreaDef): string {
  const existing = Object.entries(a.legend).find(([, d]) => d.walkable)?.[0];
  if (existing) return existing;
  a.legend['.'] = { walkable: true, kind: 'floor' };
  return '.';
}

/**
 * Every pack's environment assets, so an area that mixes packs still draws.
 *
 * ⚠ Keyed by `pack/id`. Indexing only the SELECTED pack meant opening a map
 * built from two packs drew half of it.
 */
const assetIndex = new Map<string, { mesh: string; textures: readonly string[] }>();

function addAssetVisual(a: PlacedAsset): void {
  assetVisuals.set(
    a,
    new AssetVisual(scene.scene, a, {
      api: STUDIO,
      lookup: (pack, id) => assetIndex.get(`${pack}/${id}`),
    }),
  );
}

/**
 * Keep the preview in step with what is picked, and put it under the cursor.
 *
 * ⚠ It is a real `AssetVisual`, not a box: the whole reason to show it is
 * to judge whether THIS mesh sits right against the one beside it, and a
 * stand-in that is the right size and the wrong shape answers the wrong
 * question. It costs nothing extra — the mesh is already cached by the time
 * it has been drawn once.
 */
function updateGhost(): void {
  const want = tool === 'asset' ? assetPick : null;
  if (want !== ghostFor) {
    ghost?.dispose();
    ghost = null;
    ghostFor = want;
    if (want) {
      ghost = new AssetVisual(
        scene.scene,
        { asset: want.id, pack: want.pack, x: 0, y: 0, z: 0, rotation: 0, scale: 1,
          collision: [], overrideCollision: false, dressed: false, fromTiles: false, seat: want.seat ?? false },
        { api: STUDIO, lookup: (pack, id) => assetIndex.get(`${pack}/${id}`) },
      );
      ghost.setGhost(true);
    }
  }
  if (!ghost) return;
  // ⚠ Hidden rather than parked off-screen when the cursor leaves the map.
  // A preview left at the last place it was valid reads as something already
  // placed there, which is the one thing it must never look like.
  if (!hoverGround) {
    ghost.setVisible(false);
    return;
  }
  ghost.setVisible(true);
  ghost.moveTo({
    asset: ghostFor!.id, pack: ghostFor!.pack,
    seat: ghostFor!.seat ?? false,
    // ⚠ A person is placing this, so it is never `dressed` — that flag marks
    // scatter a tool owns and may replace wholesale (D-592).
    dressed: false, fromTiles: false,
    // Snapped exactly as a real placement is, or the preview lies about
    // where the click will land by up to half a snap.
    x: snapped(hoverGround.x), y: snapped(hoverGround.y),
    z: assetZ, rotation: assetRot, scale: 1,
    collision: [], overrideCollision: false,
  });
}

/** The placed asset under a point, topmost last-placed first. */
function assetAt(x: number, y: number): PlacedAsset | null {
  // ⚠ By what it COVERS, not by its anchor: clicking the far end of a 4m wall
  // has to find the wall, or a map fills with things that cannot be removed
  // from where they visibly are. Searched backwards so the thing placed most
  // recently — the one on top — wins an overlap.
  if (!area) return null;
  for (let i = area.assets.length - 1; i >= 0; i--) {
    const a = area.assets[i]!;
    if (assetCovers(a, { x, y })) return a;
  }
  return null;
}

function removeAsset(hit: PlacedAsset): void {
  if (!area) return;
  area.assets = area.assets.filter((a) => a !== hit);
  assetVisuals.get(hit)?.dispose();
  assetVisuals.delete(hit);
  if (selected === hit) select(null);
  setDirty(true);
}

function removeAssetAt(x: number, y: number): boolean {
  if (!area) return false;
  const hit = assetAt(x, y);
  if (!hit) return false;
  area.assets = area.assets.filter((a) => a !== hit);
  assetVisuals.get(hit)?.dispose();
  assetVisuals.delete(hit);
  if (selected === hit) select(null);
  return true;
}

function placeAsset(x: number, y: number): boolean {
  if (!area || !assetPick) return false;
  const placed: PlacedAsset = {
    asset: assetPick.id,
    pack: assetPick.pack,
    // ⚠ BAKED from the catalogue, like the collision mask beside it
    // (D-567/D-605). The server holds areas and not the 1,402-entry asset
    // catalogue, so a placement has to carry what the simulation will ask of
    // it — and "can somebody sit here" is now one of those questions.
    seat: assetPick.seat ?? false,
    dressed: false, fromTiles: false,
    x,
    y,
    z: assetZ,
    rotation: assetRot,
    scale: 1,
    // ⚠ The asset's mask, COPIED at placement (D-567) — a copy this placement
    // may then edit without forking the asset, which is the rule the
    // stakeholder chose. CI reports it when the copy and the catalogue part.
    collision: defaultMask(assetPick),
    // Inherited, not overridden: it tracks the asset until somebody edits it.
    overrideCollision: false,
  };
  // ⚠ Overlapping is ALLOWED now. Tiles could hold one thing each, so placing
  // meant replacing; a wall with a torch on it and a rug under a table are the
  // ordinary case in metres, and auto-deleting what is already there would
  // make them impossible.
  area.assets.push(placed);
  addAssetVisual(placed);
  return true;
}

// ---------------------------------------------------------------------------
// Building with more than one click at a time (D-567)
// ---------------------------------------------------------------------------

/**
 * What a placement snaps to, in metres. 0 is off.
 *
 * ⚠ Free placement is what D-567 bought and it is not what you want for a
 * WALL. Two walls that meet at 4.97m instead of 5 leave a three-centimetre
 * slit a body cannot pass but an eye can, and it reads as a rendering seam
 * rather than a mistake. Every map built by hand so far has been a row of
 * things almost lining up.
 */
let snap = 0.5;

/** The asset's own length along its local x, measured from its mask. */
function assetLength(a: EnvironmentAsset): number {
  const mask = defaultMask(a);
  let longest = 1;
  for (const v of mask) {
    if (v.shape.kind === 'rect') longest = Math.max(longest, v.shape.w);
    else if (v.shape.kind === 'circle') longest = Math.max(longest, v.shape.r * 2);
  }
  return longest;
}

function snapped(n: number): number {
  return snap > 0 ? Math.round(n / snap) * snap : n;
}

/**
 * Place a run of the picked asset between two points.
 *
 * ⚠ This is the verb the map builder was missing. Everything else the editor
 * can do, a person can do one click at a time; a wall is twenty clicks that
 * have to line up, and doing that by hand is why every map so far was written
 * by a script instead. The run is laid END TO END using the asset's own
 * measured length and turned to face along the drag, so a wall built this way
 * is continuous by construction rather than by care.
 */
function placeRun(from: { x: number; y: number }, to: { x: number; y: number }): number {
  if (!area || !assetPick) return 0;
  const a = { x: snapped(from.x), y: snapped(from.y) };
  const b = { x: snapped(to.x), y: snapped(to.y) };
  const span = Math.hypot(b.x - a.x, b.y - a.y);
  const unit = assetLength(assetPick);
  if (span < unit * 0.5) {
    placeAsset(a.x, a.y);
    return 1;
  }
  const n = Math.max(1, Math.round(span / unit));
  // Degrees clockwise in the screen frame (+x east, +y south) — the same
  // convention `transformVolume` and the renderer's negated yaw both use.
  const angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  const step = span / n;
  for (let i = 0; i < n; i++) {
    // Each segment's CENTRE, so the run starts at `a` and ends at `b` rather
    // than overhanging both by half a segment.
    const t = (i + 0.5) * step;
    const x = a.x + ((b.x - a.x) / span) * t;
    const y = a.y + ((b.y - a.y) / span) * t;
    const before = assetRot;
    assetRot = angle;
    placeAsset(x, y);
    assetRot = before;
  }
  return n;
}

/** Copy the selected object, offset so the copy is visibly a second thing. */
function duplicateSelected(): void {
  if (!area || !selected) return;
  snapshot();
  const copy: PlacedAsset = {
    ...selected,
    x: snapped(selected.x + 1),
    y: snapped(selected.y + 1),
    // ⚠ Deep-copied. A shallow spread shares the collision array, so editing
    // the copy's mask silently edits the original's — and the original is
    // usually somewhere else on the map where nobody is looking.
    collision: JSON.parse(JSON.stringify(selected.collision)) as typeof selected.collision,
  };
  area.assets.push(copy);
  addAssetVisual(copy);
  select(copy);
  setDirty(true);
}

// ---------------------------------------------------------------------------
// Selecting and manipulating what is already placed (D-567)
// ---------------------------------------------------------------------------

/**
 * Pick the asset under the cursor by RAYCASTING the drawn meshes.
 *
 * ⚠ Not by its collision mask, which was the first attempt and is wrong twice
 * over: an asset whose mask is empty — a rug, a decal, anything the classifier
 * measured flat — could never be clicked at all, and an asset whose mask is a
 * door frame could not be clicked in its own doorway. You click what you can
 * see, which is the mesh.
 */
function assetAtScreen(px: number, py: number): PlacedAsset | null {
  const rect = stage.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((px - rect.left) / rect.width) * 2 - 1,
    -((py - rect.top) / rect.height) * 2 + 1,
  );
  const ray = new THREE.Raycaster();
  ray.setFromCamera(ndc, scene.camera);
  let best: { placed: PlacedAsset; d: number } | null = null;
  for (const [placed, visual] of assetVisuals.entries()) {
    const hits = ray.intersectObject(visual.object, true);
    if (hits.length === 0) continue;
    if (!best || hits[0]!.distance < best.d) best = { placed, d: hits[0]!.distance };
  }
  return best?.placed ?? null;
}

/** Where the cursor meets the ground plane, in METRES rather than rounded. */
function groundAtScreen(px: number, py: number): { x: number; y: number } | null {
  const rect = stage.getBoundingClientRect();
  const ndc = new THREE.Vector3(
    ((px - rect.left) / rect.width) * 2 - 1,
    -((py - rect.top) / rect.height) * 2 + 1,
    -1,
  );
  const near = ndc.clone().unproject(scene.camera);
  const far = new THREE.Vector3(ndc.x, ndc.y, 1).unproject(scene.camera);
  const dir = far.sub(near);
  if (Math.abs(dir.y) < 1e-6) return null;
  const k = -near.y / dir.y;
  return { x: near.x + dir.x * k, y: near.z + dir.z * k };
}

function select(a: PlacedAsset | null): void {
  selected = a;
  maskIndex = 0;
  refreshMask();
  renderPanel();
}

/** Redraw the selected asset's collision cage. */
/**
 * Draw (or clear) the area's WHOLE collision layer.
 *
 * ⚠ This is what makes migrating an area possible at all. Ten of the eleven
 * authored areas still carry no `collision` block, so what the server actually
 * uses is derived from their tile grid — every wall a metre thick and on a
 * lattice (D-567). Nobody can judge whether that is worth re-cutting by hand
 * without looking at it, and until this existed there was no way to look.
 */
function refreshLayer(): void {
  layerView?.dispose();
  layerView = null;
  if (!showLayer || !area) return;
  layerView = new VolumeView(scene.scene, areaCollision(area).volumes);
}

function refreshMask(): void {
  maskView?.dispose();
  maskView = null;
  if (!selected) return;
  maskView = new VolumeView(scene.scene, placedVolumes(selected));
}

/**
 * Apply an edit to the selected asset.
 *
 * ⚠ Moves the EXISTING visual rather than rebuilding it. The `AssetVisual`
 * constructor re-fetches and re-parses the FBX over HTTP, which is fine once
 * and hopeless per wheel notch — the same lesson D-565 recorded for weapon
 * offsets, in a place where it costs a network round trip.
 */
function editSelected(change: Partial<PlacedAsset>): void {
  if (!selected || !area) return;
  Object.assign(selected, change);
  assetVisuals.get(selected)?.moveTo(selected);
  refreshMask();
  setDirty(true);
}

/**
 * A number you can scroll (D-565).
 *
 * ⚠ The wheel handler must stop propagation as well as prevent the default, or
 * the stage's own handler flies the camera backwards mid-nudge. Shift is ×10
 * and alt is ÷10, because metres, degrees and scale never want one granularity.
 */
function numField(
  label: string,
  value: number,
  step: number,
  onChange: (v: number) => void,
  digits = 2,
): HTMLElement {
  const row = document.createElement('label');
  row.className = 'numrow';
  const name = document.createElement('span');
  name.textContent = label;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value.toFixed(digits);
  input.style.cssText = 'width:5.5em;text-align:right';
  const commit = (v: number): void => {
    if (!Number.isFinite(v)) return;
    input.value = v.toFixed(digits);
    onChange(v);
  };
  input.onchange = () => commit(parseFloat(input.value));
  input.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
      commit(parseFloat(input.value) + (e.deltaY < 0 ? 1 : -1) * step * mult);
    },
    { passive: false },
  );
  row.append(name, input);
  return row;
}

function tickbox(label: string, on: boolean, onChange: (v: boolean) => void): HTMLElement {
  const row = document.createElement('label');
  row.className = 'numrow';
  const name = document.createElement('span');
  name.textContent = label;
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = on;
  box.onchange = () => onChange(box.checked);
  row.append(name, box);
  return row;
}

/** The inspector: where a placed thing is, and what it does to a body. */
function renderSelectTool(opts: HTMLElement): void {
  const layerRow = document.createElement('div');
  layerRow.className = 'chips';
  layerRow.appendChild(
    chip(showLayer ? 'collision: shown' : 'collision: hidden', showLayer, () => {
      showLayer = !showLayer;
      refreshLayer();
      renderPanel();
    }),
  );
  const lh = document.createElement('h2');
  lh.textContent = 'Whole area';
  opts.append(lh, layerRow);
  if (showLayer) {
    const note = document.createElement('div');
    note.className = 'hint';
    note.textContent =
      'What the server actually collides against. An area with no collision '
      + 'block of its own gets one derived from its tiles — every wall a metre '
      + 'thick and on the old lattice. That is what re-cutting a map replaces.';
    opts.appendChild(note);
  }

  if (!selected) {
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.innerHTML =
      'Click something you have placed to select it. Then <b>drag</b> to move it, '
      + '<b>R</b> to turn it, <b>Delete</b> to remove it — or scroll any field below.';
    opts.appendChild(hint);
    return;
  }

  const h = document.createElement('h2');
  h.textContent = selected.asset;
  opts.appendChild(h);

  const place = document.createElement('div');
  place.className = 'fields';
  place.append(
    numField('east (m)', selected.x, nudge, (v) => editSelected({ x: v })),
    numField('south (m)', selected.y, nudge, (v) => editSelected({ y: v })),
    numField('height (m)', selected.z, nudge, (v) => editSelected({ z: v })),
    numField('turn (°)', selected.rotation, 15, (v) => editSelected({ rotation: v }), 1),
    numField('scale', selected.scale, 0.05, (v) => editSelected({ scale: Math.max(0.01, v) })),
  );
  opts.append(place);

  const snapH = document.createElement('h2');
  snapH.textContent = 'Snap';
  const snapRow = document.createElement('div');
  snapRow.className = 'chips';
  for (const v of [0, 0.25, 0.5, 1]) {
    snapRow.appendChild(
      chip(v === 0 ? 'off' : `${v}m`, snap === v, () => { snap = v; renderPanel(); }),
    );
  }
  opts.append(snapH, snapRow);

  const sh = document.createElement('h2');
  sh.textContent = 'Nudge step';
  const stepRow = document.createElement('div');
  stepRow.className = 'chips';
  for (const s of [0.05, 0.25, 0.5, 1]) {
    stepRow.appendChild(chip(`${s}m`, nudge === s, () => { nudge = s; renderPanel(); }));
  }
  opts.append(sh, stepRow);

  renderMaskEditor(opts);

  const del = document.createElement('button');
  del.textContent = 'Delete this object';
  del.style.marginTop = '10px';
  del.onclick = () => {
    if (!area || !selected) return;
    snapshot();
    const gone = selected;
    area.assets = area.assets.filter((a) => a !== gone);
    assetVisuals.get(gone)?.dispose();
    assetVisuals.delete(gone);
    select(null);
    setDirty(true);
  };
  opts.appendChild(del);
}

/** One volume, added to the selected asset with sensible starting numbers. */
function blankVolume(kind: 'rect' | 'circle'): Volume {
  return {
    shape:
      kind === 'rect'
        ? { kind: 'rect', x: 0, y: 0, w: 1, h: 1, rotation: 0 }
        : { kind: 'circle', x: 0, y: 0, r: 0.5 },
    base: 0,
    top: 1,
    walkable: false,
    opaque: false,
    sightTop: undefined,
    ramp: undefined,
  };
}

/**
 * The collision mask, volume by volume.
 *
 * ⚠ This edits the only part of a map that is invisible in play and decisive in
 * it. A door frame is passable because somebody drew two jambs here; nothing
 * infers it, and the bounding box every unauthored asset starts with is exactly
 * what made 395 assets block nine tiles apiece.
 */
function renderMaskEditor(opts: HTMLElement): void {
  if (!selected) return;
  const target = selected;
  const h = document.createElement('h2');
  h.textContent = `Collision — ${target.collision.length} volume(s)`;
  opts.appendChild(h);

  const legend = document.createElement('div');
  legend.className = 'hint';
  legend.innerHTML =
    '<b style="color:#d05a4a">red</b> stops a body · '
    + '<b style="color:#5aa85f">green</b> you stand on · '
    + '<b style="color:#d39b3c">amber</b> climbs · '
    + '<b style="color:#4a7fd0">blue</b> stops only sight';
  opts.appendChild(legend);

  const picker = document.createElement('div');
  picker.className = 'chips';
  target.collision.forEach((v, i) => {
    picker.appendChild(
      chip(`${i + 1}. ${v.shape.kind}`, maskIndex === i, () => { maskIndex = i; renderPanel(); }),
    );
  });
  opts.appendChild(picker);

  const set = (change: Partial<Volume>): void => {
    target.collision = target.collision.map((x, i) => (i === maskIndex ? { ...x, ...change } : x));
    // ⚠ Touching a mask marks it as a deliberate override, so CI stops asking
    // whether it has drifted from the asset it was copied from. Doing it here,
    // on the edit, is the only way it can be right without asking.
    editSelected({ overrideCollision: true });
    renderPanel();
  };

  const v = target.collision[maskIndex];
  if (v) {
    const f = document.createElement('div');
    f.className = 'fields';
    if (v.shape.kind === 'rect') {
      const r = v.shape;
      const shape = (c: Partial<typeof r>): void => set({ shape: { ...r, ...c } });
      f.append(
        numField('offset east', r.x, 0.1, (n) => shape({ x: n })),
        numField('offset south', r.y, 0.1, (n) => shape({ y: n })),
        numField('width', r.w, 0.1, (n) => shape({ w: Math.max(0.05, n) })),
        numField('depth', r.h, 0.1, (n) => shape({ h: Math.max(0.05, n) })),
        numField('turn (°)', r.rotation, 15, (n) => shape({ rotation: n }), 1),
      );
    } else if (v.shape.kind === 'circle') {
      const c = v.shape;
      const shape = (o: Partial<typeof c>): void => set({ shape: { ...c, ...o } });
      f.append(
        numField('offset east', c.x, 0.1, (n) => shape({ x: n })),
        numField('offset south', c.y, 0.1, (n) => shape({ y: n })),
        numField('radius', c.r, 0.1, (n) => shape({ r: Math.max(0.05, n) })),
      );
    }
    f.append(
      numField('base (m)', v.base, 0.1, (n) => set({ base: n })),
      numField('top (m)', v.top, 0.1, (n) => set({ top: Math.max(v.base, n) })),
      tickbox('stand on top', v.walkable, (n) => set({ walkable: n })),
      tickbox('stops sight', v.opaque, (n) => set({ opaque: n })),
    );
    opts.appendChild(f);

    // ⚠ A ramp is offered only on a rect. A gradient across a circle has no
    // direction and one across a concave polygon has several — the schema
    // refuses both, and an editor that offers what the schema refuses teaches
    // people to author maps that will not save.
    if (v.shape.kind === 'rect') {
      const rampRow = document.createElement('div');
      rampRow.className = 'chips';
      const ramp = v.ramp;
      rampRow.appendChild(
        chip(ramp ? 'ramp: on' : 'ramp: off', !!ramp, () =>
          set(
            ramp
              ? { ramp: undefined }
              : { ramp: { along: 'y', low: 0, high: Math.max(0.5, v.top) } },
          ),
        ),
      );
      if (ramp) {
        rampRow.appendChild(
          chip(`climbs along ${ramp.along}`, false, () =>
            set({ ramp: { ...ramp, along: ramp.along === 'x' ? 'y' : 'x' } }),
          ),
        );
      }
      opts.appendChild(rampRow);
      if (ramp) {
        const rf = document.createElement('div');
        rf.className = 'fields';
        rf.append(
          numField('bottom (m)', ramp.low, 0.1, (n) => set({ ramp: { ...ramp, low: n } })),
          numField('top (m)', ramp.high, 0.1, (n) =>
            set({ ramp: { ...ramp, high: Math.max(ramp.low, n) } }),
          ),
        );
        opts.appendChild(rf);
      }
    }
  }

  const buttons = document.createElement('div');
  buttons.className = 'chips';
  const add = (kind: 'rect' | 'circle'): void => {
    snapshot();
    target.collision = [...target.collision, blankVolume(kind)];
    maskIndex = target.collision.length - 1;
    editSelected({ overrideCollision: true });
    renderPanel();
  };
  buttons.appendChild(chip('+ box', false, () => add('rect')));
  buttons.appendChild(chip('+ circle', false, () => add('circle')));
  if (target.collision.length > 0) {
    buttons.appendChild(
      chip('− remove', false, () => {
        snapshot();
        target.collision = target.collision.filter((_, i) => i !== maskIndex);
        maskIndex = 0;
        editSelected({ overrideCollision: true });
        renderPanel();
      }),
    );
  }
  buttons.appendChild(
    chip('walk through', false, () => {
      snapshot();
      target.collision = [];
      editSelected({ overrideCollision: true });
      renderPanel();
    }),
  );
  opts.appendChild(buttons);

  const note = document.createElement('div');
  note.className = 'hint';
  note.innerHTML =
    'Offsets are measured from the object itself, so a mask drawn once travels '
    + 'with it however it is turned. ⚠ This edits <b>this placement only</b>; '
    + 'the mask every copy inherits belongs to the asset.';
  opts.appendChild(note);
}

/**
 * ⚠ `placeProp` USED TO LIVE HERE and was removed with the prop palette
 * (D-566). Legacy props are still drawn and can still be erased; nothing in
 * the editor creates a new one, because the point of the map builder now is to
 * place the pack's own art. The generators (`build-round-map.py`) still write
 * props and the schema still accepts them.
 */
function applyAt(x: number, y: number, erase: boolean): boolean {
  if (!area) return false;
  // ⚠ Handled BEFORE the brush loop and outside it. Ground is continuous and a
  // brush over it makes sense; a brush of 7 over assets placed forty-nine
  // overlapping houses on one click. One click, one object.
  if (tool === 'asset') {
    if (!erase) return placeAsset(x, y);
    const hit = assetAt(x, y);
    if (hit) {
      removeAsset(hit);
      return true;
    }
    return false;
  }
  let changed = false;
  const half = Math.floor(brush / 2);
  for (let dy = -half; dy <= half; dy++) {
    for (let dx = -half; dx <= half; dx++) {
      const tx = x + dx;
      const ty = y + dy;
      if (tx < 0 || ty < 0 || tx >= area.width || ty >= area.height) continue;
      if (tool === 'station') {
        area.stations = area.stations.filter((s) => s.x !== tx || s.y !== ty);
        stationVisuals.get(`st:${tx}:${ty}`)?.dispose();
        stationVisuals.delete(`st:${tx}:${ty}`);
        if (!erase && area.legend[area.tiles[ty]![tx]!]!.walkable) {
          area.stations.push({ x: tx, y: ty, type: stationType as CoreStationType });
          stationVisuals.set(
            `st:${tx}:${ty}`,
            new StationVisual(scene.scene, stationType as CoreStationType, tx, ty),
          );
        }
        changed = true;
      } else if (tool === 'roof') {
        const at = area.roofs.findIndex((r) => r.x === tx && r.y === ty);
        if (erase) {
          if (at >= 0) {
            area.roofs.splice(at, 1);
            changed = true;
          }
        } else if (at >= 0) {
          if (area.roofs[at]!.style !== roofStyle) {
            area.roofs[at] = { x: tx, y: ty, style: roofStyle };
            changed = true;
          }
        } else {
          area.roofs.push({ x: tx, y: ty, style: roofStyle });
          changed = true;
        }
      } else if (tool === 'npc') {
        // ⚠ One person per tile, and only where a body can stand. The server
        // moves an NPC with nowhere to stand to the area's spawn without a
        // word (that is how the Hanged Ferryman's keeper spent who knows how
        // long standing in the middle of the room instead of behind his bar),
        // and `validate:content` now refuses it outright — so refusing it here
        // is the editor keeping its promise not to author what the build
        // rejects.
        area.npcs = (area.npcs ?? []).filter((n) => n.x !== tx || n.y !== ty);
        // ⚠ `canStandAt`, NOT the legend's `walkable`. They are different
        // questions: the legend says the GROUND is passable, and canStandAt
        // also asks whether a placed asset's collision volume is standing on
        // it. Checked against the legend, the tool happily stood somebody
        // inside the palisade at (0,0) — which the build refuses and the
        // server would silently answer by moving them to the area's spawn.
        // This is the same function `validate:content` calls, which is what
        // makes the editor's promise true rather than nearly true.
        if (!erase && npcType && canStandAt(area, { x: tx, y: ty })) {
          area.npcs.push({ x: tx, y: ty, type: npcType, facing: 's' });
        }
        changed = true;
        // ⚠ The marker has to be rebuilt HERE, as the node tool does one branch
        // below. Without it the person is in the file, saved, and drawn only
        // after a reload — placed, persisted and invisible, which is the exact
        // shape of bug the editor exists to prevent. Found by counting the
        // markers in the scene against the placements in the file rather than
        // by looking at the map, where one missing figure among three hundred
        // objects is not something an eye reports.
        rebuildMarkers();
      } else if (tool === 'node') {
        area.nodes = area.nodes.filter((n) => n.x !== tx || n.y !== ty);
        if (!erase && area.legend[area.tiles[ty]![tx]!]!.walkable) {
          area.nodes.push({ x: tx, y: ty, type: nodeType });
        }
        changed = true;
        rebuildMarkers();
      }
    }
  }
  if (tool === 'exit') {
    const existing = area.transitions.findIndex((t) => t.x === x && t.y === y);
    if (erase) {
      if (existing >= 0) {
        area.transitions.splice(existing, 1);
        rebuildMarkers();
        changed = true;
      }
    } else {
      const ch = area.tiles[y]?.[x];
      if (ch !== undefined && area.legend[ch]!.walkable && exitTarget) {
        const doorway = { x, y, toArea: exitTarget, toX: exitToX, toY: exitToY };
        if (existing >= 0) area.transitions[existing] = doorway;
        else area.transitions.push(doorway);
        rebuildMarkers();
        rebuildAll();
        changed = true;
      }
    }
  }
  if (tool === 'spawn' && !erase) {
    const ch = area.tiles[y]?.[x];
    if (ch !== undefined && area.legend[ch]!.walkable && canStandAt(area, { x, y })) {
      area.spawn = { x, y };
      rebuildMarkers();
      changed = true;
    }
  }
  if (changed) setDirty(true);
  // A roof's SHAPE derives from its whole footprint (D-545), so one painted
  // tile can re-pitch the entire building. Rebuild the geometry rather than
  // trying to patch one slab.
  if (changed && tool === 'roof' && area) {
    roofView?.dispose(scene.scene);
    roofView = new Roofs(area.roofs, scene.scene);
  }
  return changed;
}

/**
 * Resizes the map, cropping or extending from an offset.
 *
 * Everything standing outside the new bounds is DROPPED, and the count is
 * reported before it happens — a resize that silently ate a third of the
 * scenery would be the worst button in the tool. New ground is filled with
 * the area's first walkable kind, so growing a map gives you floor to build
 * on rather than a void.
 */
function resizeArea(width: number, height: number, offsetX: number, offsetY: number): string {
  if (!area) return 'no area';
  snapshot();
  const fillChar = groundChar(area);
  const rows: string[] = [];
  for (let y = 0; y < height; y++) {
    let row = '';
    for (let x = 0; x < width; x++) {
      const sx = x + offsetX;
      const sy = y + offsetY;
      const ch = area.tiles[sy]?.[sx];
      row += ch ?? fillChar;
    }
    rows.push(row);
  }
  const inside = (x: number, y: number): boolean =>
    x - offsetX >= 0 && y - offsetY >= 0 && x - offsetX < width && y - offsetY < height;
  const shift = <T extends { x: number; y: number }>(list: T[]): T[] =>
    list.filter((i) => inside(i.x, i.y)).map((i) => ({ ...i, x: i.x - offsetX, y: i.y - offsetY }));

  const droppedAssets = area.assets.length;
  const droppedStations = area.stations.length;
  const droppedNodes = area.nodes.length;
  const droppedExits = area.transitions.length;
  const droppedRoofs = area.roofs.length;

  area.width = width;
  area.height = height;
  area.tiles = rows;
  area.assets = shift(area.assets);
  area.stations = shift(area.stations);
  area.nodes = shift(area.nodes);
  area.transitions = shift(area.transitions);
  // Roofs are tiles too, and a roof tile off the edge of the map fails the
  // schema — the resize has to carry them like everything else.
  area.roofs = shift(area.roofs);
  // The spawn cannot be dropped — it has to be somewhere, so it is clamped
  // and then walked to the nearest tile anybody can stand on.
  area.spawn = {
    x: Math.max(0, Math.min(width - 1, area.spawn.x - offsetX)),
    y: Math.max(0, Math.min(height - 1, area.spawn.y - offsetY)),
  };
  if (!area.legend[area.tiles[area.spawn.y]![area.spawn.x]!]!.walkable) {
    outer: for (let r = 1; r < Math.max(width, height); r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const x = area.spawn.x + dx;
          const y = area.spawn.y + dy;
          const ch = area.tiles[y]?.[x];
          if (ch !== undefined && area.legend[ch]!.walkable) {
            area.spawn = { x, y };
            break outer;
          }
        }
      }
    }
  }
  setDirty(true);
  rebuildAll();
  camTarget.set(area.spawn.x, 0, area.spawn.y);
  const lost = [
    droppedAssets - area.assets.length && `${droppedAssets - area.assets.length} assets`,
    droppedStations - area.stations.length && `${droppedStations - area.stations.length} stations`,
    droppedNodes - area.nodes.length && `${droppedNodes - area.nodes.length} nodes`,
    droppedExits - area.transitions.length && `${droppedExits - area.transitions.length} exits`,
    droppedRoofs - area.roofs.length && `${droppedRoofs - area.roofs.length} roof tiles`,
  ].filter(Boolean);
  return lost.length === 0
    ? `resized to ${width}×${height}, nothing lost`
    : `resized to ${width}×${height} — dropped ${lost.join(', ')}`;
}

/** The tightest rectangle that still holds everything worth keeping. */
function contentBounds(): { x0: number; y0: number; x1: number; y1: number } | null {
  if (!area) return null;
  let x0 = area.width;
  let y0 = area.height;
  let x1 = -1;
  let y1 = -1;
  const note = (x: number, y: number): void => {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y);
    x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  };
  for (let y = 0; y < area.height; y++) {
    for (let x = 0; x < area.width; x++) {
      const def = area.legend[area.tiles[y]![x]!]!;
      if (def.walkable || def.kind !== 'wall') note(x, y);
    }
  }
  for (const a of area.assets) note(Math.round(a.x), Math.round(a.y));
  for (const st of area.stations) note(st.x, st.y);
  for (const n of area.nodes) note(n.x, n.y);
  for (const t of area.transitions) note(t.x, t.y);
  if (x1 < 0) return null;
  // Keep a one-tile border so the crop does not shave the enclosing wall off.
  return {
    x0: Math.max(0, x0 - 1), y0: Math.max(0, y0 - 1),
    x1: Math.min(area.width - 1, x1 + 1), y1: Math.min(area.height - 1, y1 + 1),
  };
}

/**
 * ⚠ Undo REPLACES every placed object, so the selection has to go with it.
 *
 * `area` is restored by parsing a snapshot, which means every `PlacedAsset` in
 * it is a new object. Anything still holding the old reference — `selected`,
 * and therefore the inspector, the mask view, and now turning and raising with
 * shift — would be editing a detached object no longer on the map: the numbers
 * move and nothing happens, which is the worst way for an editor to fail.
 * Clearing it is honest; silently re-pointing it at whatever now occupies that
 * slot would select a different object without saying so.
 */
function undo(): void {
  if (!area || undoStack.length === 0) return;
  redoStack.push(JSON.stringify(area));
  area = JSON.parse(undoStack.pop()!) as AreaDef;
  select(null);
  rebuildAll();
  setDirty(true);
}

function redo(): void {
  if (!area || redoStack.length === 0) return;
  undoStack.push(JSON.stringify(area));
  area = JSON.parse(redoStack.pop()!) as AreaDef;
  select(null);
  rebuildAll();
  setDirty(true);
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

function setStatus(lines: string[], cls: '' | 'bad' | 'good'): void {
  const el = $('status');
  el.className = cls;
  el.innerHTML = lines.length === 0
    ? ''
    : lines.length === 1
      ? lines[0]!
      : `${lines[0]}<ul>${lines.slice(1).map((l) => `<li>${l}</li>`).join('')}</ul>`;
}

async function save(): Promise<void> {
  if (!area) return;
  setStatus(['saving…'], '');
  try {
    // ⚠ The IMAGE goes first, and the area's reference to it second. Written
    // the other way round, a save that failed halfway would leave an area
    // naming a picture that is not there — which CI refuses, so the map would
    // not build until somebody worked out why.
    if (paintDirty && groundBrush) {
      if (groundBrush.painted) {
        const png = await fetch(`${API}/paint/${area.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pngs: groundBrush.toDataUrls() }),
        });
        const got = (await png.json()) as { saved?: string[]; error?: string };
        if (!got.saved) {
          setStatus([`the painted ground was refused: ${got.error ?? 'unknown'}`], 'bad');
          return;
        }
        area.groundPaint = got.saved;
        // ⚠ The channel order goes WITH the images. A mask is meaningless
        // without it: red means "this much of the first material", and which
        // one that was is not recoverable from the pixels.
        area.groundMaterials = groundBrush.materials.map((m) => m.id);
      } else {
        // ⚠ Rubbing out the last material UNPAINTS the area. Leaving the old
        // reference in place would have the game load a mask the editor has
        // already thrown away, and the map would render its last save
        // forever — which looks exactly like the painter not working.
        delete area.groundPaint;
        area.groundMaterials = [];
      }
      paintDirty = false;
    }
    const res = await fetch(`${API}/areas/${area.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(area),
    });
    const result = (await res.json()) as { ok: boolean; errors?: string[]; crossArea?: string[] };
    if (!result.ok) {
      setStatus(['REFUSED — nothing was written:', ...(result.errors ?? [])], 'bad');
      return;
    }
    original = JSON.stringify(area);
    setDirty(false);
    if (result.crossArea && result.crossArea.length > 0) {
      setStatus(
        ['saved, but the content check has something to say:', ...result.crossArea],
        'bad',
      );
    } else {
      setStatus(
        [`saved ${area.id} — ${area.assets.length} assets`
          + `${area.groundPaint ? ', ground painted' : ''}, content valid`],
        'good',
      );
    }
  } catch (err) {
    setStatus([`could not reach the editor server: ${String(err)}`], 'bad');
  }
}

function revert(): void {
  if (!original) return;
  if (dirty && !confirm('Throw away every change since the last save?')) return;
  area = JSON.parse(original) as AreaDef;
  undoStack.length = 0;
  redoStack.length = 0;
  setDirty(false);
  rebuildAll();
  setStatus(['reverted to the file on disk'], '');
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

function chip(label: string, on: boolean, onClick: () => void, swatch?: string): HTMLElement {
  const el = document.createElement('button');
  el.className = `chip${on ? ' on' : ''}`;
  el.innerHTML = swatch ? `<span class="sw" style="background:${swatch}"></span>${label}` : label;
  el.addEventListener('click', () => {
    onClick();
    renderPanel();
  });
  return el;
}

function renderPanel(): void {
  const tools = $('tools');
  tools.innerHTML = '';
  for (const t of ['select', 'asset', 'paint', 'station', 'node', 'npc', 'spawn', 'exit', 'roof'] as Tool[]) {
    tools.appendChild(chip(t, tool === t, () => { tool = t; }));
  }

  const opts = $('tool-options');
  opts.innerHTML = '';
  const section = (title: string): HTMLElement => {
    const h = document.createElement('h2');
    h.textContent = title;
    opts.appendChild(h);
    const chips = document.createElement('div');
    chips.className = 'chips';
    opts.appendChild(chips);
    return chips;
  };

  if (tool === 'select') {
    renderSelectTool(opts);
  } else if (tool === 'paint') {
    renderPaintTool(opts);
  } else if (tool === 'asset') {
    renderAssetTool(opts);
  } else if (tool === 'station') {
    const chips = section('Facility');
    for (const t of stationTypes) {
      chips.appendChild(chip(t, stationType === t, () => { stationType = t; }));
    }
  } else if (tool === 'node') {
    const chips = section('Resource');
    for (const t of nodeTypes) {
      chips.appendChild(chip(t, nodeType === t, () => { nodeType = t; }));
    }
  } else if (tool === 'npc') {
    const chips = section('Who');
    for (const t of npcTypes) {
      chips.appendChild(chip(t, npcType === t, () => { npcType = t; }));
    }
    const note = document.createElement('div');
    note.className = 'hint';
    note.innerHTML = npcTypes.length === 0
      ? 'Nobody is defined yet. People are written in the creation tool under '
        + '<b>Interactive → people</b>, and placed here.'
      : 'Click a walkable tile to stand somebody there, right-click to take them '
        + 'away. <b>Who</b> they are is content (<code>content/npcs/</code>); this '
        + 'is only <b>where</b>. What they DO is still a script — a script reaches '
        + 'one with <code>npc("id")</code>, and the build refuses a script asking '
        + 'for somebody its area does not place.';
    opts.appendChild(note);
  } else if (tool === 'spawn') {
    const note = document.createElement('div');
    note.className = 'hint';
    note.textContent = 'Click a walkable tile to move where characters arrive.';
    opts.appendChild(note);
  } else if (tool === 'exit') {
    renderExitTool(opts);
  } else if (tool === 'roof') {
    const chips = section('Roofing');
    const styles: typeof roofStyle[] = ['thatch', 'tile', 'slate', 'plank'];
    for (const st of styles) {
      chips.appendChild(chip(st, roofStyle === st, () => { roofStyle = st; }));
    }
    const note = document.createElement('div');
    note.className = 'hint';
    note.innerHTML = 'Paint where the roof IS and the shape follows: touching '
      + 'tiles become one building, and the ridge runs along its longer side. '
      + 'In the game a roof lifts away when somebody walks under it; here it '
      + 'always stays up so you can see what you are painting.';
    opts.appendChild(note);
  }

  if (tool === 'roof') {
    const chips = section('Brush');
    for (const size of [1, 3, 5, 7]) {
      chips.appendChild(chip(`${size}×${size}`, brush === size, () => { brush = size; }));
    }
  }
}

/**
 * The exit tool: where a doorway leads, and the ones already here.
 *
 * An exit is one-way in the data — the way BACK is a transition in the other
 * area — so the panel says so. Half of all door bugs are a door that only
 * works in one direction, and a single file cannot tell you that on its own.
 */
/**
 * The asset browser (D-566).
 *
 * ⚠ 1,402 assets cannot be a chip list. The prop palette was 44 in eight named
 * groups and worked because it was small; this needs a pack, a search box and
 * a cap on what is drawn, or picking a wall means scrolling past six hundred
 * dungeon props.
 */

/**
 * The ground painter's controls (D-585).
 *
 * ⚠ Radius is in METRES, not pixels, because the thing being judged is how
 * big the stroke is ON THE MAP. A pixel radius would mean a different brush at
 * every zoom, which is the same mistake as sizing a gate opening by eye.
 */

/** Where the last dab landed, so a stroke is a line rather than a row of dots. */
let lastDab: { x: number; y: number } | null = null;

/**
 * Paint from the last dab to this one.
 *
 * ⚠ INTERPOLATED. A pointer reports a handful of positions a second and a fast
 * drag jumps metres between them, so dabbing only where the events land draws
 * a string of discs with gaps between — which reads as a broken brush rather
 * than as a fast stroke. Stepping along the gap at a fraction of the radius is
 * what makes it a stroke.
 */
function paintAt(x: number, y: number, erase: boolean): void {
  if (!groundBrush) return;
  const mat = groundMats.find((m) => m.id === groundPick) ?? groundMats[0];
  if (!mat) return;
  const from = lastDab ?? { x, y };
  const dx = x - from.x;
  const dy = y - from.y;
  const span = Math.hypot(dx, dy);
  // A quarter of the radius keeps consecutive dabs overlapping heavily, which
  // is what stops a soft edge showing up as banding along the stroke.
  const step = Math.max(0.05, brushRadius * 0.25);
  const steps = Math.max(1, Math.ceil(span / step));
  for (let i = 1; i <= steps; i++) {
    const px = from.x + (dx * i) / steps;
    const py = from.y + (dy * i) / steps;
    if (erase) {
      groundBrush.erase(px, py, brushRadius, brushSoftness, brushStrength);
    } else if (groundBrush.dab(mat, px, py, brushRadius, brushSoftness, brushStrength) === 'full') {
      // ⚠ Said out loud, and the stroke stops. An area's two masks hold six
      // materials; a seventh has nowhere to go, and painting nothing silently
      // is the worst answer — the brush would just look broken.
      //
      // ⚠ This used to say "rub one out completely to free its channel", which
      // was FALSE ADVICE: a layer was added on first use and never removed, so
      // an erased material still held its channel and there was no way at all
      // to free one. Removing is now a button, under In use below.
      setStatus([
        `This map already uses all ${SPLAT_CHANNELS} ground materials: `
        + `${groundBrush.materials.map((m) => m.name).join(', ')}.`,
        'Remove one under "In use on this map", or paint with one of those.',
      ], 'bad');
      lastDab = null;
      return;
    }
  }
  lastDab = { x, y };
  paintDirty = true;
  setDirty(true);
}

function renderPaintTool(opts: HTMLElement): void {
  if (groundMats.length === 0) {
    const none = document.createElement('div');
    none.className = 'hint';
    none.textContent = 'No ground materials yet — add files to content/ground/.';
    opts.appendChild(none);
    return;
  }
  const head = document.createElement('h2');
  head.textContent = 'Material';
  opts.appendChild(head);
  const row = document.createElement('div');
  row.className = 'chips';
  for (const mat of groundMats) {
    const chipEl = document.createElement('span');
    chipEl.className = `chip${groundPick === mat.id ? ' on' : ''}`;
    chipEl.innerHTML =
      `<span style="display:inline-block;width:9px;height:9px;margin-right:4px;`
      + `background:${mat.tint};border:1px solid #0006"></span>${mat.name}`
      + (mat.texture ? '' : ' <i style="opacity:.5">flat</i>');
    chipEl.title = mat.texture
      ? `${mat.name} — ${mat.texture}`
      : `${mat.name} — no texture yet, painted as its tint`;
    chipEl.onclick = () => {
      groundPick = mat.id;
      renderPanel();
    };
    row.appendChild(chipEl);
  }
  opts.append(row);

  renderMaterialEditor(opts);
  renderMaterialsInUse(opts);

  const brushHead = document.createElement('h2');
  brushHead.textContent = 'Brush';
  opts.appendChild(brushHead);
  slider(opts, 'size', brushRadius, 0.5, 12, 0.5, 'm', (v) => { brushRadius = v; });
  slider(opts, 'soft edge', brushSoftness, 0, 1, 0.05, '', (v) => { brushSoftness = v; });
  slider(opts, 'strength', brushStrength, 0.05, 1, 0.05, '', (v) => { brushStrength = v; });

  const note = document.createElement('div');
  note.className = 'hint';
  note.innerHTML =
    '<b>Drag</b> to paint, <b>right-drag</b> to rub out. The edge is soft, so two '
    + 'materials blend where they meet rather than butting on a tile boundary. '
    + 'A material with no texture paints as its tint — lay the ground out now, '
    + 'and it gains its surface when the art lands, without repainting. '
    + 'Textures go in <b>client/public/textures/ground/</b>.';
  opts.appendChild(note);
}

/**
 * Author a ground material (D-597).
 *
 * ⚠ Ground was the last thing in `content/` that could be PAINTED WITH and
 * never authored. Thirteen materials shipped and a fourteenth meant hand-
 * writing JSON beside an image nothing listed -- in the one tool whose whole
 * premise is that what you place is what you get (D-543).
 *
 * ⚠ `tint` and `wash` are two controls because they are two jobs (D-590):
 * the tint stands in for art that is missing, the wash multiplies art that is
 * there. One field doing both is what once rendered mud at an albedo of 0.107
 * and made the whole town read as bad lighting, so the panel names them apart
 * and says which is which.
 *
 * ⚠ Written as you go, not on Save. Save writes the MAP, and a material is
 * not part of one -- a change to grass belongs to every area painted with it.
 * The status line says which file each change reached.
 */
function renderMaterialEditor(opts: HTMLElement): void {
  const mat = groundMats.find((m) => m.id === groundPick);
  const head = document.createElement('h2');
  head.textContent = mat ? `Edit — ${mat.name}` : 'Materials';
  opts.appendChild(head);

  const bar = document.createElement('div');
  bar.className = 'chips';
  const fresh = document.createElement('button');
  fresh.textContent = '+ New material';
  fresh.className = 'small';
  fresh.onclick = () => {
    const name = prompt('Name the material (what a person calls it)');
    if (!name?.trim()) return;
    const id = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!id) return setStatus(['that name has no letters or digits in it'], 'bad');
    if (groundMats.some((m) => m.id === id)) {
      return setStatus([`there is already a material called ${id}`], 'bad');
    }
    // A new material is FLAT and walkable: no texture, the default tint. It can
    // be painted with at once and gains a surface when one is picked, which is
    // the promise the painter already makes for art that has not landed.
    groundMats = [...groundMats, {
      id, name: name.trim(), repeat: 1, tint: '#6b7a55', wash: '#ffffff', walkable: true,
    }].sort((a, b) => a.name.localeCompare(b.name));
    groundPick = id;
    void saveMaterial(id);
    renderPanel();
  };
  bar.appendChild(fresh);
  if (mat) {
    const del = document.createElement('button');
    del.textContent = 'Delete';
    del.className = 'small';
    del.onclick = () => {
      if (!confirm(`Delete the material "${mat.name}"? Its file is removed from content/ground.`)) return;
      void (async () => {
        const res = await fetch(`${API}/ground/${mat.id}`, { method: 'DELETE' });
        const got = (await res.json()) as { ok: boolean; errors?: string[] };
        if (!got.ok) return setStatus(['REFUSED:', ...(got.errors ?? [])], 'bad');
        groundMats = groundMats.filter((m) => m.id !== mat.id);
        groundPick = groundMats[0]?.id ?? null;
        setStatus([`${mat.name} deleted`], 'good');
        renderPanel();
      })();
    };
    bar.appendChild(del);
  }
  opts.appendChild(bar);
  if (!mat) return;

  const field = (label: string, el: HTMLElement): void => {
    const wrap = document.createElement('div');
    wrap.className = 'app-row';
    const lab = document.createElement('span');
    lab.style.cssText = 'flex:1;font-size:11.5px';
    lab.textContent = label;
    wrap.append(lab, el);
    opts.appendChild(wrap);
  };
  const commit = (): void => { void saveMaterial(mat.id); };

  const nameIn = document.createElement('input');
  nameIn.type = 'text';
  nameIn.value = mat.name;
  nameIn.style.width = '55%';
  nameIn.oninput = () => { mat.name = nameIn.value; };
  nameIn.onchange = commit;
  field('called', nameIn);

  const texSel = document.createElement('select');
  texSel.add(new Option('none — flat tint', ''));
  for (const t of groundTextureFiles) texSel.add(new Option(t, t));
  texSel.value = mat.texture ?? '';
  texSel.onchange = () => {
    if (texSel.value) mat.texture = texSel.value;
    else delete mat.texture;
    commit();
    renderPanel();
  };
  field('texture', texSel);

  const rep = document.createElement('input');
  rep.type = 'number';
  rep.step = '0.01';
  rep.min = '0.01';
  rep.value = String(mat.repeat);
  rep.style.width = '72px';
  // ⚠ Per TILE, not per area, or a map that grows stretches its grass.
  rep.onchange = () => {
    const v = Number(rep.value);
    if (!(v > 0)) return setStatus(['repeats per tile must be greater than zero'], 'bad');
    mat.repeat = v;
    commit();
  };
  field('repeats per tile', rep);

  const tint = document.createElement('input');
  tint.type = 'color';
  tint.value = mat.tint;
  tint.onchange = () => { mat.tint = tint.value; commit(); renderPanel(); };
  field('tint (no art)', tint);

  const wash = document.createElement('input');
  wash.type = 'color';
  wash.value = mat.wash;
  wash.onchange = () => { mat.wash = wash.value; commit(); };
  field('wash (over art)', wash);

  const walk = document.createElement('input');
  walk.type = 'checkbox';
  walk.checked = mat.walkable;
  walk.onchange = () => { mat.walkable = walk.checked; commit(); };
  field('walkable', walk);

  const notes = document.createElement('input');
  notes.type = 'text';
  notes.value = mat.notes ?? '';
  notes.style.width = '55%';
  notes.oninput = () => {
    if (notes.value.trim()) mat.notes = notes.value;
    else delete mat.notes;
  };
  notes.onchange = commit;
  field('notes', notes);

  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.innerHTML = '<b>tint</b> is what this paints as when it has no texture. '
    + '<b>wash</b> multiplies over the texture when it has one -- leave it white '
    + 'unless you want a bleached or greener cut of the same art. '
    + '<b>walkable</b> is authored here and the server does not read it: where a '
    + 'body may stand is the tiles and the collision volumes, or painting a map '
    + 'would silently re-cut it. Changes are written to <b>content/ground/</b> '
    + 'as you make them -- Save writes the map, not these.';
  opts.appendChild(hint);
}

/** Write one material, and say so or say why not. */
async function saveMaterial(id: string): Promise<void> {
  const mat = groundMats.find((m) => m.id === id);
  if (!mat) return;
  try {
    const res = await fetch(`${API}/ground/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mat),
    });
    const got = (await res.json()) as { ok: boolean; errors?: string[] };
    if (!got.ok) return setStatus(['the material was REFUSED:', ...(got.errors ?? [])], 'bad');
    setStatus([`${mat.name} written to content/ground/${id}.json`], 'good');
  } catch (err) {
    setStatus([`could not reach the editor server: ${String(err)}`], 'bad');
  }
}

/**
 * What this map is painted with, and the way to take one off it (D-588).
 *
 * ⚠ This exists because the editor gave advice it could not honour. The mask
 * has a fixed number of channels, a material claimed one on first use and
 * never gave it back, and the "all materials used" message told people to rub
 * one out to free its channel — which did nothing. Erasing paint and removing
 * a MATERIAL are different acts, and only one of them was ever possible.
 *
 * ⚠ The share is measured from the masks, not counted from strokes. A material
 * painted and then covered over reads as 0% and is exactly the one worth
 * removing, and nothing but the pixels knows that.
 */
function renderMaterialsInUse(opts: HTMLElement): void {
  const brush = groundBrush;
  if (!brush || brush.materials.length === 0) return;
  const head = document.createElement('h2');
  head.textContent = `In use on this map (${brush.materials.length}/${SPLAT_CHANNELS})`;
  opts.appendChild(head);

  const cover = new Map(brush.coverage().map((c) => [c.id, c.share]));
  for (const mat of brush.materials) {
    const row = document.createElement('div');
    row.className = 'app-row';
    const share = cover.get(mat.id) ?? 0;
    const swatch = `<span style="display:inline-block;width:9px;height:9px;`
      + `margin-right:5px;background:${mat.tint};border:1px solid #0006"></span>`;
    const label = document.createElement('span');
    label.style.cssText = 'flex:1;font-size:11.5px';
    label.innerHTML = `${swatch}${mat.name} `
      + `<i style="opacity:.55">${(share * 100).toFixed(share < 0.1 ? 1 : 0)}%</i>`;
    const drop = document.createElement('button');
    drop.textContent = 'remove';
    drop.className = 'small';
    drop.title = `Take ${mat.name} off this map and free its channel`;
    drop.onclick = () => {
      // ⚠ Confirmed, and the confirmation says what it costs. This is not an
      // undo-able stroke: it erases every trace of that material across the
      // whole map, and the paint underneath does not come back.
      const painted = (cover.get(mat.id) ?? 0) > 0;
      if (painted && !confirm(
        `Remove ${mat.name} from this map?

`
        + 'Everywhere it is painted goes back to bare ground, and its channel '
        + 'is freed for another material. This cannot be undone.',
      )) return;
      if (!brush.removeMaterial(mat.id)) return;
      paintDirty = true;
      setDirty(true);
      setStatus([`${mat.name} removed — ${brush.materials.length} of `
        + `${SPLAT_CHANNELS} channels in use. Save to write it.`], 'good');
      renderPanel();
    };
    row.append(label, drop);
    opts.appendChild(row);
  }
}

/** A labelled slider that shows its own value. */
function slider(
  host: HTMLElement,
  label: string,
  value: number,
  min: number,
  max: number,
  step: number,
  unit: string,
  set: (v: number) => void,
): void {
  const wrap = document.createElement('div');
  wrap.className = 'app-row';
  const name = document.createElement('label');
  name.textContent = label;
  name.style.cssText = 'width:72px;font-size:11.5px;color:var(--dim)';
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.style.flex = '1';
  const read = document.createElement('span');
  read.style.cssText = 'width:46px;text-align:right;font-family:monospace;font-size:11px';
  read.textContent = `${value}${unit}`;
  input.oninput = () => {
    const v = Number(input.value);
    read.textContent = `${v}${unit}`;
    set(v);
  };
  wrap.append(name, input, read);
  host.appendChild(wrap);
}

function renderAssetTool(opts: HTMLElement): void {
  const packRow = document.createElement('div');
  packRow.className = 'chips';
  for (const p of assetPacks) {
    packRow.appendChild(chip(p, assetPack === p, () => void selectAssetPack(p)));
  }
  const ph = document.createElement('h2');
  ph.textContent = 'Pack';
  opts.append(ph, packRow);

  const search = document.createElement('input');
  search.placeholder = 'search — wall, door, tree…';
  search.value = assetSearch;
  search.style.cssText = 'width:100%;margin:8px 0 4px';
  search.oninput = () => {
    assetSearch = search.value;
    renderAssetList(opts);
  };
  opts.appendChild(search);

  const list = document.createElement('div');
  list.id = 'asset-list';
  opts.appendChild(list);
  renderAssetList(opts);

  const snapH = document.createElement('h2');
  snapH.textContent = 'Snap';
  const snapRow = document.createElement('div');
  snapRow.className = 'chips';
  for (const v of [0, 0.25, 0.5, 1]) {
    snapRow.appendChild(
      chip(v === 0 ? 'off' : `${v}m`, snap === v, () => { snap = v; renderPanel(); }),
    );
  }
  opts.append(snapH, snapRow);

  const note = document.createElement('div');
  note.className = 'hint';
  note.innerHTML =
    '<b>Drag</b> to lay a run of them end to end; click for one. ' +
    `Rotation <b>${Math.round(assetRot)}°</b> — <b>shift-drag</b>, or <b>R</b> for 15°. ` +
    `Height <b>${assetZ.toFixed(2)}m</b> — <b>shift-wheel</b>. ` +
    '<b>X</b> looks at what is already placed and comes back to this brush. ' +
    'A ■ marks something that blocks movement; the save is refused if one seals ' +
    'an area off. Right-click erases.';
  opts.appendChild(note);

}

function renderAssetList(opts: HTMLElement): void {
  const host = opts.querySelector('#asset-list') as HTMLElement | null;
  if (!host) return;
  host.innerHTML = '';
  const q = assetSearch.trim().toLowerCase();
  const matches = assetList.filter(
    (a) => !q || a.name.toLowerCase().includes(q) || a.mesh.toLowerCase().includes(q),
  );
  const count = document.createElement('div');
  count.className = 'hint';
  count.textContent = `${matches.length} of ${assetList.length}${matches.length > 120 ? ' — showing the first 120' : ''}`;
  host.appendChild(count);

  const chips = document.createElement('div');
  chips.className = 'chips';
  for (const a of matches.slice(0, 120)) {
    const el = chip(
      `${a.name} ${a.footprint[0]}×${a.footprint[1]}`,
      assetPick?.id === a.id,
      () => {
        assetPick = a;
        renderPanel();
      },
    );
    if (a.solid) el.classList.add('solid');
    el.title = `${a.mesh} — ${a.solid ? 'blocks movement' : 'walkable'}, ${a.opaque ? 'blocks sight' : 'see-through'}`;
    chips.appendChild(el);
  }
  host.appendChild(chips);
}

/** What this map may place, from content (D-530). */
async function loadPalette(): Promise<void> {
  try {
    const p = (await (await fetch(`${API}/palette`)).json()) as {
      stations: string[];
      nodes: string[];
      npcs?: string[];
      cues?: string[];
      scripts?: string[];
    };
    if (p.stations.length) stationTypes = p.stations;
    if (p.nodes.length) nodeTypes = p.nodes;
    npcTypes = p.npcs ?? [];
    if (!npcTypes.includes(npcType)) npcType = npcTypes[0] ?? '';
    cueIds = p.cues ?? [];
    scriptIds = p.scripts ?? [];
    if (!stationTypes.includes(stationType)) stationType = stationTypes[0]!;
    if (!nodeTypes.includes(nodeType)) nodeType = nodeTypes[0]!;
    renderPanel();
    renderResizePanel();
  } catch {
    // ⚠ The built-in lists stay as the fallback rather than the palette going
    // empty: a tool that offers nothing looks broken, and the editor server
    // being down is a different problem with its own message.
  }
}

async function loadAssetPacks(): Promise<void> {
  try {
    const packs = (await (await fetch(`${STUDIO}/assetpacks`)).json()) as { id: string }[];
    assetPacks = packs.map((p) => p.id);
  } catch (err) {
    // The studio server is a separate process; say so rather than showing an
    // empty palette that looks like a pack with no contents.
    assetPacks = [];
    console.warn(`asset packs unavailable — is the studio server running? ${String(err)}`);
    return;
  }
  // ⚠ EVERY pack is indexed, and it happens on LOAD rather than on selection.
  // An area names its assets by `pack/id` and may mix packs, so indexing only
  // the pack the palette happens to be showing draws half a map — and indexing
  // none of them, which is what this used to do, draws none of it.
  await Promise.all(assetPacks.map((p) => indexPack(p)));
  if (assetPacks.length) await selectAssetPack(assetPacks[0]!);
  // The area finishes loading long before the packs do; rebuild so whatever is
  // already placed picks up the mesh it has been waiting for.
  if (area) rebuildProps();
}

/** `pack/id` → the mesh stem and the pack's atlases, for every placed asset. */
async function indexPack(id: string): Promise<void> {
  try {
    const file = AssetFileSchema.parse(
      await (await fetch(`${STUDIO}/assets/${encodeURIComponent(id)}/environment`)).json(),
    );
    const cat = (await (await fetch(`${STUDIO}/assetpacks/${encodeURIComponent(id)}`)).json()) as {
      textures: string[];
    };
    for (const a of file.assets) {
      assetIndex.set(`${id}/${a.id}`, { mesh: a.mesh, textures: cat.textures });
    }
  } catch (err) {
    // ⚠ Never silent. One pack failing must not stop the rest, but a swallowed
    // failure here has exactly one symptom — every placed wall drawing nothing
    // — and that reads as a renderer fault rather than a missing catalogue.
    console.warn(`could not index ${id}: ${String(err)}`);
  }
}

async function selectAssetPack(id: string): Promise<void> {
  assetPack = id;
  assetPick = null;
  try {
    const file = AssetFileSchema.parse(
      await (await fetch(`${STUDIO}/assets/${encodeURIComponent(id)}/environment`)).json(),
    );
    assetList = file.assets.filter((a): a is EnvironmentAsset => a.kind === 'environment');
    const cat = (await (await fetch(`${STUDIO}/assetpacks/${encodeURIComponent(id)}`)).json()) as {
      textures: string[];
    };
    assetTextures = cat.textures;
  } catch (err) {
    assetList = [];
    assetTextures = [];
    console.warn(`could not load pack ${id}: ${String(err)}`);
  }
  renderPanel();
}

function renderExitTool(opts: HTMLElement): void {
  if (!area) return;
  const h = document.createElement('h2');
  h.textContent = 'Leads to';
  opts.appendChild(h);

  const select = document.createElement('select');
  if (!exitTarget && areaIndex.length > 0) {
    exitTarget = areaIndex.find((a) => a.id !== area!.id)?.id ?? areaIndex[0]!.id;
  }
  select.innerHTML = areaIndex
    .map((a) => `<option value="${a.id}"${a.id === exitTarget ? ' selected' : ''}>${a.name} — ${a.id}</option>`)
    .join('');
  select.value = exitTarget;
  select.addEventListener('change', () => { exitTarget = select.value; });
  opts.appendChild(select);

  const coords = document.createElement('div');
  coords.className = 'row';
  const pair: [string, () => number, (v: number) => void][] = [
    ['to x', () => exitToX, (v) => { exitToX = v; }],
    ['to y', () => exitToY, (v) => { exitToY = v; }],
  ];
  for (const [label, get, set] of pair) {
    const wrap = document.createElement('div');
    wrap.style.flex = '1';
    const lab = document.createElement('div');
    lab.className = 'grouphead';
    lab.textContent = label;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = String(get());
    input.addEventListener('change', () => {
      const n = Number(input.value);
      if (Number.isFinite(n) && n >= 0) set(Math.floor(n));
    });
    wrap.append(lab, input);
    coords.appendChild(wrap);
  }
  opts.appendChild(coords);

  const note = document.createElement('div');
  note.className = 'hint';
  note.innerHTML = 'Click a walkable tile to put an exit there (clicking an '
    + 'existing one repoints it); right-click removes. <b>Exits are one-way</b> — '
    + 'the way back is a transition in the other area, so place that one too.';
  opts.appendChild(note);

  const h2 = document.createElement('h2');
  h2.textContent = `Exits here (${area.transitions.length})`;
  opts.appendChild(h2);
  for (const t of area.transitions) {
    const row = document.createElement('div');
    row.className = 'hint';
    row.style.marginTop = '3px';
    row.innerHTML = `(${t.x},${t.y}) &rarr; <b>${t.toArea}</b> (${t.toX},${t.toY}) `;
    const jump = document.createElement('button');
    jump.className = 'chip';
    jump.textContent = 'go';
    jump.addEventListener('click', () => { camTarget.set(t.x, 0, t.y); });
    row.appendChild(jump);
    opts.appendChild(row);
  }
}

/**
 * The resize panel. Deliberately not one of the paint tools: it is a single
 * decision about the whole map, it can throw work away, so it asks first and
 * then says exactly what it dropped.
 */
function renderResizePanel(): void {
  const host = $('resize-panel');
  host.innerHTML = '';
  if (!area) return;

  // ⚠ The live/test flag sits at the TOP of the map-level panel, above
  // resizing, because it is a statement about what this file IS and everything
  // below it is a change to the file's contents. It gates nothing (see the
  // schema note) — a flag that silently changed how an area played would make
  // a test map stop testing the thing it was built to test.
  const liveHead = document.createElement('h2');
  liveHead.textContent = 'This map';
  const liveRow = document.createElement('div');
  liveRow.className = 'chips';
  const setLive = (on: boolean): void => {
    if (!area || area.live === on) return;
    area.live = on;
    setDirty(true);
    renderResizePanel();
    // ⚠ The option's marker is updated IN PLACE rather than by re-fetching the
    // list. The flag is not saved yet, and a refresh would redraw it from the
    // file on disk — showing the old marker beside a panel showing the new
    // one, which is the editor disagreeing with itself.
    const opt = $<HTMLSelectElement>('area-select').selectedOptions[0];
    if (opt) {
      opt.dataset.live = String(on);
      opt.textContent = `${on ? '● ' : '○ '}${opt.textContent!.replace(/^[●○]\s*/, '')}`;
    }
  };
  liveRow.appendChild(chip('● in the game', area.live === true, () => setLive(true)));
  liveRow.appendChild(chip('○ for testing', area.live !== true, () => setLive(false)));
  const liveNote = document.createElement('div');
  liveNote.className = 'hint';
  liveNote.textContent = area.live === true
    ? 'Part of a real game loop. It shows with a ● in the map list.'
    : 'A place to try things. Nothing here is expected to reach a player.';
  host.append(liveHead, liveRow, liveNote);

  /*
   * What this map IS, rather than what is in it.
   *
   * ⚠ Every one of these has a schema default and every default points the
   * quiet way. `outdoor` is false, `zone` is settled, `lighting` is overcast,
   * `ambience` is absent and `scripts` is empty — so a wilderness area drawn
   * here and saved paid no night bonus (D-528), carried the settled zone's
   * hostility and corpse rules (D-206), and was silent (D-541). None of that
   * is visible on the map and all of it was hand-edited JSON, which is the
   * worst combination: a tool that produces a wrong file without saying so.
   *
   * ⚠ The defaults themselves are NOT changed. D-527 chose their direction
   * deliberately — forgetting `outdoor` on open ground is wrong and visible in
   * play, while the opposite default pays every cellar the night bonus and is
   * wrong and invisible. The fix is to make them askable, not to guess better.
   */
  const group = (title: string): HTMLElement => {
    const h = document.createElement('h2');
    h.textContent = title;
    host.appendChild(h);
    const chips = document.createElement('div');
    chips.className = 'chips';
    host.appendChild(chips);
    return chips;
  };
  const hint = (text: string): void => {
    const n = document.createElement('div');
    n.className = 'hint';
    n.textContent = text;
    host.appendChild(n);
  };

  const nameHead = document.createElement('h2');
  nameHead.textContent = 'Called';
  const nameIn = document.createElement('input');
  nameIn.type = 'text';
  nameIn.value = area.name;
  nameIn.addEventListener('input', () => {
    if (!area) return;
    area.name = nameIn.value;
    setDirty(true);
  });
  host.append(nameHead, nameIn);
  hint('What a player is told this place is called. The id never changes.');

  // ⚠ Applied to the VIEW as well as the file. The editor renders through the
  // game's own lighting (D-543), so choosing `night` here should look like
  // night here — otherwise the profile is a word in a form and nobody can
  // judge whether an area reads at all after dusk.
  const lightRow = group('Light');
  for (const l of ['overcast', 'night', 'underground', 'interior'] as const) {
    lightRow.appendChild(chip(l, area.lighting === l, () => {
      if (!area || area.lighting === l) return;
      area.lighting = l;
      scene.applyLighting(l);
      setDirty(true);
      renderResizePanel();
    }));
  }
  hint('How it is lit. A rendering profile only — it never decides danger.');

  // ⚠ SEPARATE from the light, and the schema says why at length: tying how
  // an area looks to whether night reaches it breaks the first bright cavern
  // or gloomy field somebody authors.
  const skyRow = group('Does the sky reach here?');
  skyRow.appendChild(chip('under the sky', area.outdoor === true, () => {
    if (!area || area.outdoor === true) return;
    area.outdoor = true; setDirty(true); renderResizePanel();
  }));
  skyRow.appendChild(chip('indoors or below', area.outdoor !== true, () => {
    if (!area || area.outdoor === false) return;
    area.outdoor = false; setDirty(true); renderResizePanel();
  }));
  hint(area.outdoor === true
    ? 'Roamers walk it after dusk and what is earned here pays 1.5x at night.'
    : 'Night never reaches it: no roamers, no night bonus, whatever the light says.');

  const zoneRow = group('Zone');
  for (const z of ['settled', 'wilderness', 'endgame'] as const) {
    zoneRow.appendChild(chip(z, area.zone === z, () => {
      if (!area || area.zone === z) return;
      area.zone = z;
      setDirty(true);
      renderResizePanel();
    }));
  }
  hint(
    area.zone === 'endgame'
      ? 'PERMADEATH. A character killed here is gone for good — never use it for a round map.'
      : area.zone === 'wilderness'
        ? 'Open: no declared hostility, and a corpse here wears everything it carried.'
        : 'Settled: hostility must be declared and spoken, and corpses keep their gear.',
  );

  // ⚠ Ambience cues only, and picked from a list rather than typed. A bed
  // naming a cue that does not exist fails CI (D-541), and an `effect` cue is
  // a sword hitting somebody — named as a bed it would loop forever.
  const cueRow = group('Ambience');
  cueRow.appendChild(chip('silent', area.ambience === undefined, () => {
    if (!area || area.ambience === undefined) return;
    delete area.ambience;
    setDirty(true);
    renderResizePanel();
  }));
  for (const c of cueIds) {
    cueRow.appendChild(chip(c.replace(/^ambience-/, ''), area.ambience === c, () => {
      if (!area || area.ambience === c) return;
      area.ambience = c;
      setDirty(true);
      renderResizePanel();
    }));
  }
  hint(cueIds.length === 0
    ? 'No cues loaded — the editor server may be down, which is not the same as an area having no bed.'
    : 'The bed that plays here. Silence is a real choice, not an oversight.');

  const scriptRow = group('Scripts');
  for (const sid of scriptIds) {
    const on = (area.scripts ?? []).includes(sid);
    scriptRow.appendChild(chip(sid, on, () => {
      if (!area) return;
      const list = new Set(area.scripts ?? []);
      if (list.has(sid)) list.delete(sid);
      else list.add(sid);
      area.scripts = [...list].sort();
      setDirty(true);
      renderResizePanel();
    }));
  }
  hint(scriptIds.length === 0
    ? 'No scripts found under content/scripts.'
    : 'Lua that runs for this area — this is where scripted NPCs come from.');

  const sizeHead = document.createElement('h2');
  sizeHead.textContent = 'Size';
  host.appendChild(sizeHead);
  const row = document.createElement('div');
  row.className = 'row';
  const mk = (label: string, value: number): HTMLInputElement => {
    const wrap = document.createElement('div');
    wrap.style.flex = '1';
    const lab = document.createElement('div');
    lab.className = 'grouphead';
    lab.textContent = label;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = String(value);
    wrap.append(lab, input);
    row.appendChild(wrap);
    return input;
  };
  const w = mk('width', area.width);
  const hgt = mk('height', area.height);
  const ox = mk('from x', 0);
  const oy = mk('from y', 0);
  host.appendChild(row);

  const apply = document.createElement('button');
  apply.textContent = 'Resize';
  apply.addEventListener('click', () => {
    const width = Math.max(8, Math.min(256, Number(w.value) | 0));
    const height = Math.max(8, Math.min(256, Number(hgt.value) | 0));
    const offX = Number(ox.value) | 0;
    const offY = Number(oy.value) | 0;
    if (!confirm(`Resize to ${width}x${height} from (${offX},${offY})? Anything outside is dropped.`)) return;
    setStatus([resizeArea(width, height, offX, offY)], '');
    renderPanel();
    renderResizePanel();
  });
  host.appendChild(apply);

  const trim = document.createElement('button');
  trim.textContent = 'Trim to content';
  trim.addEventListener('click', () => {
    const b = contentBounds();
    if (!b) return setStatus(['nothing to trim to'], 'bad');
    const width = b.x1 - b.x0 + 1;
    const height = b.y1 - b.y0 + 1;
    if (width === area!.width && height === area!.height) {
      return setStatus(['already as tight as it goes'], '');
    }
    if (!confirm(`Trim to ${width}x${height}?`)) return;
    setStatus([resizeArea(width, height, b.x0, b.y0)], '');
    renderPanel();
    renderResizePanel();
  });
  host.appendChild(trim);

  const note = document.createElement('div');
  note.className = 'hint';
  note.innerHTML = `now <b>${area.width}&times;${area.height}</b>. "from" is the top-left `
    + 'corner of the region kept &mdash; growing a map fills the new ground with floor. '
    + 'Shrinking can orphan an exit that another area points into this one; the '
    + 'save refuses and names it.';
  host.appendChild(note);
}

// ---------------------------------------------------------------------------
// Mouse and camera
// ---------------------------------------------------------------------------

function tileAtScreen(px: number, py: number): { x: number; y: number } | null {
  if (!area) return null;
  const rect = stage.getBoundingClientRect();
  const ndc = new THREE.Vector3(
    ((px - rect.left) / rect.width) * 2 - 1,
    -((py - rect.top) / rect.height) * 2 + 1,
    -1,
  );
  const near = ndc.clone().unproject(scene.camera);
  const far = new THREE.Vector3(ndc.x, ndc.y, 1).unproject(scene.camera);
  const dir = far.sub(near);
  if (Math.abs(dir.y) < 1e-6) return null;
  const k = -near.y / dir.y;
  const x = Math.round(near.x + dir.x * k);
  const y = Math.round(near.z + dir.z * k);
  if (x < 0 || y < 0 || x >= area.width || y >= area.height) return null;
  return { x, y };
}

let drag: {
  x: number; y: number; button: number; moved: boolean; panning: boolean;
  /** Shift-dragging to turn something, rather than to pan or orbit. */
  spinning: boolean;
} | null = null;
let painting = false;
/** Where on the selected object the cursor took hold of it. */
let grab: { dx: number; dy: number } | null = null;
/** Where a wall run started, while one is being dragged out. */
let runFrom: { x: number; y: number } | null = null;

/**
 * What a turn or a lift acts on: the thing being painted, or the thing picked.
 *
 * ⚠ The rule is WHICHEVER ONE IS ON SCREEN, not "the selection if there is
 * one". In the asset tool the ghost is under the cursor and is plainly what
 * the gesture is aimed at; everywhere else the selection is the only thing it
 * could mean. Preferring a stale selection while a preview is being steered
 * would turn a wall somewhere off-screen and look like nothing happened.
 */
function spinTarget(): 'ghost' | 'selected' | null {
  if (tool === 'asset' && assetPick) return 'ghost';
  if (selected) return 'selected';
  return null;
}

/** Turn the live thing by `deg`, clockwise. */
function spinBy(deg: number): void {
  const target = spinTarget();
  if (target === 'ghost') {
    assetRot = (((assetRot + deg) % 360) + 360) % 360;
  } else if (target === 'selected' && selected) {
    editSelected({ rotation: (((selected.rotation + deg) % 360) + 360) % 360 });
  } else {
    return;
  }
  renderPanel();
}

/**
 * When the current run of wheel notches began, so one gesture is one undo.
 *
 * ⚠ A wheel gesture arrives as twenty separate events. Taking a snapshot per
 * event would make Ctrl+Z step back one notch at a time through a lift nobody
 * thinks of as twenty actions — exactly what the painting path already refuses
 * ("one snapshot per stroke, not per tile"). Anything under the idle gap is
 * treated as a continuation of the same lift.
 */
let raisingSince = 0;
const RAISE_GESTURE_MS = 500;

/** Raise or lower the live thing by `dz` metres. */
function raiseBy(dz: number): void {
  const target = spinTarget();
  if (target === 'ghost') {
    // The ghost is not in the document, so there is nothing to undo — the
    // height of the next placement is a setting, like the snap size.
    assetZ = Math.round((assetZ + dz) * 1000) / 1000;
  } else if (target === 'selected' && selected) {
    const now = performance.now();
    if (now - raisingSince > RAISE_GESTURE_MS) snapshot();
    raisingSince = now;
    editSelected({ z: Math.round((selected.z + dz) * 1000) / 1000 });
  } else {
    return;
  }
  renderPanel();
}

stage.addEventListener('contextmenu', (e) => e.preventDefault());

stage.addEventListener('pointerdown', (e) => {
  // ⚠ SHIFT + LEFT-DRAG NOW TURNS THINGS, and it used to pan. Panning is
  // still on middle-drag, which it always was; the help text says so. The
  // trade is deliberate — panning had two bindings and turning a wall to meet
  // another had none but a 15-degree key, and lining two meshes up by eye is
  // the motion a map is actually built out of.
  const spinning = e.button === 0 && e.shiftKey;
  drag = {
    x: e.clientX, y: e.clientY, button: e.button, moved: false,
    panning: e.shiftKey && !spinning,
    spinning,
  };
  // A spin takes the gesture before anything else looks at it: no run opens,
  // no tile is painted, the camera does not orbit.
  if (spinning) {
    if (spinTarget() === 'selected') snapshot();
    return;
  }

  // ⚠ Two tools work in METRES and take the click before the tile path sees
  // it. Rounding first and un-rounding later is how a continuous editor ends
  // up snapping to a grid it no longer has.
  if (tool === 'select') {
    const hit = assetAtScreen(e.clientX, e.clientY);
    select(hit);
    if (hit) {
      const g = groundAtScreen(e.clientX, e.clientY);
      // Grab OFFSET, so the object does not jump its own centre to the cursor
      // the instant you touch it.
      if (g) grab = { dx: g.x - hit.x, dy: g.y - hit.y };
      snapshot();
    }
    return;
  }
  if (tool === 'paint') {
    // ⚠ Painting works in METRES off the ground plane, never in tiles: the
    // whole point of the brush is that it goes where the cursor is rather
    // than snapping to a square.
    const g = groundAtScreen(e.clientX, e.clientY);
    if (g) paintAt(g.x, g.y, e.button === 2);
    return;
  }
  if (tool === 'asset') {
    // ⚠ Erase picks by RAYCAST rather than by mask, so right-clicking the mesh
    // deletes it even when its mask is empty or has a hole where you clicked.
    if (e.button === 2) {
      const hit = assetAtScreen(e.clientX, e.clientY);
      if (hit) {
        snapshot();
        removeAsset(hit);
      }
      return;
    }
    // ⚠ A press does NOT place. It opens a run, and the release decides
    // whether that run was one object or twenty — a click and a drag are the
    // same gesture, which is what makes building a wall one motion.
    runFrom = groundAtScreen(e.clientX, e.clientY);
    return;
  }

  const tile = tileAtScreen(e.clientX, e.clientY);
  if (!tile) return;
  // One snapshot per stroke, not per tile: undo should step back a brush
  // stroke, which is what a person thinks of as one action.
  snapshot();
  painting = true;
  applyAt(tile.x, tile.y, e.button === 2);
});

window.addEventListener('pointermove', (e) => {
  hovered = tileAtScreen(e.clientX, e.clientY);
  // The ghost lives in metres, so it follows the GROUND point rather than the
  // tile the readout shows.
  hoverGround = hovered ? groundAtScreen(e.clientX, e.clientY) : null;
  $('hud-tile').textContent = hovered ? `(${hovered.x}, ${hovered.y})` : '';
  if (!drag) return;
  if (drag.spinning) {
    // Horizontal travel turns it: right is clockwise, which is the way the
    // map's own rotation runs. 0.5 deg/px lands a half turn in a comfortable
    // drag rather than needing a swipe across two monitors.
    spinBy((e.clientX - drag.x) * 0.5);
    drag.x = e.clientX;
    drag.y = e.clientY;
    return;
  }
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) > 3) drag.moved = true;
  if (grab && selected && drag.button === 0) {
    const g = groundAtScreen(e.clientX, e.clientY);
    if (g) editSelected({ x: g.x - grab.dx, y: g.y - grab.dy });
    drag.x = e.clientX;
    drag.y = e.clientY;
    return;
  }
  if (tool === 'paint' && drag.button !== 1 && !drag.spinning) {
    const g = groundAtScreen(e.clientX, e.clientY);
    if (g) paintAt(g.x, g.y, drag.button === 2);
    drag.x = e.clientX;
    drag.y = e.clientY;
    return;
  }
  if (painting && hovered) {
    applyAt(hovered.x, hovered.y, drag.button === 2);
    drag.x = e.clientX;
    drag.y = e.clientY;
    return;
  }
  if (drag.panning || drag.button === 1) {
    // Pan along the camera's own axes, or dragging feels wrong at every
    // orbit angle but one.
    const az = scene.cameraAzimuth;
    const speed = 0.045;
    camTarget.x -= (Math.cos(az) * dy + Math.cos(az + Math.PI / 2) * dx) * speed;
    camTarget.z -= (Math.sin(az) * dy + Math.sin(az + Math.PI / 2) * dx) * speed;
  } else if (drag.button === 0 && !runFrom) {
    scene.rotateBy(dx * 0.008);
  }
  drag.x = e.clientX;
  drag.y = e.clientY;
});

window.addEventListener('pointerup', (e) => {
  // ⚠ Ends the stroke. Without this the next click paints a line from wherever
  // the last one finished — across the whole map, if that is where you clicked.
  lastDab = null;
  if (runFrom) {
    const to = groundAtScreen(e.clientX, e.clientY) ?? runFrom;
    snapshot();
    if (placeRun(runFrom, to) > 0) setDirty(true);
    runFrom = null;
    renderPanel();
  }
  painting = false;
  grab = null;
  drag = null;
  // The inspector's numbers went stale while the object was being dragged.
  if (tool === 'select' && selected) renderPanel();
});

stage.addEventListener('wheel', (e) => {
  e.preventDefault();
  // ⚠ Shift + wheel RAISES, and zoom keeps the bare wheel. Height had no
  // binding at all before this — a lantern on a shelf or a bridge over a
  // stream had to be typed into the inspector, which breaks the loop of
  // looking at the thing you are placing (the D-565 finding about weapon
  // offsets, in a second editor).
  if (e.shiftKey) {
    raiseBy(e.deltaY > 0 ? -nudge : nudge);
    return;
  }
  scene.zoomBy(e.deltaY > 0 ? 1.12 : 1 / 1.12);
}, { passive: false });

window.addEventListener('keydown', (e) => {
  const meta = e.ctrlKey || e.metaKey;
  if (meta && e.key.toLowerCase() === 's') {
    e.preventDefault();
    void save();
    return;
  }
  if (meta && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
    return;
  }
  if (e.key === 'Escape') {
    select(null);
    return;
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
    // ⚠ Guarded on the target: Backspace inside a number field must delete a
    // digit, not the building.
    if ((e.target as HTMLElement | null)?.tagName === 'INPUT') return;
    e.preventDefault();
    snapshot();
    removeAsset(selected);
    return;
  }
  if ((e.key === 'x' || e.key === 'X') && !meta) {
    // ⚠ Guarded on the target, like Delete and D above: X inside the search
    // box must type an x, not throw the panel into selection mode mid-word.
    if ((e.target as HTMLElement | null)?.tagName === 'INPUT') return;
    e.preventDefault();
    if (tool === 'select') {
      tool = lastPaintTool;
    } else {
      lastPaintTool = tool;
      tool = 'select';
    }
    renderPanel();
    return;
  }
  if ((e.key === 'd' || e.key === 'D') && selected && !meta) {
    if ((e.target as HTMLElement | null)?.tagName === 'INPUT') return;
    e.preventDefault();
    duplicateSelected();
    return;
  }
  if (e.key === 'r' || e.key === 'R') {
    // Free rotation since D-567; the key steps 15°, or 90° with shift, because
    // most things still want to line up with each other.
    const by = e.shiftKey ? 90 : 15;
    if (selected) {
      snapshot();
      editSelected({ rotation: (selected.rotation + by) % 360 });
    } else {
      assetRot = (assetRot + by) % 360;
    }
    renderPanel();
  } else if (e.key === '[') {
    brush = Math.max(1, brush - 2);
    renderPanel();
  } else if (e.key === ']') {
    brush = Math.min(7, brush + 2);
    renderPanel();
  }
});

$('btn-save').addEventListener('click', () => void save());
$('btn-revert').addEventListener('click', revert);
$('btn-recentre').addEventListener('click', () => {
  if (area) camTarget.set(area.spawn.x, 0, area.spawn.y);
});

/**
 * The editor's verification hook — what `window.__rc` is for the game.
 *
 * ⚠ It exists because the things worth checking here CANNOT be read off a
 * screenshot. Whether the preview is under the cursor, at the right angle and
 * at the right height is three numbers, and two towers at isometric distance
 * are hard to tell apart by eye — the D-559 finding, in the editor. Nothing
 * in the editor reads this; it is for a person or a check standing outside.
 */
declare global {
  interface Window {
    __ed?: {
      tool: () => Tool;
      pick: () => string | null;
      /** The preview: where it is, which way it faces, and whether a mesh arrived. */
      ghost: () => { x: number; y: number; z: number; yaw: number; drawn: boolean } | null;
      /** What a turn or a lift would act on right now. */
      target: () => 'ghost' | 'selected' | null;
      paint: () => { rotation: number; z: number };
      selected: () => { x: number; y: number; z: number; rotation: number } | null;
      assetNear: (x: number, y: number) => { x: number; y: number; z: number; rotation: number } | null;
      count: () => number;
      live: () => boolean;
      mask: () => { channels: number[]; nonZero: number; materials: string[] } | null;
      /**
       * Paint and remove WITHOUT the pointer (D-588).
       *
       * ⚠ Six materials and a removal is a dozen strokes and a confirm dialog,
       * and what has to be checked afterwards is which channel holds what —
       * which is a number, not a picture. Driving the brush directly is how
       * the compaction gets checked at all: on screen, a correct compaction
       * and a wrong one both look like ground.
       */
      dab: (materialId: string, x: number, y: number, radius?: number) => string;
      remove: (materialId: string) => boolean;
      coverage: () => { id: string; name: string; share: number }[];
    };
  }
}
window.__ed = {
  tool: () => tool,
  pick: () => assetPick?.id ?? null,
  ghost: () => (ghost && ghostFor ? ghost.placement() : null),
  target: () => spinTarget(),
  paint: () => ({ rotation: assetRot, z: assetZ }),
  selected: () => (selected
    ? { x: selected.x, y: selected.y, z: selected.z, rotation: selected.rotation }
    : null),
  // Straight out of the document, so a check cannot read a stale reference.
  assetNear: (x: number, y: number) => {
    const near = (area?.assets ?? [])
      .map((a) => ({ a, d: Math.hypot(a.x - x, a.y - y) }))
      .sort((p, q) => p.d - q.d)[0];
    return near ? { x: near.a.x, y: near.a.y, z: near.a.z, rotation: near.a.rotation } : null;
  },
  count: () => area?.assets.length ?? 0,
  live: () => area?.live === true,
  // What the ground brush has actually written — a verification hook.
  mask: () => groundBrush?.debug() ?? null,
  dab: (materialId, x, y, radius = 3) => {
    const mat = groundMats.find((m) => m.id === materialId);
    if (!mat) return `no such material '${materialId}'`;
    if (!groundBrush) return 'no area open';
    const got = groundBrush.dab(mat, x, y, radius, brushSoftness, brushStrength);
    if (got === 'painted') { paintDirty = true; setDirty(true); }
    return got;
  },
  remove: (materialId) => {
    const got = groundBrush?.removeMaterial(materialId) ?? false;
    if (got) { paintDirty = true; setDirty(true); renderPanel(); }
    return got;
  },
  coverage: () => groundBrush?.coverage() ?? [],
};

window.addEventListener('beforeunload', (e) => {
  if (dirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ---------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------

function ensureCursor(): void {
  if (cursor) return;
  const half = 0.5;
  const pts = [
    new THREE.Vector3(-half, 0, -half), new THREE.Vector3(half, 0, -half),
    new THREE.Vector3(half, 0, half), new THREE.Vector3(-half, 0, half),
  ];
  cursor = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: 0xffc98a }),
  );
  cursor.position.y = 0.12;
  scene.scene.add(cursor);
}

const clock = new THREE.Clock();

function step(dt: number): void {
  scene.updateCamera(dt);
  scene.follow(camTarget);
  roofView?.update(null, dt);
  lightRig.update(camTarget, clock.elapsedTime);
  ensureCursor();
  updateGhost();
  if (cursor) {
    cursor.visible = hovered !== null;
    if (hovered) {
      cursor.position.set(hovered.x, 0.12, hovered.y);
      cursor.scale.setScalar(brush);
    }
  }
  // No character to protect here, so nothing is ever cut away — an editor
  // that hid the wall you were building would be its own joke.
  setOcclusionFocus(null, scene.camera, scene.renderer);
  // Raw render, NOT the palette pass: the quantiser's ordered dither is the
  // game's look, and it makes a single misplaced tile almost impossible to
  // see. You judge composition here and the look in the game.
  scene.renderer.render(scene.scene, scene.camera);
}

function frame(): void {
  requestAnimationFrame(frame);
  step(Math.min(clock.getDelta(), 0.05));
}

// ---------------------------------------------------------------------------
// Automation hook, matching `__rc` in the client and `__viewer`/`__creator`
// in the review tools. The browser pane cannot always be driven by real
// clicks, and an editor with no way to assert what it did is an editor that
// gets verified by squinting.
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    __editor?: {
      area: () => AreaDef | null;
      open: (id: string) => Promise<void>;
      /** Places with the current tool at a tile, as a click would. */
      apply: (x: number, y: number, erase?: boolean) => boolean;
      setTool: (t: Tool) => void;
      setAsset: (id: string, rot?: 0 | 90 | 180 | 270) => void;
      setBrush: (n: number) => void;
      snapshot: () => string;
      save: () => Promise<void>;
      status: () => string;
      counts: () => {
        assets: number; stations: number; nodes: number; npcs: number; roofs: number;
        exits: number; size: string; lights: number; dirty: boolean;
        /** Person markers actually IN the scene, not the count in the file.
         * The two disagreeing is the whole class of bug where a thing is
         * placed, saved and never drawn. */
        npcMarkers: number;
      };
      resize: (w: number, h: number, ox?: number, oy?: number) => string;
      setExit: (toArea: string, toX: number, toY: number) => void;
      setRoof: (style: 'thatch' | 'tile' | 'slate' | 'plank') => void;
      /** Forces a frame and returns the canvas — the browser pane does not
       * composite when it is not displayed, so rAF alone is not enough. */
      pick: (i: number) => PlacedAsset | null;
      selection: () => { placed: PlacedAsset; volumes: Volume[] } | null;
      placed: () => { x: number; y: number; z: number; yaw: number; drawn: boolean }[];
      shot: () => string;
      look: (azimuthRad: number, zoom?: number) => void;
    };
  }
}

window.__editor = {
  area: () => area,
  open: (id) => openArea(id),
  apply: (x, y, erase = false) => {
    snapshot();
    const changed = applyAt(x, y, erase);
    return changed;
  },
  setTool: (t) => { tool = t; renderPanel(); },
  // ⚠ `setProp` is gone with the prop palette; the hook now places an ASSET
  // so the verification path and the UI place the same kind of thing.
  setAsset: (id: string, rot: 0 | 90 | 180 | 270 = 0) => {
    assetPick = assetList.find((a) => a.id === id) ?? null;
    assetRot = rot;
    renderPanel();
  },
  setBrush: (n) => { brush = n; renderPanel(); },
  /** The stage as a PNG data URL, drawn now (D-637's probe, here too). */
  snapshot: () => {
    scene.renderer.render(scene.scene, scene.camera);
    return scene.renderer.domElement.toDataURL('image/png');
  },
  save: () => save(),
  status: () => $('status').textContent ?? '',
  counts: () => ({
    assets: area?.assets.length ?? 0,
    stations: area?.stations.length ?? 0,
    nodes: area?.nodes.length ?? 0,
    npcs: area?.npcs?.length ?? 0,
    npcMarkers: markerGroup.children.filter(
      (o) => (o as THREE.Mesh).geometry?.type === 'CapsuleGeometry',
    ).length,
    roofs: area?.roofs.length ?? 0,
    exits: area?.transitions.length ?? 0,
    size: area ? `${area.width}x${area.height}` : '',
    lights: lightRig.sourceCount,
    dirty,
  }),
  resize: (w: number, h: number, ox = 0, oy = 0) => resizeArea(w, h, ox, oy),
  setExit: (toArea: string, toX: number, toY: number) => {
    exitTarget = toArea; exitToX = toX; exitToY = toY; renderPanel();
  },
  setRoof: (style: 'thatch' | 'tile' | 'slate' | 'plank') => { roofStyle = style; renderPanel(); },
  /** Select by index into `area().assets`, or -1 for nothing. */
  pick: (i: number) => {
    select(i < 0 ? null : (area?.assets[i] ?? null));
    return selected;
  },
  /** What is selected, and the world volumes drawn for it. */
  selection: () => (selected ? { placed: selected, volumes: placedVolumes(selected) } : null),
  /** What the scene actually drew, for verifying placement without a screenshot. */
  placed: () => [...assetVisuals.values()].map((v) => v.placement()),
  shot: () => {
    step(1 / 60);
    return scene.renderer.domElement.toDataURL('image/png');
  },
  look: (angle: number, zoom?: number) => {
    scene.setAzimuth(angle);
    if (zoom !== undefined) scene.setZoom(zoom);
  },
};

renderPanel();
// Ground materials before the first area, or the first rebuild paints nothing.
void loadGround().then(() => loadAreaList());
void loadPalette();
void loadAssetPacks();
frame();
