import * as THREE from 'three';
import {
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
import { CharacterVisual } from './render/character';
import { ImportedVisual } from './render/imported-visual';
import * as importedModels from './render/imported-models';
import { isMoving, markMoved, stepToward, type InterpolatedPosition } from './game/interpolation';
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
const chatBar = $('chat-bar');
const chatHint = $('chat-hint');
const chatInput = $<HTMLInputElement>('in-chat');
const declareInput = $<HTMLInputElement>('in-declare');

const defaultServer = `ws://${location.hostname || 'localhost'}:8080`;
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
  setFacing(_dir: Parameters<CharacterVisual['setFacing']>[0]): void {}
  /** A heap IS the loot, so this only ever hides an emptied one. */
  setLootable(lootable: boolean): void {
    this.root.visible = lootable;
  }
  setPosture(_p: Parameters<CharacterVisual['setPosture']>[0]): void {}
  setPresentation(_p: Parameters<CharacterVisual['setPresentation']>[0]): void {}
  playTransients(_t: Parameters<CharacterVisual['playTransients']>[0]): void {}
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
  setFacing(_dir: Parameters<CharacterVisual['setFacing']>[0]): void {}
  setLootable(_lootable: boolean): void {}
  setPosture(_p: Parameters<CharacterVisual['setPosture']>[0]): void {}
  setPresentation(_p: Parameters<CharacterVisual['setPresentation']>[0]): void {}
  playTransients(_t: Parameters<CharacterVisual['playTransients']>[0]): void {}
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
  setFacing(_dir: Parameters<CharacterVisual['setFacing']>[0]): void {}
  setLootable(_lootable: boolean): void {}
  setPosture(_p: Parameters<CharacterVisual['setPosture']>[0]): void {}
  setPresentation(_p: Parameters<CharacterVisual['setPresentation']>[0]): void {}
  playTransients(_t: Parameters<CharacterVisual['playTransients']>[0]): void {}
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
  visual: CharacterVisual | ImportedVisual | PileVisual | NodeVisual | StationEntity;
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
});
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
    li.innerHTML = `<span>${c.name}</span>`
      + `<span class="where">level ${c.level} · ${c.areaId}</span>`;
    li.onclick = () => conn.send({ t: 'enter_world', characterId: c.id });
    charList.appendChild(li);
  }
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
      else setStatus(`${msg.code}: ${msg.message}`);
      return;
    case 'auth_ok':
      localStorage.setItem('rc.token', msg.token);
      showCharacters(msg.characters);
      conn.send({ t: 'get_creation_content' }); // catalogue for the wizard
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
      chatLog.appendChild(line);
      trimAndScrollChat();
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
      if (msg.ghost && !wasGhost) {
        appendSystemLine('The world goes quiet. Only the dead remain with you.');
      } else if (!msg.ghost && wasGhost) {
        appendSystemLine('You wake at the spawn, scarred but breathing.');
      }
      return;
    }
    case 'retired':
      appendSystemLine(
        `The tale is told. ${msg.awarded} Legacy Points earned (${msg.totalLegacyPoints} total). ` +
        'Reconnect to begin someone new.',
      );
      setTimeout(() => conn.close(), 4000);
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
      chatLog.appendChild(line);
      trimAndScrollChat();
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
  const visual =
    inherited ??
    (useImportedCast()
      // ⚠ The look is passed through, so an entity is drawn as the face its
      // player chose rather than one picked from the seed (D-574, resolving
      // what D-559 left open). Null for everything that never chose.
      ? new ImportedVisual(appearance, s.scene, wire.appearanceSeed, wire.look,
        wire.model ?? null)
      : new CharacterVisual(appearance, s.scene));
  // Layer 1 is the character/pixel layer the split pass quantises (D-404).
  visual.setRenderLayer(1);
  visual.setPosition(wire.x, wire.y, wire.z);
  visual.setFacing(wire.facing);
  visual.setPosture(wire.posture);
  visual.setPresentation(wire.presentation);
  visual.setCombat(wire.combat);
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
      e.visual.setFacing(e.wire.facing);
      e.visual.setPosture('standing');
    }
  } else if (event.type === 'entity_emote') {
    const e = entities.get(event.id as number);
    if (e) {
      const posture = event.posture as WireEntity['posture'] | undefined;
      if (posture) {
        e.wire.posture = posture;
        e.visual.setPosture(posture);
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
    if (e && e.visual instanceof CharacterVisual) {
      e.wire.combat = event.inCombat as boolean;
      e.visual.setCombat(e.wire.combat);
    }
  } else if (event.type === 'entity_attacked') {
    playAttack(event.attackerId as number, event.targetId as number, event.variant as number);
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
      if (e.visual instanceof CharacterVisual) e.visual.setLootable(e.wire.lootable);
      else if (e.visual instanceof PileVisual) e.visual.setLootable(e.wire.lootable);
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
      if (e.visual instanceof CharacterVisual || e.visual instanceof ImportedVisual) {
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
      if (e.visual instanceof CharacterVisual || e.visual instanceof ImportedVisual) {
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
function applyWorn(visual: CharacterVisual | ImportedVisual, wire: WireEntity): void {
  const worn = wire.worn;
  if (!worn) return;
  visual.setEquipment({
    helm: worn.helm,
    pauldrons: worn.pauldrons,
    cape: worn.cape,
    robe: worn.robe,
    weapon: worn.weapon !== 'none',
    weaponKind: worn.weapon === 'staff' ? 'staff' : 'sword',
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
  if (!e || !(e.visual instanceof CharacterVisual)) return null;
  // Corpses and piles do not cry out; the living and the newly dead do.
  if (e.wire.kind === 'corpse' || e.wire.kind === 'pile') return null;
  const sex = resolveAppearance(e.wire.appearanceSeed, e.wire.appearance).sex;
  return `${kind}-${sex}`;
}

function playAttack(attackerId: number, targetId: number, variant: number): void {
  const attacker = entities.get(attackerId);
  if (!attacker || !(attacker.visual instanceof CharacterVisual)) return;
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
  chatLog.appendChild(line);
  if (msg.impression) {
    const imp = document.createElement('div');
    imp.className = 'line impression';
    imp.textContent =
      msg.impression === 'certain_false'
        ? 'You are certain that name is not their own.'
        : 'Something about that rings false.';
    chatLog.appendChild(imp);
  }
  trimAndScrollChat();
}

function appendSystemLine(text: string): void {
  const line = document.createElement('div');
  line.className = 'line system';
  line.textContent = text;
  chatLog.appendChild(line);
  trimAndScrollChat();
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
  chatLog.appendChild(doc);
  trimAndScrollChat();
}

function trimAndScrollChat(): void {
  while (chatLog.childElementCount > 200) chatLog.firstElementChild!.remove();
  chatLog.scrollTop = chatLog.scrollHeight;
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
    conn.send({ t: 'attack', targetEntityId: target });
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
      conn.send({ t: 'move_to', x: moveDest.x, y: moveDest.y });
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
    if (target !== null) conn.send({ t: 'attack', targetEntityId: target });
  }
  if (e.key === 'Escape' && !chatOpen()) {
    selectedId = null;
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

function updateHighlights(): void {
  ensureHighlights();
  if (!tileHighlight || !hoverRing || !selectRing) return;
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
  autoAttackStep();
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
  if (selectedId === null || youId === null || status === null || status.ghost) return;
  const target = entities.get(selectedId);
  const you = entities.get(youId);
  if (!target || !you) return;
  if (target.wire.kind !== 'npc' && target.wire.kind !== 'player') return;
  // Only things that are visibly hostile, or people who have already swung.
  const engageable = target.wire.hostile || struckBy.has(target.wire.id);
  if (!engageable) return;
  if (tilesBetween(you.wire, target.wire) > status.reach) return;
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
    selectedId = entityId;
    updateTargetFrame();
    return;
  }
  const tile = tileAtScreen(e.clientX, e.clientY);
  if (tile && tileWalkable(tile.x, tile.y)) {
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
      entries.push({ label: 'Attack', act: () => conn.send({ t: 'attack', targetEntityId: entityId }) });
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
    if (tileKind(tile.x, tile.y) === 'chair') {
      // Walk to the chair, then sit through the normal emote pipeline —
      // everyone nearby sees the same "*sits down*" they would if typed.
      entries.push({ label: 'Sit here', act: () => { moveDest = tile; moveAsked = false; pendingSit = tile; } });
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
    if (t !== null) conn.send({ t: 'attack', targetEntityId: t });
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
  /**
   * Which cast the world is drawn with (D-559).
   *
   * `procedural` is D-402's generate-from-a-seed rig and remains the
   * shipping default: it is the one that renders every appearance the server
   * can describe, wears equipment, and raises a hood. `imported` swaps in
   * the built Synty models so the art can be judged IN the game — which is
   * what D-555 left to the stakeholder and could not be judged from a
   * viewer.
   */
  cast: 'procedural' | 'imported';
}

const GRAPHICS_DEFAULTS: GraphicsSettings = {
  cast: 'procedural',
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
 * Is the imported cast both wanted and BUILT?
 *
 * Both halves matter. A client served a `models/` directory that nobody has
 * run `build:characters` for must fall back rather than draw nothing, and a
 * setting saved in localStorage outlives the models it refers to.
 */
function useImportedCast(): boolean {
  return graphics.cast === 'imported' && importedModels.available();
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
  $<HTMLSelectElement>('set-cast').value = graphics.cast;
  // Say WHY it is unavailable rather than offering a control that does
  // nothing: nobody can tell a broken toggle from an unbuilt one.
  const built = importedModels.available();
  $<HTMLSelectElement>('set-cast').disabled = !built;
  $('cast-note').textContent = built
    ? 'Imported models ignore hoods and equipment — see the note in DECISIONS D-559.'
    : 'No imported models built. Run npm run build:characters.';
  $<HTMLInputElement>('set-seethrough').checked = graphics.seeThrough;
}

$<HTMLSelectElement>('set-cast').addEventListener('change', (e) => {
  graphics.cast = (e.target as HTMLSelectElement).value as GraphicsSettings['cast'];
  applyGraphics();
  rebuildCast();
  syncSettingsUi();
});

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
const pendingBolts: { at: number; from: THREE.Vector3; to: THREE.Vector3; visual: CharacterVisual }[] = [];
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
const dyingVisuals: { visual: CharacterVisual | ImportedVisual; until: number; x: number; y: number }[] = [];

/**
 * Claims the ragdoll of something that just died on this tile, if there is
 * one. Returns null when the death was not witnessed — a corpse found later
 * is already down, and must not flop over as you walk up to it.
 */
function adoptDyingVisual(x: number, y: number): CharacterVisual | ImportedVisual | null {
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
    stepToward(e.render, target, dt);
    // ⚠ Height comes straight from the wire, NOT interpolated with x and y.
    // A stair's treads are a series of small steps and easing between them
    // makes a character wade through the stone; arriving at each tread is what
    // climbing looks like (D-567).
    e.visual.setPosition(e.render.x, e.render.y, e.wire.z);
    // Corpses animate too — their "animation" is the held prone pose, which
    // still has to be written to the bones every frame.
    e.visual.update(dt, t, moving, wind);
    if (e.visual instanceof CharacterVisual && e.wire.carriedBy !== null) {
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
    // Arrived on the chosen chair: sit through the emote pipeline, once.
    if (pendingSit && you.wire.x === pendingSit.x && you.wire.y === pendingSit.y
      && !isMoving(you.render, { x: you.wire.x, y: you.wire.y }, performance.now())) {
      pendingSit = null;
      conn.send({ t: 'say', channel: 'say', text: '*sits down*' });
    }
  }

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
      /** How many pack meshes are drawn — verification, not a feature (D-567). */
      walk: () => Promise<unknown>;
      assets: () => { placed: number; drawn: number };
      /** Which cast is drawn, and what each entity actually got (D-559). */
      cast: () => {
        setting: string;
        modelsBuilt: boolean;
        active: 'procedural' | 'imported';
        visuals: string[];
      };
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
      cast: graphics.cast,
    };
  },
  assets: () => ({
    placed: currentArea?.assets.length ?? 0,
    drawn: worldAssets?.drawn ?? 0,
  }),
  // Two figures at isometric distance are hard to tell apart by eye, and the
  // whole point of the toggle is that somebody can tell. This reports what
  // was actually constructed rather than what was asked for.
  cast: () => ({
    setting: graphics.cast,
    modelsBuilt: importedModels.available(),
    active: useImportedCast() ? ('imported' as const) : ('procedural' as const),
    visuals: [...entities.values()].map((e) => e.visual.constructor.name),
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
