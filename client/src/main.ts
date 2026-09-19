import * as THREE from 'three';
import {
  SEAT_REACH,
  SEAT_PICK_RADIUS,
  DIRECTION_VECTORS,
  SoundsFileSchema,
  CORE_STATION_TYPES,
  resolveAppearance,
  type CoreStationType,
  type Channel,
  type CharacterSummary,
  type Direction,
  type ServerMessage,
  type WireEntity,
  attackSpacingTicks,
  xpForLevel,
} from '@rc/shared';
import { Connection } from './net/connection';
import { Ambience } from './audio';
import { SoundBank, DEFAULT_VOLUMES, type Volumes } from './sound';
import soundManifest from '../../content/audio/sounds.json';
import { invalidateImportedModels } from './render/imported-models';
import { setAnimationSets } from './render/animation-sets';
import { setGroundMaterials } from './render/ground';
import { setGrips } from './render/held-items';
import { setPartCatalogues } from './render/hood';
import { setClothSettings } from './render/mesh-cloth';
import { invalidateWorldAssets } from './render/world-assets';
import { CreationWizard } from './creation';
import { GameScene } from './render/scene';
import { StationVisual } from './render/station-visual';
import { LightRig } from './render/lights';
import { Roofs } from './render/roofs';
import { occlusionState, setOcclusionFocus } from './render/occlusion';
import { CombatEffects } from './render/effects';
import { Terrain } from './render/terrain';
import { buildPaintedGround } from './render/ground';
import { WorldAssets, loadOneAsset } from './render/world-assets';
import { HoverOutline } from './render/hover-outline';
import { ImportedVisual } from './render/imported-visual';
import * as importedModels from './render/imported-models';
import {
  RUN_SECONDS,
  SPRINT_SECONDS,
  TILE_SECONDS,
  isMoving,
  markMoved,
  stepToward,
  type InterpolatedPosition,
} from './game/interpolation';
import { RoundHud } from './game/round-hud';
import {
  formatEffort,
  recipeStatus,
  type CatalogueItem,
  type CatalogueRecipe,
} from './game/pack';
import {
  barFraction,
  barState,
  clockHands,
  clockText,
  compassRotationDeg,
  needFraction,
  needLabel,
} from './game/hud';
import { CharacterPanel, type BookEntry } from './character-panel';
import { LevelUpScreen } from './levelup';

/**
 * Client glue: UI flow (login → character → world), the entity mirror driven
 * by snapshot + deltas (D-107), input → move intents (D-102), and the render
 * loop. The client renders what it is told and decides nothing.
 */

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const overlay = $('overlay');
const loginForm = $('login-form');
const charForm = $('char-form');
const statusMsg = $('status-msg');
const charList = $<HTMLUListElement>('char-list');
const hud = $('hud');
const chat = $('chat');
const chatLog = $('chat-log');
/**
 * What the player PERCEIVES, kept apart from what people SAY (D-611).
 *
 * ⚠ They shared one scrollback, so a line of dialogue could be pushed off
 * the top by four refusals and a change in the weather — in a mode whose whole
 * point is people talking to each other (D-521). Speech goes to `chatLog`;
 * narration, the world's answers, refusals and sounds carried through walls go
 * here. Nothing writes to both.
 */
const eventLog = $('event-log');
const chatBar = $('chat-bar');
const chatHint = $('chat-hint');
const chatInput = $<HTMLInputElement>('in-chat');
const declareInput = $<HTMLInputElement>('in-declare');

// The same PORT the server reads from `.env` (exposed by vite.config.ts), so
// the form and the server cannot disagree about a default (D-630).
const defaultServer = `ws://${location.hostname || 'localhost'}:${import.meta.env['PORT'] ?? 8080}`;
$<HTMLInputElement>('in-server').value = localStorage.getItem('rc.server') ?? defaultServer;

function setStatus(text: string, isError = true): void {
  statusMsg.textContent = text;
  statusMsg.style.color = isError ? 'var(--bad)' : 'var(--dim)';
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Dropped gear on the ground (D-511): a sack and a bundle, nothing more.
 * Bright albedo on purpose — mid-tones starve the palette quantiser. */
class PileVisual {
  readonly root = new THREE.Group();
  constructor(private parent: THREE.Scene) {
    const sack = new THREE.Mesh(
      new THREE.BoxGeometry(0.55, 0.28, 0.45),
      new THREE.MeshLambertMaterial({ color: 0xb5875a }),
    );
    sack.position.y = 0.14;
    sack.rotation.y = 0.4;
    const bundle = new THREE.Mesh(
      new THREE.BoxGeometry(0.3, 0.16, 0.24),
      new THREE.MeshLambertMaterial({ color: 0xcfc39a }),
    );
    bundle.position.set(0.16, 0.32, -0.06);
    bundle.rotation.y = -0.3;
    this.root.add(sack, bundle);
    parent.add(this.root);
  }
  setPosition(x: number, z: number, elevation = 0): void {
    this.root.position.set(x, elevation, z);
  }
  setFacing(_dir: Parameters<ImportedVisual['setFacing']>[0]): void {}
  /** A heap IS the loot, so this only ever hides an emptied one. */
  setLootable(lootable: boolean): void {
    this.root.visible = lootable;
  }
  setPosture(_p: Parameters<ImportedVisual['setPosture']>[0]): void {}
  setPresentation(_p: Parameters<ImportedVisual['setPresentation']>[0]): void {}
  playTransients(_t: Parameters<ImportedVisual['playTransients']>[0]): void {}
  update(_dt: number, _t: number, _moving: boolean, _wind: number): void {}
  dispose(): void {
    this.parent.remove(this.root);
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
  }
}

/**
 * A resource node. Deliberately NOT a character: nodes arrived as entities so
 * they could reuse line of sight, deltas and targeting (MR2), but rendering
 * them through CharacterVisual would stand seventeen people in the mine.
 *
 * The shape is chosen from the descriptor the server already sends, so no
 * extra wire field was needed to tell a seam from a thicket.
 */
class NodeVisual {
  readonly root = new THREE.Group();
  private disposed = false;

  /**
   * Swap the built-in shape for the authored mesh, once it has loaded (D-583).
   *
   * ⚠ Built-in geometry first, replaced only when a mesh actually arrives —
   * the same rule a station follows. A node you cannot see is a node nobody
   * harvests, and the whole danger of gathering is standing still beside one
   * for a known length of time.
   */
  async wear(art: { pack: string; asset: string; rotation: number; scale: number }): Promise<void> {
    const object = await loadOneAsset(art.pack, art.asset);
    if (!object || this.disposed) return;
    for (const child of [...this.root.children]) this.root.remove(child);
    object.rotation.y = (-art.rotation * Math.PI) / 180;
    object.scale.setScalar(art.scale);
    this.root.add(object);
  }

  constructor(private parent: THREE.Scene, descriptor: string) {
    const leafy = /leaf|grain|scrub|tangle|run\b/i.test(descriptor);
    const woody = /timber|tree|stand/i.test(descriptor);
    if (descriptor === 'station') {
      // Facilities must be findable across a room without a label: a squat,
      // pale, obviously-built shape among the terrain (D-530).
      const block = new THREE.Mesh(
        new THREE.BoxGeometry(0.72, 0.5, 0.6),
        new THREE.MeshLambertMaterial({ color: 0xc2b39a }),
      );
      block.position.y = 0.25;
      const top = new THREE.Mesh(
        new THREE.BoxGeometry(0.82, 0.1, 0.7),
        new THREE.MeshLambertMaterial({ color: 0x8f7d63 }),
      );
      top.position.y = 0.55;
      this.root.add(block, top);
    } else if (woody) {
      const trunk = new THREE.Mesh(
        new THREE.CylinderGeometry(0.13, 0.17, 1.15, 6),
        // Albedo lesson (D-514): brighten the material, never the lights.
        new THREE.MeshLambertMaterial({ color: 0x8a6f4e }),
      );
      trunk.position.y = 0.57;
      const crown = new THREE.Mesh(
        new THREE.ConeGeometry(0.52, 0.95, 7),
        new THREE.MeshLambertMaterial({ color: 0x6d7f52 }),
      );
      crown.position.y = 1.35;
      this.root.add(trunk, crown);
    } else if (leafy) {
      for (let i = 0; i < 3; i++) {
        const tuft = new THREE.Mesh(
          new THREE.BoxGeometry(0.26, 0.34, 0.24),
          new THREE.MeshLambertMaterial({ color: i === 1 ? 0x93a06a : 0x7f8d5c }),
        );
        tuft.position.set((i - 1) * 0.22, 0.18 + (i === 1 ? 0.08 : 0), (i - 1) * 0.1);
        tuft.rotation.y = i * 0.6;
        this.root.add(tuft);
      }
    } else {
      const rock = new THREE.Mesh(
        new THREE.DodecahedronGeometry(0.42, 0),
        new THREE.MeshLambertMaterial({ color: 0x9a8c80 }),
      );
      rock.position.y = 0.26;
      rock.rotation.set(0.4, 0.8, 0.2);
      const seam = new THREE.Mesh(
        new THREE.BoxGeometry(0.46, 0.09, 0.12),
        new THREE.MeshLambertMaterial({ color: 0xb2704a }),
      );
      seam.position.set(0, 0.36, 0.14);
      this.root.add(rock, seam);
    }
    parent.add(this.root);
  }
  setPosition(x: number, z: number, elevation = 0): void {
    this.root.position.set(x, elevation, z);
  }
  /** Spent nodes sink and grey off, so "worked out" reads at a glance. */
  setSpent(spent: boolean): void {
    this.root.scale.setScalar(spent ? 0.55 : 1);
  }
  setFacing(_dir: Parameters<ImportedVisual['setFacing']>[0]): void {}
  setLootable(_lootable: boolean): void {}
  setPosture(_p: Parameters<ImportedVisual['setPosture']>[0]): void {}
  setPresentation(_p: Parameters<ImportedVisual['setPresentation']>[0]): void {}
  playTransients(_t: Parameters<ImportedVisual['playTransients']>[0]): void {}
  update(_dt: number, _t: number, _moving: boolean, _wind: number): void {}
  dispose(): void {
    this.parent.remove(this.root);
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
  }
}

/**
 * A facility in the entity interface (D-542).
 *
 * ⚠ The last procedural geometry in the game. The 44 prop types are gone with
 * the tile system (D-567); a station is not scenery but an object the server
 * spawns, and the well has to be visible across the square for thirst to work
 * (D-529). It should become a pack asset like everything else.
 */
class StationEntity {
  private readonly visual: StationVisual;
  /** ⚠ The union needs ONE way to ask where a visual's geometry is, or the
   * hover outline (D-622) has to know what kind of thing it is looking at. */
  get root(): THREE.Object3D {
    return this.visual.root;
  }
  constructor(
    parent: THREE.Scene,
    type: CoreStationType,
    x: number,
    y: number,
    art?: { pack: string; asset: string; rotation: number; scale: number },
  ) {
    this.visual = new StationVisual(parent, type, x, y, art);
  }
  setPosition(x: number, z: number, elevation = 0): void {
    this.visual.setPosition(x, z, elevation);
  }
  setFacing(_dir: Parameters<ImportedVisual['setFacing']>[0]): void {}
  setLootable(_lootable: boolean): void {}
  setPosture(_p: Parameters<ImportedVisual['setPosture']>[0]): void {}
  setPresentation(_p: Parameters<ImportedVisual['setPresentation']>[0]): void {}
  playTransients(_t: Parameters<ImportedVisual['playTransients']>[0]): void {}
  update(_dt: number, _t: number, _moving: boolean, _wind: number): void {
    this.visual.update();
  }
  dispose(): void {
    this.visual.dispose();
  }
}

interface EntityState {
  wire: WireEntity;
  render: InterpolatedPosition;
  visual: ImportedVisual | PileVisual | NodeVisual | StationEntity;
}

// Start fetching the character manifest immediately rather than on the first
// snapshot: by the time somebody has picked a character off the roster it is
// usually already in hand, and the world builds with the right cast first
// time instead of rebuilding a moment later.
void importedModels.loadManifest();

const conn = new Connection();
let scene: GameScene | null = null;
let terrain: Terrain | null = null;
/**
 * The painted ground for the area you are standing in (D-585 → D-588).
 *
 * ⚠ Its own object rather than part of `Terrain`, because it is not made of
 * tiles: it is one plane over the whole area carrying a mask, and the terrain
 * is instanced per tile kind. Keeping them separate is also what lets the map
 * editor and the game share ONE implementation — the reason D-558 gives for
 * sharing the character assembler. A floor that draws differently in the
 * painter from the way it draws in the world is a painter that lies.
 */
let paintedGround: THREE.Mesh | null = null;
let worldAssets: WorldAssets | null = null;
/** The lit edge on whatever the cursor is over (D-622). */
let hoverOutline: HoverOutline | null = null;
const occlusionFocus = new THREE.Vector3();
/** How wide the see-through hole is, in device pixels. */
const SEE_THROUGH_RADIUS_PX = 110;
/** Area scenery (D-542). Rebuilt with the terrain, on every area change. */
/** Prop lighting (D-544): a small pool of real lights, given to the nearest. */
let lightRig: LightRig | null = null;
/** Roofs (D-545). They lift away when you are under them. */
let roofs: Roofs | null = null;
const entities = new Map<number, EntityState>();
let youId: number | null = null;
let areaName = '';
let coin = 0;
let inventory: Extract<ServerMessage, { t: 'inventory' }>['items'] = [];
let currentLanguage: string | null = null; // null = common
let status: Extract<ServerMessage, { t: 'status' }> | null = null;

// Mouse interaction state (stakeholder UI pass, 2026-08-17)
let selectedId: number | null = null;
/**
 * Auto-attack (D-550). A selected target that is visibly hostile is engaged
 * without further clicking; everything else needs the verb.
 *
 * `struckBy` is how a PLAYER becomes auto-attackable: they hit you first. The
 * wire never marks a player hostile (that would be an accusation the server
 * has no business making, D-217), so the client remembers who has actually
 * swung at it and treats only those as fair game. Clicking a stranger can
 * therefore never start a fight, which matters more here than convenience —
 * the tavern keeper is somebody's objective.
 */
const struckBy = new Set<number>();
/** Tick of the last attack we sent, to pace the next one. */
let lastAttackAt = 0;
/** Latest server tick seen on a delta — the clock auto-attack paces against. */
let serverTick = 0;
let hoveredEntityId: number | null = null;
let hoveredTile: { x: number; y: number } | null = null;
/** Click-to-move destination; the executor re-plans each step (drift-safe). */
let moveDest: { x: number; y: number } | null = null;
/** Whether `moveDest` was double-clicked: run there (D-636). */
let moveRun = false;
/** The last ground click, so the next one can be recognised as a double. */
let lastGroundClick: { x: number; y: number; at: number } | null = null;
const DOUBLE_CLICK_MS = 400;
/**
 * The target the player has chosen to FIGHT (D-636). Approached until it is
 * within reach and struck every time the weapon is ready, until the player
 * asks for anything else: a move, another target, another ability, Escape.
 * `engagePlannedFor` is where the target stood when we last asked the
 * server to walk us toward it, so a target that moves gets a fresh route
 * and one that stands still does not get the walk restarted every poll.
 */
let engagedId: number | null = null;
let engagePlannedFor: { x: number; y: number } | null = null;
/**
 * Whether the server has already been asked to walk to `moveDest`.
 *
 * ⚠ A destination is asked for ONCE. Re-sending it on every poll restarts the
 * route from wherever the character has reached, which reads as walking on the
 * spot — the same drift the client's re-planning loop was written to avoid,
 * arriving from the other direction.
 */
let moveAsked = false;
/** Chair the player asked to sit on: emits the sit emote on arrival. */
let pendingSit: { x: number; y: number } | null = null;
let currentArea: Extract<ServerMessage, { t: 'snapshot' }>['area'] | null = null;

// Ambient sound (procedural, see audio.ts). Browsers gate audio behind a
// user gesture, so the graph builds on the first input and not before.
const ambience = new Ambience();
// The craft catalogue, sent once on entering the world (MR2).
let itemCatalogue: CatalogueItem[] = [];
let craftRecipes: CatalogueRecipe[] = [];

/** Redraws the pack and the workbench. Cheap, and only when something moved. */
/**
 * The character panel owns the pack and the paperdoll (D-547); this function
 * keeps the workbench, which is a different question and lives in its own
 * window beside it.
 */
function renderPackAndCraft(): void {
  charPanel.setInventory(inventory);
  charPanel.setCatalogue(itemCatalogue);

  const craftList = $('craft-list');
  craftList.innerHTML = '';
  const inTown = currentArea?.id === 'round-town';
  for (const recipe of craftRecipes) {
    const status = recipeStatus(recipe, inventory, itemCatalogue, inTown);
    const el = document.createElement('div');
    el.className = 'recipe';
    const head = document.createElement('div');
    head.className = 'recipe-head';
    const name = document.createElement('span');
    name.className = 'recipe-name';
    name.textContent = recipe.name;
    const make = document.createElement('button');
    make.textContent = `Make · ${formatEffort(recipe.effortTicks)}`;
    make.disabled = !status.canAttempt;
    // The button is a convenience, never the authority: the server checks
    // materials again on completion, so this only spares a wasted click.
    make.addEventListener('click', () => conn.send({ t: 'craft', recipeId: recipe.id }));
    head.append(name, make);
    const cost = document.createElement('div');
    cost.className = 'recipe-cost';
    for (const c of status.costs) {
      const span = document.createElement('span');
      if (c.short) span.className = 'short';
      span.textContent = `${c.name} ${c.have}/${c.need}  `;
      cost.appendChild(span);
    }
    if (!status.atStation) {
      const where = document.createElement('span');
      where.className = 'short';
      where.textContent = `· needs the ${recipe.station}`;
      cost.appendChild(where);
    }
    el.append(head, cost);
    craftList.appendChild(el);
  }
}
const charPanel = new CharacterPanel({
  onEquip: (itemId, slot) => conn.send({ t: 'equip', itemId, ...(slot ? { slot } : {}) }),
  onUnequip: (itemId) => conn.send({ t: 'unequip', itemId }),
  onUse: (templateId) => conn.send({ t: 'use_item', templateId }),
  onDrop: (itemId) => conn.send({ t: 'drop_item', itemId }),
  onStock: (itemId) => conn.send({ t: 'store_deposit', itemId }),
  onTake: (itemId) => conn.send({ t: 'store_withdraw', itemId }),
  onLookAtStores: () => conn.send({ t: 'store_look' }),
  book: () => characterBook(),
});
const levelUp = new LevelUpScreen({
  onSubmit: (advances) => conn.send({ t: 'advance', advances }),
});
/**
 * The round's clock, for the dial (D-548). The server sends only the whole
 * game hour, so the minute hand is interpolated from when the hour last
 * turned — cosmetic, bounded by one game hour, and the alternative is a hand
 * that jumps in twelve-degree steps and reads as broken.
 */
/** The last round phase seen, so a RESET can be told from a lobby that is
 * merely still waiting (D-612). */
let lastRoundPhase: 'lobby' | 'running' | 'resolved' | null = null;
let clockHour = 6;
let clockNight = false;
let clockHourChangedAt = performance.now();
/** Real milliseconds per game hour, from the round's own cycle (D-527). */
const GAME_HOUR_MS = 25_000;

const roundHud = new RoundHud({
  root: $('round-hud'),
  phase: $('round-phase'),
  clock: $('round-clock'),
  cast: $('round-cast'),
  objective: $('round-objective'),
  objectiveName: $('round-objective-name'),
  objectiveBrief: $('round-objective-brief'),
  ending: $('round-ending'),
  endingTitle: $('round-ending-title'),
  endingBody: $('round-ending-body'),
  lobby: $('round-lobby'),
  lobbyNote: $('round-lobby-note'),
  botAdd: $('round-bot-add') as HTMLButtonElement,
  botFill: $('round-bot-fill') as HTMLButtonElement,
  botClear: $('round-bot-clear') as HTMLButtonElement,
}, (msg) => conn.send(msg));
/**
 * Sampled sound (D-541). The cue list is CONTENT — the same file the server
 * loads and CI validates — imported directly rather than sent over the wire,
 * because it is presentation and the menu music has to play before there is
 * a connection to receive anything on.
 */
const sounds = new SoundBank(SoundsFileSchema.parse(soundManifest));

const enableAudio = (): void => {
  ambience.enable();
  const ctx = ambience.context;
  const master = ambience.masterGain;
  // One graph for both layers: the procedural bed and the sampled one share
  // a context, so there is a single master and a single latency budget.
  if (ctx && master) {
    sounds.attach(ctx, master);
    sounds.setVolumes(loadVolumes());
    // Before the world opens, the screen has music. It stops on entry.
    if (!overlay.classList.contains('hidden')) sounds.setMusic('menu-music');
  }
};
window.addEventListener('pointerdown', enableAudio, { once: true });
window.addEventListener('keydown', enableAudio, { once: true });

/** Volumes persist per browser, like the graphics settings do. */
function loadVolumes(): Volumes {
  try {
    const raw = localStorage.getItem('rc.volumes');
    if (raw) return { ...DEFAULT_VOLUMES, ...(JSON.parse(raw) as Partial<Volumes>) };
  } catch {
    // corrupt or unavailable storage — defaults are fine
  }
  return { ...DEFAULT_VOLUMES };
}

function saveVolumes(v: Partial<Volumes>): void {
  sounds.setVolumes(v);
  try {
    localStorage.setItem('rc.volumes', JSON.stringify(sounds.volumeSettings));
  } catch {
    // storage unavailable — the setting simply does not persist
  }
}

// ---------------------------------------------------------------------------
// UI flow
// ---------------------------------------------------------------------------

function beginAuth(kind: 'login' | 'register'): void {
  const server = $<HTMLInputElement>('in-server').value.trim();
  const username = $<HTMLInputElement>('in-user').value.trim();
  const password = $<HTMLInputElement>('in-pass').value;
  if (!username || !password) return setStatus('username and password required');
  localStorage.setItem('rc.server', server);
  setStatus('connecting…', false);
  conn.connect(server);
  conn.onOpen = () => {
    setStatus('', false);
    conn.send({ t: kind, username, password });
  };
}

$('btn-login').onclick = () => beginAuth('login');
$('btn-register').onclick = () => beginAuth('register');
$<HTMLInputElement>('in-pass').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') beginAuth('login');
});

