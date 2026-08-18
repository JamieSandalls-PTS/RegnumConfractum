import * as THREE from 'three';
import {
  DIRECTION_VECTORS,
  type Channel,
  type CharacterSummary,
  type Direction,
  type ServerMessage,
  type WireEntity,
} from '@rc/shared';
import { Connection } from './net/connection';
import { Ambience } from './audio';
import { CreationWizard } from './creation';
import { GameScene } from './render/scene';
import type { PixelPost } from './render/palette';
import { CombatEffects } from './render/effects';
import { Terrain } from './render/terrain';
import { CharacterVisual } from './render/character';
import { isMoving, stepToward, type InterpolatedPosition } from './game/interpolation';
import { findPath } from './game/path';
import { RoundHud } from './game/round-hud';
import {
  formatEffort,
  packRows,
  recipeStatus,
  type CatalogueItem,
  type CatalogueRecipe,
} from './game/pack';

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
  setPosition(x: number, z: number): void {
    this.root.position.set(x, 0, z);
  }
  setFacing(_dir: Parameters<CharacterVisual['setFacing']>[0]): void {}
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
  constructor(private parent: THREE.Scene, descriptor: string) {
    const leafy = /leaf|grain|scrub|tangle|run\b/i.test(descriptor);
    const woody = /timber|tree|stand/i.test(descriptor);
    if (woody) {
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
  setPosition(x: number, z: number): void {
    this.root.position.set(x, 0, z);
  }
  /** Spent nodes sink and grey off, so "worked out" reads at a glance. */
  setSpent(spent: boolean): void {
    this.root.scale.setScalar(spent ? 0.55 : 1);
  }
  setFacing(_dir: Parameters<CharacterVisual['setFacing']>[0]): void {}
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

interface EntityState {
  wire: WireEntity;
  render: InterpolatedPosition;
  visual: CharacterVisual | PileVisual | NodeVisual;
}

const conn = new Connection();
let scene: GameScene | null = null;
let terrain: Terrain | null = null;
const entities = new Map<number, EntityState>();
let youId: number | null = null;
let areaName = '';
let coin = 0;
let inventory: Extract<ServerMessage, { t: 'inventory' }>['items'] = [];
let currentLanguage: string | null = null; // null = common
let status: Extract<ServerMessage, { t: 'status' }> | null = null;

// Mouse interaction state (stakeholder UI pass, 2026-08-17)
let selectedId: number | null = null;
let hoveredEntityId: number | null = null;
let hoveredTile: { x: number; y: number } | null = null;
/** Click-to-move destination; the executor re-plans each step (drift-safe). */
let moveDest: { x: number; y: number } | null = null;
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
function renderPackAndCraft(): void {
  const rows = packRows(inventory, itemCatalogue);
  const packList = $('pack-list');
  packList.innerHTML = '';
  if (rows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'pack-empty';
    empty.textContent = 'Nothing but lint.';
    packList.appendChild(empty);
  }
  for (const row of rows) {
    const el = document.createElement('div');
    el.className = 'pack-row';
    const name = document.createElement('span');
    name.textContent = row.name;
    const qty = document.createElement('span');
    qty.className = 'qty';
    qty.textContent = String(row.qty);
    el.append(name, qty);
    packList.appendChild(el);
  }

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
const enableAudio = (): void => ambience.enable();
window.addEventListener('pointerdown', enableAudio, { once: true });
window.addEventListener('keydown', enableAudio, { once: true });

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
  onSubmit: (name, classId, build) => {
    conn.send({
      t: 'create_character',
      name,
      appearanceSeed: creation.seed,
      classId,
      build,
    });
  },
  onCancel: () => setStatus(''),
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
    li.innerHTML = `<span>${c.name}</span><span class="where">${c.areaId}</span>`;
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
      return;
    case 'character_created':
      conn.send({ t: 'enter_world', characterId: msg.character.id });
      return;
    case 'snapshot':
      applySnapshot(msg);
      return;
    case 'delta':
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
      $('hud-hp').textContent = `${msg.hp}/${msg.maxHp}`;
      $('hud-ghost').textContent = msg.ghost ? '☽ dead — /respawn when released' : '';
      if (msg.ghost && !wasGhost) {
        appendSystemLine('The world goes quiet. Only the dead remain with you.');
      } else if (!msg.ghost && wasGhost) {
        appendSystemLine('You wake at the spawn, scarred but breathing.');
      }
      if (msg.injuries.length > 0) {
        const majors = msg.injuries.filter((i) => i.severity === 'major');
        if (majors.length > 0) {
          $('hud-hp').textContent += ` (bleeding ×${majors.length})`;
        }
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
  youId = null;
}

function addEntity(wire: WireEntity): void {
  const s = ensureScene();
  if (wire.kind === 'pile') {
    const visual = new PileVisual(s.scene);
    visual.setPosition(wire.x, wire.y);
    entities.set(wire.id, { wire: { ...wire }, render: { x: wire.x, y: wire.y }, visual });
    return;
  }
  if (wire.kind === 'node') {
    const visual = new NodeVisual(s.scene, wire.descriptor);
    visual.setPosition(wire.x, wire.y);
    entities.set(wire.id, { wire: { ...wire }, render: { x: wire.x, y: wire.y }, visual });
    return;
  }
  const visual = new CharacterVisual(wire.appearanceSeed, s.scene);
  // Layer 1 is the character/pixel layer the split pass quantises (D-404).
  visual.setRenderLayer(1);
  visual.setPosition(wire.x, wire.y);
  visual.setFacing(wire.facing);
  visual.setPosture(wire.posture);
  visual.setPresentation(wire.presentation);
  visual.setCombat(wire.combat);
  if (wire.kind === 'corpse') {
    // A body we are only now seeing is already down: hold the final frame
    // of the collapse rather than replaying a death nobody witnessed.
    visual.setDead(true);
  }
  entities.set(wire.id, { wire: { ...wire }, render: { x: wire.x, y: wire.y }, visual });
}

function applySnapshot(snap: Extract<ServerMessage, { t: 'snapshot' }>): void {
  // Station availability depends on where you are, so the workbench has to
  // be redrawn on every area change, not only when the pack changes.
  queueMicrotask(renderPackAndCraft);
  const s = ensureScene();
  clearWorld();
  s.applyLighting(snap.area.lighting);
  terrain = new Terrain(snap.area, s.scene);
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
  moveDest = null;
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
  selectedId = null;
  updateTargetFrame();
  coin = snap.coin;
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
      e.wire.x = event.x as number;
      e.wire.y = event.y as number;
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
  } else if (event.type === 'entity_carried') {
    const e = entities.get(event.id as number);
    if (e) e.wire.carriedBy = event.carrierId as number | null;
  } else if (event.type === 'entity_died') {
    const e = entities.get(event.id as number);
    if (e) {
      appendSystemLine(`${e.wire.descriptor} falls.`);
      // The fall is watched, not skipped. The entity is removed from the
      // world mirror straight away (the server has already replaced it with
      // a corpse), but its visual lingers just long enough to collapse.
      if (e.visual instanceof CharacterVisual) {
        // A recent blow shoves the body over; anything else (bleeding out,
        // sickness) simply drops it where it stands.
        const blow = lastBlow.get(event.id as number);
        const shove = blow && t - blow.at < 1.5
          ? blow.dir.clone().multiplyScalar(1.6)
          : undefined;
        lastBlow.delete(event.id as number);
        e.visual.playDeath(t, shove);
        dyingVisuals.push({ visual: e.visual, until: t + 3.0 });
      } else {
        e.visual.dispose();
      }
      entities.delete(event.id as number);
    }
  }
}

/**
 * Plays one blow. The variant comes from the server so every observer sees
 * the same swing; whether it is a cast or a cut is read from what the
 * attacker is actually holding, which every client derives identically
 * from the appearance seed.
 */
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
    $('pack-panel').classList.toggle('hidden');
    renderPackAndCraft();
    return;
  }
  if (!isTyping() && (e.key === 'c' || e.key === 'C')) {
    $('craft-panel').classList.toggle('hidden');
    renderPackAndCraft();
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
    moveDest = null; // keys always override the mouse
    conn.send({ t: 'move', dir });
    return;
  }
  // Click-to-move: re-plan from the CURRENT tile every step, so queued-intent
  // drift (see HANDOFF) can never walk us off the path.
  if (moveDest && currentArea) {
    const you = entities.get(youId);
    if (!you) return;
    if (you.wire.x === moveDest.x && you.wire.y === moveDest.y) {
      moveDest = null;
      return;
    }
    const path = findPath(
      {
        width: currentArea.width,
        height: currentArea.height,
        walkable: (x, y) => tileWalkable(x, y),
      },
      you.wire.x, you.wire.y, moveDest.x, moveDest.y,
    );
    if (!path || path.length === 0) {
      moveDest = null;
      return;
    }
    conn.send({ t: 'move', dir: path[0]! });
  }
}, 90);