// Character creation (D-208) lives in its own module; it submits a finished
// build and the SERVER decides whether it is legal.
const creation = new CreationWizard({
  onSubmit: (name, classId, build, appearance, raceId, look) => {
    conn.send({
      t: 'create_character',
      name,
      appearanceSeed: creation.seed,
      classId,
      // ⚠ Omitted, not null, when the wizard never asked — a server whose
      // content has no races skips the step, and `raceId: undefined` is what
      // the schema's `.optional()` means. Sending an empty string would be a
      // race id nothing can resolve (D-572).
      ...(raceId ? { raceId } : {}),
      // Omitted when nothing was chosen, for the same reason as the race: an
      // empty look is not a blank face, it is the absence of a choice (D-574).
      ...(look ? { look } : {}),
      // The wizard assembles a build a step at a time, so its fields are
      // optional; the schema fills the gaps and the server re-validates the
      // whole thing regardless (D-102).
      build: {
        attributes: build.attributes ?? {},
        skills: build.skills ?? {},
        feats: build.feats ?? [],
        spells: build.spells ?? [],
      },
      appearance,
    });
  },
  // ⚠ Backing out of creation returns to the character list, and saying so
  // here is the point: `close()` no longer decides what replaces the wizard,
  // because the same call also serves a dropped connection, which must land on
  // the login fields instead (D-577).
  onCancel: () => {
    setStatus('');
    charForm.classList.remove('hidden');
  },
});

$('btn-create').onclick = () => {
  if (!creation.ready) return setStatus('still loading the catalogue — try again in a moment');
  setStatus('');
  creation.open();
};

function showCharacters(characters: CharacterSummary[]): void {
  loginForm.classList.add('hidden');
  creation.close();
  charForm.classList.remove('hidden');
  charList.innerHTML = '';
  for (const c of characters) {
    const li = document.createElement('li');
    // Level belongs on the roster, not in the round (D-538): you choose who
    // to take in knowing what they are, and the round itself never shows it.
    const label = document.createElement('span');
    label.className = 'charname';
    label.innerHTML = `<span>${c.name}</span>`
      + `<span class="where">level ${c.level} · ${c.areaId}</span>`;
    // ⚠ The ROW still enters the world, and the button is a sibling of the
    // row's click target rather than inside it. A delete nested in something
    // that also means "play this character" is one mis-click from an
    // irreversible act, and this act is irreversible by design (D-510).
    label.onclick = () => conn.send({ t: 'enter_world', characterId: c.id });
    const del = document.createElement('button');
    del.className = 'chardel';
    del.type = 'button';
    del.textContent = 'Delete';
    del.title = `End ${c.name} permanently`;
    del.onclick = (e) => {
      e.stopPropagation();
      confirmDelete(c);
    };
    li.append(label, del);
    charList.appendChild(li);
  }
}

/**
 * Ask before ending a character (D-600).
 *
 * ⚠ The prompt states BOTH halves, and the payment second. Retirement is
 * permanent and it is also the only route to Legacy Points (D-510), so a
 * confirmation that mentioned only the loss would be describing half the
 * mechanic — and one that led with the reward would be selling it. The
 * number comes from the server, because the formula has diminishing returns
 * on repeat sacrifice and the client does not know how many this account has
 * already spent.
 */
function confirmDelete(c: CharacterSummary): void {
  const points = c.legacyIfRetired;
  const ok = window.confirm(
    `Delete ${c.name}?\n\n`
    + 'This is PERMANENT. The character ends, and no amount of play brings '
    + 'them back — their name, their levels and everything they were carrying '
    + 'are gone.\n\n'
    + `In return this account gains ${points} Legacy Point${points === 1 ? '' : 's'}, `
    + 'which buy access and flavour for future characters — never raw power.',
  );
  if (ok) conn.send({ t: 'retire_character', characterId: c.id });
}

// ---------------------------------------------------------------------------
// Server messages
// ---------------------------------------------------------------------------

conn.onClose = (reason) => {
  overlay.classList.remove('hidden');
  loginForm.classList.remove('hidden');
  creation.close();
  charForm.classList.add('hidden');
  hud.classList.add('hidden');
  chat.classList.add('hidden');
  chatHint.classList.add('hidden');
  clearWorld();
  setStatus(`disconnected: ${reason}`);
};
conn.onProtocolError = (detail) => setStatus(`protocol error: ${detail}`);

conn.onMessage = (msg: ServerMessage) => {
  switch (msg.t) {
    case 'error':
      // ⚠ "There are no stores here" is an ANSWER, not a failure: the panel
      // asks whenever it opens and the server is the authority on reach
      // (D-102), so a refusal is what empties the section. Letting it fall
      // through to the status line as well would put a red error in front of
      // a player who did nothing but open their pack in a field.
      if (msg.code === 'no_store_here') {
        charPanel.setStores(null);
        return;
      }
      // While the creation wizard is open its own error line is the one the
      // player is looking at — a rejected build must land there, not in the
      // login status behind the panel.
      if (!$('create-form').classList.contains('hidden')) creation.showError(msg.message);
      else if (msg.code === 'auth_failed' || msg.code === 'username_taken') setStatus(msg.message);
      else if (msg.code === 'character_name_taken') setStatus(msg.message);
      // ⚠ Once you are IN the world, a refusal goes to the chat log
      // (D-610). `#status-msg` lives inside the login overlay, which is
      // hidden the moment you enter play — so every in-world refusal was
      // written into an invisible element and the game simply did nothing.
      //
      // Reported as "I tried to attack a bot and nothing happened". The
      // server was answering every time: 'out of reach', 'you have swung all
      // you can this round', 'not now — the day has not started'. All three
      // are things a player needs to be told, and none of them were on
      // screen. An action that is refused must LOOK different from an action
      // that was never sent.
      // ⚠: cooldown refusals are SWALLOWED (D-618). Combat runs on a
      // four-second beat (D-550) and a player holds the key down, so every
      // frame between swings answered "you have swung all you can this round"
      // -- dozens of identical lines burying everything that matters. The
      // refusal is still sent, because bots and tests read it and the server
      // stays the authority on what is allowed (D-102); it simply is not news
      // to a person who can see their own hotbar.
      //
      // ⚠: this is the ONE code suppressed. D-610 routed refusals here
      // precisely because "nothing happened" was indistinguishable from a
      // broken game, and quietly hiding a second one would walk that back.
      else if (msg.code === 'on_cooldown') return;
      else if (youId !== null) appendSystemLine(msg.message);
      else setStatus(`${msg.code}: ${msg.message}`);
      return;
    case 'auth_ok':
      localStorage.setItem('rc.token', msg.token);
      showCharacters(msg.characters);
      conn.send({ t: 'get_creation_content' }); // catalogue for the wizard
      return;
    case 'render_content':
      // Presentation content, off the server's own copy (D-630): what the
      // tool saved is what this client draws with, no rebuild between.
      setAnimationSets(msg.animations);
      setGroundMaterials(msg.ground);
      setGrips(msg.grips);
      setPartCatalogues(msg.parts);
      setClothSettings(msg.cloth);
      return;
    case 'content_reloaded':
      // The production line reached the game (D-630). Drop what was read off
      // the build manifests so the next draw sees the Publish; say so in the
      // log because a dev loop that works silently is one nobody trusts.
      invalidateImportedModels();
      invalidateWorldAssets();
      appendSystemLine(
        `content reloaded: ${msg.applied.length} directories`
        + (msg.deferred.length ? ` — ${msg.deferred.join('; ')}` : ''),
      );
      return;
    case 'creation_content':
      creation.setContent(msg);
      // The level-up screen renders from the SAME catalogue (D-546/D-110):
      // one content source, so a feat added in a file appears in both places
      // without a client deploy.
      levelUp.setContent(msg);
      return;
    case 'character_created':
      conn.send({ t: 'enter_world', characterId: msg.character.id });
      return;
    case 'snapshot':
      applySnapshot(msg);
      return;
    case 'delta':
      serverTick = msg.tick;
      for (const event of msg.events) applyEvent(event);
      return;
    case 'inventory':
      queueMicrotask(renderPackAndCraft);
      coin = msg.coin;
      inventory = msg.items;
      return;
    case 'speech':
      appendSpeech(msg);
      addSpeechBubble(msg);
      return;
    case 'item_text':
      appendDocument(msg.title, msg.text);
      return;
    case 'descriptor': {
      const e = entities.get(msg.entityId);
      if (e) e.wire.descriptor = msg.descriptor;
      return;
    }
    case 'narrate': {
      const line = document.createElement('div');
      line.className = 'line narration';
      line.textContent = msg.text;
      eventLog.appendChild(stamped(line));
      trimAndScroll(eventLog);
      return;
    }
    case 'area_lighting':
      scene?.applyLighting(msg.lighting);
      return;
    case 'status': {
      const wasGhost = status?.ghost ?? false;
      status = msg;
      renderVitals(msg);
      adoptHotbar(msg.hotbar);
      charPanel.setStatus(msg);
      levelUp.setStatus(msg);
      $('hud-ghost').textContent = msg.ghost ? '☽ dead — /respawn when released' : '';
      // ⚠ The world goes pale while you are dead (D-621). Driven off the
      // SERVER's ghost flag rather than off any local guess: the planes are
      // partitioned by the server both ways (invariant 4), and the veil must
      // agree with the thing that decides what you can see.
      scene?.setVeiled(msg.ghost);
      if (msg.ghost && !wasGhost) {
        appendSystemLine('The world goes quiet. Only the dead remain with you.');
      } else if (!msg.ghost && wasGhost) {
        appendSystemLine('You wake at the spawn, scarred but breathing.');
      }
      return;
    }
    case 'retired':
      // ⚠ Two ways to arrive here, and only one of them ends the session.
      // Retiring IN the world takes the character out from under the player,
      // so the connection is closed and they come back to a login screen.
      // Deleting from the ROSTER (D-600) leaves them exactly where they were,
      // looking at a list that is about to be re-sent — closing the socket
      // there would log them out for tidying up.
      if (youId === null) {
        setStatus(
          `Ended. ${msg.awarded} Legacy Point${msg.awarded === 1 ? '' : 's'} earned `
          + `(${msg.totalLegacyPoints} total).`,
          false,
        );
        return;
      }
      appendSystemLine(
        `The tale is told. ${msg.awarded} Legacy Points earned (${msg.totalLegacyPoints} total). ` +
        'Reconnect to begin someone new.',
      );
      setTimeout(() => conn.close(), 4000);
      return;
    case 'character_list':
      showCharacters(msg.characters);
      return;
    case 'seance':
      if (msg.active) {
        appendSystemLine(
          msg.role === 'caster'
            ? `The séance holds. ${msg.questionsLeft} question${msg.questionsLeft === 1 ? '' : 's'} remain.`
            : `You are held at your body. ${msg.questionsLeft} question${msg.questionsLeft === 1 ? '' : 's'} remain — answer as you please.`,
        );
      } else {
        appendSystemLine(msg.role === 'caster' ? 'The séance ends.' : 'The hold on you releases.');
      }
      return;
    case 'observing':
      appendSystemLine(
        msg.on
          ? 'You settle into the dead weight of your own body. /observe off to let go.'
          : 'You drift free of the body.',
      );
      return;
    case 'catalogue':
      itemCatalogue = msg.items;
      craftRecipes = msg.recipes;
      renderPackAndCraft();
      return;
    case 'work': {
      const bar = $('work-bar');
      if (msg.done) {
        bar.classList.add('hidden');
        if (msg.interrupted) appendSystemLine(`You stop: ${msg.interrupted}.`);
        return;
      }
      bar.classList.remove('hidden');
      $('work-label').textContent =
        msg.activity === 'harvest' ? `Working ${msg.what}` : msg.what;
      ($('work-fill') as HTMLElement).style.width = `${Math.round(msg.progress * 100)}%`;
      return;
    }
    case 'round_state':
      // ⚠ Both logs are emptied when a round resets to the lobby (D-612).
      // Round-scoped memory is not a tidiness preference here: D-525 wipes
      // recognition precisely so the cast meets as strangers every round, and
      // a scrollback still holding last round's accusations, confessions and
      // dying words hands back exactly what that ruling took away. It is also
      // the one piece of round state a player can read at leisure.
      //
      // ⚠ Keyed on the TRANSITION into lobby, not on the phase being
      // lobby. Lobby state is broadcast every fifty ticks, so clearing on the
      // value would wipe the log five times a second while people were
      // standing around waiting to start — including anything they said.
      // ⚠ Either way out of a finished round (D-618). Clearing only on
      // the lobby missed the fast path: a reset with a full cast starts the
      // next round about a tick later, so a client can go straight from
      // `resolved` to `running` and never observe the lobby at all --
      // carrying the last round's dying words into the new one.
      const wentToLobby = msg.phase === 'lobby' && lastRoundPhase !== 'lobby';
      const startedAfresh = msg.phase === 'running' && lastRoundPhase === 'resolved';
      if (wentToLobby || startedAfresh) {
        eventLog.replaceChildren();
        chatLog.replaceChildren();
      }
      lastRoundPhase = msg.phase;
      roundHud.onState(msg);
      if (msg.hour !== clockHour) {
        clockHour = msg.hour;
        clockHourChangedAt = performance.now();
      }
      clockNight = msg.night;
      // Gold is not part of a round (stakeholder, 2026-08-20). It stays in
      // the persistent world's economy (D-220/D-221) and is simply not shown
      // here — the round has no shops, no wages and nothing to spend on.
      $('hud-coin-wrap').classList.toggle('hidden', msg.phase === 'running');
      renderClock();
      return;
    case 'store_contents':
      charPanel.setStores(msg);
      return;
    case 'round_role':
      roundHud.onRole(msg);
      if (msg.objective) {
        appendSystemLine(`A word was had with you before the doors opened: ${msg.objective.brief}`);
      }
      return;
    case 'round_ended':
      roundHud.onEnded(msg);
      appendSystemLine(
        `The round is over. ${msg.antagonistName} carried "${msg.objectiveName}".`,
      );
      return;
    case 'sound': {
      // The server already decided who is within earshot (D-531); the client
      // only makes what it was sent audible. It cannot widen the range.
      ambience.combat(msg.bearing, msg.distance);
      const line = document.createElement('div');
      line.className = 'line narration';
      line.textContent = msg.text;
      eventLog.appendChild(stamped(line));
      trimAndScroll(eventLog);
      return;
    }
    case 'pong':
      return;
  }
};

// ---------------------------------------------------------------------------
// World mirror → visuals
// ---------------------------------------------------------------------------

function ensureScene(): GameScene {
  if (!scene) scene = new GameScene($('stage'));
  return scene;
}

function clearWorld(): void {
  for (const e of entities.values()) e.visual.dispose();
  entities.clear();
  if (terrain && scene) terrain.dispose(scene.scene);
  terrain = null;
  if (paintedGround && scene) {
    scene.scene.remove(paintedGround);
    paintedGround.geometry.dispose();
    // ⚠ The MATERIAL only. Its mask and layer textures are cached and shared
    // with whatever else is drawn from them, so freeing those here would blank
    // the ground of the next area built from the same art.
    (paintedGround.material as THREE.Material).dispose();
  }
  paintedGround = null;
  if (roofs && scene) roofs.dispose(scene.scene);
  roofs = null;
  worldAssets?.dispose();
  worldAssets = null;
  hoverOutline?.dispose();
  hoverOutline = null;
  youId = null;
}

function addEntity(wire: WireEntity): void {
  const s = ensureScene();
  if (wire.kind === 'pile') {
    const visual = new PileVisual(s.scene);
    visual.setPosition(wire.x, wire.y, wire.z);
    entities.set(wire.id, { wire: { ...wire }, render: { x: wire.x, y: wire.y }, visual });
    return;
  }
  if (wire.kind === 'station') {
    // Stations are entities because they are used and targeted, but they are
    // OBJECTS: before D-542 they fell through to the character pipeline and
    // the well in the town square was a man standing very still.
    // ⚠ A station's TYPE is content now (D-530), so the client may be told
    // about a facility it has no built-in model for. It falls back to the
    // workshop's geometry rather than drawing nothing: an invisible object
    // you can still use reads as a bug, and a wrong-looking one reads as
    // art that has not been made yet — which is the truth.
    const type = (CORE_STATION_TYPES as readonly string[]).includes(wire.variant ?? '')
      ? (wire.variant as CoreStationType)
      : 'workshop';
    // ⚠ The art comes off the WIRE, not from a table here (D-583): which mesh
    // a facility wears is content the server resolved, and a client guessing
    // it would draw a different well from everybody else's.
    const visual = new StationEntity(s.scene, type, wire.x, wire.y, wire.art);
    entities.set(wire.id, { wire: { ...wire }, render: { x: wire.x, y: wire.y }, visual });
    return;
  }
  if (wire.kind === 'node') {
    // `variant` is the node's own id (D-542); the descriptor guess stays as
    // the fallback for anything that predates it.
    const visual = new NodeVisual(s.scene, wire.variant ?? wire.descriptor);
    // ⚠ Off the wire, never guessed here (D-583) — which mesh a vein wears is
    // content the server resolved against `content/nodes/`.
    if (wire.art) void visual.wear(wire.art);
    visual.setPosition(wire.x, wire.y, wire.z);
    entities.set(wire.id, { wire: { ...wire }, render: { x: wire.x, y: wire.y }, visual });
    return;
  }
  // A body we watched fall keeps the ragdoll it fell with (D-554), rather
  // than being replaced by a fresh one already settled.
  const inherited = wire.kind === 'corpse' ? adoptDyingVisual(wire.x, wire.y) : null;
  // Seed first, player second (D-539). Passing the raw seed here would draw
  // everybody as the seed rolls them and quietly discard the body the player
  // built — the descriptor would say "towering" over a slight figure.
  const appearance = resolveAppearance(wire.appearanceSeed, wire.appearance);
  // ⚠ One cast (D-617). The procedural `CharacterVisual` and the toggle
  // that chose between them are deleted: the imported cast is what ships, and
  // a settings switch that silently changed which renderer a player was
  // judging was a way to report a bug about the wrong one.
  //
  // ⚠ The look is passed through, so an entity is drawn as the face its
  // player chose rather than one picked from the seed (D-574, resolving what
  // D-559 left open). Null for everything that never chose.
  const visual =
    inherited
    ?? new ImportedVisual(appearance, s.scene, wire.appearanceSeed, wire.look,
      wire.model ?? null);
  // Layer 1 is the character/pixel layer the split pass quantises (D-404).
  visual.setRenderLayer(1);
  visual.setPosition(wire.x, wire.y, wire.z);
  visual.setFacing(wire.facing);
  visual.setPosture(wire.posture, wire.seated);
  visual.setPresentation(wire.presentation);
  visual.setCombat(wire.combat);
  if (isPerson(visual)) visual.setRunning(wire.running);
  applyWorn(visual, wire);
  visual.setLootable(wire.lootable);
  if (wire.kind === 'corpse' && !inherited) {
    // A body we are only now seeing is already down: hold the final frame
    // of the collapse rather than replaying a death nobody witnessed.
    // An INHERITED one is mid-fall and already dead — calling setDead here
    // would fast-forward the very collapse we kept it for.
    visual.setDead(true);
  }
  entities.set(wire.id, { wire: { ...wire }, render: { x: wire.x, y: wire.y }, visual });
}

function applySnapshot(snap: Extract<ServerMessage, { t: 'snapshot' }>): void {
  // Pull the built models in before anybody needs one. They are shared, so
  // this is a handful of files once per session.
  //
  // And REBUILD when they land. `addEntity` runs synchronously further down
  // this same function, so on the first snapshot of a session the manifest
  // has not arrived yet, `available()` is false, and every character is
  // built procedural however the setting is set. Without this the toggle
  // looks broken until you walk through a door.
  void importedModels.preload().then(() => {
    syncSettingsUi();
    if (useImportedCast()) rebuildCast();
  });
  // Station availability depends on where you are, so the workbench has to
  // be redrawn on every area change, not only when the pack changes.
  queueMicrotask(renderPackAndCraft);
  const s = ensureScene();
  clearWorld();
  s.applyLighting(snap.area.lighting);
  terrain = new Terrain(snap.area, s.scene);
  // What somebody painted in the editor (D-588). Null when the area is
  // unpainted, which is most of them — bare terrain, exactly as before.
  paintedGround = buildPaintedGround(snap.area);
  if (paintedGround) s.scene.add(paintedGround);
  lightRig?.clear();
  if (!lightRig) lightRig = new LightRig(s.scene);
  roofs?.dispose(s.scene);
  roofs = new Roofs(snap.area.roofs, s.scene);
  // The pack meshes this map is built from (D-567). The server has been
  // colliding with them all along; this is the half that draws them.
  worldAssets?.dispose();
  worldAssets = new WorldAssets(s.scene, snap.area.assets);
  effects?.dispose();
  effects = new CombatEffects(s.scene);
  // Lights (including the hearth's, added by Terrain just now) and the
  // camera must reach both layers or the split pass renders black.
  s.enableAllLayers();
  applyGraphics();
  $('btn-settings').classList.remove('hidden');
  for (const e of snap.entities) addEntity(e);
  youId = snap.you;
  areaName = snap.area.name;
  currentArea = snap.area;
  moveDest = null; moveAsked = false;
  pendingSit = null;
  // Ambience derives from the area data: hearth tiles crackle, interior
  // and underground profiles carry a room tone.
  const hearths: { x: number; y: number }[] = [];
  for (let ty = 0; ty < snap.area.height; ty++) {
    for (let tx = 0; tx < snap.area.width; tx++) {
      const ch = snap.area.tiles[ty]![tx]!;
      if (snap.area.legend[ch]?.kind === 'hearth') hearths.push({ x: tx, y: ty });
    }
  }
  ambience.setScene(hearths, snap.area.lighting === 'interior' || snap.area.lighting === 'underground');
  // The bed follows the area (D-541); the same cue twice is a no-op, so
  // walking through a door and back does not restart it.
  sounds.setAmbience(snap.area.ambience ?? null);
  sounds.setMusic(null);
  selectedId = null;
  updateTargetFrame();
  coin = snap.coin;
  // The snapshot carries the pack too, and it is the ONLY inventory a player
  // gets on entering — there is no separate `inventory` message until
  // something moves. Without this the paperdoll opened empty for a character
  // who was standing there in full mail.
  inventory = snap.inventory;
  charPanel.setInventory(inventory);
  overlay.classList.add('hidden');
  hud.classList.remove('hidden');
  chat.classList.remove('hidden');
  chatHint.classList.remove('hidden');
  hotbarEl.classList.remove('hidden');
  $('hud-area').textContent = areaName;
  appendSystemLine(`${snap.area.name}.`);
}

function applyEvent(event: { type: string } & Record<string, unknown>): void {
  if (event.type === 'entity_entered') {
    const wire = event.entity as WireEntity;
    if (!entities.has(wire.id)) addEntity(wire);
  } else if (event.type === 'entity_left') {
    const e = entities.get(event.id as number);
    if (e) {
      e.visual.dispose();
      entities.delete(event.id as number);
    }
  } else if (event.type === 'entity_moved') {
    const e = entities.get(event.id as number);
    if (e) {
      // ⚠ The authoritative position CHANGED, which is what "walking" means.
      // Inferring it from whether the visual has caught up flickers false
      // between every pair of updates (D-567) and restarts the stride.
      markMoved(e.render, performance.now());
      e.wire.x = event.x as number;
      e.wire.y = event.y as number;
      e.wire.z = event.z as number;
      e.wire.facing = event.facing as Direction;
      e.wire.posture = 'standing';
      // Sprinting rides on the movement event (D-636): it is the one
      // message every observer gets while the body moves.
      e.wire.running = event.running === true;
      e.visual.setFacing(e.wire.facing);
      e.visual.setPosture('standing');
      if (isPerson(e.visual)) e.visual.setRunning(e.wire.running);
    }
  } else if (event.type === 'entity_emote') {
    const e = entities.get(event.id as number);
    if (e) {
      const posture = event.posture as WireEntity['posture'] | undefined;
      if (posture) {
        e.wire.posture = posture;
        // WARN The seat comes from the EVENT (D-615). Taking a chair and the
        // `*sits*` emote both arrive as `posture: 'sitting'`, so reading the
        // flag off the entity here would be reading a value this very event is
        // about to change.
        e.wire.seated = Boolean(event.seated);
        e.visual.setPosture(posture, e.wire.seated);
      }
      e.visual.playTransients(event.transients as Parameters<typeof e.visual.playTransients>[0]);
    }
  } else if (event.type === 'entity_presentation') {
    const e = entities.get(event.id as number);
    if (e) {
      const state = event.state as WireEntity['presentation'];
      e.wire.presentation = state;
      e.visual.setPresentation(state);
    }
  } else if (event.type === 'entity_combat') {
    const e = entities.get(event.id as number);
    // ⚠ BOTH casts. This drives the whole readiness layer — sheathe, draw,
    // guard stance (D-516, D-565) — and narrowed to the procedural cast it
    // meant a modelled character never entered combat at all.
    if (e) {
      // ⚠ The FLAG is recorded whatever the body is, and only the stance
      // is a person's. A creature has no readiness layer to swap, but it runs
      // at the same pace a person does (D-619) and the glide reads this.
      e.wire.combat = event.inCombat as boolean;
      if (isPerson(e.visual)) e.visual.setCombat(e.wire.combat);
    }
  } else if (event.type === 'entity_attacked') {
    playAttack(event.attackerId as number, event.targetId as number, event.variant as number);
    // ⚠ A MISS is a result, not an absence (D-606). Zero damage and a blow
    // that never connected are the same number on the wire and must not be the
    // same picture: without this a fight where nothing lands looks like a
    // fight where the server has stopped answering.
    //
    // ⚠ Only blows YOU are in. Narrating every swing in a taproom brawl
    // would bury the speech that matters, and what a bystander is entitled to
    // is what they can see and hear (D-531), not a combat log of other
    // people's dice.
    if (event.attackerId === youId || event.targetId === youId) {
      const mine = event.attackerId === youId;
      const other = entities.get((mine ? event.targetId : event.attackerId) as number);
      const who = other ? other.wire.descriptor : 'something';
      if (event.critical) {
        appendSystemLine(mine
          ? `A perfect stroke — you strike ${who} for ${event.damage}.`
          : `${who} strikes true, for ${event.damage}.`);
      } else if (!event.hit) {
        appendSystemLine(mine
          ? `You swing at ${who} and miss. (rolled ${event.roll})`
          : `${who} swings at you and misses. (rolled ${event.roll})`);
      }
    }
    // Somebody who has swung at you is somebody you may swing back at without
    // clicking again (D-550). Remembered CLIENT-side and never sent: a wire
    // field saying "this player is hostile" would be the game making an
    // accusation, which is exactly what D-217 leaves to players.
    if (event.targetId === youId) struckBy.add(event.attackerId as number);
  } else if (event.type === 'entity_dissolved') {
    // Daylight has undone it (D-551). Play the effect where it stands; the
    // `entity_left` that follows removes it from the mirror.
    const e = entities.get(event.id as number);
    if (e && effects) {
      effects.dissolve(new THREE.Vector3(e.render.x, 0.05, e.render.y));
    }
  } else if (event.type === 'entity_lootable') {
    const e = entities.get(event.id as number);
    if (e) {
      e.wire.lootable = event.lootable as boolean;
      // ⚠ BOTH casts, or a modelled corpse never draws the pack that says
      // it is worth searching (D-554).
      if (isPerson(e.visual)) e.visual.setLootable(e.wire.lootable);
      else if (e.visual instanceof PileVisual) e.visual.setLootable(e.wire.lootable);
    }
  } else if (event.type === 'entity_model') {
    // Drawn as something else from now on (D-632): you died, and your race
    // has a ghost look. The visual is rebuilt from the same wire record with
    // the model changed, which is how everybody else already sees you.
    const e = entities.get(event.id as number);
    if (e) {
      const wire = { ...e.wire, ...(event.model ? { model: event.model } : {}) } as WireEntity;
      if (!event.model) delete (wire as { model?: string }).model;
      e.visual.dispose();
      entities.delete(event.id as number);
      addEntity(wire);
    }
  } else if (event.type === 'entity_worn') {
    // Somebody put something on (D-554). The silhouette changes for everyone
    // watching, which is the whole point — armour you cannot see is armour
    // nobody can decide to avoid.
    const e = entities.get(event.id as number);
    if (e) {
      e.wire.worn = event.worn as WireEntity['worn'];
      // ⚠ BOTH casts. This said `instanceof CharacterVisual`, so the imported
      // cast never heard about a change of kit — a garment would appear only
      // on the next full snapshot, which in practice means on the next area
      // change. `applyWorn` takes the union precisely so the caller does not
      // have to know which cast it is holding (D-559); testing for one of
      // them here was undoing that.
      // A pile, a node and a station wear nothing — the test excludes what
      // is not a person, rather than picking one of the two casts.
      if (isPerson(e.visual)) {
        applyWorn(e.visual, e.wire);
      }
    }
  } else if (event.type === 'entity_carried') {
    const e = entities.get(event.id as number);
    if (e) e.wire.carriedBy = event.carrierId as number | null;
  } else if (event.type === 'entity_effect') {
    // A mending or a rite, at somebody the room can see (D-541).
    const e = entities.get(event.id as number);
    if (e) {
      sounds.play(
        event.effect === 'heal' ? 'heal' : 'spirit-rite',
        placementOf(e.render.x, e.render.y),
      );
    }
  } else if (event.type === 'entity_died') {
    const e = entities.get(event.id as number);
    if (e) {
      appendSystemLine(`${e.wire.descriptor} falls.`);
      const deathCue = voiceCue(event.id as number, 'death');
      if (deathCue) sounds.play(deathCue, placementOf(e.render.x, e.render.y));
      // The fall is watched, not skipped. The entity is removed from the
      // world mirror straight away (the server has already replaced it with
      // a corpse), but its visual lingers just long enough to collapse.
      if (isPerson(e.visual)) {
        // A recent blow shoves the body over; anything else (bleeding out,
        // sickness) simply drops it where it stands.
        const blow = lastBlow.get(event.id as number);
        const shove = blow && t - blow.at < 1.5
          ? blow.dir.clone().multiplyScalar(1.6)
          : undefined;
        lastBlow.delete(event.id as number);
        e.visual.playDeath(t, shove);
        dyingVisuals.push({
          visual: e.visual, until: t + 3.0, x: e.render.x, y: e.render.y,
        });
      } else {
        e.visual.dispose();
      }
      entities.delete(event.id as number);
    }
  }
}