function tileWalkable(x: number, y: number): boolean {
  const a = currentArea;
  if (!a) return false;
  if (x < 0 || y < 0 || x >= a.width || y >= a.height) return false;
  const ch = a.tiles[y]?.[x];
  return ch !== undefined && (a.legend[ch]?.walkable ?? false);
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

/** Screen-space entity pick: nearest projected entity under the cursor. */
function entityAtScreen(px: number, py: number): number | null {
  if (!scene) return null;
  const rect = stageEl.getBoundingClientRect();
  let best: number | null = null;
  let bestDist = 30; // px
  const v = new THREE.Vector3();
  for (const [id, e] of entities) {
    v.set(e.render.x, 0.9, e.render.y).project(scene.camera);
    const sx = rect.left + ((v.x + 1) / 2) * rect.width;
    const sy = rect.top + ((1 - v.y) / 2) * rect.height;
    const d = Math.hypot(sx - px, sy - py);
    if (d < bestDist) {
      bestDist = d;
      best = id;
    }
  }
  return best;
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
  const sel = selectedId !== null ? entities.get(selectedId) : undefined;
  if (sel) {
    selectRing.visible = true;
    selectRing.position.x = sel.render.x;
    selectRing.position.z = sel.render.y;
  } else {
    selectRing.visible = false;
    if (selectedId !== null) {
      selectedId = null; // target left the world
      updateTargetFrame();
    }
  }
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
    moveDest = tile;
    pendingSit = null;
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
      entries.push({ label: 'Sit here', act: () => { moveDest = tile; pendingSit = tile; } });
    }
    entries.push({ label: `Walk here (${tile.x}, ${tile.y})`, act: () => { moveDest = tile; pendingSit = null; } });
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
  targetFrame.classList.remove('hidden');
  targetFrame.textContent = `◎ ${sel.wire.descriptor}`;
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
  { id: 'speakdead', glyph: '☾', label: 'Speak with dead', use: () => {
    const t = abilityTarget(['corpse']);
    if (t !== null) conn.send({ t: 'speak_dead', targetEntityId: t });
    else appendSystemLine('No corpse near enough.');
  } },
  { id: 'animate', glyph: '☠', label: 'Animate dead', use: () => {
    const t = abilityTarget(['corpse']);
    if (t !== null) conn.send({ t: 'animate_dead', targetEntityId: t });
    else appendSystemLine('No corpse near enough.');
  } },
  { id: 'hood', glyph: '◒', label: 'Hood up/down', use: toggleHood },
  { id: 'observe', glyph: '◉', label: 'Ride your corpse', use: () => conn.send({ t: 'observe_body', on: true }) },
  { id: 'respawn', glyph: '↻', label: 'Respawn', use: () => conn.send({ t: 'respawn' }) },
];