/**
 * Puts what somebody is wearing onto the model they are drawn with (D-554).
 *
 * Falls back to the SEED's own equipment when the server says nothing —
 * `worn` is null for every NPC, roamer and corpse, and for any character not
 * holding gear. That fallback is what keeps the world looking exactly as it
 * did before equipment was visible, rather than stripping every NPC bare.
 */
/**
 * Whether a visual is a PERSON — either cast (D-612).
 *
 * ⚠ This exists because `instanceof CharacterVisual` kept being written
 * where "is this somebody" was meant. `CharacterVisual` is the procedural cast
 * and `ImportedVisual` is the modelled one (D-559); both implement the same
 * eighteen members precisely so world code does not have to know which it has,
 * and every narrowing to one of them silently switched half the game off for
 * whoever was rendered by the other.
 *
 * ⚠ It had already been found and written down once — D-571 records
 * `entity_worn` doing exactly this — and the comment saying so sits fifteen
 * lines above two more of them. A rule that has to be remembered at each call
 * site is not a rule; this is.
 */
function isPerson(v: unknown): v is ImportedVisual {
  return v instanceof ImportedVisual;
}

function applyWorn(visual: ImportedVisual, wire: WireEntity): void {
  const worn = wire.worn;
  if (!worn) return;
  visual.setEquipment({
    helm: worn.helm,
    pauldrons: worn.pauldrons,
    cape: worn.cape,
    robe: worn.robe,
    weapon: worn.weapon !== 'none',
    weaponKind: worn.weapon === 'staff' ? 'staff' : 'sword',
    // ⚠ Which blade, not just that there is one (D-614). The silhouette
    // says 'sword' for every weapon in the game, so without this the imported
    // cast had nothing to put in the hand and fought empty-handed.
    weaponArt: worn.weaponArt,
    // ⚠ The imported cast re-assembles a body out of these (D-571); the
    // procedural one ignores them and draws its generated armour from the
    // flags above. One call, two casts, and `main.ts` still does not know
    // which it is holding — which is the property D-559 exists to keep.
    garments: worn.garments,
    // ⚠ The server decides this (D-102/D-578): which stance an asset declares
    // is content, and a client that guessed it from the silhouette would
    // animate a crossbow as a sword. Undefined is empty-handed, which is the
    // rig's own clips rather than a stance (D-564).
    stance: worn.stance,
  });
}

/**
 * Plays one blow. The variant comes from the server so every observer sees
 * the same swing; whether it is a cast or a cut is read from what the
 * attacker is actually holding, which every client derives identically
 * from the appearance seed.
 */
/**
 * Where a sound is, relative to you: how far, and how far to the side.
 *
 * Panning is computed against the CAMERA's forward, not the world axes —
 * the camera orbits (D-514), so a fixed mapping would put a sound on the
 * wrong side the moment the player turned the view.
 */
function placementOf(x: number, y: number): { pan: number; distance: number } {
  const you = youId !== null ? entities.get(youId) : undefined;
  if (!you) return { pan: 0, distance: 0 };
  const dx = x - you.render.x;
  const dy = y - you.render.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 0.001) return { pan: 0, distance: 0 };
  const az = scene?.azimuthAngle ?? 0;
  // Right-hand vector of the camera, in world XZ.
  const rx = Math.cos(az + Math.PI / 2);
  const rz = Math.sin(az + Math.PI / 2);
  const pan = Math.max(-1, Math.min(1, ((dx * rx + dy * rz) / distance) * 0.85));
  return { pan, distance };
}

/** The sex-specific cry for an entity, read from the appearance it wears. */
function voiceCue(entityId: number, kind: 'hurt' | 'death'): string | null {
  const e = entities.get(entityId);
  // ⚠ BOTH casts: a modelled character took a blow in silence.
  if (!e || !isPerson(e.visual)) return null;
  // Corpses and piles do not cry out; the living and the newly dead do.
  if (e.wire.kind === 'corpse' || e.wire.kind === 'pile') return null;
  const sex = resolveAppearance(e.wire.appearanceSeed, e.wire.appearance).sex;
  return `${kind}-${sex}`;
}

function playAttack(attackerId: number, targetId: number, variant: number): void {
  const attacker = entities.get(attackerId);
  // ⚠ BOTH casts, and this is the one that was reported: "the animations
  // for combat do not play at all". `ImportedVisual.playAttack` has been a
  // real implementation since D-559 and this line returned before reaching it,
  // so a modelled character swung at somebody and simply stood there — no
  // animation, and no sound either, because the sound is below this return.
  if (!attacker || !isPerson(attacker.visual)) return;
  attacker.visual.playAttack(variant, t);
  const target = entities.get(targetId);
  // Remember which way the blow came from: if this one kills, the body
  // should go over away from the attacker rather than fold in place.
  if (target) {
    const push = new THREE.Vector3(
      target.render.x - attacker.render.x, 0, target.render.y - attacker.render.y,
    );
    if (push.lengthSq() < 1e-6) push.set(0, 0, 1);
    lastBlow.set(targetId, { dir: push.normalize(), at: t });
  }
  // Sound follows the same fork the visuals do: steel or a bolt. Sampled
  // cues play only for blows you can SEE — anything out of your area arrives
  // as the anonymous procedural cue instead, which is what keeps hearing a
  // fight from telling you who is in it (D-531).
  const at = placementOf(attacker.render.x, attacker.render.y);
  sounds.play(attacker.visual.castsSpells ? 'attack-bolt' : 'attack-swing', at);
  const hurtCue = voiceCue(targetId, 'hurt');
  if (hurtCue && target) {
    const there = placementOf(target.render.x, target.render.y);
    // A beat after the swing, so the cry answers the blow rather than
    // arriving with it.
    window.setTimeout(() => sounds.play(hurtCue, there), 220);
  }
  if (!effects) return;
  const muzzle = attacker.visual.weaponMuzzle(new THREE.Vector3());
  if (attacker.visual.castsSpells) {
    // The wind-up gathers light at the stave head, then the bolt flies.
    effects.gather(muzzle);
    const aim = new THREE.Vector3(
      target ? target.render.x : attacker.render.x,
      1.0,
      target ? target.render.y : attacker.render.y,
    );
    // Fired at the release point of the cast animation, not on impact.
    pendingBolts.push({ at: t + 0.3, from: muzzle.clone(), to: aim, visual: attacker.visual });
  } else if (target) {
    // Steel landing on a body: a small spray where the blow arrives.
    const hit = new THREE.Vector3(target.render.x, 1.05, target.render.y);
    pendingImpacts.push({ at: t + 0.28, at3: hit });
  }
}

// ---------------------------------------------------------------------------
// Chat (D-306: a reading application first)
// ---------------------------------------------------------------------------

/** Renders *emote spans* italic-amber; everything else plain text. */
function renderSpeechText(target: HTMLElement, text: string): void {
  const parts = text.split(/(\*[^*]+\*)/g);
  for (const part of parts) {
    if (part.length === 0) continue;
    const span = document.createElement('span');
    if (part.startsWith('*') && part.endsWith('*')) {
      span.className = 'emote-text';
      span.textContent = part;
    } else {
      span.textContent = part;
    }
    target.appendChild(span);
  }
}

function appendSpeech(msg: Extract<ServerMessage, { t: 'speech' }>): void {
  const line = document.createElement('div');
  line.className = `line ${msg.channel}`;
  const who = document.createElement('span');
  who.className = 'who';
  const verb = msg.channel === 'whisper' ? 'whispers' : msg.channel === 'shout' ? 'shouts' : 'says';
  const tongue =
    msg.language === 'unknown'
      ? ' in an unfamiliar tongue'
      : msg.language !== 'Common'
        ? ` in ${msg.language}`
        : '';
  who.textContent = `${msg.speakerDescriptor} ${verb}`;
  line.appendChild(who);
  if (tongue) {
    const t = document.createElement('span');
    t.className = 'tongue';
    t.textContent = tongue;
    line.appendChild(t);
  }
  line.appendChild(document.createTextNode(': '));
  renderSpeechText(line, msg.text);
  chatLog.appendChild(stamped(line));
  if (msg.impression) {
    const imp = document.createElement('div');
    imp.className = 'line impression';
    imp.textContent =
      msg.impression === 'certain_false'
        ? 'You are certain that name is not their own.'
        : 'Something about that rings false.';
    chatLog.appendChild(stamped(imp));
  }
  trimAndScrollChat();
}

function appendSystemLine(text: string): void {
  const line = document.createElement('div');
  line.className = 'line system';
  line.textContent = text;
  eventLog.appendChild(stamped(line));
  trimAndScroll(eventLog);
}

function appendDocument(title: string, text: string): void {
  const doc = document.createElement('div');
  doc.className = 'document';
  if (title) {
    const t = document.createElement('div');
    t.className = 'doc-title';
    t.textContent = title;
    doc.appendChild(t);
  }
  doc.appendChild(document.createTextNode(text));
  stamped(doc);
  // ⚠ A letter is something you READ, not something anybody said, so it
  // belongs with what you notice. Putting a long document into the talk panel
  // would scroll a conversation away by itself.
  eventLog.appendChild(doc);
  trimAndScroll(eventLog);
}

/**
 * The in-game time, for stamping a log line (D-612).
 *
 * ⚠ The ROUND's compressed clock, not the wall clock. A round runs a game
 * hour every twenty-five seconds (D-527), so a real timestamp would say the
 * same minute for the whole round and tell nobody anything. What a player
 * needs to place an event is the hour the world was at — "it happened just
 * before dusk" is a thing two people can argue about; "14:52:03" is not.
 *
 * ⚠ Minutes are INTERPOLATED from how long the current hour has been
 * running, the same way the dial's minute hand is. Stamping whole hours would
 * give twenty-five seconds of identical stamps, which reads as a frozen log.
 */