const HOTBAR_SLOTS = 9;
const HOTBAR_KEY = 'rc.hotbar';
const hotbarEl = $('hotbar');
const drawerEl = $('ability-drawer');
let hotbar: (string | null)[] = loadHotbar();

function loadHotbar(): (string | null)[] {
  try {
    const raw = JSON.parse(localStorage.getItem(HOTBAR_KEY) ?? 'null') as (string | null)[] | null;
    if (Array.isArray(raw) && raw.length === HOTBAR_SLOTS) return raw;
  } catch { /* fall through to defaults */ }
  return ['attack', 'treat', 'loot', 'revive', 'hood', null, null, null, null];
}

function saveHotbar(): void {
  localStorage.setItem(HOTBAR_KEY, JSON.stringify(hotbar));
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
    slot.title = ability ? `${ability.label} (key ${i + 1}; double-click to clear)` : 'Drop an ability here';
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

// ---------------------------------------------------------------------------
// Graphics settings (stakeholder request, 2026-08-18)
//
// The ratified art direction is SPLIT: characters are palette-pixelated, the
// environment is not (D-404 as reinstated). Both scales are tunable here and
// persist per browser.
// ---------------------------------------------------------------------------

interface GraphicsSettings {
  mode: 'split' | 'uniform' | 'raw';
  charPixel: number;
  envPixel: number;
  envPalette: boolean;
}

const GRAPHICS_DEFAULTS: GraphicsSettings = {
  mode: 'split',
  charPixel: 4,
  envPixel: 1,
  envPalette: false,
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

function applyGraphics(): void {
  if (!scene) return;
  scene.post.pixelScale = graphics.charPixel;
  scene.post.envPixelScale = graphics.envPixel;
  scene.resize();
  localStorage.setItem('rc.graphics', JSON.stringify(graphics));
}

function syncSettingsUi(): void {
  $<HTMLSelectElement>('set-mode').value = graphics.mode;
  $<HTMLInputElement>('set-charpx').value = String(graphics.charPixel);
  $<HTMLInputElement>('set-envpx').value = String(graphics.envPixel);
  $<HTMLInputElement>('set-envpal').checked = graphics.envPalette;
  $('v-charpx').textContent = String(graphics.charPixel);
  $('v-envpx').textContent = String(graphics.envPixel);
  // Character pixelation is meaningless without a quantiser pass.
  $<HTMLInputElement>('set-charpx').disabled = graphics.mode === 'raw';
  $<HTMLInputElement>('set-envpx').disabled = graphics.mode !== 'split';
  $<HTMLInputElement>('set-envpal').disabled = graphics.mode !== 'split';
}

$('btn-settings').addEventListener('click', () => {
  $('settings').classList.toggle('hidden');
  syncSettingsUi();
});
$('set-mode').addEventListener('change', () => {
  graphics.mode = $<HTMLSelectElement>('set-mode').value as GraphicsSettings['mode'];
  applyGraphics();
  syncSettingsUi();
});
$('set-charpx').addEventListener('input', () => {
  graphics.charPixel = Number($<HTMLInputElement>('set-charpx').value);
  applyGraphics();
  syncSettingsUi();
});
$('set-envpx').addEventListener('input', () => {
  graphics.envPixel = Number($<HTMLInputElement>('set-envpx').value);
  applyGraphics();
  syncSettingsUi();
});
$('set-envpal').addEventListener('change', () => {
  graphics.envPalette = $<HTMLInputElement>('set-envpal').checked;
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
const dyingVisuals: { visual: CharacterVisual; until: number }[] = [];
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

  for (const e of entities.values()) {
    const target = { x: e.wire.x, y: e.wire.y };
    const moving = isMoving(e.render, target);
    stepToward(e.render, target, dt);
    e.visual.setPosition(e.render.x, e.render.y);
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
    $('hud-pos').textContent = `${you.wire.x},${you.wire.y}`;
    $('hud-coin').textContent = String(coin);
    $('hud-conn').textContent = conn.open ? '' : 'connection lost';
    // Arrived on the chosen chair: sit through the emote pipeline, once.
    if (pendingSit && you.wire.x === pendingSit.x && you.wire.y === pendingSit.y
      && !isMoving(you.render, { x: you.wire.x, y: you.wire.y })) {
      pendingSit = null;
      conn.send({ t: 'say', channel: 'say', text: '*sits down*' });
    }
  }

  // Split mode (D-404): characters through the quantiser, world crisp.
  if (graphics.mode === 'split') scene.renderSplit(graphics.envPalette);
  else if (graphics.mode === 'raw') scene.renderer.render(scene.scene, scene.camera);
  else scene.render();
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
      /** The post pass, so a check can A/B its split-mode depth test. */
      post: () => PixelPost;
    };
  }
}
window.__rc = {
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
  post: () => scene!.post,
};