function stampNow(): string {
  const into = Math.min(0.999, (performance.now() - clockHourChangedAt) / GAME_HOUR_MS);
  const minute = Math.floor(into * 60);
  return `${String(clockHour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** Prefixes a line with the world's time. Every log line gets one. */
function stamped(line: HTMLElement): HTMLElement {
  const at = document.createElement('span');
  at.className = 'at';
  at.textContent = stampNow();
  line.prepend(at);
  return line;
}

function trimAndScroll(log: HTMLElement): void {
  while (log.childElementCount > 200) log.firstElementChild!.remove();
  log.scrollTop = log.scrollHeight;
}

/** Speech only. Kept as its own name so a new writer has to choose a side. */
function trimAndScrollChat(): void {
  trimAndScroll(chatLog);
}

function sendChat(): void {
  const raw = chatInput.value.trim();
  if (!raw) return;
  chatInput.value = '';

  // Slash commands — the placeholder UI until real inventory/interaction
  // panels exist. /w /y are channels; the rest are actions.
  if (raw.startsWith('/write ')) {
    const body = raw.slice(7);
    const sep = body.indexOf('|');
    const title = (sep >= 0 ? body.slice(0, sep) : 'A note').trim();
    const text = (sep >= 0 ? body.slice(sep + 1) : body).trim();
    if (text) conn.send({ t: 'write', title, text });
    return;
  }
  if (raw === '/read' || raw.startsWith('/read ')) {
    const wanted = raw.slice(5).trim().toLowerCase();
    const item = inventory.find(
      (i) => i.label && (wanted === '' || i.label.toLowerCase().includes(wanted)),
    );
    if (item) conn.send({ t: 'read_item', itemId: item.id });
    else appendSystemLine('You carry nothing written.');
    return;
  }
  if (raw.startsWith('/introduce ')) {
    const name = raw.slice(11).trim();
    const target = nearestOther();
    if (!name) return appendSystemLine('Introduce them as what?');
    if (!target) return appendSystemLine('There is nobody close enough to introduce.');
    conn.send({
      t: 'say',
      channel: 'say',
      text: `This is ${name}.`,
      introduce: { entityId: target, name },
      ...(currentLanguage ? { language: currentLanguage } : {}),
    });
    return;
  }
  if (raw === '/hood') {
    toggleHood();
    return;
  }
  if (raw.startsWith('/hostile ')) {
    const target = nearestOther();
    if (target === null) return appendSystemLine('Nobody near enough to threaten.');
    conn.send({ t: 'hostile', targetEntityId: target, text: raw.slice(9).trim() });
    return;
  }
  if (raw === '/attack') {
    const target = nearestOther();
    if (target === null) return appendSystemLine('Nothing in reach.');
    engage(target);
    return;
  }
  if (raw === '/treat') {
    const target = nearestOther() ?? youId;
    if (target === null) return;
    conn.send({ t: 'treat', targetEntityId: target });
    return;
  }
  if (raw === '/treatself') {
    if (youId !== null) conn.send({ t: 'treat', targetEntityId: youId });
    return;
  }
  if (raw === '/respawn') {
    conn.send({ t: 'respawn' });
    return;
  }
  if (raw === '/revive') {
    const target = nearestOther();
    if (target === null) return appendSystemLine('Nobody near enough to save.');
    conn.send({ t: 'revive', targetEntityId: target });
    return;
  }
  if (raw === '/loot') {
    const target = nearestBody(['corpse', 'pile']);
    if (target === null) return appendSystemLine('Nothing here to loot.');
    conn.send({ t: 'loot', targetEntityId: target });
    return;
  }
  if (raw === '/speakdead') {
    const target = nearestBody(['corpse']);
    if (target === null) return appendSystemLine('No corpse near enough to question.');
    conn.send({ t: 'speak_dead', targetEntityId: target });
    return;
  }
  if (raw === '/animate') {
    const target = nearestBody(['corpse']);
    if (target === null) return appendSystemLine('No corpse near enough to raise.');
    conn.send({ t: 'animate_dead', targetEntityId: target });
    return;
  }
  if (raw === '/observe' || raw === '/observe on') {
    conn.send({ t: 'observe_body', on: true });
    return;
  }
  if (raw === '/observe off') {
    conn.send({ t: 'observe_body', on: false });
    return;
  }
  if (raw === '/retire forever') {
    conn.send({ t: 'retire' });
    return;
  }
  if (raw === '/retire') {
    appendSystemLine(
      'Retirement is permanent — this character ends and your account earns ' +
      'Legacy Points. Type "/retire forever" if you mean it.',
    );
    return;
  }
  if (raw.startsWith('/lang')) {
    const lang = raw.slice(5).trim();
    currentLanguage = lang === '' || lang === 'common' ? null : lang;
    appendSystemLine(`You will speak ${currentLanguage ?? 'common'}.`);
    return;
  }

  let channel: Channel = 'say';
  let text = raw;
  if (text.startsWith('/w ')) {
    channel = 'whisper';
    text = text.slice(3).trim();
  } else if (text.startsWith('/y ') || text.startsWith('/shout ')) {
    channel = 'shout';
    text = text.slice(text.indexOf(' ') + 1).trim();
  }
  if (!text) return;
  const declareAs = declareInput.value.trim();
  conn.send({
    t: 'say',
    channel,
    text,
    ...(currentLanguage ? { language: currentLanguage } : {}),
    ...(declareAs ? { declareAs } : {}),
  });
  declareInput.value = '';
  declareInput.classList.remove('armed');
}

/** Nearest other entity by chebyshev distance, within speech range. */
function nearestOther(): number | null {
  if (youId === null) return null;
  const you = entities.get(youId);
  if (!you) return null;
  let best: number | null = null;
  let bestDist = 11;
  for (const [id, e] of entities) {
    if (id === youId) continue;
    const d = Math.max(Math.abs(e.wire.x - you.wire.x), Math.abs(e.wire.y - you.wire.y));
    if (d < bestDist) {
      bestDist = d;
      best = id;
    }
  }
  return best;
}

/** Nearest corpse or gear pile — the targets of loot/séance/animation. */
function nearestBody(kinds: WireEntity['kind'][]): number | null {
  if (youId === null) return null;
  const you = entities.get(youId);
  if (!you) return null;
  let best: number | null = null;
  let bestDist = 11;
  for (const [id, e] of entities) {
    if (id === youId || !kinds.includes(e.wire.kind)) continue;
    const d = Math.max(Math.abs(e.wire.x - you.wire.x), Math.abs(e.wire.y - you.wire.y));
    if (d < bestDist) {
      bestDist = d;
      best = id;
    }
  }
  return best;
}

function toggleHood(): void {
  if (youId === null) return;
  const you = entities.get(youId);
  if (!you) return;
  conn.send({
    t: 'set_presentation',
    state: you.wire.presentation === 'hooded' ? 'normal' : 'hooded',
  });
}

function chatOpen(): boolean {
  return chatBar.classList.contains('open');
}

declareInput.addEventListener('input', () => {
  declareInput.classList.toggle('armed', declareInput.value.trim().length > 0);
});

// ---------------------------------------------------------------------------
// Input → intent
// ---------------------------------------------------------------------------

const held = new Set<string>();
window.addEventListener('keydown', (e) => {
  if (overlay.classList.contains('hidden') && !isTyping()) held.add(e.key.toLowerCase());
});
window.addEventListener('keyup', (e) => held.delete(e.key.toLowerCase()));
window.addEventListener('blur', () => held.clear());

function isTyping(): boolean {
  return document.activeElement instanceof HTMLInputElement;
}

// Enter opens the composer / sends; Escape closes it. Movement keys are
// ignored while typing.
window.addEventListener('keydown', (e) => {
  if (!overlay.classList.contains('hidden')) return;
  // Pack and workbench. Guarded on isTyping() so 'i' in a sentence does not
  // open a panel mid-word — this is a game people are meant to talk in.
  if (!isTyping() && (e.key === 'i' || e.key === 'I')) {
    charPanel.toggle();
    return;
  }
  if (!isTyping() && (e.key === 'c' || e.key === 'C')) {
    $('craft-panel').classList.toggle('hidden');
    renderPackAndCraft();
    return;
  }
  // Tab takes the next body, nearest first (D-542). Targeting by mouse alone
  // is hard work in a crowd, and harder while something is hitting you.
  if (!isTyping() && e.key === 'Tab') {
    e.preventDefault();
    cycleTarget();
    return;
  }
  if (!isTyping() && e.key === 'Escape' && selectedId !== null) {
    selectedId = null;
    updateTargetFrame();
    return;
  }
  if (e.key === 'Enter') {
    if (!chatOpen()) {
      chatBar.classList.add('open');
      chatHint.classList.add('hidden');
      chatInput.focus();
    } else if (isTyping()) {
      sendChat();
      chatInput.blur();
      chatBar.classList.remove('open');
      chatHint.classList.remove('hidden');
    } else {
      chatInput.focus();
    }
    e.preventDefault();
  } else if (e.key === 'Escape' && chatOpen()) {
    chatBar.classList.remove('open');
    chatHint.classList.remove('hidden');
    chatInput.blur();
    declareInput.blur();
    held.clear();
  }
});

function heldDirection(): Direction | null {
  const n = held.has('w') || held.has('arrowup');
  const s = held.has('s') || held.has('arrowdown');
  const w = held.has('a') || held.has('arrowleft');
  const e = held.has('d') || held.has('arrowright');
  const dy = (s ? 1 : 0) - (n ? 1 : 0);
  const dx = (e ? 1 : 0) - (w ? 1 : 0);
  if (dx === 0 && dy === 0) return null;
  for (const [dir, v] of Object.entries(DIRECTION_VECTORS)) {
    if (v.x === dx && v.y === dy) return dir as Direction;
  }
  return null;
}

setInterval(() => {
  if (!conn.open || youId === null) return;
  const dir = heldDirection();
  if (dir) {
    // Keys always override the mouse, and the server has to be told to drop
    // the route as well — otherwise the two fight each other every tick.
    if (moveDest) conn.send({ t: 'move_stop' });
    moveDest = null; moveAsked = false;
    moveAsked = false;
    disengage(); // walking away is the answer to "keep attacking?" (D-636)
    conn.send({ t: 'move', dir });
    return;
  }
  // Click-to-move: ask the SERVER to walk there (D-567).
  //
  // ⚠ The client's own A* is gone from this path, and losing it fixes two
  // things at once. It ran over the tile grid, so once positions became metres
  // it indexed `tiles[12.7]`, found nothing, and quietly refused to move at
  // all. And the route was never the client's to choose (D-102): the client
  // sends intent and renders what it is told. It used to choose because the
  // server could not path, which is no longer true.
  //
  // Asked ONCE, not re-planned every 90ms: the server owns the route and
  // re-sending it each tick would restart the walk from wherever the character
  // had got to, which is how a character walks on the spot.
  if (moveDest && currentArea) {
    const you = entities.get(youId);
    if (!you) return;
    if (Math.hypot(you.wire.x - moveDest.x, you.wire.y - moveDest.y) < 0.4) {
      conn.send({ t: 'move_stop' });
      moveDest = null; moveAsked = false;
      return;
    }
    if (!moveAsked) {
      conn.send({ t: 'move_to', x: moveDest.x, y: moveDest.y, run: moveRun });
      moveAsked = true;
    }
  }
}, 90);

function tileWalkable(x: number, y: number): boolean {
  const a = currentArea;
  if (!a) return false;
  if (x < 0 || y < 0 || x >= a.width || y >= a.height) return false;
  const ch = a.tiles[y]?.[x];
  if (ch === undefined || !(a.legend[ch]?.walkable ?? false)) return false;
  // ⚠ Terrain only. What a body actually fits through is the server's
  // question now (D-567) — this gates which tiles a CLICK may target, and
  // erring open is right: the server walks you as close as it can.
  return true;
}

function tileKind(x: number, y: number): string | null {
  const ch = currentArea?.tiles[y]?.[x];
  return ch !== undefined ? currentArea!.legend[ch]?.kind ?? null : null;
}

window.addEventListener('keydown', (e) => {
  if (youId === null || isTyping()) return;
  if (e.key >= '1' && e.key <= '9') {
    useHotbarSlot(Number(e.key) - 1);
    return;
  }
  if (e.key === 'h') toggleHood();
  if (e.key === 'f') {
    const target = selectedId ?? nearestOther();
    if (target !== null) engage(target);
  }
  if (e.key === 'Escape' && !chatOpen()) {
    selectedId = null;
    disengage();
    hideContextMenu();
    updateTargetFrame();
  }
});

// ---------------------------------------------------------------------------
// Mouse: hover highlights, click-to-move, target selection, orbit and zoom
// (stakeholder UI pass, 2026-08-17). The server still validates everything —
// the mouse only chooses which intents to send (D-102).
// ---------------------------------------------------------------------------

const stageEl = $('stage');
const DRAG_THRESHOLD_PX = 6;
let pointerDown: { x: number; y: number; dragging: boolean } | null = null;

/** Cursor ray → the y=0 ground plane → tile coordinates, or null off-grid. */
function tileAtScreen(px: number, py: number): { x: number; y: number } | null {
  if (!scene || !currentArea) return null;
  const rect = stageEl.getBoundingClientRect();
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
  if (k < 0) return null;
  const x = Math.round(near.x + dir.x * k);
  const y = Math.round(near.z + dir.z * k);
  if (x < 0 || y < 0 || x >= currentArea.width || y >= currentArea.height) return null;
  return { x, y };
}

/**
 * Screen-space entity pick (D-542).
 *
 * The first version measured to a single point at chest height with a 30px
 * tolerance, which meant clicking someone's legs, head or weapon missed, and
 * a resource node standing near a person stole the click. Targeting was the
 * loudest complaint about the UI, and all three causes were here.
 *
 * Now: each entity is a vertical SEGMENT from its feet to the top of its
 * head, the cursor is measured against the whole segment, and PEOPLE win
 * ties against scenery. You aim at a body, not at a magic pixel.
 */
function entityAtScreen(px: number, py: number): number | null {
  if (!scene) return null;
  const rect = stageEl.getBoundingClientRect();
  const foot = new THREE.Vector3();
  const head = new THREE.Vector3();
  let best: number | null = null;
  let bestScore = Infinity;
  const project = (v: THREE.Vector3): { x: number; y: number } => {
    v.project(scene!.camera);
    return {
      x: rect.left + ((v.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - v.y) / 2) * rect.height,
    };
  };
  for (const [id, e] of entities) {
    const person = e.wire.kind === 'player' || e.wire.kind === 'npc';
    // A body is about 1.8 tall; scenery is squatter and gets a smaller box.
    const top = person ? 1.85 : e.wire.kind === 'station' ? 1.6 : 0.8;
    const a = project(foot.set(e.render.x, 0.05, e.render.y));
    const b = project(head.set(e.render.x, top, e.render.y));
    // Distance from the cursor to the segment a→b.
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const len2 = vx * vx + vy * vy;
    const t = len2 > 0
      ? Math.max(0, Math.min(1, ((px - a.x) * vx + (py - a.y) * vy) / len2))
      : 0;
    const d = Math.hypot(px - (a.x + vx * t), py - (a.y + vy * t));
    // The grab radius scales with how big the thing is drawn, so zooming out
    // does not make everything unclickable.
    const radius = Math.max(18, Math.min(70, Math.hypot(vx, vy) * 0.45));
    if (d > radius) continue;
    // People are what you mean to click. A node has to be much closer to the
    // cursor than a person to beat them.
    const score = d * (person ? 1 : 2.2);
    if (score < bestScore) {
      bestScore = score;
      best = id;
    }
  }
  return best;
}

/** Everything targetable, nearest first — for Tab cycling. */
function targetableEntities(): number[] {
  const you = youId !== null ? entities.get(youId) : undefined;
  if (!you) return [];
  return [...entities.entries()]
    .filter(([id, e]) => id !== youId && (e.wire.kind === 'player' || e.wire.kind === 'npc'))
    .sort(
      (a, b) =>
        Math.hypot(a[1].render.x - you.render.x, a[1].render.y - you.render.y)
        - Math.hypot(b[1].render.x - you.render.x, b[1].render.y - you.render.y),
    )
    .map(([id]) => id);
}

/** Tab: take the next body in range. Escape clears. */
function cycleTarget(): void {
  const order = targetableEntities();
  if (order.length === 0) {
    selectedId = null;
    updateTargetFrame();
    return;
  }
  const at = selectedId === null ? -1 : order.indexOf(selectedId);
  selectedId = order[(at + 1) % order.length]!;
  updateTargetFrame();
}

// Highlight meshes, created once the scene exists.
let tileHighlight: THREE.LineLoop | null = null;
let hoverRing: THREE.Mesh | null = null;
let selectRing: THREE.Mesh | null = null;

function ensureHighlights(): void {
  // ⚠ The outline is rebuilt on its OWN condition (D-638). `clearWorld`
  // disposes it on every snapshot — a door, a round starting, a reconnect —
  // while the rings below survive, and this function used to return early
  // whenever the rings existed. So the hover edge D-622 built worked until
  // the first area change and never again, which read as the feature having
  // been removed.
  if (scene && !hoverOutline) hoverOutline = new HoverOutline(scene.scene);
  if (!scene || tileHighlight) return;
  const half = 0.48;
  const pts = [
    new THREE.Vector3(-half, 0, -half),
    new THREE.Vector3(half, 0, -half),
    new THREE.Vector3(half, 0, half),
    new THREE.Vector3(-half, 0, half),
  ];
  tileHighlight = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: 0xc4703a, transparent: true, opacity: 0.85 }),
  );
  tileHighlight.position.y = 0.03;
  tileHighlight.visible = false;
  scene.scene.add(tileHighlight);

  const ring = () =>
    new THREE.Mesh(
      new THREE.RingGeometry(0.36, 0.46, 24).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xc4703a, transparent: true, opacity: 0.5 }),
    );
  hoverRing = ring();
  hoverRing.position.y = 0.02;
  hoverRing.visible = false;
  scene.scene.add(hoverRing);
  selectRing = ring();
  (selectRing.material as THREE.MeshBasicMaterial).opacity = 0.95;
  selectRing.position.y = 0.025;
  selectRing.visible = false;
  scene.scene.add(selectRing);
}

/**
 * The geometry the cursor is over, or null (D-622).
 *
 * ⚠ Entities FIRST, scenery second. A chair with somebody sitting in it is
 * two interactable things on one tile, and the person is what you meant: the
 * pick already resolves that between entities (D-542), and this keeps the same
 * answer rather than inventing a second rule.
 *
 * ⚠ Scenery is narrowed to SEATS. Every wall, cobble and flower is a placed
 * asset too, and outlining whatever happens to stand on the hovered tile would
 * light up the floor of the tavern as the cursor crossed it. The stakeholder's
 * note is "any the character can directly interact with", and a seat is the
 * only piece of scenery there is a verb for.
 */
function hoverTarget(): THREE.Object3D | null {
  const entity = hoveredEntityId !== null ? entities.get(hoveredEntityId) : undefined;
  if (entity) return entity.visual.root;
  if (!hoveredTile || !worldAssets) return null;
  const seat = seatNear(hoveredTile.x, hoveredTile.y);
  if (!seat) return null;
  return worldAssets.objectAt(seat.x, seat.y);
}

function updateHighlights(): void {
  ensureHighlights();
  if (!tileHighlight || !hoverRing || !selectRing) return;
  hoverOutline?.show(hoverTarget());
  const hoveredEnt = hoveredEntityId !== null ? entities.get(hoveredEntityId) : undefined;
  if (hoveredEnt) {
    hoverRing.visible = true;
    hoverRing.position.x = hoveredEnt.render.x;
    hoverRing.position.z = hoveredEnt.render.y;
    tileHighlight.visible = false;
  } else {
    hoverRing.visible = false;
    if (hoveredTile && tileWalkable(hoveredTile.x, hoveredTile.y)) {
      tileHighlight.visible = true;
      tileHighlight.position.x = hoveredTile.x;
      tileHighlight.position.z = hoveredTile.y;
    } else {
      tileHighlight.visible = false;
    }
  }
  engageStep();
  const sel = selectedId !== null ? entities.get(selectedId) : undefined;
  if (sel) {
    selectRing.visible = true;
    selectRing.position.x = sel.render.x;
    selectRing.position.z = sel.render.y;
    // A slow pulse: the marker has to be findable in a crowd at a glance,
    // and a static ring reads as scenery once there are props on the floor.
    const pulse = 1 + Math.sin(t * 4) * 0.09;
    selectRing.scale.set(pulse, 1, pulse);
    // The panel carries a distance, so it has to be refreshed as either of
    // you moves rather than only when the selection changes.
    if (sel.wire.x !== lastTargetTile.x || sel.wire.y !== lastTargetTile.y) {
      lastTargetTile = { x: sel.wire.x, y: sel.wire.y };
      updateTargetFrame();
    }
  } else {
    selectRing.visible = false;
    if (selectedId !== null) {
      selectedId = null; // target left the world
      updateTargetFrame();
    }
  }
}

/** Last tile the target stood on, so the panel refreshes only when it moves. */
let lastTargetTile = { x: -1, y: -1 };

/** Chebyshev distance, the same metric the server measures reach with. */
function tilesBetween(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/**
 * Swing at the selected target when it is something that fights back.
 *
 * The client decides NOTHING here (D-102) — the server still checks reach,
 * line of sight, the zone rules and the round's budget, and refuses what it
 * does not like. All this does is stop sending attacks that would be refused,
 * because a stream of `on_cooldown` errors is indistinguishable from a bug.
 *
 * Ranged weapons work through the same path: the server reports the reach of
 * whatever is in hand, so a bow simply starts engaging six tiles out. Mages
 * hit with the staff for the same reason — a staff is a weapon with a
 * damage value, and nothing here special-cases it.
 */
function autoAttackStep(): void {
  if (engagedId !== null || selectedId === null || status === null || status.ghost) return;
  const target = entities.get(selectedId);
  if (!target) return;
  if (target.wire.kind !== 'npc' && target.wire.kind !== 'player') return;
  // Only things that are visibly hostile, or people who have already swung.
  if (target.wire.hostile || struckBy.has(target.wire.id)) engage(selectedId);
}

/**
 * Choose somebody to fight (D-636). Every way of asking for an attack — the
 * hotbar, the F key, the context menu, `/attack` — comes here rather than
 * sending one swing, and `engageStep` does the rest.
 */
function engage(targetId: number): void {
  if (youId === null || targetId === youId) return;
  const target = entities.get(targetId);
  if (!target || (target.wire.kind !== 'npc' && target.wire.kind !== 'player')) return;
  engagedId = targetId;
  engagePlannedFor = null;
  // A fight replaces a walk, not the other way round.
  moveDest = null; moveAsked = false; moveRun = false;
  if (selectedId !== targetId) {
    selectedId = targetId;
    updateTargetFrame();
  }
  engageStep();
}

function disengage(): void {
  if (engagedId !== null && engagePlannedFor !== null) conn.send({ t: 'move_stop' });
  engagedId = null;
  engagePlannedFor = null;
}

/**
 * The nearest tile to `from` that is within `reach` of `target`, or null.
 *
 * Not the target's own tile: the server walks the whole route and would
 * shove the target off theirs (the struck-worker test found exactly that,
 * D-633). Reach is Euclidean, as the server measures it.
 */
function approachTile(
  from: { x: number; y: number },
  target: { x: number; y: number },
  reach: number,
): { x: number; y: number } | null {
  const tx = Math.round(target.x);
  const ty = Math.round(target.y);
  const r = Math.max(1, Math.floor(reach));
  let best: { x: number; y: number } | null = null;
  let bestGap = Infinity;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx === 0 && dy === 0) continue;
      const p = { x: tx + dx, y: ty + dy };
      if (Math.hypot(p.x - target.x, p.y - target.y) > reach) continue;
      if (!tileWalkable(p.x, p.y)) continue;
      const gap = Math.hypot(p.x - from.x, p.y - from.y);
      if (gap < bestGap) {
        bestGap = gap;
        best = p;
      }
    }
  }
  return best;
}

/**
 * Fight the engaged target (D-636): close the distance if it is out of reach,
 * strike whenever the weapon is ready once it is in. Runs on the poll.
 *
 * The client only chooses WHEN to send the intent; range, cooldown, line of
 * sight and the roll are the server's (D-102). Sending a swing that would be
 * refused is avoided because a stream of refusals is indistinguishable from
 * a bug, and the approach exists because "out of reach" is not an answer a
 * player can use — it is a request to be walked closer.
 */
function engageStep(): void {
  autoAttackStep();
  if (engagedId === null || youId === null || status === null) return;
  const target = entities.get(engagedId);
  const you = entities.get(youId);
  if (status.ghost || !target || !you
      || (target.wire.kind !== 'npc' && target.wire.kind !== 'player')) {
    // Gone, dead, or we are: the fight is over.
    engagedId = null;
    engagePlannedFor = null;
    return;
  }
  const gap = Math.hypot(you.wire.x - target.wire.x, you.wire.y - target.wire.y);
  if (gap > status.reach) {
    const at = { x: Math.round(target.wire.x), y: Math.round(target.wire.y) };
    const stale = engagePlannedFor === null
      || Math.max(Math.abs(engagePlannedFor.x - at.x), Math.abs(engagePlannedFor.y - at.y)) >= 1;
    if (stale) {
      const dest = approachTile(you.wire, target.wire, status.reach);
      if (dest) {
        // At the pace the weapon sets: a drawn blade already runs (D-619).
        conn.send({ t: 'move_to', x: dest.x, y: dest.y });
        engagePlannedFor = at;
      }
    }
    return;
  }
  if (engagePlannedFor !== null) {
    conn.send({ t: 'move_stop' });
    engagePlannedFor = null;
  }
  const spacing = attackSpacingTicks(status.attacksPerRound, status.roundTicks);
  if (serverTick - lastAttackAt < spacing) return;
  lastAttackAt = serverTick;
  conn.send({ t: 'attack', targetEntityId: target.wire.id });
}

stageEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || youId === null) return;
  pointerDown = { x: e.clientX, y: e.clientY, dragging: false };
});

window.addEventListener('pointermove', (e) => {
  if (pointerDown) {
    const dx = e.clientX - pointerDown.x;
    if (!pointerDown.dragging &&
        Math.hypot(dx, e.clientY - pointerDown.y) > DRAG_THRESHOLD_PX) {
      pointerDown.dragging = true;
    }
    if (pointerDown.dragging && scene) {
      // Holding left and dragging orbits the camera (stakeholder spec #5).
      scene.rotateBy((e.clientX - pointerDown.x) * 0.008);
      pointerDown.x = e.clientX;
      pointerDown.y = e.clientY;
      return;
    }
  }
  hoveredEntityId = entityAtScreen(e.clientX, e.clientY);
  hoveredTile = hoveredEntityId === null ? tileAtScreen(e.clientX, e.clientY) : null;
});

window.addEventListener('pointerup', (e) => {
  if (e.button !== 0 || !pointerDown) return;
  const wasDrag = pointerDown.dragging;
  pointerDown = null;
  if (wasDrag || youId === null) return;
  hideContextMenu();
  const entityId = entityAtScreen(e.clientX, e.clientY);
  if (entityId !== null && entityId !== youId) {
    // Picking somebody else is a change of mind about who to fight (D-636).
    if (engagedId !== null && engagedId !== entityId) disengage();
    selectedId = entityId;
    updateTargetFrame();
    return;
  }
  const tile = tileAtScreen(e.clientX, e.clientY);
  if (tile && tileWalkable(tile.x, tile.y)) {
    // A second click on the same tile inside the double-click window is a
    // RUN there (D-636); the first click already set off the walk.
    const now = performance.now();
    moveRun = lastGroundClick !== null
      && lastGroundClick.x === tile.x && lastGroundClick.y === tile.y
      && now - lastGroundClick.at < DOUBLE_CLICK_MS;
    lastGroundClick = { x: tile.x, y: tile.y, at: now };
    disengage(); // walking somewhere is the answer to "keep attacking?"
    moveDest = tile; moveAsked = false;
    pendingSit = null;
    // Clicking open ground drops the target, the way every game with a
    // target frame behaves. The hotbar still falls back to the nearest body,
    // so this loses nothing except a stale selection.
    if (selectedId !== null) {
      selectedId = null;
      updateTargetFrame();
    }
  }
});

stageEl.addEventListener('wheel', (e) => {
  if (!scene) return;
  e.preventDefault();
  scene.zoomBy(e.deltaY > 0 ? 1.12 : 1 / 1.12);
}, { passive: false });

// ---------------------------------------------------------------------------
// Right-click context menu (stakeholder spec #3)
// ---------------------------------------------------------------------------

const ctxMenu = $('ctx-menu');

interface MenuEntry {
  label: string;
  act: () => void;
}

function hideContextMenu(): void {
  ctxMenu.classList.add('hidden');
}

function showContextMenu(x: number, y: number, entries: MenuEntry[]): void {
  ctxMenu.innerHTML = '';
  for (const entry of entries) {
    const btn = document.createElement('button');
    btn.textContent = entry.label;
    btn.addEventListener('click', () => {
      hideContextMenu();
      entry.act();
    });
    ctxMenu.appendChild(btn);
  }
  ctxMenu.classList.remove('hidden');
  const rect = ctxMenu.getBoundingClientRect();
  ctxMenu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
  ctxMenu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;
}

/**
 * The seat nearest a point, if one is close enough to have been meant.
 *
 * ⚠ Chairs are area SCENERY, not entities (D-542): thirty-two of them in a
 * taproom would be thirty-two snapshot entries and a delta stream each. So
 * there is nothing to hit-test against, and the click is resolved against the
 * placements the snapshot already carries.
 *
 * ⚠ The server checks this again, and its answer is the one that counts
 * (D-102). This exists so the MENU only offers a sit where there is something
 * to sit on — an entry that always appears and usually fails is worse than no
 * entry.
 */
function seatNear(x: number, y: number): { x: number; y: number } | null {
  const a = currentArea;
  if (!a) return null;
  let best: { x: number; y: number } | null = null;
  let away = SEAT_PICK_RADIUS;
  for (const placed of a.assets ?? []) {
    if (!placed.seat) continue;
    const d = Math.hypot(placed.x - x, placed.y - y);
    if (d > away) continue;
    away = d;
    best = { x: placed.x, y: placed.y };
  }
  return best;
}

function menuFor(entityId: number | null, tile: { x: number; y: number } | null): MenuEntry[] {
  const entries: MenuEntry[] = [];
  if (entityId !== null) {
    const e = entities.get(entityId);
    if (!e) return entries;
    const kind = e.wire.kind;
    entries.push({
      label: `Examine`,
      act: () => appendSystemLine(`You see ${e.wire.descriptor}.`),
    });
    if (entityId === youId) {
      const hooded = e.wire.presentation === 'hooded';
      entries.push({ label: hooded ? 'Lower hood' : 'Raise hood', act: toggleHood });
      if (status?.ghost) {
        entries.push({ label: 'Respawn', act: () => conn.send({ t: 'respawn' }) });
      }
      return entries;
    }
    if (kind === 'player' || kind === 'npc') {
      entries.push({ label: 'Attack', act: () => engage(entityId) });
    }
    if (kind === 'player') {
      entries.push({ label: 'Treat wounds', act: () => conn.send({ t: 'treat', targetEntityId: entityId }) });
      entries.push({ label: 'Revive', act: () => conn.send({ t: 'revive', targetEntityId: entityId }) });
    }
    if (kind === 'node') {
      // The server checks reach and charges; this is only the intent (D-102).
      entries.push({
        label: 'Work it',
        act: () => conn.send({ t: 'harvest', targetEntityId: entityId }),
      });
    }
    if (kind === 'corpse' || kind === 'pile') {
      entries.push({ label: 'Loot', act: () => conn.send({ t: 'loot', targetEntityId: entityId }) });
    }
    if (kind === 'corpse') {
      entries.push({ label: 'Speak with dead', act: () => conn.send({ t: 'speak_dead', targetEntityId: entityId }) });
      entries.push({ label: 'Animate dead', act: () => conn.send({ t: 'animate_dead', targetEntityId: entityId }) });
      // Whether it lifts is the server's call — it weighs the body against
      // the carrier's Athletics and refuses if it is too heavy.
      entries.push(
        e.wire.carriedBy === youId
          ? { label: 'Set the body down', act: () => conn.send({ t: 'drop_body' }) }
          : { label: 'Carry the body', act: () => conn.send({ t: 'carry_body', targetEntityId: entityId }) },
      );
    }
  } else if (tile && tileWalkable(tile.x, tile.y)) {
    const seat = seatNear(tile.x, tile.y);
    if (seat) {
      // Walk to it, then ask the server to seat us (D-605). It decides where
      // we end up and which way we face: the chair's own rotation is the only
      // thing that knows which way is forward for it, and a sit taken facing
      // the way we happened to arrive plays into the backrest.
      entries.push({
        label: 'Sit here',
        act: () => { moveDest = { x: seat.x, y: seat.y }; moveAsked = false; pendingSit = seat; },
      });
    }
    entries.push({ label: `Walk here (${tile.x}, ${tile.y})`, act: () => { moveDest = tile; moveAsked = false; pendingSit = null; } });
  }
  return entries;
}

stageEl.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (youId === null) return;
  const entityId = entityAtScreen(e.clientX, e.clientY);
  const tile = entityId === null ? tileAtScreen(e.clientX, e.clientY) : null;
  const entries = menuFor(entityId, tile);
  if (entries.length === 0) return hideContextMenu();
  if (entityId !== null && entityId !== youId) {
    selectedId = entityId;
    updateTargetFrame();
  }
  showContextMenu(e.clientX, e.clientY, entries);
});

window.addEventListener('pointerdown', (e) => {
  if (!(e.target instanceof Node) || !ctxMenu.contains(e.target)) hideContextMenu();
});

// ---------------------------------------------------------------------------
// Target frame + action hotbar (stakeholder spec #4)
// ---------------------------------------------------------------------------

const targetFrame = $('target-frame');

function updateTargetFrame(): void {
  const sel = selectedId !== null ? entities.get(selectedId) : undefined;
  if (!sel) {
    targetFrame.classList.add('hidden');
    return;
  }
  const you = youId !== null ? entities.get(youId) : undefined;
  const dist = you
    ? Math.max(Math.abs(sel.wire.x - you.wire.x), Math.abs(sel.wire.y - you.wire.y))
    : null;
  // What it IS matters as much as what it is called: a corpse, a vein and a
  // person all answer to a descriptor, and the hotbar treats them differently.
  const kindLabel = {
    player: 'person', npc: 'person', corpse: 'body',
    pile: 'gear', node: 'resource', station: 'facility',
  }[sel.wire.kind] ?? sel.wire.kind;
  const reach = dist === null ? '' : dist <= 1 ? ' · within reach' : ` · ${dist} tiles`;
  targetFrame.classList.remove('hidden');
  targetFrame.classList.toggle('near', dist !== null && dist <= 1);
  targetFrame.innerHTML = `<span class="tmark">◎</span> <b>${sel.wire.descriptor}</b>`
    + `<span class="tmeta">${kindLabel}${reach}</span>`;
}

/** The target an ability acts on: your selection, else a sensible nearest. */
function abilityTarget(kinds?: WireEntity['kind'][]): number | null {
  if (selectedId !== null) {
    const sel = entities.get(selectedId);
    if (sel && (!kinds || kinds.includes(sel.wire.kind))) return selectedId;
  }
  if (kinds) return nearestBody(kinds);
  return nearestOther();
}

interface AbilityDef {
  id: string;
  glyph: string;
  label: string;
  use: () => void;
  /**
   * Which class ability the character must hold for this to appear in the
   * book (D-553). Absent means everybody has it.
   */
  requires?: string;
}

const ABILITIES: AbilityDef[] = [
  { id: 'attack', glyph: '⚔', label: 'Attack', use: () => {
    const t = abilityTarget();
    if (t !== null) engage(t);
  } },
  { id: 'treat', glyph: '✚', label: 'Treat wounds', use: () => {
    const t = abilityTarget() ?? youId;
    if (t !== null) conn.send({ t: 'treat', targetEntityId: t });
  } },
  { id: 'revive', glyph: '❋', label: 'Revive', use: () => {
    const t = abilityTarget();
    if (t !== null) conn.send({ t: 'revive', targetEntityId: t });
  } },
  { id: 'loot', glyph: '✋', label: 'Loot', use: () => {
    const t = abilityTarget(['corpse', 'pile']);
    if (t !== null) conn.send({ t: 'loot', targetEntityId: t });
    else appendSystemLine('Nothing here to loot.');
  } },
  { id: 'poison', glyph: '☣', label: 'Spoil the well', use: () => conn.send({ t: 'poison_well' }) },
  { id: 'speakdead', glyph: '☾', label: 'Speak with dead', requires: 'speak-with-dead', use: () => {
    const t = abilityTarget(['corpse']);
    if (t !== null) conn.send({ t: 'speak_dead', targetEntityId: t });
    else appendSystemLine('No corpse near enough.');
  } },
  { id: 'animate', glyph: '☠', label: 'Animate dead', requires: 'animate-dead', use: () => {
    const t = abilityTarget(['corpse']);
    if (t !== null) conn.send({ t: 'animate_dead', targetEntityId: t });
    else appendSystemLine('No corpse near enough.');
  } },
  { id: 'hood', glyph: '◒', label: 'Hood up/down', use: toggleHood },
  { id: 'observe', glyph: '◉', label: 'Ride your corpse', use: () => conn.send({ t: 'observe_body', on: true }) },
  { id: 'respawn', glyph: '↻', label: 'Respawn', use: () => conn.send({ t: 'respawn' }) },
];

const HOTBAR_SLOTS = 9;
const hotbarEl = $('hotbar');
const drawerEl = $('ability-drawer');

function defaultHotbar(): (string | null)[] {
  return ['attack', 'treat', 'loot', 'revive', 'hood', null, null, null, null];
}

let hotbar: (string | null)[] = defaultHotbar();
let hotbarSaveTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Takes the bar the SERVER holds for this character (D-553).
 *
 * It used to live in localStorage, which meant one bar shared by every
 * character on the machine and none of it following the player to another
 * browser. A physician's bar and a berserker's are not the same bar.
 */
function adoptHotbar(saved: (string | null)[] | null): void {
  const next = defaultHotbar();
  if (Array.isArray(saved)) {
    for (let i = 0; i < HOTBAR_SLOTS; i++) next[i] = saved[i] ?? null;
  }
  if (JSON.stringify(next) === JSON.stringify(hotbar)) return;
  hotbar = next;
  renderHotbar();
}

/**
 * Debounced, because dragging a slot around fires this on every drop and the
 * bar is not worth a message per gesture.
 */
function saveHotbar(): void {
  if (hotbarSaveTimer) clearTimeout(hotbarSaveTimer);
  hotbarSaveTimer = setTimeout(() => {
    hotbarSaveTimer = null;
    conn.send({ t: 'set_hotbar', slots: hotbar });
  }, 400);
}

function useHotbarSlot(i: number): void {
  const id = hotbar[i];
  const ability = id ? ABILITIES.find((a) => a.id === id) : undefined;
  // Any other ability is "something else" (D-636): the standing attack ends.
  if (ability && ability.id !== 'attack') disengage();
  ability?.use();
}

function renderHotbar(): void {
  hotbarEl.innerHTML = '';
  for (let i = 0; i < HOTBAR_SLOTS; i++) {
    const slot = document.createElement('div');
    slot.className = 'hb-slot';
    const ability = hotbar[i] ? ABILITIES.find((a) => a.id === hotbar[i]) : undefined;
    slot.innerHTML = `<span class="hb-key">${i + 1}</span><span class="hb-glyph">${ability?.glyph ?? ''}</span>`;
    slot.title = ability
      ? `${ability.label} — key ${i + 1}. Drag it off the bar, or double-click, to clear it.`
      : 'Drop an ability here';
    slot.addEventListener('click', () => useHotbarSlot(i));
    slot.addEventListener('dblclick', () => {
      hotbar[i] = null;
      saveHotbar();
      renderHotbar();
    });
    slot.addEventListener('dragover', (e) => {
      e.preventDefault();
      slot.classList.add('over');
    });
    slot.addEventListener('dragleave', () => slot.classList.remove('over'));
    slot.addEventListener('drop', (e) => {
      e.preventDefault();
      slot.classList.remove('over');
      const abilityId = e.dataTransfer?.getData('rc/ability');
      const fromSlot = e.dataTransfer?.getData('rc/from-slot');
      if (!abilityId) return;
      if (fromSlot !== '' && fromSlot !== undefined && fromSlot !== null && fromSlot !== 'palette') {
        const j = Number(fromSlot);
        hotbar[j] = hotbar[i] ?? null; // swap
      }
      hotbar[i] = abilityId;
      saveHotbar();
      renderHotbar();
    });
    if (ability) {
      slot.draggable = true;
      slot.addEventListener('dragstart', (e) => {
        e.dataTransfer?.setData('rc/ability', ability.id);
        e.dataTransfer?.setData('rc/from-slot', String(i));
      });
      // Dropped anywhere that is not a slot: the ability comes off the bar
      // (D-553). `dropEffect === 'none'` is how the browser reports "nobody
      // accepted this", which is exactly the gesture we want to mean clear.
      slot.addEventListener('dragend', (e) => {
        if (e.dataTransfer?.dropEffect !== 'none') return;
        hotbar[i] = null;
        saveHotbar();
        renderHotbar();
      });
    }
    hotbarEl.appendChild(slot);
  }
  const book = document.createElement('div');
  book.className = 'hb-slot hb-book';
  book.innerHTML = '<span class="hb-glyph">☰</span>';
  book.title = 'Abilities — drag onto the bar';
  book.addEventListener('click', () => drawerEl.classList.toggle('hidden'));
  hotbarEl.appendChild(book);
}

function renderDrawer(): void {
  drawerEl.innerHTML = '<div class="drawer-title">Abilities — drag to the bar</div>';
  for (const ability of ABILITIES) {
    const item = document.createElement('div');
    item.className = 'drawer-item';
    item.draggable = true;
    item.innerHTML = `<span class="hb-glyph">${ability.glyph}</span> ${ability.label}`;
    item.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData('rc/ability', ability.id);
      e.dataTransfer?.setData('rc/from-slot', 'palette');
    });
    item.addEventListener('dblclick', () => {
      const free = hotbar.indexOf(null);
      if (free >= 0) {
        hotbar[free] = ability.id;
        saveHotbar();
        renderHotbar();
      }
    });
    drawerEl.appendChild(item);
  }
}

renderHotbar();
renderDrawer();

/**
 * What this character can actually do, for the Abilities tab (D-553).
 *
 * Two lists, and the split is the honest one: things every character can do,
 * and things this calling was granted. Spells appear too — greyed and
 * undraggable, with the reason — because a character that HAS a spell should
 * be able to see it, and a hotbar slot that silently does nothing is exactly
 * the lie D-538 refused for feats.
 */
function characterBook(): {
  actions: BookEntry[];
  rites: BookEntry[];
} {
  const held = new Set(status?.abilities ?? []);
  const actions: BookEntry[] = [];
  const rites: BookEntry[] = [];
  for (const ability of ABILITIES) {
    const entry: BookEntry = { id: ability.id, glyph: ability.glyph, label: ability.label };
    if (ability.requires) {
      if (!held.has(ability.requires)) continue;
      rites.push(entry);
    } else {
      actions.push(entry);
    }
  }
  for (const spell of status?.spells ?? []) {
    rites.push({
      id: `spell:${spell}`,
      glyph: '✧',
      label: spell,
      inert: true,
      note: 'no casting yet',
    });
  }
  return { actions, rites };
}

// ---------------------------------------------------------------------------
// Graphics settings (stakeholder request, 2026-08-18)
//
// ⚠ The pixel controls are GONE (D-586). They tuned a palette quantiser that
// no longer exists: the world is drawn straight to the canvas at full
// resolution. What is left here is what still decides something — which cast
// the world is drawn with, and whether walls between you and the camera go
// stippled.
// ---------------------------------------------------------------------------

interface GraphicsSettings {
  /** Walls between the camera and you go stippled (D-542). */
  seeThrough: boolean;
}

const GRAPHICS_DEFAULTS: GraphicsSettings = {
  seeThrough: true,
};

function loadGraphics(): GraphicsSettings {
  try {
    const raw = localStorage.getItem('rc.graphics');
    if (!raw) return { ...GRAPHICS_DEFAULTS };
    const saved = JSON.parse(raw) as Partial<GraphicsSettings>;
    return { ...GRAPHICS_DEFAULTS, ...saved };
  } catch {
    return { ...GRAPHICS_DEFAULTS };
  }
}

const graphics = loadGraphics();

/**
 * Are the models BUILT?
 *
 * ⚠ There is no longer a second cast to fall back to (D-617), so this is
 * now the difference between drawing people and drawing nothing. A checkout
 * where `build:characters` has not run has no bodies at all, and saying so is
 * the only useful thing the client can do about it.
 */
function useImportedCast(): boolean {
  return importedModels.available();
}

/**
 * Redraw every character with the other cast.
 *
 * A visual is chosen when the entity arrives, so switching has to rebuild
 * the ones already here — otherwise the change appears to do nothing until
 * you walk to another area, and the person judging the art concludes the
 * toggle is broken.
 */
function rebuildCast(): void {
  if (!scene) return;
  // Snapshot FIRST. `addEntity` re-inserts under the same key, and a Map
  // iterator visits entries added during iteration — so deleting and
  // re-adding while looping walks the same entity forever and hangs the
  // tab. It does not throw; the page simply stops painting.
  for (const [id, e] of [...entities]) {
    if (e.wire.kind === 'pile' || e.wire.kind === 'station' || e.wire.kind === 'node') continue;
    e.visual.dispose();
    entities.delete(id);
    addEntity(e.wire);
  }
}

function applyGraphics(): void {
  if (!scene) return;
  scene.resize();
  localStorage.setItem('rc.graphics', JSON.stringify(graphics));
}

function syncSettingsUi(): void {
  // ⚠ Says whether the bodies exist, since there is no second cast to fall
  // back to any more (D-617). An unbuilt checkout draws no people at all, and
  // the only useful thing the client can do is say so rather than leave
  // somebody wondering why the tavern is empty.
  const built = importedModels.available();
  $('cast-note').textContent = built
    ? 'Imported models ignore hoods and equipment — see the note in DECISIONS D-559.'
    : 'No imported models built. Run npm run build:characters.';
  $<HTMLInputElement>('set-seethrough').checked = graphics.seeThrough;
}

$('btn-settings').addEventListener('click', () => {
  $('settings').classList.toggle('hidden');
  syncSettingsUi();
});
// Sound levels (D-541). These balance the layers against each other; the
// normalisation on load is what makes individual files consistent.
for (const key of ['master', 'effects', 'ambience', 'music'] as const) {
  const input = $<HTMLInputElement>(`set-vol-${key}`);
  const readout = $(`v-vol-${key}`);
  const current = loadVolumes();
  input.value = String(Math.round(current[key] * 100));
  readout.textContent = input.value;
  input.addEventListener('input', () => {
    readout.textContent = input.value;
    saveVolumes({ [key]: Number(input.value) / 100 });
  });
}

$('set-seethrough').addEventListener('change', () => {
  graphics.seeThrough = $<HTMLInputElement>('set-seethrough').checked;
  applyGraphics();
});

syncSettingsUi();

// ---------------------------------------------------------------------------
// Speech bubbles (stakeholder request, 2026-08-18)
//
// Range is NOT decided here: the server already delivers speech only to
// listeners who can hear it — proximity per channel plus line of sight
// (D-102, M2). Receiving the message IS the permission to draw it, so a
// whisper across the room can never appear, and no client-side radius can
// be edited to eavesdrop.
// ---------------------------------------------------------------------------

interface Bubble {
  el: HTMLDivElement;
  entityId: number;
  remaining: number;
}

// ---------------------------------------------------------------------------
// Combat visuals: bolts in flight, impacts, and bodies still falling.
// All are cosmetic and scheduled off authoritative events.
// ---------------------------------------------------------------------------

let effects: CombatEffects | null = null;
/** Bolts released partway through a cast, not at the moment of the message. */
// ⚠ Either cast (D-612). `weaponMuzzle` is implemented by both, and typing
// this to the procedural one is what stopped a modelled caster's bolt.
const pendingBolts: {
  at: number; from: THREE.Vector3; to: THREE.Vector3;
  visual: ImportedVisual;
}[] = [];
/** Melee impact sprays, timed to when the blade actually arrives. */
const pendingImpacts: { at: number; at3: THREE.Vector3 }[] = [];
/** Visuals kept alive past their entity so the collapse can finish. */
/**
 * Bodies mid-collapse (D-554).
 *
 * The tile is remembered as well as the timer, because the server replaces a
 * dying entity with a SEPARATE corpse entity — and when that corpse arrives
 * we hand it the ragdoll that is already falling rather than building a
 * second, pre-settled one. Without the handover you watch a body drop and a
 * different body appear on top of it in a tidy pose, which is exactly the
 * "switches from a ragdoll into a static model" the stakeholder reported.
 */
const dyingVisuals: { visual: ImportedVisual; until: number; x: number; y: number }[] = [];

/**
 * Claims the ragdoll of something that just died on this tile, if there is
 * one. Returns null when the death was not witnessed — a corpse found later
 * is already down, and must not flop over as you walk up to it.
 */
function adoptDyingVisual(x: number, y: number): ImportedVisual | null {
  for (let i = 0; i < dyingVisuals.length; i++) {
    const d = dyingVisuals[i]!;
    // Within a tile: the corpse is spawned where the entity fell, but
    // interpolation means the visual may not have arrived exactly.
    if (Math.abs(d.x - x) <= 1.01 && Math.abs(d.y - y) <= 1.01) {
      dyingVisuals.splice(i, 1);
      return d.visual;
    }
  }
  return null;
}
/** The last blow each entity took, so a killing hit can shove the body. */
const lastBlow = new Map<number, { dir: THREE.Vector3; at: number }>();

function stepCombatVisuals(dt: number): void {
  for (let i = pendingBolts.length - 1; i >= 0; i--) {
    const b = pendingBolts[i]!;
    if (t < b.at) continue;
    // Re-read the muzzle at release: the staff has moved during the cast.
    effects?.castBolt(b.visual.weaponMuzzle(new THREE.Vector3()), b.to);
    pendingBolts.splice(i, 1);
  }
  for (let i = pendingImpacts.length - 1; i >= 0; i--) {
    const p = pendingImpacts[i]!;
    if (t < p.at) continue;
    effects?.burst(p.at3, 'physical');
    pendingImpacts.splice(i, 1);
  }
  for (let i = dyingVisuals.length - 1; i >= 0; i--) {
    const d = dyingVisuals[i]!;
    d.visual.update(dt, t, false, 0);
    if (t >= d.until) {
      d.visual.dispose();
      dyingVisuals.splice(i, 1);
    }
  }
  effects?.update(dt);
}

const bubbleLayer = document.createElement('div');
bubbleLayer.id = 'bubble-layer';
document.body.appendChild(bubbleLayer);
const bubbles: Bubble[] = [];

function addSpeechBubble(msg: Extract<ServerMessage, { t: 'speech' }>): void {
  // No bubble for a speaker we cannot see (heard through a wall, or a
  // séance voice): the chat log still carries those.
  if (!entities.has(msg.speakerId)) return;
  const existing = bubbles.findIndex((b) => b.entityId === msg.speakerId);
  if (existing >= 0) {
    bubbles[existing]!.el.remove();
    bubbles.splice(existing, 1);
  }
  const el = document.createElement('div');
  el.className = `bubble ${msg.channel}`;
  el.textContent = msg.text;
  bubbleLayer.appendChild(el);
  // Long lines linger; the floor keeps a one-word shout readable.
  const seconds = Math.min(11, 2.6 + msg.text.length * 0.055);
  bubbles.push({ el, entityId: msg.speakerId, remaining: seconds });
}

const bubbleProject = new THREE.Vector3();

function updateSpeechBubbles(dt: number): void {
  if (!scene) return;
  const rect = stageEl.getBoundingClientRect();
  for (let i = bubbles.length - 1; i >= 0; i--) {
    const b = bubbles[i]!;
    const entity = entities.get(b.entityId);
    b.remaining -= dt;
    if (!entity || b.remaining <= 0) {
      b.el.remove();
      bubbles.splice(i, 1);
      continue;
    }
    // Anchor just above the head, in world space, then project to screen.
    bubbleProject.set(entity.render.x, 1.95, entity.render.y).project(scene.camera);
    const sx = rect.left + ((bubbleProject.x + 1) / 2) * rect.width;
    const sy = rect.top + ((1 - bubbleProject.y) / 2) * rect.height;
    b.el.style.left = `${sx}px`;
    b.el.style.top = `${sy}px`;
    // Fade the last second rather than blinking out.
    b.el.style.opacity = String(Math.min(1, b.remaining));
  }
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

const clock = new THREE.Clock();
let t = 0;
const followPoint = new THREE.Vector3();

function stepFrame(dt: number): void {
  if (!scene) return;
  t += dt;
  const wind = 0.22 + Math.sin(t * 0.13) * 0.12;
  scene.updateCamera(dt);

  const now = performance.now();
  for (const e of entities.values()) {
    const target = { x: e.wire.x, y: e.wire.y };
    const moving = isMoving(e.render, target, now);
    // ⚠ Glide at the pace the SERVER is moving them (D-619). A body with
    // its weapon up runs, and a walk-paced glide would trail it.
    stepToward(
      e.render, target, dt,
      e.wire.running ? SPRINT_SECONDS : e.wire.combat ? RUN_SECONDS : TILE_SECONDS,
    );
    // ⚠ Height comes straight from the wire, NOT interpolated with x and y.
    // A stair's treads are a series of small steps and easing between them
    // makes a character wade through the stone; arriving at each tread is what
    // climbing looks like (D-567).
    e.visual.setPosition(e.render.x, e.render.y, e.wire.z);
    // Corpses animate too — their "animation" is the held prone pose, which
    // still has to be written to the bones every frame.
    e.visual.update(dt, t, moving, wind);
    // ⚠ BOTH casts, or a modelled body being carried drags along the floor.
    if (isPerson(e.visual) && e.wire.carriedBy !== null) {
      // Slung: lifted off the ground and riding at the carrier's shoulder.
      e.visual.root.position.y += 0.95;
    }
  }
  updateHighlights();

  terrain?.update(t);
  stepCombatVisuals(dt);
  updateSpeechBubbles(dt);
  const you = youId !== null ? entities.get(youId) : undefined;
  if (you) {
    followPoint.set(you.render.x, 0, you.render.y);
    scene.follow(followPoint);
    ambience.update(you.render.x, you.render.y);
    sounds.update();
    // Anything between the camera and your own body goes stippled (D-542).
    // Aimed at the chest rather than the feet: a wall that hides your head
    // and leaves your boots visible is still hiding you.
    // Braziers and lanterns near you are the ones that are real (D-544).
    lightRig?.update(new THREE.Vector3(you.render.x, 0, you.render.y), t);
    // The roof over your head lifts away (D-545).
    roofs?.update({ x: you.render.x, y: you.render.y }, dt);
    if (scene) {
      occlusionFocus.set(you.render.x, 1.0, you.render.y);
      setOcclusionFocus(
        graphics.seeThrough ? occlusionFocus : null,
        scene.camera,
        scene.renderer,
        SEE_THROUGH_RADIUS_PX,
      );
    }
    $('hud-pos').textContent = `${you.wire.x},${you.wire.y}`;
    $('hud-coin').textContent = String(coin);
    renderCompass();
    renderClock();
    $('hud-conn').textContent = conn.open ? '' : 'connection lost';
    // Close enough to the chosen chair, and stopped: ask to sit.
    //
    // ⚠ A DISTANCE, not an equality. This compared the wire position against
    // the clicked tile exactly — and positions have been metres since D-567
    // while tiles are integers, so arriving on `12.03, 7.98` never matched
    // `12, 8` and the sit simply never fired. That is what "sitting is not in
    // the game properly" was.
    if (pendingSit
      && Math.hypot(you.wire.x - pendingSit.x, you.wire.y - pendingSit.y) <= SEAT_REACH
      && !isMoving(you.render, { x: you.wire.x, y: you.wire.y }, performance.now())) {
      const seat = pendingSit;
      pendingSit = null;
      conn.send({ t: 'sit', x: seat.x, y: seat.y });
    }
  }

  // ⚠ LAST, and after everything that poses a body (D-622). The outline
  // copies world matrices off the meshes it wraps; reading them before the
  // mixers have run this frame trails a running character by a whole frame,
  // which at four metres a second is a visible double image.
  scene.scene.updateMatrixWorld(true);
  hoverOutline?.update();
  // Split mode (D-404): characters through the quantiser, world crisp.
  scene.render();
}


// ---------------------------------------------------------------------------
// Vitals, compass and clock (D-546, D-548)
// ---------------------------------------------------------------------------

/** Fills one bar and colours it by how urgent it has become. */
function setBar(id: string, fraction: number, label: string, value: string): void {
  const el = $(id);
  const fill = el.querySelector('i') as HTMLElement;
  const text = el.querySelector('span') as HTMLElement;
  fill.style.width = `${Math.round(fraction * 100)}%`;
  el.classList.remove('low', 'critical');
  const state = barState(fraction);
  if (state !== 'ok') el.classList.add(state);
  text.innerHTML = `<span>${label}</span><span>${value}</span>`;
}

function renderVitals(msg: Extract<ServerMessage, { t: 'status' }>): void {
  $('vitals').classList.remove('hidden');
  const bleeding = msg.injuries.filter((i) => i.severity === 'major').length;
  setBar(
    'v-hp',
    barFraction(msg.hp, msg.maxHp),
    bleeding > 0 ? `health · bleeding ×${bleeding}` : 'health',
    `${msg.hp}/${msg.maxHp}`,
  );
  // A caster with no will has no bar at all rather than an empty one — an
  // empty bar reads as "you are out", which is a different thing from "this
  // does not apply to you".
  $('v-mana').classList.toggle('hidden', msg.maxMana <= 0);
  if (msg.maxMana > 0) {
    setBar('v-mana', barFraction(msg.mana, msg.maxMana), 'reserve', `${msg.mana}/${msg.maxMana}`);
  }
  // Hunger only. Thirst is a separate need pulling the opposite way (D-533)
  // and shares the label rather than the bar — two bars side by side would
  // read as one resource with two halves, which is exactly what they are not.
  setBar(
    'v-hunger',
    needFraction(msg.hunger),
    `${needLabel('hunger', msg.hunger)} · ${needLabel('thirst', msg.thirst)}`,
    '',
  );
  // Progress WITHIN the level, not toward the next total. Measuring from
  // zero makes the bar look nearly full at level nine and crawl at level two,
  // which is backwards from what is actually happening.
  const next = msg.xpForNextLevel;
  const floor = xpForLevel(msg.level);
  ($('v-xp-fill') as HTMLElement).style.width =
    next === null ? '100%' : `${Math.round(barFraction(msg.xp - floor, next - floor) * 100)}%`;
  $('v-xp-label').textContent =
    next === null ? `level ${msg.level}` : `level ${msg.level} · ${msg.xp - floor}/${next - floor}`;
}

/** Points the needle at world north, whatever the camera has been rotated to. */
function renderCompass(): void {
  if (!scene) return;
  // North is -y in tile space, which is -z in world space.
  const deg = compassRotationDeg(scene.screenDirection(0, -1));
  const rose = document.getElementById('compass-rose');
  if (rose) rose.setAttribute('transform', `rotate(${deg.toFixed(1)})`);
}

let clockTicksBuilt = false;

function renderClock(): void {
  $('dials').classList.remove('hidden');
  if (!clockTicksBuilt) {
    const ticks = document.getElementById('clock-ticks');
    if (ticks) {
      for (let i = 0; i < 12; i++) {
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('class', 'dial-tick');
        line.setAttribute('x1', '0');
        line.setAttribute('y1', '-40');
        line.setAttribute('x2', '0');
        line.setAttribute('y2', i % 3 === 0 ? '-32' : '-36');
        line.setAttribute('transform', `rotate(${i * 30})`);
        ticks.appendChild(line);
      }
    }
    clockTicksBuilt = true;
  }
  const elapsed = performance.now() - clockHourChangedAt;
  const hands = clockHands(clockHour, Math.min(0.999, elapsed / GAME_HOUR_MS));
  const hour = document.getElementById('clock-hour');
  const minute = document.getElementById('clock-minute');
  if (hour) hour.setAttribute('transform', `rotate(${hands.hourDeg.toFixed(1)})`);
  if (minute) minute.setAttribute('transform', `rotate(${hands.minuteDeg.toFixed(1)})`);
  document.getElementById('clock-face')?.classList.toggle('night', clockNight);
  const orb = document.getElementById('clock-orb');
  if (orb) orb.textContent = clockNight ? '☾' : '☀';
  $('clock-text').textContent = clockText(clockHour);
}

function frame(): void {
  requestAnimationFrame(frame);
  stepFrame(Math.min(clock.getDelta(), 0.033));
}
frame();

// ---------------------------------------------------------------------------
// Headless verification hook (D-114): automated checks pump frames and read
// mirror state without depending on requestAnimationFrame (which stops in
// non-composited tabs). Not part of the game surface.
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    __rc?: {
      snapshot: () => string | null;
      hover: (id: number | null) => { hovered: number | null; outlining: boolean; hulls: number; ringVisible: boolean | null };
      engaged: () => { target: number | null; plannedFor: { x: number; y: number } | null; nearest: number | null };
      /** How many pack meshes are drawn — verification, not a feature (D-567). */
      walk: () => Promise<unknown>;
      assets: () => { placed: number; drawn: number };
      /** Which cast is drawn, and what each entity actually got (D-559). */
      cast: () => {
        modelsBuilt: boolean;
        visuals: string[];
      };
      /**
       * What an entity is actually holding, measured off the scene graph
       * (D-614).
       *
       * ⚠ Verification, not a feature. "Is the sword drawn" is a question
       * about the scene graph, and the only honest way to answer it is to walk
       * it: the wire can say `weaponArt`, the grip can resolve, the mesh can
       * load, and the thing can still end up parented to nothing. This reports
       * whether an object hangs off the hand and where it is in the world.
       */
      /**
       * What a character's body is MADE OF (D-616).
       *
       * The hood is a part swap, so "is the hood up" is a question about
       * which meshes the assembly contains. A probe that only asked whether a
       * method had been called would pass against the empty stub this
       * replaced.
       */
      body: (id?: number) => {
        cast: string;
        meshes: { name: string; verts: number }[];
        /** The clip playing right now. */
        clip: string;
      } | null;
      weapon: (id?: number) => {
        cast: string;
        wire: string | null;
        drawn: boolean;
        at: [number, number, number] | null;
        bone: string | null;
        boneAt: [number, number, number] | null;
        boneScale: number | null;
        /** Metres between the grip and the bone. A hilt is at the fist. */
        gap: number | null;
      } | null;
      step: (dt: number) => void;
      entities: () => { id: number; x: number; y: number; rx: number; ry: number }[];
      you: () => number | null;
      /** Sends through the real connection — background tabs throttle the
       * input timers, so automated checks inject intents directly. The
       * server validates everything regardless (D-102). */
      send: (msg: Parameters<Connection['send']>[0]) => void;
      /** World→screen projection, so a check can assert what should be in
       * front of what (used to verify split-render occlusion). */
      project: (x: number, y: number, height?: number) => { sx: number; sy: number; depth: number };
      /** Grabs the canvas as a data URL for visual diffing. */
      shot: () => string;
      /** Sound state (D-541). Audio is the one system with no visual trace,
       * so verifying it needs a hook or it needs a pair of ears. */
      sound: () => {
        ready: boolean;
        context: string | null;
        streams: { cue: string; kind: string; playing: boolean; time: number; gain: number }[];
        volumes: Volumes;
      };
      /** Fires a cue by hand, to check a file decodes and plays. */
      playCue: (id: string, pan?: number, distance?: number) => void;
      /** What each loaded cue split into, and at what gains. */
      cues: () => { id: string; takes: number; seconds: number[]; gains: number[] }[];
      /** See-through state (D-542): where the cutout is aimed right now. */
      occlusion: () => { on: boolean; x: number; y: number; depth: number };
      /** Turn the camera, so a check can put a wall between it and the player. */
      look: (azimuthRad: number) => void;
    };
  }
}
window.__rc = {
  /** The world as drawn now, as a PNG data URL (D-637). Verification only. */
  snapshot: (): string | null => {
    if (!scene) return null;
    scene.render();
    return scene.renderer.domElement.toDataURL('image/png');
  },
  /** Who the standing attack is aimed at, if anyone (D-636). Verification only. */
  engaged: () => ({ target: engagedId, plannedFor: engagePlannedFor, nearest: nearestOther() }),
  /**
   * Hover an entity (or nothing) as the mouse would, and report the outline
   * (D-622, probed for D-638). Verification only.
   */
  hover: (id: number | null) => {
    hoveredEntityId = id;
    hoveredTile = null;
    updateHighlights();
    return {
      hovered: hoveredEntityId,
      outlining: hoverOutline?.outlining !== null && hoverOutline?.outlining !== undefined,
      hulls: hoverOutline?.hullCount ?? -1,
      ringVisible: hoverRing?.visible ?? null,
    };
  },
  /**
   * Watch your own walk for two seconds and report what actually flips.
   *
   * ⚠ A diagnostic, added because "the animation resets" could not be
   * reproduced from the code — it says which of the three inputs to the clip
   * choice is changing (moving, posture, facing) and how often, so the next
   * step is a measurement rather than a fourth guess.
   */
  walk: async () => {
    const id = youId;
    if (id === null) return 'not in the world';
    const e = entities.get(id);
    if (!e) return 'no self';
    let flips = 0;
    let postures = 0;
    let facings = 0;
    let updates = 0;
    let last = isMoving(e.render, { x: e.wire.x, y: e.wire.y }, performance.now());
    let lastPosture = e.wire.posture;
    let lastFacing = e.wire.facing;
    let lastPos = `${e.wire.x},${e.wire.y}`;
    const t0 = performance.now();
    await new Promise<void>((done) => {
      const h = setInterval(() => {
        const now = performance.now();
        const m = isMoving(e.render, { x: e.wire.x, y: e.wire.y }, now);
        if (m !== last) { flips++; last = m; }
        if (e.wire.posture !== lastPosture) { postures++; lastPosture = e.wire.posture; }
        if (e.wire.facing !== lastFacing) { facings++; lastFacing = e.wire.facing; }
        const pos = `${e.wire.x},${e.wire.y}`;
        if (pos !== lastPos) { updates++; lastPos = pos; }
        if (now - t0 > 2000) { clearInterval(h); done(); }
      }, 8);
    });
    return {
      seconds: 2,
      serverUpdates: updates,
      movingFlips: flips,
      postureChanges: postures,
      facingChanges: facings,
    };
  },
  assets: () => ({
    placed: currentArea?.assets.length ?? 0,
    drawn: worldAssets?.drawn ?? 0,
  }),
  body: (id?: number) => {
    const target = id ?? youId;
    if (target === null) return null;
    const e = entities.get(target);
    if (!e || !isPerson(e.visual)) return null;
    const meshes: { name: string; verts: number }[] = [];
    e.visual.root.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (!m.isSkinnedMesh) return;
      meshes.push({ name: m.name, verts: m.geometry.getAttribute('position')?.count ?? 0 });
    });
    const clip = 'playing' in e.visual ? (e.visual as { playing: string }).playing : '';
    return { cast: e.visual.constructor.name, meshes, clip };
  },
  weapon: (id?: number) => {
    const target = id ?? youId;
    if (target === null) return null;
    const e = entities.get(target);
    if (!e || !isPerson(e.visual)) return null;
    // ⚠ Both casts hold a weapon differently, and a probe that knew only
    // one would report the other as unarmed. The IMPORTED cast parents a pack
    // mesh to a hand bone; the PROCEDURAL cast generates a blade and places it
    // between anchors each frame, so it hangs off the root under its own name.
    // Looking only for the first shape reported the procedural cast as
    // carrying nothing, which is false and would have sent me hunting a bug
    // that was not there.
    let found: THREE.Object3D | null = null;
    e.visual.root.traverse((o) => {
      if (found) return;
      if ((o as THREE.Bone).isBone) return;
      if (/^(sword|staff)$/i.test(o.name)) { found = o; return; }
      const parent = o.parent;
      if (!parent) return;
      if (!/^(Hand_[LR]|hand_[lr]|prop_r|lowerarm_[lr])$/i.test(parent.name)) return;
      found = o;
    });
    const at = new THREE.Vector3();
    if (found) (found as THREE.Object3D).getWorldPosition(at);
    // The bone it should be ON, so "drawn" can be checked against "drawn in
    // the right place" — a sword a metre from the fist is still `drawn`.
    const bone = (found as THREE.Object3D | null)?.parent ?? null;
    const boneAt = new THREE.Vector3();
    const boneScale = new THREE.Vector3();
    if (bone) { bone.getWorldPosition(boneAt); bone.getWorldScale(boneScale); }
    return {
      cast: e.visual.constructor.name,
      wire: e.wire.worn?.weaponArt ?? null,
      drawn: found !== null,
      at: found ? [at.x, at.y, at.z] : null,
      bone: bone ? bone.name : null,
      boneAt: bone ? [boneAt.x, boneAt.y, boneAt.z] : null,
      boneScale: bone ? boneScale.x : null,
      gap: bone && found ? at.distanceTo(boneAt) : null,
    };
  },
  // ⚠ Still reports what was actually CONSTRUCTED rather than what was
  // asked for. There is one cast now, so the useful question changed from
  // "which one is drawn" to "did anything get drawn at all" — an unbuilt
  // models directory leaves the world peopled by nothing.
  cast: () => ({
    modelsBuilt: importedModels.available(),
    visuals: [...entities.values()].map((e) => e.visual.constructor.name),
    // How many characters have cloth simulating on them (D-631).
    cloth: [...entities.values()].filter((e) => e.visual instanceof ImportedVisual && e.visual.clothCount > 0).length,
  }),
  step: stepFrame,
  entities: () =>
    [...entities.entries()].map(([id, e]) => ({
      id,
      x: e.wire.x,
      y: e.wire.y,
      rx: e.render.x,
      ry: e.render.y,
    })),
  you: () => youId,
  send: (msg) => conn.send(msg),
  project: (x, y, height = 0) => {
    const v = new THREE.Vector3(x, height, y);
    v.project(scene!.camera);
    const rect = stageEl.getBoundingClientRect();
    return {
      sx: ((v.x + 1) / 2) * rect.width,
      sy: ((1 - v.y) / 2) * rect.height,
      depth: v.z,
    };
  },
  shot: () => scene!.renderer.domElement.toDataURL('image/png'),
  sound: () => ({
    ready: sounds.ready,
    context: ambience.context?.state ?? null,
    streams: sounds.streams(),
    volumes: sounds.volumeSettings,
  }),
  playCue: (id, pan = 0, distance = 0) => sounds.play(id, { pan, distance }),
  cues: () => sounds.loadedCues(),
  occlusion: () => occlusionState(),
  look: (angle) => scene?.setAzimuth(angle),
};
